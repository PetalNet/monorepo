package dev.petalcat.janetcall

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureScreenRoboImage
import dev.petalcat.janetcall.ui.JanetTheme
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf

/** Draws [content] on a 412 x 915 dp phone and writes it to build/screens/[name].png. */
fun shoot(name: String, dark: Boolean = true, before: (ComponentActivity) -> Unit = {}, content: @Composable () -> Unit) {
	val app = ApplicationProvider.getApplicationContext<android.app.Application>()
	shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
	val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
	val activity = controller.get()
	activity.setContent { JanetTheme(dark = dark, content = content) }
	shadowOf(Looper.getMainLooper()).idle()
	before(activity)
	shadowOf(Looper.getMainLooper()).idle()
	captureScreenRoboImage("build/screens/$name.png")
	controller.pause().stop().destroy()
}

/** Every view under [root] of type [T]. */
inline fun <reified T : View> views(root: View): List<T> = views(root, T::class.java)

fun <T : View> views(root: View, type: Class<T>): List<T> {
	val found = mutableListOf<T>()
	fun walk(v: View) {
		if (type.isInstance(v)) found += type.cast(v)!!
		if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
	}
	walk(root)
	return found
}

/**
 * Plays [seconds] of a call into the sky under [activity] at 30 frames a second, on [clock], so the
 * planet, the meter and the transcript are where a real call would have them.
 */
fun play(activity: ComponentActivity, clock: DoubleArray, seconds: Double, each: (Double) -> Unit = {}) {
	val sky = views<CallSky>(activity.window.decorView).single()
	val scratch = Canvas(Bitmap.createBitmap(sky.width, sky.height, Bitmap.Config.ARGB_8888))
	val until = clock[0] + seconds
	while (clock[0] < until) {
		each(clock[0])
		sky.draw(scratch)
		clock[0] += 1.0 / 30
	}
}
