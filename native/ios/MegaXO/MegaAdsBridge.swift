import Foundation
import UIKit
import WebKit

/// P20-06 typed, origin-pinned page surface for the real Google Mobile Ads SDK - the iOS parity of
/// Android's `MegaAdsBridge`.
///
/// This is the publisher of `window.MegaAds`, which `src/monetization-ui.js` has always called and
/// which nothing used to define, so every ad path in the signed game silently no-opped. It follows
/// the identity/theme/api handlers in this target exactly: the handler is main-frame only and its
/// document must be exactly the signed entry file, with the injected shim main-frame only.
///
/// The published surface, and nothing else:
///
///   window.MegaAds.platform                       -> 'ios'
///   window.MegaAds.privacyState()                -> {canRequestAds, privacyOptionsRequired}
///   window.MegaAds.isReady(kind)                 -> boolean
///   window.MegaAds.prepare(kind)                 -> Promise<boolean>
///   window.MegaAds.privacyOptions()              -> Promise<boolean>
///   window.MegaAds.showRewarded(ticket)          -> Promise<{earned, outcome, shown}>
///   window.MegaAds.showInterstitial(permit)      -> Promise<{shown}>
///   window.MegaAds.reportAd()                    -> Promise<{ok}>
///
/// `showRewarded` settles positively **only** on the SDK's earned-reward handler. It rejects on
/// show-only, dismissal, failure, timeout and every malformed caller. There is no parameter that can
/// make it grant: the only inputs are Core-issued ticket values, which are re-validated in Swift
/// against this build's configured ad unit, and the reward item/amount is checked against an
/// allowlist. A page-supplied `watched: true` is never read, and no argument reaches the earned
/// handler.
///
/// The capability state is returned on every reply as a `state` field and applied by the shim before
/// the caller's continuation resumes, so the page's own synchronous `privacyState()`/`isReady()`
/// checks right after an `await` are never stale. Consent is never claimed before UMP has answered.
///
/// Two identifiers are never trusted from the page: the ad unit (it must be the one this build
/// configured, and for a presentation the one Core itself issued the ticket/permit for) and the
/// actor. No actor id, token, ticket or ad unit is ever logged.
@MainActor
final class MegaAdsBridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var controller: MegaXOGameController?
    private let trustedEntry: URL
    private let ads: MegaIOSAds
    private var closed = false

    init(controller: MegaXOGameController, entry: URL, ads: MegaIOSAds) {
        self.controller = controller
        trustedEntry = entry.standardizedFileURL.resolvingSymlinksInPath()
        self.ads = ads
        super.init()
    }

    static let bootstrap = #"""
    (() => {
      if (window.top !== window || window.MegaAds) return;
      const bridge = window.webkit?.messageHandlers?.megaNativeAds;
      if (!bridge || typeof bridge.postMessage !== 'function') return;
      let state = {canRequestAds: false, privacyOptionsRequired: false, ready: {}};
      const call = (op, fields, validate) => {
        if (!validate()) return Promise.reject(new Error('ADS_UNAVAILABLE'));
        return bridge.postMessage({op, ...fields}).then(result => {
          if (result && result.state && typeof result.state === 'object') state = result.state;
          if (result && result.ok === true) return result;
          throw new Error(typeof result?.error === 'string' ? result.error : 'ADS_UNAVAILABLE');
        });
      };
      const text = (value, max) => typeof value === 'string' &&
        value.length > 0 && value.length <= max;
      const isTicket = value => !!value && typeof value === 'object' &&
        text(value.ticket, 200) && text(value.actor, 200) &&
        text(value.adUnit, 200) && text(value.rewardItem, 200) &&
        Number.isInteger(value.rewardAmount) && value.rewardAmount > 0 &&
        Number.isSafeInteger(value.expires) && value.expires > 0;
      const isPermit = value => !!value && typeof value === 'object' &&
        value.allowed === true && text(value.adUnit, 200) &&
        Number.isSafeInteger(value.expires) && value.expires > 0;
      Object.defineProperty(window, 'MegaAds', {
        configurable: false, enumerable: false,
        value: Object.freeze({
          platform: 'ios',
          privacyState: () => ({
            canRequestAds: state.canRequestAds === true,
            privacyOptionsRequired: state.privacyOptionsRequired === true
          }),
          isReady: kind => !!(state.ready && state.ready[kind] === true),
          prepare: kind => call('prepare', {kind},
            () => kind === 'rewarded' || kind === 'interstitial'),
          privacyOptions: () => call('privacyOptions', {}, () => true),
          showRewarded: ticket => call('showRewarded', {ticket}, () => isTicket(ticket)),
          showInterstitial: permit => call('showInterstitial', {permit}, () => isPermit(permit)),
          reportAd: () => call('report', {}, () => true)
        })
      });
    })();
    """#

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        // The exact signed entry document, main frame only, is the whole authority - exactly like the
        // other handlers in this target. An untrusted caller gets a bounded refusal and no action.
        guard !closed, message.name == "megaNativeAds",
              message.frameInfo.isMainFrame,
              let page = message.frameInfo.request.url,
              page.isFileURL,
              page.standardizedFileURL.resolvingSymlinksInPath() == trustedEntry,
              let body = message.body as? [String: Any],
              let op = body["op"] as? String
        else {
            replyHandler(["ok": false, "error": "ADS_UNTRUSTED_FRAME"], nil)
            return
        }
        switch op {
        case "prepare": prepare(body, replyHandler)
        case "privacyOptions": privacyOptions(replyHandler)
        case "showRewarded": showRewarded(body, replyHandler)
        case "showInterstitial": showInterstitial(body, replyHandler)
        case "report": report(replyHandler)
        default: replyHandler(["ok": false, "error": "ADS_UNSUPPORTED"], nil)
        }
    }

    /// Everything the page may know about ad availability right now. Consent is only ever true after
    /// UMP answered, and each ready flag only after that format's SDK state allows it.
    private func state() -> [String: Any] {
        let available = !closed
        return [
            "canRequestAds": available && ads.canRequestAds,
            "privacyOptionsRequired": available && ads.privacyOptionsRequired,
            "ready": [
                "rewarded": available && ads.isReady("rewarded"),
                "interstitial": available && ads.isReady("interstitial")
            ]
        ]
    }

    private func reply(_ handler: @escaping (Any?, String?) -> Void, _ payload: [String: Any]) {
        var out = payload
        out["state"] = state()
        handler(out, nil)
    }

    private func fail(_ handler: @escaping (Any?, String?) -> Void, _ code: String) {
        reply(handler, ["ok": false, "error": code])
    }

    /// Brings the SDK to the point where a format can be loaded: ask UMP, then initialise only with
    /// consent. `false` means "not available", never "try anyway".
    private func withConsentAndSDK(_ done: @escaping (Bool) -> Void) {
        let step: () -> Void = { [weak self] in
            guard let self, !self.closed, self.ads.canRequestAds else { done(false); return }
            self.ads.initializeIfAllowed()
            done(self.ads.canRequestAds && self.ads.isInitialized)
        }
        if ads.consentUpdated {
            step()
            return
        }
        guard let controller else { done(false); return }
        Task { @MainActor in
            _ = await self.ads.gatherConsent(from: controller)
            step()
        }
    }

    private func prepare(_ body: [String: Any], _ handler: @escaping (Any?, String?) -> Void) {
        let kind = body["kind"] as? String ?? ""
        guard kind == "rewarded" || kind == "interstitial" else {
            fail(handler, "ADS_INVALID_KIND"); return
        }
        withConsentAndSDK { [weak self] available in
            guard let self, available else {
                self?.reply(handler, ["ok": false, "error": "ADS_UNAVAILABLE"]); return
            }
            Task { @MainActor in
                let loaded = await self.ads.prepare(kind)
                self.reply(handler, [
                    "ok": loaded,
                    "kind": kind,
                    "error": loaded ? NSNull() : "AD_LOAD_FAILED",
                    "ready": self.ads.isReady(kind)
                ])
            }
        }
    }

    /// Presents the UMP privacy form. Consent information is requested first when this launch has not
    /// asked yet, so the page's one "Ad privacy options" action works on a fresh install too; the form
    /// itself is only shown where the provider says it is required.
    private func privacyOptions(_ handler: @escaping (Any?, String?) -> Void) {
        let step: () -> Void = { [weak self] in
            guard let self, !self.closed, self.ads.canRequestAds else {
                self?.fail(handler, "ADS_CONSENT_NOT_GRANTED"); return
            }
            guard let controller = self.controller else { self.fail(handler, "ADS_UNAVAILABLE"); return }
            Task { @MainActor in
                let shown = await self.ads.showPrivacyOptions(from: controller)
                self.reply(handler, [
                    "ok": shown,
                    "error": shown ? NSNull() : "ADS_PRIVACY_OPTIONS_UNAVAILABLE"
                ])
            }
        }
        if ads.consentUpdated {
            step()
            return
        }
        guard let controller else { fail(handler, "ADS_UNAVAILABLE"); return }
        Task { @MainActor in
            _ = await self.ads.gatherConsent(from: controller)
            step()
        }
    }

    /// Presents one Core-issued rewarded ticket. Every value comes from the server's ticket response
    /// and is re-checked here; the page's only role is to hand the object over unchanged.
    private func showRewarded(_ body: [String: Any], _ handler: @escaping (Any?, String?) -> Void) {
        guard let ticket = body["ticket"] as? [String: Any] else {
            reply(handler, ["ok": false, "granted": false, "error": "ADS_INVALID_TICKET"]); return
        }
        let issued = ticket["ticket"] as? String ?? ""
        let actor = ticket["actor"] as? String ?? ""
        let unit = ticket["adUnit"] as? String ?? ""
        let item = ticket["rewardItem"] as? String ?? ""
        let amount = ticket["rewardAmount"] as? Int ?? -1
        let expires = (ticket["expires"] as? NSNumber)?.int64Value ?? 0
        let platform = ticket["platform"] as? String ?? ""
        guard issued.count >= 16, issued.count <= 200,
              issued.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }),
              !actor.isEmpty, actor.count <= 200,
              unit == ads.rewardedUnitID, platform == "ios",
              !item.isEmpty, amount > 0, expires > 0
        else {
            // Core's own fields failed this build's checks: nothing is presented and nothing is
            // granted, whatever the caller claimed.
            reply(handler, ["ok": false, "granted": false, "error": "ADS_INVALID_TICKET"]); return
        }
        guard let controller else {
            reply(handler, ["ok": false, "granted": false, "error": "ADS_UNAVAILABLE"]); return
        }
        ads.showRewarded(
            from: controller, platform: platform, adUnit: unit, actor: actor, ticket: issued,
            rewardItem: item, rewardAmount: amount, expiresAtMilliseconds: expires
        ) { [weak self] result in
            guard let self else { return }
            let earned = result.outcome == .earned
            self.reply(handler, [
                "ok": earned,
                "granted": earned,
                "earned": earned,
                "shown": result.shown,
                "outcome": result.outcome.rawValue,
                "error": earned ? NSNull() : "AD_NOT_EARNED"
            ])
        }
    }

    /// Presents one Core-issued automatic permit, on the exact unit Core authorised.
    private func showInterstitial(_ body: [String: Any], _ handler: @escaping (Any?, String?) -> Void) {
        let permit = body["permit"] as? [String: Any]
        let allowed = permit?["allowed"] as? Bool ?? false
        let unit = permit?["adUnit"] as? String ?? ""
        let expires = (permit?["expires"] as? NSNumber)?.int64Value ?? 0
        let platform = permit?["platform"] as? String ?? ""
        guard allowed, unit == ads.interstitialUnitID, platform == "ios", expires > 0,
              let controller
        else {
            reply(handler, ["ok": false, "shown": false, "error": "ADS_INVALID_PERMIT"]); return
        }
        ads.showInterstitial(
            from: controller, platform: platform, adUnit: unit,
            serverPermitAllowed: allowed, expiresAtMilliseconds: expires
        ) { [weak self] shown in
            guard let self else { return }
            self.reply(handler, [
                "ok": shown,
                "shown": shown,
                "error": shown ? NSNull() : "AD_NOT_SHOWN"
            ])
        }
    }

    /// "Report an ad". This app has no server-side ad-complaint route, so nothing is fabricated here:
    /// the one real, SDK-owned capability is Ad Inspector, which reports the last ad's unit, fill and
    /// errors on a registered test device. It is unavailable in a normal consumer install, and that is
    /// reported as a clean failure rather than as a silent success.
    private func report(_ handler: @escaping (Any?, String?) -> Void) {
        guard !closed, ads.isInitialized, let controller else {
            reply(handler, ["ok": false, "error": "ADS_UNAVAILABLE"]); return
        }
        ads.presentAdInspector(from: controller) { [weak self] ok in
            guard let self else { return }
            self.reply(handler, [
                "ok": ok,
                "error": ok ? NSNull() : "ADS_REPORT_UNAVAILABLE"
            ])
        }
    }

    func close() {
        closed = true
    }
}
