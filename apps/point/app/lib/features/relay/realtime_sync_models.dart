enum RealtimeSyncReason {
  wsAuthenticated,
  appResumed,
  pushWake,
  manualRefresh,
  peopleTabActivated,
  shareRequest,
  mailboxNotice,
  relayEvent,
  retry,
}

class MailboxDrainDiff {
  const MailboxDrainDiff({
    this.applied = 0,
    this.alreadyApplied = 0,
    this.acknowledged = 0,
    this.quarantined = 0,
    this.deferred = 0,
    this.errors = const [],
  });

  final int applied;
  final int alreadyApplied;
  final int acknowledged;
  final int quarantined;
  final int deferred;
  final List<String> errors;

  bool get healthy => errors.isEmpty && deferred == 0;
}

class CurrentFixSyncDiff {
  const CurrentFixSyncDiff({
    this.updatedPeers = const {},
    this.errors = const [],
  });

  final Set<String> updatedPeers;
  final List<String> errors;
}

class RealtimeSyncDiff {
  const RealtimeSyncDiff({
    required this.reason,
    required this.mailbox,
    this.sharesAdded = const {},
    this.sharesRemoved = const {},
    this.incomingRequestsAdded = const {},
    this.incomingRequestsRemoved = const {},
    this.outgoingRequestsAdded = const {},
    this.outgoingRequestsRemoved = const {},
    this.tempSharesAdded = const {},
    this.tempSharesRemoved = const {},
    this.ghostChanged = false,
    this.profileChanged = false,
    this.currentFixes = const CurrentFixSyncDiff(),
    this.errors = const [],
  });

  final RealtimeSyncReason reason;
  final MailboxDrainDiff mailbox;
  final Set<String> sharesAdded;
  final Set<String> sharesRemoved;
  final Set<String> incomingRequestsAdded;
  final Set<String> incomingRequestsRemoved;
  final Set<String> outgoingRequestsAdded;
  final Set<String> outgoingRequestsRemoved;
  final Set<String> tempSharesAdded;
  final Set<String> tempSharesRemoved;
  final bool ghostChanged;
  final bool profileChanged;
  final CurrentFixSyncDiff currentFixes;
  final List<String> errors;

  bool get healthy =>
      mailbox.healthy && currentFixes.errors.isEmpty && errors.isEmpty;
}
