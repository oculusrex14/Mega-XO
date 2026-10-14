package online.megaxo.prototype

import android.content.Context
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JsPromptResult
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * V5.1 same-Wi-Fi room transport for the signed game.
 *
 * The approved tournament rules, the guest-session contract and the HTTP contract all live in
 * `src/lan/` and ship inside this bundle. This bridge owns ONLY the two things JavaScript cannot
 * have - a real TCP listener and an NSD record - and publishes exactly the frozen primitives those
 * modules read at call time:
 *
 *   window.MegaLanSocket.start(port)  -> {ok:true, port} | {ok:false, error}
 *   window.MegaLanSocket.stop()       -> {ok:true}
 *   window.MegaLanSocket.status()     -> {listening, port, origin}
 *   window.MegaLanDiscovery.advertise(name, port) -> {ok:true} | {ok:false, error}
 *   window.MegaLanDiscovery.stop()                -> {ok:true}
 *   window.MegaLanDiscovery.browse(timeoutMs)     -> Promise<[{name, origin, rooms}]>
 *
 * `start`, `stop`, `status` and `advertise` are SYNCHRONOUS in the frozen contract:
 * `src/lan/lan-host.js` reads `started.ok` and `status().listening` directly without awaiting
 * anything, so an asynchronous message channel cannot serve them. They are answered through the one
 * synchronous page-to-host channel a WebView has without `.addJavascriptInterface(...)`, which this
 * package refuses on purpose: a page `prompt()` handled by `WebChromeClient.onJsPrompt`. Every
 * prompt is gated to the exact signed entry document, and a prompt without this bridge's prefix is
 * handed straight back to the superclass. `browse` is a Promise by contract and therefore uses a
 * reply channel exactly like [MegaNativeApiBridge].
 *
 * For every accepted connection the raw bytes are parsed here - request line, headers, a
 * Content-Length body capped at 16 KiB, chunked refused - and handed to the page as one JSON string,
 * which it answers by calling `window.MegaLanRoom.handle(<requestJson>)`. That call is marshalled
 * onto the main thread with `evaluateJavascript` and a completion callback, with a 2 s ceiling after
 * which the client receives `503 SERVICE_UNAVAILABLE`. A page that has not published its handler yet
 * gets that same 503: nothing here ever throws across the bridge.
 *
 * The page's own room traffic is carried by [partyFetch] as well. Android's network security
 * configuration matches a `<domain>` as an exact host name and has no CIDR syntax, so the private
 * Wi-Fi ranges cannot be permitted in XML at all (see res/xml/network_security_config.xml), and an
 * `https://` document may not fetch `http://` while `MIXED_CONTENT_NEVER_ALLOW` is in force. Carrying
 * those calls on this bridge's own socket keeps the whole destination check in code - scheme http, a
 * private / link-local / loopback literal, a `/api/party/` path, and nothing else - which is strictly
 * narrower than any address-range rule and still leaves the page unable to reach a public origin.
 *
 * A room host on the Wi-Fi is often Node's `http` server rather than another phone, and Node answers
 * a JSON body with `Transfer-Encoding: chunked`. [parseResponse] therefore undoes the transfer coding
 * before the body reaches the page - chunked decoded and reassembled, `Content-Length` honoured,
 * a body with neither read to the close - and a body whose framing cannot be undone becomes a clean
 * `502 {"error":"UPSTREAM_DECODE"}` instead of a size-prefixed, truncated string the lobby would only
 * mis-parse. The same reader serves the NSD discovery fetch and this device's own listener.
 *
 * No bearer token, request body or actor id is ever logged, echoed into an error or stored.
 */
