package dev.petalcat.point_app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import io.flutter.FlutterInjector
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugins.GeneratedPluginRegistrant

/**
 * Point's OWN persistent location foreground service (DEFECT #2).
 *
 * This is the service we control, run for the whole sharing session and
 * deliberately decoupled from geolocator's position stream. geolocator caches
 * its stream and ignores new LocationSettings while a listener is active, so the
 * engine must fully cancel + reopen the stream to change GPS cadence — and if
 * geolocator owned the FGS, that cancel would tear the FGS down and Android 12+
 * would refuse to restart a foreground-service-with-location from the
 * background (the "leave home → go dark" bug). By running our own FGS that never
 * drops across those cancel→reopen cycles, the process stays foreground-promoted
 * and background location keeps flowing while cadence adapts.
 *
 * START_STICKY + [BootReceiver] give R9: after an OS memory-kill the system
 * restarts this service (null intent), and after a reboot the boot receiver
 * restarts it when an active share is persisted. When it comes up without the
 * app's Flutter engine attached, it hosts a headless engine that re-establishes
 * the Dart location engine so a killed/rebooted phone resumes sharing without
 * the user reopening the app.
 */
class PointForegroundService : Service() {
    companion object {
        const val ACTION_START = "dev.petalcat.point.action.FGS_START"
        const val ACTION_STOP = "dev.petalcat.point.action.FGS_STOP"

        private const val TAG = "PointFGS"
        private const val CHANNEL_ID = "point_location_sharing"
        private const val NOTIFICATION_ID = 74010
        private const val WAKELOCK_TAG = "point:location_fgs"

        const val PREFS = "point_fgs"
        const val KEY_ACTIVE_SHARE = "active_share"

        /**
         * Set true while the app's own Flutter engine is alive (see
         * [MainActivity]). When it is, a (re)start of this service must NOT spin
         * a second, headless engine — the app is already driving the Dart
         * location engine. It is false in a fresh process brought up by boot /
         * sticky-restart, which is exactly when we DO want the headless engine.
         */
        @Volatile
        var appEngineAttached: Boolean = false

        /**
         * Request a start of the foreground service. Returns whether the OS
         * ACCEPTED the start (Defect #5). On Android 12+ a
         * foreground-service-with-location start from the background is refused
         * with `ForegroundServiceStartNotAllowedException`, thrown synchronously
         * here — caught so it never crashes the caller, and reported as `false`
         * so the Dart engine re-arms instead of latching a dead FGS.
         */
        fun start(context: Context): Boolean {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_ACTIVE_SHARE, true).apply()
            val intent = Intent(context, PointForegroundService::class.java)
                .setAction(ACTION_START)
            return try {
                androidx.core.content.ContextCompat.startForegroundService(context, intent)
                true
            } catch (e: Throwable) {
                Log.e(TAG, "startForegroundService refused", e)
                false
            }
        }

        fun stop(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_ACTIVE_SHARE, false).apply()
            val intent = Intent(context, PointForegroundService::class.java)
                .setAction(ACTION_STOP)
            context.startService(intent)
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var backgroundEngine: FlutterEngine? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Log.d(TAG, "stop requested")
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }

        // Promote FIRST (a started FGS must call startForeground within seconds).
        // Defect #5: if the OS refuses the promotion (Android 12+ background
        // FGS-with-location block), stop cleanly rather than lingering as a
        // killable non-foreground service — the Dart engine confirms the start
        // over the channel and re-arms, retrying when the OS next allows it.
        if (!promoteToForeground()) {
            Log.e(TAG, "foreground promotion refused — stopping (engine will re-arm)")
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        acquireWakeLock()

        // A null intent means the OS restarted us (START_STICKY) after a kill; an
        // ACTION_START from BootReceiver means a reboot. In both cases the app's
        // engine is not attached, so re-establish the Dart engine headless (R9).
        if (!appEngineAttached && backgroundEngine == null) {
            Log.d(TAG, "no app engine attached — starting headless engine (R9)")
            startHeadlessEngine()
        } else if (appEngineAttached && backgroundEngine != null) {
            // Defect #3 — double-engine leak. A boot / sticky-restart brought up
            // the headless R9 engine (isolate A); now the app has opened
            // (MainActivity set appEngineAttached) and re-invoked start with its
            // own engine (isolate B) driving sampling. Two engines on one session
            // = two GPS streams, two relays, two WS, and two MLS clients mutating
            // the SAME secure storage concurrently (crypto-corruption hazard).
            // Tear the headless one down; the app's engine owns the session now.
            Log.d(TAG, "app engine attached — tearing down headless engine (R9 double-engine)")
            teardownBackgroundEngine()
        }

        return START_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        teardownBackgroundEngine()
        super.onDestroy()
    }

    private fun teardownBackgroundEngine() {
        backgroundEngine?.let {
            it.serviceControlSurface.detachFromService()
            it.destroy()
        }
        backgroundEngine = null
    }

    /**
     * Promote to a foreground service. Returns whether promotion SUCCEEDED
     * (Defect #5): the in-service `startForeground` can also be refused on
     * Android 12+, and an uncaught throw here crashes the process and kills the
     * service → Doze go-dark. Caught, logged, reported so the caller stops
     * cleanly and the Dart engine re-arms.
     */
    private fun promoteToForeground(): Boolean {
        createChannel()
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Point")
            .setContentText("Sharing your location")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        val type =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            } else {
                0
            }
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
            true
        } catch (e: Throwable) {
            // Android 12+ can refuse a foreground-service-with-location start from
            // the background (ForegroundServiceStartNotAllowedException). Swallow
            // so it never crashes the process; the caller stops the service.
            Log.e(TAG, "startForeground refused", e)
            false
        }
    }

    private fun stopForegroundCompat() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Location sharing",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shows while Point is sharing your location."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    /**
     * Host a headless Flutter engine running the dedicated background entrypoint
     * (`pointBackgroundMain`, `@pragma('vm:entry-point')`) so the Dart location
     * engine + relay re-establish without a UI. Registers the app's plugins so
     * geolocator / secure-storage / the platform channels work in this engine.
     */
    private fun startHeadlessEngine() {
        try {
            val loader = FlutterInjector.instance().flutterLoader()
            loader.startInitialization(applicationContext)
            loader.ensureInitializationComplete(applicationContext, null)

            val engine = FlutterEngine(applicationContext)
            engine.serviceControlSurface.attachToService(this, null, true)
            GeneratedPluginRegistrant.registerWith(engine)
            val entrypoint = DartExecutor.DartEntrypoint(
                loader.findAppBundlePath(),
                "package:point_app/background_engine_main.dart",
                "pointBackgroundMain",
            )
            engine.dartExecutor.executeDartEntrypoint(entrypoint)
            backgroundEngine = engine
        } catch (e: Throwable) {
            Log.e(TAG, "headless engine start failed", e)
        }
    }
}
