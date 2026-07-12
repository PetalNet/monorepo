import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/onboarding/onboarding_flow.dart';
import 'package:point_app/features/onboarding/presentation/onboarding_scaffold.dart';
import 'package:point_app/theme/theme_x.dart';

/// Onboarding: the location ask. Sits after the privacy story so the grant is
/// earned, not ambushed. Foreground access unlocks Continue; the screen
/// teaches the "Allow all the time" upgrade that makes background sharing
/// reliable, with live state that re-checks whenever the user comes back
/// from Android settings.
class LocationPermissionScreen extends ConsumerStatefulWidget {
  const LocationPermissionScreen({super.key});

  @override
  ConsumerState<LocationPermissionScreen> createState() =>
      _LocationPermissionScreenState();
}

class _LocationPermissionScreenState
    extends ConsumerState<LocationPermissionScreen>
    with WidgetsBindingObserver {
  LocationPermission _permission = LocationPermission.denied;
  bool _checked = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_check());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_check());
  }

  Future<void> _check() async {
    try {
      final p = await Geolocator.checkPermission();
      if (!mounted) return;
      setState(() {
        _permission = p;
        _checked = true;
      });
    } on Object {
      if (!mounted) return;
      setState(() => _checked = true);
    }
  }

  bool get _granted =>
      _permission == LocationPermission.always ||
      _permission == LocationPermission.whileInUse;

  Future<void> _request() async {
    try {
      final p = await Geolocator.requestPermission();
      if (!mounted) return;
      setState(() => _permission = p);
    } on Object {
      // The system dialog failed to show (or platform unsupported); the
      // status row keeps telling the truth.
    }
  }

  Future<void> _done() async {
    await continueOnboarding(ref, context.router<AppRoute>());
  }

  @override
  Widget build(BuildContext context) {
    final always = _permission == LocationPermission.always;
    final foreverDenied = _permission == LocationPermission.deniedForever;

    final (primaryLabel, onPrimary) = switch ((_granted, foreverDenied)) {
      (true, _) => ('Done', _done),
      (false, true) => (
        'Open settings',
        () => unawaited(Geolocator.openAppSettings()),
      ),
      (false, false) => ('Allow location', _request),
    };

    return OnboardingScaffold(
      step: OnboardingProgress.location,
      headline: 'Location,\nall the time.',
      body:
          'Sharing where you are is the whole job, so Point needs '
          'location access even while it is closed. It stays encrypted, '
          'only your people can see it, and one switch turns it all off.',
      primaryLabel: primaryLabel,
      onPrimary: !_checked ? null : onPrimary,
      secondaryLabel: _granted && !always ? 'Continue anyway' : null,
      onSecondary: _granted && !always ? _done : null,
      children: [
        _PermissionStatus(
          checked: _checked,
          permission: _permission,
        ),
        SizedBox(height: context.space.lg),
        if (foreverDenied)
          Text(
            'Android will not show the request again, so the switch lives '
            'in settings now. Open settings, tap Permissions, then '
            'Location, and choose Allow all the time.',
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          )
        else if (_granted && !always) ...[
          Text(
            'One step left for reliable sharing while the screen is off: '
            'open settings, tap Permissions, then Location, and choose '
            'Allow all the time.',
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          SizedBox(height: context.space.md),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: () => unawaited(Geolocator.openAppSettings()),
              child: const Text('Open settings'),
            ),
          ),
        ] else if (!_granted)
          const _AskSteps(),
      ],
    );
  }
}

/// Live permission readout, presence-grammar shapes: filled = all the time,
/// ring = while in use, faint hollow = not yet.
class _PermissionStatus extends StatelessWidget {
  const _PermissionStatus({required this.checked, required this.permission});

  final bool checked;
  final LocationPermission permission;

  @override
  Widget build(BuildContext context) {
    final ink = context.colors.onSurface;
    final always = permission == LocationPermission.always;
    final whileInUse = permission == LocationPermission.whileInUse;
    final label = !checked
        ? 'Checking'
        : switch (permission) {
            LocationPermission.always => 'Allowed all the time. Thank you.',
            LocationPermission.whileInUse => 'Allowed while the app is open.',
            LocationPermission.deniedForever =>
              'Turned off in Android settings.',
            _ => 'Not allowed yet.',
          };
    return Container(
      padding: EdgeInsets.all(context.space.lg),
      decoration: BoxDecoration(
        color: context.colors.surfaceContainer,
        borderRadius: context.radii.brMd,
      ),
      child: Row(
        children: [
          Container(
            width: 12,
            height: 12,
            decoration: BoxDecoration(
              color: always ? ink : Colors.transparent,
              shape: BoxShape.circle,
              border: Border.all(
                color: always || whileInUse
                    ? ink
                    : context.colors.onSurfaceVariant.withValues(alpha: 0.5),
                width: 1.5,
              ),
            ),
          ),
          SizedBox(width: context.space.md),
          Expanded(child: Text(label, style: context.text.titleSmall)),
        ],
      ),
    );
  }
}

/// What Android is about to ask, spelled out so nobody is surprised.
class _AskSteps extends StatelessWidget {
  const _AskSteps();

  static const _steps = [
    'Tap Allow location below.',
    'Pick While using the app.',
    'Later, choose Allow all the time in settings for sharing that survives a locked phone.',
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final (i, step) in _steps.indexed)
          Padding(
            padding: EdgeInsets.only(bottom: context.space.sm),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 24,
                  child: Text(
                    '${i + 1}',
                    style: context.text.bodySmall?.copyWith(
                      fontFamily: 'JetBrains Mono',
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                ),
                Expanded(
                  child: Text(
                    step,
                    style: context.text.bodyMedium?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
