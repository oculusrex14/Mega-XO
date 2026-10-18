package online.megaxo.prototype

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * P20-03 native HTTPS transport. This is not a JS fetch proxy: no caller can name an arbitrary
 * host, method or path, and JavaScript can never supply an Authorization value.
 *
 * Two disjoint surfaces, both cookie-free and both redirect-refusing:
 *
 *   request(...)      authenticated game/account calls. The bearer is the token the session
 *                     manager installed; a call without an installed token fails closed.
 *   authRequest(...)  the five cookie-free native-credential routes (challenge/token/refresh/
 *                     logout). The bearer is passed in by the session manager, which owns it in
 *                     memory only, and is optionally absent for a first sign-in that has no
 *                     access token yet.
 *
 * Never sent, on either surface: a Cookie header, a client-supplied Authorization for the game
 * surface, a non-HTTPS URL, a different Host than the configured origin, or a followed redirect.
 */
internal class MegaNativeHttpClient(apiOrigin: String?) {
    private val origin: URL? = runCatching {
        val url = URL(apiOrigin ?: "")
        require(url.protocol == "https" && url.userInfo == null && (url.path == "" || url.path == "/") &&
            url.query == null && url.ref == null)
        url
    }.getOrNull()
    /* A bounded pool, not a single thread: one wedged connection (a DNS lookup, which ignores
     * connectTimeout) must never park every later request behind it. The watchdog below still
     * bounds each caller to one honest timeout, so the user-visible contract holds either way. */
    private val executor = Executors.newFixedThreadPool(4) { runnable ->
        Thread(runnable, "megaxo-api-http").apply { isDaemon = true }
    }
    private val watchdogs = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "megaxo-api-watchdog").apply { isDaemon = true }
    }
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var accessToken: String? = null
    private val prefixes = listOf(
        "/api/account/", "/api/community/", "/api/monetization/", "/api/v1/", "/api/party/"
    )

    /** The cookie-free native credential routes, and ONLY those, may be called without a session. */
    private val nativePaths = setOf(
        "/api/account/native/challenge",
        "/api/account/native/token",
        "/api/account/native/refresh",
        "/api/account/native/logout"
    )
    /* The largest declared route contract (packages/contracts/routes.js): account.save.write and
     * every other authenticated POST allow 300000. The previous 64 KiB cap refused large cloud
     * saves device-side with no server contact, which the client classified as a degraded
     * connection - a permanent "Connection interrupted" banner for anyone with a long play
     * history. Stay at the contract ceiling; the server still enforces its own precise limits. */
    private val maxBodyBytes = 300000
    private val maxResponseBytes = 524288

    /** True only when a valid HTTPS origin was configured (Gradle `megaApiOrigin`). */
    fun isConfigured(): Boolean = origin != null

    fun installVerifiedAccessToken(token: String?) {
        accessToken = token?.takeIf {
            it.length in 24..8192 && it.all { c -> c.code in 33..126 }
        }
    }

    fun revokeLocalAccess() { accessToken = null }

    /** Authenticated account/game call. The caller cannot supply the token. */
    fun request(
        path: String, method: String, body: String?, operationKey: String?,
        complete: (Result<Pair<Int, String>>) -> Unit
    ) {
        val token = accessToken
        if (origin == null || token == null) {
            complete(Result.failure(IllegalStateException("ONLINE_UNAVAILABLE"))); return
        }
        if (method !in listOf("GET", "POST") ||
            !path.startsWith("/api/") || path.length > 512 ||
            path.any { it.code !in 33..126 || it == '\\' } ||
            listOf("..", "//", "%", "#", "?").any { path.contains(it) } ||
            prefixes.none { path.startsWith(it) } ||
            (method == "GET" && body != null) ||
            (method == "POST" && (body == null || body.toByteArray().size > maxBodyBytes)) ||
            (method == "POST" && (operationKey.isNullOrEmpty() || operationKey.length > 128 ||
                operationKey.any { it.code !in 33..126 }))
        ) {
            complete(Result.failure(IllegalArgumentException("INVALID_NATIVE_REQUEST"))); return
        }
        transmit(path, method, body, "Bearer $token", operationKey, complete)
    }

    /**
     * Cookie-free native credential exchange. `bearer` is supplied on purpose by the session
     * manager (the access token it holds in memory) or null for a first sign-in with no session
     * yet. No operation key is invented for these routes: their idempotency is the durable
     * challenge/family state on the server, not a client-generated key.
     */
    fun authRequest(
        path: String, bearer: String?, body: String,
        complete: (Result<Pair<Int, String>>) -> Unit
    ) {
        if (origin == null) {
            complete(Result.failure(IllegalStateException("ONLINE_UNAVAILABLE"))); return
        }
        if (path !in nativePaths || body.toByteArray().size > maxBodyBytes ||
            (bearer != null && (bearer.length !in 24..8192 || bearer.any { it.code !in 33..126 }))
        ) {
            complete(Result.failure(IllegalArgumentException("INVALID_NATIVE_REQUEST"))); return
        }
        transmit(path, "POST", body, bearer?.let { "Bearer $it" }, null, complete)
    }

    private fun transmit(
        path: String, method: String, body: String?, authorization: String?, operationKey: String?,
        complete: (Result<Pair<Int, String>>) -> Unit
    ) {
        val host = origin ?: run {
            complete(Result.failure(IllegalStateException("ONLINE_UNAVAILABLE"))); return
        }
        /* Exactly-once completion. The watchdog fires when a transmit outlives its own timeouts
         * (DNS has none), so the caller always gets one answer and the pool is never the reason
         * a request hangs. A thread still stuck in the OS resolver eventually dies on its own. */
        val finished = AtomicBoolean(false)
        val watchdog = watchdogs.schedule({
            if (finished.compareAndSet(false, true)) {
                main.post { complete(Result.failure(IllegalStateException("REQUEST_TIMEOUT"))) }
            }
        }, 20L, TimeUnit.SECONDS)
        executor.execute {
            val result = runCatching {
                val url = URL(host, path)
                require(url.host == host.host && url.protocol == "https")
                val conn = url.openConnection() as HttpURLConnection
                conn.instanceFollowRedirects = false
                conn.connectTimeout = 6000
                conn.readTimeout = 12000
                conn.requestMethod = method
                conn.setRequestProperty("Accept", "application/json")
                if (authorization != null) conn.setRequestProperty("Authorization", authorization)
                // There is no cookie jar anywhere in this client: the header is never composed.
                conn.setRequestProperty("Cache-Control", "no-store")
                conn.useCaches = false
                try {
                    if (body != null) {
                        conn.doOutput = true
                        conn.setRequestProperty("Content-Type", "application/json")
                        if (operationKey != null) conn.setRequestProperty("Idempotency-Key", operationKey)
                        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                    }
                    val status = conn.responseCode
                    require(status in 200..599 && status !in 300..399) { "SERVICE_UNAVAILABLE" }
                    require(conn.contentType?.substringBefore(';')?.trim() == "application/json")
                    val stream = if (status >= 400) conn.errorStream else conn.inputStream
                    val bytes = stream?.use { input ->
                        val output = ByteArrayOutputStream()
                        val chunk = ByteArray(8192)
                        while (true) {
                            val n = input.read(chunk)
                            if (n < 0) break
                            require(output.size() + n <= maxResponseBytes) { "RESPONSE_TOO_LARGE" }
                            output.write(chunk, 0, n)
                        }
                        output.toString("UTF-8")
                    } ?: "{}"
                    JSONObject(bytes) // Always validate response as JSON.
                    status to bytes
                } finally {
                    conn.disconnect()
                }
            }
            watchdog.cancel(false)
            if (finished.compareAndSet(false, true)) {
                main.post { complete(result) }
            }
        }
    }

    fun close() {


        accessToken = null


        executor.shutdownNow()


        /* Queued transmits are dropped by shutdownNow, but their callers must still get one


         * bounded answer: keep the watchdog pool alive past the longest pending timer and let


         * it stop itself afterwards. */


        watchdogs.schedule({ watchdogs.shutdownNow() }, 25L, TimeUnit.SECONDS)


    }
}
