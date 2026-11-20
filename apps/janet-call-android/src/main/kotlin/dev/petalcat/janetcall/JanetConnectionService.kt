package dev.petalcat.janetcall

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
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

class JanetConnection(
	private val service: JanetConnectionService,
	private val onGone: (CallRecord) -> Unit,
) : Connection() {
	private var session: CallSession? = null
	private var incoming: IncomingCall? = null
	private var answering = false
	private val main = Handler(Looper.getMainLooper())
	private val startedMs = System.currentTimeMillis()
	private var activeAtMs: Long? = null
	private val ringback = Ringback()
	private val dropTone = DropTone()

	private fun configure() {
		connectionProperties = PROPERTY_SELF_MANAGED
		audioModeIsVoip = true
		setAddress(android.net.Uri.parse("sip:janet@janet"), TelecomManager.PRESENTATION_ALLOWED)
		setCallerDisplayName("Janet", TelecomManager.PRESENTATION_ALLOWED)
	}

	fun ring(call: IncomingCall) {
		configure()
		incoming = call
		setRinging()
		Calls.update()
	}

	fun begin(pairing: Pairing, player: Player, stage: CallStage, ringId: String? = null) {
		configure()
		if (ringId == null) {
			setDialing()
			// Ringback follows the outgoing call to its earpiece or headset.
			ringback.start()
		}
		session = CallSession(
			pairing,
			micFactory = { MutableMic(TestHooks.micWav?.let(::WavMic) ?: AudioRecordMic()) { Calls.muted } },
			player = player,
			stage = stage,
			onOpen = {
				main.post {
					if (state != STATE_DISCONNECTED) {
						setActive()
						activeAtMs = SystemClock.elapsedRealtime()
						Calls.update(CallState.Active)
					}
				}
			},
			onEnded = { end -> main.post { disconnect(end) } },
			onFirstAudio = ringback::stop,
			ringId = ringId,
		)
		session?.start()
	}

	override fun onShowIncomingCallUi() {
		incoming?.takeIf { state == STATE_RINGING && !answering }?.let { IncomingNotification.show(service, it.ring) }
	}

	override fun onAnswer() {
		val call = incoming ?: return
		if (state != STATE_RINGING || session != null || answering) return
		if (IncomingCalls.matching(service, call.ring.id) !== call) {
			expireIncoming()
			return
		}
		answering = true
		IncomingNotification.show(service, call.ring, silent = true)
		// Telecom can answer from Bluetooth with the app in the background. A visible activity starts
		// the microphone service, rather than promoting a background binding with while-in-use audio.
		try {
			service.startActivity(IncomingCallActivity.intent(service, call.ring.id, answer = true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
		} catch (_: RuntimeException) {
			answering = false
		}
	}

	override fun onAnswer(videoState: Int) = onAnswer()

	fun answerFromForeground(id: String) {
		val call = incoming ?: return
		if (call.ring.id != id || session != null || state != STATE_RINGING) return
		if (IncomingCalls.matching(service, id) !== call) {
			expireIncoming()
			return
		}
		try {
			service.startMedia(this, call.pairing, id)
			IncomingCalls.answered(service)
		} catch (_: RuntimeException) {
			IncomingCalls.decline(call.pairing, id)
			disconnect(End.Failed("Open Janet and allow microphone access, then try the call again."))
		}
	}

	override fun onReject() = rejectIncoming(DisconnectCause.REJECTED, "Call declined", decline = true)

	override fun onReject(replyMessage: String?) = onReject()

	@RequiresApi(30)
	override fun onReject(rejectReason: Int) = onReject()

	@RequiresApi(29)
	override fun onSilence() {
		incoming?.takeIf { state == STATE_RINGING }?.let { IncomingNotification.show(service, it.ring, silent = true) }
	}

	fun expireIncoming() = rejectIncoming(DisconnectCause.MISSED, "Missed call from Janet", decline = false)

	private fun rejectIncoming(cause: Int, reason: String, decline: Boolean) {
		val call = incoming ?: return
		if (state == STATE_DISCONNECTED || session != null) return
		if (decline) IncomingCalls.decline(call.pairing, call.ring.id)
		IncomingCalls.clear(service)
		Calls.update(CallState.Ended(reason))
		setDisconnected(DisconnectCause(cause))
		destroy()
		onGone(CallRecord(startedMs, 0, false))
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
		val teardown = {
			IncomingCalls.clear(service)
			Calls.update(CallState.Ended(reason, problem))
			setDisconnected(cause)
			destroy()
			onGone(record)
		}
		if (end is End.Dropped) {
			dropTone.play(main)
			main.postDelayed(teardown, DropTone.DROP_TONE_MS)
		} else teardown()
	}

	fun hangup() {
		val active = session
		if (active == null) onReject() else active.hangup()
	}

	fun setRoute(route: Int) = setAudioRoute(route)

	override fun onDisconnect() = hangup()

	override fun onAbort() = hangup()

	@Deprecated("Superseded by onCallEndpointChanged on API 34, which is also handled.")
	override fun onCallAudioStateChanged(state: CallAudioState) {
		Calls.update(route = routeName(state.route))
	}

	@RequiresApi(34)
	override fun onCallEndpointChanged(callEndpoint: CallEndpoint) {
		Calls.update(route = when (callEndpoint.endpointType) {
			CallEndpoint.TYPE_SPEAKER -> "Speaker"
			CallEndpoint.TYPE_BLUETOOTH -> "Bluetooth"
			CallEndpoint.TYPE_WIRED_HEADSET -> "Headset"
			else -> "Earpiece"
		})
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
		Calls.connection?.hangup()
		hold.stop()
		super.onDestroy()
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		val id = intent?.getStringExtra(IncomingCalls.EXTRA_RING_ID)
		if (intent?.action == ANSWER && id != null && IncomingCalls.matching(this, id) != null && Calls.connection != null) {
			Calls.connection?.answerFromForeground(id)
		} else stopSelf(startId)
		return START_NOT_STICKY
	}

	private fun connection(): JanetConnection = JanetConnection(this, onGone = { record ->
		hold.stop()
		CallLog(applicationContext).add(record)
		Calls.connection = null
		Calls.stage = null
		stopForeground(STOP_FOREGROUND_REMOVE)
		stopSelf()
	})

	override fun onCreateIncomingConnection(account: PhoneAccountHandle, request: ConnectionRequest): Connection {
		val id = request.extras?.getString(IncomingCalls.EXTRA_RING_ID)
		val call = IncomingCalls.matching(this, id)
			?: return Connection.createFailedConnection(DisconnectCause(DisconnectCause.CANCELED))
		if (Calls.connection != null) {
			IncomingCalls.failed(this, id)
			return Connection.createFailedConnection(DisconnectCause(DisconnectCause.BUSY))
		}
		return connection().also {
			Calls.connection = it
			it.ring(call)
			Calls.update()
		}
	}

	override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
		IncomingCalls.failed(this, request?.extras?.getString(IncomingCalls.EXTRA_RING_ID))
	}

	override fun onCreateOutgoingConnection(account: PhoneAccountHandle, request: ConnectionRequest): Connection {
		if (Calls.connection != null || IncomingCalls.pending != null) return Connection.createFailedConnection(DisconnectCause(DisconnectCause.BUSY))
		val pairing = Settings(this).pairing() ?: return failed(NOT_PAIRED)
		val connection = connection()
		Calls.connection = connection
		try { startMedia(connection, pairing) } catch (_: RuntimeException) {
			Calls.connection = null
			hold.stop()
			stopForeground(STOP_FOREGROUND_REMOVE)
			return failed("Android could not start call audio. Open Janet and check microphone access.")
		}
		return connection
	}

	fun startMedia(connection: JanetConnection, pairing: Pairing, ringId: String? = null) {
		startForegroundCall()
		hold.start()
		val stage = CallStage()
		Calls.stage = stage
		Calls.update(CallState.Connecting)
		connection.begin(pairing, Player(stage) { rate -> TestHooks.playedWav?.let { WavWriter(it, rate) } }, stage, ringId)
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
		val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
		val notification = android.app.Notification.Builder(this, "call")
			.setSmallIcon(R.drawable.ic_stat_janet).setContentTitle("Call with Janet")
			.setContentIntent(open).setOngoing(true).build()
		if (Build.VERSION.SDK_INT >= 29) startForeground(1, notification,
			ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
		else startForeground(1, notification)
	}

	companion object {
		const val ANSWER = "dev.petalcat.janetcall.ANSWER"
	}
}
