import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/me/me_profile_provider.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/realtime_sync_models.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';

/// The single authoritative catch-up contract for mobile lifecycle and
/// best-effort realtime events. Calls never overlap, and every pass drains MLS
/// before it fetches or decrypts current location state.
class RealtimeSyncCoordinator {
  RealtimeSyncCoordinator(this._ref) {
    _triggerSub = _ref
        .read(relayControllerProvider)
        .syncRequests
        .listen(
          (reason) => unawaited(syncNow(reason)),
        );
    _ref.listen(authControllerProvider, (previous, next) {
      if (next.value == null) _cancelRetry();
    });
  }

  final Ref _ref;
  StreamSubscription<RealtimeSyncReason>? _triggerSub;
  Future<void> _tail = Future<void>.value();
  final _diffs = StreamController<RealtimeSyncDiff>.broadcast();
  Timer? _retryTimer;
  int _retryAttempt = 0;

  Stream<RealtimeSyncDiff> get diffs => _diffs.stream;

  Future<RealtimeSyncDiff> syncNow(RealtimeSyncReason reason) {
    final completer = Completer<RealtimeSyncDiff>();
    _tail = _tail.catchError((Object _) {}).then((_) async {
      try {
        final diff = await _run(reason);
        if (!_diffs.isClosed) _diffs.add(diff);
        _handleResult(diff);
        completer.complete(diff);
      } on Object catch (error, stackTrace) {
        _scheduleRetry();
        completer.completeError(error, stackTrace);
      }
    });
    return completer.future;
  }

  Future<RealtimeSyncDiff> _run(RealtimeSyncReason reason) async {
    final session = _ref.read(authControllerProvider).value;
    if (session == null) {
      return RealtimeSyncDiff(
        reason: reason,
        mailbox: const MailboxDrainDiff(),
      );
    }

    final errors = <String>[];
    final relay = _ref.read(relayControllerProvider);
    final relayEpoch = relay.sessionEpoch;
    MailboxDrainDiff mailbox;
    try {
      mailbox = await relay.processMailbox();
    } on Object {
      mailbox = const MailboxDrainDiff(errors: ['mailbox_unavailable']);
    }
    if (!relay.isSessionCurrent(relayEpoch, session.userId)) {
      return _sessionChanged(reason, mailbox);
    }

    final previousPeople =
        _ref.read(peopleControllerProvider).value ?? const <Person>[];
    var people = previousPeople;
    try {
      people = await _ref.read(peopleControllerProvider.notifier).refresh();
    } on Object {
      errors.add('shares_unavailable');
    }
    if (!relay.isSessionCurrent(relayEpoch, session.userId)) {
      return _sessionChanged(reason, mailbox);
    }

    final previousIncoming =
        _ref.read(requestsControllerProvider).value ?? const <ShareRequest>[];
    var incoming = previousIncoming;
    try {
      incoming = await _ref.read(requestsControllerProvider.notifier).refresh();
    } on Object {
      errors.add('incoming_requests_unavailable');
    }
    if (!relay.isSessionCurrent(relayEpoch, session.userId)) {
      return _sessionChanged(reason, mailbox);
    }

    final previousOutgoing =
        _ref.read(outgoingRequestsControllerProvider).value ??
        const <OutgoingShareRequest>[];
    var outgoing = previousOutgoing;
    try {
      outgoing = await _ref
          .read(outgoingRequestsControllerProvider.notifier)
          .refresh();
    } on Object {
      errors.add('outgoing_requests_unavailable');
    }
    if (!relay.isSessionCurrent(relayEpoch, session.userId)) {
      return _sessionChanged(reason, mailbox);
    }

    final previousTemps =
        _ref.read(tempSharesControllerProvider).value ?? const <TempShare>[];
    var temps = previousTemps;
    try {
      temps = await _ref.read(tempSharesControllerProvider.notifier).refresh();
    } on Object {
      errors.add('temp_shares_unavailable');
    }
    if (!relay.isSessionCurrent(relayEpoch, session.userId)) {
      return _sessionChanged(reason, mailbox);
    }

    final previousGhost = _ref.read(ghostControllerProvider).value;
    var ghost = previousGhost;
    try {
      ghost = await _ref.read(ghostControllerProvider.notifier).refresh();
    } on Object {
      errors.add('ghost_unavailable');
    }
    if (!relay.isSessionCurrent(relayEpoch, session.userId)) {
      return _sessionChanged(reason, mailbox);
    }

    final previousProfile = _ref.read(meProfileProvider).value;
    var profile = previousProfile;
    try {
      profile = await _ref.refresh(meProfileProvider.future);
    } on Object {
      errors.add('profile_unavailable');
    }
    if (!relay.isSessionCurrent(relayEpoch, session.userId)) {
      return _sessionChanged(reason, mailbox);
    }

    CurrentFixSyncDiff currentFixes;
    try {
      currentFixes = await relay.reconcileCurrentFixes(people);
    } on Object {
      currentFixes = const CurrentFixSyncDiff(errors: ['current_unavailable']);
    }

    final previousPeopleIds = previousPeople.map((p) => p.userId).toSet();
    final peopleIds = people.map((p) => p.userId).toSet();
    final previousIncomingIds = previousIncoming.map((r) => r.id).toSet();
    final incomingIds = incoming.map((r) => r.id).toSet();
    final previousOutgoingIds = previousOutgoing.map((r) => r.id).toSet();
    final outgoingIds = outgoing.map((r) => r.id).toSet();
    final previousTempIds = previousTemps.map((t) => t.id).toSet();
    final tempIds = temps.map((t) => t.id).toSet();

    return RealtimeSyncDiff(
      reason: reason,
      mailbox: mailbox,
      sharesAdded: peopleIds.difference(previousPeopleIds),
      sharesRemoved: previousPeopleIds.difference(peopleIds),
      incomingRequestsAdded: incomingIds.difference(previousIncomingIds),
      incomingRequestsRemoved: previousIncomingIds.difference(incomingIds),
      outgoingRequestsAdded: outgoingIds.difference(previousOutgoingIds),
      outgoingRequestsRemoved: previousOutgoingIds.difference(outgoingIds),
      tempSharesAdded: tempIds.difference(previousTempIds),
      tempSharesRemoved: previousTempIds.difference(tempIds),
      ghostChanged: !_sameGhost(previousGhost, ghost),
      profileChanged: !_sameProfile(previousProfile, profile),
      currentFixes: currentFixes,
      errors: errors,
    );
  }

