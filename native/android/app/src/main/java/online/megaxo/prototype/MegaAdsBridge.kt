package online.megaxo.prototype

import android.app.Activity
import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.libraries.ads.mobile.sdk.MobileAds
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * P20-06 typed, origin-pinned page surface for the real Mobile Ads SDK.
 *
 * This is the publisher of `window.MegaAds`, which `src/monetization-ui.js` has always called and
 * which nothing used to define, so every ad path in the signed game silently no-opped. It follows
 * the identity/theme/api bridges in this package exactly: one exact HTTPS app-assets channel, a
 * receiver that additionally requires a main frame whose origin is the app-assets host and whose
 * document is still the signed entry, and an injected shim restricted to that origin at document
 * start.
 *
 * The published surface, and nothing else:
 *
 *   window.MegaAds.platform                       -> 'android'
 *   window.MegaAds.privacyState()                -> {canRequestAds, privacyOptionsRequired}
 *   window.MegaAds.isReady(kind)                 -> boolean
 *   window.MegaAds.prepare(kind)                 -> Promise<boolean>
 *   window.MegaAds.privacyOptions()              -> Promise<boolean>
 *   window.MegaAds.showRewarded(ticket)          -> Promise<{earned, outcome, shown}>
 *   window.MegaAds.showInterstitial(permit)      -> Promise<{shown}>
 *   window.MegaAds.reportAd()                    -> Promise<{ok}>
 *
 * `showRewarded` settles positively **only** on the SDK's earned-reward callback. It rejects on
 * show-only, dismissal, failure, timeout and every malformed caller. There is no parameter that can
 * make it grant: the only inputs are Core-issued ticket values, which are re-validated in Kotlin
 * against this build's configured ad unit, and the reward item/amount is checked against an
 * allowlist. A page-supplied `watched: true` is never read, and no argument reaches the earned
 * listener.
 *
 * The capability state is returned on every reply as a `state` field and applied by the shim before
 * the caller's continuation resumes, so the page's own synchronous `privacyState()`/`isReady()`
 * checks right after an `await` are never stale. Consent is never claimed before UMP has answered.
 *
 * Two identifiers are never trusted from the page: the ad unit (it must be the one this build
 * configured, and for a presentation the one Core itself issued the ticket/permit for) and the
 * actor. No actor id, token, ticket or ad unit is ever logged.
 */
