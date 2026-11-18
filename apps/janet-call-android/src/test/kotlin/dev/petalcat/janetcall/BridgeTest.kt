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

	private fun link() = PairingLink("ws://127.0.0.1:${server.address.port}/v1/call", "one-time", Long.MAX_VALUE)

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
	fun `a good code pairs the phone with the token and the Access credentials the bridge issued`() {
		bridgeAnswers(200, """{"token":"device-token","cf_id":"id.access","cf_secret":"s3cret"}""")
		val result = Bridge.pair(link(), "Maker Model")
		assertEquals(PairResult.Paired(Pairing(link().url, "device-token", "id.access", "s3cret")), result)

		val (line, headers, body) = seen.single()
		assertEquals("POST /v1/call/pair", line)
		assertNull("pairing is outside Access", headers["cf-access-client-id"])
		assertNull("pairing is outside Access", headers["cf-access-client-secret"])
		assertTrue(headers.getValue("content-type").startsWith("application/json"))
		assertNull("pairing sends no bearer token", headers["authorization"])
		assertEquals("one-time", JSONObject(body).getString("code"))
		assertEquals("Maker Model", JSONObject(body).getString("name"))
	}

	@Test
	fun `the bridge's own 403 means the code was used, is wrong or has expired`() {
		bridgeAnswers(403, """{"error":"code already used or expired"}""")
		assertEquals(
			"This pairing link was already used or has expired. Ask for a new one.",
			refusal(Bridge.pair(link(), "x")),
		)
	}

	@Test
	fun `a 429 says to wait a minute`() {
		bridgeAnswers(429, """{"error":"too many attempts"}""")
		assertEquals("Too many pairing attempts. Wait a minute, then open the pairing link again.", refusal(Bridge.pair(link(), "x")))
	}

	@Test
	fun `any other answer means the bridge was not reached`() {
		bridgeAnswers(403, "<html>Forbidden</html>")
		assertEquals("Could not reach the bridge at ${link().host} (HTTP 403).", refusal(Bridge.pair(link(), "x")))
	}

	@Test
	fun `a redirect is not followed`() {
		bridgeAnswers(302, headers = mapOf("Location" to "/elsewhere"))
		assertEquals("Could not reach the bridge at ${link().host} (HTTP 302).", refusal(Bridge.pair(link(), "x")))
		assertEquals(listOf("POST /v1/call/pair"), seen.map { it.first })
	}

	@Test
	fun `a 200 that is not a whole pairing does not pair`() {
		bridgeAnswers(200, """{"token":"device-token","cf_id":"id.access"}""")
		assertEquals("Could not reach the bridge at ${link().host} (HTTP 200).", refusal(Bridge.pair(link(), "x")))
	}

	@Test
	fun `an unreachable bridge names the host`() {
		val port = server.address.port
		server.stop(0)
		assertTrue(refusal(Bridge.pair(link(), "x")).startsWith("Could not reach the bridge at 127.0.0.1:$port: "))
	}
}
