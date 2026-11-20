package dev.petalcat.janetcall

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** A persistent, non-Google wake path. The subscription topic exists only in this service's memory. */
class RingService : Service() {
	private val main = Handler(Looper.getMainLooper())
	private var generation = 0
	private var destroyed = false
	private var pairing: Pairing? = null
	private var socket: WebSocket? = null
	private var retryMs = 2_000L
	private var registering = false
	private val inbox = RingInbox()
	private val reconnect = Runnable { connect(generation) }
	private val prefs by lazy { getSharedPreferences("janet_call_pairing", Context.MODE_PRIVATE) }
	private val changed = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> reload() }
	private val network = object : ConnectivityManager.NetworkCallback() {
		override fun onAvailable(network: Network) {
			main.post {
				if (!destroyed && pairing != null && socket == null) {
					main.removeCallbacks(reconnect)
					connect(generation)
				}
			}
		}
	}

	override fun onCreate() {
		super.onCreate()
		showStatus("Connecting for incoming calls")
		prefs.registerOnSharedPreferenceChangeListener(changed)
		getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(network)
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		reload()
		return START_STICKY
	}

	private fun reload() {
		IncomingCalls.pairingChanged(this)
		val current = Settings(this).pairing()
		if (current == pairing && current != null) return
		generation++
		main.removeCallbacks(reconnect)
		socket?.cancel()
		socket = null
		pairing = current
		inbox.clear()
		registering = false
		retryMs = 2_000
		if (current == null) {
			stopForeground(STOP_FOREGROUND_REMOVE)
			stopSelf()
		} else connect(generation)
	}

	private fun current(epoch: Int, device: Pairing) =
		!destroyed && generation == epoch && pairing == device && Settings(this).pairing() == device

	private fun connect(epoch: Int) {
		val device = pairing ?: return
		if (!current(epoch, device) || socket != null || registering) return
		registering = true
		showStatus("Connecting for incoming calls")
		RingWork.run {
			val registration = Bridge.registerRing(device)
			main.post {
				if (!current(epoch, device)) return@post
				registering = false
				if (registration == null) retry() else {
					socket = Bridge.http.newWebSocket(Request.Builder().url(registration.socketUrl).build(), Subscription(epoch, device))
				}
			}
		}
	}

	private inner class Subscription(private val epoch: Int, private val device: Pairing) : WebSocketListener() {
		override fun onOpen(webSocket: WebSocket, response: Response) {
			main.post {
				if (!current(epoch, device) || socket !== webSocket) webSocket.cancel() else {
					retryMs = 2_000
					showStatus("Listening for incoming calls")
				}
			}
		}

		override fun onMessage(webSocket: WebSocket, text: String) {
			val notice = parseRingNotice(text, System.currentTimeMillis() / 1000) ?: return
			main.post {
				if (current(epoch, device) && socket === webSocket) {
					inbox.offer(notice)
					validate(epoch, device)
				}
			}
		}

		private fun lost(webSocket: WebSocket) {
			main.post {
				if (!current(epoch, device) || socket !== webSocket) return@post
				socket = null
				retry()
			}
		}

		override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
			webSocket.close(1000, null)
			lost(webSocket)
		}

		override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lost(webSocket)
	}

	private fun validate(epoch: Int, device: Pairing) {
		if (!current(epoch, device)) return
		val notice = inbox.next(System.currentTimeMillis() / 1000) ?: return
		val wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "janetcall:ring-check")
		wake.setReferenceCounted(false)
		wake.acquire(30_000)
		RingWork.run {
			val answer = try {
				Bridge.pendingRing(device, notice.id, System.currentTimeMillis() / 1000)
			} catch (_: RuntimeException) {
				RingCheck.Retry
			}
			main.post {
				try {
					if (current(epoch, device)) {
						inbox.complete(notice.id, retry = answer is RingCheck.Retry)
						if (answer is RingCheck.Live) IncomingCalls.offer(this, device, answer.ring)
						if (answer is RingCheck.Retry) main.postDelayed({ validate(epoch, device) }, 1_000)
						else validate(epoch, device)
					}
				} finally {
					if (wake.isHeld) wake.release()
				}
			}
		}
	}

	private fun retry() {
		showStatus("Reconnecting for incoming calls")
		main.removeCallbacks(reconnect)
		main.postDelayed(reconnect, retryMs)
		retryMs = (retryMs * 2).coerceAtMost(60_000)
	}

	private fun showStatus(status: String) {
		val manager = getSystemService(NotificationManager::class.java)
		manager.createNotificationChannel(NotificationChannel("ring-listener", "Incoming call connection", NotificationManager.IMPORTANCE_LOW))
		val open = PendingIntent.getActivity(this, 20, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
		val notification = Notification.Builder(this, "ring-listener")
			.setSmallIcon(R.drawable.ic_stat_janet).setContentTitle("Janet").setContentText(status)
			.setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).build()
		if (Build.VERSION.SDK_INT >= 34) startForeground(2, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
		else startForeground(2, notification)
	}

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onDestroy() {
		destroyed = true
		generation++
		prefs.unregisterOnSharedPreferenceChangeListener(changed)
		getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(network)
		main.removeCallbacksAndMessages(null)
		socket?.cancel()
		socket = null
		pairing = null
		super.onDestroy()
	}

	companion object {
		fun sync(context: Context) {
			val app = context.applicationContext
			val sync: () -> Unit = {
				IncomingCalls.pairingChanged(app)
				val intent = Intent(app, RingService::class.java)
				if (Settings(app).pairing() == null) app.stopService(intent) else {
					// Pairing can finish after the activity leaves. A visible launch or reboot retries this.
					try { app.startForegroundService(intent) } catch (_: IllegalStateException) { }
				}
			}
			if (Looper.myLooper() == Looper.getMainLooper()) sync() else Handler(Looper.getMainLooper()).post { sync() }
		}
	}
}

class RingBootReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) RingService.sync(context)
	}
}
