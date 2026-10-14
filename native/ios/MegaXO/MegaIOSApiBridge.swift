import Foundation
import UIKit
import WebKit

/// P20-03 iOS parity of Android's MegaNativeApiBridge. The signed game already issues every
/// account/game call through one adapter; in the native host that adapter is routed here instead of
/// to the WebView's (nonexistent) cookie jar.
///
/// JavaScript may ask for exactly one thing: an allowlisted API path with a method, an optional JSON
/// body and an optional operation key. It may NOT supply an Authorization value, a Cookie, a header,
/// an arbitrary host, a scheme or a redirect target. The bearer is attached by MegaNativeSession
/// inside Swift and never crosses the bridge in either direction.
///
/// The handler is main-frame only, restricted to the exact signed entry file, exactly like the
/// existing notification and identity handlers.
@MainActor
final class MegaIOSApiBridge: NSObject, WKScriptMessageHandlerWithReply {
    private let trustedEntry: URL
    private let http: MegaNativeHTTP
    private let session: MegaNativeSession
    private let apple: MegaIOSIdentityBridge?
    private let maxPathLength = 512
    private let maxBodyLength = 65536

    init(entry: URL, http: MegaNativeHTTP, session: MegaNativeSession, apple: MegaIOSIdentityBridge?) {
        trustedEntry = entry.standardizedFileURL.resolvingSymlinksInPath()
        self.http = http
        self.session = session
        self.apple = apple
        super.init()
    }

    static let bootstrap = #"""
    (() => {
      if (window.top !== window || window.MegaNativeApi) return;
      const bridge = window.webkit?.messageHandlers?.megaNativeApi;
      if (!bridge || typeof bridge.postMessage !== 'function') return;
      Object.defineProperty(window, 'MegaNativeApi', {
        configurable: false, enumerable: false,
        value: Object.freeze({
          session: () => bridge.postMessage({op: 'session'}),
          refresh: () => bridge.postMessage({op: 'refresh'}),
          signOut: allDevices => bridge.postMessage({op: 'signOut', allDevices: allDevices === true}),
          signIn: (provider, intent) => bridge.postMessage({op: 'signIn', provider, intent}),
          request: (path, method, body, key) => bridge.postMessage({op: 'request', path, method, body, key})
        })
      });
    })();
    """#

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.name == "megaNativeApi",
              message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url,
              url.isFileURL,
              url.standardizedFileURL.resolvingSymlinksInPath() == trustedEntry,
              let body = message.body as? [String: Any],
              let op = body["op"] as? String
        else {
            replyHandler(nil, "NATIVE_API_UNTRUSTED_FRAME")
            return
        }
        switch op {
        case "session": respondSession(replyHandler)
        case "refresh": respondRefresh(replyHandler)
        case "signOut": respondSignOut(body, replyHandler)
        case "signIn": respondSignIn(body, replyHandler)
        case "request": respondRequest(body, replyHandler)
        default: replyHandler(nil, "NATIVE_API_UNSUPPORTED")
        }
    }

    private func respondSession(_ reply: @escaping (Any?, String?) -> Void) {
        Task { @MainActor in
            let status = await session.status()
            // `providers` is reported as the capability that was actually compiled in, never as a
            // claim: no Apple adapter means Apple is not advertised as a native provider.
            let providers: [String] = apple != nil ? ["apple"] : []
            reply(["ok": true,
                   "linked": status.linked,
                   "actorId": status.actorId as Any,
                   "expiresAt": (status.expiresAt?.timeIntervalSince1970 ?? 0) * 1000,
                   "online": await http.isConfigured(),
                   "providers": providers], nil)
        }
    }

    private func respondRefresh(_ reply: @escaping (Any?, String?) -> Void) {
        Task { @MainActor in
            let outcome = await session.refresh()
            reply(["ok": outcome == .ok, "outcome": outcome.rawValue], nil)
        }
    }

    private func respondSignOut(_ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        let allDevices = body["allDevices"] as? Bool ?? false
        Task { @MainActor in
            // `allDevices` is best-effort: a server that rejects the field must not make sign-out
            // fail, and local credentials are cleared either way.
            var revoked = await session.signOut(allDevices: allDevices)
            if !revoked && allDevices { revoked = await session.signOut(allDevices: false) }
            reply(["ok": revoked], nil)
        }
    }

    private func respondSignIn(_ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let provider = body["provider"] as? String,
              let apple,
              provider == "apple"
        else {
            reply(["ok": false, "error": "PROVIDER_NOT_CONFIGURED"], nil)
            return
        }
        Task { @MainActor in
            let intent = (body["intent"] as? String) ?? "login"
            switch await session.challenge(provider: provider, intent: intent) {
            case .failure:
                reply(["ok": false, "error": "NATIVE_SIGNIN_FAILED"], nil)
            case .success(let challenge):
                guard let idToken = await apple.credential(nonce: challenge.nonce) else {
                    reply(["ok": false, "error": "NATIVE_SIGNIN_FAILED"], nil)
                    return
                }
                let outcome = await session.signIn(provider: provider,
                                                   state: challenge.state, idToken: idToken)
                reply(["ok": outcome == .ok, "outcome": outcome.rawValue], nil)
            }
        }
    }

    private func respondRequest(_ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        let path = body["path"] as? String ?? ""
        let method = (body["method"] as? String ?? "GET").uppercased()
        guard method == "GET" || method == "POST",
              !path.isEmpty, path.utf8.count <= maxPathLength,
              path.hasPrefix("/api/"),
              !path.contains(".."), !path.contains("//"),
              !path.contains("%"), !path.contains("#"), !path.contains("?")
        else {
            reply(["ok": false, "error": "INVALID_NATIVE_REQUEST"], nil)
            return
        }
        let payload: String? = method == "GET" ? nil : jsonString(body["body"]) ?? "{}"
        if let payload, payload.utf8.count > maxBodyLength {
            reply(["ok": false, "error": "INVALID_NATIVE_REQUEST"], nil)
            return
        }
        let key = (body["key"] as? String).flatMap { $0.isEmpty || $0.utf8.count > 128 ? nil : $0 }
        Task { @MainActor in
            do {
                let data = try await self.http.request(
                    path: path, method: method,
                    body: payload.map { Data($0.utf8) }, idempotencyKey: key)
                let value = (try? JSONSerialization.jsonObject(with: data)) ?? [String: Any]()
                reply(["ok": true, "status": 200, "data": value], nil)
            } catch {
                reply(["ok": false, "error": Self.code(for: error)], nil)
            }
        }
    }

    /// A JSON body arrives already parsed by WebKit; re-serialize without reshaping it.
    private func jsonString(_ value: Any?) -> String? {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value)
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Maps transport failures onto the same bounded codes the JS adapter already understands.
    private static func code(for error: Error) -> String {
        switch error {
        case MegaNativeHTTP.RequestError.unavailable: return "ONLINE_UNAVAILABLE"
        case MegaNativeHTTP.RequestError.unauthorized: return "AUTH_REQUIRED"
        case MegaNativeHTTP.RequestError.invalidPath, MegaNativeHTTP.RequestError.invalidMethod,
             MegaNativeHTTP.RequestError.invalidBody: return "INVALID_NATIVE_REQUEST"
        case MegaNativeHTTP.RequestError.tooLarge, MegaNativeHTTP.RequestError.responseInvalid,
             MegaNativeHTTP.RequestError.redirected: return "SERVICE_UNAVAILABLE"
        case MegaNativeHTTP.RequestError.httpFailure(let status): return "HTTP_\(status)"
        default: return "SERVICE_UNAVAILABLE"
        }
    }
}
