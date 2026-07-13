/// Peer-invite links (spec 01): a shareable link/QR that identifies ME so the
/// other person can send a share request without typing my handle. There is no
/// public directory — the link IS the discovery.
///
/// Format: `point://add/<url-encoded user id>` (custom scheme; a QR of it opens
/// the app straight to the add flow). The same path is also accepted over
/// `https://<host>/add/<user id>` for links shared as plain URLs.
library;

const _scheme = 'point';
const _addHost = 'add';

/// The invite link a user shares to be added.
String inviteLinkFor(String userId) =>
    '$_scheme://$_addHost/${Uri.encodeComponent(userId)}';

/// Extract the invited user id from a `point://add/<id>` or `.../add/<id>` URI.
/// Returns null if the URI isn't a Point add-invite.
String? handleFromInvite(Uri uri) {
  final segs = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  final isCustom = uri.scheme == _scheme && uri.host == _addHost;
  final isHttp =
      (uri.scheme == 'https' || uri.scheme == 'http') &&
      segs.isNotEmpty &&
      segs.first == _addHost;
  if (isCustom) {
    // point://add/<id> → host=add, the id is the (single) path segment.
    return segs.isNotEmpty ? segs.first : null;
  }
  if (isHttp && segs.length >= 2) {
    return segs[1];
  }
  return null;
}

/// A valid user id is exactly `local@domain`: one `@`, both sides non-empty,
/// and no separator characters from OTHER address schemes (`:`, `/`, spaces).
/// Task 727: a Matrix-style `janet:server` pasted here used to slip past a
/// bare `contains('@')` check and get the home domain appended, producing
/// `janet:server@server` — which resolves to nobody while the UI toasted
/// "Request sent".
final _handleShape = RegExp(r'^[^@:/\s]+@[^@:/\s]+$');

/// Normalize a typed address into a full `name@server` user id: a bare
/// username gets the caller's own [selfDomain] appended (same-server add); an
/// address that already carries `@server` is used as-is (cross-server).
/// Returns the empty string when the input is malformed (already-qualified in
/// a foreign shape, multiple `@`, empty parts) — the caller must treat that
/// as an input error, never send it.
String normalizeHandle(String raw, {required String selfDomain}) {
  final s = raw.trim().toLowerCase();
  if (s.isEmpty) return s;
  final qualified = s.contains('@') ? s : '$s@${selfDomain.toLowerCase()}';
  return _handleShape.hasMatch(qualified) ? qualified : '';
}
