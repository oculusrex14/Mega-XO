import Foundation
import GoogleMobileAds
import UIKit
import UserMessagingPlatform

/// The one terminal truth of a rewarded presentation. Only `earned` may ever be read as a reward,
/// and nothing but the SDK's own `userDidEarnRewardHandler` can produce it.
enum AdRewardOutcome: String {
    case earned = "EARNED"
    case dismissed = "DISMISSED"
    case failed = "FAILED"
    case timedOut = "TIMEOUT"
    case unavailable = "UNAVAILABLE"
}

/// The outcome plus whether any full-screen content was actually shown. `shown` alone is worth
/// nothing.
struct AdRewardResult {
    let outcome: AdRewardOutcome
    let shown: Bool
}

/// An AdMob application id: the exact public grammar, so a placeholder can never be initialised.
private let adAppIDPattern = try! NSRegularExpression(pattern: "^ca-app-pub-[0-9]{16}~[0-9]{10}$")

/// An AdMob ad unit id: the exact public grammar the backend already enforces.
private let adUnitPattern = try! NSRegularExpression(pattern: "^ca-app-pub-[0-9]{16}/[0-9]{10}$")

private func matches(_ pattern: NSRegularExpression, _ value: String) -> Bool {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return pattern.firstMatch(in: value, range: range) != nil
}

/// A rewarded ad that has neither earned nor dismissed inside this window settles as a timeout, so
/// no presentation can leave a grant open forever.
private let presentTimeoutSeconds: UInt64 = 10 * 60

/// The earned callback precedes dismissal in the SDK's own ordering. This grace only covers the
/// reverse delivery order; it can turn a pending dismissal into an earned result the SDK really
/// reported, and it can never invent one.
private let dismissGraceSeconds: UInt64 = 1

/// An interstitial that has not appeared within this window was not shown and reports so.
private let interstitialTimeoutSeconds: UInt64 = 30

/// P20-06 GoogleMobileAds + UMP, now instantiated by the signed host (`MegaXOApplication.swift`) and
/// published to the page through `MegaAdsBridge`.
///
/// Two facts are kept strictly apart here, which is the whole point of the class:
///
///  - **shown** is a presentation fact, read from `FullScreenContentDelegate`. Worth nothing alone.
///  - **earned** is the SDK's `userDidEarnRewardHandler`. Only that callback completes a rewarded
///    presentation positively. A show, a dismissal, a show failure, a malformed caller and the
///    watchdog all complete negatively.
///
/// Nothing a caller passes can produce `earned`: `showRewarded` does not return a result, and a field
/// such as `watched: true` is never read at all. Even `earned` is only local evidence that the ad was
/// watched. Cosmetic Credits stay server-side: the ticket is issued and bound by Core, and only
/// AdMob's signed server-to-server verification may settle it.
@MainActor
final class MegaIOSAds: NSObject, FullScreenContentDelegate {
    // A malformed or missing identifier is unavailability, never a default and never a crash: every
    // path below re-reads these nullable values and fails closed on nil.
    private let appID: String?
    private let rewardedUnit: String?
    private let interstitialUnit: String?
    private var updatedConsent = false
    private var initialized = false
    private var rewarded: RewardedAd?
    private var interstitial: InterstitialAd?

    private var pendingReward: RewardSettlement?
    private var pendingShow: ShowSettlement?

    /// The ad object of the presentation in flight, so delegate events are matched to it by identity.
    private var activePresentedAd: FullScreenPresentingAd?

    init(appID: String?, rewardedUnit: String?, interstitialUnit: String?) {
        self.appID = appID.flatMap { value in
            value.isEmpty || !matches(adAppIDPattern, value) ? nil : value
        }
        self.rewardedUnit = rewardedUnit.flatMap { value in
            value.isEmpty || !matches(adUnitPattern, value) ? nil : value
        }
        self.interstitialUnit = interstitialUnit.flatMap { value in
            value.isEmpty || !matches(adUnitPattern, value) ? nil : value
        }
        super.init()
    }

    /// True when this build named real ids at all; a false here publishes no bridge.
    var isConfigured: Bool {
        appID != nil && (rewardedUnit != nil || interstitialUnit != nil)
    }

    /// The two ad units this build actually compiled, and nothing else. The bridge answers a Core
    /// ticket/permit for no other unit, so a caller cannot retarget a presentation.
    var rewardedUnitID: String? { rewardedUnit }
    var interstitialUnitID: String? { interstitialUnit }
    var isInitialized: Bool { initialized }
    var consentUpdated: Bool { updatedConsent }

