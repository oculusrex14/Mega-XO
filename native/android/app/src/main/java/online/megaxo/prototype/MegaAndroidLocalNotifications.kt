package online.megaxo.prototype

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * P20-03 existing opt-in local alerts. No FCM token, backend actor binding,
 * invisible permission prompt, push campaign or native payment surface.
 *
 * WebMessageListener is explicitly origin-scoped and each incoming message
 * must come from the trusted signed entry's main frame.
 */
internal class MegaAndroidLocalNotifications private constructor(
    private val activity: Activity,
    private val entryUrl: String
) {
    private val manager = activity.getSystemService(NotificationManager::class.java)
    private var awaiting: Pair<Int, JavaScriptReplyProxy>? = null
    private val requestCode = 2030
    private val channel = "mega_local_notifications"

    private fun reply(id: Int, proxy: JavaScriptReplyProxy, ok: Boolean) {
        val data = JSONObject().put("id", id).put("ok", ok).toString()
        proxy.postMessage(data)
    }

    private fun permissionGranted(): Boolean {
        if (!manager.areNotificationsEnabled()) return false
        return Build.VERSION.SDK_INT < 33 ||
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    private fun askPermission(id: Int, proxy: JavaScriptReplyProxy) {
        if (permissionGranted()) { reply(id, proxy, true); return }
        if (Build.VERSION.SDK_INT < 33 || awaiting != null) {
            reply(id, proxy, false)
            return
        }
        awaiting = id to proxy
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), requestCode)
    }

    fun onPermissionResult(code: Int, results: IntArray): Boolean {
        if (code != requestCode) return false
        val waiting = awaiting
        awaiting = null
        if (waiting != null) {
            reply(waiting.first, waiting.second,
                results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED &&
                    permissionGranted())
        }
        return true
    }

    fun close() {
        awaiting?.let { reply(it.first, it.second, false) }
        awaiting = null
    }

    private fun showNotification(id: Int, proxy: JavaScriptReplyProxy, message: JSONObject) {
        val title = message.optString("title", "")
        val body = message.optString("body", "")
        val tag = message.optString("tag", "")
        if (!permissionGranted() || activity.hasWindowFocus() ||
            title.length !in 1..120 || body.length !in 1..280 ||
            tag.length !in 1..128) {
            reply(id, proxy, false)
            return
        }
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(
                channel, "Mega XO game alerts", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val intent = Intent(activity, MegaXOActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            activity, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val note = Notification.Builder(activity, channel)
            .setSmallIcon(R.drawable.ic_stat_mega_xo)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        manager.notify("mega.local." + tag, 1, note)
        reply(id, proxy, true)
    }

    private fun handle(
        view: WebView, message: WebMessageCompat, origin: Uri, mainFrame: Boolean,
        proxy: JavaScriptReplyProxy
    ) {
        val data = try { JSONObject(message.data ?: "") } catch (_: Exception) { return }
        val id = data.optInt("id", -1)
        if (id <= 0) return
        // The HTTPS AssetLoader origin and one exact signed game entry are
        // the entire bridge authority; legal pages and nested frames are denied.
        val trusted = mainFrame && origin.scheme == "https" &&
            origin.host == "appassets.androidplatform.net" &&
            (origin.port == -1 || origin.port == 443) &&
            view.url == entryUrl
        if (!trusted) { reply(id, proxy, false); return }
        when (data.optString("op", "")) {
            "permission" -> askPermission(id, proxy)
            "notify" -> showNotification(id, proxy, data)
            else -> reply(id, proxy, false)
        }
    }

    companion object {
        private val bootstrap = """
            (() => {
              if (window.top !== window || window.MegaNativeNotifications) return;
              const channel = window.megaNativeNotifications;
              if (!channel || typeof channel.postMessage !== 'function') return;
              let nextID = 0;
              const pending = new Map();
              channel.onmessage = event => {
                try {
                  const message = JSON.parse(event.data);
                  const settle = pending.get(message.id);
                  if (settle) { pending.delete(message.id); settle(message.ok === true); }
                } catch (_) {}
              };
              const send = (op, fields = {}) => new Promise(resolve => {
                const id = ++nextID;
                pending.set(id, resolve);
                try { channel.postMessage(JSON.stringify({id, op, ...fields})); }
                catch (_) { pending.delete(id); resolve(false); }
              });
              Object.defineProperty(window, 'MegaNativeNotifications', {
                configurable: false, enumerable: false,
                value: Object.freeze({
                  requestPermission: () => send('permission'),
                  notify: ({title, body, tag} = {}) => send('notify', {title, body, tag})
                })
              });
            })();
        """.trimIndent()

        fun install(activity: Activity, game: WebView, entryUrl: String): MegaAndroidLocalNotifications? {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
                !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return null
            val service = MegaAndroidLocalNotifications(activity, entryUrl)
            val origins = setOf("https://appassets.androidplatform.net")
            WebViewCompat.addWebMessageListener(
                game, "megaNativeNotifications", origins,
                WebViewCompat.WebMessageListener { view, message, origin, main, proxy ->
                    service.handle(view, message, origin, main, proxy)
                })
            WebViewCompat.addDocumentStartJavaScript(game, bootstrap, origins)
            return service
        }
    }
}
