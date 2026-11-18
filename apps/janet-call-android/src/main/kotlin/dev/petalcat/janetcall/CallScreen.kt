package dev.petalcat.janetcall

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.SystemClock
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.util.TypedValue
import android.view.Choreographer
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** The approved palette, dark ground. */
object Ink {
	const val GROUND = 0xFF0B0B0B.toInt()
	const val INK = 0xFFF3F3EF.toInt()
	const val G1 = 0xFFC6C6C2.toInt()
	const val G2 = 0xFFA2A29E.toInt()
	const val HAIR2 = 0xFF3B3B3B.toInt()
	const val TINT = 0xFF202020.toInt()
}

/**
 * Star positions for the reference's 360 x 760 screen: its generator with its seed, so the sky is
 * the approved one. Each entry is x, y, and whether the star is a big one. None sits within
 * [clearRadius] of the planet's centre.
 */
fun stars(seed: Long, count: Int, clearX: Double, clearY: Double, clearRadius: Double): List<Triple<Int, Int, Boolean>> {
	var s = seed
	fun next(): Double {
		s = (s * 1664525 + 1013904223) % 4294967296
		return s / 4294967296.0
	}
	val out = mutableListOf<Triple<Int, Int, Boolean>>()
	var k = 0
	while (k < count * 4 && out.size < count) {
		k++
		val x = floor(6 + next() * 348 + 0.5).toInt()
		val y = floor(40 + next() * 690 + 0.5).toInt()
		if ((y < 96 || y > 640) && next() < 0.7) continue
		if (Math.hypot(x - clearX, y - clearY) < clearRadius) continue
		out += Triple(x, y, next() < 0.16)
	}
	return out
}

/**
 * The call screen: the planet is the whole interface. Under it, the level meter and one centred
 * transcript line, hers bright and his gray, with no labels. Controls: speaker, Hide or Show text, hang up.
 */
class CallScreen(context: Context) : FrameLayout(context) {
	private val sky = Sky(context)
	private val speaker = round(R.drawable.ic_speaker, "Speaker")
	private val end = round(R.drawable.ic_end, "Hang up").apply {
		background = oval(Ink.INK)
		drawable.setTint(Ink.GROUND)
	}
	private val text = TextView(context).apply {
		setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
		setTextColor(Ink.G1)
		typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
		gravity = Gravity.CENTER
		setPadding(dp(22), 0, dp(22), 0)
		background = GradientDrawable().apply {
			cornerRadius = dp(28).toFloat()
			setStroke(dp(1), Ink.HAIR2)
		}
		setOnClickListener {
			sky.showText = !sky.showText
			renderControls()
		}
	}

	var onSpeaker: () -> Unit = {}
	var onHangUp: () -> Unit = {}