    func gatherConsent(from controller: UIViewController) async -> Bool {
        guard appID != nil else { return false }
        do {
            try await ConsentInformation.shared.requestConsentInfoUpdate(
                with: RequestParameters())
            updatedConsent = true
            try await ConsentForm.loadAndPresentIfRequired(from: controller)
            return canRequestAds
        } catch {
            // Keep ads unavailable when the consent flow is not usable.
            return false
        }
    }

    var canRequestAds: Bool {
        updatedConsent && ConsentInformation.shared.canRequestAds
    }

    var privacyOptionsRequired: Bool {
        updatedConsent &&
          ConsentInformation.shared.privacyOptionsRequirementStatus == .required
    }

    func showPrivacyOptions(from controller: UIViewController) async -> Bool {
        guard updatedConsent, canRequestAds else { return false }
        do {
            try await ConsentForm.presentPrivacyOptionsForm(from: controller)
            return true
        } catch { return false }
    }

    func initializeIfAllowed() {
        guard appID != nil, canRequestAds, !initialized else { return }
        MobileAds.shared.start()
        initialized = true
    }

    func prepare(_ kind: String) async -> Bool {
        guard initialized, canRequestAds else { return false }
        switch kind {
        case "rewarded":
            guard let id = rewardedUnit else { return false }
            do {
                rewarded = try await RewardedAd.load(with: id, request: Request())
            } catch {
                // A failed load leaves no ad behind, or `isReady` would report a stale one.
                rewarded = nil
                return false
            }
            return canRequestAds
        case "interstitial":
            guard let id = interstitialUnit else { return false }
            do {
                interstitial = try await InterstitialAd.load(with: id, request: Request())
            } catch {
                interstitial = nil
                return false
            }
            return canRequestAds
        default: return false
        }
    }

    func isReady(_ kind: String) -> Bool {
        guard canRequestAds && initialized else { return false }
        switch kind {
        case "rewarded": return rewarded != nil
        case "interstitial": return interstitial != nil
        default: return false
        }
    }

    /// Presents one already-loaded rewarded ad and reports the SDK's own terminal outcome.
    ///
    /// Ticket values are issued and bound by Core, not by the JS caller, so every one of them is
    /// re-checked here against this build's configuration before anything is presented. The reward
    /// item/amount pair must be one of `Self.rewardAllowlist`; anything else is a caller error and is
    /// refused rather than presented.
    func showRewarded(
        from controller: UIViewController, platform: String, adUnit: String,
        actor: String, ticket: String, rewardItem: String, rewardAmount: Int,
        expiresAtMilliseconds: Int64, done: @escaping (AdRewardResult) -> Void
    ) {
        guard platform == "ios", adUnit == rewardedUnit,
              !actor.isEmpty, actor.count <= 200,
              !ticket.isEmpty, ticket.count <= 200,
              Self.rewardAllowlist[rewardItem] == rewardAmount,
              Int64(Date().timeIntervalSince1970 * 1000) < expiresAtMilliseconds,
              isReady("rewarded"), let ad = rewarded else {
            done(AdRewardResult(outcome: .unavailable, shown: false))
            return
        }
        // A loaded ad is single use: it is consumed here whether or not it is earned, so one
        // presentation can never be replayed for a second grant.
        rewarded = nil
        let options = ServerSideVerificationOptions()
        options.userIdentifier = actor
        options.customRewardText = ticket
        ad.serverSideVerificationOptions = options
        let settlement = RewardSettlement(done)
        pendingReward = settlement
        activePresentedAd = ad
        ad.fullScreenContentDelegate = self
        settlement.arm()
        // The local earned handler carries no credit, account, balance or persistence side effect. It
        // is the only writer of `.earned`, and it is the SDK's own reward signal - not this method
        // returning and not any value the page sent.
        ad.present(from: controller, userDidEarnRewardHandler: { settlement.earn() })
    }

    /// Presents an already-loaded interstitial. An interstitial has no reward and no earned callback,
    /// so `shown` here means the SDK reported the full-screen content as displayed, not that a
    /// `present` call was accepted.
    func showInterstitial(
        from controller: UIViewController, platform: String, adUnit: String,
        serverPermitAllowed: Bool, expiresAtMilliseconds: Int64,
        done: @escaping (Bool) -> Void
    ) {
        guard platform == "ios", adUnit == interstitialUnit,
              serverPermitAllowed,
              Int64(Date().timeIntervalSince1970 * 1000) < expiresAtMilliseconds,
              isReady("interstitial"), let ad = interstitial else {
            done(false)
            return
        }
        // Actual placement/cooldowns are checked by the approved JS/server rules before the native
        // bridge calls this gated method; one loaded ad serves exactly one presentation.
        interstitial = nil
        let settlement = ShowSettlement(done)
        pendingShow = settlement
        activePresentedAd = ad
        ad.fullScreenContentDelegate = self
        settlement.arm()
        ad.present(from: controller)
    }

