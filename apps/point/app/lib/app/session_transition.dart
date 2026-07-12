import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/services/api/models.dart';

/// What an auth emission means for the session lifecycle.
enum SessionTransition {
  /// A session with a NEW identity became active: start the relay, establish
  /// the engine state, run the launch gate.
  establish,

  /// The signed-in account left: hard-stop the engine, stop the relay, route
  /// to sign-in.
  teardown,

  /// Nothing to do (still loading, same identity re-emission, or a repeat
  /// signed-out emission).
  skip,
}

/// The session-lifecycle decision `_onAuth` makes for an auth emission —
/// pure, so the ghost-preserving skip rules are testable headless (D-028).
///
/// [establishedUserId] is the identity the app last ESTABLISHED (null after
/// a teardown or on a fresh process), tracked independently of the previous
/// [AsyncValue]: a `loading → data(same user)` refresh must be a [SessionTransition.skip]
/// (re-establishing would reset the engine's sharing state and could lift a
/// live ghost choice — safety-critical), while a sign-out → sign-in of the
/// SAME account must still [SessionTransition.establish] (the sign-out hard-stop has to be
/// lifted; the v1.2 wedge).
SessionTransition sessionTransition({
  required String? establishedUserId,
  required AsyncValue<Session?>? prev,
  required AsyncValue<Session?> next,
}) {
  // Mirror of `next.whenData`: only a resolved emission acts.
  if (next is! AsyncData<Session?>) return SessionTransition.skip;
  final session = next.value;
  if (session != null) {
    return session.userId == establishedUserId
        ? SessionTransition.skip
        : SessionTransition.establish;
  }
  // Skip a REPEAT signed-out emission, but not the initial resolution to
  // signed-out (prev is null/loading on the fireImmediately call and on a
  // fresh install), which must still route to server-pick.
  final repeatSignedOut = prev != null && prev.hasValue && prev.value == null;
  return repeatSignedOut ? SessionTransition.skip : SessionTransition.teardown;
}
