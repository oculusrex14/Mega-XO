import Darwin
import Foundation
import Network
import WebKit

/// V5.1 same-Wi-Fi room transport for the signed game — the iOS parity of `MegaAndroidLanBridge`.
///
/// The approved tournament rules, the guest-session contract and the HTTP contract all live in
/// `src/lan/` and ship inside this bundle. This bridge owns ONLY the two things JavaScript cannot
/// have — a real TCP listener and a Bonjour record — and publishes exactly the frozen primitives
/// those modules read at call time:
///
///   window.MegaLanSocket.start(port)  -> {ok:true, port} | {ok:false, error}
///   window.MegaLanSocket.stop()       -> {ok:true}
///   window.MegaLanSocket.status()     -> {listening, port, origin}
///   window.MegaLanDiscovery.advertise(name, port) -> {ok:true} | {ok:false, error}
///   window.MegaLanDiscovery.stop()                -> {ok:true}
///   window.MegaLanDiscovery.browse(timeoutMs)     -> Promise<[{name, origin, rooms}]>
///
/// `start`, `stop`, `status` and `advertise` are SYNCHRONOUS in the frozen contract:
/// `src/lan/lan-host.js` reads `started.ok` and `status().listening` directly without awaiting
/// anything, so an asynchronous message channel cannot serve them. They are answered through the one
/// synchronous page-to-host channel a WebView has — `WKUIDelegate`'s JavaScript text-input panel,
/// which is what `window.prompt()` becomes, exactly as the Android host answers through
/// `WebChromeClient.onJsPrompt`. Every prompt is gated to the exact signed entry document and the
/// bridge's own prefix; anything else is handed straight back as the `nil` the approved client
/// already receives. `browse` is a Promise by contract and therefore uses the asynchronous reply
/// channel (`WKScriptMessageHandlerWithReply`) exactly like the notification and API bridges.
///
/// For every accepted connection the raw bytes are parsed here — request line, headers capped at
/// 8 KiB, a `Content-Length` body capped at 16 KiB, chunked *requests* refused — and handed to the
/// page as one JSON string, which it answers by calling `window.MegaLanRoom.handle(<requestJson>)`.
/// That call runs on the main thread with a 2 s ceiling after which the client receives
/// `503 SERVICE_UNAVAILABLE`. A page that has not published its handler yet gets that same 503:
/// nothing here ever throws across the bridge.
///
/// The listener speaks the party API and nothing else. On Android the same bridge also relays
/// `/assets/mega/...` through the WebView asset loader; iOS has no such loader for its `file://`
/// bundle, and inventing a second file-serving path would widen the exact surface the native guard
/// tests pin ("iOS restricts the loaded signed file bundle"). A guest runs this same app, so a
/// non-party path is an honest `404 NOT_FOUND` here.
///
/// Transport is `Network.framework` (`NWListener` + `NWConnection`) and Bonjour (`NWBrowser` +
/// `NWListener.service`) only: no package-manager entry, no third-party dependency. Because the
/// whole path is raw TCP rather than `URLSession`, App Transport Security never sees it — see the
/// Info.plist note about `NSAllowsArbitraryLoads` / `NSAllowsLocalNetworking`.
///
/// No bearer token, request body or actor id is ever logged, echoed into an error or stored.
final class MegaNativeLanBridge: NSObject, WKScriptMessageHandlerWithReply {

    /// The WebView whose page owns every room rule. Set by the controller once the WebView exists.
    weak var host: WKWebView?

    private let trustedEntry: URL
    private let queue = DispatchQueue(label: "online.megaxo.lan.listener")
    private let connections = DispatchQueue(label: "online.megaxo.lan.connections", attributes: .concurrent)
    private let slots = DispatchSemaphore(value: MegaNativeLanBridge.maxConnections)
    private let lock = NSLock()

    private var listener: NWListener?
    private var serviceWanted: NWListener.Service?
    private var boundPort = 0
    private var browseSession: LanBrowseSession?
    private var live: [ObjectIdentifier: LanExchange] = [:]
    private var closed = false

