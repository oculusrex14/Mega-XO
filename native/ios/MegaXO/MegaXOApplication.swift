import UIKit
import os
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
            NSLog("Mega XOXO: native credential storage unavailable; offline play continues")
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
    private var themeBridge: MegaNativeThemeBridge?
    private var lanBridge: MegaNativeLanBridge?
    private var probeWork: DispatchWorkItem?
    private var identityBridge: MegaIOSIdentityBridge?
    private var apiBridge: MegaIOSApiBridge?
    private var nativeSession: MegaNativeSession?
    private var ads: MegaIOSAds?
    private var adsBridge: MegaAdsBridge?

    /// The last theme the signed page announced, so the status bar style survives a re-query from
    /// the system. Light surfaces take dark status bar glyphs and vice versa.
    private var darkSurface = false

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return darkSurface ? .lightContent : .darkContent
    }

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
        // System-bar theming for the same one signed entry file, main frame only. It carries a
        // colour and a darkness flag, never identity, credential or transport data.
        let themeBridge = MegaNativeThemeBridge(controller: self, entry: entry)
        self.themeBridge = themeBridge
        configuration.userContentController.addScriptMessageHandler(
            themeBridge, contentWorld: .page, name: "megaNativeTheme")
        configuration.userContentController.addUserScript(
            WKUserScript(source: MegaNativeThemeBridge.bootstrap,
                         injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // V5.1 same-Wi-Fi room transport. The synchronous half (start/stop/status/advertise) rides
        // `window.prompt`, which the UI delegate below answers only for this bridge's prefix and
        // only from the exact signed entry document; the Promise half (`browse`) rides the reply
        // channel like every other typed handler. It carries no credential and no actor id.
        let lanBridge = MegaNativeLanBridge(entry: entry)
        self.lanBridge = lanBridge
        configuration.userContentController.addScriptMessageHandler(
            lanBridge, contentWorld: .page, name: "megaLanDiscovery")
        configuration.userContentController.addUserScript(
            WKUserScript(source: MegaNativeLanBridge.bootstrap,
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
        // P20-03 ONLINE TARGET (iOS parity). Installed only when the built app names an approved
        // HTTPS API origin; the WebView keeps its blanket https? block either way, so only the
        // native shell can reach the API, and only through the typed bridge above.
        let apiOrigin = (Bundle.main.object(forInfoDictionaryKey: "MegaApiOrigin") as? String) ?? ""
        if !apiOrigin.isEmpty {
            let http = MegaNativeHTTP(apiOrigin: apiOrigin)
            let vault = MegaNativeSecretVault()
            let session = MegaNativeSession(vault: vault, http: http)
            nativeSession = session
            let bridge = MegaIOSApiBridge(entry: entry, http: http, session: session,
                                          apple: identityBridge)
            apiBridge = bridge
            configuration.userContentController.addScriptMessageHandler(
                bridge, contentWorld: .page, name: "megaNativeApi")
            configuration.userContentController.addUserScript(
                WKUserScript(source: MegaIOSApiBridge.bootstrap,
                             injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // P20-06 REWARDED/INTERSTITIAL ADS (iOS parity). The real GoogleMobileAds + UMP wrapper is
        // instantiated here and published to the page as `window.MegaAds`, which the shipped
        // `src/monetization-ui.js` has always called and which nothing used to define. The handler is
        // installed only when this build named an approved app id and at least one approved ad unit,
        // exactly like the api handler without an origin. Nothing here makes an ad required: `MegaAds`
        // absent simply leaves the rewards page's own optional ad actions disabled.
        let adMobAppID = (Bundle.main.object(forInfoDictionaryKey: "MegaAdMobAppID") as? String) ?? ""
        let adMobRewardedUnit = (Bundle.main.object(forInfoDictionaryKey: "MegaAdMobRewardedUnit")
                                 as? String) ?? ""
        let adMobInterstitialUnit = (Bundle.main.object(forInfoDictionaryKey: "MegaAdMobInterstitialUnit")
                                     as? String) ?? ""
        let adService = MegaIOSAds(appID: adMobAppID, rewardedUnit: adMobRewardedUnit,
                                   interstitialUnit: adMobInterstitialUnit)
        if adService.isConfigured {
            ads = adService
            let bridge = MegaAdsBridge(controller: self, entry: entry, ads: adService)
            adsBridge = bridge
            configuration.userContentController.addScriptMessageHandler(
                bridge, contentWorld: .page, name: "megaNativeAds")
            configuration.userContentController.addUserScript(
                WKUserScript(source: MegaAdsBridge.bootstrap,
                             injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.translatesAutoresizingMaskIntoConstraints = false
        // Parity with the Android host, which enables `WebView.setWebContentsDebuggingEnabled`
        // in debug builds. Without this the bundled page cannot be inspected by a developer or
        // by a device-verification harness, which is how the owner-reported defects were found
        // on Android. DEBUG only: a release build leaves it unset.
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        view.addSubview(webView)
        // The window now fills the display (UILaunchScreen), but the WebView itself stays inside the
        // safe area, exactly like the Android host: there the system insets pad the WebView, so the
        // page's content sits below the status bar and above the gesture bar, and the bar strips are
        // painted the active theme colour by MegaNativeThemeBridge.applyNativeTheme rather than
        // showing the window. Letting the WebView run edge to edge instead made page screens that
        // have no top inset (the account sheet) collide with the clock.
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor)
        ])
        game = webView
        // Diagnostics parity with the Android host's MegaNativeRenderProbe: report what the page
        // actually has once it finishes loading, so a missing primitive, or a playable-Impossible
        // entry point that should not exist, is visible in the device log instead of showing up only
        // as a feature that silently does nothing. DEBUG only.
        #if DEBUG
        probeWork = DispatchWorkItem { [weak self] in
            guard let webView = self?.game else { return }
            webView.evaluateJavaScript(
                "JSON.stringify({room:typeof window.MegaLanRoom,socket:typeof window.MegaLanSocket,"
                + "discovery:typeof window.MegaLanDiscovery,host:typeof window.MegaLanHost,"
                + "intent:localStorage.getItem('mega_lan_host_intent_v1'),"
                + "tutorial:localStorage.getItem('mega_v32_tutorial_seen'),"
                + "theme:document.documentElement.dataset.theme,"
                + "aipackEntries:document.querySelectorAll('[data-action=\"aipack\"]').length,"
                + "ads:typeof window.MegaAds,adsPlatform:window.MegaAds&&window.MegaAds.platform,"
                + "adsReady:!!(window.MegaAds&&window.MegaAds.isReady&&window.MegaAds.isReady('rewarded')),"
                + "impossibleChips:Array.from(document.querySelectorAll('.setup-chip'))"
                + ".filter(function(c){return /IMPOSSIBLE/i.test(c.textContent)}).length,"
                + "partyChoices:document.querySelectorAll('.party-choice').length,"
                + "cells:document.querySelectorAll('.cell').length})"
            ) { value, error in
                NSLog("LANPROBE page=%@ err=%@", String(describing: value), String(describing: error))
            }
        }
        if let probeWork { DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: probeWork) }
        #endif
        // The LAN bridge answers page requests on its own queues and hops to the main thread only
        // for the one synchronous `MegaLanRoom.handle` call the frozen contract requires.
        lanBridge.host = webView
        // WKNavigationDelegate only governs frame navigations, not fetch/img/script
        // subresources. Refuse all network URLs with a WebKit content-blocking
        // rule before loading any of the bundled HTML.
        let offlineRules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "MegaXOOfflineNetworkDenyV1",
            encodedContentRuleList: offlineRules
        ) { [weak self, weak webView] rule, error in
            DispatchQueue.main.async { [weak self, weak webView] in
                guard let webView, let rule, error == nil else {
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

    /// Applies one theme announcement from the signed page: the window, the WebView, and therefore
    /// every strip the safe-area constraints leave uncovered (status bar and home indicator area),
    /// plus the status bar glyph style. The page's own colours remain authoritative; this only
    /// makes the native chrome agree with them.
    func applyNativeTheme(dark: Bool, surface: UIColor) {
        // A dark game surface must not sit inside a light-appearance shell, or the system would
        // restyle the bars and any sheet the page raises behind its back.
        overrideUserInterfaceStyle = dark ? .dark : .light
        darkSurface = dark
        view.backgroundColor = surface
        game?.backgroundColor = surface
        game?.scrollView.backgroundColor = surface
        setNeedsStatusBarAppearanceUpdate()
    }

    private func showMissingBundle() {
        let label = UILabel()
        label.text = "Game assets unavailable. Reinstall Mega XOXO."
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
        let alert = UIAlertController(title: "Mega XOXO", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard trusted(frame) else { completionHandler(false); return }
        let alert = UIAlertController(title: "Mega XOXO", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Confirm", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        // The page's one synchronous page-to-host channel: `window.MegaLanSocket.start/stop/status`
        // and `MegaLanDiscovery.advertise/stop` are synchronous in the frozen contract, so
        // `src/lan/lan-host.js` cannot await them. Only this bridge's own prefix is answered, only
        // from the exact signed entry document; every other prompt keeps the previous nil answer.
        if let reply = lanBridge?.handlePrompt(prompt, frame: frame) {
            completionHandler(reply)
            return
        }
        completionHandler(nil)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Disallow new WebViews and popups, especially untrusted OAuth/content pages.
        return nil
    }
}
