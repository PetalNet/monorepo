import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/pill_button.dart';

/// The five first-run steps, for the progress dots.
enum OnboardingProgress { server, account, recovery, privacy, location }

/// Shared chrome for every onboarding screen: brand row + progress dots, a
/// big Schibsted headline, muted body copy, scrollable content, and a pinned
/// full-width pill primary (optional secondary action beneath it). Borderless
/// and monochrome; presence by form.
class OnboardingScaffold extends StatelessWidget {
  const OnboardingScaffold({
    required this.step,
    required this.headline,
    required this.body,
    required this.primaryLabel,
    required this.onPrimary,
    this.children = const [],
    this.primaryLoading = false,
    this.secondaryLabel,
    this.onSecondary,
    super.key,
  });

  final OnboardingProgress step;
  final String headline;
  final String body;
  final List<Widget> children;
  final String primaryLabel;
  final VoidCallback? onPrimary;
  final bool primaryLoading;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: ListView(
              padding: EdgeInsets.fromLTRB(
                context.space.xl,
                context.space.xl,
                context.space.xl,
                context.space.lg,
              ),
              children: [
                _BrandHeader(step: step),
                SizedBox(height: context.space.xxl),
                Text(headline, style: context.text.displaySmall),
                SizedBox(height: context.space.lg),
                Text(
                  body,
                  style: context.text.bodyLarge?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
                if (children.isNotEmpty) SizedBox(height: context.space.xl),
                ...children,
              ],
            ),
          ),
        ),
      ),
      // A Row (not Center) so the bar hugs its intrinsic height; Center would
      // greedily take the whole screen and starve the body.
      bottomNavigationBar: SafeArea(
        top: false,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Flexible(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 460),
                child: Padding(
                  padding: EdgeInsets.fromLTRB(
                    context.space.xl,
                    context.space.sm,
                    context.space.xl,
                    context.space.lg,
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      PillButton(
                        label: primaryLabel,
                        loading: primaryLoading,
                        onPressed: onPrimary,
                      ),
                      if (secondaryLabel != null) ...[
                        SizedBox(height: context.space.xs),
                        TextButton(
                          onPressed: onSecondary,
                          child: Text(secondaryLabel!),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Brand row + step progress: filled dots for finished steps, the current one
/// ringed, the rest hollow. Form, not color.
class _BrandHeader extends StatelessWidget {
  const _BrandHeader({required this.step});
  final OnboardingProgress step;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(
            color: context.colors.onSurface,
            shape: BoxShape.circle,
          ),
        ),
        SizedBox(width: context.space.sm),
        Text('Point', style: context.text.titleLarge),
        const Spacer(),
        Semantics(
          label:
              'Set-up step ${step.index + 1} of ${OnboardingProgress.values.length}',
          child: Row(
            children: [
              for (final s in OnboardingProgress.values) ...[
                _StepDot(
                  done: s.index < step.index,
                  current: s == step,
                ),
                if (s != OnboardingProgress.values.last)
                  SizedBox(width: context.space.xs),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _StepDot extends StatelessWidget {
  const _StepDot({required this.done, required this.current});
  final bool done;
  final bool current;

  @override
  Widget build(BuildContext context) {
    final ink = context.colors.onSurface;
    final faint = context.colors.onSurfaceVariant.withValues(alpha: 0.4);
    // Same grammar as presence: solid = done, ring = where you are, faint =
    // still ahead.
    return Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        color: done ? ink : Colors.transparent,
        shape: BoxShape.circle,
        border: Border.all(color: done || current ? ink : faint),
      ),
    );
  }
}
