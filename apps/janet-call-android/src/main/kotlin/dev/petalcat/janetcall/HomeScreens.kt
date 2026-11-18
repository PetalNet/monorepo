package dev.petalcat.janetcall

import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.petalcat.janetcall.ui.LocalPalette
import dev.petalcat.janetcall.ui.Type
import java.time.Instant
import java.time.ZoneId

private val SIDE = 24.dp
private val TOP_BAR = 56.dp

/** What the lower half of a home screen needs at most, so the planet gets the rest. */
private val CONTENT_BUDGET = 400.dp

/**
 * The skeleton every home screen shares, from the approved design: the star field and the idle
 * planet behind, a top bar, a two-line headline, the screen's own [body], a status line, and the
 * one action pill at the bottom, if the screen has an action at all.
 */
@Composable
private fun Skeleton(
	headline: String,
	status: String,
	onSettings: (() -> Unit)? = null,
	action: (@Composable () -> Unit)? = null,
	body: @Composable ColumnScope.() -> Unit,
) {
	val palette = LocalPalette.current
	val density = LocalDensity.current
	BoxWithConstraints(Modifier.fillMaxSize().background(palette.ground)) {
		val slot = (maxHeight - TOP_BAR - CONTENT_BUDGET).coerceIn(110.dp, maxHeight * 0.45f)
		val topInset = WindowInsets.statusBars.getTop(density)
		AndroidView(
			modifier = Modifier.fillMaxSize(),
			factory = { CallSky(it).apply { showText = false } },
			update = { sky ->
				sky.palette = palette
				sky.inset(topInset, 0)
				val top = topInset + with(density) { TOP_BAR.roundToPx() }
				sky.slot(top, top + with(density) { slot.roundToPx() })
			},
		)
		Column(Modifier.fillMaxSize().statusBarsPadding()) {
			Row(Modifier.fillMaxWidth().height(TOP_BAR).padding(horizontal = SIDE), verticalAlignment = Alignment.CenterVertically) {
				Text("Janet", style = Type.name, color = palette.ink, modifier = Modifier.weight(1f).semantics { heading() })
				if (onSettings != null) {
					RoundButton(R.drawable.ic_settings, "Settings", size = 44, iconSize = 20, filled = false, onClick = onSettings)
				}
			}
			Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = SIDE)) {
				Spacer(Modifier.height(slot))
				Text(headline, style = Type.headline, color = palette.ink)
				Spacer(Modifier.height(18.dp))
				body()
			}
			Column(Modifier.navigationBarsPadding().padding(start = SIDE, end = SIDE, bottom = 24.dp, top = 8.dp)) {
				Text(
					status,
					style = Type.detail,
					color = palette.g2,
					textAlign = TextAlign.Center,
					modifier = Modifier.fillMaxWidth().padding(bottom = if (action != null) 12.dp else 0.dp)
						.semantics { liveRegion = LiveRegionMode.Polite },
				)
				action?.invoke()
			}
		}
	}
}

/** The main action: a tall pill, filled with ink, or outlined when it is the quieter of two. */
@Composable
fun Pill(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, filled: Boolean = true, enabled: Boolean = true) {
	val palette = LocalPalette.current
	val shape = RoundedCornerShape(50)
	Box(
		modifier.fillMaxWidth().height(if (filled) 58.dp else 52.dp).alpha(if (enabled) 1f else 0.4f).clip(shape)
			.then(if (filled) Modifier.background(palette.ink) else Modifier.border(BorderStroke(1.dp, palette.hair2), shape))
			.clickable(enabled = enabled, role = Role.Button, onClick = onClick),
		contentAlignment = Alignment.Center,
	) {
		Text(text, style = Type.button, color = if (filled) palette.onInk else palette.ink)
	}
}

/** A hairline card on the paper colour, with a small capital label at its top. */
@Composable
private fun Card(label: String, content: @Composable ColumnScope.() -> Unit) {
	val palette = LocalPalette.current
	val shape = RoundedCornerShape(18.dp)
	Column(
		Modifier.fillMaxWidth().clip(shape).background(palette.paper).border(BorderStroke(1.dp, palette.hair2), shape).padding(18.dp),
	) {
		Text(label, style = Type.label, color = palette.g2)
		Spacer(Modifier.height(10.dp))
		content()
	}
}

@Composable
fun HomeScreen(
	screen: Screen.Home,
	onCall: () -> Unit,
	onSettings: () -> Unit,
	now: Instant = Instant.now(),
	zone: ZoneId = ZoneId.systemDefault(),
) {
	val palette = LocalPalette.current
	Skeleton(
		headline = "Ready when\nyou are.",
		status = screen.notice ?: "Paired with ${screen.host}",
		onSettings = onSettings,
		action = { Pill("Call Janet", onCall) },
	) {
		Card("LAST CALL") {
			if (screen.recent.isEmpty()) {
				Text("No calls yet. Tap Call Janet to start one.", style = Type.body, color = palette.g1)
			}
			screen.recent.forEachIndexed { i, record ->
				if (i > 0) Spacer(Modifier.height(10.dp))
				Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
					Text(whenText(record, now, zone), style = Type.body, color = palette.ink)
					Text(lengthText(record), style = Type.body, color = palette.g2)
				}
			}
		}
	}
}

