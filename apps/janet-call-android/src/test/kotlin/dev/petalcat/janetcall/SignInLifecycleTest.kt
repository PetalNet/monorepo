package dev.petalcat.janetcall

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import java.io.InputStream
import java.io.OutputStream
import java.security.Key
import java.security.KeyStoreSpi
import java.security.Provider
import java.security.Security
import java.security.cert.Certificate
import java.util.Collections
import java.util.Date
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.spec.SecretKeySpec
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Exercises the coordinator and persistence; the test provider substitutes only Android's hardware key store. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SignInLifecycleTest {
	private val app: Context = ApplicationProvider.getApplicationContext()
	private val old = Pairing("wss://old.example/v1/call", "old-token", "old-id", "old-secret")
	private val fresh = Pairing("wss://new.example/v1/call", "new-token", "new-id", "new-secret")

	@Before fun setup() {
		Security.addProvider(TestKeys())
		Settings(app).finishWebReset()
		IncomingCalls.clear(app)
		Calls.update(CallState.Idle)
		SignIn.close(app)
		Settings(app).save(old)
		idle()
	}

	@After fun cleanup() {
		IncomingCalls.clear(app)
		Calls.update(CallState.Idle)
		SignIn.close(app)
		Settings(app).clear()
		idle()
		Security.removeProvider("AndroidKeyStore")
	}

	private fun idle() = shadowOf(Looper.getMainLooper()).idle()
	private fun start(): String {
		assertNotNull(SignIn.begin(app, fresh.url))
		val request = Settings(app).pendingSignIn()!!
		return "janetcall://signin?code=one-use&state=${request.state}"
	}

	private fun complete() {
		val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
		while ((SignIn.exchanging || SignIn.finishing) && System.nanoTime() < until) { Thread.sleep(5); idle() }
		assertFalse("exchange completed", SignIn.exchanging)
		assertFalse("home session reset completed", SignIn.finishing)
	}

	@Test fun `cancel and unsolicited return keep the existing pairing`() {
		val callback = start()
		SignIn.cancel(app)
		SignIn.receive(app, callback) { _, _, _ -> fail("cancelled enrollment exchanged"); PairResult.Paired(fresh) }
		assertNull(Settings(app).pendingSignIn())
		assertEquals(old, Settings(app).pairing())
	}

	@Test fun `pending secrets are encrypted and survive an activity recreation`() {
		start()
		val request = Settings(app).pendingSignIn()!!
		val stored = java.io.File(app.filesDir, "pending-signin").readText()
		assertFalse(stored.contains(request.verifier))
		assertFalse(stored.contains(request.state))
		val activity = Robolectric.buildActivity(MainActivity::class.java).setup()
		activity.recreate()
		assertEquals(request.state, Settings(activity.get()).pendingSignIn()!!.state)
		assertTrue(SignIn.open)
		assertEquals(old, Settings(app).pairing())
		activity.pause().stop().destroy()
	}

	@Test fun `startup finishes a durable web-session reset left by a killed process`() {
		Settings(app).requireWebReset()
		assertTrue(Settings(app).webResetRequired())
		SignIn.resume(app)
		assertTrue("home remains behind the sign-in screen", SignIn.open)
		complete()
		assertFalse(Settings(app).webResetRequired())
		assertEquals(old, Settings(app).pairing())
	}

	@Test fun `a fresh browser return is handled when Android restores saved activity state`() {
		val callback = start().replace("code=one-use", "error=access_denied")
		val intent = android.content.Intent(app, MainActivity::class.java)
			.setAction(android.content.Intent.ACTION_VIEW).setData(android.net.Uri.parse(callback))
		val activity = Robolectric.buildActivity(MainActivity::class.java, intent)
			.create(android.os.Bundle()).start().resume().visible()
		idle()
		assertNull("the provider refusal consumed the restored request", Settings(app).pendingSignIn())
		assertEquals(old, Settings(app).pairing())
		assertTrue(SignIn.message.contains("declined"))
		activity.pause().stop().destroy()
	}

	@Test fun `a matching callback is durably consumed before exchange and cannot replay`() {
		val callback = start()
		val started = CountDownLatch(1)
		val finish = CountDownLatch(1)
		val count = AtomicInteger()
		SignIn.receive(app, callback) { _, _, _ ->
			count.incrementAndGet()
			assertNull(Settings(app).pendingSignIn())
			started.countDown()
			check(finish.await(5, TimeUnit.SECONDS))
			PairResult.Paired(fresh)
		}
		assertTrue(started.await(5, TimeUnit.SECONDS))
		SignIn.receive(app, callback) { _, _, _ -> count.incrementAndGet(); PairResult.Paired(fresh) }
		finish.countDown()
		complete()
		assertEquals(1, count.get())
		assertEquals(fresh, Settings(app).pairing())
	}

	@Test fun `cancelling an exchange prevents a late success from replacing credentials`() {
		val callback = start()
		val finish = CountDownLatch(1)
		val returned = CountDownLatch(1)
		SignIn.receive(app, callback) { _, _, _ ->
			check(finish.await(5, TimeUnit.SECONDS))
			returned.countDown()
			PairResult.Paired(fresh)
		}
		SignIn.cancel(app)
		finish.countDown()
		assertTrue(returned.await(5, TimeUnit.SECONDS))
		Thread.sleep(30)
		idle()
		assertEquals(old, Settings(app).pairing())
	}

	@Test fun `a newly reserved incoming call prevents replacement before its UI state is posted`() {
		val ready = CountDownLatch(1)
		SignIn.receive(app, start()) { _, _, _ -> ready.countDown(); PairResult.Paired(fresh) }
		assertTrue(ready.await(5, TimeUnit.SECONDS))
		Thread.getAllStackTraces().keys.filter { it.name == "janet-signin" }.forEach { it.join(5000) }
		val ring = PendingRing("reserved-call", "Test call", System.currentTimeMillis() / 1000.0 + 60)
		IncomingCalls.offer(app, old, ring)
		assertNotNull(IncomingCalls.pending)
		assertEquals("ring state update is still queued", CallState.Idle, Calls.state)
		idle()
		assertEquals(old, Settings(app).pairing())
		assertNotNull(IncomingCalls.matching(app, ring.id))
	}

	@Test fun `provider denial wrong state expiration and exchange failures keep credentials`() {
		val callback = start()
		SignIn.receive(app, callback.replace("state=", "state=wrong")) { _, _, _ -> fail("wrong state"); PairResult.Paired(fresh) }
		assertNotNull(Settings(app).pendingSignIn())
		SignIn.receive(app, callback.replace("code=one-use", "error=access_denied")) { _, _, _ -> fail("provider denial"); PairResult.Paired(fresh) }
		assertNull(Settings(app).pendingSignIn())
		assertEquals(old, Settings(app).pairing())
		Settings(app).savePendingSignIn(PendingSignIn.create(fresh.url, 0, 0))
		SignIn.resume(app)
		assertNull(Settings(app).pendingSignIn())
		for (reason in listOf("Network failure", "Expired code", "Provider refusal")) {
			SignIn.receive(app, start()) { _, _, _ -> PairResult.Refused(reason) }
			complete()
			assertEquals(old, Settings(app).pairing())
		}
	}

	@Test fun `a failed preference commit restores the old pairing before readers see it`() {
		val listener = Robolectric.buildService(RingService::class.java).create()
		val ring = PendingRing("persist-test", "Test call", System.currentTimeMillis() / 1000.0 + 60)
		IncomingCalls.offer(app, old, ring)
		idle()
		assertNotNull("old phone has a pending ring", IncomingCalls.matching(app, ring.id))
		val wrapped = object : ContextWrapper(app) {
			override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
				val prefs = super.getSharedPreferences(name, mode)
				if (name != "janet_call_pairing") return prefs
				var failed = false
				return object : SharedPreferences by prefs {
					override fun edit(): SharedPreferences.Editor {
						val editor = prefs.edit()
						return object : SharedPreferences.Editor by editor {
							override fun putString(key: String?, value: String?): SharedPreferences.Editor { editor.putString(key, value); return this }
							override fun commit(): Boolean { editor.commit(); return if (!failed) { failed = true; false } else true }
						}
					}
				}
			}
		}
		assertThrows(java.io.IOException::class.java) { Settings(wrapped).save(fresh) }
		assertEquals(old, Settings(app).pairing())
		assertNotNull("failed save keeps the current incoming call", IncomingCalls.matching(app, ring.id))
		listener.destroy()
	}
}

