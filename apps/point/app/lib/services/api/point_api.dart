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

  void close() => _client.close();
}

class ApiException implements Exception {
  const ApiException(this.message, this.statusCode);
  final String message;
  final int statusCode;
  @override
  String toString() => message;
}