@Composable
fun WelcomeScreen(screen: Screen.Welcome) {
	val palette = LocalPalette.current
	Skeleton(
		headline = "Pair this phone\nwith Janet.",
		status = screen.notice ?: "Waiting for a pairing link",
	) {
		listOf(
			"Open the pairing link Janet sent you, on this phone.",
			"Check the address this app shows.",
			"Tap Pair, then call.",
		).forEachIndexed { i, text ->
			Row(Modifier.padding(bottom = 14.dp), verticalAlignment = Alignment.Top) {
				Box(
					Modifier.size(24.dp).border(BorderStroke(1.dp, palette.hair2), CircleShape),
					contentAlignment = Alignment.Center,
				) {
					Text("${i + 1}", style = Type.detail, color = palette.g1)
				}
				Spacer(Modifier.size(14.dp))
				Text(text, style = Type.body, color = palette.g1, modifier = Modifier.padding(top = 2.dp))
			}
		}
	}
}

@Composable
fun PairingScreen(screen: Screen.Pairing) {
	Skeleton(headline = "Pairing with\n${screen.host}", status = "Trading the one-time code…") {}
}

/**
 * Cancel takes the slot where Call Janet sits, and Pair is a quieter pill off at the card, dimmed
 * for the first moment, so a tap aimed at the screen that was there a moment ago cannot pair.
 */
@Composable
fun ConfirmScreen(screen: Screen.Confirm, onPair: () -> Unit, onCancel: () -> Unit) {
	val palette = LocalPalette.current
	Skeleton(
		headline = "Pair this phone?",
		status = "Only continue if you asked for this link",
		action = { Pill("Cancel", onCancel) },
	) {
		Card("BRIDGE") {
			Text(screen.host, style = Type.title, color = palette.ink)
			Spacer(Modifier.height(8.dp))
			Text(
				"Janet Call will place its calls through this address" +
					(if (screen.replacing != null) ", in place of ${screen.replacing}" else "") + ".",
				style = Type.body,
				color = palette.g1,
			)
		}
		Spacer(Modifier.height(14.dp))
		Pill("Pair", onPair, filled = false, enabled = screen.pairReady)
	}
}

@Composable
fun SettingsScreen(host: String, onBack: () -> Unit, onUnpair: () -> Unit, licences: () -> String) {
	val palette = LocalPalette.current
	var asking by remember { mutableStateOf(false) }
	var reading by remember { mutableStateOf(false) }
	BackHandler(onBack = onBack)
	Column(Modifier.fillMaxSize().background(palette.ground).statusBarsPadding().navigationBarsPadding()) {
		Row(Modifier.fillMaxWidth().height(TOP_BAR).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
			RoundButton(R.drawable.ic_back, "Back", size = 44, iconSize = 20, filled = false, onClick = onBack)
			Spacer(Modifier.size(12.dp))
			Text("Settings", style = Type.title, color = palette.ink, modifier = Modifier.semantics { heading() })
		}
		Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = SIDE, vertical = 12.dp)) {
			Card("THIS PHONE") {
				Fact("Device name", "${Build.MANUFACTURER} ${Build.MODEL}")
				Spacer(Modifier.height(14.dp))
				Fact("Bridge", host)
				Spacer(Modifier.height(14.dp))
				Fact("Version", BuildConfig.VERSION_NAME)
			}
			Spacer(Modifier.height(14.dp))
			Pill("Open-source licences", { reading = true }, filled = false)
		}
		Pill("Unpair this phone", { asking = true }, Modifier.padding(start = SIDE, end = SIDE, bottom = 24.dp), filled = false)
	}
	if (asking) {
		AlertDialog(
			onDismissRequest = { asking = false },
			text = { Text("Unpair this phone? To call Janet again you will need a new pairing link.") },
			confirmButton = { TextButton({ asking = false; onUnpair() }) { Text("Unpair") } },
			dismissButton = { TextButton({ asking = false }) { Text("Cancel") } },
		)
	}
	if (reading) {
		AlertDialog(
			onDismissRequest = { reading = false },
			title = { Text("Open-source licences") },
			text = { Text(licences(), style = Type.detail, modifier = Modifier.verticalScroll(rememberScrollState())) },
			confirmButton = { TextButton({ reading = false }) { Text("Close") } },
		)
	}
}

@Composable
private fun Fact(name: String, value: String) {
	val palette = LocalPalette.current
	Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "$name, $value" }) {
		Text(name, style = Type.detail, color = palette.g2)
		Text(value, style = Type.body, color = palette.ink)
	}
}

/** The licence texts the APK carries, one after the other. */
fun licenceText(context: android.content.Context): String =
	listOf("Geist-OFL.txt", "Lucide-ISC.txt").joinToString("\n\n--------\n\n") { name ->
		context.assets.open("licenses/$name").use { String(it.readBytes(), Charsets.UTF_8) }
	}
