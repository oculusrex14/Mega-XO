import Foundation

/// P20-03 native HTTPS client. The WebView never receives a refresh token,
/// native bearer token, arbitrary fetch proxy or access to URLSession cookies.
/// Until the P05 access-token issuer is ready, no request is authenticated.
actor MegaNativeHTTP {
    enum RequestError: Error {
        case unavailable, invalidPath, invalidMethod, invalidBody
        case tooLarge, responseInvalid, redirected, unauthorized
        case httpFailure(Int)
    }

    private let origin: URL?
    private var accessToken: String?
    private let session: URLSession
    private static let allowedPrefixes = [
        "/api/account/", "/api/community/", "/api/monetization/",
        "/api/v1/", "/api/party/"
    ]
    /// The five cookie-free native credential routes, and ONLY those, may be called before a
    /// session exists (challenge) or with a deliberate bearer supplied by the session owner.
    private static let nativePaths: Set<String> = [
        "/api/account/native/challenge", "/api/account/native/token",
        "/api/account/native/refresh", "/api/account/native/logout"
    ]

    init(apiOrigin: String?) {
        if let raw = apiOrigin, let parsed = URL(string: raw),
           parsed.scheme == "https", parsed.user == nil, parsed.password == nil,
           parsed.query == nil, parsed.fragment == nil, parsed.path.isEmpty || parsed.path == "/" {
            origin = parsed
        } else {
            origin = nil
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    /// True only when an approved HTTPS origin was configured for the built app.
    /// The WebView never learns this value; it gates the native session host, not JS.
    func isConfigured() -> Bool { origin != nil }

    /// Cookie-free native credential exchange (challenge/token/refresh/logout). `bearer` is supplied
    /// deliberately by MegaNativeSession, which owns the access token in memory, or is nil for a
    /// first sign-in that has no session yet. The cookie jar is never consulted and no Idempotency
    /// key is invented: these routes' idempotency is durable challenge/family state on the server.
    func authRequest(path: String, bearer: String?, body: Data) async throws -> (Int, Data) {
        guard let origin else { throw RequestError.unavailable }
        guard Self.nativePaths.contains(path) else { throw RequestError.invalidPath }
        // The largest declared route contract (packages/contracts/routes.js) is 300000
        // (account.save.write); a 64 KiB client cap refused large cloud saves before any
        // server contact. Stay at the contract ceiling; the server enforces its own limits.
        guard body.count <= 300000 else { throw RequestError.invalidBody }
        if let bearer {
            guard bearer.utf8.count >= 24, bearer.utf8.count <= 8192,
                  bearer.allSatisfy({ $0.isASCII && !$0.isWhitespace })
            else { throw RequestError.invalidBody }
        }
        let url = origin.appendingPathComponent(String(path.dropFirst()))
        guard url.host == origin.host, url.scheme == "https" else { throw RequestError.invalidPath }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        // No Cookie header is ever composed, and no access token is presented when the caller
        // deliberately passes none (a first sign-in has no session).
        if let bearer { request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization") }
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        guard data.count <= 524288 else { throw RequestError.tooLarge }
        guard let http = response as? HTTPURLResponse,
              http.url?.scheme == "https",
              http.url?.host == origin.host,
              http.url?.port == origin.port else { throw RequestError.responseInvalid }
        if (300...399).contains(http.statusCode) { throw RequestError.redirected }
        // A 401 is a REAL answer on these routes (terminal revocation on refresh), so it is
        // returned to the caller rather than collapsed into `unauthorized`.
        guard http.mimeType == "application/json" else { throw RequestError.responseInvalid }
        return (http.statusCode, data)
    }

    /// Only a verified native P05 session exchange may install an access token.
    func installVerifiedAccessToken(_ token: String?) {
        guard let token, token.utf8.count <= 8192, token.utf8.count >= 24,
              token.allSatisfy({ $0.isASCII && !$0.isWhitespace }) else {
            accessToken = nil
            return
        }
        accessToken = token
    }

    func revokeLocalAccess() { accessToken = nil }

    func request(path: String, method: String, body: Data?, idempotencyKey: String?)
        async throws -> Data {
        guard let origin, let token = accessToken else { throw RequestError.unavailable }
        let permitted = method == "GET" || method == "POST"
        guard permitted else { throw RequestError.invalidMethod }
        guard path.utf8.count <= 512,
              path.hasPrefix("/api/"),
              !path.contains(".."), !path.contains("//"),
              !path.contains("?"), !path.contains("#"), !path.contains("%"),
              Self.allowedPrefixes.contains(where: { path.hasPrefix($0) })
        else { throw RequestError.invalidPath }
        if method == "GET" && body != nil { throw RequestError.invalidBody }
        if method == "POST" && (body == nil || body!.count > 300000) {
            throw RequestError.invalidBody
        }
        if method == "POST" {
            guard let idempotencyKey, idempotencyKey.utf8.count <= 128,
                  !idempotencyKey.isEmpty,
                  idempotencyKey.allSatisfy({ $0.isASCII && !$0.isWhitespace })
            else { throw RequestError.invalidBody }
        }
        let url = origin.appendingPathComponent(String(path.dropFirst()))
        guard url.host == origin.host && url.scheme == "https" else { throw RequestError.invalidPath }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if method == "POST" {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        let (data, response) = try await session.data(for: request)
        guard data.count <= 524288 else { throw RequestError.tooLarge }
        guard let http = response as? HTTPURLResponse,
              http.url?.scheme == "https",
              http.url?.host == origin.host,
              http.url?.port == origin.port else { throw RequestError.responseInvalid }
        // NoRedirectDelegate opts out of following redirects. A 30x must not
        // be mistaken for a successful account/game command.
        if (300...399).contains(http.statusCode) { throw RequestError.redirected }
        if http.statusCode == 401 { throw RequestError.unauthorized }
        guard http.mimeType == "application/json" else { throw RequestError.responseInvalid }
        guard (200...299).contains(http.statusCode) else {
            throw RequestError.httpFailure(http.statusCode)
        }
        return data
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
