import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/settings_controller.dart';

/// Haptics, gated by the Look & feel setting:
/// none = silence; standard = impact on state-changing controls (ghost,
/// confirms); enhanced = standard plus selection ticks on choices and tabs.
abstract final class Haptics {
  /// A state-changing control fired (ghost toggle, confirm primary).
  static void impact(WidgetRef ref) {
    if (ref.read(settingsProvider).haptics == HapticsLevel.none) return;
    HapticFeedback.mediumImpact();
  }

  /// A selection tick (choice rows, tab switches). Enhanced only.
  static void tick(WidgetRef ref) {
    if (ref.read(settingsProvider).haptics != HapticsLevel.enhanced) return;
    HapticFeedback.selectionClick();
  }
}
