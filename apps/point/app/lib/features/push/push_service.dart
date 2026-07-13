import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart'
    hide Person;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/relay/data/realtime_sync_coordinator.dart';
import 'package:point_app/features/relay/domain/realtime_sync_models.dart';
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
  PushService(
    this._ref, {
    FlutterSecureStorage? storage,
    LocalNotificationGateway? notifications,
  }) : _storage = storage ?? const FlutterSecureStorage(),
       _notifications = notifications ?? PluginLocalNotificationGateway();

  final Ref _ref;
  final FlutterSecureStorage _storage;
  final LocalNotificationGateway _notifications;

  /// The last endpoint we registered with the server, so a transport switch or
  /// sign-out can unregister it precisely.
  static const _endpointKey = 'point.push.endpoint';
  static const _snapshotKeyPrefix = 'point.push.snapshot.';

  bool _initialized = false;
  Future<void> _wakeTail = Future<void>.value();
  Future<void> _notificationTail = Future<void>.value();
  StreamSubscription<RealtimeSyncDiff>? _syncDiffSub;
  final _syncAnnouncements = PushSyncAnnouncementState();
  final _foregroundNotices = StreamController<PushNotice>.broadcast();
  final _destinations = StreamController<PushDestination>.broadcast();

  Stream<PushNotice> get foregroundNotices => _foregroundNotices.stream;
  Stream<PushDestination> get destinations => _destinations.stream;

  /// Wire the UnifiedPush callbacks once, at app start. Idempotent.
  Future<void> init() async {
    if (_initialized) return;
    _initialized = true;
    _syncDiffSub = _ref
        .read(realtimeSyncCoordinatorProvider)
        .diffs
        .listen(_enqueueSyncDiff);
    try {
      await _notifications.initialize(_onNotificationPayload);
    } on Object catch (e) {
      // Local display failing must not disable the wake transport: the app can
      // still reconcile visibly when opened.
      if (kDebugMode) debugPrint('local notification init failed: $e');
    }
    try {
      await UnifiedPush.initialize(
        onNewEndpoint: (endpoint, _) => unawaited(_onEndpoint(endpoint.url)),
        onMessage: (message, _) => _enqueueWake(message.content),
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
      // This is contextual rather than an app-launch prompt: only ask once the
      // user has selected a working notification transport and Point has an
      // endpoint to receive wakes on.
      if (await _storage.read(key: _endpointKey) != null) {
        await _notifications.requestPermission();
      }
    } on Object catch (e) {
      if (kDebugMode) debugPrint('unifiedpush register failed: $e');
    }
  }

  /// A convenient-tier (Firebase) build calls this with its FCM token.
  Future<void> registerFcm(String fcmToken) async {
    final session = _ref.read(authControllerProvider).value;
    if (session == null) return;
    await _ensureBaseline(session);
    if (!_isCurrent(session)) return;
    await _uploadEndpoint(session, transport: 'fcm', endpoint: fcmToken);
  }

  Future<void> _onEndpoint(String url) async {
    final session = _ref.read(authControllerProvider).value;
    if (session == null) return;
    // Establish the last-seen snapshot before making the endpoint reachable.
    // That ordering avoids treating every existing request/share as new on a
    // fresh registration.
    await _ensureBaseline(session);
    if (!_isCurrent(session)) return;
    await _uploadEndpoint(session, transport: 'unifiedpush', endpoint: url);
  }

  Future<void> _uploadEndpoint(
    Session session, {
    required String transport,
    required String endpoint,
  }) async {
    if (!_isCurrent(session)) return;
    try {
      await _ref
          .read(apiProvider)
          .registerPush(
            session.token,
            transport: transport,
            endpoint: endpoint,
          );
      if (!_isCurrent(session)) {
        // Registration won a race with sign-out/account switch. Undo it with
        // the credential that created it so the old account is not re-woken.
        await _ref.read(apiProvider).unregisterPush(session.token, endpoint);
        return;
      }
      await _storage.write(key: _endpointKey, value: endpoint);
    } on Object catch (e) {
      if (kDebugMode) debugPrint('push endpoint upload failed: $e');
      return;
    }
    try {
      await _notifications.requestPermission();
    } on Object catch (e) {
      if (kDebugMode) debugPrint('notification permission request failed: $e');
    }
  }

  bool _isCurrent(Session session) {
    final current = _ref.read(authControllerProvider).value;
    return current?.userId == session.userId && current?.token == session.token;
  }

  /// A wake carries no content by design. Its only meaning is “authoritative
  /// state may have changed,” so route it through the full ordered catch-up.
  void _enqueueWake(List<int> content) {
    _wakeTail = _wakeTail
        .catchError((Object _) {})
        .then(
          (_) => _onWake(content),
        );
  }

  /// Reconcile a contentless wake against the persisted authoritative state.
  /// Wakes are serialized by [_enqueueWake], so two deliveries cannot both
  /// compare against the same snapshot and produce duplicate notifications.
  Future<void> _onWake(List<int> content) async {
    if (_ref.read(authControllerProvider).value == null) return;
    await _ref
        .read(realtimeSyncCoordinatorProvider)
        .syncNow(RealtimeSyncReason.pushWake);
  }

  void _enqueueSyncDiff(RealtimeSyncDiff diff) {
    _notificationTail = _notificationTail
        .catchError((Object _) {})
        .then((_) => _processSyncDiff(diff));
  }

  /// Consume the coordinator's one authoritative diff stream. This catches
  /// both contentless push wakes and live WebSocket events that arrive while
  /// Android has kept the socket connected in the background.
  Future<void> _processSyncDiff(RealtimeSyncDiff diff) async {
    final changedExternally = _syncAnnouncements.observe(
      diff.reason,
      healthy: diff.healthy,
    );
    final session = _ref.read(authControllerProvider).value;
    if (session == null || !diff.healthy) return;
    final previous = await _readSnapshot(session);
    if (!_isCurrent(session)) return;

    final current = PushSnapshot.capture(_ref);
    final decision = changedExternally
        ? PushWakePolicy.decide(
            previous: previous,
            current: current,
            incomingAdded: diff.incomingRequestsAdded,
            sharesAdded: diff.sharesAdded,
          )
        : PushWakeDecision(nextSnapshot: current, notices: const []);

    // Commit last-seen before display. A repeated distributor wake can then
    // never duplicate an already-decided notification, even if the platform
    // rejects display because permission was denied.
    await _writeSnapshot(session, decision.nextSnapshot);
    if (!_isCurrent(session)) return;

    for (final notice in decision.notices) {
      if (_isForegrounded) {
        _foregroundNotices.add(notice);
      } else {
        await _notifications.show(notice);
      }
    }
  }

  void _onNotificationPayload(String? payload) {
    final destination = PushDestination.fromPayload(payload);
    if (destination != null) _destinations.add(destination);
  }

  bool get _isForegrounded =>
      WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;

  Future<void> _ensureBaseline(Session session) async {
    if (await _readSnapshot(session) != null) return;
    final diff = await _ref
        .read(realtimeSyncCoordinatorProvider)
        .syncNow(RealtimeSyncReason.pushWake);
    if (diff.healthy &&
        _ref.read(authControllerProvider).value?.userId == session.userId) {
      await _writeSnapshot(session, PushSnapshot.capture(_ref));
    }
  }

  String _snapshotKey(Session session) =>
      '$_snapshotKeyPrefix${Uri.encodeComponent(session.userId)}';

  Future<PushSnapshot?> _readSnapshot(Session session) async {
    final encoded = await _storage.read(key: _snapshotKey(session));
    if (encoded == null) return null;
    try {
      return PushSnapshot.fromJson(
        jsonDecode(encoded) as Map<String, dynamic>,
      );
    } on Object {
      return null;
    }
  }

  Future<void> _writeSnapshot(Session session, PushSnapshot snapshot) =>
      _storage.write(
        key: _snapshotKey(session),
        value: jsonEncode(snapshot.toJson()),
      );

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
    // Let an already-delivered wake observe the signed-out session and finish
    // before deleting state, so it cannot recreate the old account snapshot.
    try {
      await Future.wait([
        _wakeTail.catchError((Object _) {}),
        _notificationTail.catchError((Object _) {}),
      ]).timeout(const Duration(seconds: 3));
    } on TimeoutException {
      // In-flight work rechecks the active session before every write/display,
      // so endpoint cleanup can safely win over a wedged network catch-up.
    }
    _syncAnnouncements.reset();
    await _clearServerEndpoint(session);
    if (session != null) {
      await _storage.delete(key: _snapshotKey(session));
    }
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

  Future<void> dispose() async {
    await _syncDiffSub?.cancel();
    await _foregroundNotices.close();
    await _destinations.close();
  }
}

