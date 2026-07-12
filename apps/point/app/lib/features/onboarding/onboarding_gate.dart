import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:geolocator/geolocator.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';

/// The required first-run steps, in sequence. Server pick and account
/// creation precede these (they gate themselves: no session, no shell).
enum OnboardingStep { recovery, privacy, location }

/// The launch gate: computes which required step is still incomplete so the
/// router can resume a half-set-up account exactly where it left off, on
/// every open. Reopening never drops someone into the shell with recovery
/// unsaved, no transport chosen, or location denied.
class OnboardingGate {
  OnboardingGate(
    this._ref, {
    FlutterSecureStorage? storage,
    Future<bool> Function()? locationCheck,
  }) : _storage = storage ?? const FlutterSecureStorage(),
       _locationCheck = locationCheck;

  final Ref _ref;
  final FlutterSecureStorage _storage;

  /// Injectable for tests (Geolocator is a static platform channel).
  final Future<bool> Function()? _locationCheck;

  static String _recoveryKey(String userId) =>
      'point.onboarding.recovery_saved.$userId';

  /// Whether [userId] has confirmed (on this device) that their recovery
  /// phrase is stored somewhere safe.
  Future<bool> recoverySaved(String userId) async =>
      await _storage.read(key: _recoveryKey(userId)) != null;

  Future<void> markRecoverySaved(String userId) =>
      _storage.write(key: _recoveryKey(userId), value: '1');

  /// Foreground location is the floor the engine runs on; the permission
  /// screen teaches the "all the time" upgrade but does not hold the app
  /// hostage for it.
  Future<bool> locationGranted() async {
    final check = _locationCheck;
    if (check != null) return check();
    final p = await Geolocator.checkPermission();
    return p == LocationPermission.always || p == LocationPermission.whileInUse;
  }

  /// The first incomplete required step for [session], or null when set-up is
  /// complete and the shell may open.
  Future<OnboardingStep?> firstIncomplete(Session session) async {
    if (!await recoverySaved(session.userId)) return OnboardingStep.recovery;
    if (!_ref.read(settingsProvider).transportChosen) {
      return OnboardingStep.privacy;
    }
    if (!await locationGranted()) return OnboardingStep.location;
    return null;
  }
}

final onboardingGateProvider = Provider<OnboardingGate>(OnboardingGate.new);
