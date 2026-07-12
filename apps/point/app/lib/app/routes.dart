import 'package:kaisel/kaisel.dart';

/// App-level route stack (kaisel sealed routes — no string paths, no codegen).
/// Login lives OUTSIDE the shell (D-015): auth transitions are `router.set`
/// calls on the one app-lifetime router, never a MaterialApp swap, so the
/// shell + its per-branch state are never torn down on an auth change.
sealed class AppRoute extends KaiselRoute {
  const AppRoute();
}

final class SplashRoute extends AppRoute {
  const SplashRoute();
}

final class LoginRoute extends AppRoute {
  const LoginRoute();
}

/// The authed home: an animated adaptive branched shell (Map · People · You).
final class MainShell extends AppRoute {
  const MainShell();
}

/// Ghost mode — presented full-screen over the shell (mockup: has an ✕ close).
final class GhostRoute extends AppRoute {
  const GhostRoute();
}

/// Device-linking QR enrollment (server never injects a device).
final class DeviceLinkRoute extends AppRoute {
  const DeviceLinkRoute();
}

/// One person's detail: a map focused on them + their share controls. Presented
/// over the shell; identified by user id (the screen reads live presence).
final class PersonDetailRoute extends AppRoute {
  const PersonDetailRoute(this.userId);
  final String userId;
}

/// Add a person by handle or invite. [prefillHandle] is set when the screen is
/// opened from a tapped invite link (`point://add/<handle>`).
final class AddPersonRoute extends AppRoute {
  const AddPersonRoute({this.prefillHandle});
  final String? prefillHandle;
}

/// Routes that require a signed-in session. The guard redirects any stack
/// containing one of these to [LoginRoute] when signed out.
bool routeRequiresAuth(AppRoute r) =>
    r is MainShell ||
    r is GhostRoute ||
    r is DeviceLinkRoute ||
    r is PersonDetailRoute ||
    r is AddPersonRoute;

// --- Shell branches: each tab has its own sealed route type ---------------

sealed class MapRoute extends KaiselRoute {
  const MapRoute();
}

final class MapRoot extends MapRoute {
  const MapRoot();
}

sealed class PeopleRoute extends KaiselRoute {
  const PeopleRoute();
}

final class PeopleRoot extends PeopleRoute {
  const PeopleRoot();
}

sealed class ProfileRoute extends KaiselRoute {
  const ProfileRoute();
}

final class ProfileRoot extends ProfileRoute {
  const ProfileRoot();
}
