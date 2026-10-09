import UIKit
import WebKit

@main
final class MegaXOApplication: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(
            name: "Default Configuration", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = MegaXOSceneDelegate.self
        return configuration
    }
}

final class MegaXOSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        // Fresh reinstall must not resurrect an old Keychain refresh credential.
        // Not an active login path: credentials are issued only by future P05 APIs.
        do { try MegaNativeSecretVault().clearForFreshInstallIfRequired() }
        catch {
            // A simulator, protected-data lock or temporarily unavailable
            // Keychain must not crash the offline game. Native sign-in remains
            // unavailable until a verified P05 exchange can use secure storage.
            // Never log raw credentials or the Keychain error's private context.
            NSLog("Mega XO: native credential storage unavailable; offline play continues")
        }
        window.rootViewController = MegaXOGameController()
        window.makeKeyAndVisible()
        self.window = window
    }
}

/**
 * P20-02 signed-bundle host. It does NOT load megaxo.online (deferred website),
 * install a broad WKScriptMessageHandler, or fabricate online sessions/store grants.
 * Approved game HTML/CSS/JS stays unchanged inside the app's copied MegaClient folder.
 */
final class MegaXOGameController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var game: WKWebView?
    private var clientRoot: URL?
    private var nativeNotifications: MegaLocalNotifications?
    private var identityBridge: MegaIOSIdentityBridge?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 247 / 255, green: 249 / 255, blue: 252 / 255, alpha: 1)
        guard let root = Bundle.main.resourceURL?.appendingPathComponent(
            "MegaClient", isDirectory: true) else {
            showMissingBundle()
            return
        }
        let entry = root.appendingPathComponent("bundle-index.html", isDirectory: false)
        guard FileManager.default.fileExists(atPath: entry.path) else {
            showMissingBundle()
            return
        }
        clientRoot = root.standardizedFileURL.resolvingSymlinksInPath()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        // The message receiver checks main-frame identity and the exact
        // signed entry file; no other bundled legal or nested frame can send.
        let notifications = MegaLocalNotifications(entry: entry)
        nativeNotifications = notifications
        configuration.userContentController.addScriptMessageHandler(
            notifications, contentWorld: .page, name: "megaNativeNotifications")
        configuration.userContentController.addUserScript(
            WKUserScript(source: MegaLocalNotifications.bootstrap,
                         injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Real native Apple sign-in must use the registered bundle/entitlement.
        // Default is disabled until authorized App ID and P05 API handshake.
        let appleEnabled = (Bundle.main.object(forInfoDictionaryKey: "MegaAppleNativeEnabled")
                            as? String)?.uppercased() == "YES"
        if appleEnabled {
            let bridge = MegaIOSIdentityBridge(controller: self, entry: entry)
            identityBridge = bridge
            configuration.userContentController.addScriptMessageHandler(
                bridge, contentWorld: .page, name: "megaNativeIdentity")
            configuration.userContentController.addUserScript(
                WKUserScript(source: MegaIOSIdentityBridge.bootstrap,
                             injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor)
        ])
        game = webView
        // WKNavigationDelegate only governs frame navigations, not fetch/img/script
        // subresources. Refuse all network URLs with a WebKit content-blocking
        // rule before loading any of the bundled HTML.
        let offlineRules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "MegaXOOfflineNetworkDenyV1",
            encodedContentRuleList: offlineRules
        ) { [weak self, weak webView] rule, error in
            DispatchQueue.main.async {
                guard let self, let webView, let rule, error == nil else {
                    // Fail closed: a rules compilation failure cannot turn the
                    // signed offline game into a remote-content browser.
                    self?.showMissingBundle()
                    return
                }
                webView.configuration.userContentController.add(rule)
                webView.loadFileURL(entry, allowingReadAccessTo: root)
            }
        }
    }

    private func showMissingBundle() {
        let label = UILabel()
        label.text = "Game assets unavailable. Reinstall Mega XO."
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24)
        ])
    }

    private func trusted(_ url: URL?) -> Bool {
        guard let url = url, url.isFileURL, let root = clientRoot else { return false }
        let normalized = url.standardizedFileURL.resolvingSymlinksInPath().path
        return normalized.hasPrefix(root.path + "/")
    }

    private func trusted(_ frame: WKFrameInfo) -> Bool {
        return frame.isMainFrame && trusted(frame.request.url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if trusted(url) {
            decisionHandler(.allow)
            return
        }
        if url?.scheme == "about" && url?.absoluteString == "about:blank" {
            decisionHandler(.allow)
            return
        }
        // Only a deliberate top-level HTTPS link may leave the trusted bundle.
        if navigationAction.navigationType == .linkActivated,
           navigationAction.targetFrame?.isMainFrame == true,
           let url = url, url.scheme == "https" {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // Prevent redirects or responses from changing the main-frame trust origin.
        if navigationResponse.isForMainFrame && !trusted(navigationResponse.response.url) {
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard trusted(frame) else { completionHandler(); return }
        let alert = UIAlertController(title: "Mega XO", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard trusted(frame) else { completionHandler(false); return }
        let alert = UIAlertController(title: "Mega XO", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Confirm", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        // The approved client currently does not require arbitrary JS prompts.
        completionHandler(nil)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Disallow new WebViews and popups, especially untrusted OAuth/content pages.
        return nil
    }
}
