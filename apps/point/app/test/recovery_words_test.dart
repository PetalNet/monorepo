import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/recovery/recovery_wordlist.dart';
import 'package:point_app/features/recovery/recovery_words.dart';

void main() {
  group('wordlist', () {
    test('has exactly 1024 unique lowercase words', () {
      expect(kRecoveryWords.length, 1024);
      expect(kRecoveryWords.toSet().length, 1024);
      for (final w in kRecoveryWords) {
        expect(RegExp(r'^[a-z]+$').hasMatch(w), isTrue, reason: w);
      }
    });
  });

  group('codeToWords / wordsToCode', () {
    test('all-zero code maps to twelve first words and back', () {
      const code = '000000-000000-000000-000000';
      final words = codeToWords(code);
      expect(words, List.filled(12, kRecoveryWords[0]));
      expect(wordsToCode(words), code);
    });

    test('all-Z code maps to twelve last words and back', () {
      const code = 'ZZZZZZ-ZZZZZZ-ZZZZZZ-ZZZZZZ';
      final words = codeToWords(code);
      expect(words, List.filled(12, kRecoveryWords[1023]));
      expect(wordsToCode(words), code);
    });

    test('roundtrips 500 random codes exactly', () {
      const alpha = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      final rng = Random(42);
      for (var n = 0; n < 500; n++) {
        final bare = [
          for (var i = 0; i < 24; i++) alpha[rng.nextInt(32)],
        ].join();
        final dashed = formatCode(bare);
        final words = codeToWords(dashed);
        expect(words.length, 12);
        expect(wordsToCode(words), dashed);
      }
    });

    test('word matching ignores case and padding', () {
      final words = codeToWords(
        'ZZZZZZ-ZZZZZZ-ZZZZZZ-ZZZZZZ',
      ).map((w) => '  ${w.toUpperCase()} ').toList();
      expect(wordsToCode(words), 'ZZZZZZ-ZZZZZZ-ZZZZZZ-ZZZZZZ');
    });

    test('rejects a wrong word count and unknown words', () {
      expect(() => wordsToCode(['abandon']), throwsFormatException);
      expect(
        () => wordsToCode(List.filled(12, 'notaword')),
        throwsFormatException,
      );
    });
  });

  group('normalizeCode', () {
    test('mirrors the Rust look-alike map', () {
      expect(normalizeCode('oli-OLI'), '011011');
      expect(normalizeCode('abc def'), 'ABCDEF');
    });

    test('codeToWords accepts lowercase, unspaced, look-alike input', () {
      final canonical = codeToWords('0123AB-CDEF01-234567-89ABCD');
      final sloppy = codeToWords('o123ab cdefo1 234567 89abcd');
      expect(sloppy, canonical);
    });
  });

  group('parseRecoveryInput', () {
    test('accepts a 12-word phrase', () {
      final words = codeToWords('0123AB-CDEF01-234567-89ABCD');
      expect(
        parseRecoveryInput(words.join(' ')),
        '0123AB-CDEF01-234567-89ABCD',
      );
    });

    test('accepts a legacy bare code in any casing', () {
      expect(
        parseRecoveryInput('0123abcdef0123456789abcd'),
        '0123AB-CDEF01-234567-89ABCD',
      );
    });

    test('accepts a dashed legacy code', () {
      expect(
        parseRecoveryInput('0123AB-CDEF01-234567-89ABCD'),
        '0123AB-CDEF01-234567-89ABCD',
      );
    });

    test('accepts a legacy code split by spaces, even all-letter groups', () {
      // Regression (review): 'ABCDEF GHJKMN PQRSTV WXYZAB' is word-shaped
      // (four alphabetic groups) but is really a 24-symbol code; the Rust
      // normalizer accepts it, so the client must too.
      expect(
        parseRecoveryInput('ABCDEF GHJKMN PQRSTV WXYZAB'),
        'ABCDEF-GHJKMN-PQRSTV-WXYZAB',
      );
    });

    test('rejects garbage', () {
      expect(() => parseRecoveryInput('nope'), throwsFormatException);
      expect(() => parseRecoveryInput(''), throwsFormatException);
      expect(
        () => parseRecoveryInput('only three words'),
        throwsFormatException,
      );
    });
  });
}
