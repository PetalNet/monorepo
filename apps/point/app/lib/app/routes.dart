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

/// First-run step 1: choose (or confirm) the home server before the account
/// screen. Signed-out stacks keep it beneath [LoginRoute] so "back" from
/// login lands here.
final class ServerPickRoute extends AppRoute {
  const ServerPickRoute();
}

/// Onboarding step: show + save the recovery phrase (gated on a stored-it
/// confirm). Also offers restore when the account already has a backup.
final class OnboardingRecoveryRoute extends AppRoute {
  const OnboardingRecoveryRoute();
}

/// Onboarding step: the privacy story + the one plain-language fork that sets
/// map + notification transport together.
final class OnboardingPrivacyRoute extends AppRoute {
  const OnboardingPrivacyRoute();
}

/// The UnifiedPush distributor walk-through, pushed from the privacy fork
/// when the private path needs a distributor set up.
final class OnboardingDistributorRoute extends AppRoute {
  const OnboardingDistributorRoute();
}

/// Onboarding step: the location permission ask ("allow all the time"), shown
/// only while not yet granted.
final class OnboardingLocationRoute extends AppRoute {
  const OnboardingLocationRoute();
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

/// Settings sub-screens (Wave B): each category heavy enough to drill into
/// gets its own full-screen route over the shell. Simple settings stay inline
/// on the category screen.
final class SettingsPrivacyRoute extends AppRoute {
  const SettingsPrivacyRoute();
}

final class SettingsLookRoute extends AppRoute {
  const SettingsLookRoute();
}

final class SettingsNotificationsRoute extends AppRoute {
  const SettingsNotificationsRoute();
}

final class SettingsAccountRoute extends AppRoute {
  const SettingsAccountRoute();
}

final class SettingsAboutRoute extends AppRoute {
  const SettingsAboutRoute();
}

/// The identity editor: display name + photo-dot.
final class IdentityRoute extends AppRoute {
  const IdentityRoute();
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
    r is AddPersonRoute ||
    r is OnboardingRecoveryRoute ||
    r is OnboardingPrivacyRoute ||
    r is OnboardingDistributorRoute ||
    r is OnboardingLocationRoute ||
    r is SettingsPrivacyRoute ||
    r is SettingsLookRoute ||
    r is SettingsNotificationsRoute ||
    r is SettingsAccountRoute ||
    r is SettingsAboutRoute ||
    r is IdentityRoute;

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

sealed class MeRoute extends KaiselRoute {
  const MeRoute();
}

final class MeRoot extends MeRoute {
  const MeRoot();
}
