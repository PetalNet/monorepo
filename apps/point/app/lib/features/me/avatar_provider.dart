import 'dart:typed_data';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/services/auth_controller.dart';

/// A person's photo-dot bytes, fetched once per session and cached by user
/// id. Null = no avatar (or not visible to us): callers fall back to the
/// monogram. Invalidate after an upload/delete of the OWN avatar.
// The family's concrete type is not exported by riverpod's public API, so it
// cannot be written out; the generics on the builder call carry the type.
// ignore: specify_nonobvious_property_types
final avatarProvider = FutureProvider.family<Uint8List?, String>((
  ref,
  userId,
) async {
  final session = ref.watch(authControllerProvider).value;
  if (session == null) return null;
  try {
    return await ref.read(apiProvider).fetchAvatar(session.token, userId);
  } on Object {
    // A fetch hiccup renders as the monogram, never an error surface.
    return null;
  }
});
