import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';

enum TrackingPermissionIssue {
  foregroundLocation,
  backgroundLocation,
  notifications,
  battery,
}

extension TrackingPermissionIssueCopy on TrackingPermissionIssue {
  String get reason => switch (this) {
    TrackingPermissionIssue.foregroundLocation => 'Location access is denied',
    TrackingPermissionIssue.backgroundLocation =>
      'Background location is not allowed',
    TrackingPermissionIssue.notifications =>
      'The tracking notification is blocked',
    TrackingPermissionIssue.battery => 'Battery use is restricted',
  };
}

@immutable
class TrackingPermissionHealth {
  const TrackingPermissionHealth({
    required this.foregroundLocation,
    required this.backgroundLocation,
    required this.notifications,
    required this.batteryUnrestricted,
    required this.isAndroid,
  });

  const TrackingPermissionHealth.unsupported()
    : foregroundLocation = true,
      backgroundLocation = true,
      notifications = true,
      batteryUnrestricted = true,
      isAndroid = false;

  final bool foregroundLocation;
  final bool backgroundLocation;
  final bool notifications;
  final bool batteryUnrestricted;
  final bool isAndroid;

  bool get liveTrackingReady =>
      foregroundLocation &&
      backgroundLocation &&
      notifications &&
      batteryUnrestricted;

  TrackingPermissionIssue? get firstIssue {
    if (!foregroundLocation) return TrackingPermissionIssue.foregroundLocation;
    if (!backgroundLocation) return TrackingPermissionIssue.backgroundLocation;
    if (!notifications) return TrackingPermissionIssue.notifications;
    if (!batteryUnrestricted) return TrackingPermissionIssue.battery;
    return null;
  }
}

class TrackingPermissions {
  TrackingPermissions({
    MethodChannel batteryChannel = const MethodChannel(
      'dev.petalcat.point/battery_optimization',
    ),
  }) : _batteryChannel = batteryChannel;

  final MethodChannel _batteryChannel;

  bool get _isAndroid =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  Future<TrackingPermissionHealth> check() async {
    if (!_isAndroid) return const TrackingPermissionHealth.unsupported();

    final statuses = await Future.wait([
      Permission.locationWhenInUse.status,
      Permission.locationAlways.status,
      Permission.notification.status,
    ]);
    var batteryUnrestricted = false;
    try {
      batteryUnrestricted =
          await _batteryChannel.invokeMethod<bool>(
            'isIgnoringBatteryOptimizations',
          ) ??
          false;
    } on PlatformException {
      // Fail closed: a broken bridge must not silently claim tracking is live.
    } on MissingPluginException {
      // Tests and non-Android embedders do not install the native bridge.
    }

    return TrackingPermissionHealth(
      foregroundLocation: statuses[0].isGranted || statuses[1].isGranted,
      backgroundLocation: statuses[1].isGranted,
      notifications: statuses[2].isGranted,
      batteryUnrestricted: batteryUnrestricted,
      isAndroid: true,
    );
  }

  Future<void> requestForegroundLocation() async {
    await Permission.locationWhenInUse.request();
  }

  /// Android 11+ only offers "Allow all the time" in the app's system page.
  Future<void> openBackgroundLocationSettings() => openAppSettings();

  Future<void> requestNotifications() async {
    final status = await Permission.notification.status;
    if (status.isPermanentlyDenied || status.isRestricted) {
      await openAppSettings();
      return;
    }
    await Permission.notification.request();
  }

  Future<void> requestBatteryExemption() async {
    if (!_isAndroid) return;
    try {
      final opened = await _batteryChannel.invokeMethod<bool>(
        'requestIgnoreBatteryOptimizations',
      );
      if (opened != true) await openAppSettings();
    } on PlatformException {
      await openAppSettings();
    } on MissingPluginException {
      await openAppSettings();
    }
  }

  Future<void> fix(TrackingPermissionIssue issue) => switch (issue) {
    TrackingPermissionIssue.foregroundLocation => requestForegroundLocation(),
    TrackingPermissionIssue.backgroundLocation =>
      openBackgroundLocationSettings(),
    TrackingPermissionIssue.notifications => requestNotifications(),
    TrackingPermissionIssue.battery => requestBatteryExemption(),
  };
}

final trackingPermissionsProvider = Provider<TrackingPermissions>(
  (_) => TrackingPermissions(),
);

final trackingPermissionHealthProvider =
    FutureProvider<TrackingPermissionHealth>(
      (ref) => ref.watch(trackingPermissionsProvider).check(),
    );
