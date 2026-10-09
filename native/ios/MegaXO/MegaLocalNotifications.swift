import Foundation
import UserNotifications
import WebKit

/// P20-03: existing player-opt-in *local* alerts only. No APNs token,
/// account binding, new notification campaign or unsolicited permission prompt.
@MainActor
final class MegaLocalNotifications: NSObject, WKScriptMessageHandlerWithReply {
    private let entry: URL
    private let center = UNUserNotificationCenter.current()

    init(entry: URL) {
        self.entry = entry.standardizedFileURL.resolvingSymlinksInPath()
        super.init()
    }

    static let bootstrap = #"""
    (() => {
      if (window.top !== window || window.MegaNativeNotifications) return;
      const handler = window.webkit?.messageHandlers?.megaNativeNotifications;
      if (!handler || typeof handler.postMessage !== 'function') return;
      const send = async (value) => {
        try { return (await handler.postMessage(value)) === true; }
        catch (_) { return false; }
      };
      Object.defineProperty(window, 'MegaNativeNotifications', {
        configurable: false, enumerable: false,
        value: Object.freeze({
          requestPermission: () => send({op: 'permission'}),
          notify: ({title, body, tag} = {}) => send({op: 'notify', title, body, tag})
        })
      });
    })();
    """#

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.name == "megaNativeNotifications",
              message.frameInfo.isMainFrame,
              let page = message.frameInfo.request.url,
              page.isFileURL,
              page.standardizedFileURL.resolvingSymlinksInPath() == entry,
              let body = message.body as? [String: Any],
              let operation = body["op"] as? String else {
            replyHandler(false, nil)
            return
        }

        switch operation {
        case "permission":
            // Called only through the player's existing notification setting.
            center.requestAuthorization(options: [.alert, .badge, .sound]) { allowed, error in
                DispatchQueue.main.async { replyHandler(error == nil && allowed, nil) }
            }
        case "notify":
            guard UIApplication.shared.applicationState != .active,
                  let title = body["title"] as? String, !title.isEmpty,
                  title.count <= 120,
                  let text = body["body"] as? String, !text.isEmpty,
                  text.count <= 280,
                  let tag = body["tag"] as? String, !tag.isEmpty,
                  tag.count <= 128 else {
                replyHandler(false, nil)
                return
            }
            center.getNotificationSettings { settings in
                let approved = settings.authorizationStatus == .authorized ||
                               settings.authorizationStatus == .provisional
                guard approved else {
                    DispatchQueue.main.async { replyHandler(false, nil) }
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = text
                content.sound = .default
                let notification = UNNotificationRequest(
                    identifier: "mega.local." + tag,
                    content: content,
                    trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false))
                self.center.add(notification) { error in
                    DispatchQueue.main.async { replyHandler(error == nil, nil) }
                }
            }
        default:
            replyHandler(false, nil)
        }
    }
}
