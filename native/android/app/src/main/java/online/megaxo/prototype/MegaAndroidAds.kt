package online.megaxo.prototype

import android.app.Activity
import com.google.android.ump.ConsentInformation
import com.google.android.ump.ConsentRequestParameters
import com.google.android.ump.UserMessagingPlatform
import com.google.android.libraries.ads.mobile.sdk.MobileAds
import com.google.android.libraries.ads.mobile.sdk.initialization.InitializationConfig
import com.google.android.libraries.ads.mobile.sdk.common.AdLoadCallback
import com.google.android.libraries.ads.mobile.sdk.common.AdRequest
import com.google.android.libraries.ads.mobile.sdk.common.LoadAdError
import com.google.android.libraries.ads.mobile.sdk.interstitial.InterstitialAd
import com.google.android.libraries.ads.mobile.sdk.rewarded.RewardedAd
import com.google.android.libraries.ads.mobile.sdk.rewarded.OnUserEarnedRewardListener
import com.google.android.libraries.ads.mobile.sdk.rewarded.ServerSideVerificationOptions

/**
 * P20-06 Google UMP 4 + GMA Next-Gen. Deliberately not instantiated until
 * actual AdMob app/unit IDs, approved consent flow, active actor and server
 * tickets exist. The JS UI remains the authority for approved *placement*
 * and the backend alone grants SSV rewards.
 */
internal class MegaAndroidAds(
    private val activity: Activity,
    private val appId: String?,
    private val rewardedUnit: String?,
    private val interstitialUnit: String?
) {
    private val consent: ConsentInformation = UserMessagingPlatform.getConsentInformation(activity)
    private var updatedThisLaunch = false
    private var initialized = false
    private var rewarded: RewardedAd? = null
    private var interstitial: InterstitialAd? = null

    fun gatherConsent(done: (Boolean) -> Unit) {
        if (appId.isNullOrBlank()) { done(false); return }
        val params = ConsentRequestParameters.Builder().build()
        consent.requestConsentInfoUpdate(activity, params, {
            updatedThisLaunch = true
            UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity) {
                done(canRequestAds())
            }
        }, { _ -> done(false) })
    }

    fun canRequestAds(): Boolean = updatedThisLaunch && consent.canRequestAds()
    fun isPrivacyOptionsRequired(): Boolean = updatedThisLaunch &&
        consent.privacyOptionsRequirementStatus ==
        ConsentInformation.PrivacyOptionsRequirementStatus.REQUIRED

    fun privacyOptions(done: (Boolean) -> Unit) {
        if (!updatedThisLaunch) { done(false); return }
        UserMessagingPlatform.showPrivacyOptionsForm(activity) { error ->
            done(error == null)
        }
    }

    fun initialize(done: (Boolean) -> Unit) {
        if (!canRequestAds() || appId.isNullOrBlank()) { done(false); return }
        if (initialized) { done(true); return }
        // The Next-Gen SDK initializes on a background thread to avoid ANRs.
        Thread {
            MobileAds.initialize(activity, InitializationConfig.Builder(appId).build()) {
                activity.runOnUiThread {
                    initialized = true
                    done(canRequestAds())
                }
            }
        }.start()
    }

    fun prepare(kind: String, done: (Boolean) -> Unit) {
        if (!initialized || !canRequestAds()) { done(false); return }
        when (kind) {
            "rewarded" -> {
                val unit = rewardedUnit ?: return done(false)
                RewardedAd.load(AdRequest.Builder(unit).build(),
                    object : AdLoadCallback<RewardedAd> {
                        override fun onAdLoaded(ad: RewardedAd) {
                            activity.runOnUiThread { rewarded = ad; done(canRequestAds()) }
                        }
                        override fun onAdFailedToLoad(adError: LoadAdError) {
                            activity.runOnUiThread { rewarded = null; done(false) }
                        }
                    })
            }
            "interstitial" -> {
                val unit = interstitialUnit ?: return done(false)
                InterstitialAd.load(AdRequest.Builder(unit).build(),
                    object : AdLoadCallback<InterstitialAd> {
                        override fun onAdLoaded(ad: InterstitialAd) {
                            activity.runOnUiThread { interstitial = ad; done(canRequestAds()) }
                        }
                        override fun onAdFailedToLoad(adError: LoadAdError) {
                            activity.runOnUiThread { interstitial = null; done(false) }
                        }
                    })
            }
            else -> done(false)
        }
    }

    fun ready(kind: String): Boolean = initialized && canRequestAds() &&
        when (kind) { "rewarded" -> rewarded != null; "interstitial" -> interstitial != null; else -> false }

    /**
     * Ticket values are issued and bound by Core, not by the JS caller.
     * A local watched callback is NOT an economic grant: only AdMob signed
     * server-to-server verification can update Cosmetic Credits.
     */
    fun showRewarded(
        platform: String, unit: String, actor: String, ticket: String,
        rewardItem: String, rewardAmount: Int, expiresAt: Long,
        done: (Boolean) -> Unit
    ) {
        if (platform != "android" || unit != rewardedUnit || actor.isBlank() ||
            ticket.isBlank() || rewardItem != "cosmetic_reward" || rewardAmount != 1 ||
            System.currentTimeMillis() >= expiresAt || !ready("rewarded")
        ) { done(false); return }
        val ad = rewarded ?: return done(false)
        rewarded = null
        ad.setServerSideVerificationOptions(ServerSideVerificationOptions(actor, ticket))
        // The local callback has no credit, account, balance or persistence side effect.
        ad.show(activity, OnUserEarnedRewardListener { _ -> })
        done(true)
    }

    fun showInterstitial(platform: String, unit: String, permitAllowed: Boolean, done: (Boolean) -> Unit) {
        if (platform != "android" || unit != interstitialUnit || !permitAllowed ||
            !ready("interstitial")) { done(false); return }
        val ad = interstitial ?: return done(false)
        interstitial = null
        // Actual placement/cooldowns are checked by the approved JS/server
        // rules before the native bridge calls this gated method.
        ad.show(activity)
        done(true)
    }
}
