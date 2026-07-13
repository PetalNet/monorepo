import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/settings_controller.dart';

/// The small tactile vocabulary used across Point's core interactions.
enum HapticCue { selection, commit, warning }

/// Injectable boundary around Flutter's platform haptic channel.
typedef HapticFeedbackDriver = void Function(HapticCue cue);

void _playSystemHaptic(HapticCue cue) {
  switch (cue) {
    case HapticCue.selection:
      HapticFeedback.selectionClick();
    case HapticCue.commit:
      HapticFeedback.mediumImpact();
    case HapticCue.warning:
      HapticFeedback.heavyImpact();
  }
}

final hapticFeedbackDriverProvider = Provider<HapticFeedbackDriver>(
  (_) => _playSystemHaptic,
);

/// Haptics, gated by the Look & feel setting.
///
/// Interaction matrix:
/// - selection: enhanced only, for navigation and non-committing choices;
/// - commit: standard/enhanced, for completed or state-changing actions;
/// - warning: standard/enhanced, for destructive actions.
abstract final class Haptics {
  static void selection(WidgetRef ref) => _play(ref, HapticCue.selection);

  static void commit(WidgetRef ref) => _play(ref, HapticCue.commit);

  static void warning(WidgetRef ref) => _play(ref, HapticCue.warning);

  /// Preview a newly selected level before its asynchronous persistence makes
  /// it observable through [settingsProvider]. Choosing none stays silent.
  static void preview(WidgetRef ref, HapticsLevel level) {
    if (!enabledFor(level, HapticCue.commit)) return;
    ref.read(hapticFeedbackDriverProvider)(HapticCue.commit);
  }

  /// Compatibility names for established callers outside the audit scope.
  static void tick(WidgetRef ref) => selection(ref);
  static void impact(WidgetRef ref) => commit(ref);

  static bool enabledFor(HapticsLevel level, HapticCue cue) {
    return switch ((level, cue)) {
      (HapticsLevel.none, _) => false,
      (HapticsLevel.standard, HapticCue.selection) => false,
      _ => true,
    };
  }

  static void _play(WidgetRef ref, HapticCue cue) {
    final level = ref.read(settingsProvider).haptics;
    if (!enabledFor(level, cue)) return;
    ref.read(hapticFeedbackDriverProvider)(cue);
  }
}
