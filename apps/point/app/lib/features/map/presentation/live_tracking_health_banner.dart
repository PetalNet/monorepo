import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/tracking_permissions.dart';
import 'package:point_app/theme/theme_x.dart';

/// A session-dismissible warning that returns whenever Point resumes and the
/// OS still reports degraded background tracking.
class LiveTrackingHealthBanner extends ConsumerStatefulWidget {
  const LiveTrackingHealthBanner({super.key});

  @override
  ConsumerState<LiveTrackingHealthBanner> createState() =>
      _LiveTrackingHealthBannerState();
}

class _LiveTrackingHealthBannerState
    extends ConsumerState<LiveTrackingHealthBanner>
    with WidgetsBindingObserver {
  bool _dismissed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    setState(() => _dismissed = false);
    ref.invalidate(trackingPermissionHealthProvider);
  }

  Future<void> _fix(TrackingPermissionIssue issue) async {
    await ref.read(trackingPermissionsProvider).fix(issue);
    ref.invalidate(trackingPermissionHealthProvider);
  }

  @override
  Widget build(BuildContext context) {
    final health = ref.watch(trackingPermissionHealthProvider).value;
    final issue = health?.firstIssue;
    if (_dismissed || health == null || !health.isAndroid || issue == null) {
      return const SizedBox.shrink();
    }

    return Semantics(
      liveRegion: true,
      container: true,
      label: 'Live tracking is off. ${issue.reason}. Fix this setting.',
      child: Material(
        color: context.colors.inverseSurface,
        shape: RoundedRectangleBorder(borderRadius: context.radii.brMd),
        child: Row(
          children: [
            SizedBox(width: context.space.md),
            Icon(
              Icons.location_disabled_outlined,
              size: 20,
              color: context.colors.onInverseSurface,
            ),
            SizedBox(width: context.space.sm),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Live tracking is off',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.text.titleSmall?.copyWith(
                      color: context.colors.onInverseSurface,
                    ),
                  ),
                  Text(
                    issue.reason,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.text.bodySmall?.copyWith(
                      color: context.colors.onInverseSurface,
                    ),
                  ),
                ],
              ),
            ),
            TextButton(
              onPressed: () => unawaited(_fix(issue)),
              style: TextButton.styleFrom(
                foregroundColor: context.colors.onInverseSurface,
                minimumSize: const Size(48, 48),
              ),
              child: const Text('Fix'),
            ),
            IconButton(
              onPressed: () => setState(() => _dismissed = true),
              color: context.colors.onInverseSurface,
              tooltip: 'Dismiss until Point resumes',
              icon: const Icon(Icons.close, size: 20),
            ),
          ],
        ),
      ),
    );
  }
}
