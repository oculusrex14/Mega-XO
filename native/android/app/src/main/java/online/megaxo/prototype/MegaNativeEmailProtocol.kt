package online.megaxo.prototype

import org.json.JSONObject

/**
 * Exact public reply for the cookie-free native email workflow. This is intentionally separate
 * from the credential path: no session token, OTP, password, or provider response body crosses
 * into WebView JavaScript. Only the safe masked recipient and challenge metadata are returned.
 */
internal object MegaNativeEmailProtocol {
    private val errorCode = Regex("^[A-Z][A-Z0-9_]{0,63}$")
    private val anonymousToken = Regex("^[A-Za-z0-9_-]{24,2048}$")
    private val publicFields = listOf(
        "verificationRequired", "challengeId", "email", "maskedEmail",
        "message", "resetReady", "expiresAt", "resendAt"
    )

    fun error(code: String, status: Int = 0): JSONObject =
        JSONObject().put("ok", false)
            .put("error", code.takeIf { errorCode.matches(it) } ?: "SERVICE_UNAVAILABLE")
            .put("status", status)

    /** A challenge-continuation token never enters the public reply. */
    fun anonymousContinuation(server: JSONObject): String? =
        server.optString("sessionToken", "")
            .takeIf { anonymousToken.matches(it) }

    /**
     * A 200 response must actually represent this action. An empty body, broken deployment or
     * mismatched native route cannot silently become an apparent successful sign-in.
     */
    fun unlinked(action: String, server: JSONObject): JSONObject {
        val challengeId = server.optString("challengeId", "")
        require(challengeId.isNotEmpty() && challengeId.length <= 64) { "EMAIL_RESPONSE_INVALID" }
        when (action) {
            "continue" -> require(server.optBoolean("verificationRequired", false)) { "EMAIL_RESPONSE_INVALID" }
            "forgot" -> require(server.optString("message", "").isNotEmpty()) { "EMAIL_RESPONSE_INVALID" }
            "verify" -> require(server.optBoolean("resetReady", false)) { "EMAIL_RESPONSE_INVALID" }
            // reset must create a linked credential family, and is handled separately.
            else -> throw IllegalArgumentException("EMAIL_RESPONSE_INVALID")
        }
        val response = JSONObject().put("ok", true).put("linked", false)
        for (key in publicFields) {
            if (server.has(key) && !server.isNull(key)) response.put(key, server.get(key))
        }
        return response
    }
}
