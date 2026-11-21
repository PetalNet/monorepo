package dev.petalcat.janetcall

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/** The pairing, sealed as one value with an Android Keystore AES key. Nothing here is typed in or shown. */
class Settings(context: Context) {
	private val app = context.applicationContext
	private val prefs = context.getSharedPreferences("janet_call_pairing", Context.MODE_PRIVATE)
	private val enrollment = AtomicFile(File(context.filesDir, "pending-signin"))
	private val appPrefs = context.getSharedPreferences("janet_call_app", Context.MODE_PRIVATE)

	fun webResetRequired(): Boolean = appPrefs.getBoolean("web_reset_required", false)
	fun requireWebReset() { check(appPrefs.edit().putBoolean("web_reset_required", true).commit()) }
	fun finishWebReset(): Boolean = appPrefs.edit().remove("web_reset_required").commit()

	init {
		// 0.1.0 kept a typed bearer token here. It is not a device token, so it must not read as a pairing.
		context.deleteSharedPreferences("janet_call")
	}

	/** Throws when the Keystore cannot seal the pairing. */
	fun save(pairing: Pairing) = synchronized(storageLock) {
		val json = JSONObject()
			.put("url", pairing.url).put("token", pairing.token)
			.put("cf_id", pairing.cfId).put("cf_secret", pairing.cfSecret)
		val encrypted = seal(json.toString())
		val previous = prefs.getString(KEY, null)
		if (!prefs.edit().putString(KEY, encrypted).commit()) {
			// SharedPreferences changes memory even when its disk commit fails.
			prefs.edit().putString(KEY, previous).commit()
			throw java.io.IOException("Pairing persistence failed")
		}
		// Notify after the durable write. Preference listeners can observe a failed commit's transient value.
		RingService.sync(app)
	}

	fun savePendingSignIn(request: PendingSignIn) = synchronized(storageLock) {
		val encrypted = seal(request.json()).toByteArray(Charsets.UTF_8)
		val stream = enrollment.startWrite()
		try {
			stream.write(encrypted)
			enrollment.finishWrite(stream)
		} catch (failure: Exception) {
			enrollment.failWrite(stream)
			throw failure
		}
	}

	fun pendingSignIn(): PendingSignIn? = synchronized(storageLock) {
		try {
			PendingSignIn.restore(unseal(String(enrollment.readFully(), Charsets.UTF_8)))
		} catch (_: Exception) { null }
	}

	fun clearPendingSignIn(): Boolean = synchronized(storageLock) {
		enrollment.delete()
		listOf("", ".bak", ".new").none { File(enrollment.baseFile.path + it).exists() }
	}

	fun clear() {
		prefs.edit().clear().apply()
		RingService.sync(app)
	}

	/** Null when this phone is not paired, or the stored pairing can no longer be opened or used. */
	fun pairing(): Pairing? = synchronized(storageLock) {
		val sealed = prefs.getString(KEY, null) ?: return@synchronized null
		try {
			val json = JSONObject(unseal(sealed))
			Pairing(json.getString("url"), json.getString("token"), json.getString("cf_id"), json.getString("cf_secret"))
				.takeIf { it.token.isNotEmpty() && bridgeUrlProblem(it.url, BuildConfig.DEBUG) == null }
		} catch (_: Exception) {
			null
		}
	}

	private fun unseal(sealed: String): String {
		val raw = Base64.decode(sealed, Base64.NO_WRAP)
		val cipher = Cipher.getInstance(TRANSFORM)
		cipher.init(Cipher.DECRYPT_MODE, vaultKey(), GCMParameterSpec(128, raw, 0, IV_BYTES))
		return String(cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES), Charsets.UTF_8)
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
		val storageLock = Any()
		const val KEY = "pairing"
		const val KEY_ALIAS = "janet_call_settings"
		const val TRANSFORM = "AES/GCM/NoPadding"
		const val IV_BYTES = 12
	}
}

const val NOT_PAIRED = "Pair this phone first"
