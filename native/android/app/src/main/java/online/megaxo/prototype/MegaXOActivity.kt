package online.megaxo.prototype

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.ConsoleMessage
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

/**
 * P20-02 trusted offline host of the approved deterministic client bundle.
 * There is intentionally no JavascriptInterface or identity/billing/ad stub:
 * online actor sessions will be introduced through the audited P05/P20-03 contract.
 */
class MegaXOActivity : Activity() {
    private lateinit var game: WebView
    private var notifications: MegaAndroidLocalNotifications? = null
    private var themeBridge: MegaAndroidThemeBridge? = null
    private var identityBridge: MegaAndroidIdentityBridge? = null
    private var apiBridge: MegaNativeApiBridge? = null
    private var sessionManager: MegaNativeSessionManager? = null
    private var transport: MegaNativeHttpClient? = null
    private var vault: MegaSecureSessionVault? = null
    private val startupProbe = MegaNativeRenderProbe()
    private val assetHost = "appassets.androidplatform.net"
    private val assetPrefix = "/assets/mega/"
    private val gameEntry get() = "https://$assetHost${assetPrefix}bundle-index.html"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        game = WebView(this)
        game.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setSupportZoom(false)
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(game, false)
        game.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG && message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    val category = Regex("(?:SyntaxError|ReferenceError|TypeError|RangeError|SecurityError)")
                        .find(message.message())?.value ?: "OtherError"
                    startupProbe.jsError(message.sourceId(), message.lineNumber(), category)
                }
                return super.onConsoleMessage(message)
            }
        }
        game.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                if (url == gameEntry) startupProbe.start(view)
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                // data: favicon and blob: local exports are handled internally by WebView.
                if (url.scheme == "data" || url.scheme == "blob" || url.scheme == "about") return null
                if (url.scheme != "https" || url.host != assetHost || url.port != -1) return blocked()
                if (url.path?.startsWith(assetPrefix) == true) {
                    return loader.shouldInterceptRequest(url) ?: blocked()
                }
                if (url.path?.startsWith("/api/") == true) return unavailable()
                return blocked()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "https" && url.host == assetHost && url.port == -1 &&
                    url.path?.startsWith(assetPrefix) == true) return false
                // Only deliberate top-level external HTTPS links can leave the signed host.
                if (request.isForMainFrame && request.hasGesture() && url.scheme == "https") {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
                    } catch (_: ActivityNotFoundException) { /* remain within game */ }
                }
                return true
            }
        }

        game.setOnApplyWindowInsetsListener { view: View, insets: WindowInsets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        setContentView(game)
        // The bar theme must be ready before the very first frame, so the bridge is installed here
        // with the other host services rather than after load; its own gates keep it usable only
        // from the signed game entry.
        themeBridge = MegaAndroidThemeBridge.install(this, game, gameEntry)
        notifications = MegaAndroidLocalNotifications.install(this, game, gameEntry)
        identityBridge = MegaAndroidIdentityBridge.install(
            this, game, gameEntry, BuildConfig.MEGA_GOOGLE_SERVER_CLIENT_ID)
        // P20-03 ONLINE TARGET. The native session host is installed ONLY in the online flavor and
        // only when the build named an approved HTTPS origin; it owns the bearer, and the WebView's
        // /api/* interception stays hard-blocked in both flavors. A build with no origin keeps the
        // previous cookie-free `ONLINE_UNAVAILABLE` behaviour and no bridge at all.
        if (BuildConfig.MEGA_ONLINE_TARGET && BuildConfig.MEGA_API_ORIGIN.isNotEmpty()) {
            val client = MegaNativeHttpClient(BuildConfig.MEGA_API_ORIGIN)
            val secretVault = MegaSecureSessionVault(this)
            val manager = MegaNativeSessionManager(secretVault, client)
            // Capability comes from what this build actually compiled, not from a claim: the Google
            // adapter exists only when the authorized server client ID was supplied at build time.
            manager.providerAdapters = if (identityBridge != null) setOf("google") else emptySet()
            transport = client
            vault = secretVault
            sessionManager = manager
            apiBridge = MegaNativeApiBridge.install(game, gameEntry, client, manager, identityBridge)
        }
        game.loadUrl(gameEntry)
    }

    private fun blocked(): WebResourceResponse = WebResourceResponse(
        "text/plain", "UTF-8", 403, "Forbidden",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(ByteArray(0))
    )

    private fun unavailable(): WebResourceResponse = WebResourceResponse(
        "application/json", "UTF-8", 503, "Service Unavailable",
        mapOf("Cache-Control" to "no-store", "Access-Control-Allow-Origin" to "https://$assetHost"),
        ByteArrayInputStream("""{"error":"ONLINE_UNAVAILABLE"}""".toByteArray(Charsets.UTF_8))
    )

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (game.canGoBack()) game.goBack() else moveTaskToBack(true)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        notifications?.onPermissionResult(requestCode, grantResults)
    }

    override fun onDestroy() {
        startupProbe.close()
        themeBridge?.close()
        themeBridge = null
        notifications?.close()
        notifications = null
        identityBridge?.close()
        identityBridge = null
        // The access token is host memory only, so dropping it here is the whole local teardown.
        // The encrypted refresh credential survives in the Keystore vault across process death,
        // which is the point: a restart restores the same actor instead of minting a new one.
        apiBridge = null
        sessionManager?.clearLocal()
        sessionManager = null
        transport?.close()
        transport = null
        vault = null
        game.stopLoading()
        game.destroy()
        super.onDestroy()
    }
}
