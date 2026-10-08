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
    private var identityBridge: MegaAndroidIdentityBridge? = null
    private val assetHost = "appassets.androidplatform.net"
    private val assetPrefix = "/assets/mega/"

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
        game.webChromeClient = WebChromeClient()
        game.webViewClient = object : WebViewClient() {
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
        val gameEntry = "https://$assetHost${assetPrefix}bundle-index.html"
        notifications = MegaAndroidLocalNotifications.install(this, game, gameEntry)
        identityBridge = MegaAndroidIdentityBridge.install(
            this, game, gameEntry, BuildConfig.MEGA_GOOGLE_SERVER_CLIENT_ID)
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
        notifications?.close()
        notifications = null
        identityBridge?.close()
        identityBridge = null
        game.stopLoading()
        game.destroy()
        super.onDestroy()
    }
}
