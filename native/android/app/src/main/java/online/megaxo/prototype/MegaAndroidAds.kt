package online.megaxo.prototype

import android.app.Activity
import android.os.Handler
import android.os.Looper
import com.google.android.ump.ConsentInformation
import com.google.android.ump.ConsentRequestParameters
import com.google.android.ump.UserMessagingPlatform
import com.google.android.libraries.ads.mobile.sdk.MobileAds
import com.google.android.libraries.ads.mobile.sdk.initialization.InitializationConfig
import com.google.android.libraries.ads.mobile.sdk.common.AdLoadCallback
import com.google.android.libraries.ads.mobile.sdk.common.AdRequest
import com.google.android.libraries.ads.mobile.sdk.common.FullScreenContentError
import com.google.android.libraries.ads.mobile.sdk.common.LoadAdError
import com.google.android.libraries.ads.mobile.sdk.interstitial.InterstitialAd
import com.google.android.libraries.ads.mobile.sdk.interstitial.InterstitialAdEventCallback
import com.google.android.libraries.ads.mobile.sdk.rewarded.RewardedAd
import com.google.android.libraries.ads.mobile.sdk.rewarded.RewardedAdEventCallback
import com.google.android.libraries.ads.mobile.sdk.rewarded.OnUserEarnedRewardListener
import com.google.android.libraries.ads.mobile.sdk.rewarded.ServerSideVerificationOptions
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The one terminal truth of a rewarded presentation. Only [EARNED] may ever be read as a reward,
 * and nothing but the SDK's own earned-reward listener can produce it.
 */
internal enum class AdRewardOutcome { EARNED, DISMISSED, FAILED, TIMEOUT, UNAVAILABLE }

/** [outcome] plus whether any full-screen content was actually shown. A `shown` is worth nothing. */
internal data class AdRewardResult(val outcome: AdRewardOutcome, val shown: Boolean)

/** An AdMob application id: the exact public grammar, so a placeholder can never be initialised. */
private val AD_APP_ID = Regex("^ca-app-pub-[0-9]{16}~[0-9]{10}$")

/** An AdMob ad unit id: the exact public grammar the backend already enforces. */
private val AD_UNIT = Regex("^ca-app-pub-[0-9]{16}/[0-9]{10}$")

/**
 * A rewarded ad that has neither earned nor dismissed inside this window settles as a timeout, so
 * no presentation can leave a grant open forever.
 */
private const val PRESENT_TIMEOUT_MS = 10 * 60 * 1000L

/**
 * The earned callback precedes dismissal in the SDK's own ordering. This grace only covers the
 * reverse delivery order; it can turn a pending dismissal into an earned result the SDK really
 * reported, and it can never invent one.
 */
private const val DISMISS_GRACE_MS = 500L

/** An interstitial that has not appeared within this window was not shown and reports so. */
private const val INTERSTITIAL_SHOW_TIMEOUT_MS = 30_000L

/**
 * P20-06 Google UMP 4 + GMA Next-Gen, now instantiated by the signed online host and published to
 * the page through [MegaAdsBridge].
 *
 * Two facts are kept strictly apart here, which is the whole point of the class:
 *
 *  - **shown** is a presentation fact, read from the SDK's full-screen-content callback. It is
 *    worth nothing on its own.
 *  - **EARNED** is the SDK's `OnUserEarnedRewardListener`. Only that callback completes a rewarded
 *    presentation positively. A show, a dismissal, a show failure, a malformed caller and the
 *    watchdog all complete negatively.
 *
 * Nothing a caller passes can produce `EARNED`: `showRewarded` does not return a result, and a
 * field such as `watched: true` is never read at all. Even `EARNED` is only local evidence that
 * the ad was watched. Cosmetic Credits stay server-side: the ticket is issued and bound by Core,
 * and only AdMob's signed server-to-server verification may settle it.
 */
