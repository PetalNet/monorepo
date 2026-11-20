package dev.petalcat.janetcall

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RingProtocolTest {
	@Test fun `registration only accepts the pinned server and a high entropy topic`() {
		val topic = "janet-ring-" + "aB0_-".repeat(8) + "aB0"
		assertEquals("wss://ntfy.petalcat.dev/$topic/ws", parseRingRegistration(JSONObject().put("server", "https://ntfy.petalcat.dev").put("topic", topic))?.socketUrl)
		assertNull(parseRingRegistration(JSONObject().put("server", "https://evil.example").put("topic", topic)))
		assertNull(parseRingRegistration(JSONObject().put("server", "https://ntfy.petalcat.dev").put("topic", "janet-ring-short")))
		assertNull(parseRingRegistration(JSONObject().put("server", "https://ntfy.petalcat.dev").put("topic", "janet-ring-" + "a".repeat(64))))
		assertNull(parseRingRegistration(JSONObject().put("server", "https://ntfy.petalcat.dev").put("topic", "$topic/other")))
	}

	@Test fun `only live message envelopes with valid ids can be checked with the bridge`() {
		fun envelope(id: String, expires: Long) = JSONObject().put("event", "message").put("message", JSONObject().put("id", id).put("expires", expires).toString()).toString()
		assertEquals("ring_1", parseRingNotice(envelope("ring_1", 101), 100)?.id)
		assertNull(parseRingNotice(envelope("ring_1", 100), 100))
		assertNull(parseRingNotice(envelope("../bad", 101), 100))
		assertNull(parseRingNotice("{}", 100))
		assertNull(parseRingNotice("not JSON", 100))
		assertNull(parseRingNotice(" ".repeat(4097), 100))
	}

	@Test fun `pending response must match the requested live ring`() {
		val answer = JSONObject().put("id", "one").put("reason", "Hello").put("expires", 101)
		assertEquals("Hello", parsePendingRing(answer, "one", 100)?.reason)
		assertNull(parsePendingRing(answer, "other", 100))
		assertNull(parsePendingRing(answer, "one", 101))
	}

	@Test fun `fractional expiry is preserved and ringing never extends past the deadline`() {
		val answer = JSONObject().put("id", "one").put("reason", "Hello").put("expires", 100.125)
		val ring = parsePendingRing(answer, "one", 100)!!
		assertEquals(125L, ringRemainingMs(ring.expires, nowMs = 100_000))
		assertEquals(1L, ringRemainingMs(ring.expires, nowMs = 100_124))
		assertEquals(0L, ringRemainingMs(ring.expires, nowMs = 100_125))
		assertEquals(0L, ringRemainingMs(ring.expires, nowMs = 100_126))
	}
	@Test fun `inbox keeps concurrent notices and retries without consuming an id`() {
		val inbox = RingInbox()
		inbox.offer(RingNotice("first", 110.0))
		assertEquals("first", inbox.next(100)?.id)
		inbox.offer(RingNotice("second", 110.0))
		assertNull(inbox.next(100))
		inbox.complete("first", retry = true)
		assertEquals("second", inbox.next(100)?.id)
		inbox.complete("second", retry = false)
		assertEquals("first", inbox.next(100)?.id)
		inbox.complete("first", retry = false)
		inbox.offer(RingNotice("first", 110.0))
		inbox.offer(RingNotice("second", 110.0))
		assertNull(inbox.next(100))
	}

	@Test fun `inbox drops expired retries and clears the previous pairing`() {
		val inbox = RingInbox()
		inbox.offer(RingNotice("first", 101.0))
		assertEquals("first", inbox.next(100)?.id)
		inbox.complete("first", retry = true)
		assertNull(inbox.next(101))
		inbox.offer(RingNotice("second", 110.0))
		inbox.clear()
		assertNull(inbox.next(100))
	}

}
