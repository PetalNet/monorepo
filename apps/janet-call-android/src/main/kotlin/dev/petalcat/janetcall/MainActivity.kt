package dev.petalcat.janetcall

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.telecom.CallAudioState
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import dev.petalcat.janetcall.ui.JanetTheme

/**
 * Pairing, the home screen, and the call screen ([CallScreen]) while a call is up. Self-managed
 * calls get no system dialer screen, so the app draws its own.
 *
 * A pairing link (`janetcall://pair?u=...`) can come from any app or web page, so nothing is sent or
 * stored until the person confirms the bridge host it names. The confirmation is built so a hostile
 * link cannot land under a habitual tap: a link is only taken when it arrives fresh, never during a
 * call or over another confirmation, and Pair sits apart from Call and Hang up and wakes up late.
 */
class MainActivity : ComponentActivity() {
	private lateinit var title: TextView
	private lateinit var body: TextView
	private lateinit var primary: Button
	private lateinit var secondary: Button
	private lateinit var home: View
	private lateinit var callScreen: ComposeView
	private var callUi by mutableStateOf(CallUi(null, "", false))
	private var callStage by mutableStateOf<CallStage?>(null)
	private val settings by lazy { Settings(this) }
	private val observer: () -> Unit = { render() }

	/**
	 * The link waiting for a yes or no. It holds the one-time code, so it is never written to saved
	 * state: an activity recreated mid-confirmation drops the question.
	 */
	private var pending: PairingLink? = null
	private var pendingSinceMs = 0L

	override fun onCreate(savedInstanceState: Bundle?) {
		enableEdgeToEdge()
		super.onCreate(savedInstanceState)
		val dp = resources.displayMetrics.density
		fun pad(v: Int) = (v * dp).toInt()

		title = TextView(this).apply { textSize = 22f }
		body = TextView(this).apply {
			textSize = 16f
			setPadding(0, pad(8), 0, pad(20))
		}
		primary = Button(this)
		// An overlay drawn over the confirmation must not be able to pass a tap through to Pair.
		secondary = Button(this).apply { filterTouchesWhenObscured = true }
		val column = LinearLayout(this).apply {
			orientation = LinearLayout.VERTICAL
			setPadding(pad(20), pad(24), pad(20), pad(24))
			listOf(title, body, primary, secondary).forEach(::addView)
		}
		home = column
		callScreen = ComposeView(this).apply {
			setContent {
				JanetTheme {
					CallScreen(
						ui = callUi,
						stage = callStage,
						onMute = Calls::mute,
						onSpeaker = ::toggleSpeaker,
						onHangUp = { Calls.connection?.hangup() },
					)
				}
			}
		}
		setContentView(FrameLayout(this).apply {
			addView(column)
			addView(callScreen)
		})
		// The call screen runs under the system bars. The home column keeps clear of them.
		column.setOnApplyWindowInsetsListener { v, insets ->
			v.setPadding(pad(20), pad(24) + insets.systemWindowInsetTop, pad(20), pad(24) + insets.systemWindowInsetBottom)
			insets
		}
		// A restored activity is handed the intent it was first started with. That link was already
		// answered or cancelled, so only a first creation reads it.
		if (savedInstanceState == null) takePairingLink(intent)
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		takePairingLink(intent)
		render()
	}

	override fun onStart() {
		super.onStart()
		Calls.observe(observer)
		settings.pairing()?.let { Bridge.warmOnForeground(it, SystemClock.elapsedRealtime()) }
		render()
	}

	override fun onStop() {
		Calls.unobserve(observer)
		super.onStop()
	}

	private fun takePairingLink(intent: Intent) {
		val data = intent.data ?: return
		setIntent(Intent(this, MainActivity::class.java))
		if (intent.action != Intent.ACTION_VIEW || data.scheme != "janetcall" || data.host != "pair") return
		// Reopening the app from recents replays the old link. Only a link opened just now counts.
		if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
		// A link is never held to be shown later, when the person no longer expects it.
		Pairer.notice = when {
			Calls.inCall -> "Finish the call first, then open the pairing link again."
			pending != null || Pairer.host != null -> "Another pairing was already waiting. Answer it, then open the new link again."
			else -> when (val parsed = parsePairingPayload(data.getQueryParameter("u").orEmpty(), nowS(), BuildConfig.DEBUG)) {
				is PairingParse.Bad -> parsed.reason
				is PairingParse.Ok -> {
					pending = parsed.link
					pendingSinceMs = SystemClock.elapsedRealtime()
					null
				}
			}
		}
	}

