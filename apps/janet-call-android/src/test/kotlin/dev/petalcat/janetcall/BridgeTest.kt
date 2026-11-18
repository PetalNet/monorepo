package dev.petalcat.janetcall

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** [Bridge.pair] against a local HTTP server standing in for the bridge. */
class BridgeTest {
	private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
	private val seen = mutableListOf<Triple<String, Map<String, String>, String>>()

	private fun link() = PairingLink("ws://127.0.0.1:${server.address.port}/v1/call", "one-time", "id.access", "s3cret", Long.MAX_VALUE)

	private fun bridgeAnswers(status: Int, body: String = "", headers: Map<String, String> = emptyMap()) {
		server.createContext("/") { exchange: HttpExchange ->
			val sent = exchange.requestHeaders.entries.associate { it.key.lowercase() to it.value.first() }
			seen += Triple("${exchange.requestMethod} ${exchange.requestURI}", sent, String(exchange.requestBody.readBytes()))
			headers.forEach { (name, value) -> exchange.responseHeaders.add(name, value) }
			val bytes = body.toByteArray()
			exchange.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
			exchange.responseBody.use { it.write(bytes) }
		}
		server.start()
	}

	private fun refusal(result: PairResult) = (result as PairResult.Refused).reason

	@After
	fun stop() = server.stop(0)

	@Test
	fun `a good code pairs the phone with the token the bridge issued`() {
		bridgeAnswers(200, """{"token":"device-token"}""")
		val result = Bridge.pair(link(), "Maker Model")
		assertEquals(PairResult.Paired(Pairing(link().url, "device-token", "id.access", "s3cret")), result)

		val (line, headers, body) = seen.single()
		assertEquals("POST /v1/call/pair", line)
		assertEquals("id.access", headers["cf-access-client-id"])
		assertEquals("s3cret", headers["cf-access-client-secret"])
		assertTrue(headers.getValue("content-type").startsWith("application/json"))
		assertNull("pairing sends no bearer token", headers["authorization"])
		assertEquals("one-time", JSONObject(body).getString("code"))
		assertEquals("Maker Model", JSONObject(body).getString("name"))
	}

	@Test
	fun `a used or wrong code is refused with what to do next`() {
		bridgeAnswers(403, """{"error":"bad code"}""")
		assertEquals(
			"The pairing code was already used or is not valid. Open the pairing page again for a new one.",
			refusal(Bridge.pair(link(), "x")),
		)
	}

	@Test
	fun `a redirect is not followed and reads as Cloudflare Access turning the phone away`() {
		bridgeAnswers(302, headers = mapOf("Location" to "/elsewhere"))
		assertEquals("Cloudflare Access did not accept this link (HTTP 302).", refusal(Bridge.pair(link(), "x")))
		assertEquals(listOf("POST /v1/call/pair"), seen.map { it.first })
	}

	@Test
	fun `any other status is a plain failure`() {
		bridgeAnswers(500)
		assertEquals("The bridge could not pair this phone (HTTP 500).", refusal(Bridge.pair(link(), "x")))
	}

	@Test
	fun `a 200 without a token does not pair`() {
		bridgeAnswers(200, "<html>login</html>")
		assertEquals("The bridge answered without a device token.", refusal(Bridge.pair(link(), "x")))
	}

	@Test
	fun `an unreachable bridge names the host`() {
		val port = server.address.port
		server.stop(0)
		assertTrue(refusal(Bridge.pair(link(), "x")).startsWith("Could not reach 127.0.0.1:$port: "))
	}
}
