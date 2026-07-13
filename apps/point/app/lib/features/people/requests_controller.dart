import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';

enum RequestMutationAction { accept, decline }

enum MutationPhase { running, failed }

class RequestMutation {
  const RequestMutation({required this.action, required this.phase});

  final RequestMutationAction action;
  final MutationPhase phase;

  bool get isRunning => phase == MutationPhase.running;
}

class RequestMutations extends Notifier<Map<String, RequestMutation>> {
  @override
  Map<String, RequestMutation> build() => const {};

  void begin(String id, RequestMutationAction action) {
    state = {
      ...state,
      id: RequestMutation(action: action, phase: MutationPhase.running),
    };
  }

  void fail(String id, RequestMutationAction action) {
    state = {
      ...state,
      id: RequestMutation(action: action, phase: MutationPhase.failed),
    };
  }

  void clear(String id) {
    if (!state.containsKey(id)) return;
    state = {...state}..remove(id);
  }
}

final requestMutationsProvider =
    NotifierProvider<RequestMutations, Map<String, RequestMutation>>(
      RequestMutations.new,
    );

class StopSharingController extends Notifier<Map<String, MutationPhase>> {
  @override
  Map<String, MutationPhase> build() => const {};

  Future<MutationOutcome> stop(String userId) async {
    if (state[userId] == MutationPhase.running) {
      return MutationOutcome.ignored;
    }
    final session = ref.read(authControllerProvider).value;
    if (session == null) return MutationOutcome.ignored;
    state = {...state, userId: MutationPhase.running};
    try {
      await ref.read(apiProvider).deleteShare(session.token, userId);
    } on Object {
      state = {...state, userId: MutationPhase.failed};
      return MutationOutcome.failed;
    }
    var reconciled = true;
    try {
      await Future.wait([
        ref.read(peopleControllerProvider.notifier).refresh(),
        ref.read(requestsControllerProvider.notifier).refresh(),
      ]);
    } on Object {
      reconciled = false;
    }
    state = {...state}..remove(userId);
    return reconciled
        ? MutationOutcome.succeeded
        : MutationOutcome.succeededNeedsRefresh;
  }
}

final stopSharingMutationsProvider =
    NotifierProvider<StopSharingController, Map<String, MutationPhase>>(
      StopSharingController.new,
    );

enum MutationOutcome { succeeded, succeededNeedsRefresh, failed, ignored }

/// Incoming (pending) share requests addressed to the signed-in user, from
/// `GET /api/shares/requests`. Accepting creates the mutual share (and the
/// relay forms the MLS group with them); declining removes the request. Both
/// refresh the People list so the pinned requests + active rows stay in sync.
class RequestsController extends AsyncNotifier<List<ShareRequest>> {
  final Set<String> _optimisticallyRemoved = {};

  @override
  Future<List<ShareRequest>> build() async {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) {
      _optimisticallyRemoved.clear();
      return const [];
    }
    final fetched = await ref.read(apiProvider).incomingRequests(session.token);
    return [
      for (final request in fetched)
        if (!_optimisticallyRemoved.contains(request.id)) request,
    ];
  }

  /// Re-fetch WITHOUT flashing through `AsyncLoading` — the previous value stays
  /// put until the new one resolves, so the pinned section doesn't blank and the
  /// share-target listener never sees a transient null (which would drop
  /// outbound fixes for a round-trip).
  Future<List<ShareRequest>> refresh() async {
    final previous = state.value ?? const <ShareRequest>[];
    final next = await AsyncValue.guard(build);
    if (next.hasValue) {
      state = next;
      return next.value!;
    }
    state = AsyncData(previous);
    Error.throwWithStackTrace(next.error!, next.stackTrace!);
  }

  Future<MutationOutcome> accept(ShareRequest request) => _mutate(
    request,
    action: RequestMutationAction.accept,
    send: (token) => ref.read(apiProvider).acceptRequest(token, request.id),
    refreshPeople: true,
  );

  Future<MutationOutcome> decline(ShareRequest request) => _mutate(
    request,
    action: RequestMutationAction.decline,
    send: (token) => ref.read(apiProvider).rejectRequest(token, request.id),
    refreshPeople: false,
  );

  Future<MutationOutcome> _mutate(
    ShareRequest request, {
    required RequestMutationAction action,
    required Future<void> Function(String token) send,
    required bool refreshPeople,
  }) async {
    final mutations = ref.read(requestMutationsProvider);
    if (mutations[request.id]?.isRunning ?? false) {
      return MutationOutcome.ignored;
    }
    final session = ref.read(authControllerProvider).value;
    if (session == null) return MutationOutcome.ignored;

    final previous = state.value ?? const <ShareRequest>[];
    final index = previous.indexWhere((item) => item.id == request.id);
    if (index == -1) return MutationOutcome.ignored;
    ref.read(requestMutationsProvider.notifier).begin(request.id, action);
    _optimisticallyRemoved.add(request.id);
    state = AsyncData([
      for (final item in previous)
        if (item.id != request.id) item,
    ]);

    try {
      await send(session.token);
    } on Object {
      _optimisticallyRemoved.remove(request.id);
      final current = state.value ?? const <ShareRequest>[];
      if (!current.any((item) => item.id == request.id)) {
        final restored = [...current];
        restored.insert(index.clamp(0, restored.length), request);
        state = AsyncData(restored);
      }
      ref.read(requestMutationsProvider.notifier).fail(request.id, action);
      return MutationOutcome.failed;
    }

    var reconciled = true;
    try {
      await Future.wait([
        refresh(),
        if (refreshPeople)
          ref.read(peopleControllerProvider.notifier).refresh(),
      ]);
    } on Object {
      reconciled = false;
    }
    ref.read(requestMutationsProvider.notifier).clear(request.id);
    return reconciled
        ? MutationOutcome.succeeded
        : MutationOutcome.succeededNeedsRefresh;
  }
}

final requestsControllerProvider =
    AsyncNotifierProvider<RequestsController, List<ShareRequest>>(
      RequestsController.new,
    );

class OutgoingRequestsController
    extends AsyncNotifier<List<OutgoingShareRequest>> {
  @override
  Future<List<OutgoingShareRequest>> build() async {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) return const [];
    return ref.read(apiProvider).outgoingRequests(session.token);
  }

  Future<List<OutgoingShareRequest>> refresh() async {
    final next = await AsyncValue.guard(build);
    if (next.hasValue) {
      state = next;
      return next.value!;
    }
    state = next;
    Error.throwWithStackTrace(next.error!, next.stackTrace!);
  }
}

final outgoingRequestsControllerProvider =
    AsyncNotifierProvider<
      OutgoingRequestsController,
      List<OutgoingShareRequest>
    >(OutgoingRequestsController.new);
