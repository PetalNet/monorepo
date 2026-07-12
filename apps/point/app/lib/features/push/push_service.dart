import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:unifiedpush/unifiedpush.dart';

/// Wake transport (Wave D). Registers this device with the user's chosen
/// transport and, on a wake, pulls the detail over the authenticated API — the
/// wake itself carries no who or where.
///
/// UnifiedPush is fully wired: register with the distributor, POST the
/// endpoint to the server, and refresh the relevant controllers when a wake
/// arrives. FCM registration is transport-agnostic on the server; the device
/// side needs a Firebase build (google-services.json + firebase_messaging),
/// which a convenient-tier flavor supplies. Until then the private path is the
/// one delivering.
class PushService {
  PushService(this._ref, {FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final Ref _ref;
  final FlutterSecureStorage _storage;

  /// The last endpoint we registered with the server, so a transport switch or
  /// sign-out can unregister it precisely.
  static const _endpointKey = 'point.push.endpoint';

  bool _initialized = false;

  /// Wire the UnifiedPush callbacks once, at app start. Idempotent.
  Future<void> init() async {
    if (_initialized) return;
    _initialized = true;
    try {
      await UnifiedPush.initialize(
        onNewEndpoint: (endpoint, _) => unawaited(_onEndpoint(endpoint.url)),
        onMessage: (message, _) => unawaited(_onWake(message.content)),
        onUnregistered: (_) => unawaited(_onUnregistered()),
      );
    } on Object catch (e) {
      if (kDebugMode) debugPrint('unifiedpush init failed: $e');
    }
  }

  /// Bring registration in line with the current transport setting. Called on
  /// sign-in and whenever the notification transport changes.
  ///
  /// UnifiedPush registration is attempted whenever a distributor is available,
  /// EVEN on the convenient/FCM choice: a real device push beats none, and the
  /// base build has no Firebase SDK to mint an FCM token. So a convenient-tier
  /// user with ntfy installed still gets push (via UP); only a user with no
  /// distributor AND no FCM flavor gets nothing — which is inherent, not a
  /// silent failure this code introduces. A convenient-tier build flavor
  /// (firebase_messaging + google-services.json) calls [registerFcm].
  Future<void> sync() async {
    try {
      final distributors = await UnifiedPush.getDistributors();
      if (distributors.isNotEmpty) {
        final ok = await UnifiedPush.tryUseCurrentOrDefaultDistributor();
        if (ok) await UnifiedPush.register();
      }
    } on Object catch (e) {
      if (kDebugMode) debugPrint('unifiedpush register failed: $e');
    }
  }

  /// A convenient-tier (Firebase) build calls this with its FCM token.
  Future<void> registerFcm(String fcmToken) async {
    final session = _ref.read(authControllerProvider).value;
    if (session == null) return;
    await _uploadEndpoint(session, transport: 'fcm', endpoint: fcmToken);
  }

  Future<void> _onEndpoint(String url) async {
    final session = _ref.read(authControllerProvider).value;
    if (session == null) return;
    await _uploadEndpoint(session, transport: 'unifiedpush', endpoint: url);
  }

  Future<void> _uploadEndpoint(
    Session session, {
    required String transport,
    required String endpoint,
  }) async {
    try {
      await _ref
          .read(apiProvider)
          .registerPush(session.token, transport: transport, endpoint: endpoint);
      await _storage.write(key: _endpointKey, value: endpoint);
    } on Object catch (e) {
      if (kDebugMode) debugPrint('push endpoint upload failed: $e');
    }
  }

  /// A wake arrived. It carries no content by design, so we simply refresh the
  /// surfaces a v1 wake can concern — pending requests and the people list —
  /// over the authenticated API. Skipped when signed out (nothing to pull).
  Future<void> _onWake(List<int> content) async {
    if (_ref.read(authControllerProvider).value == null) return;
    unawaited(_ref.read(requestsControllerProvider.notifier).refresh());
    unawaited(_ref.read(peopleControllerProvider.notifier).refresh());
    unawaited(_ref.read(tempSharesControllerProvider.notifier).refresh());
  }

  Future<void> _onUnregistered() async {
    await _clearServerEndpoint();
  }

  /// Unregister from the distributor AND tell the server to forget the
  /// endpoint. Called on sign-out and on a switch away from UnifiedPush.
  ///
  /// [session] is passed explicitly because on the sign-out path the auth
  /// controller has already emitted null; without it the server-side
  /// unregister would be skipped and the endpoint would linger, still woken.
  Future<void> teardown(Session? session) async {
    try {
      await UnifiedPush.unregister();
    } on Object catch (e) {
      if (kDebugMode) debugPrint('unifiedpush unregister failed: $e');
    }
    await _clearServerEndpoint(session);
  }

  Future<void> _clearServerEndpoint([Session? session]) async {
    final endpoint = await _storage.read(key: _endpointKey);
    session ??= _ref.read(authControllerProvider).value;
    if (endpoint != null && session != null) {
      try {
        await _ref.read(apiProvider).unregisterPush(session.token, endpoint);
      } on Object catch (e) {
        if (kDebugMode) debugPrint('push endpoint clear failed: $e');
      }
    }
    await _storage.delete(key: _endpointKey);
  }
}

final pushServiceProvider = Provider<PushService>(PushService.new);