internal class MegaAndroidAds(
    private val activity: Activity,
    appId: String?,
    rewardedUnit: String?,
    interstitialUnit: String?
) {
    // A malformed or missing identifier is unavailability, never a default and never a crash:
    // every path below re-reads these nullable values and fails closed on null.
    private val appId: String? = appId?.takeIf { AD_APP_ID.matches(it) }
    private val rewardedUnit: String? = rewardedUnit?.takeIf { AD_UNIT.matches(it) }
    private val interstitialUnit: String? = interstitialUnit?.takeIf { AD_UNIT.matches(it) }

    private val consent: ConsentInformation = UserMessagingPlatform.getConsentInformation(activity)
    private var updatedThisLaunch = false
    private var initialized = false
    private var rewarded: RewardedAd? = null
    private var interstitial: InterstitialAd? = null
    private var pendingReward: RewardSettlement? = null
    private var pendingShow: ShowSettlement? = null

    /** True when this build named real ids at all; a false here publishes no bridge. */
    fun isConfigured(): Boolean =
        appId != null && (rewardedUnit != null || interstitialUnit != null)

    /**
     * The two ad units this build actually compiled, and nothing else. The bridge answers a Core
     * ticket/permit for no other unit, so a caller cannot retarget a presentation.
     */
    fun rewardedUnitId(): String? = rewardedUnit
    fun interstitialUnitId(): String? = interstitialUnit
    fun isInitialized(): Boolean = initialized

    fun gatherConsent(done: (Boolean) -> Unit) {
        if (appId == null) { done(false); return }
        val params = ConsentRequestParameters.Builder().build()
        consent.requestConsentInfoUpdate(activity, params, {
            updatedThisLaunch = true
            UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity) {
                done(canRequestAds())
            }
        }, { _ -> done(false) })
    }

    /* Owner rule (2026-10-16): installing the app is implicit consent to ads. UMP's persisted
     * consent status is authoritative the moment it has ever answered; a first-session gather is
     * kicked off at bridge install, so waiting for updatedThisLaunch only produced a false
     * CONSENT_UNAVAILABLE dead end on the powers path. */
    fun canRequestAds(): Boolean = consent.canRequestAds()
    fun isPrivacyOptionsRequired(): Boolean = updatedThisLaunch &&
        consent.privacyOptionsRequirementStatus ==
        ConsentInformation.PrivacyOptionsRequirementStatus.REQUIRED
    fun consentUpdated(): Boolean = updatedThisLaunch

    fun privacyOptions(done: (Boolean) -> Unit) {
        if (!updatedThisLaunch) { done(false); return }
        UserMessagingPlatform.showPrivacyOptionsForm(activity) { error ->
            done(error == null)
        }
    }

    fun initialize(done: (Boolean) -> Unit) {
        if (!canRequestAds() || appId == null) { done(false); return }
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
     * Presents one already-loaded rewarded ad and reports the SDK's own terminal outcome.
     *
     * Ticket values are issued and bound by Core, not by the JS caller, so every one of them is
     * re-checked here against this build's configuration before anything is presented. The reward
     * item/amount pair must be one of [rewardAllowlist]; anything else is a caller error and is
     * refused rather than presented.
     */
    fun showRewarded(
        platform: String, unit: String, actor: String, ticket: String,
        rewardItem: String, rewardAmount: Int, expiresAt: Long,
        done: (AdRewardResult) -> Unit
    ) {
        if (platform != "android" || unit != rewardedUnit || actor.isBlank() ||
            ticket.isBlank() || rewardAllowlist[rewardItem] != rewardAmount ||
            System.currentTimeMillis() >= expiresAt || !ready("rewarded")
        ) {
            done(AdRewardResult(AdRewardOutcome.UNAVAILABLE, false)); return
        }
        val ad = rewarded ?: run {
            done(AdRewardResult(AdRewardOutcome.UNAVAILABLE, false)); return
        }
        // A loaded ad is single use: it is consumed here whether or not it is earned, so one
        // presentation can never be replayed for a second grant.
        rewarded = null
        ad.setServerSideVerificationOptions(ServerSideVerificationOptions(actor, ticket))
        val settlement = RewardSettlement(done)
        pendingReward = settlement
        ad.adEventCallback = object : RewardedAdEventCallback {
            override fun onAdShowedFullScreenContent() {
                settlement.shown()
            }

            override fun onAdDismissedFullScreenContent() {
                settlement.dismissed()
            }

            override fun onAdFailedToShowFullScreenContent(fullScreenContentError: FullScreenContentError) {
                settlement.failed()
            }
        }
        settlement.arm()
        // The local earned callback carries no credit, account, balance or persistence side effect.
        // It is the only writer of EARNED, and it is the SDK's own reward signal - not this method
        // returning and not any value the page sent.
        ad.show(activity, OnUserEarnedRewardListener { settlement.earned() })
    }

    /**
     * Presents an already-loaded interstitial. An interstitial has no reward and no earned
     * callback, so `shown` here means the SDK reported the full-screen content as displayed, not
     * that a `show` call was accepted.
     */
    fun showInterstitial(
        platform: String, unit: String, permitAllowed: Boolean, expiresAt: Long,
        done: (Boolean) -> Unit
    ) {
        if (platform != "android" || unit != interstitialUnit || !permitAllowed ||
            System.currentTimeMillis() >= expiresAt || !ready("interstitial")
        ) { done(false); return }
        val ad = interstitial ?: run { done(false); return }
        // Actual placement/cooldowns are checked by the approved JS/server rules before the native
        // bridge calls this gated method; one loaded ad serves exactly one presentation.
        interstitial = null
        val settlement = ShowSettlement(done)
        pendingShow = settlement
        ad.adEventCallback = object : InterstitialAdEventCallback {
            override fun onAdShowedFullScreenContent() {
                settlement.shown()
            }

            override fun onAdDismissedFullScreenContent() {
                settlement.dismissed()
            }

            override fun onAdFailedToShowFullScreenContent(fullScreenContentError: FullScreenContentError) {
                settlement.failed()
            }
        }
        settlement.arm()
        ad.show(activity)
    }

    /** Releases the loaded ads and settles anything in flight as not-earned, never as a grant. */
    fun close() {
        pendingReward?.close(); pendingReward = null
        pendingShow?.close(); pendingShow = null
        rewarded?.destroy(); rewarded = null
        interstitial?.destroy(); interstitial = null
        initialized = false
    }

    internal companion object {
        /**
         * The exact (reward item, amount) pairs this client may present, and the only ones.
         *
         * `cosmetic_reward` / 1 is the pair the four registered AdMob units carry and the one the
         * backend settles. The three named placements are the ones the V5.2 execution board and the
         * rewarded-undo pack reserve for their own, accurately labelled, provider units - they are
         * listed here so those units can be wired without a second convention, and they grant
         * nothing until Core registers and verifies such a unit. The amount is pinned at exactly 1
         * for every item because the server settles only amount 1.
         *
         * This replaces the previous single `rewardItem != "cosmetic_reward" || rewardAmount != 1`
         * literal, which could not express a second approved placement.
         */
        private val rewardAllowlist: Map<String, Int> = mapOf(
            "cosmetic_reward" to 1,
            "solo_rewind" to 1,
            "tactical_hint" to 1,
            "casual_rewind" to 1
        )
    }
}

