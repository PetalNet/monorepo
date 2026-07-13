import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/ghost_toggle.dart';

/// Ghost mode — the one safety-critical control (mockup screen 2). Sharing
/// state reads via an **inverse fill + a clear label**, never color, never a
/// pulse (D-015). Full-screen over the shell with an ✕ close.
class GhostScreen extends ConsumerWidget {
  const GhostScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ghost = ref.watch(ghostControllerProvider);
    final sharing = ghost.value?.isSharing ?? true;

    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: context.colors.onSurface,
                shape: BoxShape.circle,
              ),
            ),
            SizedBox(width: context.space.sm),
            const Text('Ghost mode'),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.close),
            onPressed: () => context.pop(),
          ),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: context.space.xl),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                'CURRENTLY',
                style: context.text.labelSmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
              SizedBox(height: context.space.md),
              Text(
                sharing ? "You're sharing your\nlocation" : "You're\ndark",
                textAlign: TextAlign.center,
                style: context.text.headlineMedium,
              ),
              SizedBox(height: context.space.xl),
              _StatusChip(sharing: sharing),
              SizedBox(height: context.space.xl),
              Text(
                sharing
                    ? 'Tap to go dark. No one sees where you are, and no one is told that you went dark.'
                    : 'No one can see your location. Tap to start sharing again.',
                textAlign: TextAlign.center,
                style: context.text.bodyMedium?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
              SizedBox(height: context.space.xxl),
              GhostToggle(
                sharing: sharing,
                onChanged: (nextSharing) {
                  Haptics.commit(ref);
                  ref
                      .read(ghostControllerProvider.notifier)
                      .setSharing(sharing: nextSharing);
                },
              ),
              SizedBox(height: context.space.sm),
              Text(
                sharing ? 'Sharing (on)' : 'Ghost (on)',
                style: context.text.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The inverse-filled status indicator: a big pill, filled when sharing (ink
/// bg / surface text + a filled location pin), outlined when dark. No pulse.
class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.sharing});
  final bool sharing;

  @override
  Widget build(BuildContext context) {
    final ink = context.colors.onSurface;
    final onInk = context.colors.surface;
    return AnimatedContainer(
      duration: ReducedMotionScope.of(context)
          ? Duration.zero
          : const Duration(milliseconds: 220),
      height: 72,
      padding: EdgeInsets.symmetric(horizontal: context.space.md),
      decoration: BoxDecoration(
        color: sharing ? ink : Colors.transparent,
        borderRadius: BorderRadius.circular(context.radii.full),
        border: Border.all(color: ink, width: 1.5),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(width: context.space.lg),
          Text(
            sharing ? 'Sharing' : 'Ghosted',
            style: context.text.titleLarge?.copyWith(
              color: sharing ? onInk : ink,
            ),
          ),
          SizedBox(width: context.space.lg),
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: sharing ? onInk : Colors.transparent,
              shape: BoxShape.circle,
              border: sharing ? null : Border.all(color: ink, width: 1.5),
            ),
            child: Icon(
              sharing ? Icons.location_on : Icons.location_off,
              color: sharing ? ink : ink,
              size: 24,
            ),
          ),
        ],
      ),
    );
  }
}
