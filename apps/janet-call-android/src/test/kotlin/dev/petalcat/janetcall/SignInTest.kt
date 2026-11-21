package dev.petalcat.janetcall

import java.io.IOException
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SignInTest {
	private val request = PendingSignIn.create("wss://bridge.example/v1/call", 1000, 500)
	private fun callback(query: String = "code=one-time&state=${request.state}", target: String = "janetcall://signin") =
		signInCallback("$target?$query", request, 1001, 501)

	@Test fun `S256 matches the RFC 7636 example`() {
		val pending = PendingSignIn(request.url, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "state", 0, 0)
		assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", pending.challenge)
	}

	@Test fun `each attempt has fresh unpredictable state and verifier`() {
		val other = PendingSignIn.create(request.url, 1000, 500)
		assertNotEquals(request.state, other.state)
		assertNotEquals(request.verifier, other.verifier)
		assertTrue(request.state.matches(Regex("[A-Za-z0-9_-]{43}")))
		assertTrue(request.verifier.matches(Regex("[A-Za-z0-9_-]{43}")))
		assertFalse(request.browserUrl.contains(request.verifier))
		assertTrue(request.browserUrl.startsWith("https://bridge.example/v1/call/pair/signin?challenge="))
		assertEquals("PendingSignIn", request.toString())
	}

	@Test fun `an enrollment restored after recreation accepts the original browser return`() {
		val restored = PendingSignIn.restore(request.json())
		val result = signInCallback("janetcall://signin?code=one-time&state=${request.state}", restored, 1100, 600)
		assertEquals("one-time", (result as SignInCallback.Code).value)
		assertFalse(result.toString().contains("one-time"))
	}

	@Test fun `wrong state and authority path scheme fragment and duplicate fields are refused`() {
		for (target in listOf("https://signin", "janetcall://signin/", "janetcall://signin/path", "janetcall://signin:443", "janetcall://user@signin", "janetcall://elsewhere")) {
			assertEquals(target, SignInCallback.Invalid, callback(target = target))
		}
		for (query in listOf("code=x&state=wrong", "code=x", "state=${request.state}",
			"code=x&state=${request.state}&state=${request.state}", "code=x&code=y&state=${request.state}",
			"code=x&state=${request.state}#extra", "code=x&error=denied&state=${request.state}",
			"code=%00&state=${request.state}", "code=x&state=%bad")) {
			assertEquals(query, SignInCallback.Invalid, callback(query))
		}
	}

	@Test fun `enrollment expires at the bound and rejects rollback or reboot`() {
		val raw = "janetcall://signin?code=x&state=${request.state}"
		assertTrue(request.live(1000 + SIGN_IN_LIFE_MS - 1, 500 + SIGN_IN_LIFE_MS - 1))
		for ((wall, elapsed) in listOf(1000 + SIGN_IN_LIFE_MS to 600L, 1100L to 500 + SIGN_IN_LIFE_MS, 999L to 600L, 1100L to 499L)) {
			assertEquals(SignInCallback.Invalid, signInCallback(raw, request, wall, elapsed))
		}
	}

	@Test fun `provider refusal is accepted only for the pending state`() {
		assertEquals(SignInCallback.Denied, callback("error=access_denied&state=${request.state}&error_description=private"))
		assertEquals(SignInCallback.Invalid, callback("error=access_denied&state=wrong"))
	}

	@Test fun `cleartext and untrusted URL shapes cannot start SSO`() {
		for (url in listOf("ws://bridge.example/v1/call", "wss://user@bridge.example/v1/call", "wss://bridge.example/v1/call?extra=1")) {
			assertThrows(IllegalArgumentException::class.java) { PendingSignIn.create(url, 0, 0) }
		}
	}

	private fun exchange(status: Int, body: String): PairResult {
		val client = OkHttpClient.Builder().addInterceptor { chain ->
			val sent = chain.request()
			assertEquals("https://bridge.example/v1/call/pair/signin", sent.url.toString())
			assertEquals("POST", sent.method)
			assertNull(sent.header("Authorization"))
			assertNull(sent.header("CF-Access-Client-Secret"))
			val json = JSONObject(Buffer().also { sent.body!!.writeTo(it) }.readUtf8())
			assertEquals(setOf("code", "verifier", "name"), json.keys().asSequence().toSet())
			assertEquals(request.verifier, json.getString("verifier"))
			assertEquals("auth-code", json.getString("code"))
			Response.Builder().request(sent).protocol(Protocol.HTTP_1_1).code(status).message("fixture")
				.body(body.toResponseBody()).build()
		}.build()
		return Bridge.signIn(request, "auth-code", "test phone", client)
	}

	@Test fun `exchange accepts only complete credentials from the preselected bridge`() {
		val response = exchange(200, """{"token":"device","cf_id":"id","cf_secret":"secret","url":"wss://evil.example/v1/call"}""")
		assertEquals(PairResult.Paired(Pairing(request.url, "device", "id", "secret")), response)
		for (body in listOf("{}", "not JSON", """{"token":"device","cf_id":"id","cf_secret":null}""")) {
			assertTrue(exchange(200, body) is PairResult.Refused)
		}
	}

	@Test fun `expired code provider refusal rate limit and redirect require a new sign-in`() {
		for (status in listOf(403, 429, 302, 503)) {
			val response = exchange(status, """{"error":"private provider detail"}""") as PairResult.Refused
			assertFalse(response.retryable)
			assertFalse(response.reason.contains("private provider detail"))
		}
	}

	@Test fun `network failures do not expose the request or exception contents`() {
		val client = OkHttpClient.Builder().addInterceptor { throw IOException("sensitive auth-code ${request.verifier}") }.build()
		val response = Bridge.signIn(request, "auth-code", "phone", client) as PairResult.Refused
		assertFalse(response.reason.contains("auth-code"))
		assertFalse(response.reason.contains(request.verifier))
	}
}
