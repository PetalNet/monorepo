package dev.petalcat.janetcall

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.telecom.CallAudioState
import android.telecom.CallEndpoint
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.annotation.RequiresApi

class JanetConnection(private val onGone: (CallRecord) -> Unit) : Connection() {
	private lateinit var session: CallSession
	private val main = Handler(Looper.getMainLooper())
	private val startedMs = System.currentTimeMillis()
	private var activeAtMs: Long? = null
	private val ringback = Ringback()
	private val dropTone = DropTone()

	fun begin(pairing: Pairing, player: Player, stage: CallStage) {
		connectionProperties = PROPERTY_SELF_MANAGED
		audioModeIsVoip = true
		setAddress(android.net.Uri.parse("sip:janet@janet"), TelecomManager.PRESENTATION_ALLOWED)
		setCallerDisplayName("Janet", TelecomManager.PRESENTATION_ALLOWED)
		setDialing()
		// The phone rings back while the call loads, on the call's own stream, so it follows the call to the earpiece or a headset.
		ringback.start()
		session = CallSession(
			pairing,
			micFactory = { MutableMic(TestHooks.micWav?.let(::WavMic) ?: AudioRecordMic()) { Calls.muted } },
			player = player,
			stage = stage,
			onOpen = {
				main.post {
					setActive()
					activeAtMs = SystemClock.elapsedRealtime()
					Calls.update(CallState.Active)
				}
			},
			onEnded = { end -> main.post { disconnect(end) } },
			onFirstAudio = ringback::stop,
		)
		session.start()
	}

	private fun disconnect(end: End) {
		if (state == STATE_DISCONNECTED) return
		val (cause, reason) = when (end) {
			End.Local -> DisconnectCause(DisconnectCause.LOCAL) to "Call ended"
			is End.Remote -> DisconnectCause(DisconnectCause.REMOTE, end.reason, end.reason, "janet") to end.reason
			is End.Dropped -> DisconnectCause(DisconnectCause.ERROR, "Call dropped", end.reason, "janet") to end.reason
			is End.Failed -> DisconnectCause(DisconnectCause.ERROR, "Call failed", end.reason, "janet") to end.reason
		}
		ringback.stop()
		val problem = when (end) {
			is End.Failed -> if (end.repair) Problem.RePair(end.reason) else Problem.CallFailed(end.reason)
			is End.Dropped -> Problem.CallFailed(end.reason)
			else -> null
		}
		val connectedFor = activeAtMs?.let { (SystemClock.elapsedRealtime() - it) / 1000 }
		val record = CallRecord(startedMs, (connectedFor ?: 0).toInt(), connectedFor != null)
		// The screen stays a call until the teardown, so nothing can place a new call while this one is still alive.
		val teardown = {
			Calls.update(CallState.Ended(reason, problem))
			setDisconnected(cause)
			destroy()
			onGone(record)
		}
		// A lost line is announced with a tone on the call's own stream, so the call stays up until it has played.
		if (end is End.Dropped) {
			dropTone.play(main)
			main.postDelayed(teardown, DropTone.DROP_TONE_MS)
		} else {
			teardown()
		}
	}

	fun hangup() = session.hangup()

	fun setRoute(route: Int) = setAudioRoute(route)

	override fun onDisconnect() = session.hangup()

	override fun onAbort() = session.hangup()

	@Deprecated("Superseded by onCallEndpointChanged on API 34, which is also handled.")
	override fun onCallAudioStateChanged(state: CallAudioState) {
		Calls.update(route = routeName(state.route))
	}

	// Android calls this only on API 34 and later, so its body may use the newer API.
	@RequiresApi(34)
	override fun onCallEndpointChanged(callEndpoint: CallEndpoint) {
		Calls.update(
			route = when (callEndpoint.endpointType) {
				CallEndpoint.TYPE_SPEAKER -> "Speaker"
				CallEndpoint.TYPE_BLUETOOTH -> "Bluetooth"
				CallEndpoint.TYPE_WIRED_HEADSET -> "Headset"
				else -> "Earpiece"
			},
		)
	}

	private fun routeName(route: Int) = when (route) {
		CallAudioState.ROUTE_SPEAKER -> "Speaker"
		CallAudioState.ROUTE_BLUETOOTH -> "Bluetooth"
		CallAudioState.ROUTE_WIRED_HEADSET -> "Headset"
		else -> "Earpiece"
	}
}

class JanetConnectionService : ConnectionService() {
	private val hold by lazy { CallHold(this) }

	override fun onDestroy() {
		hold.stop()
		super.onDestroy()
	}

	override fun onCreateOutgoingConnection(account: PhoneAccountHandle, request: ConnectionRequest): Connection {
		val pairing = Settings(this).pairing() ?: return failed(NOT_PAIRED)
		startForegroundCall()
		hold.start()
		val connection = JanetConnection(onGone = { record ->
			hold.stop()
			CallLog(applicationContext).add(record)
			Calls.connection = null
			Calls.stage = null
			stopForeground(STOP_FOREGROUND_REMOVE)
		})
		val stage = CallStage()
		Calls.connection = connection
		Calls.stage = stage
		connection.begin(
			pairing,
			Player(stage) { rate -> TestHooks.playedWav?.let { WavWriter(it, rate) } },
			stage,
		)
		return connection
	}

	override fun onCreateOutgoingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
		Calls.update(CallState.Ended("Android could not place the call", Problem.CallFailed("Android could not place the call.")))
	}

	private fun failed(reason: String): Connection {
		Calls.update(CallState.Ended(reason, Problem.Note(reason)))
		return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR, "Call failed", reason, "janet"))
	}

	private fun startForegroundCall() {
		val manager = getSystemService(NotificationManager::class.java)
		manager.createNotificationChannel(NotificationChannel("call", "Calls", NotificationManager.IMPORTANCE_LOW))
		val notification = android.app.Notification.Builder(this, "call")
			.setSmallIcon(R.drawable.ic_stat_janet)
			.setContentTitle("Call with Janet")
			.setOngoing(true)
			.build()
		if (Build.VERSION.SDK_INT >= 29) {
			startForeground(
				1,
				notification,
				ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
			)
		} else {
			startForeground(1, notification)
		}
	}
}
