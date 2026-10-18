package online.megaxo.prototype

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject

/**
 * P20-03 authenticated transport for the signed game. The approved client already issues every
 * account/game call through one same-origin adapter; in the native host that adapter is routed
 * here instead of to the WebView's (nonexistent) cookie jar.
 *
 * What JavaScript may ask for is exactly one thing: an allowlisted API path with a method, an
 * optional JSON body and an optional operation key. It may NOT supply an Authorization value, a
 * Cookie, a header, an arbitrary host, a scheme or a redirect target. The bearer is attached by
 * [MegaNativeSessionManager] inside Kotlin and never crosses the bridge in either direction.
 *
 * The bridge is origin-scoped to the app-assets origin, main-frame only, and callable only while
 * the signed entry document is the one loaded, exactly like the existing notification and
 * identity bridges.
 */
internal class MegaNativeApiBridge private constructor(
    private val entryUrl: String,
    private val transport: MegaNativeHttpClient,
    private val session: MegaNativeSessionManager,
    private val provider: MegaAndroidIdentityBridge?
) {
    private val maxPathLength = 512
    /* Mirror of the transport cap: the largest declared route contract (300000, see
     * packages/contracts/routes.js account.save.write). A 64 KiB bridge reject refused large
     * cloud saves before any server contact and surfaced as a permanent degraded banner. */
    private val maxBodyLength = 300000

    private fun send(reply: JavaScriptReplyProxy, id: Int, payload: JSONObject) {
        runCatching { reply.postMessage(payload.put("id", id).toString()) }
    }

    private fun fail(reply: JavaScriptReplyProxy, id: Int, code: String, status: Int = 0) {
        send(reply, id, JSONObject().put("ok", false).put("error", code).put("status", status))
    }

    private fun handle(
        view: WebView, message: WebMessageCompat, origin: Uri,
        isMainFrame: Boolean, reply: JavaScriptReplyProxy
    ) {
        val command = try { JSONObject(message.data ?: "") } catch (_: Exception) { return }
        val id = command.optInt("id", -1)
        if (id <= 0) return
        val trusted = isMainFrame && origin.scheme == "https" &&
            origin.host == "appassets.androidplatform.net" &&
            (origin.port == -1 || origin.port == 443) && view.url == entryUrl
        if (!trusted) { fail(reply, id, "NATIVE_API_UNTRUSTED_FRAME"); return }

        when (command.optString("op", "")) {
            "session" -> {
                val (linked, expiresAt, actorId) = session.status()
                send(reply, id, JSONObject()
                    .put("ok", true)
                    .put("linked", linked)
                    .put("actorId", actorId)
                    .put("expiresAt", expiresAt)
                    .put("online", transport.isConfigured())
                    .put("providers", JSONArray(session.nativeProviders())))
            }
            "request" -> request(command, reply, id)
            "signIn" -> signIn(command, reply, id)
            "refresh" -> session.refresh { outcome ->
                val body = JSONObject().put("ok", outcome == MegaNativeSessionManager.Outcome.OK)
                if (outcome != MegaNativeSessionManager.Outcome.OK) {
                    body.put("error", outcome.name)
                }
                send(reply, id, body)
            }
            "restore" -> session.restoreIfStored { outcome ->
                send(reply, id, JSONObject()
                    .put("ok", outcome == MegaNativeSessionManager.Outcome.OK)
                    .put("outcome", outcome.name))
            }
            "signOut" -> session.signOut(command.optBoolean("allDevices", false)) { outcome ->
                send(reply, id, JSONObject().put("ok", outcome == MegaNativeSessionManager.Outcome.OK))
            }
            else -> fail(reply, id, "NATIVE_API_UNSUPPORTED")
        }
    }

    private fun request(command: JSONObject, reply: JavaScriptReplyProxy, id: Int) {
        val path = command.optString("path", "")
        val method = command.optString("method", "GET").uppercase()
        // The transport re-validates the same grammar; this is the reject-early mirror so an
        // obviously impossible path never reaches the network layer at all.
        if (method !in listOf("GET", "POST") || path.isEmpty() || path.length > maxPathLength ||
            !path.startsWith("/api/") || path.any { it.code !in 33..126 || it == '\\' } ||
            listOf("..", "//", "%", "#", "?").any { path.contains(it) }
        ) {
            fail(reply, id, "INVALID_NATIVE_REQUEST"); return
        }
        val rawBody = command.opt("body")
        val body = when {
            method == "GET" -> null
            rawBody == null || rawBody == JSONObject.NULL -> "{}"
            else -> rawBody.toString()
        }
        if (body != null && body.toByteArray().size > maxBodyLength) {
            fail(reply, id, "INVALID_NATIVE_REQUEST"); return
        }
        val key = command.optString("key", "").takeIf { it.isNotEmpty() && it.length <= 128 }
        transport.request(path, method, body, key) { result ->
            result.fold(
                onSuccess = { (status, text) ->
                    // Read routes may answer with an array (invitations, leaderboard) or an object.
                    // Both are legal JSON bodies; pass the parsed value through unchanged and let
                    // the JS adapter unwrap, so nothing is reshaped or lost here.
                    val value = runCatching {
                        if (text.trimStart().startsWith("[")) JSONArray(text)
                        else JSONObject(text) as Any
                    }.getOrElse { JSONObject() }
                    send(reply, id, JSONObject().put("ok", status in 200..299)
                        .put("status", status).put("data", value))
                },
                onFailure = { error -> fail(reply, id, error.message ?: "ONLINE_UNAVAILABLE") }
            )
        }
    }

    /**
     * The complete cookie-free native sign-in: server challenge -> SDK credential -> bearer
     * exchange. The ID token and both session credentials stay inside Kotlin the whole way; only a
     * boolean outcome crosses back to JavaScript, because the approved client's account UI is
     * already driven by the profile projection the adapter fetches afterwards.
     */
    private fun signIn(command: JSONObject, reply: JavaScriptReplyProxy, id: Int) {
        val providerName = command.optString("provider", "")
        val intent = command.optString("intent", "login")
        val adapter = provider
        if (adapter == null || providerName !in session.nativeProviders()) {
            fail(reply, id, "PROVIDER_NOT_CONFIGURED"); return
        }
        session.challenge(providerName, intent) { challenge ->
            val issued = challenge.getOrNull()
            if (issued == null) {
                fail(reply, id, challenge.exceptionOrNull()?.message ?: "NATIVE_SIGNIN_FAILED")
            } else {
                adapter.credential(providerName, issued.optString("nonce", "")) { idToken ->
                    if (idToken == null) {
                        fail(reply, id, "NATIVE_SIGNIN_FAILED")
                    } else {
                        session.signIn(
                            JSONObject().put("provider", providerName)
                                .put("state", issued.optString("state", ""))
                                .put("idToken", idToken)
                                .put("sessionToken", issued.optString("sessionToken", ""))
                        ) { outcome ->
                            send(reply, id, JSONObject()
                                .put("ok", outcome == MegaNativeSessionManager.Outcome.OK)
                                .put("outcome", outcome.name))
                        }
                    }
                }
            }
        }
    }

    companion object {
        private val bootstrap = """
            (() => {
              if (window.top !== window || window.MegaNativeApi) return;
              const channel = window.megaNativeApiChannel;
              if (!channel || typeof channel.postMessage !== 'function') return;
              const outstanding = new Map();
              let next = 0;
              channel.onmessage = event => {
                try {
                  const result = JSON.parse(event.data);
                  const callbacks = outstanding.get(result.id);
                  if (!callbacks) return;
                  outstanding.delete(result.id);
                  callbacks.resolve(result);
                } catch (_) {}
              };
              const call = (op, fields) => new Promise((resolve, reject) => {
                const id = ++next;
                outstanding.set(id, {resolve, reject});
                try { channel.postMessage(JSON.stringify({id, op, ...fields})); }
                catch (_) { outstanding.delete(id); reject(new Error('NATIVE_API_UNAVAILABLE')); }
              });
              Object.defineProperty(window, 'MegaNativeApi', {
                configurable: false, enumerable: false,
                value: Object.freeze({
                  session: () => call('session'),
                  restore: () => call('restore'),
                  refresh: () => call('refresh'),
                  signOut: allDevices => call('signOut', {allDevices: allDevices === true}),
                  signIn: (provider, intent) => call('signIn', {provider, intent}),
                  request: (path, method, body, key) => call('request', {path, method, body, key})
                })
              });
            })();
        """.trimIndent()

        fun install(
            view: WebView, entryUrl: String,
            transport: MegaNativeHttpClient, session: MegaNativeSessionManager,
            provider: MegaAndroidIdentityBridge?
        ): MegaNativeApiBridge? {
            if (!transport.isConfigured()) return null
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
                !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return null
            val service = MegaNativeApiBridge(entryUrl, transport, session, provider)
            val origins = setOf("https://appassets.androidplatform.net")
            WebViewCompat.addWebMessageListener(
                view, "megaNativeApiChannel", origins,
                WebViewCompat.WebMessageListener { webView, message, origin, main, reply ->
                    service.handle(webView, message, origin, main, reply)
                })
            WebViewCompat.addDocumentStartJavaScript(view, bootstrap, origins)
            return service
        }
    }
}
