/// Peer-invite links and fallback codes (sharing UX spec 01).
///
/// Invites always leave the user's home server through one stable HTTPS
/// landing origin. The full federated handle remains in the URL, so a person
/// on a self-hosted instance never depends on that instance serving Android
/// App Links. Legacy `point://add/...` links remain readable.
library;

import 'dart:convert';

const inviteLandingOrigin = 'https://point.petalcat.dev';
const _customScheme = 'point';
const _addHost = 'add';
const _codePrefix = 'P1';
const _base32Alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const _checksumLength = 4;
const _maxHandleBytes = 254;

/// A valid user id is exactly `local@domain`: one `@`, both sides non-empty,
/// and no separator characters from OTHER address schemes (`:`, `/`, spaces).
final _handleShape = RegExp(r'^[^@:/\s]+@[^@:/\s]+$');

bool _isValidHandle(String value) =>
    utf8.encode(value).length <= _maxHandleBytes &&
    _handleShape.hasMatch(value);

/// The universal invite URL a user shares to be added.
String inviteLinkFor(String userId) => Uri(
  scheme: 'https',
  host: Uri.parse(inviteLandingOrigin).host,
  pathSegments: <String>[_addHost, userId.toLowerCase()],
).toString();

/// Text handed to the native share sheet.
String inviteShareTextFor(String userId) {
  final handle = userId.toLowerCase();
  return 'Add me on Point:\n'
      '${inviteLinkFor(handle)}\n\n'
      "If the link doesn't open, enter this code in Add a person:\n"
      '${inviteCodeFor(handle)}';
}

/// Extract the invited user id from the stable HTTPS landing URL or a legacy
/// `point://add/<id>` URI. Unknown web hosts are deliberately rejected: an
/// arbitrary `/add/` page must not gain Point deep-link semantics.
String? handleFromInvite(Uri uri) {
  final segments = uri.pathSegments
      .where((segment) => segment.isNotEmpty)
      .toList();
  String? candidate;
  if (uri.scheme == _customScheme &&
      uri.host == _addHost &&
      segments.length == 1) {
    candidate = segments.single;
  } else {
    final landing = Uri.parse(inviteLandingOrigin);
    if (uri.scheme == landing.scheme &&
        uri.host == landing.host &&
        uri.port == landing.port &&
        segments.length == 2 &&
        segments.first == _addHost) {
      candidate = segments.last;
    }
  }
  if (candidate == null) return null;
  final normalized = candidate.toLowerCase();
  return _isValidHandle(normalized) ? normalized : null;
}

/// A checksummed, case-insensitive code that can be read aloud or typed when
/// QR scanning and deep linking are unavailable. It embeds the full federated
/// handle, so it works without a lookup service or trust in the home server.
String inviteCodeFor(String userId) {
  final bytes = utf8.encode(userId.toLowerCase());
  final payload = _base32Encode(bytes);
  final checksum = _base32EncodeChecksum(_checksum(bytes));
  final groups = <String>[
    for (var offset = 0; offset < payload.length; offset += 4)
      payload.substring(offset, (offset + 4).clamp(0, payload.length)),
  ];
  return '$_codePrefix-${groups.join('-')}-$checksum';
}

/// Decode and validate a peer invite code. The final four base32 characters
/// provide a 20-bit checksum that catches ordinary transcription errors.
String? handleFromInviteCode(String raw) {
  final compact = raw.toUpperCase().replaceAll(RegExp(r'[\s-]'), '');
  if (!compact.startsWith(_codePrefix) ||
      compact.length <= _codePrefix.length + _checksumLength) {
    return null;
  }
  final payload = compact.substring(
    _codePrefix.length,
    compact.length - _checksumLength,
  );
  final suppliedChecksum = compact.substring(
    compact.length - _checksumLength,
  );
  try {
    final bytes = _base32Decode(payload);
    if (_base32Encode(bytes) != payload ||
        _base32EncodeChecksum(_checksum(bytes)) != suppliedChecksum) {
      return null;
    }
    final handle = const Utf8Decoder().convert(bytes).toLowerCase();
    return _isValidHandle(handle) ? handle : null;
  } on FormatException {
    return null;
  }
}

/// Normalize a typed address into a full `name@server` user id. A bare
/// username gets the caller's [selfDomain] appended; a federated handle is
/// used as-is. Checksummed `P1-...` peer invite codes are accepted too.
String normalizeHandle(String raw, {required String selfDomain}) {
  final trimmed = raw.trim();
  final compact = trimmed.toUpperCase().replaceAll(RegExp(r'[\s-]'), '');
  final looksLikeInviteCode =
      compact.startsWith(_codePrefix) &&
      compact.length >= _codePrefix.length + _checksumLength + 5 &&
      compact.split('').every(_base32Alphabet.contains);
  if (trimmed.toUpperCase().startsWith('$_codePrefix-') ||
      looksLikeInviteCode) {
    return handleFromInviteCode(trimmed) ?? '';
  }
  final value = trimmed.toLowerCase();
  if (value.isEmpty) return value;
  final qualified = value.contains('@')
      ? value
      : '$value@${selfDomain.toLowerCase()}';
  return _isValidHandle(qualified) ? qualified : '';
}

String _base32Encode(List<int> bytes) {
  final result = StringBuffer();
  var buffer = 0;
  var bitCount = 0;
  for (final byte in bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      result.write(_base32Alphabet[(buffer >> bitCount) & 31]);
    }
    buffer &= bitCount == 0 ? 0 : (1 << bitCount) - 1;
  }
  if (bitCount > 0) {
    result.write(_base32Alphabet[(buffer << (5 - bitCount)) & 31]);
  }
  return result.toString();
}

List<int> _base32Decode(String value) {
  final bytes = <int>[];
  var buffer = 0;
  var bitCount = 0;
  for (final character in value.codeUnits) {
    final digit = _base32Alphabet.indexOf(String.fromCharCode(character));
    if (digit < 0) throw const FormatException('Invalid invite code');
    buffer = (buffer << 5) | digit;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.add((buffer >> bitCount) & 0xff);
      buffer &= bitCount == 0 ? 0 : (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0 && (buffer & ((1 << bitCount) - 1)) != 0) {
    throw const FormatException('Invalid invite code padding');
  }
  return bytes;
}

int _checksum(List<int> bytes) {
  var hash = 0x811c9dc5;
  for (final byte in bytes) {
    hash = ((hash ^ byte) * 0x01000193) & 0xffffffff;
  }
  return hash & 0xfffff;
}

String _base32EncodeChecksum(int checksum) => String.fromCharCodes([
  for (var shift = 15; shift >= 0; shift -= 5)
    _base32Alphabet.codeUnitAt((checksum >> shift) & 31),
]);
