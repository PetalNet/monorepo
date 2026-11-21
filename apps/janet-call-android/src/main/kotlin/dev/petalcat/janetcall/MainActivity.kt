package dev.petalcat.janetcall

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
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
	private var incoming by mutableStateOf<PendingRing?>(null)
	private var incomingReady by mutableStateOf(false)
	private var incomingStatus by mutableStateOf("")
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
		// A browser return can recreate a killed activity with saved state. PKCE consumption, not
		// activity restoration, decides whether that return is still valid.
		takeSignIn(intent)
		// A restored activity is handed the intent it was first started with. That link was already
		// answered or cancelled, so only a first creation reads it.
		if (savedInstanceState == null) {
			takePairingLink(intent)
			content.post { takeCallShortcut(intent) }
		}
	}

	@Composable
	private fun Root() {
		val shown = screen
		val ring = incoming
		var settingsOpen by rememberSaveable { mutableStateOf(false) }
		// A phone that is no longer paired has no settings to leave open.
		if (shown !is Screen.Home) settingsOpen = false
		when {
			ring != null -> IncomingCallScreen(
				ring,
				onAnswer = { if (IncomingCalls.matching(this, ring.id) != null) IncomingCallActivity.answer(this, ring.id) },
				onDecline = { if (IncomingCalls.matching(this, ring.id) != null) Calls.connection?.onReject() },
				ready = incomingReady,
			)
			inCall -> CallScreen(
				ui = callUi,
				stage = callStage,
				onMute = Calls::mute,
				onSpeaker = ::toggleSpeaker,
				onHangUp = { Calls.connection?.hangup() },
			)
			SignIn.open -> SignInScreen(
				bridge = settings.pairing()?.url ?: DEFAULT_BRIDGE_URL,
				message = SignIn.message,
				waiting = SignIn.pending(this) != null,
				exchanging = SignIn.exchanging,
				finishing = SignIn.finishing,
				onSignIn = ::startSignIn,
				onCancel = { SignIn.cancel(this) },
				onBack = { SignIn.close(this) },
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
				incomingStatus = incomingStatus,
				onIncomingSetup = { IncomingSetup.openNext(this) },
				onSignIn = { SignIn.show() },
			)
			// Something to fix comes before the page: the page is for when all is well.
			shown is Screen.Home && (shown.problem != null || shown.line == Line.Revoked) -> HomeScreen(
				shown,
				onCall = ::requestCall,
				onSettings = { settingsOpen = true },
				onProblem = ::act,
				onDismiss = ::dismissProblem,
			)
			shown is Screen.Home -> HomeWeb(
				url = config.homeUrl(),
				onCall = ::requestCall,
				onSettings = { settingsOpen = true },
				fallback = { retry ->
					HomeScreen(shown, onCall = ::requestCall, onSettings = { settingsOpen = true }, onProblem = ::act, onRetry = retry)
				},
			)
			shown is Screen.Welcome -> WelcomeScreen(shown, onProblem = ::act, onSignIn = { SignIn.show() })
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
		takeSignIn(intent)
		takePairingLink(intent)
		render()
		takeCallShortcut(intent)
	}

	private fun takeSignIn(intent: Intent) {
		val data = intent.data ?: return
		if (data.scheme != "janetcall" || data.host != "signin") return
		setIntent(Intent(this, MainActivity::class.java))
		if (intent.action != Intent.ACTION_VIEW || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
		SignIn.receive(this, data.toString())
	}

	private fun startSignIn(url: String) {
		if (pending != null) return
		val browser = SignIn.begin(this, url) ?: return
		try {
			startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(browser)).addCategory(Intent.CATEGORY_BROWSABLE))
		} catch (_: android.content.ActivityNotFoundException) {
			SignIn.cancel(this)
			Pairer.problem = Problem.Note("Install a browser, then try signing in again.")
		}
	}

	override fun onStart() {
		super.onStart()
		Calls.observe(observer)
		SignIn.resume(this)
		RingService.sync(this)
		settings.pairing()?.let { Bridge.warmOnForeground(it, SystemClock.elapsedRealtime(), Calls.lineSink(this, it)) }
		render()
	}

	override fun onResume() {
		super.onResume()
		IncomingNotification.channel(this)
		incomingStatus = IncomingSetup.status(this)
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
		Pairer.problem = when {
			Calls.inCall -> Problem.Note("Finish the call first, then open the pairing link again.")
			pending != null || Pairer.host != null || SignIn.open || SignIn.pending(this) != null -> Problem.Note("Another pairing was already waiting. Answer it, then open the new link again.")
			else -> when (val parsed = parsePairingPayload(data.getQueryParameter("u").orEmpty(), nowS(), BuildConfig.DEBUG)) {
				is PairingParse.Bad -> Problem.Note(parsed.reason)
				is PairingParse.Ok -> {
					pending = parsed.link
					pendingSinceMs = SystemClock.elapsedRealtime()
					null
				}
			}
		}
	}

	/**
	 * The launcher shortcut "Call Janet". It starts the call as the Call Janet button does, once, and
	 * never over a pairing question or a call that is already up.
	 */
	private fun takeCallShortcut(intent: Intent) {
		if (intent.action != CALL_SHORTCUT) return
		setIntent(Intent(this, MainActivity::class.java))
		if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
		when {
			// A phone the bridge has forgotten cannot call: the screen says what to do.
			Calls.inCall || pending != null || Pairer.host != null || SignIn.open || Calls.line == Line.Revoked -> Unit
			settings.pairing() == null -> {
				Pairer.problem = Problem.Note("Pair this phone first, then call.")
				render()
			}
			else -> requestCall()
		}
	}

	private fun nowS() = System.currentTimeMillis() / 1000

	private fun render() {
		// A question asked before the call must not be waiting under the first tap after it.
		if (Calls.inCall) pending = null
		inCall = Calls.inCall
		incoming = (Calls.state as? CallState.Ringing)?.ring
		incomingReady = Calls.connection != null
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
		// The microphone problem is over once the permission is back.
		if (Pairer.problem == Problem.NoMicrophone && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
			Pairer.problem = null
		}
		val paired = settings.pairing()
		val ended = Calls.state as? CallState.Ended
		screen = screenFor(
			pairingWith = Pairer.host,
			link = link,
			pairReady = wait <= 0,
			paired = paired,
			// What the last call said is about a pairing that is still there.
			problem = Pairer.problem ?: ended?.problem.takeIf { paired != null },
			ended = ended?.takeIf { it.problem == null }?.reason,
			line = Calls.line,
			recent = log.recent(),
		)
		// An overlay drawn over the confirmation must not be able to pass a tap through to Pair.
		content.filterTouchesWhenObscured = screen is Screen.Confirm
	}

	private fun pair(link: PairingLink) {
		pending = null
		if (link.expired(nowS())) {
			Pairer.problem = Problem.Note(EXPIRED_LINK)
			render()
		} else {
			Pairer.start(this, link)
		}
	}

	private fun unpair() {
		SignIn.close(this)
		// The next person to pair this phone must not inherit the last one's sign-in to the home page.
		forgetWebSession()
		settings.clear()
		log.clear()
		Pairer.problem = null
		Calls.update(CallState.Idle)
		Calls.hearLine(Line.Checking)
		render()
	}

	private fun toggleSpeaker() {
		val speakerOn = Calls.route == "Speaker"
		Calls.connection?.setRoute(if (speakerOn) CallAudioState.ROUTE_EARPIECE else CallAudioState.ROUTE_SPEAKER)
	}

	/** Puts the page back: forgets the problem and how the last call ended. */
	private fun dismissProblem() {
		Pairer.problem = null
		Calls.update(CallState.Idle)
		render()
	}

	/** The one thing a problem card offers to do. */
	private fun act(problem: Problem) {
		when (problem) {
			is Problem.Note -> Unit
			is Problem.PairUnreachable -> pair(problem.link)
			Problem.NoMicrophone -> startActivity(
				Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)),
			)
			is Problem.CallFailed -> requestCall()
			is Problem.RePair -> unpair()
		}
	}

	private fun requestCall() {
		Pairer.problem = null
		val needed = buildList {
			add(Manifest.permission.RECORD_AUDIO)
			if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
		}.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
		if (needed.isEmpty()) placeCall() else requestPermissions(needed.toTypedArray(), 1)
	}

	override fun onRequestPermissionsResult(code: Int, permissions: Array<String>, results: IntArray) {
		super.onRequestPermissionsResult(code, permissions, results)
		if (code == IncomingSetup.PERMISSIONS) {
			incomingStatus = IncomingSetup.status(this)
			RingService.sync(this)
			return
		}
		if (code != 1) return
		if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
			placeCall()
		} else {
			Pairer.problem = Problem.NoMicrophone
			render()
		}
	}

	private fun placeCall() {
		Pairer.problem = Dialer.place(this)
		render()
	}

	private companion object {
		const val PAIR_DELAY_MS = 1000L
		const val CALL_SHORTCUT = "dev.petalcat.janetcall.action.CALL"
	}
}
