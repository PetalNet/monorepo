import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/push/push_service.dart';
import 'package:point_app/features/settings/app_settings.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('PushTransportPolicy', () {
    test('registers UnifiedPush only when a distributor exists', () {
      expect(
        PushTransportPolicy.resolve(
          settings: const AppSettings(),
          hasDistributor: true,
        ),
        PushTransportPlan.registerUnifiedPush,
      );
      // D-027: the default choice (UnifiedPush) with no distributor is
      // unavailable — it never silently falls back to FCM.
      expect(
        PushTransportPolicy.resolve(
          settings: const AppSettings(),
          hasDistributor: false,
        ),
        PushTransportPlan.unavailable,
      );
    });

    test('an FCM choice on a build without Firebase never registers FCM — the '
        'private path wins (D-027)', () {
      // supportsFcm is false in the private base build, so the model itself
      // refuses to hold an unsupported FCM choice: nothing downstream can
      // register FCM behind the user's back.
      const settings = AppSettings(
        transport: NotifTransport.fcm,
        fcmFallback: true,
      );
      expect(settings.transport, NotifTransport.unifiedPush);
      expect(settings.fcmFallback, isFalse);
      // The resolved plan therefore follows the (coerced) private choice.
      expect(
        PushTransportPolicy.resolve(settings: settings, hasDistributor: true),
        PushTransportPlan.registerUnifiedPush,
      );
    });
  });

  test('restores registered transport and endpoint sync time', () async {
    FlutterSecureStorage.setMockInitialValues({
      'point.push.endpoint': 'https://push.example/device',
      'point.push.transport': 'unifiedpush',
      'point.push.synced_at': '2026-07-13T15:30:00.000Z',
    });
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final service = PushService(_dummyRef(container));
    addTearDown(service.dispose);

    await service.refreshDeliveryHealth();

    expect(service.deliveryHealth.value.isRegistered, isTrue);
    expect(service.deliveryHealth.value.registeredTransport, 'unifiedpush');
    expect(
      service.deliveryHealth.value.syncedAt?.toUtc(),
      DateTime.utc(2026, 7, 13, 15, 30),
    );
  });

  test('does not invent a transport for a legacy endpoint', () async {
    FlutterSecureStorage.setMockInitialValues({
      'point.push.endpoint': 'https://push.example/legacy-device',
    });
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final service = PushService(_dummyRef(container));
    addTearDown(service.dispose);

    await service.refreshDeliveryHealth();

    expect(service.deliveryHealth.value.isRegistered, isTrue);
    expect(service.deliveryHealth.value.registeredTransport, 'unknown');
    expect(service.deliveryHealth.value.syncedAt, isNull);
  });

  test(
    'test notification requests granted permission before display',
    () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final notifications = _RecordingNotifications();
      final service = PushService(
        _dummyRef(container),
        notifications: notifications,
      );
      addTearDown(service.dispose);

      expect(await service.sendTestNotification(), isTrue);
      expect(notifications.calls, ['permission', 'showTest']);
    },
  );

  test('test notification reports denied permission honestly', () async {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final notifications = _RecordingNotifications(permissionGranted: false);
    final service = PushService(
      _dummyRef(container),
      notifications: notifications,
    );
    addTearDown(service.dispose);

    expect(await service.sendTestNotification(), isFalse);
    expect(notifications.calls, ['permission']);
  });

  test('test notification reports unsupported display honestly', () async {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final notifications = _RecordingNotifications(supportsDisplay: false);
    final service = PushService(
      _dummyRef(container),
      notifications: notifications,
    );
    addTearDown(service.dispose);

    expect(await service.sendTestNotification(), isFalse);
    expect(notifications.calls, isEmpty);
  });
}

Ref _dummyRef(ProviderContainer container) {
  late Ref captured;
  final probe = Provider<void>((ref) => captured = ref);
  container.read(probe);
  return captured;
}

class _RecordingNotifications implements LocalNotificationGateway {
  _RecordingNotifications({
    this.supportsDisplay = true,
    this.permissionGranted = true,
  });

  final calls = <String>[];

  @override
  final bool supportsDisplay;
  final bool permissionGranted;

  @override
  Future<void> initialize(ValueChanged<String?> onPayload) async {}

  @override
  Future<bool> requestPermission() async {
    calls.add('permission');
    return permissionGranted;
  }

  @override
  Future<void> show(PushNotice notice) async => calls.add('show');

  @override
  Future<void> showTest() async => calls.add('showTest');
}
