import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/theme/theme_x.dart';

/// Look and feel: theme, motion, haptics, units, text size, clock. The map
/// provider row deep-links into Privacy, its one real home.
class LookFeelScreen extends ConsumerWidget {
  const LookFeelScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider);
    final notifier = ref.read(settingsProvider.notifier);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Look and feel'),
        actions: [
          IconButton(
            icon: const Icon(Icons.close),
            onPressed: () => context.pop(),
          ),
        ],
      ),
      body: ListView(
        children: [
          const SettingsSection('Appearance'),
          SettingsChoiceRow<Appearance>(
            title: 'Theme',
            value: settings.appearance,
            options: const [
              (Appearance.light, 'Light', null),
              (Appearance.dark, 'Dark', null),
              (
                Appearance.pureBlack,
                'Pure black',
                'True black for OLED screens. Saves battery.',
              ),
            ],
            onSelected: (v) {
              Haptics.tick(ref);
              unawaited(notifier.update((s) => s.copyWith(appearance: v)));
            },
          ),
          const _TextSizeRow(),
          const Divider(),
          const SettingsSection('Motion and touch'),
          SettingsChoiceRow<MotionPreference>(
            title: 'Reduce motion',
            value: settings.motion,
            options: const [
              (
                MotionPreference.system,
                'Follow system',
                'Uses the Android accessibility setting.',
              ),
              (MotionPreference.reduced, 'Always reduce', null),
              (MotionPreference.full, 'Full motion', null),
            ],
            onSelected: (v) {
              Haptics.tick(ref);
              unawaited(notifier.update((s) => s.copyWith(motion: v)));
            },
          ),
          SettingsChoiceRow<HapticsLevel>(
            title: 'Haptics',
            value: settings.haptics,
            options: const [
              (HapticsLevel.none, 'None', null),
              (
                HapticsLevel.standard,
                'Standard',
                'A bump on the controls that change what others see.',
              ),
              (
                HapticsLevel.enhanced,
                'Enhanced',
                'Standard, plus a tick on every selection.',
              ),
            ],
            onSelected: (v) {
              unawaited(notifier.update((s) => s.copyWith(haptics: v)));
              Haptics.impact(ref);
            },
          ),
          const Divider(),
          const SettingsSection('Format'),
          SettingsChoiceRow<DistanceUnits>(
            title: 'Units',
            value: settings.units,
            options: const [
              (DistanceUnits.miles, 'Miles', null),
              (DistanceUnits.kilometers, 'Kilometers', null),
            ],
            onSelected: (v) {
              Haptics.tick(ref);
              unawaited(notifier.update((s) => s.copyWith(units: v)));
            },
          ),
          SettingsChoiceRow<TimeFormat>(
            title: 'Time format',
            value: settings.timeFormat,
            options: const [
              (TimeFormat.h12, '12 hour', null),
              (TimeFormat.h24, '24 hour', null),
            ],
            onSelected: (v) {
              Haptics.tick(ref);
              unawaited(notifier.update((s) => s.copyWith(timeFormat: v)));
            },
          ),
          const Divider(),
          const SettingsSection('Map'),
          SettingsNavRow(
            title: 'Map provider',
            subtitle: 'Lives in Privacy, because it is one',
            onTap: () => context.push(const SettingsPrivacyRoute()),
          ),
        ],
      ),
    );
  }
}

/// Text size: a live slider snapped to sensible stops, composed with the OS
/// scale (never replacing it).
class _TextSizeRow extends ConsumerWidget {
  const _TextSizeRow();

  static const _stops = [0.85, 1.0, 1.15, 1.3];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scale = ref.watch(
      settingsProvider.select((s) => s.textScale),
    );
    final index = _stops.indexOf(scale).clamp(0, _stops.length - 1);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ListTile(
          title: const Text('Text size'),
          subtitle: Text(switch (index) {
            0 => 'Small',
            1 => 'Default',
            2 => 'Large',
            _ => 'Largest',
          }),
        ),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: context.space.md),
          child: Slider(
            value: index.toDouble(),
            max: (_stops.length - 1).toDouble(),
            divisions: _stops.length - 1,
            label: '${(_stops[index] * 100).round()}%',
            onChanged: (v) {
              final next = _stops[v.round()];
              if (next == scale) return;
              Haptics.tick(ref);
              unawaited(
                ref
                    .read(settingsProvider.notifier)
                    .update((s) => s.copyWith(textScale: next)),
              );
            },
          ),
        ),
      ],
    );
  }
}
