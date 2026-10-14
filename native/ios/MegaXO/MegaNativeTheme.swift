import Foundation
import UIKit
import WebKit

/// V5.1 theme-aware system bars for the signed game entry.
///
/// The page calls `window.MegaNativeTheme.apply({theme, dark, surface})` from its own theme
/// application. This handler paints the window and the WebView with the active theme's surface
/// colour, so the strips outside the WebView's safe-area constraints - the status bar and the home
/// indicator area - match the game instead of the fixed light grey they start with, and it tracks
/// the status bar style from the theme's darkness.
///
/// The payload is a colour and a darkness flag and nothing else: no identity, credential, actor or
/// transport value crosses here, so the handler cannot leak anything and adds no reachability.
///
/// Authority matches the notification/identity/api handlers in this target: the message must be a
/// main-frame message whose document is exactly the signed entry file, and the injected shim is
/// main-frame only.
@MainActor
final class MegaNativeThemeBridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var controller: MegaXOGameController?
    private let trustedEntry: URL

    private static let themes: Set<String> = ["vector", "midnight", "paperclub", "afterhours"]

    init(controller: MegaXOGameController, entry: URL) {
        self.controller = controller
        self.trustedEntry = entry.standardizedFileURL.resolvingSymlinksInPath()
        super.init()
    }

    /// The one field grammar this bridge accepts, shared with the Android host: a six digit hex CSS
    /// colour. Anything else is dropped before it can be turned into a UIKit colour.
    static func colour(_ value: String) -> UIColor? {
        guard value.count == 7, value.hasPrefix("#") else { return nil }
        let hex = value.dropFirst()
        guard hex.allSatisfy({ $0.isHexDigit }), let rgb = UInt32(hex, radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1)
    }

    static let bootstrap = #"""
    (() => {
      if (window.top !== window || window.MegaNativeTheme) return;
      const channel = window.webkit?.messageHandlers?.megaNativeTheme;
      if (!channel || typeof channel.postMessage !== 'function') return;
      const hex = '0123456789abcdefABCDEF';
      const themes = ['vector', 'midnight', 'paperclub', 'afterhours'];
      const isSurface = value => typeof value === 'string' && value.length === 7 &&
        value.charAt(0) === '#' &&
        value.slice(1).split('').every(digit => hex.indexOf(digit) >= 0);
      Object.defineProperty(window, 'MegaNativeTheme', {
        configurable: false, enumerable: false,
        value: Object.freeze({
          apply: ({theme, dark, surface} = {}) => {
            if (typeof dark !== 'boolean' ||
                themes.indexOf(theme) < 0 || !isSurface(surface)) return;
            try { channel.postMessage({theme, dark, surface}); }
            catch (_) {}
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
        // The page ignores the reply; always settle it so postMessage never hangs a caller.
        defer { replyHandler(nil, nil) }
        guard message.name == "megaNativeTheme",
              message.frameInfo.isMainFrame,
              let page = message.frameInfo.request.url,
              page.isFileURL,
              page.standardizedFileURL.resolvingSymlinksInPath() == trustedEntry,
              let body = message.body as? [String: Any],
              let theme = body["theme"] as? String, Self.themes.contains(theme),
              let dark = body["dark"] as? Bool,
              let surface = body["surface"] as? String,
              let colour = Self.colour(surface) else { return }
        controller?.applyNativeTheme(dark: dark, surface: colour)
    }
}
