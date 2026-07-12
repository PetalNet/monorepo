import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/location/location_providers.dart';
import 'package:point_app/features/onboarding/onboarding_gate.dart';
import 'package:point_app/services/auth_controller.dart';

/// An invite handle captured from a deep link before the shell was reachable
/// (signed out, or mid-onboarding). Consumed by [continueOnboarding] the
/// moment the shell opens, so a tapped invite survives the whole first-run.
class PendingInvite extends Notifier<String?> {
  @override
  String? build() => null;

  // A verb (not a setter) reads more naturally where a deep link is parked.
  // ignore: use_setters_to_change_properties
  void hold(String handle) => state = handle;

  /// Read-and-clear.
  String? take() {
    final v = state;
    state = null;
    return v;
  }
}

final pendingInviteProvider = NotifierProvider<PendingInvite, String?>(
  PendingInvite.new,
);

/// Route a signed-in user to their first incomplete onboarding step, or into
/// the shell when set-up is complete. This is the single routing decision the
/// launch gate, every onboarding screen, and the sign-in listener share, so
/// resuming mid-flow and finishing a step land in exactly the same place.
///
/// The location engine only starts once the flow is complete: the permission
/// ask belongs to the location step (after the privacy story earns it), never
/// to sign-in itself.
Future<void> continueOnboarding(
  WidgetRef ref,
  KaiselRouter<AppRoute> router,
) async {
  final session = ref.read(authControllerProvider).value;
  if (session == null) return;
  final step = await ref.read(onboardingGateProvider).firstIncomplete(session);
  switch (step) {
    case OnboardingStep.recovery:
      await router.set(const [OnboardingRecoveryRoute()]);
    case OnboardingStep.privacy:
      await router.set(const [OnboardingPrivacyRoute()]);
    case OnboardingStep.location:
      await router.set(const [OnboardingLocationRoute()]);
    case null:
      await ref.read(locationServiceProvider).start();
      final invite = ref.read(pendingInviteProvider.notifier).take();
      await router.set([
        const MainShell(),
        if (invite != null) AddPersonRoute(prefillHandle: invite),
      ]);
  }
}
