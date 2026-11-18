package dev.petalcat.janetcall

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.os.SystemClock
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.util.TypedValue
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.petalcat.janetcall.ui.LocalPalette
import dev.petalcat.janetcall.ui.Palette
import dev.petalcat.janetcall.ui.Type
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.delay

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

/** The call screen draws at most one frame in this long: a little under a thirtieth of a second, so every second vsync of a 60 Hz display qualifies. */
const val FRAME_MS = 30L

/** After a slow frame, the call screen draws nothing for this many times as long as the frame took. */
const val FRAME_YIELD = 3L

/**
 * How long the call screen waits after a frame before it asks for the next one. [busyMs] is how
 * long the frame took, from its vsync to the end of drawing. A quick frame is followed [FRAME_MS]
 * after its vsync. A slow one means the phone is short of CPU, and the call's audio needs what
 * there is: the wait grows with the frame, so the planet slows down and the microphone does not.
 */
fun frameGapMs(busyMs: Long): Long = max(FRAME_MS - busyMs, FRAME_YIELD * busyMs)

/** What the call screen shows besides the live [CallStage]. [sinceMs] is on the elapsed-realtime clock, null until the call connects. */
data class CallUi(val sinceMs: Long?, val route: String, val muted: Boolean)

/** The word under Janet's name for what the call is doing right now. */
fun callStatus(connected: Boolean, muted: Boolean, phase: Phase): String = when {
	!connected -> "Calling…"
	muted -> "Muted"
	phase == Phase.Thinking -> "Thinking"
	phase == Phase.Speaking -> "Speaking"
	else -> "Listening"
}

/**
 * The call screen: the planet is the whole interface. Under it, the level meter and one centred
 * transcript line, hers bright and his gray, with no labels. Controls: mute, Hide or Show text,
 * hang up, and the speaker in the top corner.
 */
@Composable
fun CallScreen(
	ui: CallUi,
	stage: CallStage?,
	onMute: (Boolean) -> Unit,
	onSpeaker: () -> Unit,
	onHangUp: () -> Unit,
	clock: () -> Double = CallStage::nowS,
) {
	val palette = LocalPalette.current
	val view = LocalView.current
	val density = LocalDensity.current
	var showText by rememberSaveable { mutableStateOf(true) }
	var phase by remember { mutableStateOf(Phase.Idle) }
	val connected = ui.sinceMs != null
	val elapsed by produceState(0L, ui.sinceMs) {
		while (ui.sinceMs != null) {
			value = max(0L, (SystemClock.elapsedRealtime() - ui.sinceMs) / 1000)
			delay(250)
		}
	}

	// Self-managed calls get no proximity sensor handling from the system, and the screen is the call.
	DisposableEffect(view) {
		view.keepScreenOn = true
		onDispose { view.keepScreenOn = false }
	}
	LaunchedEffect(connected) { if (connected) view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) }

	val topInset = WindowInsets.statusBars.getTop(density)
	val bottomInset = WindowInsets.navigationBars.getBottom(density)
	Box(Modifier.fillMaxSize().background(palette.ground)) {
		AndroidView(
			modifier = Modifier.fillMaxSize(),
			factory = { CallSky(it) },
			update = { sky ->
				sky.palette = palette
				sky.stage = stage
				sky.clock = clock
				sky.showText = showText
				sky.onPhase = { phase = it }
				sky.inset(topInset, bottomInset)
			},
		)
		Column(
			Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 14.dp),
			horizontalAlignment = Alignment.CenterHorizontally,
		) {
			Text("Janet", style = Type.name, color = palette.ink)
			val status = callStatus(connected, ui.muted, phase)
			Text(
				if (connected) "%d:%02d · %s".format(elapsed / 60, elapsed % 60, status) else status,
				style = Type.detail,
				color = palette.g2,
			)
		}
		if (ui.route.isNotEmpty()) {
			val speaker = ui.route == "Speaker"
			RoundButton(
				icon = R.drawable.ic_speaker,
				label = if (speaker) "Speaker, on" else "Speaker, off. Sound is on ${ui.route}",
				size = 48,
				iconSize = 20,
				filled = speaker,
				modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = 8.dp, end = 16.dp),
				onClick = onSpeaker,
			)
		}
		Row(
			Modifier.align(Alignment.BottomCenter).navigationBarsPadding().fillMaxWidth()
				.padding(start = EDGE.dp, end = EDGE.dp, bottom = BOTTOM.dp),
			horizontalArrangement = Arrangement.SpaceBetween,
			verticalAlignment = Alignment.CenterVertically,
		) {
			RoundButton(
				icon = if (ui.muted) R.drawable.ic_mic_off else R.drawable.ic_mic,
				label = if (ui.muted) "Microphone, muted" else "Microphone, on",
				size = BUTTON,
				iconSize = 29,
				filled = ui.muted,
				onClick = { onMute(!ui.muted) },
			)
			Box(
				Modifier.height(56.dp).clip(CircleShape).border(BorderStroke(1.dp, palette.hair2), CircleShape)
					.clickable(role = Role.Button) { showText = !showText }.padding(horizontal = 22.dp),
				contentAlignment = Alignment.Center,
			) {
				Text(if (showText) "Hide text" else "Show text", style = Type.pill, color = palette.g1)
			}
			RoundButton(
				icon = R.drawable.ic_end,
				label = "Hang up",
				size = BUTTON,
				iconSize = 31,
				filled = true,
				onClick = {
					view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
					onHangUp()
				},
			)
		}
	}
}

