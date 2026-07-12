import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/location/location_providers.dart';
import 'package:point_app/features/settings/settings_controller.dart';

/// (Re)establish the battery engine's sharing state for a session that just
/// became active, BEFORE the launch gate may start the engine.
///
/// This is the v1.2 location regression (tracker 721): the signed-out branch
/// hard-stops the engine (`setSharing(false)` → ghost), and nothing on the
/// next sign-in ever lifted it — `start()` applies whatever state the machine
/// is in. So every fresh install (whose initial auth resolution is
/// signed-out) and every sign-out → sign-in in the same process ran the
/// engine ghosted until a full process restart: no self-marker, no recenter,
/// no fixes sent. The reset below clears the leftover hard-stop; the go-dark
/// default is applied AFTER it, in the same sequence, so the two can never
/// race (the old code fired them as independent unawaited futures).
Future<void> establishSessionEngineState(
  WidgetRef ref, {
  required bool explicitSignIn,
}) async {
  ref.read(locationServiceProvider).setSharing(sharing: true);
  // "Start each sign-in dark" applies only to a real login/register, never a
  // cold-start restore (which must not override a live sharing choice).
  if (!explicitSignIn) return;
  final settings = await ref.read(settingsProvider.notifier).loaded;
  if (!settings.goDarkDefault) return;
  // Drives the engine dark + persists ghost to the server, with the ghost
  // controller's confirm-or-roll-back semantics.
  await ref.read(ghostControllerProvider.notifier).setSharing(sharing: false);
}
