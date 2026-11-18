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

class JanetConnection(private val onGone: (CallRecord) -> Unit) : Connection() {
	private lateinit var session: CallSession
	private val main = Handler(Looper.getMainLooper())
	private val startedMs = System.currentTimeMillis()
	private var activeAtMs: Long? = null

	fun begin(pairing: Pairing, player: Player, stage: CallStage) {
		connectionProperties = PROPERTY_SELF_MANAGED
		audioModeIsVoip = true
		setAddress(android.net.Uri.parse("sip:janet@janet"), TelecomManager.PRESENTATION_ALLOWED)
		setCallerDisplayName("Janet", TelecomManager.PRESENTATION_ALLOWED)
		setDialing()
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
		)
		session.start()
	}

	private fun disconnect(end: End) {
		if (state == STATE_DISCONNECTED) return
		val (cause, reason) = when (end) {
			End.Local -> DisconnectCause(DisconnectCause.LOCAL) to "Call ended"
			is End.Remote -> DisconnectCause(DisconnectCause.REMOTE, end.reason, end.reason, "janet") to end.reason
			is End.Failed -> DisconnectCause(DisconnectCause.ERROR, "Call failed", end.reason, "janet") to end.reason
		}
		setDisconnected(cause)
		destroy()
		Calls.update(CallState.Ended(reason))
		val connectedFor = activeAtMs?.let { (SystemClock.elapsedRealtime() - it) / 1000 }
		onGone(CallRecord(startedMs, (connectedFor ?: 0).toInt(), connectedFor != null))
	}

	fun hangup() = session.hangup()

	fun setRoute(route: Int) = setAudioRoute(route)

	override fun onDisconnect() = session.hangup()

	override fun onAbort() = session.hangup()

	@Deprecated("Superseded by onCallEndpointChanged on API 34, which is also handled.")
	override fun onCallAudioStateChanged(state: CallAudioState) {
		Calls.update(route = routeName(state.route))
	}

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
	override fun onCreateOutgoingConnection(account: PhoneAccountHandle, request: ConnectionRequest): Connection {
		val pairing = Settings(this).pairing() ?: return failed(NOT_PAIRED)
		startForegroundCall()
		val connection = JanetConnection(onGone = { record ->
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
		Calls.update(CallState.Ended("Android could not place the call"))
	}

	private fun failed(reason: String): Connection {
		Calls.update(CallState.Ended(reason))
		return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR, "Call failed", reason, "janet"))
	}

	private fun startForegroundCall() {
		val manager = getSystemService(NotificationManager::class.java)
		manager.createNotificationChannel(NotificationChannel("call", "Calls", NotificationManager.IMPORTANCE_LOW))
		val notification = android.app.Notification.Builder(this, "call")
			.setSmallIcon(android.R.drawable.sym_action_call)
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
