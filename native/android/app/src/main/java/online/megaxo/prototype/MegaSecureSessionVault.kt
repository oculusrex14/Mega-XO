package online.megaxo.prototype

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * P20-03 device-bound refresh credential storage. Not exposed to JavaScript.
 * No request or account token is accepted until the P05 API handshake is implemented.
 *
 * Stored preference bytes are AES-GCM authenticated ciphertext; the nonexportable
 * encryption key lives in AndroidKeyStore. The vault intentionally uses no backup.
 */
internal class MegaSecureSessionVault(private val context: Context) {
    private val alias = "mega_xo_v5_native_refresh_v1"
    private val preferences = context.getSharedPreferences("mega_native_secrets_v1", Context.MODE_PRIVATE)
    private val field = "refresh_ciphertext"

    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /* F4: the three vault operations used to share one implicit monitor, so a single wedged
     * Keystore call held it forever and the second io thread blocked behind it indefinitely.
     * The acquisition is now BOUNDED: a caller that cannot get the lock inside four seconds
     * gets an honest VAULT_BUSY failure (which every session-manager call site already maps
     * to its UNAVAILABLE/auth path) instead of hanging. The bounded-wait lock also keeps
     * operations serialized - concurrent TEE access on one key stays off the table. */
    private val lock = ReentrantLock()

    private inline fun <T> withVaultLock(block: () -> T): T {
        if (!lock.tryLock(4, TimeUnit.SECONDS)) throw IllegalStateException("VAULT_BUSY")
        return try { block() } finally { lock.unlock() }
    }

    private fun key(): SecretKey {
        val existing = store.getKey(alias, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    fun saveRefreshCredential(credential: String) = withVaultLock {
        saveLocked(credential)
    }

    private fun saveLocked(credential: String) {
        require(credential.isNotBlank() && credential.length <= 8192) { "Invalid refresh credential length" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val payload = cipher.doFinal(credential.toByteArray(StandardCharsets.UTF_8))
        val envelope = byteArrayOf(1) + cipher.iv + payload
        preferences.edit().putString(field, Base64.encodeToString(envelope, Base64.NO_WRAP)).commit()
            .also { check(it) { "Failed to persist encrypted refresh credential" } }
    }

    fun loadRefreshCredential(): String? = withVaultLock {
        loadLocked()
    }

    private fun loadLocked(): String? {
        val encoded = preferences.getString(field, null) ?: return null
        val envelope = Base64.decode(encoded, Base64.NO_WRAP)
        require(envelope.size > 29 && envelope[0] == 1.toByte()) { "Invalid encrypted credential envelope" }
        val iv = envelope.copyOfRange(1, 13)
        val payload = envelope.copyOfRange(13, envelope.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        // Tag failure throws: a corrupt credential is never treated as authenticated.
        return String(cipher.doFinal(payload), StandardCharsets.UTF_8)
    }

    fun clear() = withVaultLock {
        clearLocked()
    }

    private fun clearLocked() {
        check(preferences.edit().remove(field).commit()) { "Failed to remove refresh credential" }
        if (store.containsAlias(alias)) store.deleteEntry(alias)
    }
}
