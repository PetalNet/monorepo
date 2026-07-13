import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/features/onboarding/onboarding_flow.dart';
import 'package:point_app/features/onboarding/presentation/onboarding_scaffold.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/theme/theme_x.dart';

/// Onboarding: the privacy story plus the one plain-language fork. It sits
/// before the location ask so the E2EE explanation earns the permission. The
/// choice sets map + notification transport together; both are fine-tunable
/// later in Settings.
class PrivacyForkScreen extends HookConsumerWidget {
  const PrivacyForkScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final private = useState(true);
    final busy = useState(false);

    Future<void> submit() async {
      if (busy.value) return;
      busy.value = true;
      final settings = ref.read(settingsProvider.notifier);
      // The private path only counts as chosen once the distributor guide
      // finishes, so killing the app mid-guide resumes right here.
      await settings.applyPrivacyFork(private: private.value);
      if (!context.mounted) return;
      try {
        if (private.value) {
          await context.push(const OnboardingDistributorRoute());
        } else {
          await continueOnboarding(ref, context.router<AppRoute>());
        }
      } finally {
        busy.value = false;
      }
    }

    return OnboardingScaffold(
      step: OnboardingProgress.privacy,
      headline: 'Only your people\ncan see you.',
      body:
          'Your location is encrypted on your phone before it goes '
          'anywhere. Only the people you choose can unlock it. Your server '
          'relays sealed envelopes it cannot read, and neither can we.',
      primaryLabel: 'Continue',
      onPrimary: submit,
      children: [
        Text(
          'One choice sets your map and your notifications. Fine-tune '
          'either later in Settings.',
          style: context.text.bodySmall?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
        SizedBox(height: context.space.lg),
        _ForkOption(
          title: 'Private by default',
          description:
              'Maps come from your own server, and notifications '
              'arrive through an app you control. Nothing touches a big '
              'tech cloud. One extra setup step.',
          selected: private.value,
          onTap: () => private.value = true,
        ),
        SizedBox(height: context.space.md),
        _ForkOption(
          title: 'Convenient',
          description:
              'A polished map, requested through your server so '
              'the map provider never sees you. Notifications are delivered '
              'by Google, which sees that Point pinged you but never where '
              'you are.',
          selected: !private.value,
          onTap: () => private.value = false,
        ),
      ],
    );
  }
}

/// A selectable choice card: hairline when idle, ink ring + filled radio dot
/// when chosen. Form, not color.
class _ForkOption extends StatelessWidget {
  const _ForkOption({
    required this.title,
    required this.description,
    required this.selected,
    required this.onTap,
  });

  final String title;
  final String description;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ink = context.colors.onSurface;
    final duration = ReducedMotionScope.of(context)
        ? Duration.zero
        : const Duration(milliseconds: 160);
    return Semantics(
      button: true,
      selected: selected,
      label: title,
      child: Material(
        color: context.colors.surfaceContainer,
        borderRadius: context.radii.brMd,
        child: InkWell(
          onTap: onTap,
          borderRadius: context.radii.brMd,
          child: AnimatedContainer(
            duration: duration,
            padding: EdgeInsets.all(context.space.lg),
            decoration: BoxDecoration(
              borderRadius: context.radii.brMd,
              border: Border.all(
                color: selected ? ink : Colors.transparent,
                width: 1.5,
              ),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: _RadioDot(selected: selected),
                ),
                SizedBox(width: context.space.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: context.text.titleMedium),
                      SizedBox(height: context.space.xs),
                      Text(
                        description,
                        style: context.text.bodySmall?.copyWith(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _RadioDot extends StatelessWidget {
  const _RadioDot({required this.selected});
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final ink = context.colors.onSurface;
    final duration = ReducedMotionScope.of(context)
        ? Duration.zero
        : const Duration(milliseconds: 160);
    return AnimatedContainer(
      duration: duration,
      width: 18,
      height: 18,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: ink, width: 1.5),
      ),
      alignment: Alignment.center,
      child: AnimatedContainer(
        duration: duration,
        width: selected ? 9 : 0,
        height: selected ? 9 : 0,
        decoration: BoxDecoration(color: ink, shape: BoxShape.circle),
      ),
    );
  }
}
