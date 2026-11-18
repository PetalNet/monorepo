package dev.petalcat.janetcall.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.petalcat.janetcall.R

/** The approved design's colours. [ground] is the screen, [paper] a card on it, [ink] text and the planet. */
@Immutable
data class Palette(
	val dark: Boolean,
	val ground: Color,
	val paper: Color,
	val ink: Color,
	val onInk: Color,
	val g1: Color,
	val g2: Color,
	val hair: Color,
	val hair2: Color,
	val tint: Color,
)

val DarkPalette = Palette(
	dark = true,
	ground = Color(0xFF0B0B0B),
	paper = Color(0xFF1A1A1A),
	ink = Color(0xFFF3F3EF),
	onInk = Color(0xFF0B0B0B),
	g1 = Color(0xFFC6C6C2),
	g2 = Color(0xFFA2A29E),
	hair = Color(0xFF2A2A2A),
	hair2 = Color(0xFF3B3B3B),
	tint = Color(0xFF202020),
)

val LightPalette = Palette(
	dark = false,
	ground = Color(0xFFF7F7F5),
	paper = Color(0xFFFFFFFF),
	ink = Color(0xFF0A0A0A),
	onInk = Color(0xFFFFFFFF),
	g1 = Color(0xFF4A4A4A),
	g2 = Color(0xFF666663),
	hair = Color(0xFFE4E4E2),
	hair2 = Color(0xFFCFCFCD),
	tint = Color(0xFFECECEA),
)

val LocalPalette = staticCompositionLocalOf { DarkPalette }

@OptIn(ExperimentalTextApi::class)
private fun geist(weight: Int) =
	Font(R.font.geist, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

val Geist = FontFamily(geist(400), geist(500), geist(600))

/** The type scale. Sizes are the design's, in sp so they follow the system font size. */
object Type {
	private fun style(size: Double, weight: Int, line: Double) =
		TextStyle(fontFamily = Geist, fontSize = size.sp, fontWeight = FontWeight(weight), lineHeight = (size * line).sp)

	val headline = style(30.0, 500, 1.14)
	val title = style(20.0, 600, 1.2)
	val name = style(15.0, 600, 1.3)
	val body = style(15.0, 400, 1.4)
	val button = style(17.0, 600, 1.2)
	val pill = style(16.0, 500, 1.2)
	val detail = style(12.5, 500, 1.3)
	val label = style(11.0, 700, 1.3).copy(letterSpacing = 0.09.em)
}

@Composable
fun JanetTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
	val palette = if (dark) DarkPalette else LightPalette
	val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
		primary = palette.ink,
		onPrimary = palette.onInk,
		background = palette.ground,
		onBackground = palette.ink,
		surface = palette.ground,
		onSurface = palette.ink,
		surfaceVariant = palette.tint,
		onSurfaceVariant = palette.g1,
		surfaceContainerHigh = palette.paper,
		outline = palette.hair2,
		outlineVariant = palette.hair,
	)
	CompositionLocalProvider(LocalPalette provides palette) {
		MaterialTheme(colorScheme = scheme, content = content)
	}
}