class TestKeys : Provider("AndroidKeyStore", 1.0, "test key storage") {
	init { put("KeyStore.AndroidKeyStore", TestKeyStore::class.java.name) }
}

class TestKeyStore : KeyStoreSpi() {
	override fun engineGetKey(alias: String?, password: CharArray?): Key = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
	override fun engineLoad(stream: InputStream?, password: CharArray?) {}
	override fun engineStore(stream: OutputStream?, password: CharArray?) {}
	override fun engineGetCertificateChain(alias: String?): Array<Certificate>? = null
	override fun engineGetCertificate(alias: String?): Certificate? = null
	override fun engineGetCreationDate(alias: String?): Date = Date(0)
	override fun engineSetKeyEntry(alias: String?, key: Key?, password: CharArray?, chain: Array<out Certificate>?) = Unit
	override fun engineSetKeyEntry(alias: String?, key: ByteArray?, chain: Array<out Certificate>?) = Unit
	override fun engineSetCertificateEntry(alias: String?, cert: Certificate?) = Unit
	override fun engineDeleteEntry(alias: String?) = Unit
	override fun engineAliases(): java.util.Enumeration<String> = Collections.enumeration(listOf("janet_call_settings"))
	override fun engineContainsAlias(alias: String?) = true
	override fun engineSize() = 1
	override fun engineIsKeyEntry(alias: String?) = true
	override fun engineIsCertificateEntry(alias: String?) = false
	override fun engineGetCertificateAlias(cert: Certificate?): String? = null
}