  RealtimeSyncDiff _sessionChanged(
    RealtimeSyncReason reason,
    MailboxDrainDiff mailbox,
  ) => RealtimeSyncDiff(
    reason: reason,
    mailbox: mailbox,
    errors: const ['session_changed'],
  );

  void _handleResult(RealtimeSyncDiff diff) {
    if (diff.healthy) {
      _cancelRetry();
    } else if (!diff.errors.contains('session_changed')) {
      _scheduleRetry();
    }
  }

  void _scheduleRetry() {
    if (_retryTimer != null ||
        _ref.read(authControllerProvider).value == null) {
      return;
    }
    final seconds = 1 << _retryAttempt.clamp(0, 5);
    _retryAttempt++;
    _retryTimer = Timer(Duration(seconds: seconds), () {
      _retryTimer = null;
      if (_ref.read(authControllerProvider).value != null) {
        unawaited(syncNow(RealtimeSyncReason.retry));
      }
    });
  }

  void _cancelRetry() {
    _retryTimer?.cancel();
    _retryTimer = null;
    _retryAttempt = 0;
  }

  Future<void> dispose() async {
    _cancelRetry();
    await _triggerSub?.cancel();
    await _tail.catchError((Object _) {});
    await _diffs.close();
  }
}

bool _sameGhost(GhostState? a, GhostState? b) =>
    a?.active == b?.active &&
    _sameSet(a?.hiddenFrom ?? const {}, b?.hiddenFrom ?? const {});

bool _sameProfile(MeProfile? a, MeProfile? b) =>
    a?.userId == b?.userId &&
    a?.displayName == b?.displayName &&
    a?.whoCanAddMe == b?.whoCanAddMe &&
    a?.hasAvatar == b?.hasAvatar &&
    a?.ghostActive == b?.ghostActive;

bool _sameSet(Set<String> a, Set<String> b) =>
    a.length == b.length && a.containsAll(b);

final realtimeSyncCoordinatorProvider = Provider<RealtimeSyncCoordinator>((
  ref,
) {
  final coordinator = RealtimeSyncCoordinator(ref);
  ref.onDispose(() => unawaited(coordinator.dispose()));
  return coordinator;
});
