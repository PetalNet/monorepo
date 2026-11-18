package dev.petalcat.janetcall

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class Config(val url: String, val token: String, val cfId: String, val cfSecret: String) {
	/** A reason the call cannot be placed, or null. ws:// is for local test bridges in debug builds only. */
	fun problem(): String? = when {
		url.isBlank() || token.isBlank() -> "Set the bridge URL and token first"
		url.startsWith("wss://") -> null
		url.startsWith("ws://") && BuildConfig.DEBUG -> null
		else -> "The bridge URL must start with wss://"
	}
}

/** The URL is stored as is. The token and Cloudflare Access values are sealed with an Android Keystore AES key. */
class Settings(context: Context) {
	private val prefs = context.getSharedPreferences("janet_call", Context.MODE_PRIVATE)

	fun save(url: String, token: String?, cfId: String?, cfSecret: String?) {
		prefs.edit().apply {
			putString("url", url.trim())
			token?.let { putString("token", seal(it.trim())) }
			cfId?.let { putString("cf_id", seal(it.trim())) }
			cfSecret?.let { putString("cf_secret", seal(it.trim())) }
		}.apply()
	}

	val url: String get() = prefs.getString("url", "") ?: ""
	val hasToken: Boolean get() = prefs.contains("token")
	val hasCfSecret: Boolean get() = prefs.contains("cf_secret")
	val cfId: String get() = open("cf_id")

	fun config() = Config(url, open("token"), open("cf_id"), open("cf_secret"))

	private fun open(key: String): String {
		val sealed = prefs.getString(key, null) ?: return ""
		return try {
			val raw = Base64.decode(sealed, Base64.NO_WRAP)
			val cipher = Cipher.getInstance(TRANSFORM)
			cipher.init(Cipher.DECRYPT_MODE, vaultKey(), GCMParameterSpec(128, raw, 0, IV_BYTES))
			String(cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES), Charsets.UTF_8)
		} catch (_: Exception) {
			""
		}
	}

	private fun seal(plain: String): String {
		val cipher = Cipher.getInstance(TRANSFORM)
		cipher.init(Cipher.ENCRYPT_MODE, vaultKey())
		return Base64.encodeToString(cipher.iv + cipher.doFinal(plain.toByteArray()), Base64.NO_WRAP)
	}

	private fun vaultKey(): SecretKey {
		val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
		(store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
		return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
			init(
				KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
					.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
					.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
					.build(),
			)
			generateKey()
		}
	}

	private companion object {
		const val KEY_ALIAS = "janet_call_settings"
		const val TRANSFORM = "AES/GCM/NoPadding"
		const val IV_BYTES = 12
	}
}
