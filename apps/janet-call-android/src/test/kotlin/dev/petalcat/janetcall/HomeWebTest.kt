package dev.petalcat.janetcall

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HomeWebTest {
	private val allowed = allowedHosts(DEFAULT_HOME_URL)

	private fun route(url: String) = routeLink(url, allowed)

	@Test
	fun `the home page and the sign-in page stay in the view, every other web address goes to the browser`() {
		assertEquals(setOf("tasks.petalcat.dev", AUTH_HOST), allowed)
		assertEquals(LinkRoute.InView, route("https://tasks.petalcat.dev/janet/home"))
		assertEquals(LinkRoute.InView, route("https://$AUTH_HOST/if/flow/x/?next=%2F"))
		assertEquals(LinkRoute.InView, route("HTTPS://Tasks.Petalcat.Dev/a"))
		assertEquals(LinkRoute.Browser, route("https://example.com/"))
		assertEquals(LinkRoute.Browser, route("https://tasks.petalcat.dev.evil.example/"))
		assertEquals(LinkRoute.Browser, route("https://tasks.petalcat.dev@evil.example/"))
		assertEquals(LinkRoute.Browser, route("https://evil.example@tasks.petalcat.dev/"))
		assertEquals(LinkRoute.Browser, route("http://tasks.petalcat.dev/janet/home"))
		assertEquals(LinkRoute.Browser, route("https://tasks.petalcat.dev./janet/home"))
		assertEquals(LinkRoute.InView, route("https://tasks.petalcat.dev:8443/janet/home"))
	}

	@Test
	fun `janetcall call starts a call, with or without a query, and nothing else in that scheme does`() {
		assertEquals(LinkRoute.Call, route("janetcall://call"))
		assertEquals(LinkRoute.Call, route("janetcall://call?ask=hello%20there"))
		assertEquals(LinkRoute.Block, route("janetcall://pair?u=abc"))
		assertEquals(LinkRoute.Block, route("janetcall://callme"))
		assertEquals(LinkRoute.Block, route("janetcall://x@call"))
	}

	@Test
	fun `other schemes and broken addresses are dropped`() {
		listOf("intent://x#Intent;end", "file:///sdcard/a", "javascript:alert(1)", "content://a/b", "https://a b", "").forEach {
			assertEquals(it, LinkRoute.Block, route(it))
		}
	}

	@Test
	fun `the home page address must be https with a host and no sign-in in it`() {
		assertNull(homeUrlProblem(DEFAULT_HOME_URL))
		listOf("http://tasks.petalcat.dev/", "tasks.petalcat.dev", "https://", "https://u:p@tasks.petalcat.dev/", "ftp://x.example/").forEach {
			assertEquals(it, true, homeUrlProblem(it) != null)
		}
	}

	@Test
	fun `a changed home page keeps the sign-in host and drops the old one`() {
		assertEquals(setOf("home.example.com", AUTH_HOST), allowedHosts("https://home.example.com/x"))
	}
}
