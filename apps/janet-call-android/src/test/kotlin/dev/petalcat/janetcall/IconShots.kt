package dev.petalcat.janetcall

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Path
import android.graphics.drawable.AdaptiveIconDrawable
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.test.core.app.ApplicationProvider
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The launcher icon on a launcher grid, light and dark, round and squircle, and themed. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xxhdpi")
class IconShots {
	private val context get() = ApplicationProvider.getApplicationContext<android.app.Application>()
	private val size = 192

	private fun mask(round: Boolean): Path = Path().apply {
		if (round) addCircle(size / 2f, size / 2f, size / 2f, Path.Direction.CW)
		else addRoundRect(0f, 0f, size.toFloat(), size.toFloat(), size * 0.32f, size * 0.32f, Path.Direction.CW)
	}

	/** The adaptive icon as a launcher would draw it: both layers, clipped to the mask. */
	private fun launcher(round: Boolean, themed: Boolean): Bitmap {
		val icon = context.getDrawable(R.mipmap.ic_launcher) as AdaptiveIconDrawable
		val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
		val canvas = Canvas(bitmap)
		canvas.clipPath(mask(round))
		// The layers are 108 dp and the visible window is the middle 72: scale so the window fills the tile.
		val pad = (size * (108f / 72f) - size) / 2
		val full = (size + 2 * pad).toInt()
		if (themed) {
			canvas.drawColor(0xFFD6E3FF.toInt())
			icon.monochrome!!.mutate().apply {
				setTint(0xFF0B2A5B.toInt())
				setBounds(-pad.toInt(), -pad.toInt(), full - pad.toInt(), full - pad.toInt())
				draw(canvas)
			}
		} else {
			icon.background.setBounds(-pad.toInt(), -pad.toInt(), full - pad.toInt(), full - pad.toInt())
			icon.background.draw(canvas)
			icon.foreground.setBounds(-pad.toInt(), -pad.toInt(), full - pad.toInt(), full - pad.toInt())
			icon.foreground.draw(canvas)
		}
		return bitmap
	}

	@androidx.compose.runtime.Composable
	private fun Tile(label: String, labelColor: Color, content: @androidx.compose.runtime.Composable () -> Unit) {
		Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(vertical = 10.dp)) {
			content()
			Spacer(Modifier.height(6.dp))
			Text(label, fontSize = 12.sp, color = labelColor)
		}
	}

	@androidx.compose.runtime.Composable
	private fun Grid(dark: Boolean, round: Boolean, themed: Boolean) {
		val wallpaper = if (dark) Color(0xFF14181F) else Color(0xFFDCE4F0)
		val label = if (dark) Color(0xFFE6E6E6) else Color(0xFF1A1A1A)
		val other = if (dark) Color(0xFF3A404B) else Color(0xFFFFFFFF)
		val shape = if (round) androidx.compose.foundation.shape.CircleShape else RoundedCornerShape(18.dp)
		val names = listOf("Phone", "Messages", "Janet", "Camera", "Clock", "Maps", "Photos", "Mail", "Notes", "Music", "Files", "Settings")
		Column(Modifier.fillMaxSize().background(wallpaper).padding(horizontal = 28.dp, vertical = 90.dp)) {
			Text(
				(if (dark) "Dark" else "Light") + ", " + (if (round) "round" else "squircle") + (if (themed) ", themed" else ""),
				fontSize = 13.sp,
				color = label,
			)
			Spacer(Modifier.height(24.dp))
			names.chunked(4).forEach { row ->
				Row(Modifier.fillMaxWidth().padding(bottom = 18.dp), horizontalArrangement = Arrangement.SpaceBetween) {
					row.forEach { name ->
						Tile(name, label) {
							if (name == "Janet") {
								Image(launcher(round, themed).asImageBitmap(), "Janet", Modifier.size(56.dp))
							} else {
								Spacer(Modifier.size(56.dp).clip(shape).background(other))
							}
						}
					}
				}
			}
		}
	}

	@Test fun lightSquircle() = shoot("icon-1-light-squircle", dark = false) { Grid(dark = false, round = false, themed = false) }

	@Test fun darkSquircle() = shoot("icon-2-dark-squircle") { Grid(dark = true, round = false, themed = false) }

	@Test fun lightRound() = shoot("icon-3-light-round", dark = false) { Grid(dark = false, round = true, themed = false) }

	@Test fun darkRound() = shoot("icon-4-dark-round") { Grid(dark = true, round = true, themed = false) }

	@Test fun themedLight() = shoot("icon-5-themed-light", dark = false) { Grid(dark = false, round = false, themed = true) }

	@Test fun themedDark() = shoot("icon-6-themed-dark") { Grid(dark = true, round = false, themed = true) }
}