/// Persisted, privacy-minimal state used to decide whether a contentless wake
/// represents a user-visible request or acceptance. Display names and location
/// data never enter storage or notification bodies.
@immutable
class PushSnapshot {
  const PushSnapshot({
    required this.people,
    required this.incoming,
  });

  factory PushSnapshot.capture(Ref ref) => PushSnapshot(
    people: {
      for (final person
          in ref.read(peopleControllerProvider).value ?? const <Person>[])
        person.userId,
    },
    incoming: {
      for (final request
          in ref.read(requestsControllerProvider).value ??
              const <ShareRequest>[])
        request.id,
    },
  );

  factory PushSnapshot.fromJson(Map<String, dynamic> json) => PushSnapshot(
    people: Set<String>.from(json['people'] as List<dynamic>),
    incoming: Set<String>.from(json['incoming'] as List<dynamic>),
  );

  final Set<String> people;
  final Set<String> incoming;

  Map<String, Object> toJson() => {
    'people': people.toList()..sort(),
    'incoming': incoming.toList()..sort(),
  };
}

enum PushNoticeKind { incomingRequest, sharingStarted }

@immutable
class PushNotice {
  const PushNotice({
    required this.kind,
    required this.eventId,
    required this.destination,
    required this.badge,
  });

  final PushNoticeKind kind;
  final String eventId;
  final PushDestination destination;
  final int badge;

