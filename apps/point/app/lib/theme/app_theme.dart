import 'package:flutter/material.dart';
import 'package:point_app/theme/app_radii.dart';
import 'package:point_app/theme/app_spacing.dart';
import 'package:point_app/theme/bridge_accent.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// The Point design system (D-015): bold black & white, Material 3, monochrome
/// `ColorScheme.fromSeed`, tonal surface ladder (Beeper-anchored), zero hue.
/// Three appearances: light, near-black dark (default), and a Pure-Black OLED
/// variant that collapses the low end of the ladder to `#000`.
abstract final class AppTheme {
  static const _fontFamily = 'Schibsted Grotesk';
  static const monoFamily = 'JetBrains Mono';

  /// Neutral seed → M3 hands back a true greyscale tonal palette.
  static const _seed = Color(0xFF000000);

  static ThemeData light() => _build(Brightness.light, pureBlack: false);
  static ThemeData dark({bool pureBlack = false}) =>
      _build(Brightness.dark, pureBlack: pureBlack);

  static ThemeData _build(Brightness brightness, {required bool pureBlack}) {
    final isDark = brightness == Brightness.dark;

    // Start from the monochrome seed, then override the surface roles to the
    // hand-tuned tonal ladder (depth is tonal, not shadowed).
    final base = ColorScheme.fromSeed(
      seedColor: _seed,
      brightness: brightness,
      dynamicSchemeVariant: DynamicSchemeVariant.monochrome,
    );

    final scheme = isDark
        ? base.copyWith(
            surface: pureBlack ? const Color(0xFF000000) : const Color(0xFF0E0E0E),
            surfaceContainerLowest:
                pureBlack ? const Color(0xFF000000) : const Color(0xFF0A0A0A),
            surfaceContainerLow:
                pureBlack ? const Color(0xFF080808) : const Color(0xFF141414),
            surfaceContainer:
                pureBlack ? const Color(0xFF0D0D0D) : const Color(0xFF1A1A1A),
            surfaceContainerHigh:
                pureBlack ? const Color(0xFF141414) : const Color(0xFF202020),
            surfaceContainerHighest:
                pureBlack ? const Color(0xFF1A1A1A) : const Color(0xFF262626),
            onSurface: const Color(0xFFF6F6F6),
            onSurfaceVariant: const Color(0xFFA0A0A0),
            outline: const Color(0xFF3A3A3A),
            outlineVariant: Colors.white.withValues(alpha: pureBlack ? 0.08 : 0.10),
            // Inverse pair drives the "you're sharing" inverse-fill signal.
            inverseSurface: const Color(0xFFF6F6F6),
            onInverseSurface: const Color(0xFF0A0A0A),
            primary: const Color(0xFFF6F6F6),
            onPrimary: const Color(0xFF0A0A0A),
          )
        : base.copyWith(
            surface: const Color(0xFFFFFFFF),
            surfaceContainerLowest: const Color(0xFFFFFFFF),
            surfaceContainerLow: const Color(0xFFF7F7F7),
            surfaceContainer: const Color(0xFFF0F0F0),
            surfaceContainerHigh: const Color(0xFFEAEAEA),
            surfaceContainerHighest: const Color(0xFFE2E2E2),
            onSurface: const Color(0xFF0A0A0A),
            onSurfaceVariant: const Color(0xFF5A5A5A),
            outline: const Color(0xFFC8C8C8),
            outlineVariant: Colors.black.withValues(alpha: 0.10),
            inverseSurface: const Color(0xFF0A0A0A),
            onInverseSurface: const Color(0xFFF6F6F6),
            primary: const Color(0xFF0A0A0A),
            onPrimary: const Color(0xFFFFFFFF),
          );

    final textTheme = _textTheme(scheme.onSurface);

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      fontFamily: _fontFamily,
      textTheme: textTheme,
      splashFactory: InkSparkle.splashFactory,
      // Depth is tonal — kill drop shadows across the board.
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: textTheme.titleLarge,
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surfaceContainer,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        modalElevation: 0,
        showDragHandle: true,
        shape: const RoundedRectangleBorder(
          borderRadius:
              BorderRadius.vertical(top: Radius.circular(28)),
        ),
      ),
      cardTheme: CardThemeData(
        color: scheme.surfaceContainer,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        thickness: 1,
        space: 1,
      ),
      listTileTheme: ListTileThemeData(
        titleTextStyle: textTheme.titleMedium,
        subtitleTextStyle: textTheme.bodySmall?.copyWith(
          fontFamily: monoFamily,
          color: scheme.onSurfaceVariant,
        ),
      ),
      extensions: [
        const AppRadii(),
        const AppSpacing(),
        const BridgeAccent(),
        PresenceTokens(
          ink: scheme.onSurface,
          muted: scheme.onSurfaceVariant,
          faint: scheme.onSurfaceVariant.withValues(alpha: 0.55),
        ),
      ],
    );
  }

  /// M3 role-based text theme. Boldness (the monochrome identity lever) comes
  /// from weight contrast: heavy display/headline against regular body.
  static TextTheme _textTheme(Color ink) {
    TextStyle s(double size, FontWeight w, {double? h, double? ls}) => TextStyle(
          fontFamily: _fontFamily,
          fontSize: size,
          fontWeight: w,
          height: h,
          letterSpacing: ls,
          color: ink,
        );
    return TextTheme(
      displayLarge: s(48, FontWeight.w800, h: 1.02, ls: -1),
      displayMedium: s(38, FontWeight.w800, h: 1.05, ls: -0.5),
      displaySmall: s(30, FontWeight.w700, h: 1.08, ls: -0.3),
      headlineLarge: s(28, FontWeight.w700, h: 1.1, ls: -0.3),
      headlineMedium: s(24, FontWeight.w700, h: 1.15, ls: -0.2),
      headlineSmall: s(20, FontWeight.w700, h: 1.2),
      titleLarge: s(19, FontWeight.w700),
      titleMedium: s(16, FontWeight.w600),
      titleSmall: s(14, FontWeight.w600),
      bodyLarge: s(16, FontWeight.w400, h: 1.4),
      bodyMedium: s(14, FontWeight.w400, h: 1.4),
      bodySmall: s(13, FontWeight.w400, h: 1.35),
      labelLarge: s(14, FontWeight.w600, ls: 0.1),
      labelMedium: s(12, FontWeight.w600, ls: 0.4),
      labelSmall: s(11, FontWeight.w700, ls: 1.4),
    );
  }
}