	private fun nowS() = System.currentTimeMillis() / 1000

	private fun show(heading: String, text: String, first: Pair<String, () -> Unit>?, second: Pair<String, () -> Unit>?) {
		title.text = heading
		body.text = text
		listOf(primary to first, secondary to second).forEach { (button, action) ->
			button.visibility = if (action == null) View.GONE else View.VISIBLE
			button.isEnabled = true
			button.text = action?.first
			button.setOnClickListener { action?.second?.invoke() }
		}
	}

	private fun render() {
		val state = Calls.state
		// A question asked before the call must not be waiting under the first tap after it.
		if (Calls.inCall) pending = null
		val link = pending
		val pairing = settings.pairing()
		val pairingWith = Pairer.host
		callScreen.visibility = if (Calls.inCall) View.VISIBLE else View.GONE
		home.visibility = if (Calls.inCall) View.GONE else View.VISIBLE
		when {
			Calls.inCall -> {
				callUi = CallUi(Calls.activeSinceMs, Calls.route, Calls.muted)
				callStage = Calls.stage
			}
			pairingWith != null -> show("Pairing with $pairingWith…", "", null, null)
			link != null -> confirm(link, pairing)
			pairing == null -> show(
				"Not paired",
				Pairer.notice ?: "Open a Janet Call pairing link on this phone.",
				null,
				null,
			)
			else -> show(
				pairing.host,
				Pairer.notice ?: (state as? CallState.Ended)?.reason ?: "Ready",
				"Call Janet" to { requestCall() },
				"Unpair" to { confirmUnpair() },
			)
		}
	}

	/**
	 * Cancel takes the slot where Call Janet and Hang up sit, and Pair stays off for [PAIR_DELAY_MS],
	 * so a tap aimed at the screen that was there a moment ago cannot pair the phone.
	 */
	private fun confirm(link: PairingLink, current: Pairing?) {
		show(
			"Pair this phone with ${link.host}?",
			"Janet Call will place its calls through ${link.host}" +
				(if (current != null) ", in place of ${current.host}" else "") +
				". Continue only if you asked for this pairing link.",
			"Cancel" to {
				pending = null
				render()
			},
			"Pair" to { pair(link) },
		)
		val wait = pendingSinceMs + PAIR_DELAY_MS - SystemClock.elapsedRealtime()
		secondary.isEnabled = wait <= 0
		if (wait > 0) secondary.postDelayed({ if (pending === link) render() }, wait)
	}

	private fun pair(link: PairingLink) {
		pending = null
		if (link.expired(nowS())) {
			Pairer.notice = EXPIRED_LINK
			render()
		} else {
			Pairer.start(this, link)
		}
	}

	private fun confirmUnpair() {
		AlertDialog.Builder(this)
			.setMessage("Unpair this phone? To call Janet again you will need a new pairing link.")
			.setPositiveButton("Unpair") { _, _ ->
				settings.clear()
				Pairer.notice = null
				render()
			}
			.setNegativeButton("Cancel", null)
			.show()
	}

	private fun toggleSpeaker() {
		val speakerOn = Calls.route == "Speaker"
		Calls.connection?.setRoute(if (speakerOn) CallAudioState.ROUTE_EARPIECE else CallAudioState.ROUTE_SPEAKER)
	}

	private fun requestCall() {
		val needed = buildList {
			add(Manifest.permission.RECORD_AUDIO)
			if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
		}.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
		if (needed.isEmpty()) placeCall() else requestPermissions(needed.toTypedArray(), 1)
	}

	override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
		super.onRequestPermissionsResult(code, permissions, results)
		if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
			placeCall()
		} else {
			Pairer.notice = "Janet needs the microphone to take a call"
			render()
		}
	}

	private fun placeCall() {
		Pairer.notice = Dialer.place(this)
		render()
	}

	private companion object {
		const val PAIR_DELAY_MS = 1000L
	}
}
