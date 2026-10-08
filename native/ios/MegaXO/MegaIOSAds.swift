import Foundation
import GoogleMobileAds
import UIKit
import UserMessagingPlatform

/// P20-06 real iOS ad SDK, intentionally not wired into signed client until
/// actor-bound P05 transport, exact AdMob IDs and privacy declarations exist.
/// Neither SDK callback nor this class can grant Cosmetic Credits.
@MainActor
final class MegaIOSAds {
    private let appID: String?
    private let rewardedUnit: String?
    private let interstitialUnit: String?
    private var updatedConsent = false
    private var initialized = false
    private var rewarded: RewardedAd?
    private var interstitial: InterstitialAd?

    init(appID: String?, rewardedUnit: String?, interstitialUnit: String?) {
        self.appID = appID?.isEmpty == false ? appID : nil
        self.rewardedUnit = rewardedUnit?.isEmpty == false ? rewardedUnit : nil
        self.interstitialUnit = interstitialUnit?.isEmpty == false ? interstitialUnit : nil
    }

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
        guard updatedConsent else { return false }
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
        do {
            switch kind {
            case "rewarded":
                guard let id = rewardedUnit else { return false }
                rewarded = try await RewardedAd.load(with: id, request: Request())
                return canRequestAds
            case "interstitial":
                guard let id = interstitialUnit else { return false }
                interstitial = try await InterstitialAd.load(with: id, request: Request())
                return canRequestAds
            default: return false
            }
        } catch { return false }
    }

    func isReady(_ kind: String) -> Bool {
        guard canRequestAds && initialized else { return false }
        switch kind {
        case "rewarded": return rewarded != nil
        case "interstitial": return interstitial != nil
        default: return false
        }
    }

    func showRewarded(
        from controller: UIViewController, platform: String, adUnit: String,
        actor: String, ticket: String, rewardItem: String, rewardAmount: Int,
        expiresAtMilliseconds: Int64
    ) -> Bool {
        guard platform == "ios", adUnit == rewardedUnit,
              !actor.isEmpty, !ticket.isEmpty, rewardItem == "cosmetic_reward",
              rewardAmount == 1,
              Int64(Date().timeIntervalSince1970 * 1000) < expiresAtMilliseconds,
              isReady("rewarded"), let ad = rewarded else { return false }
        rewarded = nil
        let options = ServerSideVerificationOptions()
        options.userIdentifier = actor
        options.customRewardString = ticket
        ad.serverSideVerificationOptions = options
        ad.present(from: controller, userDidEarnRewardHandler: {
            // No client-side cosmetic grant: only backend-verified AdMob SSV.
        })
        return true
    }

    func showInterstitial(
        from controller: UIViewController, platform: String, adUnit: String,
        serverPermitAllowed: Bool
    ) -> Bool {
        guard platform == "ios", adUnit == interstitialUnit,
              serverPermitAllowed, isReady("interstitial"),
              let ad = interstitial else { return false }
        interstitial = nil
        ad.present(from: controller)
        return true
    }
}