  String get payload => destination.payload;

  int get notificationId {
    // Stable FNV-1a, masked to Android's signed 31-bit notification id range.
    var hash = 0x811c9dc5;
    for (final byte in utf8.encode('${kind.name}:$eventId')) {
      hash = ((hash ^ byte) * 0x01000193) & 0xffffffff;
    }
    return hash & 0x7fffffff;
  }

  String get title => switch (kind) {
    PushNoticeKind.incomingRequest => 'New sharing request',
    PushNoticeKind.sharingStarted => 'Sharing started',
  };

  String get body => switch (kind) {
    PushNoticeKind.incomingRequest => 'Open Point to review it.',
    PushNoticeKind.sharingStarted => 'Open Point to see the update.',
  };
}

/// Pure transition policy, kept separate from platform delivery so duplicate,
/// acceptance, and removal behavior can be regression-tested deterministically.
abstract final class PushNotificationPolicy {
  static List<PushNotice> notices(
    PushSnapshot previous,
    PushSnapshot current, {
    Set<String>? incomingAdded,
    Set<String>? sharesAdded,
  }) {
    final newlyIncoming = current.incoming
        .difference(previous.incoming)
        .intersection(incomingAdded ?? current.incoming);
    final newlySharing = current.people
        .difference(previous.people)
        .intersection(sharesAdded ?? current.people);
    final notices = <PushNotice>[
      for (final id in newlyIncoming)
        PushNotice(
          kind: PushNoticeKind.incomingRequest,
          eventId: id,
          destination: const RequestsPushDestination(),
          badge: current.incoming.length,
        ),
    ];

    for (final userId in newlySharing) {
      notices.add(
        PushNotice(
          kind: PushNoticeKind.sharingStarted,
          eventId: userId,
          destination: PersonPushDestination(userId),
          badge: current.incoming.length,
        ),
      );
    }
    return notices;
  }
}

@immutable
class PushWakeDecision {
  const PushWakeDecision({
    required this.nextSnapshot,
    required this.notices,
  });

  final PushSnapshot nextSnapshot;
  final List<PushNotice> notices;
}

/// State transition after a healthy authoritative reconciliation. The current
/// snapshot always advances; a missing migration baseline stays silent.
abstract final class PushWakePolicy {
  static PushWakeDecision decide({
    required PushSnapshot? previous,
    required PushSnapshot current,
    Set<String>? incomingAdded,
    Set<String>? sharesAdded,
  }) => PushWakeDecision(
    nextSnapshot: current,
    notices: previous == null
        ? const []
        : PushNotificationPolicy.notices(
            previous,
            current,
            incomingAdded: incomingAdded,
            sharesAdded: sharesAdded,
          ),
  );
}

