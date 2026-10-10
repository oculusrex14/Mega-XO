package com.megaxo.identity

import android.app.Activity
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

/** Native adapter source, not a compiled Android application.
 * Call from the application's coroutine/UI flow after POST /api/account/native/challenge.
 * Forward the result ONLY to /api/account/native/finish on the configured Mega XOXO origin.
 * The backend, not this helper, verifies and links the identity.
 */
class MegaGoogleIdentity(private val activity: Activity, private val serverClientId: String) {
    suspend fun getCredential(nonce: String): String {
        require(nonce.isNotBlank()) { "A fresh server-issued nonce is required" }
        require(serverClientId.isNotBlank()) { "Configure the Web/server OAuth client ID" }
        val option = GetSignInWithGoogleOption.Builder(serverClientId)
            .setNonce(nonce)
            .build()
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .build()
        val result = CredentialManager.create(activity)
            .getCredential(context = activity, request = request)
        val credential = result.credential
        require(credential is CustomCredential &&
            credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            "Unexpected credential type"
        }
        return GoogleIdTokenCredential.createFrom(credential.data).idToken
    }
}
