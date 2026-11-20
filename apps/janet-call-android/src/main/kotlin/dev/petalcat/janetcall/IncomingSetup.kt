package dev.petalcat.janetcall

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

object IncomingSetup {
	const val PERMISSIONS = 32

	private fun needed(context: Context) = buildList {
		add(Manifest.permission.RECORD_AUDIO)
		if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
	}.filter { context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }

	fun status(context: Context): String {
		val notifications = context.getSystemService(NotificationManager::class.java)
		return when {
			needed(context).isNotEmpty() -> "Allow microphone and notifications to answer incoming calls."
			!notifications.areNotificationsEnabled() -> "Turn on Janet's notifications for incoming calls."
			!context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName) ->
				"Allow unrestricted battery use so Janet can ring with the screen off."
			Build.VERSION.SDK_INT >= 34 && !notifications.canUseFullScreenIntent() -> "Allow full-screen calls to answer from the lock screen."
			notifications.getNotificationChannel(IncomingNotification.CHANNEL)?.importance?.let { it < NotificationManager.IMPORTANCE_HIGH } == true ->
				"Set Incoming calls notifications to high importance for the call screen."
			!notifications.isNotificationPolicyAccessGranted -> "Incoming calls are set up. Allow Do Not Disturb access if Janet should ring through it."
			else -> "Incoming calls are set up. Ringtone and Do Not Disturb follow the Incoming calls channel settings."
		}
	}

	/** Each tap opens the next missing permission. Returning from Android settings refreshes the explanation. */
	fun openNext(activity: Activity) {
		val notifications = activity.getSystemService(NotificationManager::class.java)
		IncomingNotification.channel(activity)
		val missing = needed(activity)
		if (missing.isNotEmpty()) {
			val prefs = activity.getSharedPreferences("incoming_setup", Context.MODE_PRIVATE)
			if (prefs.getBoolean("permissions_requested", false) && missing.any { !activity.shouldShowRequestPermissionRationale(it) }) {
				activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null)))
			} else {
				prefs.edit().putBoolean("permissions_requested", true).apply()
				activity.requestPermissions(missing.toTypedArray(), PERMISSIONS)
			}
			return
		}
		val packageUri = Uri.fromParts("package", activity.packageName, null)
		val channelSettings = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
			.putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName).putExtra(Settings.EXTRA_CHANNEL_ID, IncomingNotification.CHANNEL)
		val intent = when {
			!notifications.areNotificationsEnabled() -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
			!activity.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(activity.packageName) ->
				Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri)
			Build.VERSION.SDK_INT >= 34 && !notifications.canUseFullScreenIntent() -> Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, packageUri)
			notifications.getNotificationChannel(IncomingNotification.CHANNEL)?.importance?.let { it < NotificationManager.IMPORTANCE_HIGH } == true -> channelSettings
			!notifications.isNotificationPolicyAccessGranted -> Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
			else -> channelSettings
		}
		try { activity.startActivity(intent) } catch (_: android.content.ActivityNotFoundException) {
			activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri))
		}
	}
}
