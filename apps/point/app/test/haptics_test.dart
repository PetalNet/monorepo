import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/features/settings/settings_controller.dart';

class _FixedSettings extends SettingsController {
  _FixedSettings(this.level);

  final HapticsLevel level;

  @override
  AppSettings build() => AppSettings(haptics: level);
}

class _RecordingHaptics {
  final cues = <HapticCue>[];

  void play(HapticCue cue) => cues.add(cue);
}

void main() {
  test('interaction matrix gates cues at each configured level', () {
    for (final cue in HapticCue.values) {
      expect(Haptics.enabledFor(HapticsLevel.none, cue), isFalse);
    }
    expect(
      Haptics.enabledFor(HapticsLevel.standard, HapticCue.selection),
      isFalse,
    );
    expect(
      Haptics.enabledFor(HapticsLevel.standard, HapticCue.commit),
      isTrue,
    );
    expect(
      Haptics.enabledFor(HapticsLevel.standard, HapticCue.warning),
      isTrue,
    );
    for (final cue in HapticCue.values) {
      expect(Haptics.enabledFor(HapticsLevel.enhanced, cue), isTrue);
    }
  });

  for (final (level, expected) in [
    (HapticsLevel.none, <HapticCue>[]),
    (
      HapticsLevel.standard,
      <HapticCue>[HapticCue.commit, HapticCue.warning],
    ),
    (HapticsLevel.enhanced, HapticCue.values),
  ]) {
    testWidgets('$level dispatches only its enabled interaction cues', (
      tester,
    ) async {
      final driver = _RecordingHaptics();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            settingsProvider.overrideWith(() => _FixedSettings(level)),
            hapticFeedbackDriverProvider.overrideWithValue(driver.play),
          ],
          child: const MaterialApp(home: _HapticHarness()),
        ),
      );

      await tester.tap(find.byKey(const ValueKey('selection')));
      await tester.tap(find.byKey(const ValueKey('commit')));
      await tester.tap(find.byKey(const ValueKey('warning')));

      expect(driver.cues, expected);
    });
  }

  testWidgets('level preview uses the new value, not stale settings state', (
    tester,
  ) async {
    final driver = _RecordingHaptics();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          settingsProvider.overrideWith(
            () => _FixedSettings(HapticsLevel.none),
          ),
          hapticFeedbackDriverProvider.overrideWithValue(driver.play),
        ],
        child: const MaterialApp(home: _HapticHarness()),
      ),
    );

    await tester.tap(find.byKey(const ValueKey('preview-standard')));
    await tester.tap(find.byKey(const ValueKey('preview-none')));

    expect(driver.cues, [HapticCue.commit]);
  });
}

class _HapticHarness extends ConsumerWidget {
  const _HapticHarness();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(
      children: [
        TextButton(
          key: const ValueKey('selection'),
          onPressed: () => Haptics.selection(ref),
          child: const Text('Selection'),
        ),
        TextButton(
          key: const ValueKey('commit'),
          onPressed: () => Haptics.commit(ref),
          child: const Text('Commit'),
        ),
        TextButton(
          key: const ValueKey('warning'),
          onPressed: () => Haptics.warning(ref),
          child: const Text('Warning'),
        ),
        TextButton(
          key: const ValueKey('preview-standard'),
          onPressed: () => Haptics.preview(ref, HapticsLevel.standard),
          child: const Text('Preview standard'),
        ),
        TextButton(
          key: const ValueKey('preview-none'),
          onPressed: () => Haptics.preview(ref, HapticsLevel.none),
          child: const Text('Preview none'),
        ),
      ],
    );
  }
}
