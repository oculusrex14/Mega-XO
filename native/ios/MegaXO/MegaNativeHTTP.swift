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
        if method == "POST" && (body == nil || body!.count > 65536) {
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
