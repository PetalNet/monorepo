import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';

/// Incoming (pending) share requests addressed to the signed-in user, from
/// `GET /api/shares/requests`. Accepting creates the mutual share (and the
/// relay forms the MLS group with them); declining removes the request. Both
/// refresh the People list so the pinned requests + active rows stay in sync.
class RequestsController extends AsyncNotifier<List<ShareRequest>> {
  @override
  Future<List<ShareRequest>> build() async {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) return const [];
    return ref.read(apiProvider).incomingRequests(session.token);
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

  Future<void> accept(ShareRequest request) async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    await ref.read(apiProvider).acceptRequest(session.token, request.id);
    await refresh();
    // The new person now appears in the shares list; the relay picks them up.
    await ref.read(peopleControllerProvider.notifier).refresh();
  }

  Future<void> decline(ShareRequest request) async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    await ref.read(apiProvider).rejectRequest(session.token, request.id);
    await refresh();
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
    final previous = state.value ?? const <OutgoingShareRequest>[];
    final next = await AsyncValue.guard(build);
    if (next.hasValue) {
      state = next;
      return next.value!;
    }
    state = AsyncData(previous);
    Error.throwWithStackTrace(next.error!, next.stackTrace!);
  }
}

final outgoingRequestsControllerProvider =
    AsyncNotifierProvider<
      OutgoingRequestsController,
      List<OutgoingShareRequest>
    >(OutgoingRequestsController.new);