internal class MegaAdsBridge private constructor(
    private val activity: Activity,
    private val game: WebView,
    private val entryUrl: String,
    private val ads: MegaAndroidAds
) {
    @Volatile private var closed = false

    // ------------------------------------------------------------------ page -> host

    private fun send(reply: JavaScriptReplyProxy, id: Int, payload: JSONObject) {
        runCatching {
            reply.postMessage(
                payload.put("id", id).put("state", capabilityState()).toString()
            )
        }
    }

    private fun fail(reply: JavaScriptReplyProxy, id: Int, code: String) {
        runCatching {
            reply.postMessage(
                JSONObject().put("id", id).put("ok", false).put("error", code)
                    .put("state", capabilityState()).toString()
            )
        }
    }

    /**
     * Everything the page may know about ad availability right now. Consent is only ever true
     * after UMP answered, and each ready flag only after that format's SDK state allows it.
     */
    private fun capabilityState(): JSONObject = JSONObject()
        .put("canRequestAds", !closed && ads.canRequestAds())
        .put("privacyOptionsRequired", !closed && ads.isPrivacyOptionsRequired())
        .put("ready", JSONObject()
            .put("rewarded", !closed && ads.ready("rewarded"))
            .put("interstitial", !closed && ads.ready("interstitial")))

    private fun receive(
        view: WebView, message: WebMessageCompat, origin: Uri,
        isMainFrame: Boolean, reply: JavaScriptReplyProxy
    ) {
        if (closed) return
        // The HTTPS AssetLoader origin and the exact signed game entry are the whole bridge
        // authority, exactly as in the theme/identity/api bridges. Legal pages, nested frames and
        // any other document are denied.
        val trusted = isMainFrame && origin.scheme == "https" &&
            origin.host == assetHost &&
            (origin.port == -1 || origin.port == 443) &&
            view.url == entryUrl
        val command = try { JSONObject(message.data ?: "") } catch (_: Throwable) { null }
        val id = command?.optInt("id", -1) ?: -1
        if (id <= 0) return
        if (!trusted) { fail(reply, id, "ADS_UNTRUSTED_FRAME"); return }
        try {
            when (command!!.optString("op", "")) {
                "prepare" -> prepare(command, reply, id)
                "privacyOptions" -> privacyOptions(reply, id)
                "showRewarded" -> showRewarded(command, reply, id)
                "showInterstitial" -> showInterstitial(command, reply, id)
                "report" -> report(reply, id)
                else -> fail(reply, id, "ADS_UNSUPPORTED")
            }
        } catch (_: Throwable) {
            // No SDK, UMP or lifecycle failure may crash the host or reach the page as a grant.
            fail(reply, id, "ADS_UNAVAILABLE")
        }
    }

    /**
     * Brings the SDK to the point where a format can be loaded: ask UMP, then initialise only with
     * consent. `done(false)` means "not available", never "try anyway".
     */
    private fun withConsentAndSdk(done: (Boolean) -> Unit) {
        fun stepInitialize() {
            if (!ads.canRequestAds()) { done(false); return }
            ads.initialize { initialized -> done(initialized && ads.canRequestAds()) }
        }
        if (ads.consentUpdated()) stepInitialize() else ads.gatherConsent { stepInitialize() }
    }

    private fun prepare(command: JSONObject, reply: JavaScriptReplyProxy, id: Int) {
        val kind = command.optString("kind", "")
        if (kind != "rewarded" && kind != "interstitial") {
            fail(reply, id, "ADS_INVALID_KIND"); return
        }
        withConsentAndSdk { available ->
            if (!available) {
                send(reply, id, JSONObject().put("ok", false).put("error", "ADS_UNAVAILABLE"))
                return@withConsentAndSdk
            }
            ads.prepare(kind) { loaded ->
                send(reply, id, JSONObject()
                    .put("ok", loaded)
                    .put("kind", kind)
                    .put("error", if (loaded) JSONObject.NULL else "AD_LOAD_FAILED")
                    .put("ready", ads.ready(kind)))
            }
        }
    }

    /**
     * Presents the UMP privacy form. Consent information is requested first when this launch has
     * not asked yet, so the page's one "Ad privacy options" action works on a fresh install too;
     * the form itself is only shown where the provider says it is required.
     */
    private fun privacyOptions(reply: JavaScriptReplyProxy, id: Int) {
        fun stepForm() {
            if (!ads.canRequestAds()) {
                send(reply, id, JSONObject().put("ok", false).put("error", "ADS_CONSENT_NOT_GRANTED"))
                return
            }
            ads.privacyOptions { shown ->
                send(reply, id, JSONObject()
                    .put("ok", shown)
                    .put("error", if (shown) JSONObject.NULL else "ADS_PRIVACY_OPTIONS_UNAVAILABLE"))
            }
        }
        if (ads.consentUpdated()) stepForm() else ads.gatherConsent { stepForm() }
    }

    /**
     * Presents one Core-issued rewarded ticket. Every value comes from the server's ticket response
     * and is re-checked here; the page's only role is to hand the object over unchanged.
     */
    private fun showRewarded(command: JSONObject, reply: JavaScriptReplyProxy, id: Int) {
        val ticket = command.opt("ticket") as? JSONObject
        if (ticket == null) {
            send(reply, id, JSONObject().put("ok", false).put("granted", false)
                .put("error", "ADS_INVALID_TICKET")); return
        }
        val id_ = ticket.optString("ticket", "")
        val actor = ticket.optString("actor", "")
        val unit = ticket.optString("adUnit", "")
        val item = ticket.optString("rewardItem", "")
        val amount = ticket.optInt("rewardAmount", -1)
        val expires = ticket.optLong("expires", 0L)
        val issuedPlatform = ticket.optString("platform", "")
        if (id_.length !in 16..200 || !id_.all { it.code in 33..126 } ||
            actor.isEmpty() || actor.length > 200 ||
            unit != ads.rewardedUnitId() || issuedPlatform != "android" ||
            item.isEmpty() || amount <= 0 || expires <= 0L
        ) {
            // Core's own fields failed this build's checks: nothing is presented and nothing is
            // granted, whatever the caller claimed.
            send(reply, id, JSONObject().put("ok", false).put("granted", false)
                .put("error", "ADS_INVALID_TICKET")); return
        }
        ads.showRewarded(
            platform = issuedPlatform, unit = unit, actor = actor, ticket = id_,
            rewardItem = item, rewardAmount = amount, expiresAt = expires
        ) { result ->
            val earned = result.outcome == AdRewardOutcome.EARNED
            send(reply, id, JSONObject()
                .put("ok", earned)
                .put("granted", earned)
                .put("earned", earned)
                .put("shown", result.shown)
                .put("outcome", result.outcome.name)
                .put("error", if (earned) JSONObject.NULL else "AD_NOT_EARNED"))
        }
    }

    /** Presents one Core-issued automatic permit, on the exact unit Core authorised. */
    private fun showInterstitial(command: JSONObject, reply: JavaScriptReplyProxy, id: Int) {
        val permit = command.opt("permit") as? JSONObject
        val allowed = permit?.optBoolean("allowed", false) == true
        val unit = permit?.optString("adUnit", "") ?: ""
        val expires = permit?.optLong("expires", 0L) ?: 0L
        val issuedPlatform = permit?.optString("platform", "") ?: ""
        if (!allowed || unit != ads.interstitialUnitId() || issuedPlatform != "android" ||
            expires <= 0L
        ) {
            send(reply, id, JSONObject().put("ok", false).put("shown", false)
                .put("error", "ADS_INVALID_PERMIT")); return
        }
        ads.showInterstitial(
            platform = issuedPlatform, unit = unit, permitAllowed = allowed, expiresAt = expires
        ) { shown ->
            send(reply, id, JSONObject()
                .put("ok", shown)
                .put("shown", shown)
                .put("error", if (shown) JSONObject.NULL else "AD_NOT_SHOWN"))
        }
    }

    /**
     * "Report an ad". This app has no server-side ad-complaint route, so nothing is fabricated
     * here: the one real, SDK-owned capability is Ad Inspector, which reports the last ad's unit,
     * fill and errors on a registered test device. It is unavailable in a normal consumer install,
     * and that is reported as a clean failure rather than as a silent success.
     */
    private fun report(reply: JavaScriptReplyProxy, id: Int) {
        if (!ads.isInitialized()) {
            send(reply, id, JSONObject().put("ok", false).put("error", "ADS_UNAVAILABLE")); return
        }
        activity.runOnUiThread {
            val answered = AtomicBoolean(false)
            fun settle(ok: Boolean) {
                if (!answered.compareAndSet(false, true)) return
                send(reply, id, JSONObject()
                    .put("ok", ok)
                    .put("error", if (ok) JSONObject.NULL else "ADS_REPORT_UNAVAILABLE"))
            }
            // Ad Inspector is gated by the SDK to registered test devices; elsewhere it calls back
            // with an error, which is the clean failure reported here - never a silent success.
            runCatching {
                MobileAds.openAdInspector { error -> settle(error == null) }
            }.onFailure { settle(false) }
        }
    }

    fun close() {
        closed = true
    }

    companion object {
        private const val assetHost = "appassets.androidplatform.net"
        private const val channelName = "megaNativeAdsChannel"

        /**
         * Runs in the page, restricted to the app-assets origin by
         * [WebViewCompat.addDocumentStartJavaScript]. It publishes `window.MegaAds` and re-checks
         * every argument's shape before posting, so an obviously malformed call never reaches the
         * host at all. The capability state starts fully closed and is replaced by the host's own
         * `state` on each reply before a caller's continuation resumes.
         */
        private val bootstrap = """
            (() => {
              if (window.top !== window || window.MegaAds) return;
              const channel = window.megaNativeAdsChannel;
              if (!channel || typeof channel.postMessage !== 'function') return;
              const outstanding = new Map();
              let next = 0;
              let state = {canRequestAds: false, privacyOptionsRequired: false, ready: {}};
              channel.onmessage = event => {
                try {
                  const result = JSON.parse(event.data);
                  const callbacks = outstanding.get(result.id);
                  if (!callbacks) return;
                  outstanding.delete(result.id);
                  if (result && result.state && typeof result.state === 'object') state = result.state;
                  // showRewarded resolves the honest payload even when the reward was NOT earned:
                  // the caller must be able to tell a shown-then-skipped ad (which consumes the
                  // exposure allowance) from a call that never presented anything. Every other op
                  // still rejects on ok:false, so a genuine failure is unchanged.
                  const presented = callbacks.kind === 'showRewarded'
                    && typeof result.shown === 'boolean' && typeof result.earned === 'boolean';
                  if (result.ok === true || presented) callbacks.resolve(result);
                  else callbacks.reject(new Error(
                    typeof result.error === 'string' ? result.error : 'ADS_UNAVAILABLE'));
                } catch (_) {}
              };
              const call = (op, fields) => new Promise((resolve, reject) => {
                const id = ++next;
                outstanding.set(id, {resolve, reject, kind: op});
                try { channel.postMessage(JSON.stringify({id, op, ...fields})); }
                catch (_) { outstanding.delete(id); reject(new Error('ADS_UNAVAILABLE')); }
              });
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
                  platform: 'android',
                  privacyState: () => ({
                    canRequestAds: state.canRequestAds === true,
                    privacyOptionsRequired: state.privacyOptionsRequired === true
                  }),
                  isReady: kind => !!(state.ready && state.ready[kind] === true),
                  prepare: kind => (kind === 'rewarded' || kind === 'interstitial')
                    ? call('prepare', {kind})
                    : Promise.reject(new Error('ADS_INVALID_KIND')),
                  privacyOptions: () => call('privacyOptions', {}),
                  showRewarded: ticket => isTicket(ticket)
                    ? call('showRewarded', {ticket})
                    : Promise.reject(new Error('ADS_INVALID_TICKET')),
                  showInterstitial: permit => isPermit(permit)
                    ? call('showInterstitial', {permit})
                    : Promise.reject(new Error('ADS_INVALID_PERMIT')),
                  reportAd: () => call('report', {})
                })
              });
            })();
        """.trimIndent()

        /**
         * Installs the channel, the shim and the bridge. A build that configured no ad identifiers
         * publishes nothing at all, exactly like the api bridge without an origin: absent
         * capability is absent, never a stub that reports failure.
         */
        fun install(
            activity: Activity, game: WebView, entryUrl: String, ads: MegaAndroidAds?
        ): MegaAdsBridge? {
            if (ads == null || !ads.isConfigured()) return null
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
                !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return null
            val service = MegaAdsBridge(activity, game, entryUrl, ads)
            val origins = setOf("https://$assetHost")
            WebViewCompat.addWebMessageListener(
                game, channelName, origins,
                WebViewCompat.WebMessageListener { view, message, origin, main, reply ->
                    service.receive(view, message, origin, main, reply)
                })
            WebViewCompat.addDocumentStartJavaScript(game, bootstrap, origins)
            return service
        }
    }
}