    /// `closed` is written from `close()` on any thread and read from the main thread, the listener
    /// queue and the connection pool, so every read goes through the same lock as the write.
    private var isClosed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return closed
    }

    init(entry: URL) {
        trustedEntry = entry.standardizedFileURL.resolvingSymlinksInPath()
        super.init()
    }

    deinit { close() }

    // MARK: - the published surface

    /// Publishes the frozen primitives, restricted to the signed entry document exactly like the
    /// theme, notification, identity and API bridges. The synchronous half rides `window.prompt`;
    /// `browse` is a Promise and rides the reply channel.
    static let bootstrap = #"""
    (() => {
      if (window.top !== window || window.MegaLanSocket || window.MegaLanDiscovery) return;
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
      const channel = window.webkit?.messageHandlers?.megaLanDiscovery;
      const call = (op, fields) => {
        if (!channel || typeof channel.postMessage !== 'function') {
          return Promise.reject(new Error('LAN_UNAVAILABLE'));
        }
        return channel.postMessage(Object.assign({op: op}, fields));
      };
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
                // src/lan/lan-host.js turns this into {ok:false, error, hosts:[]}: the lobby is
                // told discovery is unavailable rather than shown a false empty Wi-Fi.
                throw new Error((result && result.error) || 'DISCOVERY_FAILED');
              }
              return (result.hosts) || [];
            })
        })
      });
      // The page's room calls travel on the host's own socket, exactly as they do on Android. The
      // signed page is a file:// document whose own http(s) subresources the WebView blocks by
      // design, so the destination rule lives here in code instead: this device's own listener for
      // a same-document call, or a private / link-local / loopback literal on a party route.
      const nativeFetch = window.fetch;
      if (typeof nativeFetch !== 'function') return;
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
        const local = target.protocol === 'file:' || target.origin === location.origin;
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
        // The lobby aborts a slow call after 6 s; the host socket has its own timeout, so the two
        // have to race rather than one silently winning.
        return signal
          ? Promise.race([routed, new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
              }, {once: true});
            })])
          : routed;
      };
    })();
    """#

    /// Answers one page `prompt()` synchronously. Returns `nil` for anything that is not this
    /// bridge's own message, so an ordinary page prompt keeps the previous `nil` behaviour.
    func handlePrompt(_ message: String, frame: WKFrameInfo) -> String? {
        guard message.hasPrefix(Self.promptPrefix) else { return nil }
        // The exact signed entry document, main frame only, is the whole authority — exactly like
        // the other bridges. An untrusted caller gets the same empty answer as an untrusted prompt.
        guard !isClosed, frame.isMainFrame,
              let page = frame.request.url, page.isFileURL,
              page.standardizedFileURL.resolvingSymlinksInPath() == trustedEntry,
              let payload = Self.decode(message.dropFirst(Self.promptPrefix.count)) else {
            return ""
        }
        let reply: [String: Any]
        switch payload["op"] as? String ?? "" {
        case "start": reply = start(Self.integer(payload["port"]))
        case "stop": reply = stop()
        case "status": reply = status()
        case "advertise": reply = advertise(payload["name"] as? String ?? "", port: Self.integer(payload["port"]))
        case "advertiseStop": reply = stopAdvertising()
        default: reply = ["ok": false, "error": "UNSUPPORTED"]
        }
        return Self.json(reply) ?? ""
    }

    /// The two asynchronous primitives: `MegaLanDiscovery.browse(timeoutMs)` and the page's own
    /// `/api/party/*` traffic, which the WebView's blanket `https?` rule would otherwise block.
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let reply: ([String: Any]) -> Void = { payload in
            DispatchQueue.main.async { replyHandler(payload, nil) }
        }
        guard message.name == Self.channelName,
              message.frameInfo.isMainFrame,
              Self.trusted(message.frameInfo.request.url, entry: trustedEntry),
              let body = message.body as? [String: Any] else {
            reply(["ok": false, "error": "LAN_UNTRUSTED_FRAME", "hosts": []])
            return
        }
        switch body["op"] as? String ?? "" {
        case "browse":
            let timeout = body["timeoutMs"] as? NSNumber
            browse(timeoutMs: timeout?.intValue ?? Self.defaultBrowseMs, complete: reply)
        case "party":
            connections.async { [weak self] in
                guard let self else { return }
                reply(self.partyFetch(body))
            }
        default:
            reply(["ok": false, "error": "LAN_UNSUPPORTED"])
        }
    }

    // MARK: - frozen primitives

    /// Binds the requested port on every interface, or one of the two next ports when it is taken,
    /// and reports the port that actually bound.
    private func start(_ requested: Int) -> [String: Any] {
        if isClosed { return ["ok": false, "error": "START_FAILED"] }
        guard (1024...65535).contains(requested) else { return ["ok": false, "error": "BIND_FAILED"] }
        if let live = listener, live.state == .ready, boundPort == requested {
            return ["ok": true, "port": boundPort]
        }
        stopListening()
        guard let bound = bind(requested) else {
            stopListening()
            return ["ok": false, "error": "BIND_FAILED"]
        }
        listener = bound.listener
        boundPort = bound.port
        return ["ok": true, "port": boundPort]
    }

    /// `stop()` ends the listener only, exactly like the Android host: the Bonjour record is owned
    /// by `MegaLanDiscovery.stop()`.
    private func stop() -> [String: Any] {
        stopListening()
        return ["ok": true]
    }

    private func status() -> [String: Any] {
        let running = listener?.state == .ready && boundPort > 0
        return [
            "listening": running,
            "port": running ? boundPort : NSNull(),
            "origin": (running ? lanOrigin() : nil) ?? NSNull()
        ]
    }

    /// Binds with `NWListener` and waits, bounded, for the listener to report itself ready, so the
    /// page can be told synchronously whether the port is really ours. A port already in use
    /// arrives as `failed` or `waiting`; both mean "not this port", so the next candidate is tried.
    private func bind(_ requested: Int) -> (listener: NWListener, port: Int)? {
        for candidate in requested...(requested + 2) {
            guard (1024...65535).contains(candidate),
                  let port = NWEndpoint.Port(rawValue: UInt16(candidate)),
                  let candidateListener = try? NWListener(using: Self.tcpParameters(), on: port) else { continue }
            let settled = LanFlag()
            let ready = DispatchSemaphore(value: 0)
            candidateListener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if settled.claim(true) { ready.signal() }
                case .failed, .cancelled, .waiting:
                    if settled.claim(false) { ready.signal() }
                default:
                    break
                }
            }
            candidateListener.service = serviceWanted
            candidateListener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            candidateListener.start(queue: queue)
            let outcome = ready.wait(timeout: .now() + Self.bindTimeout)
            if outcome == .success, settled.value == true {
                candidateListener.stateUpdateHandler = nil
                return (candidateListener, candidate)
            }
            candidateListener.stateUpdateHandler = nil
            candidateListener.newConnectionHandler = nil
            candidateListener.cancel()
        }
        return nil
    }

    /// Ends the listener AND every connection it accepted: `stop()` is a full stop in the frozen
    /// contract, not a "no new guests" flag, so an in-flight request is cancelled with its slot.
    private func stopListening() {
        let open = listener
        listener = nil
        boundPort = 0
        open?.stateUpdateHandler = nil
        open?.newConnectionHandler = nil
        open?.cancel()
        lock.lock()
        let outstanding = Array(live.values)
        lock.unlock()
        for exchange in outstanding { release(exchange) }
    }

    /// This device's LAN address and real port: what a friend sitting beside it can type.
    private func lanOrigin() -> String? {
        let port = boundPort
        guard port > 0 else { return nil }
        var fallback: String?
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return nil }
        defer { freeifaddrs(head) }
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }
            guard let address = entry.pointee.ifa_addr,
                  address.pointee.sa_family == UInt8(AF_INET) else { continue }
            let flags = entry.pointee.ifa_flags
            // A private address is what a peer on the same Wi-Fi can route to; a carrier, USB or
            // loopback address is not a lobby URL.
            guard flags & UInt32(IFF_UP) != 0, flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            let sin = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in.self).pointee
            let value = UInt32(bigEndian: sin.sin_addr.s_addr)
            let text = "\((value >> 24) & 0xFF).\((value >> 16) & 0xFF).\((value >> 8) & 0xFF).\(value & 0xFF)"
            if Self.isPrivateLanIPv4(text) { return "http://\(text):\(port)" }
            if fallback == nil { fallback = "http://\(text):\(port)" }
        }
        return fallback
    }

    /// Advertising. The service is installed on the listener, so a Bonjour name that is taken is
    /// renamed by mDNS itself rather than failing the room.
    private func advertise(_ name: String, port: Int) -> [String: Any] {
        guard (1024...65535).contains(port) else { return ["ok": false, "error": "DISCOVERY_UNAVAILABLE"] }
        _ = stopAdvertising()
        let trimmed = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(48))
        let service = NWListener.Service(name: trimmed.isEmpty ? "Mega XOXO host" : trimmed,
                                         type: Self.serviceType)
        serviceWanted = service
        // Publishing is a promise about the listener, not about the port the caller named: the
        // listener advertises the port it actually holds, and the record outlives a restart.
        listener?.service = service
        return ["ok": true]
    }

    private func stopAdvertising() -> [String: Any] {
        serviceWanted = nil
        listener?.service = nil
        return ["ok": true]
    }

    // MARK: - listener

    private func accept(_ connection: NWConnection) {
        if isClosed {
            connection.cancel()
            return
        }
        if slots.wait(timeout: .now()) == .timedOut {
            // Far more simultaneous connections than one Wi-Fi room has players: refuse the extra
            // one instead of queueing work the accept path cannot bound.
            connection.cancel()
            return
        }
        let exchange = LanExchange(connection: connection)
        track(exchange)
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled, .waiting:
                self?.release(exchange)
            default:
                break
            }
        }
        connection.start(queue: connections)
        read(exchange)
        let watchdog = DispatchWorkItem { [weak self] in self?.release(exchange) }
        exchange.watchdog = watchdog
        queue.asyncAfter(deadline: .now() + Self.socketTimeout, execute: watchdog)
    }

    private func read(_ exchange: LanExchange) {
        exchange.connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] chunk, _, isComplete, error in
            guard let self, !exchange.done.isSettled else { return }
            if let chunk, !chunk.isEmpty { exchange.buffer.append(chunk) }
            if error != nil {
                self.release(exchange)
                return
            }
            if isComplete { exchange.complete = true }
            self.consume(exchange)
        }
    }

    /// Parses what has arrived so far. A request that is not yet complete asks for more bytes; a
    /// request that can never be valid is answered with its honest code and nothing else.
    private func consume(_ exchange: LanExchange) {
        let buffer = exchange.buffer
        guard let headEnd = Self.indexOfCRLFCRLF(buffer) else {
            if buffer.count > Self.maxHead { respond(exchange, status: 431, body: Self.badRequest); return }
            if exchange.complete { release(exchange); return }
            read(exchange)
            return
        }
        let head = String(decoding: buffer.prefix(headEnd), as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst()
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 3 else { respond(exchange, status: 400, body: Self.badRequest); return }
        let method = parts[0].uppercased()
        // Origin-form (`/path?query`) is what a browser sends. Absolute-form is accepted too, so a
        // proxy-style client cannot smuggle its authority into the path this bridge parses.
        let target = Self.absolutize(String(parts[1]))
        var headers: [String: String] = [:]
        var headerBytes = 0
        for line in lines {
            if line.isEmpty { break }
            headerBytes += line.utf8.count
            if headerBytes > Self.maxHead { respond(exchange, status: 431, body: Self.badRequest); return }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { continue }
            headers[name] = headers[name].map { "\($0), \(value)" } ?? value
        }
        if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
            // This listener speaks Content-Length only: a chunked body is refused, never guessed.
            respond(exchange, status: 400, body: Self.badRequest)
            return
        }
        let declared = Int(headers["content-length"] ?? "") ?? 0
        if declared < 0 || declared > Self.maxBody {
            respond(exchange, status: 413, body: #"{"error":"PAYLOAD_TOO_LARGE"}"#)
            return
        }
        let bodyStart = headEnd + 4
        guard buffer.count - bodyStart >= declared else {
            if exchange.complete { respond(exchange, status: 400, body: Self.badRequest) }
            else { read(exchange) }
            return
        }
        let body = String(decoding: buffer[bodyStart..<(bodyStart + declared)], as: UTF8.self)
        let path = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
        guard path.hasPrefix("/api/party/") else {
            // `/api/*` is not this host's, and this host serves no other path: a guest runs the
            // same app rather than a browser copy of the signed bundle.
            respond(exchange, status: 404, body: #"{"error":"NOT_FOUND"}"#)
            return
        }
        let request: [String: Any] = [
            "method": method,
            "path": String(path),
            "query": Self.parseQuery(target),
            "headers": headers,
            "body": body,
            "remote": exchange.remote
        ]
        guard let requestJson = Self.json(request) else {
            respond(exchange, status: 503, body: Self.unavailable)
            return
        }
        let answer = answerFromPage(requestJson)
        respond(exchange, status: answer.status, body: answer.body, extra: answer.headers)
    }

    /// One request/response through the page, which owns the rules. A `null`/empty answer is a 404,
    /// a bare `{error}` object is a 503 with that code, and a page that has not published its
    /// handler yields the same 503 — never an exception here.
    private func answerFromPage(_ requestJson: String) -> LanAnswer {
        // Only a connection worker calls this: it hop-and-waits on the main thread, and doing that
        // from the main thread itself would deadlock.
        guard let host, !isClosed,
              let data = try? JSONSerialization.data(withJSONObject: [requestJson]), data.count > 2 else {
            return LanAnswer(status: 503, body: Self.unavailable, headers: nil)
        }
        let literal = String(decoding: data.dropFirst().dropLast(), as: UTF8.self)
        // The frozen call is window.MegaLanRoom.handle. A page that has not published it yet is
        // unavailable, not broken: the caller gets the same 503 as any other failure. A `null` or
        // `undefined` answer is normalized to the empty string, which is the contract's 404.
        let script = "(function(){try{var R=window.MegaLanRoom;" +
            "if(!R||typeof R.handle!=='function')return 'UNAVAILABLE';" +
            "var v=R.handle(\(literal));" +
            "if(v===null||v===undefined)return '';" +
            "return (typeof v==='string')?v:String(v);}catch(e){return 'HANDLE_FAILED';}})()"
        let settled = DispatchSemaphore(value: 0)
        let box = LanBox<String?>(nil)
        let failure = LanFlag()
        DispatchQueue.main.async {
            host.evaluateJavaScript(script) { value, error in
                if error != nil { _ = failure.claim() }
                box.value = value as? String
                settled.signal()
            }
        }
        guard settled.wait(timeout: .now() + Self.pageTimeout) == .success, !failure.isSettled else {
            // The page never answered inside the ceiling, or WebKit could not evaluate at all:
            // unavailable, never a guessed success.
            return LanAnswer(status: 503, body: Self.unavailable, headers: nil)
        }
        guard let raw = box.value else {
            // The page answered `null`: a route it does not own. A 404, not an invented empty 200.
            return LanAnswer(status: 404, body: #"{"error":"NOT_FOUND"}"#, headers: nil)
        }
        if raw == "UNAVAILABLE" || raw == "HANDLE_FAILED" {
            // No published `window.MegaLanRoom` yet, or a handler that threw: the frozen 503,
            // exactly as the Android host answers the same two conditions.
            return LanAnswer(status: 503, body: Self.unavailable, headers: nil)
        }
        if raw.isEmpty {
            return LanAnswer(status: 404, body: #"{"error":"NOT_FOUND"}"#, headers: nil)
        }
        guard let parsed = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] else {
            return LanAnswer(status: 503, body: Self.unavailable, headers: nil)
        }
        guard let status = parsed["status"] as? NSNumber else {
            let code = (parsed["error"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "SERVICE_UNAVAILABLE"
            return LanAnswer(status: 503, body: Self.json(["error": code]) ?? Self.unavailable, headers: nil)
        }
        let value = parsed["body"]
        let body = (value == nil || value is NSNull) ? "{}" : (Self.jsonValue(value) ?? "{}")
        return LanAnswer(status: status.intValue, body: body, headers: parsed["headers"] as? [String: Any])
    }

    // MARK: - responses

    /// The page is the authority on its own response headers: the bundled room handler composes the
    /// CORS headers a cross-origin guest needs (`src/lan/lan-room-http.js`), so dropping them here
    /// would turn every answer into an opaque cross-origin failure. Only the framing headers this
    /// listener owns are reserved, and every value is checked for a line break, because a response
    /// header built from a page string would otherwise be a response-splitting hole.
    ///
    /// The frozen `src/lan/lan-host.js` answers with `{status, body, headers:{'cache-control':
    /// 'no-store'}}` and does not republish `lan-room-http.js`'s own CORS constant, so those four
    /// headers are written as the default here — the same values that module defines — and any
    /// value the page does supply still wins.
    private func respond(_ exchange: LanExchange, status: Int, body: String, extra: [String: Any]? = nil) {
        // The 4 s watchdog can release a connection while its request is still waiting on the page;
        // a released exchange is never written to.
        guard !exchange.done.isSettled else { return }
        // A 204 has no body and must not claim one.
        let payload = status == 204 ? Data() : Data(body.utf8)
        var head = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        head += "Content-Type: application/json\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "X-Content-Type-Options: nosniff\r\n"
        head += "Content-Length: \(payload.count)\r\n"
        var headers = Self.corsHeaders
        for (name, value) in extra ?? [:] { headers[name.lowercased()] = value }
        for (name, value) in headers.sorted(by: { $0.key < $1.key }) {
            let key = name.lowercased()
            guard !Self.reservedHeaders.contains(key),
                  key.unicodeScalars.allSatisfy({ (33...126).contains($0.value) }), !key.contains(":"),
                  let text = value as? String, !text.isEmpty,
                  !text.contains("\r"), !text.contains("\n") else { continue }
            head += "\(key): \(text)\r\n"
        }
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(payload)
        exchange.connection.send(content: out, completion: .contentProcessed { [weak self] _ in
            self?.release(exchange)
        })
    }

    /// Cancels one connection and returns its slot exactly once, whichever of the send completion,
    /// the watchdog and the state handler arrives first.
    private func release(_ exchange: LanExchange) {
        guard exchange.done.claim() else { return }
        exchange.watchdog?.cancel()
        exchange.connection.cancel()
        lock.lock()
        live.removeValue(forKey: ObjectIdentifier(exchange))
        lock.unlock()
        slots.signal()
    }

    private func track(_ exchange: LanExchange) {
        lock.lock()
        live[ObjectIdentifier(exchange)] = exchange
        lock.unlock()
    }

    // MARK: - discovery

    /// Same-Wi-Fi discovery. Advertising and browsing both go through Bonjour; a host that answers
    /// Bonjour but not HTTP is skipped rather than reported as an empty room list. When Bonjour is
    /// unavailable the caller is told honestly (`ok = false` plus the code, which
    /// `src/lan/lan-host.js` turns into an unavailable lobby) instead of receiving an empty list
    /// that would look like "nobody is hosting".
    private func browse(timeoutMs: Int, complete: @escaping ([String: Any]) -> Void) {
        lock.lock()
        let busy = browseSession != nil
        lock.unlock()
        if isClosed {
            complete(["ok": false, "error": "DISCOVERY_UNAVAILABLE", "hosts": []] as [String: Any])
            return
        }
        if busy {
            complete(["ok": false, "error": "DISCOVERY_BUSY", "hosts": []] as [String: Any])
            return
        }
        let session = LanBrowseSession()
        session.complete = complete
        lock.lock()
        browseSession = session
        lock.unlock()

        let browser = NWBrowser(for: .bonjour(type: Self.serviceType, domain: nil), using: .tcp)
        session.browser = browser
        browser.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.finishBrowse(session, ok: false, error: "DISCOVERY_UNAVAILABLE")
            default: break
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            self.lock.lock()
            let live = self.browseSession === session && !session.finished
            if live {
                for result in results where session.seen.count < Self.maxBrowseHosts {
                    guard case let .service(name, _, _, _) = result.endpoint else { continue }
                    guard session.seen.insert(name).inserted else { continue }
                    session.pending.append(result)
                }
            }
            self.lock.unlock()
            if live { self.browseNext() }
        }
        browser.start(queue: queue)
        // The caller's timeout is the browse budget, bounded so a wedged radio cannot hang a lobby.
        let budget = min(max(timeoutMs, 300), 8_000)
        session.watchdog = DispatchWorkItem { [weak self] in
            self?.finishBrowse(session, ok: true, error: nil)
        }
        queue.asyncAfter(deadline: .now() + .milliseconds(budget), execute: session.watchdog!)
    }

    /// Resolves one discovered host at a time, exactly like the Android browse chain: resolving
    /// every service in parallel would be unbounded work for a list the lobby only reads once.
    private func browseNext() {
        lock.lock()
        guard let session = browseSession, !session.finished, !session.resolving,
              !session.pending.isEmpty else {
            lock.unlock()
            return
        }
        session.resolving = true
        let result = session.pending.removeFirst()
        lock.unlock()
        guard case let .service(name, _, _, _) = result.endpoint else {
            advanceBrowse(session)
            return
        }
        let connection = NWConnection(to: result.endpoint, using: .tcp)
        let settled = LanFlag()
        lock.lock()
        session.connections.append(connection)
        lock.unlock()
        let watchdog = DispatchWorkItem { [weak self] in
            guard let self, settled.claim() else { return }
            connection.cancel()
            self.advanceBrowse(session)
        }
        queue.asyncAfter(deadline: .now() + Self.resolveTimeout, execute: watchdog)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, !settled.isSettled else { return }
            switch state {
            case .ready:
                self.discoverRooms(session: session, name: name, connection: connection, settled: settled)
            case .failed, .cancelled, .waiting:
                guard settled.claim() else { return }
                connection.cancel()
                self.advanceBrowse(session)
            default:
                break
            }
        }
        connection.start(queue: connections)
    }

    /// One `GET /api/party/discover` on the connection Bonjour just resolved, read whole and freed
    /// of its transfer coding before the rooms are handed to the page.
    private func discoverRooms(session: LanBrowseSession, name: String, connection: NWConnection,
                               settled: LanFlag) {
        // A LAN room lives on a private or link-local IPv4 literal; anything else is not this Wi-Fi
        // and would fail the room contract's own Host check anyway.
        guard case let .hostPort(host, port)? = connection.currentPath?.remoteEndpoint,
              let literal = Self.ipv4String(host), Self.isPrivateLanIPv4(literal),
              (1024...65535).contains(Int(port.rawValue)) else {
            guard settled.claim() else { return }
            connection.cancel()
            advanceBrowse(session)
            return
        }
        // The room contract validates the literal `host:port` it is reached on, so the header names
        // the address this socket actually dialled — never a caller-supplied value.
        let request = "GET \(Self.discoverPath) HTTP/1.1\r\n"
            + "Host: \(literal):\(port.rawValue)\r\n"
            + "Connection: close\r\n\r\n"
        connection.send(content: Data(request.utf8), completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            guard error == nil else {
                guard settled.claim() else { return }
                connection.cancel()
                self.advanceBrowse(session)
                return
            }
            self.readAll(connection, cap: Self.maxResponse, settled: settled, buffer: Data()) { data in
                guard settled.claim() else { return }
                connection.cancel()
                if case let .ok(_, body) = Self.parseUpstreamResponse(data),
                   let parsed = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any],
                   let rooms = parsed["rooms"] as? [[String: Any]] {
                    self.record(session, key: "\(literal):\(port.rawValue)", name: name,
                                origin: "http://\(literal):\(port.rawValue)", rooms: rooms)
                }
                self.advanceBrowse(session)
            }
        })
    }

    private func record(_ session: LanBrowseSession, key: String, name: String, origin: String,
                        rooms: [[String: Any]]) {
        lock.lock()
        if browseSession === session, !session.finished, session.results.count < Self.maxBrowseHosts {
            session.results[key] = ["name": name, "origin": origin, "rooms": rooms]
        }
        lock.unlock()
    }

    private func advanceBrowse(_ session: LanBrowseSession) {
        lock.lock()
        guard browseSession === session, !session.finished else {
            lock.unlock()
            return
        }
        session.resolving = false
        lock.unlock()
        browseNext()
    }

    private func finishBrowse(_ session: LanBrowseSession, ok: Bool, error: String?) {
        lock.lock()
        guard browseSession === session, !session.finished else {
            lock.unlock()
            return
        }
        browseSession = nil
        session.finished = true
        let complete = session.complete
        session.complete = nil
        let results = session.results
        let open = session.connections
        session.connections = []
        let browser = session.browser
        session.watchdog?.cancel()
        lock.unlock()

        browser?.stateUpdateHandler = nil
        browser?.browseResultsChangedHandler = { _, _ in }
        browser?.cancel()
        for connection in open { connection.cancel() }
        let hosts = results.values.sorted { (($0["origin"] as? String) ?? "") < (($1["origin"] as? String) ?? "") }
        complete?(["ok": ok, "error": error ?? NSNull(), "hosts": hosts])
    }

    private func readAll(_ connection: NWConnection, cap: Int, settled: LanFlag, buffer: Data,
                         complete: @escaping (Data) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8_192) { [weak self] chunk, _, isComplete, error in
            guard let self, !settled.isSettled else { return }
            var data = buffer
            if let chunk { data.append(chunk) }
            if error != nil || isComplete || data.count >= cap {
                complete(data.count > cap ? Data(data.prefix(cap)) : data)
                return
            }
            self.readAll(connection, cap: cap, settled: settled, buffer: data, complete: complete)
        }
    }

    // MARK: - the page's own LAN traffic

    /// Carries one `fetch` the page made to a room: a same-document call while this device hosts
    /// (rewritten to its own loopback listener), or the private literal the page just discovered.
    /// Another scheme, another path, another port or a public address is refused here, in code —
    /// the signed page is a `file://` document and the WebView's content rule blocks every http(s)
    /// subresource it would otherwise make, so this is the page's only room transport.
    private func partyFetch(_ command: [String: Any]) -> [String: Any] {
        guard let raw = command["url"] as? String,
              let target = URL(string: raw),
              let path = URLComponents(url: target, resolvingAgainstBaseURL: false)?.path,
              path.hasPrefix("/api/party/") else {
            return ["ok": false, "error": "LAN_BLOCKED"]
        }
        let method = (command["method"] as? String ?? "GET").uppercased()
        guard method == "GET" || method == "POST" else { return ["ok": false, "error": "LAN_BLOCKED"] }
        let body = (command["body"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if let body, body.utf8.count > Self.maxBody {
            return ["ok": false, "error": "PAYLOAD_TOO_LARGE"]
        }
        var headers: [String: String] = [:]
        for (name, value) in (command["headers"] as? [String: Any]) ?? [:] {
            let key = name.lowercased()
            guard Self.forwardedHeaders.contains(key),
                  let text = value as? String, !text.isEmpty, text.utf8.count <= 1_024,
                  !text.contains("\r"), !text.contains("\n") else { continue }
            headers[key] = text
        }
        let host: String
        let port: Int
        if target.scheme == "file" {
            let bound = boundPort
            guard listener != nil, bound > 0 else { return ["ok": false, "error": "LAN_UNAVAILABLE"] }
            host = Self.loopback
            port = bound
        } else {
            guard target.scheme == "http",
                  let candidate = target.port, (1024...65535).contains(candidate),
                  let name = target.host, Self.isPrivateLanIPv4(name) else {
                return ["ok": false, "error": "LAN_BLOCKED"]
            }
            host = name
            port = candidate
        }
        let query = target.query
        let fullPath = (query?.isEmpty ?? true) ? path : "\(path)?\(query!)"
        switch rawRequest(host: host, port: port, method: method, path: fullPath, headers: headers, body: body) {
        case .ok(let status, let text):
            return ["ok": true, "status": status, "body": text]
        // A body whose framing could not be undone is not handed to the page at all: a partial or
        // size-prefixed body would surface as a confusing parse failure in the lobby, so the answer
        // is a clean 502 the page already knows how to render.
        case .failed(let code):
            return ["ok": true, "status": 502, "body": Self.json(["error": code]) ?? #"{"error":"UPSTREAM_DECODE"}"#]
        }
    }

    /// One request/response through `Network.framework`, blocking the calling worker until it lands
    /// or the bounded timeout fires. This is never called on the main thread.
    private func rawRequest(host: String, port: Int, method: String, path: String,
                            headers: [String: String], body: String?) -> Upstream {
        guard let endpoint = NWEndpoint.Port(rawValue: UInt16(port)) else { return .failed("LAN_UNAVAILABLE") }
        let payload = body.map { Data($0.utf8) }
        var request = "\(method) \(path) HTTP/1.1\r\n"
        // The room contract validates the literal `host:port` it is reached on, so the header names
        // the address this socket actually dialled — never a caller-supplied value.
        request += "Host: \(host):\(port)\r\n"
        for (name, value) in headers.sorted(by: { $0.key < $1.key }) {
            request += "\(name): \(value)\r\n"
        }
        if method == "POST" { request += "Content-Length: \(payload?.count ?? 0)\r\n" }
        request += "Connection: close\r\n\r\n"
        var out = Data(request.utf8)
        if let payload { out.append(payload) }

        let upstream = NWConnection(host: NWEndpoint.Host(host), port: endpoint, using: Self.tcpParameters())
        let ready = LanFlag()
        let settled = LanFlag()
        let box = LanBox<Upstream>(.failed("LAN_UNAVAILABLE"))
        let finished = DispatchSemaphore(value: 0)
        let queue = DispatchQueue(label: "online.megaxo.lan.upstream")
        upstream.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                guard ready.claim() else { return }
                upstream.send(content: out, completion: .contentProcessed { error in
                    guard let self else { return }
                    guard error == nil else {
                        guard settled.claim() else { return }
                        box.value = .failed("LAN_UNAVAILABLE")
                        finished.signal()
                        return
                    }
                    // The same reader serves a discovered host AND this device's own listener, so a
                    // host that chunk-encodes its answer is decoded just the same.
                    self.readAll(upstream, cap: Self.maxResponse, settled: settled, buffer: Data()) { data in
                        guard settled.claim() else { return }
                        box.value = Self.parseUpstreamResponse(data)
                        finished.signal()
                    }
                })
            case .failed, .cancelled, .waiting:
                guard settled.claim() else { return }
                box.value = .failed("LAN_UNAVAILABLE")
                finished.signal()
            default:
                break
            }
        }
        upstream.start(queue: queue)
        if finished.wait(timeout: .now() + Self.upstreamTimeout) == .timedOut {
            _ = settled.claim()
            upstream.stateUpdateHandler = nil
            upstream.cancel()
            return .failed("LAN_UNAVAILABLE")
        }
        upstream.stateUpdateHandler = nil
        upstream.cancel()
        return box.value
    }

    // MARK: - teardown

    func close() {
        lock.lock()
        if closed {
            lock.unlock()
            return
        }
        closed = true
        let session = browseSession
        browseSession = nil
        lock.unlock()
        stopListening()
        _ = stopAdvertising()
        if let session {
            session.finished = true
            session.watchdog?.cancel()
            session.browser?.stateUpdateHandler = nil
            session.browser?.browseResultsChangedHandler = { _, _ in }
            session.browser?.cancel()
            for connection in session.connections { connection.cancel() }
            session.complete = nil
        }
    }

    // MARK: - shared shapes

    private final class LanAnswer {
        let status: Int
        let body: String
        let headers: [String: Any]?

        init(status: Int, body: String, headers: [String: Any]?) {
            self.status = status
            self.body = body
            self.headers = headers
        }
    }

    private final class LanExchange {
        let connection: NWConnection
        let remote: String
        let done = LanFlag()
        var buffer = Data()
        var complete = false
        var watchdog: DispatchWorkItem?

        init(connection: NWConnection) {
            self.connection = connection
            self.remote = Self.remoteAddress(connection)
        }

        private static func remoteAddress(_ connection: NWConnection) -> String {
            guard case let .hostPort(host, _) = connection.endpoint else { return "" }
            return MegaNativeLanBridge.ipv4String(host) ?? "\(host)"
        }
    }

    /// A one-shot flag: the rendezvous for a listener binding, a connection slot and a browse host.
    private final class LanFlag {
        private let lock = NSLock()
        private var stored: Bool?

        func claim(_ value: Bool) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if stored != nil { return false }
            stored = value
            return true
        }

        func claim() -> Bool { claim(true) }

        var isSettled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return stored != nil
        }

        var value: Bool? {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
    }

    private final class LanBox<T> {
        private let lock = NSLock()
        private var stored: T

        init(_ value: T) { stored = value }

        var value: T {
            get {
                lock.lock()
                defer { lock.unlock() }
                return stored
            }
            set {
                lock.lock()
                stored = newValue
                lock.unlock()
            }
        }
    }

    private final class LanBrowseSession {
        var browser: NWBrowser?
        var results: [String: [String: Any]] = [:]
        var pending: [NWBrowser.Result] = []
        var seen: Set<String> = []
        var connections: [NWConnection] = []
        var resolving = false
        var finished = false
        var watchdog: DispatchWorkItem?
        var complete: (([String: Any]) -> Void)?
    }

    // MARK: - parsing helpers

    /// One upstream response, with its body already freed of its transfer coding — or the reason it
    /// could not be. A room host on this Wi-Fi is as likely to be Node's `http` server, which
    /// answers a JSON body with `Transfer-Encoding: chunked`, as it is to be another phone running
    /// this same listener. Handing the page the raw chunks would put a leading `"345\r\n"` in front
    /// of the JSON and truncate it, so the framing is undone here, once, for every caller.
    enum Upstream {
        case ok(Int, String)
        case failed(String)
    }

    static func parseUpstreamResponse(_ raw: Data) -> Upstream {
        let bytes = [UInt8](raw)
        guard let split = indexOfCRLFCRLF(bytes) else { return .failed("UPSTREAM_DECODE") }
        // The head is ASCII; the body is bytes and must not be widened to latin-1 on the way in.
        let head = String(decoding: bytes[0..<split], as: UTF8.self)
        let body = Array(bytes[(split + 4)...])
        let lines = head.components(separatedBy: "\r\n")
        let status = lines.first?.split(separator: " ").dropFirst().first.flatMap { Int($0) } ?? 0
        var chunked = false
        var declared = -1
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            switch name {
            // A coding list can name others before chunked; the last one is what frames the body.
            case "transfer-encoding":
                if value.split(separator: ",").last?.trimmingCharacters(in: .whitespaces)
                    .lowercased() == "chunked" { chunked = true }
            case "content-length":
                declared = Int(value) ?? -1
            default:
                break
            }
        }
        if chunked {
            guard let decoded = decodeChunked(body) else { return .failed("UPSTREAM_DECODE") }
            return .ok(status, String(decoding: decoded, as: UTF8.self))
        }
        // Transfer-Encoding outranks Content-Length when both are present.
        if declared >= 0 {
            guard body.count >= declared else { return .failed("UPSTREAM_DECODE") }
            return .ok(status, String(decoding: body[0..<declared], as: UTF8.self))
        }
        // No framing at all: `Connection: close` is the delimiter, and the read ran to the end.
        return .ok(status, String(decoding: body, as: UTF8.self))
    }

    /// Undoes `Transfer-Encoding: chunked`. Returns nil for anything malformed — a size that is not
    /// hex, a chunk running past the bytes that arrived, a missing CRLF, or a decoded body over the
    /// response cap — so the caller can answer an honest failure instead of a body the page will
    /// choke on. Chunk extensions (`;name=value`) carry no body bytes and are ignored.
    private static func decodeChunked(_ body: [UInt8]) -> [UInt8]? {
        var out: [UInt8] = []
        var offset = 0
        while true {
            guard let lineEnd = indexOfCRLF(body, from: offset) else { return nil }
            let header = String(decoding: body[offset..<lineEnd], as: UTF8.self)
            guard let size = Int(header.split(separator: ";")[0].trimmingCharacters(in: .whitespaces), radix: 16),
                  size >= 0 else { return nil }
            offset = lineEnd + 2
            if size == 0 { return out }
            guard offset + size <= body.count, out.count + size <= maxResponse else { return nil }
            out.append(contentsOf: body[offset..<(offset + size)])
            offset += size
            // Each chunk's data is followed by its own CRLF.
            guard offset + 2 <= body.count, body[offset] == 13, body[offset + 1] == 10 else { return nil }
            offset += 2
        }
    }

    private static func indexOfCRLFCRLF(_ raw: Data) -> Int? {
        let bytes = [UInt8](raw)
        return indexOfCRLFCRLF(bytes)
    }

    private static func indexOfCRLFCRLF(_ bytes: [UInt8]) -> Int? {
        guard bytes.count >= 4 else { return nil }
        for index in 0...(bytes.count - 4) where bytes[index] == 13 && bytes[index + 1] == 10
            && bytes[index + 2] == 13 && bytes[index + 3] == 10 {
            return index
        }
        return nil
    }

    private static func indexOfCRLF(_ bytes: [UInt8], from: Int) -> Int? {
        guard bytes.count >= 2, from <= bytes.count - 2 else { return nil }
        for index in from...(bytes.count - 2) where bytes[index] == 13 && bytes[index + 1] == 10 {
            return index
        }
        return nil
    }

    /// Reduces an absolute-form request target to its path and query, leaving origin-form alone.
    private static func absolutize(_ target: String) -> String {
        guard let scheme = target.range(of: "://") else { return target }
        let rest = target[scheme.upperBound...]
        guard let path = rest.firstIndex(of: "/") else { return "/" }
        return String(rest[path...])
    }

    private static func parseQuery(_ target: String) -> [String: String] {
        var query: [String: String] = [:]
        guard let mark = target.firstIndex(of: "?") else { return query }
        for pair in target[target.index(after: mark)...].split(separator: "&", omittingEmptySubsequences: false) {
            if pair.isEmpty { continue }
            let index = pair.firstIndex(of: "=")
            let name = index.map { String(pair[..<$0]) } ?? String(pair)
            guard !name.isEmpty else { continue }
            let value = index.map { String(pair[pair.index(after: $0)...]) } ?? ""
            query[decode(name)] = decode(value)
        }
        return query
    }

    private static func decode(_ value: String) -> String {
        return value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? value
    }

    /// The literal private / link-local / loopback IPv4 hosts a Wi-Fi guest could be pointing at. A
    /// host name is never private: resolving a name here would make "private" a property of DNS
    /// rather than of the address, which is exactly the check this needs to stay.
    static func isPrivateLanIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        var values: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.allSatisfy({ $0.isNumber }), let value = Int(part), (0...255).contains(value) else {
                return false
            }
            values.append(value)
        }
        switch values[0] {
        case 10, 127: return true
        case 172: return (16...31).contains(values[1])
        case 192: return values[1] == 168
        case 169: return values[1] == 254
        default: return false
        }
    }

    static func ipv4String(_ host: NWEndpoint.Host) -> String? {
        switch host {
        // A Bonjour-resolved peer arrives scope-qualified (`192.168.0.9%en0`), because the record can
        // be reachable over more than one interface. The scope names this device's own interface, not
        // the peer's address, so it is stripped before the literal check and before the `Host` header.
        case .ipv4(let address): return "\(address)".split(separator: "%", maxSplits: 1)[0].description
        case .name(let name, _): return name.isEmpty ? nil : name
        // An IPv6 peer is not a lobby URL: the room contract's `Host` guard is a literal IPv4.
        case .ipv6: return nil
        @unknown default: return nil
        }
    }

    private static func trusted(_ url: URL?, entry: URL) -> Bool {
        guard let url, url.isFileURL else { return false }
        return url.standardizedFileURL.resolvingSymlinksInPath() == entry
    }

    private static func decode(_ payload: Substring) -> [String: Any]? {
        guard let data = payload.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func integer(_ value: Any?) -> Int {
        if let number = value as? NSNumber { return number.intValue }
        if let text = value as? String { return Int(text) ?? 0 }
        return 0
    }

    private static func json(_ object: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func jsonValue(_ value: Any?) -> String? {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func tcpParameters() -> NWParameters {
        let options = NWProtocolTCP.Options()
        options.noDelay = true
        options.connectionTimeout = 4
        let parameters = NWParameters(tls: nil, tcp: options)
        parameters.allowLocalEndpointReuse = true
        return parameters
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 409: return "Conflict"
        case 413: return "Payload Too Large"
        case 429: return "Too Many Requests"
        case 431: return "Request Header Fields Too Large"
        case 500: return "Internal Server Error"
        case 503: return "Service Unavailable"
        default: return "Status"
        }
    }

    // MARK: - constants

    private static let channelName = "megaLanDiscovery"
    private static let promptPrefix = "megaLanBridge"
    private static let serviceType = "_megaxo-v5._tcp"
    private static let discoverPath = "/api/party/discover"
    private static let loopback = "127.0.0.1"
    private static let unavailable = #"{"error":"SERVICE_UNAVAILABLE"}"#
    private static let badRequest = #"{"error":"INVALID_REQUEST"}"#
    private static let maxConnections = 4
    private static let maxBrowseHosts = 32
    private static let maxHead = 8_192
    private static let maxBody = 16_384
    private static let maxResponse = 65_536
    private static let defaultBrowseMs = 2_500
    private static let pageTimeout: TimeInterval = 2
    private static let socketTimeout: TimeInterval = 4
    private static let bindTimeout: TimeInterval = 2
    private static let resolveTimeout: TimeInterval = 2.5
    private static let upstreamTimeout: TimeInterval = 3

    /// The headers a LAN guest legitimately presents. The bearer is what the page already attached
    /// to its own fetch; nothing here names, invents or reads a credential.
    private static let forwardedHeaders: Set<String> = [
        "authorization", "content-type", "idempotency-key", "accept"
    ]

    /// Headers this listener always writes itself, so a page cannot replace them.
    private static let reservedHeaders: Set<String> = [
        "content-type", "content-length", "cache-control", "x-content-type-options",
        "connection", "transfer-encoding", "host"
    ]

    /// The exact cross-origin policy `src/lan/lan-room-http.js` defines for a browser guest, used
    /// as the response default so a page answer that omits it is still reachable from another
    /// device's browser. `access-control-allow-credentials` is deliberately never set.
    private static let corsHeaders: [String: Any] = [
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, idempotency-key",
        "access-control-max-age": "600"
    ]
}
