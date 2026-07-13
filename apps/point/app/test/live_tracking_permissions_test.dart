import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/tracking_permissions.dart';
import 'package:point_app/features/map/presentation/live_tracking_health_banner.dart';
import 'package:point_app/theme/app_theme.dart';

const _backgroundBlocked = TrackingPermissionHealth(
  foregroundLocation: true,
  backgroundLocation: false,
  notifications: false,
  batteryUnrestricted: false,
  isAndroid: true,
);

class _FakeTrackingPermissions extends TrackingPermissions {
  TrackingPermissionIssue? fixed;

  @override
  Future<void> fix(TrackingPermissionIssue issue) async => fixed = issue;
}

Widget _host(_FakeTrackingPermissions permissions) => ProviderScope(
  overrides: [
    trackingPermissionsProvider.overrideWithValue(permissions),
    trackingPermissionHealthProvider.overrideWith(
      (_) async => _backgroundBlocked,
    ),
  ],
  child: MaterialApp(
    theme: AppTheme.dark(pureBlack: true),
    home: const Scaffold(body: LiveTrackingHealthBanner()),
  ),
);

void main() {
  test('health identifies missing settings in permission-ladder order', () {
    expect(
      const TrackingPermissionHealth(
        foregroundLocation: false,
        backgroundLocation: false,
        notifications: false,
        batteryUnrestricted: false,
        isAndroid: true,
      ).firstIssue,
      TrackingPermissionIssue.foregroundLocation,
    );
    expect(
      _backgroundBlocked.firstIssue,
      TrackingPermissionIssue.backgroundLocation,
    );
    expect(
      const TrackingPermissionHealth(
        foregroundLocation: true,
        backgroundLocation: true,
        notifications: false,
        batteryUnrestricted: false,
        isAndroid: true,
      ).firstIssue,
      TrackingPermissionIssue.notifications,
    );
    expect(
      const TrackingPermissionHealth(
        foregroundLocation: true,
        backgroundLocation: true,
        notifications: true,
        batteryUnrestricted: false,
        isAndroid: true,
      ).firstIssue,
      TrackingPermissionIssue.battery,
    );
  });

  testWidgets('banner fixes the exact issue and recurs after resume', (
    tester,
  ) async {
    final permissions = _FakeTrackingPermissions();
    await tester.pumpWidget(_host(permissions));
    await tester.pumpAndSettle();

    expect(find.text('Live tracking is off'), findsOneWidget);
    expect(find.text('Background location is not allowed'), findsOneWidget);
    await tester.tap(find.text('Fix'));
    await tester.pump();
    expect(
      permissions.fixed,
      TrackingPermissionIssue.backgroundLocation,
    );

    await tester.tap(find.byTooltip('Dismiss until Point resumes'));
    await tester.pump();
    expect(find.text('Live tracking is off'), findsNothing);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(find.text('Live tracking is off'), findsOneWidget);
  });
}
