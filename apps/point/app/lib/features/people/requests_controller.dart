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

  Future<void> refresh() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(build);
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
