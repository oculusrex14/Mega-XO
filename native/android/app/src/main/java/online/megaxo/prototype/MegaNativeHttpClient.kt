package online.megaxo.prototype

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * P20-03 native HTTPS transport, initially disabled until the P05 native
 * bearer/access and refresh lifecycle is available. This is not a JS fetch proxy.
 * No session cookie, client-supplied Authorization, or arbitrary host ever leaves.
 */
internal class MegaNativeHttpClient(apiOrigin: String?) {
    private val origin: URL? = runCatching {
        val url = URL(apiOrigin ?: "")
        require(url.protocol == "https" && url.userInfo == null && (url.path == "" || url.path == "/") &&
            url.query == null && url.ref == null)
        url
    }.getOrNull()
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var accessToken: String? = null
    private val prefixes = listOf(
        "/api/account/", "/api/community/", "/api/monetization/", "/api/v1/", "/api/party/"
    )

    fun installVerifiedAccessToken(token: String?) {
        accessToken = token?.takeIf {
            it.length in 24..8192 && it.all { c -> c.code in 33..126 }
        }
    }

    fun revokeLocalAccess() { accessToken = null }

    fun request(
        path: String, method: String, body: String?, operationKey: String?,
        complete: (Result<Pair<Int, String>>) -> Unit
    ) {
        val host = origin
        val token = accessToken
        if (host == null || token == null) {
            complete(Result.failure(IllegalStateException("ONLINE_UNAVAILABLE"))); return
        }
        if (method !in listOf("GET", "POST") ||
            !path.startsWith("/api/") || path.length > 512 ||
            listOf("..", "//", "%", "#", "?").any { path.contains(it) } ||
            prefixes.none { path.startsWith(it) } ||
            (method == "GET" && body != null) ||
            (method == "POST" && (body == null || body.toByteArray().size > 65536)) ||
            (method == "POST" && (operationKey.isNullOrEmpty() || operationKey.length > 128 ||
                operationKey.any { it.code !in 33..126 }))
        ) {
            complete(Result.failure(IllegalArgumentException("INVALID_NATIVE_REQUEST"))); return
        }
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
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.setRequestProperty("Cache-Control", "no-store")
                conn.useCaches = false
                try {
                    if (body != null) {
                        conn.doOutput = true
                        conn.setRequestProperty("Content-Type", "application/json")
                        conn.setRequestProperty("Idempotency-Key", operationKey!!)
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
                            require(output.size() + n <= 524288) { "RESPONSE_TOO_LARGE" }
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
            main.post { complete(result) }
        }
    }

    fun close() { accessToken = null; executor.shutdownNow() }
}
