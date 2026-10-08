package online.megaxo.prototype

import android.app.Activity
import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.megaxo.identity.MegaGoogleIdentity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * P20-04 verified-provider UI adapter, disabled unless the authorized Google
 * Web/server OAuth client ID has been supplied at build time. It returns only
 * short-lived ID-token evidence to the signed game's existing
 * MegaNativeIdentity.getCredential contract. The P05 backend MUST validate
 * nonce, issuer, audience, state, subject and actor-bound link/reauth rules.
 *
 * It never creates an actor, stores a Google credential or grants a wallet.
 */
internal class MegaAndroidIdentityBridge private constructor(
    activity: Activity,
    private val entryUrl: String,
    clientId: String
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val provider = MegaGoogleIdentity(activity, clientId)

    private fun send(reply: JavaScriptReplyProxy, id: Int, token: String?) {
        val response = JSONObject().put("id", id).put("ok", token != null)
        if (token != null) response.put("idToken", token)
        runCatching { reply.postMessage(response.toString()) }
    }

    private fun receive(
        view: WebView, message: WebMessageCompat, origin: Uri,
        isMainFrame: Boolean, reply: JavaScriptReplyProxy
    ) {
        val command = try { JSONObject(message.data ?: "") } catch (_: Exception) { return }
        val id = command.optInt("id", -1)
        if (id <= 0) return
        val trusted = isMainFrame && origin.scheme == "https" &&
            origin.host == "appassets.androidplatform.net" &&
            (origin.port == -1 || origin.port == 443) && view.url == entryUrl
        val nonce = command.optString("nonce", "")
        if (!trusted || command.optString("op", "") != "credential" ||
            command.optString("provider", "") != "google" ||
            nonce.length !in 16..256 ||
            nonce.any { it.code !in 33..126 || it == '\\' }) {
            send(reply, id, null)
            return
        }
        scope.launch {
            val token = try {
                provider.getCredential(nonce).takeIf { it.length in 24..12000 }
            } catch (_: CancellationException) {
                null
            } catch (_: Exception) {
                // Cancellations, unavailability, bad SDK credentials remain
                // errors; never return an invented ID token.
                null
            }
            send(reply, id, token)
        }
    }

    fun close() { scope.cancel() }

    companion object {
        private val bootstrap = """
            (() => {
              if (window.top !== window || window.MegaNativeIdentity) return;
              const channel = window.megaNativeIdentityChannel;
              if (!channel || typeof channel.postMessage !== 'function') return;
              const outstanding = new Map();
              let next = 0;
              channel.onmessage = event => {
                try {
                  const result = JSON.parse(event.data);
                  const callbacks = outstanding.get(result.id);
                  if (!callbacks) return;
                  outstanding.delete(result.id);
                  if (result.ok === true && typeof result.idToken === 'string')
                    callbacks.resolve({idToken: result.idToken});
                  else callbacks.reject(new Error('NATIVE_SIGNIN_FAILED'));
                } catch (_) {}
              };
              Object.defineProperty(window, 'MegaNativeIdentity', {
                configurable: false, enumerable: false,
                value: Object.freeze({
                  getCredential: ({provider, nonce} = {}) =>
                    new Promise((resolve, reject) => {
                      if (provider !== 'google' || typeof nonce !== 'string' ||
                          nonce.length < 16 || nonce.length > 256) {
                        reject(new Error('NATIVE_IDENTITY_UNAVAILABLE'));
                        return;
                      }
                      const id = ++next;
                      outstanding.set(id, {resolve, reject});
                      try {
                        channel.postMessage(JSON.stringify({id, op: 'credential', provider, nonce}));
                      } catch (_) {
                        outstanding.delete(id);
                        reject(new Error('NATIVE_IDENTITY_UNAVAILABLE'));
                      }
                    })
                })
              });
            })();
        """.trimIndent()

        fun install(
            activity: Activity, view: WebView, entryUrl: String,
            configuredServerClientId: String
        ): MegaAndroidIdentityBridge? {
            if (configuredServerClientId.isBlank() ||
                !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
                !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return null
            val service = MegaAndroidIdentityBridge(activity, entryUrl, configuredServerClientId)
            val origins = setOf("https://appassets.androidplatform.net")
            WebViewCompat.addWebMessageListener(
                view, "megaNativeIdentityChannel", origins,
                WebViewCompat.WebMessageListener { webView, message, origin, main, reply ->
                    service.receive(webView, message, origin, main, reply)
                })
            WebViewCompat.addDocumentStartJavaScript(view, bootstrap, origins)
            return service
        }
    }
}
