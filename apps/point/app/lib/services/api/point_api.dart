import 'dart:convert';

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

  // --- Sharing / people ---------------------------------------------------

  Future<List<Map<String, dynamic>>> activeShares(String token) async {
    final r = await _client.get(_u('/api/shares'), headers: _headers(token));
    if (r.statusCode != 200) _fail(r);
    return (jsonDecode(r.body) as List<dynamic>).cast<Map<String, dynamic>>();
  }

  Future<List<ShareRequest>> incomingRequests(String token) async {
    final r =
        await _client.get(_u('/api/shares/requests'), headers: _headers(token));
    if (r.statusCode != 200) _fail(r);
    return (jsonDecode(r.body) as List<dynamic>)
        .map((e) => ShareRequest.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> sendShareRequest(String token, String toUserId) async {
    final r = await _client.post(
      _u('/api/shares/request'),
      headers: _headers(token),
      body: jsonEncode({'to_user_id': toUserId}),
    );
    if (r.statusCode != 200) _fail(r);
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
  Future<void> uploadKeyPackages(
    String token,
    List<String> keyPackages, {
    String? lastResort,
  }) async {
    final r = await _client.post(
      _u('/api/mls/keys'),
      headers: _headers(token),
      body: jsonEncode({
        'key_packages': keyPackages,
        if (lastResort != null) 'last_resort': lastResort,
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
  Future<({int available, bool hasLastResort})> keyCount(String token) async {
    final r =
        await _client.get(_u('/api/mls/keys/count'), headers: _headers(token));
    if (r.statusCode != 200) _fail(r);
    final v = jsonDecode(r.body) as Map<String, dynamic>;
    return (
      available: v['available'] as int? ?? 0,
      hasLastResort: v['has_last_resort'] as bool? ?? false,
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
    final r =
        await _client.get(_u('/api/mls/messages'), headers: _headers(token));
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
    final r =
        await _client.get(_u('/api/recovery/backup'), headers: _headers(token));
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

class ApiException implements Exception {
  const ApiException(this.message, this.statusCode);
  final String message;
  final int statusCode;
  @override
  String toString() => message;
}
