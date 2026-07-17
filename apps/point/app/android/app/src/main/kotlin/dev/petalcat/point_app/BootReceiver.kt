package dev.petalcat.point_app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * R9 — resume sharing after a reboot. On BOOT_COMPLETED, if an active share was
 * persisted (the user was sharing when the phone went down), restart Point's own
 * foreground service ([PointForegroundService]); it comes up without the app's
 * Flutter engine attached, so it hosts a headless engine that re-establishes the
 * Dart location engine + relay — the phone resumes sharing without the user ever
 * reopening the app.
 *
 * BOOT_COMPLETED is an exemption from the background foreground-service-start
 * restrictions, so starting the location FGS from here is allowed.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            action != "android.intent.action.QUICKBOOT_POWERON"
        ) {
            return
        }
        val active = context
            .getSharedPreferences(PointForegroundService.PREFS, Context.MODE_PRIVATE)
            .getBoolean(PointForegroundService.KEY_ACTIVE_SHARE, false)
        if (!active) {
            Log.d("PointBoot", "boot: no active share — not resuming")
            return
        }
        Log.d("PointBoot", "boot: active share — resuming foreground service")
        PointForegroundService.start(context)
    }
}