	init {
		setBackgroundColor(Ink.GROUND)
		// Self-managed calls get no proximity sensor handling from the system, and the screen is the call.
		keepScreenOn = true
		addView(sky, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
		val edge = dp(EDGE)
		val bottom = dp(BOTTOM)
		addView(speaker, LayoutParams(dp(BUTTON), dp(BUTTON), Gravity.BOTTOM or Gravity.START).apply { setMargins(edge, 0, 0, bottom) })
		addView(
			text,
			LayoutParams(LayoutParams.WRAP_CONTENT, dp(56), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
				.apply { setMargins(0, 0, 0, bottom + dp(BUTTON - 56) / 2) },
		)
		addView(end, LayoutParams(dp(BUTTON), dp(BUTTON), Gravity.BOTTOM or Gravity.END).apply { setMargins(0, 0, edge, bottom) })
		speaker.setOnClickListener { onSpeaker() }
		end.setOnClickListener { onHangUp() }
		renderControls()
	}

	/** Call state changed: the header line and the speaker button follow it. */
	fun render() {
		renderControls()
		sky.invalidate()
	}

	private fun renderControls() {
		val on = Calls.route == "Speaker"
		speaker.background = oval(if (on) Ink.INK else Ink.TINT)
		speaker.drawable.setTint(if (on) Ink.GROUND else Ink.INK)
		speaker.contentDescription = if (on) "Speaker, on" else "Speaker, off"
		text.text = if (sky.showText) "Hide text" else "Show text"
	}

	private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

	private fun oval(color: Int) = GradientDrawable().apply {
		shape = GradientDrawable.OVAL
		setColor(color)
	}

	private fun round(icon: Int, label: String) = ImageButton(context).apply {
		setImageDrawable(context.getDrawable(icon)!!.mutate())
		scaleType = android.widget.ImageView.ScaleType.CENTER
		contentDescription = label
	}

	/** Everything that is drawn rather than tapped: stars, the header, the planet with its meter, the transcript. */
	private class Sky(context: Context) : View(context) {
		var showText = true
			set(value) {
				field = value
				invalidate()
			}

		private val engine = PlanetEngine(context.resources.openRawResource(R.raw.planet_lit).use { it.readBytes() })
		private val pixels = IntArray(PlanetEngine.GRID * PlanetEngine.ROWS)
		private val bitmap = Bitmap.createBitmap(PlanetEngine.GRID, PlanetEngine.ROWS, Bitmap.Config.ARGB_8888)
		private val sky = stars(29, 30, 180.0, 250.0, 170.0)
		private val density = resources.displayMetrics.density
		private val fill = Paint()
		private val blit = Paint().apply { isFilterBitmap = false }
		private val name = textPaint(15f, 600, Ink.INK)
		private val detail = textPaint(12.5f, 500, Ink.G2)
		private val words = textPaint(18f, 500, Ink.INK)
		private val planet = RectF()
		private val caps = RectF()
		private var lastS = 0.0
		private val stage = StageView()
		private var drawnStage: CallStage? = null
		private var clock = ""
		private var clockSecond = -1L
		private var lastFrameNs = 0L
		private var ticking = false

		/** Asks for a frame about thirty times a second, whatever the display's own rate. */
		private val ticker = object : Choreographer.FrameCallback {
			override fun doFrame(frameTimeNanos: Long) {
				if (!isShown) {
					ticking = false
					return
				}
				if (frameTimeNanos - lastFrameNs >= FRAME_NS) {
					lastFrameNs = frameTimeNanos
					invalidate()
				}
				Choreographer.getInstance().postFrameCallback(this)
			}
		}

		override fun onVisibilityAggregated(isVisible: Boolean) {
			super.onVisibilityAggregated(isVisible)
			if (isVisible && !ticking) {
				ticking = true
				Choreographer.getInstance().postFrameCallback(ticker)
			}
		}

		private var shown: Caption? = null
		private var shownLayout: StaticLayout? = null
		private var shownSinceS = 0.0
		private var leaving: StaticLayout? = null
		private var leavingColor = 0
		private var leavingSinceS = 0.0

		private fun textPaint(sp: Float, weight: Int, color: Int) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
			textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, resources.displayMetrics)
			this.color = color
			typeface = if (Build.VERSION.SDK_INT >= 28) {
				Typeface.create(Typeface.DEFAULT, weight, false)
			} else {
				Typeface.create(if (weight >= 600) "sans-serif" else "sans-serif-medium", if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
			}
		}

		/**
		 * The reference lays out a 360 x 726 dp area under the status bar: planet grid at 3 dp a cell
		 * from 40 dp down, the transcript 18 dp under it, the controls at the bottom. A shorter or
		 * narrower screen gets a smaller whole-pixel cell, so the grid stays crisp.
		 */
		override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
			val below = (CAPS_GAP + CAPS_MIN + CONTROLS_GAP + BUTTON + BOTTOM) * density
			val cell = floor(
				min(
					CELL * density,
					min((w - 2 * CAPS_EDGE * density) / PlanetEngine.GRID, (h - PLANET_TOP * density - below) / PlanetEngine.ROWS),
				),
			).coerceAtLeast(1f)
			val left = floor((w - cell * PlanetEngine.GRID) / 2)
			val top = floor(PLANET_TOP * density)
			planet.set(left, top, left + cell * PlanetEngine.GRID, top + cell * PlanetEngine.ROWS)
			val capsTop = planet.bottom + CAPS_GAP * density
			val controlsTop = h - (BOTTOM + BUTTON + CONTROLS_GAP) * density
			caps.set(CAPS_EDGE * density, capsTop, w - CAPS_EDGE * density, min(capsTop + CAPS_HEIGHT * density, controlsTop))
		}

		override fun onDraw(canvas: Canvas) {
			val nowS = CallStage.nowS()
			val live = Calls.stage
			if (live !== drawnStage) {
				// Another call: nothing of the last one's line may fade out over this one.
				drawnStage = live
				shown = null
				shownLayout = null
				leaving = null
				stage.caption = null
				stage.parts = emptyList()
				stage.phase = Phase.Idle
				stage.her = 0.0
				stage.him = 0.0
			}
			live?.read(nowS, stage)
			val dt = (nowS - lastS).coerceIn(0.001, 0.05)
			lastS = nowS
			engine.step(stage.phase, stage.her, stage.him, nowS, dt)
			engine.draw(nowS, Ink.INK, pixels)
			bitmap.setPixels(pixels, 0, PlanetEngine.GRID, 0, 0, PlanetEngine.GRID, PlanetEngine.ROWS)

			fill.color = Ink.INK
			for ((x, y, big) in sky) {
				val size = (if (big) 2 else 1) * density
				val left = x * width / 360f
				val top = (y - STATUS) * height / 726f
				canvas.drawRect(left, top, left + size, top + size, fill)
			}

			val centre = width / 2f
			name.textAlign = Paint.Align.CENTER
			detail.textAlign = Paint.Align.CENTER
			val nameBase = 14 * density - name.fontMetrics.ascent
			canvas.drawText("Janet", centre, nameBase, name)
			canvas.drawText(headerDetail(), centre, nameBase + name.fontMetrics.descent - detail.fontMetrics.ascent, detail)

			canvas.save()
			val scale = engine.scale.toFloat()
			canvas.scale(scale, scale, planet.left + planet.width() * PlanetEngine.ORIGIN_X, planet.top + planet.height() * PlanetEngine.ORIGIN_Y)
			blit.alpha = (engine.alpha * 255).toInt()
			canvas.drawBitmap(bitmap, null, planet, blit)
			canvas.restore()

			if (showText) drawCaption(canvas, nowS)
		}

		private fun headerDetail(): String {
			val since = Calls.activeSinceMs ?: return if (Calls.inCall) "Calling…" else ""
			val seconds = max(0, (SystemClock.elapsedRealtime() - since) / 1000)
			if (seconds != clockSecond) {
				clockSecond = seconds
				clock = "%d:%02d".format(seconds / 60, seconds % 60)
			}
			return if (Calls.route.isEmpty()) clock else "$clock · ${Calls.route}"
		}

		private fun layout(text: String): StaticLayout {
			val width = (caps.width() - 2 * CAPS_PAD * density).toInt().coerceAtLeast(1)
			return StaticLayout.Builder.obtain(text, 0, text.length, words, width)
				.setAlignment(Layout.Alignment.ALIGN_CENTER)
				.setLineSpacing(0f, LINE_HEIGHT * words.textSize / words.getFontMetrics(null))
				.setBreakStrategy(Layout.BREAK_STRATEGY_BALANCED)
				.build()
		}

		private fun room() = caps.height() - 2 * CAPS_TOP * density

		/**
		 * Only the current utterance. When hers outgrows the box, the oldest sentences go first. A
		 * single sentence that is still too tall is drawn from its end, see [drawLayout].
		 */
		private fun fit(parts: List<String>): StaticLayout {
			for (from in parts.indices) {
				val candidate = layout(parts.drop(from).joinToString(" "))
				if (candidate.height <= room() || from == parts.lastIndex) return candidate
			}
			return layout("")
		}

		private fun drawCaption(canvas: Canvas, nowS: Double) {
			// The dark ground keeps stars from sitting behind the words.
			fill.color = Ink.GROUND
			canvas.drawRoundRect(caps, 16 * density, 16 * density, fill)
			val caption = stage.caption
			if (caption != shown) {
				if (caption?.id != shown?.id) {
					leaving = shownLayout
					leavingColor = if (shown?.side == Side.Him) Ink.G2 else Ink.INK
					leavingSinceS = nowS
					shownSinceS = nowS
				}
				shown = caption
				shownLayout = caption?.let { fit(stage.parts) }
			}
			val left = caps.left + CAPS_PAD * density
			val top = caps.top + CAPS_TOP * density
			leaving?.let { old ->
				val fade = 1 - (nowS - leavingSinceS) / FADE_OUT_S
				if (fade <= 0) leaving = null else drawLayout(canvas, old, left, top, leavingColor, fade)
			}
			shownLayout?.let { drawLayout(canvas, it, left, top, if (shown?.side == Side.Him) Ink.G2 else Ink.INK, (nowS - shownSinceS) / FADE_IN_S) }
		}

		private fun drawLayout(canvas: Canvas, layout: StaticLayout, left: Float, top: Float, color: Int, opacity: Double) {
			words.color = color
			words.alpha = (opacity.coerceIn(0.0, 1.0) * 255).toInt()
			// Words never leave the box. Text taller than the box shows its newest lines.
			canvas.save()
			canvas.clipRect(caps)
			canvas.translate(left, top - max(0f, layout.height - room()))
			layout.draw(canvas)
			canvas.restore()
		}
	}

	private companion object {
		const val BUTTON = 78
		const val EDGE = 24
		const val BOTTOM = 24
		const val STATUS = 34
		const val CELL = 3
		const val PLANET_TOP = 40
		const val CAPS_GAP = 18
		const val CAPS_EDGE = 22
		const val CAPS_PAD = 8
		const val CAPS_HEIGHT = 132
		const val CAPS_MIN = 84
		const val CONTROLS_GAP = 16
		const val LINE_HEIGHT = 1.36f
		const val CAPS_TOP = 6

		/** A little under a thirtieth of a second, so every second frame of a 60 Hz display qualifies. */
		const val FRAME_NS = 30_000_000L
		const val FADE_IN_S = 0.2
		const val FADE_OUT_S = 0.38
	}
}
