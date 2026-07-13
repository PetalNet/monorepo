import 'dart:typed_data';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/services/auth_controller.dart';

typedef AvatarRequest = Future<AvatarResponse> Function(String? etag);

class AvatarResponse {
  const AvatarResponse({required this.statusCode, this.bytes, this.etag});

  final int statusCode;
  final Uint8List? bytes;
  final String? etag;
}

class AvatarFetchException implements Exception {
  const AvatarFetchException(this.statusCode);

  final int statusCode;

  @override
  String toString() => 'Avatar request failed ($statusCode)';
}

class _AvatarCacheEntry {
  const _AvatarCacheEntry(this.bytes, this.etag);

  final Uint8List? bytes;
  final String? etag;
}

/// Retains the last validated bytes across a family-entry invalidation. The
/// next request sends its ETag, so a live profile event updates immediately
/// without downloading an unchanged photo again.
class AvatarCache {
  final Map<String, _AvatarCacheEntry> _entries = {};
  final Map<String, int> _generations = {};

  Future<Uint8List?> load(String key, AvatarRequest request) async {
    final generation = (_generations[key] ?? 0) + 1;
    _generations[key] = generation;
    final previous = _entries[key];
    final response = await request(previous?.etag);
    switch (response.statusCode) {
      case 200:
        final bytes = response.bytes;
        if (bytes == null) throw const AvatarFetchException(200);
        if (_generations[key] == generation) {
          _entries[key] = _AvatarCacheEntry(bytes, response.etag);
        }
        return bytes;
      case 304:
        if (previous == null) throw const AvatarFetchException(304);
        return previous.bytes;
      case 404:
        if (_generations[key] == generation) {
          _entries[key] = const _AvatarCacheEntry(null, null);
        }
        return null;
      default:
        throw AvatarFetchException(response.statusCode);
    }
  }
}

final avatarCacheProvider = Provider<AvatarCache>((_) => AvatarCache());

/// A person's photo-dot bytes. Null means the server definitively reports no
/// visible avatar; transport and server failures remain [AsyncError] so they
/// are not misrepresented as an absent photo. Live profile events invalidate
/// the relevant family entry while [AvatarCache] revalidates its prior bytes.
// The family's concrete type is not exported by riverpod's public API, so it
// cannot be written out; the generics on the builder call carry the type.
// ignore: specify_nonobvious_property_types
final avatarProvider = FutureProvider.family<Uint8List?, String>((
  ref,
  userId,
) async {
  final session = ref.watch(authControllerProvider).value;
  if (session == null) return null;
  final api = ref.read(apiProvider);
  final cacheKey = '${api.baseUrl}\u0000$userId';
  return ref.read(avatarCacheProvider).load(cacheKey, (etag) async {
    final response = await api.fetchAvatarVersioned(
      session.token,
      userId,
      etag: etag,
    );
    return AvatarResponse(
      statusCode: response.notModified
          ? 304
          : response.bytes == null
          ? 404
          : 200,
      bytes: response.bytes,
      etag: response.etag,
    );
  });
});
