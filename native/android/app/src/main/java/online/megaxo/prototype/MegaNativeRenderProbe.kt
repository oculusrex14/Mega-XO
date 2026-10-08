package online.megaxo.prototype

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONTokener

/**
 * DEBUG-ONLY startup verification. The signed HTML can render a static
 * toolbar while the game scripts fail; an APK/process/screenshot test alone
 * therefore cannot prove that offline play has initialized.
 *
 * Reports only bounded booleans/counts, never user text, URL query strings,
 * tokens, purchases or the raw JavaScript exception message.
 */
internal class MegaNativeRenderProbe {
    private val handler = Handler(Looper.getMainLooper())
    private var closed = false
    private var attempts = 0

    private val javascript = """
        (() => {
            const p = document.getElementById('page');
            const n = document.getElementById('navigation');
            const home = !!p?.querySelector('.home-hero');
            const modes = !!p?.querySelector('.mode-list');
            const nav = n?.querySelectorAll('.nav-button').length || 0;
            return JSON.stringify([
                home && modes && nav >= 5,
                p?.children.length || 0, nav,
                !!window.MegaGame, !!window.MegaDomain,
                !!window.MegaIcons, !!window.MegaNetwork
            ]);
        })()
    """.trimIndent()

    fun start(view: WebView) {
        if (!BuildConfig.DEBUG || closed) return
        attempts = 0
        verify(view)
    }

    private fun verify(view: WebView) {
        if (closed || !BuildConfig.DEBUG) return
        view.evaluateJavascript(javascript) { encoded ->
            if (closed) return@evaluateJavascript
            val values = runCatching {
                JSONArray(JSONTokener(encoded).nextValue() as String)
            }.getOrNull()
            if (values?.optBoolean(0) == true) {
                Log.i("MegaXOStartup", "READY game_initialized=true nav=5")
                return@evaluateJavascript
            }
            attempts += 1
            if (attempts >= 25) {
                val details = values?.let {
                    "pageChildren=${it.optInt(1)} nav=${it.optInt(2)} " +
                    "game=${it.optBoolean(3)} domain=${it.optBoolean(4)} " +
                    "icons=${it.optBoolean(5)} network=${it.optBoolean(6)}"
                } ?: "probe_response_unavailable"
                Log.e("MegaXOStartup", "TIMEOUT " + details)
            } else {
                handler.postDelayed({ verify(view) }, 1000)
            }
        }
    }

    fun jsError(source: String?, line: Int, category: String) {
        if (!BuildConfig.DEBUG || closed) return
        val prefix = "https://appassets.androidplatform.net/assets/mega/"
        if (source == null || !source.startsWith(prefix)) return
        val safeSource = source.removePrefix(prefix).substringAfterLast('/')
            .take(48).filter { it.isLetterOrDigit() || it == '.' || it == '_' }
        Log.e("MegaXOStartup", "SCRIPT_ERROR type=" + category +
            " file=" + safeSource + " line=" + line.coerceIn(0, 99999))
    }

    fun close() {
        closed = true
        handler.removeCallbacksAndMessages(null)
    }
}