abstract final class PushSyncPolicy {
  static bool announces(RealtimeSyncReason reason) => switch (reason) {
    RealtimeSyncReason.pushWake ||
    RealtimeSyncReason.shareRequest ||
    RealtimeSyncReason.relayEvent => true,
    _ => false,
  };
}

/// Carries an external-event intent across the coordinator's bounded retry.
/// Otherwise a failed push pass followed by a healthy `retry` would persist the
/// change silently because `retry` itself is not an event source.
class PushSyncAnnouncementState {
  bool _pending = false;

  bool observe(RealtimeSyncReason reason, {required bool healthy}) {
    if (PushSyncPolicy.announces(reason)) _pending = true;
    if (!healthy) return false;
    final announce = _pending;
    _pending = false;
    return announce;
  }

  void reset() => _pending = false;
}

sealed class PushDestination {
  const PushDestination();

  static PushDestination? fromPayload(String? payload) {
    if (payload == 'requests') return const RequestsPushDestination();
    if (payload?.startsWith('person:') ?? false) {
      final encoded = payload!.substring('person:'.length);
      if (encoded.isEmpty) return null;
      try {
        return PersonPushDestination(Uri.decodeComponent(encoded));
      } on FormatException {
        return null;
      }
    }
    return null;
  }

  String get payload;
}

final class RequestsPushDestination extends PushDestination {
  const RequestsPushDestination();

  @override
  String get payload => 'requests';
}

final class PersonPushDestination extends PushDestination {
  const PersonPushDestination(this.userId);

  final String userId;

  @override
  String get payload => 'person:${Uri.encodeComponent(userId)}';
}

abstract interface class LocalNotificationGateway {
  Future<void> initialize(ValueChanged<String?> onPayload);
  Future<void> requestPermission();
  Future<void> show(PushNotice notice);
}

class PluginLocalNotificationGateway implements LocalNotificationGateway {
  PluginLocalNotificationGateway({FlutterLocalNotificationsPlugin? plugin})
    : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  static const _channel = AndroidNotificationChannel(
    'point_relationships',
    'Sharing activity',
    description: 'New sharing requests and accepted requests',
    importance: Importance.high,
  );

  final FlutterLocalNotificationsPlugin _plugin;

  @override
  Future<void> initialize(ValueChanged<String?> onPayload) async {
    if (kIsWeb ||
        (defaultTargetPlatform != TargetPlatform.android &&
            defaultTargetPlatform != TargetPlatform.iOS)) {
      return;
    }
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('ic_notification'),
        iOS: DarwinInitializationSettings(
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
        ),
      ),
      onDidReceiveNotificationResponse: (response) =>
          onPayload(response.payload),
    );
    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.createNotificationChannel(_channel);
    final launch = await _plugin.getNotificationAppLaunchDetails();
    if (launch?.didNotificationLaunchApp ?? false) {
      onPayload(launch?.notificationResponse?.payload);
    }
  }

  @override
  Future<void> requestPermission() async {
    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.requestNotificationsPermission();
    await _plugin
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >()
        ?.requestPermissions(alert: true, badge: true, sound: true);
  }

  @override
  Future<void> show(PushNotice notice) async {
    if (kIsWeb ||
        (defaultTargetPlatform != TargetPlatform.android &&
            defaultTargetPlatform != TargetPlatform.iOS)) {
      return;
    }
    await _plugin.show(
      id: notice.notificationId,
      title: notice.title,
      body: notice.body,
      payload: notice.payload,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          _channel.id,
          _channel.name,
          channelDescription: _channel.description,
          importance: Importance.high,
          priority: Priority.high,
          number: notice.badge,
          category: AndroidNotificationCategory.social,
        ),
        iOS: DarwinNotificationDetails(badgeNumber: notice.badge),
      ),
    );
  }
}

final pushServiceProvider = Provider<PushService>((ref) {
  final service = PushService(ref);
  ref.onDispose(() => unawaited(service.dispose()));
  return service;
});
