import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/services/api/models.dart';

/// Regression guard for the fresh-install splash hang: the auth-routing guard
/// must treat a first-ever resolution to signed-out (prev null/loading) as
/// "route to server-pick", and only skip a REPEAT signed-out emission
/// (prev already AsyncData(null)). Mirrors the predicate in PointApp._onAuth.
bool skipsSignedOut(AsyncValue<Session?>? prev) =>
    prev != null && prev.hasValue && prev.value == null;

void main() {
  group('auth routing guard', () {
    test('fresh start (prev null) does NOT skip -> routes to server-pick', () {
      expect(skipsSignedOut(null), isFalse);
    });

    test('loading -> null (prev AsyncLoading) does NOT skip', () {
      expect(skipsSignedOut(const AsyncLoading<Session?>()), isFalse);
    });

    test('signed-in -> null (prev AsyncData(session)) does NOT skip', () {
      const prev = AsyncData<Session?>(
        Session(token: 't', userId: 'a@b', displayName: 'A', isAdmin: false),
      );
      expect(skipsSignedOut(prev), isFalse);
    });

    test('repeat null (prev AsyncData(null)) DOES skip', () {
      expect(skipsSignedOut(const AsyncData<Session?>(null)), isTrue);
    });
  });
}
