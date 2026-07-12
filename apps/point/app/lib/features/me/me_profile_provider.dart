import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';

/// The signed-in user's server-held profile (/api/me), for surfaces that need
/// the parts the JWT session does not carry (who_can_add_me, has_avatar).
/// Invalidate after writes that change it.
final meProfileProvider = FutureProvider<MeProfile?>((ref) async {
  final session = ref.watch(authControllerProvider).value;
  if (session == null) return null;
  return ref.read(apiProvider).getMe(session.token);
});