/**
 * One rewarded presentation's terminal outcome: delivered at most once, only ever from the SDK's
 * own callbacks, and never positively except from the earned listener.
 */
private class RewardSettlement(private val done: (AdRewardResult) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val settled = AtomicBoolean(false)

    @Volatile private var shown = false
    private val watchdog = Runnable { settle(AdRewardOutcome.TIMEOUT) }
    private val lateDismiss = Runnable { settle(AdRewardOutcome.DISMISSED) }

    fun arm() = main.postDelayed(watchdog, PRESENT_TIMEOUT_MS)
    fun shown() { shown = true }
    fun earned() = settle(AdRewardOutcome.EARNED)
    fun failed() = settle(AdRewardOutcome.FAILED)
    fun dismissed() { main.postDelayed(lateDismiss, DISMISS_GRACE_MS) }
    fun close() = settle(AdRewardOutcome.UNAVAILABLE)

    private fun settle(outcome: AdRewardOutcome) {
        if (!settled.compareAndSet(false, true)) return
        main.removeCallbacks(watchdog)
        main.removeCallbacks(lateDismiss)
        // The page reply must be posted from the UI thread; the earned listener and the event
        // callbacks are documented main-thread, and this makes that independent of the SDK's
        // delivery thread.
        val result = AdRewardResult(outcome, shown)
        main.post { done(result) }
    }
}

/** One interstitial presentation: true only when the SDK reported content actually displayed. */
private class ShowSettlement(private val done: (Boolean) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val settled = AtomicBoolean(false)
    private val watchdog = Runnable { settle(false) }

    fun arm() = main.postDelayed(watchdog, INTERSTITIAL_SHOW_TIMEOUT_MS)
    fun shown() = settle(true)
    fun failed() = settle(false)
    fun dismissed() = settle(false)
    fun close() = settle(false)

    private fun settle(ok: Boolean) {
        if (!settled.compareAndSet(false, true)) return
        main.removeCallbacks(watchdog)
        // The page reply must be posted from the UI thread; this makes that independent of the
        // SDK's delivery thread.
        main.post { done(ok) }
    }
}
