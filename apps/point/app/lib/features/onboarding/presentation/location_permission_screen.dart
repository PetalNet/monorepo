import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/location/tracking_permissions.dart';
import 'package:point_app/features/onboarding/onboarding_flow.dart';
import 'package:point_app/features/onboarding/presentation/onboarding_scaffold.dart';
import 'package:point_app/theme/theme_x.dart';

/// A truthful four-step Android permission ladder. Each return from system
/// settings re-reads OS state before advancing to the next missing grant.
class LocationPermissionScreen extends ConsumerStatefulWidget {
  const LocationPermissionScreen({super.key});

  @override
  ConsumerState<LocationPermissionScreen> createState() =>
      _LocationPermissionScreenState();
}

class _LocationPermissionScreenState
    extends ConsumerState<LocationPermissionScreen>
    with WidgetsBindingObserver {
  TrackingPermissionHealth? _health;
  bool _checking = true;

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
    if (mounted) setState(() => _checking = true);
    try {
      final health = await ref.read(trackingPermissionsProvider).check();
      if (!mounted) return;
      setState(() {
        _health = health;
        _checking = false;
      });
      ref.invalidate(trackingPermissionHealthProvider);
    } on Object {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    await action();
    await _check();
  }

  Future<void> _done() async {
    await continueOnboarding(ref, context.router<AppRoute>());
  }

  @override
  Widget build(BuildContext context) {
    final permissions = ref.read(trackingPermissionsProvider);
    final health = _health;
    final foreground = health?.foregroundLocation ?? false;
    final ready = health?.liveTrackingReady ?? false;
    final nextIssue = health?.firstIssue;

    final (label, action) = health == null
        ? ('Check permissions', _check)
        : switch (nextIssue) {
            TrackingPermissionIssue.foregroundLocation => (
              'Allow while using Point',
              () => _run(permissions.requestForegroundLocation),
            ),
            TrackingPermissionIssue.backgroundLocation => (
              'Open location settings',
              () => _run(permissions.openBackgroundLocationSettings),
            ),
            TrackingPermissionIssue.notifications => (
              'Allow notifications',
              () => _run(permissions.requestNotifications),
            ),
            TrackingPermissionIssue.battery => (
              'Allow background activity',
              () => _run(permissions.requestBatteryExemption),
            ),
            null => ('Finish setup', _done),
          };

    return OnboardingScaffold(
      step: OnboardingProgress.location,
      headline: 'Enable live\ntracking.',
      body:
          'Point needs four Android settings to keep your encrypted location '
          'moving when the screen is off. You stay in control, and going dark '
          'still stops sharing.',
      primaryLabel: label,
      onPrimary: _checking ? null : action,
      primaryLoading: _checking,
      secondaryLabel: foreground && !ready
          ? 'Continue with limited tracking'
          : null,
      onSecondary: foreground && !ready ? _done : null,
      children: [
        _PermissionStep(
          number: 1,
          title: 'Location while using Point',
          body: 'Finds your position while Point is on screen.',
          complete: health?.foregroundLocation ?? false,
          active: nextIssue == TrackingPermissionIssue.foregroundLocation,
        ),
        _PermissionStep(
          number: 2,
          title: 'Location all the time',
          body:
              'Keeps trusted people updated after you lock your phone. In '
              'Android settings, choose “Allow all the time.”',
          complete: health?.backgroundLocation ?? false,
          active: nextIssue == TrackingPermissionIssue.backgroundLocation,
        ),
        _PermissionStep(
          number: 3,
          title: 'Tracking notification',
          body:
              'Shows when live tracking is running and keeps Android’s '
              'foreground service healthy.',
          complete: health?.notifications ?? false,
          active: nextIssue == TrackingPermissionIssue.notifications,
        ),
        _PermissionStep(
          number: 4,
          title: 'Unrestricted battery use',
          body:
              'Prevents Doze and phone battery managers from silently '
              'suspending live updates.',
          complete: health?.batteryUnrestricted ?? false,
          active: nextIssue == TrackingPermissionIssue.battery,
          last: true,
        ),
      ],
    );
  }
}

class _PermissionStep extends StatelessWidget {
  const _PermissionStep({
    required this.number,
    required this.title,
    required this.body,
    required this.complete,
    required this.active,
    this.last = false,
  });

  final int number;
  final String title;
  final String body;
  final bool complete;
  final bool active;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final ink = context.colors.onSurface;
    final muted = context.colors.onSurfaceVariant;
    return Semantics(
      label:
          '$title. ${complete
              ? 'Enabled'
              : active
              ? 'Next step'
              : 'Not enabled'}',
      child: Padding(
        padding: EdgeInsets.only(bottom: last ? 0 : context.space.lg),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 28,
              height: 28,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: complete ? ink : Colors.transparent,
                shape: BoxShape.circle,
                border: Border.all(color: active || complete ? ink : muted),
              ),
              child: complete
                  ? Icon(Icons.check, size: 17, color: context.colors.surface)
                  : Text(
                      '$number',
                      style: context.text.labelMedium?.copyWith(
                        color: active ? ink : muted,
                      ),
                    ),
            ),
            SizedBox(width: context.space.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: context.text.titleSmall),
                  SizedBox(height: context.space.xs),
                  Text(
                    body,
                    style: context.text.bodySmall?.copyWith(color: muted),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
