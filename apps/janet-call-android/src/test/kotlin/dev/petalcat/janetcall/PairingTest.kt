package dev.petalcat.janetcall

import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTest {
	private val now = 1_800_000_000L

	private fun payload(
		url: String? = "wss://bridge.example/v1/call",
		code: String? = "one-time",
		expires: Long? = now + 600,
	): String {
		val json = JSONObject().put("cf_id", "id.access").put("cf_secret", "s3cret")
		url?.let { json.put("url", it) }
		code?.let { json.put("code", it) }
		expires?.let { json.put("expires", it) }
		return Base64.getUrlEncoder().withoutPadding().encodeToString(json.toString().toByteArray())
	}

	private fun parse(u: String, allowCleartext: Boolean = false) = parsePairingPayload(u, now, allowCleartext)

	private fun reason(u: String, allowCleartext: Boolean = false) = (parse(u, allowCleartext) as PairingParse.Bad).reason

	@Test
	fun `a pairing link gives the bridge, the code and the Access credentials`() {
		val link = (parse(payload()) as PairingParse.Ok).link
		assertEquals(PairingLink("wss://bridge.example/v1/call", "one-time", "id.access", "s3cret", now + 600), link)
		assertEquals("bridge.example", link.host)
		assertEquals("https://bridge.example/v1/call/pair", bridgeEndpoint(link.url, "pair"))
	}

	@Test
	fun `padding on the payload is accepted`() {
		val padded = Base64.getUrlEncoder().encodeToString("""{"url":"wss://b.example/v1/call","code":"c","expires":${now + 1}}""".toByteArray())
		assertEquals("b.example", (parse(padded) as PairingParse.Ok).link.host)
	}

	@Test
	fun `an expired link is refused with a reason that says what to do`() {
		assertEquals(EXPIRED_LINK, reason(payload(expires = now)))
		assertEquals(EXPIRED_LINK, reason(payload(expires = now - 1)))
	}

	@Test
	fun `a release build pairs over wss only, a debug build also over ws`() {
		val local = payload(url = "ws://10.0.2.2:38417/v1/call")
		assertEquals("The bridge address must start with wss://", reason(local))
		val link = (parse(local, allowCleartext = true) as PairingParse.Ok).link
		assertEquals("10.0.2.2:38417", link.host)
		assertEquals("http://10.0.2.2:38417/v1/call/pair", bridgeEndpoint(link.url, "pair"))
	}

	@Test
	fun `the host shown is the host that is called`() {
		listOf(
			"wss://bridge.example@evil.example/v1/call",
			"wss://bridge.example/v1/call?next=evil.example",
			"wss://bridge.example/v1/call#x",
			"wss://bridge.example/other",
			"https://bridge.example/v1/call",
			"wss:///v1/call",
			"wss://bridge example/v1/call",
		).forEach { url ->
			assertNull(url, bridgeAuthority(url))
			assertEquals(url, "The bridge address is not valid.", reason(payload(url = url)))
		}
	}

	@Test
	fun `anything that is not a pairing payload is refused`() {
		val notALink = "This is not a Janet Call pairing link."
		assertEquals(notALink, reason(""))
		assertEquals(notALink, reason("***"))
		assertEquals(notALink, reason(Base64.getUrlEncoder().encodeToString("[1,2]".toByteArray())))
		assertEquals(notALink, reason(payload(url = null)))
		assertEquals(notALink, reason(payload(code = null)))
		assertEquals(notALink, reason(payload(expires = null)))
	}
}
