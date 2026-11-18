package dev.petalcat.janetcall

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/** What Janet is doing, as the bridge reports it or as the levels imply. */
enum class Phase { Idle, Listening, Thinking, Speaking }

/**
 * Janet's pixel planet and the level meter under it: a port of the approved design's planet
 * engine, "meter" variant. The body never deforms. Every pixel is a cell of [lit], 48 frames of a
 * 96 x 96 grid, drawn on a 108 x 132 grid with the meter in its last rows. She turns slowly, pulls
 * in and spins fast while thinking, and goes almost still and dims while the caller talks.
 *
 * The meter is a fixed row of columns on a dotted baseline. Each column rises on its own with a
 * fast attack and a springy release. Hers is bright and wide, the caller's dimmer and narrower.
 *
 * The constants are the reference's. `PlanetEngineTest` holds this to frames the reference drew.
 */
class PlanetEngine(private val lit: ByteArray) {
	/** Uniform scale about [ORIGIN_X], [ORIGIN_Y] of the grid, and opacity, for whoever blits [draw]'s pixels. */
	var scale = 1.0
		private set
	var alpha = 1.0
		private set
	var frame = 0
		private set

	private var her = 0.0
	private var him = 0.0
	private var think = 0.0
	private var hush = 0.0
	private var turn = 0.0
	private var average = 0.0
	private var hers = true
	private val loudness = Spring()
	private val column = FloatArray(GRID)
	private val columnSpeed = FloatArray(GRID)
	private val scratch = Spring()

	init {
		require(lit.size == FRAMES * SIDE * SIDE / 8) { "planet frames are ${lit.size} bytes" }
	}

	/** Puts the engine where the reference starts a still frame from. */
	fun reset(turn: Double = 0.0) {
		her = 0.0
		him = 0.0
		think = 0.0
		hush = 0.0
		this.turn = turn
		average = 0.0
		hers = true
		loudness.x = 0.0
		loudness.v = 0.0
		column.fill(0f)
		columnSpeed.fill(0f)
	}

	/** Advances by [dt] seconds towards the levels [herLevel] and [himLevel] (0..1) at time [t]. */
	fun step(phase: Phase, herLevel: Double, himLevel: Double, t: Double, dt: Double) {
		val listening = phase == Phase.Listening
		// She stops mid-word when he cuts in.
		her = ease(her, herLevel, dt, 0.045, if (listening) 0.03 else 0.13)
		him = ease(him, himLevel, dt, 0.06, 0.16)
		think = ease(think, if (phase == Phase.Thinking) 1.0 else 0.0, dt, 0.12, 0.16)
		hush = ease(hush, if (listening) 1.0 else 0.0, dt, 0.25, 0.3)
		turn += dt * (5 * (1 - 0.92 * hush) + 27 * think)
		val k = floor(turn).toInt()
		val swing = 2 * FRAMES - 2
		frame = if (think > 0.5) k % FRAMES else if (k % swing < FRAMES) k % swing else swing - k % swing
		scale = (1 - 0.1 * think) * (1 - 0.02 * hush - 0.025 * him)
		alpha = 1 - 0.15 * think - 0.16 * hush

		val level = max(her, him)
		val talking = phase == Phase.Speaking || listening
		val was = hers
		if (level > 0.02) hers = her >= him
		if (hers != was) {
			// The interrupt: her columns drop at once.
			for (i in 0 until GRID) {
				column[i] = (column[i] * 0.15).toFloat()
				columnSpeed[i] = 0f
			}
		}
		average += (level - average) * (1 - exp(-dt / 0.12))
		loudness.chase(if (talking) average else 0.0, dt, 0.15, 0.86)
		val wide = if (hers) 36 else 22
		val centre = (GRID - 1) / 2.0
		val drive = if (talking) min(1.0, level.pow(0.8) * 1.2) else 0.0
		for (i in 0 until GRID step 2) {
			val dx = abs(i - centre)
			val window = if (dx < wide) (0.5 + 0.5 * cos(PI * dx / wide)).pow(0.8) else 0.0
			val to = drive * window * (0.72 + 0.28 * sin(i * 1.7 + t * 9.1) * sin(i * 0.53 - t * 6.3))
			if (to > column[i]) {
				column[i] = (column[i] + (to - column[i]) * (1 - exp(-dt / 0.025))).toFloat()
				columnSpeed[i] = 0f
			} else {
				scratch.x = column[i].toDouble()
				scratch.v = columnSpeed[i].toDouble()
				scratch.chase(to, dt, 0.2, 0.55)
				column[i] = scratch.x.toFloat()
				columnSpeed[i] = scratch.v.toFloat()
			}
		}
	}

