package dev.petalcat.janetcall

import android.app.Notification
import android.app.ActivityOptions
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build

object IncomingNotification {
	const val CHANNEL = "incoming-calls"
	private const val ID = 3

	fun channel(context: Context) {
		val manager = context.getSystemService(NotificationManager::class.java)
		manager.createNotificationChannel(NotificationChannel(CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
			description = "Janet's incoming call ringtone and vibration"
			setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioAttributes.Builder()
				.setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
			enableVibration(true)
			vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
			lockscreenVisibility = Notification.VISIBILITY_PUBLIC
			if (manager.isNotificationPolicyAccessGranted) setBypassDnd(true)
		})
	}

	fun show(context: Context, ring: PendingRing, silent: Boolean = false) {
		channel(context)
		val show = activity(context, ring.id, answer = false)
		val answer = activity(context, ring.id, answer = true)
		val rejectIntent = Intent(context, RingActionReceiver::class.java)
			.setData(Uri.parse("janetcall-incoming://decline/${ring.id}"))
			.putExtra(IncomingCalls.EXTRA_RING_ID, ring.id)
		val reject = PendingIntent.getBroadcast(context, 0, rejectIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
		val builder = Notification.Builder(context, CHANNEL)
			.setSmallIcon(R.drawable.ic_stat_janet).setContentTitle("Janet").setContentText("Incoming call")
			.setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PUBLIC)
			.setContentIntent(show).setFullScreenIntent(show, true)
			.setOngoing(true).setTimeoutAfter(ringRemainingMs(ring.expires).coerceAtLeast(1))
		if (Build.VERSION.SDK_INT >= 31) {
			builder.setStyle(Notification.CallStyle.forIncomingCall(Person.Builder().setName("Janet").setImportant(true).build(), reject, answer))
		} else {
			builder.addAction(Notification.Action.Builder(null, "Decline", reject).build())
			builder.addAction(Notification.Action.Builder(null, "Answer", answer).build())
		}
		if (silent) builder.setOnlyAlertOnce(true)
		val notification = builder.build()
		if (!silent) notification.flags = notification.flags or Notification.FLAG_INSISTENT
		context.getSystemService(NotificationManager::class.java).notify(ID, notification)
	}

	private fun activity(context: Context, id: String, answer: Boolean): PendingIntent {
		val options = if (Build.VERSION.SDK_INT >= 35) ActivityOptions.makeBasic()
			.setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED).toBundle() else null
		return PendingIntent.getActivity(context, 0, IncomingCallActivity.intent(context, id, answer),
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE, options)
	}

	fun cancel(context: Context) = context.getSystemService(NotificationManager::class.java).cancel(ID)
}

class RingActionReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		if (IncomingCalls.matching(context, intent.getStringExtra(IncomingCalls.EXTRA_RING_ID)) != null) Calls.connection?.onReject()
	}
}
