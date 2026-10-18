package online.megaxo.prototype

import java.net.URI
import java.net.URLDecoder
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/** Shared by the page bridge and HTTPS transport; never accepts a caller-selected origin. */
internal object MegaNativeWirePolicy {
    private val prefixes = listOf("/api/account/", "/api/community/", "/api/monetization/", "/api/v1/", "/api/party/")
    private val queryKeys = mapOf(
        "/api/community/search" to setOf("q"),
        "/api/v1/leaderboard" to setOf("scope", "region", "league", "metric")
    )

    fun acceptsPath(value: String): Boolean = runCatching {
        require(value.length in 1..512 && value.all { it.code in 33..126 && it != '\\' })
        val uri = URI(value)
        require(uri.scheme == null && uri.rawAuthority == null && uri.rawFragment == null)
        val path = uri.rawPath ?: error("PATH_REQUIRED")
        require(prefixes.any { path.startsWith(it) })
        require(listOf("..", "//", "%").none { path.contains(it) })
        uri.rawQuery?.let { query ->
            val allowed = queryKeys[path] ?: error("QUERY_NOT_ALLOWED")
            val seen = mutableSetOf<String>()
            for (part in query.split('&')) {
                val pair = part.split('=', limit = 2)
                require(pair.size == 2 && pair[0] in allowed && seen.add(pair[0]))
                val decoded = URLDecoder.decode(pair[1], "UTF-8")
                require(decoded.none { it.code < 32 || it.code == 127 })
            }
        }
        true
    }.getOrDefault(false)

    /** Read endpoints legitimately return either objects or lists. Scalars are not API envelopes. */
    fun parseResponse(text: String): Any {
        val parser = JSONTokener(text)
        val value = parser.nextValue()
        require(value is JSONObject || value is JSONArray) { "INVALID_NATIVE_RESPONSE" }
        require(parser.nextClean() == '\u0000') { "INVALID_NATIVE_RESPONSE" }
        return value
    }

    fun responseEnvelope(status: Int, text: String): JSONObject {
        val value = parseResponse(text)
        val payload = JSONObject().put("ok", status in 200..299).put("status", status).put("data", value)
        if (status !in 200..299) {
            val code = (value as? JSONObject)?.optString("error", "") ?: ""
            payload.put("error", code.takeIf { Regex("^[A-Z0-9_]{1,80}$").matches(it) } ?: "SERVICE_UNAVAILABLE")
        }
        return payload
    }
}
