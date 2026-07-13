import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:point_app/services/api/models.dart';

/// Thin typed client over the Point home-server REST surface (M0). One instance
/// per configured server; the auth token is attached per-call by the caller
/// (session lives in the auth controller, not here).
class PointApi {
  PointApi({required this.baseUrl, http.Client? client})
    : _client = client ?? http.Client();

  /// e.g. `https://point.petalcat.dev` or `http://10.0.2.2:8330` in dev.
  final String baseUrl;
  final http.Client _client;

  Uri _u(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> _headers([String? token]) => {
    'content-type': 'application/json',
    if (token != null) 'authorization': 'Bearer $token',
  };

  Never _fail(http.Response r) {
    String message;
    try {
      message = (jsonDecode(r.body) as Map<String, dynamic>)['error'] as String;
    } on Object {
      message = 'request failed (${r.statusCode})';
    }
    throw ApiException(message, r.statusCode);
  }

  /// Confirm [origin] speaks the Point protocol: fetch `/.well-known/point`
  /// and return the domain it advertises. Throws [ApiException] when the host
  /// is unreachable or not a Point server. Static because it runs BEFORE a
  /// server is chosen (the server-pick step), against an arbitrary origin.
  static Future<String> probe(String origin) async {
    final client = http.Client();
    try {
      final r = await client
          .get(Uri.parse('$origin/.well-known/point'))
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) {
        throw ApiException(
          'no Point server found there (${r.statusCode})',
          r.statusCode,
        );
      }
      final v = jsonDecode(r.body) as Map<String, dynamic>;
      final domain = v['domain'] as String?;
      if (domain == null || domain.isEmpty) {
        throw const ApiException('no Point server found there', 200);
      }
      return domain;
    } on ApiException {
      rethrow;
    } on Object {
      throw const ApiException('could not reach that server', 0);
    } finally {
      client.close();
    }
  }

  // --- Auth ---------------------------------------------------------------