internal class MegaAndroidLanBridge private constructor(
    context: Context,
    private val game: WebView,
    private val entryUrl: String,
    private val assets: WebViewAssetLoader
) {
    private data class Answer(val status: Int, val body: String, val headers: JSONObject?)

    private val main = Handler(Looper.getMainLooper())
    private val connections: ExecutorService = Executors.newFixedThreadPool(4) { runnable ->
        Thread(runnable, "megaxo-lan-http").apply { isDaemon = true }
    }
    private val outbound: ExecutorService = Executors.newFixedThreadPool(2) { runnable ->
        Thread(runnable, "megaxo-lan-out").apply { isDaemon = true }
    }
    private val nsd: NsdManager? = context.getSystemService(Context.NSD_SERVICE) as? NsdManager

    @Volatile private var server: ServerSocket? = null
    @Volatile private var boundPort = 0
    @Volatile private var closed = false
    private val accepting = AtomicBoolean(false)
    private val slots = Semaphore(4)

    private var registration: NsdManager.RegistrationListener? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private val pending = ArrayDeque<NsdServiceInfo>()
    private val browsing = AtomicBoolean(false)
    private val resolving = AtomicBoolean(false)

    // ------------------------------------------------------------------ frozen primitives

    /** Binds `0.0.0.0` on the requested port, or one of the two next ports when it is taken. */
    private fun start(requested: Int): JSONObject {
        if (closed) return JSONObject().put("ok", false).put("error", "START_FAILED")
        if (requested !in 1024..65535) {
            return JSONObject().put("ok", false).put("error", "BIND_FAILED")
        }
        val existing = server
        if (existing != null && !existing.isClosed && boundPort == requested) {
            return JSONObject().put("ok", true).put("port", boundPort)
        }
        stopListening()
        val bound = bind(requested)
        if (bound == null) {
            stopListening()
            return JSONObject().put("ok", false).put("error", "BIND_FAILED")
        }
        server = bound.first
        boundPort = bound.second
        accepting.set(true)
        val thread = try {
            Thread({ acceptLoop(bound.first) }, "megaxo-lan-accept").apply { isDaemon = true }
        } catch (_: Throwable) {
            stopListening()
            return JSONObject().put("ok", false).put("error", "START_FAILED")
        }
        thread.start()
        return JSONObject().put("ok", true).put("port", boundPort)
    }

    private fun bind(requested: Int): Pair<ServerSocket, Int>? {
        for (candidate in requested..(requested + 2)) {
            if (candidate !in 1024..65535) continue
            val socket = try {
                ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress("0.0.0.0", candidate), BACKLOG)
                }
            } catch (_: Throwable) {
                null
            } ?: continue
            return socket to candidate
        }
        return null
    }

    private fun stopListening() {
        accepting.set(false)
        val open = server
        server = null
        boundPort = 0
        if (open != null) runCatching { open.close() }
    }

    private fun stop(): JSONObject {
        stopListening()
        return JSONObject().put("ok", true)
    }

    private fun status(): JSONObject {
        val open = server
        val listening = open != null && !open.isClosed && boundPort > 0
        return JSONObject()
            .put("listening", listening)
            .put("port", if (listening) boundPort else JSONObject.NULL)
            .put("origin", if (listening) lanOrigin() else JSONObject.NULL)
    }

    /** This device's LAN address and real port: what a friend sitting beside it can type. */
    private fun lanOrigin(): String? {
        val port = boundPort
        if (port <= 0) return null
        var fallback: String? = null
        try {
            for (nic in NetworkInterface.getNetworkInterfaces() ?: return null) {
                if (!nic.isUp) continue
                for (address in nic.inetAddresses) {
                    if (address !is Inet4Address || address.isLoopbackAddress) continue
                    val text = address.hostAddress ?: continue
                    // A private address is what a peer on the same Wi-Fi can route to; a carrier or
                    // USB address is only a last resort, because the lobby must show a usable URL.
                    if (address.isSiteLocalAddress) return "http://$text:$port"
                    if (fallback == null) fallback = "http://$text:$port"
                }
            }
        } catch (_: Throwable) {
            return null
        }
        return fallback
    }

    private fun advertise(name: String, port: Int): JSONObject {
        val manager = nsd ?: return JSONObject().put("ok", false).put("error", "DISCOVERY_UNAVAILABLE")
        if (port !in 1024..65535) {
            return JSONObject().put("ok", false).put("error", "DISCOVERY_UNAVAILABLE")
        }
        stopAdvertising()
        val service = NsdServiceInfo().apply {
            serviceName = name.trim().take(48).ifEmpty { "Mega XOXO host" }
            serviceType = SERVICE_TYPE
            setPort(port)
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) = Unit
            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) = Unit
            override fun onServiceUnregistered(info: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) = Unit
        }
        return try {
            manager.registerService(service, NsdManager.PROTOCOL_DNS_SD, listener)
            registration = listener
            JSONObject().put("ok", true)
        } catch (_: Throwable) {
            JSONObject().put("ok", false).put("error", "DISCOVERY_UNAVAILABLE")
        }
    }

    private fun stopAdvertising(): JSONObject {
        val manager = nsd
        val listener = registration
        registration = null
        if (manager != null && listener != null) runCatching { manager.unregisterService(listener) }
        return JSONObject().put("ok", true)
    }

    // ------------------------------------------------------------------ synchronous page channel

    /**
     * Answers one page `prompt()` synchronously. Returns false for anything that is not this
     * bridge's own message, so an ordinary page prompt still reaches the superclass unchanged.
     */
    fun handlePrompt(view: WebView, url: String, message: String, result: JsPromptResult): Boolean {
        if (!message.startsWith(PROMPT_PREFIX)) return false
        // The exact signed entry document is the whole authority, exactly like the other bridges.
        if (closed || url != entryUrl || view.url != entryUrl) {
            result.confirm("")
            return true
        }
        val payload = try {
            JSONObject(message.substring(PROMPT_PREFIX.length))
        } catch (_: Throwable) {
            result.confirm("")
            return true
        }
        val reply = when (payload.optString("op", "")) {
            "start" -> start(payload.optInt("port", 0))
            "stop" -> stop()
            "status" -> status()
            "advertise" -> advertise(payload.optString("name", ""), payload.optInt("port", 0))
            "advertiseStop" -> stopAdvertising()
            else -> JSONObject().put("ok", false).put("error", "UNSUPPORTED")
        }
        result.confirm(reply.toString())
        return true
    }

    // ------------------------------------------------------------------ asynchronous page channel

    private fun send(reply: JavaScriptReplyProxy, id: Int, payload: JSONObject) {
        runCatching { reply.postMessage(payload.put("id", id).toString()) }
    }

    private fun receive(
        view: WebView, message: WebMessageCompat, origin: Uri,
        isMainFrame: Boolean, reply: JavaScriptReplyProxy
    ) {
        val command = try {
            JSONObject(message.data ?: "")
        } catch (_: Throwable) {
            return
        }
        val id = command.optInt("id", -1)
        if (id <= 0) return
        val trusted = !closed && isMainFrame && origin.scheme == "https" &&
            origin.host == ASSET_HOST &&
            (origin.port == -1 || origin.port == 443) &&
            view.url == entryUrl
        if (!trusted) {
            send(reply, id, JSONObject().put("ok", false).put("error", "LAN_UNTRUSTED_FRAME"))
            return
        }
        when (command.optString("op", "")) {
            "browse" -> browse(command.optInt("timeoutMs", DEFAULT_BROWSE_MS)) { ok, error, hosts ->
                val payload = JSONObject()
                    .put("ok", ok)
                    .put("error", error ?: JSONObject.NULL)
                    .put("hosts", hosts)
                main.post { send(reply, id, payload) }
            }
            "party" -> outbound.execute {
                // The socket work is on this pool; the reply proxy is used on the main thread.
                val answer = partyFetch(command)
                main.post { send(reply, id, answer) }
            }
            else -> send(reply, id, JSONObject().put("ok", false).put("error", "LAN_UNSUPPORTED"))
        }
    }

    // ------------------------------------------------------------------ listener

    private fun acceptLoop(listener: ServerSocket) {
        while (accepting.get() && !closed && listener === server && !listener.isClosed) {
            val connection = try {
                listener.accept()
            } catch (_: Throwable) {
                break
            }
            if (!accepting.get()) {
                runCatching { connection.close() }
                break
            }
            if (!slots.tryAcquire()) {
                // Far more simultaneous connections than one Wi-Fi room has players: refuse the
                // extra one instead of queueing work the accept loop cannot bound.
                runCatching { connection.close() }
                continue
            }
            connections.execute {
                try {
                    serve(connection)
                } catch (_: Throwable) {
                    // A malformed or abandoned connection must never take the listener down.
                } finally {
                    runCatching { connection.close() }
                    slots.release()
                }
            }
        }
    }

    private fun serve(socket: Socket) {
        socket.soTimeout = SOCKET_TIMEOUT_MS
        val input = BufferedInputStream(socket.getInputStream(), 4096)
        val requestLine = readLine(input, MAX_REQUEST_LINE_BYTES) ?: return
        val parts = requestLine.split(' ')
        if (parts.size < 3) {
            writeJson(socket, 400, """{"error":"INVALID_REQUEST"}""", null)
            return
        }
        val method = parts[0].uppercase()
        // Origin-form (`/path?query`) is what a browser sends. Absolute-form is accepted too, so a
        // proxy-style client cannot smuggle its authority into the path this bridge parses.
        val target = absolutize(parts[1])
        val headers = LinkedHashMap<String, String>()
        var headerBytes = 0
        while (true) {
            val line = readLine(input, MAX_HEADER_LINE_BYTES) ?: break
            if (line.isEmpty()) break
            headerBytes += line.length
            if (headerBytes > MAX_HEADER_BYTES) {
                writeJson(socket, 431, """{"error":"INVALID_REQUEST"}""", null)
                return
            }
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            val name = line.substring(0, colon).trim().lowercase()
            val value = line.substring(colon + 1).trim()
            if (name.isEmpty()) continue
            val previous = headers[name]
            headers[name] = if (previous == null) value else "$previous, $value"
        }
        if (headers["transfer-encoding"]?.contains("chunked", ignoreCase = true) == true) {
            // This listener speaks Content-Length only: a chunked body is refused, never guessed.
            writeJson(socket, 400, """{"error":"INVALID_REQUEST"}""", null)
            return
        }
        val declared = headers["content-length"]?.trim()?.toIntOrNull() ?: 0
        if (declared < 0 || declared > MAX_BODY) {
            writeJson(socket, 413, """{"error":"PAYLOAD_TOO_LARGE"}""", null)
            return
        }
        val body = if (declared > 0) readBody(input, declared) else ""
        val path = target.substringBefore('?')
        // OPTIONS is a party route like any other: `src/lan/lan-room-http.js` owns the preflight
        // answer and its CORS headers, so the transport asks the page instead of inventing one.
        if (path.startsWith("/api/party/")) {
            val requestJson = JSONObject()
                .put("method", method)
                .put("path", path)
                .put("query", parseQuery(target.substringAfter('?', "")))
                .put("headers", JSONObject(headers as Map<*, *>))
                .put("body", body)
                .put("remote", socket.inetAddress?.hostAddress?.removePrefix("/") ?: "")
                .toString()
            val answer = answerFromPage(requestJson)
            writeJson(socket, answer.status, answer.body, answer.headers)
            return
        }
        if (path.startsWith("/api/")) {
            writeJson(socket, 404, """{"error":"NOT_FOUND"}""")
            return
        }
        if (method != "GET") {
            writeJson(socket, 405, """{"error":"METHOD_NOT_ALLOWED"}""")
            return
        }
        writeStatic(socket, path)
    }

    /**
     * One request/response through the page, which owns the rules. A `null`/empty answer is a 404, a
     * bare `{error}` object is a 503 with that code, and a page that has not published its handler
     * yields the same 503 - never an exception here.
     */
    private fun answerFromPage(requestJson: String): Answer {
        val raw = callPage(requestJson)
        if (raw == null || raw == UNAVAILABLE || raw == HANDLE_FAILED) {
            return Answer(503, """{"error":"SERVICE_UNAVAILABLE"}""", null)
        }
        if (raw.isEmpty()) return Answer(404, """{"error":"NOT_FOUND"}""", null)
        val parsed = try {
            JSONObject(raw)
        } catch (_: Throwable) {
            return Answer(503, """{"error":"SERVICE_UNAVAILABLE"}""", null)
        }
        if (!parsed.has("status")) {
            val code = parsed.optString("error", "").ifEmpty { "SERVICE_UNAVAILABLE" }
            return Answer(503, JSONObject().put("error", code).toString(), null)
        }
        val value = parsed.opt("body")
        val body = if (value == null || value == JSONObject.NULL) "{}" else value.toString()
        return Answer(parsed.optInt("status", 503), body, parsed.optJSONObject("headers"))
    }

    private fun callPage(requestJson: String): String? {
        if (closed) return null
        val latch = CountDownLatch(1)
        val holder = arrayOfNulls<String>(1)
        // The frozen call is window.MegaLanRoom.handle. A page that has not published it yet is
        // unavailable, not broken: the caller gets the same 503 as any other failure.
        val script = "(function(){try{var R=window.MegaLanRoom;" +
            "if(!R||typeof R.handle!=='function')return '$UNAVAILABLE';" +
            "var v=R.handle(${JSONObject.quote(requestJson)});" +
            "return (typeof v==='string')?v:String(v);}catch(e){return '$HANDLE_FAILED';}})()"
        val posted = game.post {
            try {
                game.evaluateJavascript(script) { value ->
                    holder[0] = value
                    latch.countDown()
                }
            } catch (_: Throwable) {
                latch.countDown()
            }
        }
        if (!posted) return null
        if (!latch.await(PAGE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return null
        val encoded = holder[0] ?: return null
        return try {
            (JSONTokener(encoded).nextValue() as? String)?.ifEmpty { null }
        } catch (_: Throwable) {
            null
        }
    }

    // ------------------------------------------------------------------ responses

    /**
     * The page is the authority on its own response headers: the bundled room handler composes the
     * CORS headers a browser guest needs (`src/lan/lan-room-http.js`), so dropping them here would
     * turn every answer into an opaque cross-origin failure. Only the framing headers this listener
     * owns are reserved, and every value is checked for a line break, because a response header
     * built from a page string would otherwise be a response-splitting hole.
     */
    private fun writeJson(
        socket: Socket, status: Int, body: String, extra: JSONObject? = null
    ) {
        // A 204 has no body and must not claim one.
        val bytes = if (status == 204) ByteArray(0) else body.toByteArray(Charsets.UTF_8)
        val head = StringBuilder()
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n")
        head.append("Content-Type: application/json\r\n")
        head.append("Cache-Control: no-store\r\n")
        head.append("X-Content-Type-Options: nosniff\r\n")
        head.append("Content-Length: ").append(bytes.size).append("\r\n")
        if (extra != null) {
            for (name in extra.keys()) {
                val key = name.lowercase()
                if (key in RESERVED_HEADERS || key.any { it.code !in 33..126 || it == ':' }) continue
                val value = extra.optString(name, "")
                if (value.isEmpty() || value.contains('\r') || value.contains('\n')) continue
                head.append(key).append(": ").append(value).append("\r\n")
            }
        }
        head.append("Connection: close\r\n\r\n")
        val out = socket.getOutputStream()
        out.write(head.toString().toByteArray(Charsets.UTF_8))
        if (bytes.isNotEmpty()) out.write(bytes)
        out.flush()
    }

    /**
     * The bundled client for a browser on this Wi-Fi: `/assets/mega/...` is read through the same
     * [WebViewAssetLoader] that serves the signed entry in the WebView, so a guest is served the
     * same bytes rather than a second copy of the app. A path the loader does not own is a 404.
     */
    private fun writeStatic(socket: Socket, path: String) {
        val unsafe = path.isEmpty() || path.length > MAX_PATH_BYTES ||
            path.any { it.code !in 33..126 } ||
            listOf("..", "\\", "%", "//").any { path.contains(it) }
        if (unsafe) {
            writeJson(socket, 404, """{"error":"NOT_FOUND"}""")
            return
        }
        // A guest asks for `/` or for the asset paths the WebView itself uses. Both map onto the
        // one location the loader owns, and anything else it does not own is a 404: this never
        // invents a mapping from an arbitrary request path onto a file.
        val relative = when {
            path == "/" || path == "/index.html" -> ENTRY_FILE
            path.startsWith(ASSET_PREFIX) -> path.removePrefix(ASSET_PREFIX)
            else -> path.removePrefix("/")
        }
        val response = if (relative.isEmpty()) null else try {
            assets.shouldInterceptRequest(Uri.parse("$ASSET_ORIGIN$ASSET_PREFIX$relative"))
        } catch (_: Throwable) {
            null
        }
        if (response == null) {
            writeJson(socket, 404, """{"error":"NOT_FOUND"}""")
            return
        }
        val data = try {
            response.data?.let { readAll(it, MAX_STATIC_BYTES) } ?: ByteArray(0)
        } catch (_: Throwable) {
            ByteArray(0)
        }
        val mime = response.mimeType?.takeIf { it.isNotEmpty() } ?: "application/octet-stream"
        val charset = response.encoding?.takeIf { it.isNotEmpty() }
        val head = StringBuilder()
        head.append("HTTP/1.1 ").append(response.statusCode).append(' ')
            .append(response.reasonPhrase ?: reason(response.statusCode)).append("\r\n")
        head.append("Content-Type: ").append(mime)
        if (charset != null && mime.startsWith("text/")) head.append("; charset=").append(charset)
        head.append("\r\n")
        head.append("Content-Length: ").append(data.size).append("\r\n")
        head.append("Cache-Control: no-store\r\n")
        head.append("X-Content-Type-Options: nosniff\r\n")
        head.append("Connection: close\r\n\r\n")
        val out = socket.getOutputStream()
        out.write(head.toString().toByteArray(Charsets.UTF_8))
        out.write(data)
        out.flush()
    }

    // ------------------------------------------------------------------ the page's own LAN traffic

    /**
     * Carries one `fetch` the page made to a room: same-origin `/api/party/...` while this device
     * hosts (rewritten to its own loopback listener), or the private address the page just
     * discovered. Another scheme, another path, another port or a public address is refused here, in
     * code, because the platform config cannot express the private ranges.
     */
    private fun partyFetch(command: JSONObject): JSONObject {
        val target = try {
            Uri.parse(command.optString("url", ""))
        } catch (_: Throwable) {
            null
        } ?: return JSONObject().put("ok", false).put("error", "LAN_BLOCKED")
        val path = target.path ?: return JSONObject().put("ok", false).put("error", "LAN_BLOCKED")
        if (!path.startsWith("/api/party/")) return JSONObject().put("ok", false).put("error", "LAN_BLOCKED")
        val method = command.optString("method", "GET").uppercase()
        if (method != "GET" && method != "POST") {
            return JSONObject().put("ok", false).put("error", "LAN_BLOCKED")
        }
        val body = (command.opt("body") as? String)?.takeIf { it.isNotEmpty() }
        if (body != null && body.toByteArray(Charsets.UTF_8).size > MAX_BODY) {
            return JSONObject().put("ok", false).put("error", "PAYLOAD_TOO_LARGE")
        }
        val headers = LinkedHashMap<String, String>()
        command.optJSONObject("headers")?.let { supplied ->
            for (name in supplied.keys()) {
                val key = name.lowercase()
                if (key !in FORWARDED_HEADERS) continue
                val value = supplied.optString(name, "")
                if (value.isEmpty() || value.length > MAX_HEADER_LINE_BYTES) continue
                if (value.contains('\r') || value.contains('\n')) continue
                headers[key] = value
            }
        }
        val host: String
        val port: Int
        if (target.host == ASSET_HOST) {
            val bound = boundPort
            if (server == null || bound <= 0) {
                return JSONObject().put("ok", false).put("error", "LAN_UNAVAILABLE")
            }
            host = LOOPBACK
            port = bound
        } else {
            if (target.scheme != "http") return JSONObject().put("ok", false).put("error", "LAN_BLOCKED")
            val candidate = target.port
            if (candidate !in 1024..65535) {
                return JSONObject().put("ok", false).put("error", "LAN_BLOCKED")
            }
            val name = target.host ?: return JSONObject().put("ok", false).put("error", "LAN_BLOCKED")
            if (!isPrivateLanHost(name)) return JSONObject().put("ok", false).put("error", "LAN_BLOCKED")
            host = name
            port = candidate
        }
        val query = target.query
        val fullPath = if (query.isNullOrEmpty()) path else "$path?$query"
        val upstream = try {
            // The same reader serves a discovered host AND this device's own listener, so a future
            // client that chunk-encodes its answer is decoded just the same.
            rawRequest(host, port, method, fullPath, headers, body)
        } catch (_: Throwable) {
            return JSONObject().put("ok", false).put("error", "LAN_UNAVAILABLE")
        }
        return when (upstream) {
            is Upstream.Ok ->
                JSONObject().put("ok", true).put("status", upstream.status).put("body", upstream.body)
            // A body whose framing could not be undone is not handed to the page at all: a partial
            // or size-prefixed body would surface as a confusing parse failure in the lobby, so the
            // answer is a clean 502 the page already knows how to render.
            is Upstream.Failed ->
                JSONObject().put("ok", true).put("status", 502)
                    .put("body", JSONObject().put("error", upstream.code).toString())
        }
    }

    private fun rawRequest(
        host: String, port: Int, method: String, path: String,
        headers: Map<String, String>, body: String?
    ): Upstream {
        Socket().use { socket ->
            socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
            socket.soTimeout = READ_TIMEOUT_MS
            val payload = body?.toByteArray(Charsets.UTF_8)
            val request = StringBuilder()
            request.append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
            // The room contract validates the literal `host:port` it is reached on, so the header
            // names the address this socket actually dialled - never a caller-supplied value.
            request.append("Host: ").append(host).append(':').append(port).append("\r\n")
            for ((name, value) in headers) request.append(name).append(": ").append(value).append("\r\n")
            if (method == "POST") request.append("Content-Length: ").append(payload?.size ?: 0).append("\r\n")
            request.append("Connection: close\r\n\r\n")
            val out = socket.getOutputStream()
            out.write(request.toString().toByteArray(Charsets.UTF_8))
            if (payload != null) out.write(payload)
            out.flush()
            return parseResponse(readAll(socket.getInputStream(), MAX_RESPONSE_BYTES))
        }
    }

    /**
     * One upstream response, with its body already freed of its transfer coding - or the reason it
     * could not be. A room host on this Wi-Fi is as likely to be Node's `http` server, which answers
     * a JSON body with `Transfer-Encoding: chunked`, as it is to be another phone running this same
     * listener. Handing the page the raw chunks would put a leading `"345\r\n"` in front of the JSON
     * and truncate it, so the framing is undone here, once, for every caller.
     */
    private sealed class Upstream {
        class Ok(val status: Int, val body: String) : Upstream()
        class Failed(val code: String) : Upstream()
    }

    private fun parseResponse(raw: ByteArray): Upstream {
        val split = indexOfCrlfCrlf(raw)
        if (split < 0) return Upstream.Failed("UPSTREAM_DECODE")
        // The head is ASCII; the body is bytes and must not be widened to latin-1 on the way in.
        val head = String(raw, 0, split, Charsets.ISO_8859_1)
        val body = raw.copyOfRange(split + 4, raw.size)
        val lines = head.split("\r\n")
        val status = lines.firstOrNull()?.split(' ')?.getOrNull(1)?.toIntOrNull() ?: 0
        var chunked = false
        var declared = -1
        for (line in lines.drop(1)) {
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            val name = line.substring(0, colon).trim().lowercase()
            val value = line.substring(colon + 1).trim()
            when (name) {
                // A coding list can name others before chunked; the last one is what frames the body.
                "transfer-encoding" ->
                    if (value.split(',').lastOrNull()?.trim()?.equals("chunked", ignoreCase = true) == true) {
                        chunked = true
                    }
                "content-length" -> declared = value.toIntOrNull() ?: -1
            }
        }
        return when {
            chunked -> decodeChunked(body)
                ?.let { Upstream.Ok(status, String(it, Charsets.UTF_8)) }
                ?: Upstream.Failed("UPSTREAM_DECODE")
            // Transfer-Encoding outranks Content-Length when both are present.
            declared >= 0 ->
                if (body.size < declared) Upstream.Failed("UPSTREAM_DECODE")
                else Upstream.Ok(status, String(body, 0, declared, Charsets.UTF_8))
            // No framing at all: `Connection: close` is the delimiter, and readAll read to the end.
            else -> Upstream.Ok(status, String(body, Charsets.UTF_8))
        }
    }

    /**
     * Undoes `Transfer-Encoding: chunked`. Returns null for anything malformed - a size that is not
     * hex, a chunk running past the bytes that arrived, a missing CRLF, or a decoded body over the
     * response cap - so the caller can answer an honest failure instead of a body the page will
     * choke on. Chunk extensions (`;name=value`) carry no body bytes and are ignored.
     */
    private fun decodeChunked(body: ByteArray): ByteArray? {
        val out = ByteArrayOutputStream()
        var offset = 0
        while (true) {
            val lineEnd = indexOfCrlf(body, offset) ?: return null
            val header = String(body, offset, lineEnd - offset, Charsets.ISO_8859_1)
            val size = header.substringBefore(';').trim().toIntOrNull(16) ?: return null
            if (size < 0) return null
            offset = lineEnd + 2
            if (size == 0) return out.toByteArray()
            if (offset + size > body.size) return null
            if (out.size() + size > MAX_RESPONSE_BYTES) return null
            out.write(body, offset, size)
            offset += size
            // Each chunk's data is followed by its own CRLF.
            if (offset + 2 > body.size || body[offset] != CR || body[offset + 1] != LF) return null
            offset += 2
        }
    }

    private fun indexOfCrlfCrlf(raw: ByteArray): Int {
        for (index in 0..raw.size - 4) {
            if (raw[index] == CR && raw[index + 1] == LF &&
                raw[index + 2] == CR && raw[index + 3] == LF) return index
        }
        return -1
    }

    private fun indexOfCrlf(raw: ByteArray, from: Int): Int? {
        for (index in from..raw.size - 2) {
            if (raw[index] == CR && raw[index + 1] == LF) return index
        }
        return null
    }

    // ------------------------------------------------------------------ discovery

    /**
     * Same-Wi-Fi discovery. Advertising and browsing both go through NSD; a host that answers NSD
     * but not HTTP is skipped rather than reported as an empty room list. When NSD is unavailable
     * the caller is told honestly (`ok = false` plus the code) instead of receiving an empty list
     * that would look like "nobody is hosting".
     */
    private fun browse(timeoutMs: Int, complete: (Boolean, String?, JSONArray) -> Unit) {
        val manager = nsd
        if (manager == null || closed) {
            complete(false, "DISCOVERY_UNAVAILABLE", JSONArray())
            return
        }
        if (!browsing.compareAndSet(false, true)) {
            complete(false, "DISCOVERY_BUSY", JSONArray())
            return
        }
        val results = ConcurrentHashMap<String, JSONObject>()
        val settled = AtomicBoolean(false)

        fun finish() {
            if (!settled.compareAndSet(false, true)) return
            val listener = discovery
            discovery = null
            synchronized(pending) { pending.clear() }
            if (listener != null) runCatching { manager.stopServiceDiscovery(listener) }
            browsing.set(false)
            // A resolve that was in flight when the browse ended will never call back through a
            // stopped discovery listener, so its slot must be released here or every later browse
            // would begin permanently busy.
            resolving.set(false)
            complete(true, null, JSONArray(results.values.toList()))
        }

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = finish()
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = finish()
            override fun onDiscoveryStopped(serviceType: String) = finish()
            override fun onServiceLost(info: NsdServiceInfo) = Unit
            override fun onServiceFound(info: NsdServiceInfo) {
                if (settled.get()) return
                synchronized(pending) { pending.addLast(info) }
                main.post { resolveNext(results) }
            }
        }
        discovery = listener
        try {
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (_: Throwable) {
            finish()
            return
        }
        // The caller's timeout is the browse budget, bounded so a wedged radio cannot hang a lobby.
        main.postDelayed({ finish() }, timeoutMs.coerceIn(300, 8000).toLong())
    }

    // resolveService(NsdServiceInfo, ResolveListener) is the API-28-compatible overload; the
    // registerService/discoverServices/resolveService callback family is deprecated only in favour
    // of newer overloads this minSdk cannot use yet.
    @Suppress("DEPRECATION")
    private fun resolveNext(results: ConcurrentHashMap<String, JSONObject>) {
        val manager = nsd ?: return
        if (closed || discovery == null) return
        // NsdManager accepts one resolveService call at a time; a second in flight fails, and that
        // failure must not drop the queued hosts, so the next one starts only when this one lands.
        if (!resolving.compareAndSet(false, true)) return
        val next = synchronized(pending) {
            if (pending.isEmpty()) null else pending.removeFirst()
        }
        if (next == null) {
            resolving.set(false)
            return
        }
        fun done() {
            resolving.set(false)
            // Only keep draining while this browse is still the live one.
            if (discovery != null) main.post { resolveNext(results) }
        }
        val started = try {
            manager.resolveService(next, object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = done()

                override fun onServiceResolved(info: NsdServiceInfo) {
                    val port = info.port
                    val literal = lanAddress(info)?.hostAddress
                    if (literal == null || port !in 1024..65535) {
                        done()
                        return
                    }
                    val name = info.serviceName?.trim().orEmpty().ifEmpty { "Mega XOXO host" }
                    outbound.execute {
                        try {
                            val response = rawRequest(literal, port, "GET", DISCOVER_PATH, emptyMap(), null)
                            val answer = response as? Upstream.Ok ?: throw IllegalStateException("UPSTREAM")
                            val rooms = JSONObject(answer.body).optJSONArray("rooms") ?: JSONArray()
                            results["$literal:$port"] = JSONObject()
                                .put("name", name)
                                .put("origin", "http://$literal:$port")
                                .put("rooms", rooms)
                        } catch (_: Throwable) {
                            // A host that answered NSD but not HTTP - or answered with framing this
                            // cannot undo - is not a room host: skip it rather than guess.
                        }
                        done()
                    }
                }
            })
            true
        } catch (_: Throwable) {
            false
        }
        if (!started) done()
    }

    @Suppress("DEPRECATION")
    private fun lanAddress(info: NsdServiceInfo): Inet4Address? {
        val addresses = try {
            if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(info.host)
        } catch (_: Throwable) {
            emptyList()
        }
        // A LAN room lives on a private or link-local IPv4 address; anything else is not this Wi-Fi
        // and would fail the room contract's own Host check anyway.
        return addresses.filterIsInstance<Inet4Address>().firstOrNull { isPrivateLan(it) }
    }

    private fun isPrivateLan(address: InetAddress): Boolean =
        address.isLoopbackAddress || address.isSiteLocalAddress || address.isLinkLocalAddress

    // ------------------------------------------------------------------ teardown

    fun close() {
        if (closed) return
        closed = true
        stopListening()
        stopAdvertising()
        val manager = nsd
        val listener = discovery
        discovery = null
        if (manager != null && listener != null) runCatching { manager.stopServiceDiscovery(listener) }
        browsing.set(false)
        runCatching { connections.shutdownNow() }
        runCatching { outbound.shutdownNow() }
    }

    // ------------------------------------------------------------------ parsing helpers

    /** Reduces an absolute-form request target to its path and query, leaving origin-form alone. */
    private fun absolutize(target: String): String {
        val scheme = target.indexOf("://")
        if (scheme < 0) return target
        val path = target.indexOf('/', scheme + 3)
        return if (path < 0) "/" else target.substring(path)
    }

    private fun parseQuery(raw: String): JSONObject {
        val query = JSONObject()
        if (raw.isEmpty()) return query
        for (pair in raw.split('&')) {
            if (pair.isEmpty()) continue
            val index = pair.indexOf('=')
            val name = if (index < 0) pair else pair.substring(0, index)
            if (name.isEmpty()) continue
            val value = if (index < 0) "" else pair.substring(index + 1)
            query.put(decode(name), decode(value))
        }
        return query
    }

    private fun decode(value: String): String = try {
        URLDecoder.decode(value, "UTF-8")
    } catch (_: Throwable) {
        value
    }

    private fun readLine(input: InputStream, cap: Int): String? {
        val out = ByteArrayOutputStream()
        while (out.size() <= cap) {
            val next = try {
                input.read()
            } catch (_: Throwable) {
                return null
            }
            if (next < 0) return if (out.size() == 0) null else String(out.toByteArray(), Charsets.UTF_8)
            if (next == '\n'.code) {
                val bytes = out.toByteArray()
                val end = if (bytes.isNotEmpty() && bytes.last() == '\r'.code.toByte()) bytes.size - 1 else bytes.size
                return String(bytes, 0, end, Charsets.UTF_8)
            }
            out.write(next)
        }
        return null
    }

    /** Reads exactly [length] body bytes; a short read is a malformed request, not a guess. */
    private fun readBody(input: InputStream, length: Int): String {
        val bytes = ByteArray(length)
        var offset = 0
        while (offset < length) {
            val read = input.read(bytes, offset, length - offset)
            if (read <= 0) break
            offset += read
        }
        return String(bytes, 0, offset, Charsets.UTF_8)
    }

    private fun readAll(input: InputStream, cap: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        try {
            while (out.size() < cap) {
                val read = input.read(buffer, 0, minOf(buffer.size, cap - out.size()))
                if (read <= 0) break
                out.write(buffer, 0, read)
            }
        } finally {
            runCatching { input.close() }
        }
        return out.toByteArray()
    }

    private fun reason(status: Int): String = when (status) {
        200 -> "OK"
        204 -> "No Content"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        409 -> "Conflict"
        413 -> "Payload Too Large"
        429 -> "Too Many Requests"
        431 -> "Request Header Fields Too Large"
        500 -> "Internal Server Error"
        503 -> "Service Unavailable"
        else -> "Status"
    }

    companion object {
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val ASSET_ORIGIN = "https://$ASSET_HOST"
        private const val ASSET_PREFIX = "/assets/mega/"
        private const val ENTRY_FILE = "bundle-index.html"
        private const val LOOPBACK = "127.0.0.1"
        private const val CHANNEL = "megaLanBridgeChannel"
        private const val PROMPT_PREFIX = "megaLanBridge"
        private const val SERVICE_TYPE = "_megaxo-v5._tcp"
        private const val DISCOVER_PATH = "/api/party/discover"
        private const val UNAVAILABLE = "UNAVAILABLE"
        private const val HANDLE_FAILED = "HANDLE_FAILED"
        private const val DEFAULT_BROWSE_MS = 2500
        private const val PAGE_TIMEOUT_MS = 2000L
        private const val SOCKET_TIMEOUT_MS = 4000
        private const val CONNECT_TIMEOUT_MS = 1500
        private const val READ_TIMEOUT_MS = 2500
        private const val MAX_BODY = 16384
        private const val MAX_HEADER_BYTES = 8192
        private const val MAX_HEADER_LINE_BYTES = 1024
        private const val MAX_REQUEST_LINE_BYTES = 2048
        private const val MAX_PATH_BYTES = 1024
        private const val MAX_RESPONSE_BYTES = 65536
        private const val CR: Byte = 13
        private const val LF: Byte = 10
        private const val MAX_STATIC_BYTES = 8 * 1024 * 1024
        private const val BACKLOG = 16

        /**
         * The headers a LAN guest legitimately presents. The bearer is what the page already
         * attached to its own fetch; nothing here names, invents or reads a credential.
         */
        private val FORWARDED_HEADERS =
            setOf("authorization", "content-type", "idempotency-key", "accept")

        /** Headers this listener always writes itself, so a page cannot replace them. */
        private val RESERVED_HEADERS = setOf(
            "content-type", "content-length", "cache-control", "x-content-type-options",
            "connection", "transfer-encoding", "host"
        )

        /**
         * The literal private / link-local / loopback IPv4 hosts a Wi-Fi guest could be pointing
         * at. A host name is never private: resolving a name here would make "private" a property
         * of DNS rather than of the address, which is exactly the check this needs to stay.
         */
        fun isPrivateLanHost(host: String?): Boolean {
            if (host == null) return false
            val parts = host.split('.')
            if (parts.size != 4) return false
            val values = parts.map { it.toIntOrNull() ?: return false }
            if (values.any { it !in 0..255 }) return false
            return when (values[0]) {
                10, 127 -> true
                172 -> values[1] in 16..31
                192 -> values[1] == 168
                169 -> values[1] == 254
                else -> false
            }
        }

        /**
         * Publishes the frozen primitives and the page's LAN transport, restricted to the
         * app-assets origin exactly like the theme, notification, identity and API bridges.
         */
        private val bootstrap = """
            (() => {
              if (window.top !== window || window.MegaLanSocket || window.MegaLanDiscovery) return;
              const channel = window.megaLanBridgeChannel;
              if (!channel || typeof channel.postMessage !== 'function') return;
              const PROMPT = 'megaLanBridge';
              const invoke = payload => {
                let reply;
                try { reply = window.prompt(PROMPT + JSON.stringify(payload)); }
                catch (_) { return null; }
                if (typeof reply !== 'string' || reply.length === 0) return null;
                try { return JSON.parse(reply); } catch (_) { return null; }
              };
              Object.defineProperty(window, 'MegaLanSocket', {
                configurable: false, enumerable: false,
                value: Object.freeze({
                  start: port => invoke({op: 'start', port: Number(port)}) ||
                    {ok: false, error: 'START_FAILED'},
                  stop: () => invoke({op: 'stop'}) || {ok: false, error: 'START_FAILED'},
                  status: () => invoke({op: 'status'}) ||
                    {listening: false, port: null, origin: null}
                })
              });
              const outstanding = new Map();
              let next = 0;
              channel.onmessage = event => {
                try {
                  const result = JSON.parse(event.data);
                  const callbacks = outstanding.get(result.id);
                  if (!callbacks) return;
                  outstanding.delete(result.id);
                  callbacks.resolve(result);
                } catch (_) {}
              };
              const call = (op, fields) => new Promise((resolve, reject) => {
                const id = ++next;
                outstanding.set(id, {resolve: resolve, reject: reject});
                try { channel.postMessage(JSON.stringify(Object.assign({id: id, op: op}, fields))); }
                catch (_) { outstanding.delete(id); reject(new Error('LAN_UNAVAILABLE')); }
              });
              Object.defineProperty(window, 'MegaLanDiscovery', {
                configurable: false, enumerable: false,
                value: Object.freeze({
                  advertise: (name, port) => invoke({
                    op: 'advertise',
                    name: String(name === undefined ? '' : name),
                    port: Number(port)
                  }) || {ok: false, error: 'DISCOVERY_UNAVAILABLE'},
                  stop: () => invoke({op: 'advertiseStop'}) ||
                    {ok: false, error: 'DISCOVERY_UNAVAILABLE'},
                  browse: timeoutMs => call('browse', {timeoutMs: Number(timeoutMs)})
                    .then(result => {
                      if (!result || result.ok !== true) {
                        // src/lan/lan-host.js turns this into {ok:false, error, hosts:[]}: the lobby
                        // is told discovery is unavailable rather than shown a false empty Wi-Fi.
                        throw new Error((result && result.error) || 'DISCOVERY_FAILED');
                      }
                      return (result.hosts) || [];
                    })
                })
              });
              // The page's room calls travel on the host's own socket. An https document may not
              // fetch http while mixed content is refused, and the platform cannot permit the
              // private ranges (see res/xml/network_security_config.xml), so the destination rule
              // lives here in code: the same origin, or a private literal on a party route.
              const nativeFetch = window.fetch;
              if (typeof nativeFetch !== 'function') return;
              const ASSET_ORIGIN = 'https://appassets.androidplatform.net';
              if (location.origin !== ASSET_ORIGIN) return;
              const isPrivate = host => {
                const parts = String(host).split('.');
                if (parts.length !== 4) return false;
                const values = parts.map(Number);
                if (values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
                if (values[0] === 10 || values[0] === 127) return true;
                if (values[0] === 172 && values[1] >= 16 && values[1] <= 31) return true;
                if (values[0] === 192 && values[1] === 168) return true;
                return values[0] === 169 && values[1] === 254;
              };
              const route = (input, init) => {
                const request = (typeof Request === 'function' && input instanceof Request) ? input : null;
                let target;
                try { target = new URL(request ? request.url : String(input), location.href); }
                catch (_) { return null; }
                if (!target.pathname.startsWith('/api/party/')) return null;
                const local = target.origin === location.origin;
                if (!local && !(target.protocol === 'http:' && isPrivate(target.hostname))) return null;
                const method = String((init && init.method) || (request && request.method) || 'GET').toUpperCase();
                if (method !== 'GET' && method !== 'POST') return null;
                const headers = {};
                const source = (init && init.headers) || (request && request.headers) || null;
                if (source && typeof source.forEach === 'function') {
                  source.forEach((value, name) => { headers[String(name).toLowerCase()] = String(value); });
                } else if (source) {
                  Object.keys(source).forEach(name => { headers[String(name).toLowerCase()] = String(source[name]); });
                }
                const body = (init && typeof init.body === 'string') ? init.body : null;
                const signal = (init && init.signal) || (request && request.signal) || null;
                return call('party', {url: target.href, method: method, headers: headers, body: body})
                  .then(result => {
                    if (!result || result.ok !== true) {
                      throw new Error((result && result.error) || 'LAN_UNAVAILABLE');
                    }
                    return new Response(typeof result.body === 'string' ? result.body : '', {
                      status: Number(result.status) || 200,
                      headers: {'Content-Type': 'application/json'}
                    });
                  });
              };
              window.fetch = function (input, init) {
                const signal = (init && init.signal) || null;
                if (typeof AbortSignal === 'function' && signal && signal.aborted) {
                  return Promise.reject(new DOMException('Aborted', 'AbortError'));
                }
                const routed = route(input, init);
                if (!routed) return nativeFetch.call(this, input, init);
                // The lobby aborts a slow call after 6 s; the host socket has its own timeout, so
                // the two have to race rather than one silently winning.
                return signal
                  ? Promise.race([routed, new Promise((_, reject) => {
                      signal.addEventListener('abort', () => {
                        reject(new DOMException('Aborted', 'AbortError'));
                      }, {once: true});
                    })])
                  : routed;
              };
            })();
        """.trimIndent()

        fun install(
            context: Context, game: WebView, entryUrl: String, assets: WebViewAssetLoader
        ): MegaAndroidLanBridge? {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
                !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            ) return null
            val service = MegaAndroidLanBridge(context, game, entryUrl, assets)
            val origins = setOf(ASSET_ORIGIN)
            WebViewCompat.addWebMessageListener(
                game, CHANNEL, origins,
                WebViewCompat.WebMessageListener { view, message, origin, isMainFrame, reply ->
                    service.receive(view, message, origin, isMainFrame, reply)
                })
            WebViewCompat.addDocumentStartJavaScript(game, bootstrap, origins)
            return service
        }
    }
}