/** A round control. Filled is ink on the ground's colour: the hang-up button, and a toggle that is on. */
@Composable
fun RoundButton(
	icon: Int,
	label: String,
	size: Int,
	iconSize: Int,
	filled: Boolean,
	modifier: Modifier = Modifier,
	onClick: () -> Unit,
) {
	val palette = LocalPalette.current
	Box(
		modifier.size(size.dp).clip(CircleShape).background(if (filled) palette.ink else palette.tint)
			.clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = label },
		contentAlignment = Alignment.Center,
	) {
		Icon(painterResource(icon), null, Modifier.size(iconSize.dp), tint = if (filled) palette.onInk else palette.ink)
	}
}

/** Everything on the call screen that is drawn rather than tapped: stars, the planet with its meter, the transcript. */
class CallSky(context: Context) : View(context) {
	var showText = true
		set(value) {
			field = value
			invalidate()
		}

	/** The call to draw, or null for a quiet sky. */
	var stage: CallStage? = null

	/** Seconds on the clock the stage's times are on. A test swaps it to draw a chosen instant. */
	var clock: () -> Double = CallStage::nowS

	/** Told when the call moves between listening, thinking and speaking. */
	var onPhase: (Phase) -> Unit = {}

	var palette: Palette = dev.petalcat.janetcall.ui.DarkPalette
		set(value) {
			field = value
			ground = value.ground.toArgb()
			ink = value.ink.toArgb()
			gray = value.g2.toArgb()
			invalidate()
		}

