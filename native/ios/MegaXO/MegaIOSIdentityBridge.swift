import AuthenticationServices
import Foundation
import UIKit
import WebKit

/// P20-04: actual Sign in with Apple SDK UI behind an explicit app-build
/// capability switch, serving only the signed client main frame.
/// The resulting ID token is *evidence* for native/challenge + native/finish.
/// The backend must verify nonce, account linking, audience and actor state.
@MainActor
final class MegaIOSIdentityBridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var presentingController: UIViewController?
    private let trustedEntry: URL
    private let apple = MegaAppleIdentity()

    init(controller: UIViewController, entry: URL) {
        presentingController = controller
        trustedEntry = entry.standardizedFileURL.resolvingSymlinksInPath()
        super.init()
    }

    static let bootstrap = #"""
    (() => {
      if (window.top !== window || window.MegaNativeIdentity) return;
      const bridge = window.webkit?.messageHandlers?.megaNativeIdentity;
      if (!bridge || typeof bridge.postMessage !== 'function') return;
      Object.defineProperty(window, 'MegaNativeIdentity', {
        configurable: false, enumerable: false,
        value: Object.freeze({
          getCredential: async ({provider, nonce} = {}) => {
            if (provider !== 'apple' || typeof nonce !== 'string' ||
                nonce.length < 16 || nonce.length > 256)
              throw new Error('NATIVE_IDENTITY_UNAVAILABLE');
            return await bridge.postMessage({op:'credential', provider, nonce});
          }
        })
      });
    })();
    """#

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.name == "megaNativeIdentity",
              message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url,
              url.isFileURL,
              url.standardizedFileURL.resolvingSymlinksInPath() == trustedEntry,
              let body = message.body as? [String: Any],
              body["op"] as? String == "credential",
              body["provider"] as? String == "apple",
              let nonce = body["nonce"] as? String,
              nonce.count >= 16, nonce.count <= 256,
              nonce.unicodeScalars.allSatisfy({
                  $0.value >= 33 && $0.value <= 126 && $0.value != 92
              }),
              let window = presentingController?.view.window else {
            replyHandler(nil, "NATIVE_IDENTITY_UNAVAILABLE")
            return
        }

        apple.getCredential(nonce: nonce, window: window) { result in
            switch result {
            case .success(let token):
                guard token.utf8.count >= 24 && token.utf8.count <= 12000 else {
                    replyHandler(nil, "NATIVE_SIGNIN_FAILED")
                    return
                }
                replyHandler(["idToken": token], nil)
            case .failure:
                // Never leak SDK internals, email/profile data or credentials
                // into JavaScript errors. User cancellation is not a login.
                replyHandler(nil, "NATIVE_SIGNIN_FAILED")
            }
        }
    }
}
