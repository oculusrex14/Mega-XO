package online.megaxo.prototype

import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.view.View
import android.view.Window
import android.view.WindowInsetsController
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * V5.1 theme-aware system bars for the signed game entry.
 *
 * The page calls `window.MegaNativeTheme.apply({theme, dark, surface})` from its own theme
 * application. This bridge paints the Android status bar and navigation bar, their icon
 * appearance, and every inset area the bars sit over (the decor background and the WebView
 * background behind its system-bar padding) with the theme's own surface colour. The window itself
 * is not resized and the existing insets padding is untouched: content stays clear of the bars,
 * while the strips the bars occupy are themed instead of a fixed light grey.
 *
 * The payload is a colour and a darkness flag and nothing else: no identity, credential, actor or
 * transport value crosses here, so the bridge cannot leak anything and adds no reachability.
 *
 * Authority follows the notification/identity/api bridges in this package: the listener is
 * registered on one exact HTTPS app-assets channel name, and the receiver additionally requires a
 * main frame whose origin is the app-assets host, whose document is still the signed entry. Any
 * other origin, frame, document or payload is ignored.
 */
internal class MegaAndroidThemeBridge private constructor(
    private val activity: Activity,
    private val game: WebView,
    private val entryUrl: String
) {
    private data class Bars(val dark: Boolean, val surface: String)

    @Volatile private var closed = false

    private fun receive(
        view: WebView, message: WebMessageCompat, origin: Uri,
        isMainFrame: Boolean
    ) {
        if (closed) return
        // The HTTPS AssetLoader origin and the exact signed game entry are the whole bridge
        // authority. Legal pages, nested frames and any other document are denied.
        val trusted = isMainFrame && origin.scheme == "https" &&
            origin.host == assetHost &&
            (origin.port == -1 || origin.port == 443) &&
            view.url == entryUrl
        if (!trusted) return
        val bars = parse(message.data) ?: return
        // WebView delivers message-listener calls on its UI thread; runOnUiThread re-enters inline
        // there and still lands on the main thread if that ever changes.
        activity.runOnUiThread { if (!closed) paint(bars) }
    }

    fun close() {
        closed = true
    }

    private fun parse(payload: String?): Bars? {
        if (payload == null || payload.length > maxPayloadLength) return null
        val body = try {
            JSONObject(payload)
        } catch (_: Exception) {
            return null
        }
        val surface = body.optString("surface", "")
        // Exactly one '#' plus six hex digits, with no locale-sensitive regex involved.
        if (surface.length != 7 || surface[0] != '#' ||
            !surface.substring(1).all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
            return null
        }
        // The JavaScript boolean must arrive as a JSON boolean; "true" is not a boolean.
        val dark = body.opt("dark") as? Boolean ?: return null
        // The theme id has no effect of its own; it is only accepted when it is one of the four
        // retained themes, so an arbitrary string can never reach the bar painting.
        if (body.optString("theme", "") !in themes) return null
        return Bars(dark, surface)
    }

    @Suppress("DEPRECATION")
    private fun paint(bars: Bars) {
        // parse() already proved the '#rrggbb' grammar, so this cannot throw.
        val colour = Color.parseColor(bars.surface)
        val window = activity.window ?: return
        if (Build.VERSION.SDK_INT >= 29) {
            // Android 10+ may tint a light navigation bar with a contrast scrim, and its gesture
            // pill with a translucent one. The applied theme owns that colour, not the framework.
            window.isNavigationBarContrastEnforced = false
        }
        window.statusBarColor = colour
        window.navigationBarColor = colour
        // Target SDK 35 enforces edge-to-edge, where the two colours above are ignored and the bar
        // strip shows what the app itself draws behind it: the decor and the padded WebView.
        window.decorView.setBackgroundColor(colour)
        game.setBackgroundColor(colour)
        setBarIconAppearance(window, bars.dark)
    }

    /**
     * A dark surface takes light bar icons, a light surface takes dark ones. `LIGHT_*` means
     * "dark icons", so it is set exactly when the theme is light. The two-argument
     * `setSystemBarsAppearance` is used deliberately: it applies only the bits named in the mask,
     * so the activity's other appearance flags survive untouched.
     */
    @Suppress("DEPRECATION")
    private fun setBarIconAppearance(window: Window, dark: Boolean) {
        val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
            WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.setSystemBarsAppearance(if (dark) 0 else mask, mask)
        } else {
            val flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
                View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            val visibility = window.decorView.systemUiVisibility
            window.decorView.systemUiVisibility =
                if (dark) visibility and flags.inv() else visibility or flags
        }
    }

    companion object {
        private const val assetHost = "appassets.androidplatform.net"
        private const val channelName = "megaNativeThemeChannel"
        private val themes = setOf("vector", "midnight", "paperclub", "afterhours")
        private const val maxPayloadLength = 256

        /**
         * Runs in the page, restricted to the app-assets origin by
         * [WebViewCompat.addDocumentStartJavaScript]. It publishes `window.MegaNativeTheme.apply`
         * and re-checks the payload shape before posting: the message channel is the only thing
         * exposed globally, and the app.js call site needs no separate presence test.
         */
        private val bootstrap = """
            (() => {
              if (window.top !== window || window.MegaNativeTheme) return;
              const channel = window.megaNativeThemeChannel;
              if (!channel || typeof channel.postMessage !== 'function') return;
              const hex = '0123456789abcdefABCDEF';
              const themes = ['vector', 'midnight', 'paperclub', 'afterhours'];
              const isSurface = value => typeof value === 'string' && value.length === 7 &&
                value.charAt(0) === '#' &&
                value.slice(1).split('').every(digit => hex.indexOf(digit) >= 0);
              Object.defineProperty(window, 'MegaNativeTheme', {
                configurable: false, enumerable: false,
                value: Object.freeze({
                  apply: ({theme, dark, surface} = {}) => {
                    if (typeof dark !== 'boolean' ||
                        themes.indexOf(theme) < 0 || !isSurface(surface)) return;
                    try { channel.postMessage(JSON.stringify({theme, dark, surface})); }
                    catch (_) {}
                  }
                })
              });
            })();
        """.trimIndent()

        fun install(activity: Activity, game: WebView, entryUrl: String): MegaAndroidThemeBridge? {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
                !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return null
            val service = MegaAndroidThemeBridge(activity, game, entryUrl)
            WebViewCompat.addWebMessageListener(
                game, channelName, setOf("https://$assetHost"),
                WebViewCompat.WebMessageListener { view, message, origin, main, _ ->
                    service.receive(view, message, origin, main)
                })
            WebViewCompat.addDocumentStartJavaScript(game, bootstrap, setOf("https://$assetHost"))
            return service
        }
    }
}
