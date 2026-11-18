package dev.petalcat.janetcall

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.telecom.CallAudioState
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import dev.petalcat.janetcall.ui.JanetTheme

/**
 * Pairing, the home screens ([HomeScreens]), and the call screen ([CallScreen]) while a call is up.
 * Self-managed calls get no system dialer screen, so the app draws its own.
 *
 * A pairing link (`janetcall://pair?u=...`) can come from any app or web page, so nothing is sent or
 * stored until the person confirms the bridge host it names. The confirmation is built so a hostile
 * link cannot land under a habitual tap: a link is only taken when it arrives fresh, never during a
 * call or over another confirmation, and Pair sits apart from Call and Hang up and wakes up late.
 */
class MainActivity : ComponentActivity() {
	private lateinit var content: ComposeView
	private var inCall by mutableStateOf(false)
	private var screen by mutableStateOf<Screen>(Screen.Welcome(null))
	private var callUi by mutableStateOf(CallUi(null, "", false))
	private var callStage by mutableStateOf<CallStage?>(null)
	private val settings by lazy { Settings(this) }
	private val log by lazy { CallLog(this) }
	private val config by lazy { AppConfig(this) }
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
		content = ComposeView(this).apply { setContent { JanetTheme { Root() } } }
		setContentView(content)
		// A restored activity is handed the intent it was first started with. That link was already
		// answered or cancelled, so only a first creation reads it.
		if (savedInstanceState == null) takePairingLink(intent)
	}

	@Composable
	private fun Root() {
		val shown = screen
		var settingsOpen by rememberSaveable { mutableStateOf(false) }
		// A phone that is no longer paired has no settings to leave open.
		if (shown !is Screen.Home) settingsOpen = false
		when {
			inCall -> CallScreen(
				ui = callUi,
				stage = callStage,
				onMute = Calls::mute,
				onSpeaker = ::toggleSpeaker,
				onHangUp = { Calls.connection?.hangup() },
			)
			shown is Screen.Home && settingsOpen -> SettingsScreen(
				host = shown.host,
				homeUrl = config.homeUrl(),
				onHomeUrl = config::setHomeUrl,
				onBack = { settingsOpen = false },
				onUnpair = {
					settingsOpen = false
					unpair()
				},
				licences = { licenceText(this) },
			)
			shown is Screen.Home -> HomeWeb(
				url = config.homeUrl(),
				onCall = ::requestCall,
				onSettings = { settingsOpen = true },
				fallback = { retry -> HomeScreen(shown, onCall = ::requestCall, onSettings = { settingsOpen = true }, onRetry = retry) },
			)
			shown is Screen.Welcome -> WelcomeScreen(shown)
			shown is Screen.Pairing -> PairingScreen(shown)
			shown is Screen.Confirm -> ConfirmScreen(
				shown,
				onPair = { if (SystemClock.elapsedRealtime() - pendingSinceMs >= PAIR_DELAY_MS) pending?.let(::pair) },
				onCancel = {
					pending = null
					render()
				},
			)
		}
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

	private fun render() {
		// A question asked before the call must not be waiting under the first tap after it.
		if (Calls.inCall) pending = null
		inCall = Calls.inCall
		if (inCall) {
			callUi = CallUi(Calls.activeSinceMs, Calls.route, Calls.muted)
			callStage = Calls.stage
			return
		}
		val link = pending
		// Pair stays off for [PAIR_DELAY_MS] after the question appears, so a tap aimed at the screen that
		// was there a moment ago cannot pair the phone.
		val wait = pendingSinceMs + PAIR_DELAY_MS - SystemClock.elapsedRealtime()
		if (link != null && wait > 0) content.postDelayed({ if (pending === link) render() }, wait)
		screen = screenFor(
			pairingWith = Pairer.host,
			link = link,
			pairReady = wait <= 0,
			paired = settings.pairing(),
			notice = Pairer.notice,
			ended = (Calls.state as? CallState.Ended)?.reason,
			recent = log.recent(),
		)
		// An overlay drawn over the confirmation must not be able to pass a tap through to Pair.
		content.filterTouchesWhenObscured = screen is Screen.Confirm
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

	private fun unpair() {
		settings.clear()
		log.clear()
		Pairer.notice = null
		render()
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

	override fun onRequestPermissionsResult(code: Int, permissions: Array<String>, results: IntArray) {
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