    /// Presents the SDK's own Ad Inspector: the one real, SDK-owned ad-reporting capability. It is
    /// unavailable in a normal consumer install, and that is reported as a clean failure.
    func presentAdInspector(from controller: UIViewController, done: @escaping (Bool) -> Void) {
        guard initialized else { done(false); return }
        MobileAds.shared.presentAdInspector(from: controller) { error in
            done(error == nil)
        }
    }

    /// Releases the loaded ads and settles anything in flight as not-earned, never as a grant.
    func close() {
        pendingReward?.close(); pendingReward = nil
        pendingShow?.close(); pendingShow = nil
        activePresentedAd = nil
        rewarded = nil
        interstitial = nil
        initialized = false
    }

    // ------------------------------------------------------------ FullScreenContentDelegate

    /// The delegate is one object shared by every ad, so an event is only applied to the settlement of
    /// the ad that actually produced it. Without this identity check a late callback from an already
    /// finished presentation would be routed to the next one, and a real presentation would be starved
    /// until its watchdog fired.
    private func settlement(for ad: FullScreenPresentingAd) -> AnyObject? {
        guard let active = activePresentedAd, active === ad as AnyObject else { return nil }
        return activeSettlement
    }

    private var activeSettlement: AnyObject? {
        pendingReward ?? pendingShow
    }

    func adWillPresentFullScreenContent(_ ad: FullScreenPresentingAd) {
        (settlement(for: ad) as? RewardSettlement)?.markShown()
        (settlement(for: ad) as? ShowSettlement)?.markShown()
    }

    func ad(_ ad: FullScreenPresentingAd, didFailToPresentFullScreenContentWithError error: Error) {
        (settlement(for: ad) as? RewardSettlement)?.fail()
        (settlement(for: ad) as? ShowSettlement)?.fail()
    }

    func adDidDismissFullScreenContent(_ ad: FullScreenPresentingAd) {
        (settlement(for: ad) as? RewardSettlement)?.dismiss()
        (settlement(for: ad) as? ShowSettlement)?.dismiss()
    }

    /// The exact (reward item, amount) pairs this client may present, and the only ones.
    ///
    /// `cosmetic_reward` / 1 is the pair the registered AdMob units carry and the one the backend
    /// settles. The three named placements are the ones the V5.2 execution board and the rewarded-undo
    /// pack reserve for their own, accurately labelled, provider units - they are listed here so
    /// those units can be wired without a second convention, and they grant nothing until Core
    /// registers and verifies such a unit. The amount is pinned at exactly 1 for every item because
    /// the server settles only amount 1.
    static let rewardAllowlist: [String: Int] = [
        "cosmetic_reward": 1,
        "solo_rewind": 1,
        "tactical_hint": 1,
        "casual_rewind": 1
    ]
}

/// One rewarded presentation's terminal outcome: delivered at most once, only ever from the SDK's own
/// callbacks, and never positively except from the earned handler.
@MainActor
private final class RewardSettlement {
    private let done: (AdRewardResult) -> Void
    private var settled = false
    private var shown = false
    private var watchdog: Task<Void, Never>?

    init(_ done: @escaping (AdRewardResult) -> Void) { self.done = done }

    func arm() {
        watchdog = Task { @MainActor in
            try? await Task.sleep(nanoseconds: presentTimeoutSeconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            settle(.timedOut)
        }
    }

    func markShown() { shown = true }
    func earn() { settle(.earned) }
    func fail() { settle(.failed) }
    func close() { settle(.unavailable) }

    /// The SDK's earned callback precedes dismissal; this grace only covers the reverse order.
    func dismiss() {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: dismissGraceSeconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            settle(.dismissed)
        }
    }

    private func settle(_ outcome: AdRewardOutcome) {
        guard !settled else { return }
        settled = true
        watchdog?.cancel()
        done(AdRewardResult(outcome: outcome, shown: shown))
    }
}

/// One interstitial presentation: true only when the SDK reported content actually displayed.
@MainActor
private final class ShowSettlement {
    private let done: (Bool) -> Void
    private var settled = false
    private var watchdog: Task<Void, Never>?

    init(_ done: @escaping (Bool) -> Void) { self.done = done }

    func arm() {
        watchdog = Task { @MainActor in
            try? await Task.sleep(nanoseconds: interstitialTimeoutSeconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            settle(false)
        }
    }

    func markShown() { settle(true) }
    func fail() { settle(false) }
    func dismiss() { settle(false) }
    func close() { settle(false) }

    private func settle(_ ok: Bool) {
        guard !settled else { return }
        settled = true
        watchdog?.cancel()
        done(ok)
    }
}
