import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/onboarding/onboarding_gate.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';

const _session = Session(
  token: 't',
  userId: 'parker@localhost',
  displayName: 'Parker',
  isAdmin: false,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ProviderContainer container;
  late OnboardingGate gate;
  var locationGranted = false;

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    locationGranted = false;
    container = ProviderContainer();
    addTearDown(container.dispose);
    gate = OnboardingGate(
      _dummyRef(container),
      locationCheck: () async => locationGranted,
    );
  });

  test('a fresh account stops at every step in sequence', () async {
    expect(await gate.firstIncomplete(_session), OnboardingStep.recovery);

    await gate.markRecoverySaved(_session.userId);
    expect(await gate.firstIncomplete(_session), OnboardingStep.privacy);

    final settings = container.read(settingsProvider.notifier);
    await settings.applyPrivacyFork(private: true);
    await settings.markTransportChosen();
    expect(await gate.firstIncomplete(_session), OnboardingStep.location);

    locationGranted = true;
    expect(await gate.firstIncomplete(_session), isNull);
  });

  test('the private fork only completes after the distributor guide', () async {
    await gate.markRecoverySaved(_session.userId);
    final settings = container.read(settingsProvider.notifier);

    await settings.applyPrivacyFork(private: true);
    // Killed mid-guide: still resumes at the privacy step.
    expect(await gate.firstIncomplete(_session), OnboardingStep.privacy);

    await settings.markTransportChosen();
    locationGranted = true;
    expect(await gate.firstIncomplete(_session), isNull);
  });

  test('recovery confirmation is per account', () async {
    await gate.markRecoverySaved(_session.userId);
    const other = Session(
      token: 't2',
      userId: 'eli@localhost',
      displayName: 'Eli',
      isAdmin: false,
    );
    expect(await gate.firstIncomplete(other), OnboardingStep.recovery);
  });

  test('revoking location later re-gates the location step', () async {
    await gate.markRecoverySaved(_session.userId);
    final settings = container.read(settingsProvider.notifier);
    await settings.applyPrivacyFork(private: true);
    await settings.markTransportChosen();
    locationGranted = true;
    expect(await gate.firstIncomplete(_session), isNull);

    locationGranted = false;
    expect(await gate.firstIncomplete(_session), OnboardingStep.location);
  });

  test('the gate normalizes FCM without trapping a finished account', () async {
    // A previous build could persist FCM even though this package has no
    // Firebase token source. Loading must repair that dishonest state.
    FlutterSecureStorage.setMockInitialValues({
      'point.settings':
          '{"map_provider":"proxied","transport":"fcm",'
          '"fcm_fallback":true,"transport_chosen":true}',
    });
    final freshContainer = ProviderContainer();
    addTearDown(freshContainer.dispose);
    final freshGate = OnboardingGate(
      _dummyRef(freshContainer),
      locationCheck: () async => true,
    );
    await freshGate.markRecoverySaved(_session.userId);
    // First read of settingsProvider happens INSIDE the gate call, exactly
    // like a cold app start.
    expect(await freshGate.firstIncomplete(_session), isNull);
    final migrated = freshContainer.read(settingsProvider);
    expect(migrated.transport, NotifTransport.unifiedPush);
    expect(migrated.fcmFallback, isFalse);
    expect(migrated.transportChosen, isTrue);
    expect(migrated.needsPushMigration, isTrue);
  });

  test('the privacy fork writes the right tiers', () async {
    final settings = container.read(settingsProvider.notifier);

    await settings.applyPrivacyFork(private: true);
    var s = container.read(settingsProvider);
    expect(s.mapProvider, MapProviderChoice.selfHosted);
    expect(s.transport, NotifTransport.unifiedPush);
    expect(s.fcmFallback, isFalse);

    await settings.applyPrivacyFork(private: false);
    s = container.read(settingsProvider);
    expect(s.mapProvider, MapProviderChoice.proxied);
    expect(s.transport, NotifTransport.unifiedPush);
    expect(s.fcmFallback, isFalse);
    expect(s.transportChosen, isTrue);
    expect(s.needsPushMigration, isTrue);
  });
}

/// The gate only uses `ref.read`, so a raw container-backed shim suffices.
Ref _dummyRef(ProviderContainer container) {
  late Ref captured;
  final probe = Provider<void>((ref) => captured = ref);
  container.read(probe);
  return captured;
}
