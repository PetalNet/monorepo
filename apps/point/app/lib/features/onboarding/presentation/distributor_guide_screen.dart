import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/onboarding/onboarding_flow.dart';
import 'package:point_app/features/onboarding/presentation/onboarding_scaffold.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:unifiedpush/unifiedpush.dart';
import 'package:url_launcher/url_launcher.dart';

/// The UnifiedPush distributor walk-through for the private path. Detection
/// is live: it re-checks whenever the app returns to the foreground, so
/// "install ntfy, come back" just works. There is no silent fallback to FCM;
/// skipping is explicit and says what it means.
class DistributorGuideScreen extends ConsumerStatefulWidget {
  const DistributorGuideScreen({super.key});

  @override
  ConsumerState<DistributorGuideScreen> createState() =>
      _DistributorGuideScreenState();
}

class _DistributorGuideScreenState extends ConsumerState<DistributorGuideScreen>
    with WidgetsBindingObserver {
  List<String> _distributors = const [];
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
      final found = await UnifiedPush.getDistributors();
      if (!mounted) return;
      setState(() {
        _distributors = found;
        _checked = true;
      });
    } on Object {
      // No platform support (e.g. the web preview): treat as none installed.
      if (!mounted) return;
      setState(() => _checked = true);
    }
  }

  Future<void> _finish() async {
    await ref.read(settingsProvider.notifier).markTransportChosen();
    if (!mounted) return;
    await continueOnboarding(ref, context.router<AppRoute>());
  }

  Future<void> _skip() async {
    final sure = await showModalBottomSheet<bool>(
      context: context,
      builder: (context) => const _SkipSheet(),
    );
    if (sure ?? false) await _finish();
  }

  @override
  Widget build(BuildContext context) {
    final found = _distributors.isNotEmpty;
    return OnboardingScaffold(
      step: OnboardingProgress.privacy,
      headline: 'Set up private\nnotifications.',
      body:
          'Point wakes up through a small app you control, called a '
          'distributor. We recommend ntfy. Install it, open it once, and '
          'come back here. Point handles the rest.',
      primaryLabel: found ? 'Continue' : 'Get ntfy',
      onPrimary: found
          ? _finish
          : () => launchUrl(
              Uri.parse('https://ntfy.sh'),
              mode: LaunchMode.externalApplication,
            ),
      secondaryLabel: 'Set up later',
      onSecondary: _skip,
      children: [
        _DistributorStatus(
          checked: _checked,
          distributors: _distributors,
        ),
        SizedBox(height: context.space.lg),
        Text(
          'Any UnifiedPush distributor works. It only ever carries a plain '
          'wake-up ping, so it never learns who your people are or where '
          'anyone is.',
          style: context.text.bodySmall?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

/// Live detection readout: hollow dot while nothing is installed, filled once
/// a distributor is found. Form, not color.
class _DistributorStatus extends StatelessWidget {
  const _DistributorStatus({
    required this.checked,
    required this.distributors,
  });

  final bool checked;
  final List<String> distributors;

  /// Short human name for a distributor package id.
  static String _label(String pkg) {
    if (pkg.contains('ntfy')) return 'ntfy';
    if (pkg.contains('sunup')) return 'Sunup';
    if (pkg.contains('nextpush')) return 'NextPush';
    return pkg.split('.').last;
  }

  @override
  Widget build(BuildContext context) {
    final ink = context.colors.onSurface;
    final found = distributors.isNotEmpty;
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
              color: found ? ink : Colors.transparent,
              shape: BoxShape.circle,
              border: Border.all(color: ink, width: 1.5),
            ),
          ),
          SizedBox(width: context.space.md),
          Expanded(
            child: Text(
              !checked
                  ? 'Checking for a distributor'
                  : found
                  ? 'Found ${_label(distributors.first)}. You are set.'
                  : 'No distributor on this phone yet.',
              style: context.text.titleSmall,
            ),
          ),
        ],
      ),
    );
  }
}

/// The explicit skip: says plainly what no distributor means. Never a silent
/// FCM fallback.
class _SkipSheet extends StatelessWidget {
  const _SkipSheet();

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          context.space.xl,
          context.space.md,
          context.space.xl,
          context.space.xl,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Skip for now?', style: context.text.headlineSmall),
            SizedBox(height: context.space.md),
            Text(
              'Without a distributor, nothing can wake Point in the '
              'background. Share requests will only show up when you open '
              'the app. Set it up anytime in Settings, under '
              'Notifications.',
              style: context.text.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            SizedBox(height: context.space.xl),
            TextButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Skip for now'),
            ),
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Go back'),
            ),
          ],
        ),
      ),
    );
  }
}
