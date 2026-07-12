/// Word-phrase encoding of the recovery secret.
///
/// The Rust core generates a 120-bit recovery code rendered as 24
/// Crockford-base32 symbols (`XXXXXX-XXXXXX-XXXXXX-XXXXXX`, alphabet omits
/// I/L/O/U). People are bad at transcribing base32, so the client shows the
/// SAME 120 bits as 12 words from [kRecoveryWords] (1024 words = 10 bits
/// each). Each word maps to exactly two base32 symbols
/// (`index = hi << 5 | lo`), so the conversion is lossless in both
/// directions and the derived key is identical either way.
///
/// The crypto layer (`point_core::recovery`) only ever sees the base32 code;
/// words exist purely at the presentation edge.
library;

import 'package:point_app/features/recovery/recovery_wordlist.dart';

const String _crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/// Strip a user-entered code to its canonical 24 symbols, mirroring the Rust
/// `normalize_code` map (I/L read as 1, O as 0, separators dropped).
String normalizeCode(String raw) {
  final out = StringBuffer();
  for (final rune in raw.toUpperCase().runes) {
    final c = String.fromCharCode(rune);
    switch (c) {
      case 'I' || 'L':
        out.write('1');
      case 'O':
        out.write('0');
      default:
        // Keep digits and letters (matching the Rust map); anything the
        // Crockford alphabet doesn't know (e.g. U) fails later as an invalid
        // symbol rather than being silently dropped.
        if (RegExp(r'^[0-9A-Z]$').hasMatch(c)) out.write(c);
    }
  }
  return out.toString();
}

/// Group a bare 24-symbol code as `XXXXXX-XXXXXX-XXXXXX-XXXXXX` for display,
/// matching the shape the Rust generator emits.
String formatCode(String bare) {
  final b = StringBuffer();
  for (var i = 0; i < bare.length; i++) {
    if (i > 0 && i % 6 == 0) b.write('-');
    b.write(bare[i]);
  }
  return b.toString();
}

/// The 12-word phrase for a generated recovery [code]. Throws
/// [FormatException] if the code does not normalize to 24 valid symbols.
List<String> codeToWords(String code) {
  final bare = normalizeCode(code);
  if (bare.length != 24) {
    throw FormatException(
      'recovery code must be 24 symbols, got ${bare.length}',
    );
  }
  final symbols = [
    for (final c in bare.split('')) _crockford.indexOf(c),
  ];
  if (symbols.contains(-1)) {
    throw const FormatException('recovery code has an invalid symbol');
  }
  return [
    for (var i = 0; i < 24; i += 2)
      kRecoveryWords[(symbols[i] << 5) | symbols[i + 1]],
  ];
}

/// Rebuild the canonical dashed code from a 12-word phrase. Word matching is
/// case-insensitive and ignores extra whitespace. Throws [FormatException] on
/// an unknown word or a wrong word count.
String wordsToCode(List<String> words) {
  if (words.length != 12) {
    throw FormatException('a recovery phrase is 12 words, got ${words.length}');
  }
  final out = StringBuffer();
  var written = 0;
  for (final raw in words) {
    final word = raw.trim().toLowerCase();
    final index = kRecoveryWords.indexOf(word);
    if (index == -1) throw FormatException('unknown recovery word: $word');
    for (final symbol in [index >> 5, index & 0x1f]) {
      if (written > 0 && written % 6 == 0) out.write('-');
      out.write(_crockford[symbol]);
      written++;
    }
  }
  return out.toString();
}

/// Interpret free-form user input as either a 12-word phrase or a legacy
/// base32 code, returning the canonical code the crypto layer accepts.
/// Throws [FormatException] when it is neither.
String parseRecoveryInput(String raw) {
  final words = raw
      .trim()
      .toLowerCase()
      .split(RegExp(r'[\s,]+'))
      .where((w) => w.isNotEmpty)
      .toList();
  final looksLikeWords =
      words.length > 1 && words.every((w) => RegExp(r'^[a-z]+$').hasMatch(w));
  if (looksLikeWords) {
    try {
      return wordsToCode(words);
    } on FormatException {
      // Not words after all. A legacy code typed with spaces between its
      // groups (all-letter groups look word-shaped) still normalizes below;
      // the Rust side is equally space-tolerant.
    }
  }
  final bare = normalizeCode(raw);
  if (bare.length == 24) return formatCode(bare);
  throw const FormatException(
    'enter the 12 recovery words, or a 24 character recovery code',
  );
}