	private var ground = palette.ground.toArgb()
	private var ink = palette.ink.toArgb()
	private var gray = palette.g2.toArgb()
	private val engine = PlanetEngine(context.resources.openRawResource(R.raw.planet_lit).use { it.readBytes() })
	private val pixels = IntArray(PlanetEngine.GRID * PlanetEngine.ROWS)
	private val bitmap = Bitmap.createBitmap(PlanetEngine.GRID, PlanetEngine.ROWS, Bitmap.Config.ARGB_8888)
	private val sky = stars(29, 30, 180.0, 250.0, 170.0)
	private val density = resources.displayMetrics.density
	private val fill = Paint()
	private val blit = Paint().apply { isFilterBitmap = false }
	private val words = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
		textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 18f, resources.displayMetrics)
		typeface = resources.getFont(R.font.geist)
		fontVariationSettings = "'wght' 500"
	}
	private val planet = RectF()
	private val caps = RectF()
	private var topInset = 0
	private var bottomInset = 0
	private var lastS = 0.0
	private val view = StageView()
	private var drawnStage: CallStage? = null
	private var told: Phase? = null

	/** Every frame that is drawn asks for the next one, so nothing runs while the screen is not drawn. */
	private val nextFrame = Runnable { invalidate() }

	private var shown: Caption? = null
	private var shownLayout: StaticLayout? = null
	private var shownSinceS = 0.0
	private var leaving: StaticLayout? = null
	private var leavingColor = 0
	private var leavingSinceS = 0.0

	/** The system bars' heights in pixels. The sky runs under both; the planet and the words stay clear of them. */
	fun inset(top: Int, bottom: Int) {
		if (top == topInset && bottom == bottomInset) return
		topInset = top
		bottomInset = bottom
		place(width, height)
		invalidate()
	}

	override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) = place(w, h)

	/**
	 * The reference lays out a 360 x 726 dp area under the status bar: the planet grid from 40 dp
	 * down, the transcript 18 dp under it, the controls at the bottom. The cell is a whole number of
	 * pixels, so the grid stays crisp: as large as the width allows up to [CELL] dp, smaller on a
	 * short screen. Height the reference does not have is shared above the planet and over the controls.
	 */
	private fun place(w: Int, h: Int) {
		val controlsTop = h - bottomInset - (BOTTOM + BUTTON + CONTROLS_GAP) * density
		val planetTop = topInset + PLANET_TOP * density
		val cell = floor(
			min(
				CELL * density,
				min(
					(w - 2 * CAPS_EDGE * density) / PlanetEngine.GRID,
					(controlsTop - planetTop - (CAPS_GAP + CAPS_MIN) * density) / PlanetEngine.ROWS,
				),
			),
		).coerceAtLeast(1f)
		val block = cell * PlanetEngine.ROWS + (CAPS_GAP + CAPS_HEIGHT) * density
		val left = floor((w - cell * PlanetEngine.GRID) / 2)
		val top = floor(planetTop + max(0f, controlsTop - planetTop - block) * SLACK_ABOVE)
		planet.set(left, top, left + cell * PlanetEngine.GRID, top + cell * PlanetEngine.ROWS)
		val capsTop = planet.bottom + CAPS_GAP * density
		caps.set(CAPS_EDGE * density, capsTop, w - CAPS_EDGE * density, min(capsTop + CAPS_HEIGHT * density, controlsTop))
	}

	override fun onDraw(canvas: Canvas) {
		val nowS = clock()
		val live = stage
		if (live !== drawnStage) {
			// Another call: nothing of the last one's line may fade out over this one.
			drawnStage = live
			shown = null
			shownLayout = null
			leaving = null
			view.caption = null
			view.parts = emptyList()
			view.phase = Phase.Idle
			view.her = 0.0
			view.him = 0.0
		}
		live?.read(nowS, view)
		if (view.phase != told) {
			told = view.phase
			onPhase(view.phase)
		}
		val dt = (nowS - lastS).coerceIn(0.001, 0.05)
		lastS = nowS
		engine.step(view.phase, view.her, view.him, nowS, dt)
		engine.draw(nowS, ink, pixels)
		bitmap.setPixels(pixels, 0, PlanetEngine.GRID, 0, 0, PlanetEngine.GRID, PlanetEngine.ROWS)

		fill.color = ink
		for ((x, y, big) in sky) {
			val size = (if (big) 2 else 1) * density
			val left = x * width / 360f
			val top = topInset + (y - STATUS) * (height - topInset) / 726f
			canvas.drawRect(left, top, left + size, top + size, fill)
		}

		canvas.save()
		val scale = engine.scale.toFloat()
		canvas.scale(scale, scale, planet.left + planet.width() * PlanetEngine.ORIGIN_X, planet.top + planet.height() * PlanetEngine.ORIGIN_Y)
		blit.alpha = (engine.alpha * 255).toInt()
		canvas.drawBitmap(bitmap, null, planet, blit)
		canvas.restore()

		if (showText) drawCaption(canvas, nowS)

		removeCallbacks(nextFrame)
		postDelayed(nextFrame, frameGapMs(SystemClock.uptimeMillis() - drawingTime))
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
		fill.color = ground
		canvas.drawRoundRect(caps, 16 * density, 16 * density, fill)
		val caption = view.caption
		if (caption != shown) {
			if (caption?.id != shown?.id) {
				leaving = shownLayout
				leavingColor = if (shown?.side == Side.Him) gray else ink
				leavingSinceS = nowS
				shownSinceS = nowS
			}
			shown = caption
			shownLayout = caption?.let { fit(view.parts) }
		}
		val left = caps.left + CAPS_PAD * density
		val top = caps.top + CAPS_TOP * density
		leaving?.let { old ->
			val fade = 1 - (nowS - leavingSinceS) / FADE_OUT_S
			if (fade <= 0) leaving = null else drawLayout(canvas, old, left, top, leavingColor, fade)
		}
		shownLayout?.let { drawLayout(canvas, it, left, top, if (shown?.side == Side.Him) gray else ink, (nowS - shownSinceS) / FADE_IN_S) }
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

	private companion object {
		const val STATUS = 34
		const val CELL = 4
		const val PLANET_TOP = 40
		const val CAPS_GAP = 18
		const val CAPS_EDGE = 22
		const val CAPS_PAD = 8
		const val CAPS_HEIGHT = 132
		const val CAPS_MIN = 84
		const val CONTROLS_GAP = 16
		const val LINE_HEIGHT = 1.36f
		const val CAPS_TOP = 6
		const val FADE_IN_S = 0.2
		const val FADE_OUT_S = 0.38

		/** How much of the spare height on a tall screen goes above the planet. The rest sits over the controls. */
		const val SLACK_ABOVE = 0.35f
	}
}

private const val BUTTON = 78
private const val EDGE = 24
private const val BOTTOM = 24