  Future<Session> register({
    required String username,
    required String password,
    String? displayName,
    String? inviteCode,
  }) async {
    final r = await _client.post(
      _u('/api/register'),
      headers: _headers(),
      body: jsonEncode({
        'username': username,
        'password': password,
        if (displayName != null) 'display_name': displayName,
        if (inviteCode != null) 'invite_code': inviteCode,
      }),
    );
    if (r.statusCode != 200) _fail(r);
    return Session.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  Future<Session> login({
    required String username,
    required String password,
  }) async {
    final r = await _client.post(
      _u('/api/login'),
      headers: _headers(),
      body: jsonEncode({'username': username, 'password': password}),
    );
    if (r.statusCode != 200) _fail(r);
    return Session.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  // --- Profile / privacy (Wave B: the Me tab) ------------------------------

  /// The signed-in user's full profile row.
  Future<MeProfile> getMe(String token) async {
    final r = await _client.get(_u('/api/me'), headers: _headers(token));
    if (r.statusCode != 200) _fail(r);
    return MeProfile.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  /// Change my display name; returns the server-sanitized result.
  Future<String> updateProfile(String token, String displayName) async {
    final r = await _client.put(
      _u('/api/account/profile'),
      headers: _headers(token),
      body: jsonEncode({'display_name': displayName}),
    );
    if (r.statusCode != 200) _fail(r);
    final v = jsonDecode(r.body) as Map<String, dynamic>;
    return v['display_name'] as String;
  }

  /// Who may open a share request to me: anyone | same_server | nobody.
  Future<void> updatePrivacy(String token, String whoCanAddMe) async {
    final r = await _client.put(
      _u('/api/account/privacy'),
      headers: _headers(token),
      body: jsonEncode({'who_can_add_me': whoCanAddMe}),
    );
    if (r.statusCode != 200) _fail(r);
  }

  /// Set my photo-dot (jpeg/png/webp bytes, <=128 KiB).
  Future<void> uploadAvatar(
    String token,
    List<int> bytes, {
    required String mime,
  }) async {
    final r = await _client.post(
      _u('/api/account/avatar'),
      headers: _headers(token),
      body: jsonEncode({'data': base64Encode(bytes), 'mime': mime}),
    );
    if (r.statusCode != 200) _fail(r);
  }

  Future<void> deleteAvatar(String token) async {
    final r = await _client.delete(
      _u('/api/account/avatar'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
  }

  /// A person's photo-dot bytes, or null when they have none (or the server
  /// gates it: strangers see the same 404 as no-avatar).
  Future<Uint8List?> fetchAvatar(String token, String userId) async {
    final r = await _client.get(
      _u('/api/users/$userId/avatar'),
      headers: _headers(token),
    );
    if (r.statusCode == 404) return null;
    if (r.statusCode != 200) _fail(r);
    return r.bodyBytes;
  }

  // --- Sharing / people ---------------------------------------------------

  Future<List<Map<String, dynamic>>> activeShares(String token) async {
    final r = await _client.get(_u('/api/shares'), headers: _headers(token));
    if (r.statusCode != 200) _fail(r);
    return (jsonDecode(r.body) as List<dynamic>).cast<Map<String, dynamic>>();
  }

  Future<List<ShareRequest>> incomingRequests(String token) async {
    final r = await _client.get(
      _u('/api/shares/requests'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
    return (jsonDecode(r.body) as List<dynamic>)
        .map(
          (e) => IncomingRequestRecord.fromJson(e as Map<String, dynamic>),
        )
        .toList();
  }

  Future<List<OutgoingShareRequest>> outgoingRequests(String token) async {
    final r = await _client.get(
      _u('/api/shares/requests/outgoing'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
    return (jsonDecode(r.body) as List<dynamic>)
        .map(
          (e) => OutgoingRequestRecord.fromJson(e as Map<String, dynamic>),
        )
        .toList();
  }

  Future<void> sendShareRequest(String token, String toUserId) async {
    final r = await _client.post(
      _u('/api/shares/request'),
      headers: _headers(token),
      body: jsonEncode({'to_user_id': toUserId}),
    );
    if (r.statusCode != 200) _fail(r);
    final body = jsonDecode(r.body) as Map<String, dynamic>;
    if (body['recorded'] == false) {
      throw const ApiException('That handle could not be found.', 404);
    }
  }

  Future<void> acceptRequest(String token, String id) async {
    final r = await _client.post(
      _u('/api/shares/requests/$id/accept'),
      headers: _headers(token),
      body: '{}',
    );
    if (r.statusCode != 200) _fail(r);
  }

  /// Decline an incoming share request (404 if not the addressee / not pending).
  Future<void> rejectRequest(String token, String id) async {
    final r = await _client.post(
      _u('/api/shares/requests/$id/reject'),
      headers: _headers(token),
      body: '{}',
    );
    if (r.statusCode != 200) _fail(r);
  }

  /// Withdraw one of the signed-in user's pending outgoing requests.
  Future<void> cancelRequest(String token, String id) async {
    final r = await _client.delete(
      _u('/api/shares/requests/$id'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
  }

  /// Stop sharing with a person: removes the mutual share (and clears any
  /// pending request rows between the pair, server-side).
  Future<void> deleteShare(String token, String userId) async {
    final r = await _client.delete(
      _u('/api/shares/$userId'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
  }

  Future<void> createTempShare(
    String token,
    String toUserId,
    int durationMinutes,
  ) async {
    final r = await _client.post(
      _u('/api/shares/temp'),
      headers: _headers(token),
      body: jsonEncode({
        'to_user_id': toUserId,
        'duration_minutes': durationMinutes,
      }),
    );
    if (r.statusCode != 200) _fail(r);
  }

  /// Active temporary shares involving me (both the ones I'm pushing and the
  /// ones being pushed to me), soonest-to-expire first.
  Future<List<TempShare>> listTempShares(String token) async {
    final r = await _client.get(
      _u('/api/shares/temp'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
    return (jsonDecode(r.body) as List<dynamic>)
        .map((e) => TempShare.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// Stop one of MY outgoing temporary shares early.
  Future<void> deleteTempShare(String token, String id) async {
    final r = await _client.delete(
      _u('/api/shares/temp/$id'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
  }

  // --- Ghost --------------------------------------------------------------

  Future<GhostState> getGhost(String token) async {
    final r = await _client.get(_u('/api/ghost'), headers: _headers(token));
    if (r.statusCode != 200) _fail(r);
    return GhostState.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  Future<GhostState> setGhost(String token, {required bool active}) async {
    final r = await _client.put(
      _u('/api/ghost'),
      headers: _headers(token),
      body: jsonEncode({'active': active}),
    );
    if (r.statusCode != 200) _fail(r);
    return GhostState.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  /// Per-person hide: go dark to (or un-hide from) a single [userId]. The server
  /// enforces this in the authz gate the same as the global switch.
  Future<void> setGhostTarget(
    String token,
    String userId, {
    required bool ghosted,
  }) async {
    final r = await _client.put(
      _u('/api/ghost/targets'),
      headers: _headers(token),
      body: jsonEncode({'user_id': userId, 'ghosted': ghosted}),
    );
    if (r.statusCode != 200) _fail(r);
  }

  // --- MLS delivery (GO-bar #4: reliable sharing, one-time KeyPackages) ------

  /// Upload a pool of one-time KeyPackages (base64) + optionally the last-resort
  /// one. Uploading a POOL (not a single package) is the client half of the
  /// fix for the legacy single-KeyPackage silent-member-drop.
  /// [replace] drops the caller's unconsumed pool first — required whenever
  /// the MLS identity changed (recovery restore / re-key), so peers can never
  /// claim a package whose private half is gone.
  Future<void> uploadKeyPackages(
    String token,
    List<String> keyPackages, {
    String? lastResort,
    bool replace = false,
  }) async {
    final r = await _client.post(
      _u('/api/mls/keys'),
      headers: _headers(token),
      body: jsonEncode({
        'key_packages': keyPackages,
        if (lastResort != null) 'last_resort': lastResort,
        if (replace) 'replace': true,
      }),
    );
    if (r.statusCode != 200) _fail(r);
  }

  /// Consume ONE of a target's KeyPackages (POST is non-idempotent by design).
  /// Returns the base64 package + whether it was the last-resort fallback.
  Future<({String keyPackage, bool lastResort})> claimKeyPackage(
    String token,
    String targetUserId,
  ) async {
    final r = await _client.post(
      _u('/api/mls/keys/$targetUserId/claim'),
      headers: _headers(token),
      body: '{}',
    );
    if (r.statusCode != 200) _fail(r);
    final v = jsonDecode(r.body) as Map<String, dynamic>;
    return (
      keyPackage: v['key_package'] as String,
      lastResort: v['last_resort'] as bool? ?? false,
    );
  }

  /// Non-consuming probe of the local pool (for replenish logic).
  Future<({int available, bool hasLastResort, DateTime rekeyedAt})> keyCount(
    String token,
  ) async {
    final r = await _client.get(
      _u('/api/mls/keys/count'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
    final v = jsonDecode(r.body) as Map<String, dynamic>;
    return (
      // The server serializes the pool level as `count`.
      available: v['count'] as int? ?? 0,
      hasLastResort: v['has_last_resort'] as bool? ?? false,
      rekeyedAt: DateTime.parse(v['rekeyed_at'] as String),
    );
  }

  Future<void> sendWelcome(
    String token, {
    required String recipientId,
    required String groupId,
    required String payload,
  }) async {
    final r = await _client.post(
      _u('/api/mls/welcome'),
      headers: _headers(token),
      body: jsonEncode({
        'recipient_id': recipientId,
        'group_id': groupId,
        'payload': payload,
      }),
    );
    if (r.statusCode != 200) _fail(r);
  }

  /// Pending welcome/commit messages for the signed-in user.
  Future<List<Map<String, dynamic>>> mlsMessages(String token) async {
    final r = await _client.get(
      _u('/api/mls/messages'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
    return (jsonDecode(r.body) as List<dynamic>).cast<Map<String, dynamic>>();
  }

  Future<void> ackMlsMessage(String token, String id) async {
    final r = await _client.post(
      _u('/api/mls/messages/$id/ack'),
      headers: _headers(token),
      body: '{}',
    );
    if (r.statusCode != 200) _fail(r);
  }

  Future<void> quarantineMlsMessage(
    String token,
    String id, {
    required String reason,
  }) async {
    final r = await _client.post(
      _u('/api/mls/messages/$id/quarantine'),
      headers: _headers(token),
      body: jsonEncode({'reason': reason}),
    );
    if (r.statusCode != 200) _fail(r);
  }

  Future<List<EncryptedCurrentFix>> currentFixes(
    String token,
    String userId,
  ) async {
    final encoded = Uri.encodeComponent(userId);
    final r = await _client.get(
      _u('/api/current/$encoded'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
    return (jsonDecode(r.body) as List<dynamic>)
        .map((e) => EncryptedCurrentFix.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  // --- Push notification transport (Wave D) --------------------------------

  /// Register (or refresh) this device's push endpoint. [transport] is
  /// `unifiedpush` or `fcm`; [endpoint] is the distributor URL or FCM token.
  Future<void> registerPush(
    String token, {
    required String transport,
    required String endpoint,
  }) async {
    final r = await _client.post(
      _u('/api/push/register'),
      headers: _headers(token),
      body: jsonEncode({'transport': transport, 'endpoint': endpoint}),
    );
    if (r.statusCode != 200) _fail(r);
  }

  /// Drop one of my push endpoints (transport switch, distributor removed).
  Future<void> unregisterPush(String token, String endpoint) async {
    final r = await _client.post(
      _u('/api/push/unregister'),
      headers: _headers(token),
      body: jsonEncode({'endpoint': endpoint}),
    );
    if (r.statusCode != 200) _fail(r);
  }

  // --- Zero-knowledge recovery backup ---------------------------------------

  /// Store (or replace) the caller's encrypted MLS-state backup. [blobBase64] is
  /// the opaque recovery ciphertext, base64-encoded — the server only ever holds
  /// bytes it cannot decrypt.
  Future<void> putRecoveryBackup(String token, String blobBase64) async {
    final r = await _client.put(
      _u('/api/recovery/backup'),
      headers: _headers(token),
      body: jsonEncode({'blob': blobBase64}),
    );
    if (r.statusCode != 200) _fail(r);
  }

  /// Fetch the caller's encrypted backup (base64), or null if none is stored.
  Future<({String blobBase64, String updatedAt})?> getRecoveryBackup(
    String token,
  ) async {
    final r = await _client.get(
      _u('/api/recovery/backup'),
      headers: _headers(token),
    );
    if (r.statusCode == 404) return null;
    if (r.statusCode != 200) _fail(r);
    final v = jsonDecode(r.body) as Map<String, dynamic>;
    return (
      blobBase64: v['blob'] as String,
      updatedAt: v['updated_at'] as String? ?? '',
    );
  }

  /// Delete the caller's backup (e.g. before rotating the recovery code).
  Future<void> deleteRecoveryBackup(String token) async {
    final r = await _client.delete(
      _u('/api/recovery/backup'),
      headers: _headers(token),
    );
    if (r.statusCode != 200) _fail(r);
  }

  void close() => _client.close();
}

/// Server-backed request records carry the lifecycle timestamp used by the
/// Requests surface. The domain models predate that field, so these typed API
/// records preserve their public contracts while making the timestamp
/// available to clients that understand the richer response.
abstract interface class TimestampedRequest {
  DateTime get createdAt;
}

abstract interface class ExpirableRequest {
  bool get isExpired;
}

final class IncomingRequestRecord extends ShareRequest
    implements TimestampedRequest {
  const IncomingRequestRecord({
    required super.id,
    required super.fromUserId,
    required super.fromDisplayName,
    required this.createdAt,
  });

  factory IncomingRequestRecord.fromJson(Map<String, dynamic> json) {
    final request = ShareRequest.fromJson(json);
    return IncomingRequestRecord(
      id: request.id,
      fromUserId: request.fromUserId,
      fromDisplayName: request.fromDisplayName,
      createdAt: DateTime.parse(json['created_at'] as String).toUtc(),
    );
  }

  @override
  final DateTime createdAt;
}

final class OutgoingRequestRecord extends OutgoingShareRequest
    implements ExpirableRequest, TimestampedRequest {
  const OutgoingRequestRecord({
    required super.id,
    required super.toUserId,
    required super.toDisplayName,
    required this.createdAt,
    required this.isExpired,
  });

  factory OutgoingRequestRecord.fromJson(Map<String, dynamic> json) {
    final request = OutgoingShareRequest.fromJson(json);
    final createdAt = DateTime.parse(json['created_at'] as String).toUtc();
    return OutgoingRequestRecord(
      id: request.id,
      toUserId: request.toUserId,
      toDisplayName: request.toDisplayName,
      createdAt: createdAt,
      isExpired:
          json['expired'] as bool? ??
          createdAt.add(const Duration(days: 30)).isBefore(DateTime.now()),
    );
  }

  @override
  final DateTime createdAt;

  @override
  final bool isExpired;
}

extension IncomingRequestTimestamp on ShareRequest {
  DateTime? get createdAt => switch (this) {
    final TimestampedRequest request => request.createdAt,
    _ => null,
  };
}

extension OutgoingRequestTimestamp on OutgoingShareRequest {
  DateTime? get createdAt => switch (this) {
    final TimestampedRequest request => request.createdAt,
    _ => null,
  };

  bool get isExpired => switch (this) {
    final ExpirableRequest request => request.isExpired,
    _ => false,
  };
}

class ApiException implements Exception {
  const ApiException(this.message, this.statusCode);
  final String message;
  final int statusCode;
  @override
  String toString() => message;
}
