package dev.petalcat.janetcall

import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PlanetEngineTest {
	private val lit = File("src/main/res/raw/planet_lit.bin").readBytes()
	private val ink = 0xF3F3EF
	private val pixels = IntArray(PlanetEngine.GRID * PlanetEngine.ROWS)

	/** The reference's scripted conversation: he asks, she thinks, she answers, he cuts in, she answers again. */
	private val script = listOf(
		Triple(Phase.Listening, 0.0, 3.4), Triple(Phase.Thinking, 3.4, 4.8), Triple(Phase.Speaking, 4.8, 9.4),
		Triple(Phase.Listening, 9.4, 12.0), Triple(Phase.Thinking, 12.0, 13.0), Triple(Phase.Speaking, 13.0, 15.4),
	)

	/** The reference's stand-in for a voice: words with breaths between them. */
	private fun syllables(t: Double, k: Int): Double {
		val a = 0.5 + 0.5 * sin(t * 19.5 + k * 1.7)
		val b = 0.5 + 0.5 * sin(t * 7.3 + k * 4.1)
		val c = 0.5 + 0.5 * sin(t * 2.9 + k)
		val gap = max(0.0, min(1.0, (sin(t * 4.4 + k * 2.3) + 0.55) / 0.3))
		return gap * min(1.0, 0.2 + 0.8 * a * (0.35 + 0.65 * b) * (0.55 + 0.45 * c))
	}

	private fun phaseOf(mode: String, t: Double): Phase = when (mode) {
		"live" -> script.firstOrNull { t % 16 >= it.second && t % 16 < it.third }?.first ?: Phase.Idle
		"speak" -> Phase.Speaking
		"listen" -> Phase.Listening
		"think" -> Phase.Thinking
		else -> Phase.Idle
	}

	/** The reference's still frame at [t]: five seconds of its demo at 60 steps a second, then one draw. */
	private fun stillFrame(engine: PlanetEngine, mode: String, t: Double) {
		engine.reset(turn = 40.0)
		var x = max(0.0, t - 5)
		while (x < t) {
			val phase = phaseOf(mode, x)
			engine.step(
				phase,
				if (phase == Phase.Speaking) syllables(x, 1) else 0.0,
				if (phase == Phase.Listening) syllables(x, 2) else 0.0,
				x,
				1.0 / 60,
			)
			x += 1.0 / 60
		}
		engine.draw(t, ink, pixels)
	}

	private fun alphaHash(): Long {
		var h = 0x811c9dc5L
		for (p in pixels) h = ((h xor (p ushr 24).toLong()) * 0x01000193L) and 0xFFFFFFFFL
		return h
	}

	private fun meterRows() = pixels.asList().chunked(PlanetEngine.GRID).drop(PlanetEngine.GRID + 2)

	private fun speak(engine: PlanetEngine, phase: Phase, her: Double, him: Double, seconds: Double) {
		var t = 0.0
		while (t < seconds) {
			engine.step(phase, her, him, t, 1.0 / 60)
			t += 1.0 / 60
		}
		engine.draw(t, ink, pixels)
	}

	@Test
	fun `every sampled moment matches the frame the design reference drew`() {
		val engine = PlanetEngine(lit)
		val lines = File("src/test/resources/planet-reference-frames.txt").readLines().filter { it.isNotBlank() }
		assertEquals(60, lines.size)
		for (line in lines) {
			val field = line.split(" ")
			stillFrame(engine, field[0], field[1].toDouble())
			assertEquals(line, field[2].toInt(), engine.frame)
			assertEquals(line, field[3].toDouble(), engine.scale, 0.00006)
			assertEquals(line, field[4].toDouble(), engine.alpha, 0.0006)
			assertEquals(line, field[5].toLong(), alphaHash())
		}
	}

	@Test
	fun `silence is only the dotted baseline`() {
		val engine = PlanetEngine(lit)
		speak(engine, Phase.Idle, 0.0, 0.0, 1.0)
		val rows = meterRows()
		val middle = (PlanetEngine.METER_ROWS - 1) / 2
		rows.forEachIndexed { k, row ->
			row.forEachIndexed { x, p -> assertEquals("row $k column $x", k == middle && x % 2 == 0, p != 0) }
		}
	}

	@Test
	fun `her voice raises bright columns and his are dimmer and narrower`() {
		val engine = PlanetEngine(lit)
		speak(engine, Phase.Speaking, 0.8, 0.0, 1.0)
		val hers = meterRows()
		val herWidth = hers[2].count { it != 0 }
		assertTrue("her columns reach near the top", herWidth > 0)
		assertTrue(hers.flatten().filter { it != 0 && it ushr 24 != 110 }.all { it ushr 24 == 255 })

		engine.reset()
		speak(engine, Phase.Listening, 0.0, 0.8, 1.0)
		val his = meterRows()
		assertTrue(his.flatten().filter { it != 0 && it ushr 24 != 110 }.all { it ushr 24 == 150 })
		val reach = { rows: List<List<Int>> -> rows[6].indices.filter { rows[6][it] != 0 }.let { it.last() - it.first() } }
		assertTrue("his meter is narrower", reach(his) < reach(hers))
	}

	@Test
	fun `levels without a talking phase leave the meter flat`() {
		val engine = PlanetEngine(lit)
		speak(engine, Phase.Thinking, 0.8, 0.8, 1.0)
		assertEquals(0, meterRows().take(8).flatten().count { it != 0 })
	}

	@Test
	fun `a level rises fast and falls slower`() {
		val rise = PlanetEngine(lit)
		speak(rise, Phase.Speaking, 1.0, 0.0, 0.1)
		val risen = meterRows().flatten().count { it != 0 }
		speak(rise, Phase.Speaking, 0.0, 0.0, 0.1)
		val falling = meterRows().flatten().count { it != 0 }
		speak(rise, Phase.Speaking, 0.0, 0.0, 1.5)
		val settled = meterRows().flatten().count { it != 0 }
		assertTrue("a tenth of a second of voice already shows ($risen)", risen > 150)
		assertTrue("a tenth of a second of silence has not emptied it ($falling)", falling > settled)
		assertEquals(PlanetEngine.GRID / 2, settled)
	}

	@Test
	fun `thinking pulls her in and dims her, listening stills her`() {
		val engine = PlanetEngine(lit)
		speak(engine, Phase.Thinking, 0.0, 0.0, 2.0)
		assertEquals(0.9, engine.scale, 0.001)
		assertEquals(0.85, engine.alpha, 0.001)
		engine.reset()
		speak(engine, Phase.Listening, 0.0, 0.0, 3.0)
		val still = engine.frame
		speak(engine, Phase.Listening, 0.0, 0.0, 1.0)
		assertTrue("she barely turns while he talks", kotlin.math.abs(engine.frame - still) <= 1)
		assertEquals(0.84, engine.alpha, 0.001)
	}
}
