package online.megaxo.prototype

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.Executors

/**
 * P05/P20-03 native session lifecycle. This is the ONLY holder of the access and refresh
 * credentials: the access token lives in this object's memory, the refresh credential lives in
 * [MegaSecureSessionVault] (Android Keystore AES-GCM ciphertext, never exportable, no backup).
 * JavaScript never receives, supplies or stores either value.
 *
 * The exact wire contract is frozen by the repository's own validators, not invented here:
 *   - request bodies  <- packages/contracts/access-dto.js:validateNativeTokenGrant, whose provider
 *     branch delegates to native-bridge.js:validateFinishRequest. So the provider grant body on
 *     /native/token IS the finish request {provider,state,idToken}; there is no separate finish
 *     round trip on the bearer path (that route belongs to the cookie/browser surface).
 *   - Authorization: Bearer <access>, no cookie, no Origin, no CSRF header on token/refresh/logout.
 *   - refreshToken is base64url and at most MAX_REFRESH_TOKEN_LENGTH (512) characters.
 *
 * Failure policy:
 *   - strict response validation; anything unparseable raises NATIVE_SESSION_INVALID_RESPONSE and
 *     the previously held session is left exactly as it was (never half-overwritten);
 *   - an absent refreshToken means "keep the stored one", never "clear it";
 *   - HTTP 401 from /native/refresh is TERMINAL revocation: the vault is wiped, the access token
 *     dropped, and the WebView is told to return to the signed-out account state.
 */