	/** Fills [out], [GRID] x [ROWS] ARGB, with the planet and the meter in [rgb]. Unlit cells are 0. */
	fun draw(t: Double, rgb: Int, out: IntArray) {
		out.fill(0)
		val ink = rgb and 0xFFFFFF
		val solid = ink or (255 shl 24)
		val base = frame * SIDE * SIDE
		for (y in 0 until SIDE) {
			for (x in 0 until SIDE) {
				val cell = base + y * SIDE + x
				if ((lit[cell shr 3].toInt() shr (cell and 7)) and 1 == 1) out[(y + PAD) * GRID + x + PAD] = solid
			}
		}
		val half = (METER_ROWS - 1) / 2
		val mid = GRID + 2 + half
		val centre = (GRID - 1) / 2.0
		val voice = if (hers) 255 else 150
		val loud = max(0.0, loudness.x)
		val shine = if (think > 0.6) centre - 14 + ((t / 0.6) % 1) * 28 else null
		for (x in 0 until GRID) {
			val even = x and 1 == 0
			val h = if (even) height(x) else min(height(x - 1), height(x + 1))
			for (k in -half..half) {
				val y = mid + k
				var on = false
				var a = voice
				if (even) {
					if (abs(k) <= h) {
						on = true
						if (h == 0) a = 110
					}
				} else if (h > 0 && abs(k) <= h && loud * 1.15 > threshold(x, y)) {
					// Louder fills in between the columns.
					on = true
				}
				if (shine != null && abs(x - shine) < 2.5 && abs(k) <= (if (even) 1 else 0)) {
					on = true
					a = 235
				}
				if (on) out[y * GRID + x] = ink or (a shl 24)
			}
		}
	}

	private fun height(x: Int): Int =
		if (x < 0 || x >= GRID) 0 else floor(max(0.0, column[x].toDouble()) * ((METER_ROWS - 1) / 2) + 0.5).toInt()

	private class Spring {
		var x = 0.0
		var v = 0.0

		fun chase(to: Double, dt: Double, response: Double, damping: Double) {
			val w = 2 * PI / response
			val h = dt / 4
			repeat(4) {
				v += (-w * w * (x - to) - 2 * damping * w * v) * h
				x += v * h
			}
		}
	}

	companion object {
		const val SIDE = 96
		const val FRAMES = 48
		const val PAD = 6
		const val GRID = SIDE + 2 * PAD
		const val METER_ROWS = 21
		const val ROWS = GRID + METER_ROWS + 3

		/** The rows above the meter: the planet alone. */
		const val PLANET_ROWS = GRID

		/** The point the planet scales about, as a fraction of the grid. */
		const val ORIGIN_X = 0.5f
		const val ORIGIN_Y = 0.41f

		private val BAYER = intArrayOf(
			0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
			12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
			3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
			15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
		)

		private fun threshold(x: Int, y: Int) = (BAYER[(y and 7) * 8 + (x and 7)] + 0.5) / 64

		private fun ease(v: Double, to: Double, dt: Double, up: Double, down: Double) =
			v + (to - v) * (1 - exp(-dt / if (to > v) up else down))
	}
}
