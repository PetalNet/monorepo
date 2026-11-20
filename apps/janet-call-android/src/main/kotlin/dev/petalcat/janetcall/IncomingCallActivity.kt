package dev.petalcat.janetcall

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telecom.CallAudioState
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.petalcat.janetcall.ui.JanetTheme
import dev.petalcat.janetcall.ui.LocalPalette
import dev.petalcat.janetcall.ui.Type

/** The lockscreen UI also handles headset answers, starting microphone access from a resumed activity. */
class IncomingCallActivity : ComponentActivity() {
	private var state by mutableStateOf<CallState>(CallState.Idle)
	private var callUi by mutableStateOf(CallUi(null, "", false))
	private var problem by mutableStateOf<String?>(null)
	private var answering by mutableStateOf(false)
	private var ringId: String? = null
	private var answerRequested = false
	private var resumed = false
	private val observer: () -> Unit = { refresh() }

	override fun onCreate(savedInstanceState: Bundle?) {
		enableEdgeToEdge()
		super.onCreate(savedInstanceState)
		window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
		if (android.os.Build.VERSION.SDK_INT < 27) {
			@Suppress("DEPRECATION")
			window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
		}
		if (savedInstanceState == null) take(intent) else {
			ringId = savedInstanceState.getString(IncomingCalls.EXTRA_RING_ID)
			answerRequested = savedInstanceState.getBoolean("answerRequested")
		}
		setContent {
			JanetTheme {
				when (val shown = state) {
					is CallState.Ringing -> IncomingCallScreen(shown.ring, ::requestAnswer, {
						if (IncomingCalls.matching(this, ringId) != null) Calls.connection?.onReject()
					}, problem, answering)
					CallState.Connecting, CallState.Active -> CallScreen(callUi, Calls.stage, Calls::mute, {
						Calls.connection?.setRoute(if (Calls.route == "Speaker") CallAudioState.ROUTE_EARPIECE else CallAudioState.ROUTE_SPEAKER)
					}, { Calls.connection?.hangup() })
					is CallState.Ended -> EndedIncomingScreen(shown, ::finish)
					CallState.Idle -> Unit
				}
			}
		}
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		take(intent)
		refresh()
		if (resumed && answerRequested) requestAnswer()
	}

	private fun take(intent: Intent) {
		val id = intent.getStringExtra(IncomingCalls.EXTRA_RING_ID)
		if (id != ringId) {
			problem = null
			answering = false
		}
		ringId = id
		answerRequested = intent.action == JanetConnectionService.ANSWER
		setIntent(Intent(this, IncomingCallActivity::class.java))
	}

	override fun onSaveInstanceState(outState: Bundle) {
		outState.putString(IncomingCalls.EXTRA_RING_ID, ringId)
		outState.putBoolean("answerRequested", answerRequested)
		super.onSaveInstanceState(outState)
	}

	override fun onStart() {
		super.onStart()
		Calls.observe(observer)
		refresh()
	}

	override fun onPostResume() {
		super.onPostResume()
		resumed = true
		if (answerRequested) requestAnswer()
	}

	override fun onPause() {
		resumed = false
		super.onPause()
	}

	override fun onStop() {
		Calls.unobserve(observer)
		super.onStop()
	}

	private fun refresh() {
		if (IncomingCalls.pending?.ring?.id != ringId && Calls.state !is CallState.Ended) {
			finish()
			return
		}
		state = Calls.state
		callUi = CallUi(Calls.activeSinceMs, Calls.route, Calls.muted)
	}

	private fun requestAnswer() {
		answerRequested = false
		val id = ringId ?: return
		if (!resumed || answering || IncomingCalls.matching(this, id) == null || Calls.state !is CallState.Ringing) return
		if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
			requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 31)
			return
		}
		try {
			answering = true
			startForegroundService(Intent(this, JanetConnectionService::class.java)
				.setAction(JanetConnectionService.ANSWER).putExtra(IncomingCalls.EXTRA_RING_ID, id))
		} catch (_: RuntimeException) {
			answering = false
			problem = "Android could not start call audio. Open Janet and check microphone access."
		}
	}

	override fun onRequestPermissionsResult(code: Int, permissions: Array<String>, results: IntArray) {
		super.onRequestPermissionsResult(code, permissions, results)
		if (code != 31) return
		if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
			answerRequested = true
			if (resumed) requestAnswer()
		} else problem = "Microphone access is needed to answer. Allow it in Janet's app settings, or decline this call."
	}

	companion object {
		fun intent(context: Context, id: String, answer: Boolean) = Intent(context, IncomingCallActivity::class.java)
			.setAction(if (answer) JanetConnectionService.ANSWER else "dev.petalcat.janetcall.SHOW_RING")
			.setData(Uri.parse("janetcall-incoming://${if (answer) "answer" else "show"}/$id"))
			.putExtra(IncomingCalls.EXTRA_RING_ID, id)

		fun answer(context: Context, id: String) { context.startActivity(intent(context, id, answer = true)) }
	}
}

@Composable
fun IncomingCallScreen(ring: PendingRing, onAnswer: () -> Unit, onDecline: () -> Unit, problem: String? = null, answering: Boolean = false, ready: Boolean = true) {
	val palette = LocalPalette.current
	Column(Modifier.fillMaxSize().background(palette.ground).statusBarsPadding().navigationBarsPadding().padding(24.dp)) {
		Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.Center) {
			Text("Janet", style = Type.headline, color = palette.ink, modifier = Modifier.semantics { heading() })
			Spacer(Modifier.height(16.dp))
			Text(if (answering) "Answering…" else "Incoming call", style = Type.title, color = palette.g1)
			Spacer(Modifier.height(24.dp))
			Text(ring.reason, style = Type.body, color = palette.ink)
			problem?.let {
				Spacer(Modifier.height(24.dp))
				Text(it, style = Type.body, color = palette.ink)
			}
			Spacer(Modifier.height(24.dp))
		}
		Pill("Answer", onAnswer, enabled = !answering && ready)
		Spacer(Modifier.height(16.dp))
		Pill("Decline", onDecline, filled = false, enabled = ready)
	}
}

@Composable
private fun EndedIncomingScreen(state: CallState.Ended, onClose: () -> Unit) {
	val palette = LocalPalette.current
	Column(Modifier.fillMaxSize().background(palette.ground).statusBarsPadding().navigationBarsPadding().padding(24.dp)) {
		Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.Center) {
			Text("Janet", style = Type.headline, color = palette.ink)
			Spacer(Modifier.height(24.dp))
			Text(state.problem?.message ?: state.reason, style = Type.body, color = palette.ink)
		}
		Pill("Close", onClose)
	}
}