internal class MegaNativeSessionManager(
    private val vault: MegaSecureSessionVault,
    private val transport: MegaNativeHttpClient
) {
    data class Session(
        val accessToken: String,
        val refreshToken: String?,
        val expiresAt: Long,
        val actorId: String?
    )

    enum class Outcome { OK, INVALID, UNAVAILABLE, REVOKED }

    /**
     * Vault I/O runs here, never on the caller's thread: a Keystore key lookup plus AES-GCM
     * operation is real I/O and must not block the UI thread that WebView message callbacks arrive
     * on. Callbacks are posted back to the main thread so the session state is always observed in
     * one place.
     */
    /* Vault I/O is real Android Keystore work and has been observed to stall indefinitely on at
     * least one device (OnePlus Nord CE, Android 13). Two threads plus per-operation watchdogs
     * below mean one stalled Keystore call can no longer poison the rotation gate or the whole
     * queue: callers get an honest UNAVAILABLE and later operations keep a free thread. */
    private val io = Executors.newFixedThreadPool(2) { runnable ->
        Thread(runnable, "megaxo-session-io").apply { isDaemon = true }
    }
    private val watchdogs = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "megaxo-session-watchdog").apply { isDaemon = true }
    }
    private val main = Handler(Looper.getMainLooper())
    private var session: Session? = null
    private var refreshing = false
    /** Anonymous-session continuity token for the native email challenge/verify/reset lane.
     * Issued by the server with the challenge, held in memory only, never crosses to the page,
     * and cleared on any linked install, sign-out or revocation. */
    @Volatile private var emailSessionToken: String? = null
    /** Bumped at every accepted rotation start; gates stale completions from older rotations. */
    private var rotationGeneration = 0L
    private val pendingRefresh = mutableListOf<(Outcome) -> Unit>()
    /** Set once a refresh returned 401. Until a fresh sign-in succeeds, online use is refused. */
    @Volatile private var revoked = false

    @Synchronized
    fun currentAccessToken(): String? = session?.accessToken

    @Synchronized
    fun status(): Triple<Boolean, Long, String?> =
        Triple(session != null, session?.expiresAt ?: 0L, session?.actorId)

    /** Providers for which this build actually compiled a native adapter (Google: Gradle client id). */
    fun nativeProviders(): List<String> = listOf("google").filter { transport.isConfigured() && providerAdapters.contains(it) }

    /** Declared once by the activity when it installs a provider bridge. Never invents a provider. */
    var providerAdapters: Set<String> = emptySet()

    /** Called by the activity when the WebView reaches the signed-out state; keeps native in step. */
    @Synchronized
    fun clearLocal() {
        session = null
        emailSessionToken = null
        transport.revokeLocalAccess()
    }

    /**
     * Cookie-free native email lane (contract account.native.email). A fresh install presents no
     * credential: the server bootstraps the anonymous session the flow continues on and returns
     * its token IN THE BODY; it is held in memory only. A linked response is the frozen
     * {accessToken, refreshToken, expiresIn, actorId} family, installed exactly like a sign-in.
     * The reply carries only safe auth-state fields - no credential value ever reaches the page.
     */
    fun email(body: JSONObject, complete: (JSONObject) -> Unit) {
        synchronized(this) {
            if (revoked) { complete(MegaNativeEmailProtocol.error("REVOKED")); return }
        }
        val bearer = synchronized(this) { session?.accessToken } ?: emailSessionToken
        val action = body.optString("action", "")
        io.execute {
            transport.authRequest("/api/account/native/email", bearer, body.toString()) { result ->
                val response = result.getOrNull()
                if (response == null) {
                    // Only bounded public fault codes cross the bridge; never raw transport errors.
                    val code = result.exceptionOrNull()?.message ?: "SERVICE_UNAVAILABLE"
                    main.post { complete(MegaNativeEmailProtocol.error(code)) }
                    return@authRequest
                }
                val (status, raw) = response
                val parsed = runCatching { JSONObject(raw) }.getOrNull()
                if (parsed == null) {
                    main.post { complete(MegaNativeEmailProtocol.error("EMAIL_RESPONSE_INVALID", status)) }
                    return@authRequest
                }
                if (status !in 200..299) {
                    val code = parsed.optString("error", "SERVICE_UNAVAILABLE")
                    main.post { complete(MegaNativeEmailProtocol.error(code, status)) }
                    return@authRequest
                }

                if (parsed.has("accessToken")) {
                    // A linked response is handled by the same vetted vault/session installer as
                    // Google sign-in; no access/refresh token is forwarded to JavaScript.
                    applyServerResponse(result, rotating = false, generation = null) { outcome ->
                        val reply = if (outcome == Outcome.OK) {
                            synchronized(this) { emailSessionToken = null }
                            JSONObject().put("ok", true).put("linked", true)
                                .put("actorId", parsed.optString("actorId", ""))
                        } else {
                            MegaNativeEmailProtocol.error(outcome.name)
                        }
                        main.post { complete(reply) }
                    }
                    return@authRequest
                }

                // Account creation/forgot/reset-proof must return a real, action-matched challenge.
                // Never answer ok:true for an empty/malformed success response.
                val reply = runCatching { MegaNativeEmailProtocol.unlinked(action, parsed) }
                    .getOrElse { MegaNativeEmailProtocol.error("EMAIL_RESPONSE_INVALID", status) }
                if (reply.optBoolean("ok", false)) {
                    val continuation = MegaNativeEmailProtocol.anonymousContinuation(parsed)
                    if (bearer == null && continuation == null) {
                        main.post { complete(MegaNativeEmailProtocol.error("EMAIL_RESPONSE_INVALID", status)) }
                        return@authRequest
                    }
                    if (continuation != null) synchronized(this) { emailSessionToken = continuation }
                }
                main.post { complete(reply) }
            }
        }
    }

    /**
     * Server-issued challenge for a first sign-in: {state, nonce, expires}. This is the ONLY native
     * route that is legitimately called with no access token, because a caller who has never signed
     * in has none. No nonce or state is ever generated locally; a fabricated state would be rejected
     * as INVALID_AUTH_STATE by the server's stored-attempt comparison.
     */
    fun challenge(provider: String, intent: String, complete: (Result<JSONObject>) -> Unit) {
        if (provider !in listOf("google", "apple") || intent !in listOf("login", "link", "reauth")) {
            complete(Result.failure(IllegalArgumentException("INVALID_AUTH_REQUEST"))); return
        }
        val body = JSONObject().put("provider", provider).put("intent", intent).toString()
        transport.authRequest("/api/account/native/challenge", null, body) { result ->
            val response: Pair<Int, String>? = result.getOrNull()
            if (response == null || response.first !in 200..299) {
                complete(Result.failure(IllegalStateException("NATIVE_CHALLENGE_FAILED"))); return@authRequest
            }
            val parsed: JSONObject? = runCatching { JSONObject(response.second) }.getOrNull()
            if (parsed == null) {
                complete(Result.failure(IllegalStateException("NATIVE_CHALLENGE_FAILED"))); return@authRequest
            }
            val state = parsed.optString("state", "")
            val nonce = parsed.optString("nonce", "")
            // native-bridge.js bounds: base64url state/nonce, each at most 512 characters.
            if (state.isEmpty() || state.length > 512 || !BASE64URL.matches(state) ||
                nonce.isEmpty() || nonce.length > 512 || !BASE64URL.matches(nonce)
            ) {
                complete(Result.failure(IllegalStateException("NATIVE_CHALLENGE_FAILED"))); return@authRequest
            }
            val result = JSONObject().put("state", state).put("nonce", nonce)
            // A first-ever sign-in bootstraps the session the attempt hangs off; the token
            // call must present it or the server answers AUTH_REQUIRED.
            val sessionToken = parsed.optString("sessionToken", "")
            if (sessionToken.isNotEmpty()) result.put("sessionToken", sessionToken)
            complete(Result.success(result))
        }
    }

    /**
     * Provider grant: the caller has already obtained {provider,state,idToken} from the
     * challenge + SDK flow. Nothing here mints a credential; every value is server-issued.
     */
    fun signIn(grant: JSONObject, complete: (Outcome) -> Unit) {
        val provider = grant.optString("provider", "")
        val state = grant.optString("state", "")
        val idToken = grant.optString("idToken", "")
        val sessionToken = grant.optString("sessionToken", "")
        // Mirrors native-bridge.js bounds: provider allowlist, state/nonce <=512 base64url, and a
        // 3-segment compact JWS <=16384. A body that could never verify is refused before any I/O.
        if (provider !in listOf("google", "apple") ||
            state.isEmpty() || state.length > 512 || !BASE64URL.matches(state) ||
            idToken.isEmpty() || idToken.length > 16384 ||
            idToken.split('.').let { it.size != 3 || it.any { part -> part.isEmpty() || !BASE64URL.matches(part) } }
        ) {
            complete(Outcome.INVALID); return
        }
        val body = JSONObject()
            .put("provider", provider)
            .put("state", state)
            .put("idToken", idToken)
            .put("sessionToken", sessionToken)
            .toString()
        transport.authRequest("/api/account/native/token", null, body) { result ->
            applyServerResponse(result, complete)
        }
    }

    /**
     * Refresh the access token. Single-flight: concurrent callers share one in-flight rotation, so
     * the family is never rotated twice for one expiry (design B3.2).
     */
    fun refresh(complete: (Outcome) -> Unit) {
        val held: String?
        val generation: Long
        synchronized(this) {
            if (revoked) { complete(Outcome.REVOKED); return }
            if (refreshing) { pendingRefresh.add(complete); return }
            held = session?.refreshToken
            refreshing = true
            /* F1: the CALLER THAT STARTS the rotation is a waiter too. Only queued callers were
             * registered before, so finishRotation never answered the initiator - success,
             * failure and the watchdog all lost its callback. */
            pendingRefresh.add(complete)
            rotationGeneration += 1
            generation = rotationGeneration
        }
        /* The gate is released by finishRotation(generation) ONLY, and the transport callback
         * beneath this rotation is itself watchdog-bounded, so this timer is the second belt: if
         * anything under us stalls (a wedged Keystore read on the io pool, a lost reply), the
         * caller still gets one honest UNAVAILABLE and the gate reopens for the next attempt. */
        watchdogs.schedule({
            /* F3: JavaScriptReplyProxy is @UiThread - every bridge answer is posted, never
             * called from a watchdog thread. */
            main.post { finishRotation(generation, Outcome.UNAVAILABLE) }
        }, 15L, TimeUnit.SECONDS)
        io.execute {
            val stored = held ?: vault.loadRefreshCredentialOrNull()
            main.post {
                if (stored == null) { finishRotation(generation, Outcome.INVALID); return@post }
                val body = JSONObject()
                    .put("grant", "refresh_token")
                    .put("refreshToken", stored)
                    .toString()
                // The refresh grant IS the credential; an expired access token is deliberately not
                // presented. The server refuses a cookie+bearer pair anyway.
                transport.authRequest("/api/account/native/refresh", null, body) { result ->
                    applyServerResponse(result, rotating = true, generation = generation) { outcome ->
                        finishRotation(generation, outcome)
                    }
                }
            }
        }
    }

    /** Releases the single-flight gate for one rotation generation; stale releases are ignored. */
    private fun finishRotation(generation: Long, outcome: Outcome) {
        val waiters: List<(Outcome) -> Unit>
        synchronized(this) {
            if (generation != rotationGeneration) return
            refreshing = false
            waiters = pendingRefresh.toList()
            pendingRefresh.clear()
        }
        waiters.forEach { it(outcome) }
    }

    /**
     * Cold-start vault restore. [status] is memory-only, so after process death a vaulted refresh
     * credential would otherwise never be used again and a signed-in owner would silently become
     * a guest on every relaunch. The JS adapter calls this ONCE per process when the first
     * session read reports no live session; the host then runs the same single-flight rotation as
     * [refresh]. Outcomes: OK restores the session, INVALID means nothing usable is stored,
     * REVOKED honours a prior terminal revocation, UNAVAILABLE is a transport/storage failure.
     * No credential value ever crosses the bridge in either direction.
     */
    fun restoreIfStored(complete: (Outcome) -> Unit) {
        synchronized(this) {
            if (session != null) { complete(Outcome.OK); return }
            if (revoked) { complete(Outcome.REVOKED); return }
        }
        /* The vault read below has no intrinsic timeout (Android Keystore can stall on a wedged
         * TEE), so bound the whole restore: the caller gets UNAVAILABLE rather than a hang, and a
         * stalled read cannot consume the callback. */
        val answered = AtomicBoolean(false)
        watchdogs.schedule({
            /* F3: bridge answers are posted to the main thread (JavaScriptReplyProxy contract). */
            main.post {
                if (answered.compareAndSet(false, true)) complete(Outcome.UNAVAILABLE)
            }
        }, 8L, TimeUnit.SECONDS)
        io.execute {
            val stored = vault.loadRefreshCredentialOrNull()
            main.post {
                if (!answered.compareAndSet(false, true)) return@post
                if (stored == null) { complete(Outcome.INVALID); return@post }
                // Called from main, never from inside an io task: refresh enqueues its own work
                // on the same single-thread io executor, and nesting here would self-deadlock.
                refresh(complete)
            }
        }
    }

    /** Best-effort family revocation. A 2xx is treated as revoked; a failure never blocks logout. */
    fun signOut(allDevices: Boolean, complete: (Outcome) -> Unit) {
        val token = currentAccessToken()
        val body = JSONObject().apply { if (allDevices) put("allDevices", true) }.toString()
        val finish = { outcome: Outcome ->
            synchronized(this) {
                session = null
                emailSessionToken = null
                revoked = false
                transport.revokeLocalAccess()
            }
            val answer = if (outcome == Outcome.OK) Outcome.OK else Outcome.INVALID
            io.execute { runCatching { vault.clear() }; main.post { complete(answer) } }
        }
        if (token == null) { finish(Outcome.OK); return }
        transport.authRequest("/api/account/native/logout", token, body) { result ->
            finish(result.fold({ Outcome.OK }, { Outcome.INVALID }))
        }
    }

    /** Terminal revocation: wipe every local trace and refuse online use until a new sign-in. */
    private fun revokeEverything() {
        synchronized(this) {
            session = null
            emailSessionToken = null
            revoked = true
            transport.revokeLocalAccess()
        }
        io.execute { runCatching { vault.clear() } }
    }

    /**
     * Validates the frozen response shape and installs it. Any deviation leaves the existing
     * session untouched: a half-parsed credential is never stored.
     */
    private fun applyServerResponse(
        result: Result<Pair<Int, String>>, complete: (Outcome) -> Unit
    ) {
        applyServerResponse(result, rotating = false, generation = null, complete = complete)
    }

    /* generation: the rotation generation this reply belongs to (null for sign-in). A STALE
     * reply - one that lost its generation while queued behind a watchdog or a wedged vault op -
     * must never answer the current gate, revoke the family, or overwrite newer session state;
     * its credential is still persisted because the server already accepted that rotation. */
    private fun applyServerResponse(
        result: Result<Pair<Int, String>>, rotating: Boolean, generation: Long?, complete: (Outcome) -> Unit
    ) {
        val stale = generation != null && synchronized(this) { generation != rotationGeneration }
        val response = result.getOrNull()
        if (response == null) { if (!stale) complete(Outcome.UNAVAILABLE); return }
        val (status, raw) = response
        if (status == 401 && rotating) {
            if (stale) return
            revokeEverything(); complete(Outcome.REVOKED); return
        }
        /* The token-leg response body is never logged: it can carry access/refresh tokens, and a
           debug line that prints it would put live credentials in logcat. The status alone is the
           diagnostic, matching how every other transport failure in this file is surfaced. */
        if (status !in 200..299) { complete(Outcome.UNAVAILABLE); return }
        val parsed = runCatching { JSONObject(raw) }.getOrNull()
        if (parsed == null) { complete(Outcome.INVALID); return }
        val access = parsed.optString("accessToken", "")
        if (access.isEmpty() || access.length !in 24..8192 ||
            access.split('.').let { it.size != 3 || it.any { part -> part.isEmpty() || !BASE64URL.matches(part) } }
        ) {
            complete(Outcome.INVALID); return
        }
        val issuedRefresh = parsed.optString("refreshToken", "")
        if (issuedRefresh.isNotEmpty() &&
            (issuedRefresh.length > MAX_REFRESH_TOKEN_LENGTH || !BASE64URL.matches(issuedRefresh))
        ) {
            complete(Outcome.INVALID); return
        }
        val expiresIn = if (parsed.has("expiresIn")) {
            val seconds = parsed.optInt("expiresIn", -1)
            if (seconds !in 30..86400) { complete(Outcome.INVALID); return }
            seconds
        } else {
            // Documented fallback only when the server omits the field (design B2.1 access TTL).
            DEFAULT_ACCESS_TTL_SECONDS
        }
        val actorId = parsed.optString("actorId", "").takeIf { it.isNotEmpty() }
        val heldRefresh = session?.refreshToken
        io.execute {
            // Persist the refresh credential BEFORE it can be needed: the vault write must succeed
            // or the whole exchange is refused, otherwise a rotation would be lost on next launch.
            val refresh = issuedRefresh.takeIf { it.isNotEmpty() } ?: heldRefresh
                ?: vault.loadRefreshCredentialOrNull()
            if (refresh != null && runCatching { vault.saveRefreshCredential(refresh) }.isFailure) {
                if (!stale) main.post { complete(Outcome.UNAVAILABLE) }
                return@execute
            }
            main.post {
                /* The credential is server truth and is ALWAYS persisted; the session/token
                 * install is skipped for a stale reply so an abandoned rotation can never
                 * downgrade a newer rotation's state. */
                val current = generation == null || synchronized(this) { generation == rotationGeneration }
                if (current) {
                    synchronized(this) {
                        session = Session(access, refresh, now() + expiresIn * 1000L, actorId)
                        revoked = false
                    }
                    transport.installVerifiedAccessToken(access)
                }
                complete(Outcome.OK)
            }
        }
    }

    /* F5: teardown settles every outstanding rotation waiter (one honest UNAVAILABLE) and stops
     * its own watchdogs, so a destroyed host can never leave promises or timers dangling. */
    fun close() {
        synchronized(this) {
            session = null
            val waiters = pendingRefresh.toList()
            pendingRefresh.clear()
            io.execute {
                runCatching { vault.clear() }
                main.post { waiters.forEach { it(Outcome.UNAVAILABLE) } }
            }
        }
        io.shutdownNow()
        watchdogs.shutdownNow()
    }

    private fun now(): Long = System.currentTimeMillis()

    companion object {
        /** packages/contracts/access-dto.js MAX_REFRESH_TOKEN_LENGTH. */
        const val MAX_REFRESH_TOKEN_LENGTH = 512
        /** design B2.1 access TTL, used ONLY when the server omits expiresIn. */
        const val DEFAULT_ACCESS_TTL_SECONDS = 300
        private val BASE64URL = Regex("^[A-Za-z0-9_-]+$")

        private fun MegaSecureSessionVault.loadRefreshCredentialOrNull(): String? =
            runCatching { loadRefreshCredential() }.getOrNull()
    }
}
