import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/initials_avatar.dart';

/// Who can currently see me, derived from my accepted shares and my ghost state:
/// globally dark ⇒ nobody; otherwise everyone I share with except the people
/// I've individually hidden from. This is the number the shell always shows.
class WhoSeesMe {
  const WhoSeesMe({
    required this.dark,
    required this.people,
    required this.ghost,
  });

  /// I'm globally dark — visible to zero.
  final bool dark;

  /// Everyone I share with (each carries whether they're currently hidden).
  final List<Person> people;
  final GhostState ghost;

  bool isVisibleTo(Person p) => !dark && !ghost.isHiddenFrom(p.userId);

  int get visibleCount =>
      dark ? 0 : people.where((p) => !ghost.isHiddenFrom(p.userId)).length;
}

final whoSeesMeProvider = Provider<WhoSeesMe>((ref) {
  // Until the ghost state is confirmed, assume DARK — never tell someone they're
  // visible when we haven't confirmed they are (the safety-critical default,
  // matching GhostController).
  final ghost =
      ref.watch(ghostControllerProvider).value ??
      const GhostState(active: true);
  final people = ref.watch(peopleControllerProvider).value ?? const <Person>[];
  return WhoSeesMe(dark: ghost.active, people: people, ghost: ghost);
});

/// The always-on shell status: a glanceable "visible to N" (or "You're dark")
/// strip, one tap from the full who-sees-me list. This is what earns the
/// always-on location permission — you always see who's watching.
class WhoSeesMeBar extends ConsumerWidget {
  const WhoSeesMeBar({this.bottomSafe = false, super.key});

  /// True when this bar is the terminal bottom element (the expanded/rail
  /// layout) and must consume the system bottom inset itself; false when it's
  /// stacked above a NavigationBar that already does.
  final bool bottomSafe;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final who = ref.watch(whoSeesMeProvider);
    final dark = who.dark;
    final n = who.visibleCount;
    final ink = context.colors.onSurface;
    return Material(
      color: dark ? ink : context.colors.surfaceContainerHigh,
      child: Semantics(
        button: true,
        label: dark ? "You're dark. No one sees you." : 'Visible to $n people',
        hint: 'Opens who can see you',
        child: InkWell(
          onTap: () => WhoSeesMeSheet.show(context),
          child: SafeArea(
            top: false,
            bottom: bottomSafe,
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: context.space.lg,
                vertical: context.space.md,
              ),
              child: Row(
                children: [
                  Icon(
                    dark ? Icons.visibility_off : Icons.visibility_outlined,
                    size: 20,
                    color: dark ? context.colors.surface : ink,
                  ),
                  SizedBox(width: context.space.md),
                  Expanded(
                    child: Text(
                      dark ? "You're dark. No one sees you." : _label(n),
                      style: context.text.titleMedium?.copyWith(
                        color: dark ? context.colors.surface : ink,
                      ),
                    ),
                  ),
                  Icon(
                    Icons.expand_less,
                    size: 20,
                    color: dark ? context.colors.surface : ink,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  String _label(int n) => switch (n) {
    0 => 'No one can see you',
    1 => 'Visible to 1 person',
    _ => 'Visible to $n people',
  };
}

/// The full who-sees-me control (spec 05): a prominent global go-dark, then the
/// people you share with — each with a per-person kill switch. Never buried in
/// settings; always one tap from the shell strip.
class WhoSeesMeSheet extends ConsumerWidget {
  const WhoSeesMeSheet({super.key});

  static Future<void> show(BuildContext context) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => const WhoSeesMeSheet(),
  );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final who = ref.watch(whoSeesMeProvider);
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          context.space.lg,
          0,
          context.space.lg,
          context.space.lg,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Who can see you', style: context.text.headlineSmall),
            SizedBox(height: context.space.xs),
            Text(
              who.dark
                  ? "You're dark. No location is leaving your device."
                  : '${who.visibleCount} of ${who.people.length} people you share with.',
              style: context.text.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            SizedBox(height: context.space.lg),
            const _GoDarkButton(),
            SizedBox(height: context.space.lg),
            Flexible(
              child: who.people.isEmpty
                  ? _empty(context)
                  : ListView(
                      shrinkWrap: true,
                      children: [
                        for (final p in who.people)
                          _ViewerRow(person: p, visible: who.isVisibleTo(p)),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _empty(BuildContext context) => Padding(
    padding: EdgeInsets.symmetric(vertical: context.space.xl),
    child: Text(
      'No one yet.',
      style: context.text.bodyMedium?.copyWith(
        color: context.colors.onSurfaceVariant,
      ),
    ),
  );
}

/// The prominent global kill switch: go dark to everyone (or resume).
class _GoDarkButton extends ConsumerWidget {
  const _GoDarkButton();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dark = ref.watch(whoSeesMeProvider).dark;
    final ink = context.colors.onSurface;
    return SizedBox(
      width: double.infinity,
      child: Material(
        color: dark ? context.colors.surfaceContainerHigh : ink,
        borderRadius: context.radii.brLg,
        child: InkWell(
          borderRadius: context.radii.brLg,
          onTap: () {
            Haptics.commit(ref);
            ref
                .read(ghostControllerProvider.notifier)
                .setSharing(sharing: dark);
          },
          child: Padding(
            padding: EdgeInsets.symmetric(vertical: context.space.lg),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(
                  dark ? Icons.wb_sunny_outlined : Icons.visibility_off,
                  color: dark ? ink : context.colors.surface,
                ),
                SizedBox(width: context.space.sm),
                Text(
                  dark ? 'Resume sharing' : 'Go dark for everyone',
                  style: context.text.titleMedium?.copyWith(
                    color: dark ? ink : context.colors.surface,
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

/// One person + a per-person kill switch (hide from just them).
class _ViewerRow extends ConsumerWidget {
  const _ViewerRow({required this.person, required this.visible});
  final Person person;
  final bool visible;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SwitchListTile(
      value: visible,
      onChanged: (v) {
        Haptics.commit(ref);
        ref
            .read(ghostControllerProvider.notifier)
            .setHiddenFrom(person.userId, hidden: !v);
      },
      secondary: InitialsAvatar(name: person.displayName),
      title: Text(person.displayName, style: context.text.titleMedium),
      subtitle: Text(
        person.userId,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: context.text.bodySmall?.copyWith(
          fontFamily: AppTheme.monoFamily,
          letterSpacing: 0,
          color: context.colors.onSurfaceVariant,
        ),
      ),
      contentPadding: EdgeInsets.zero,
    );
  }
}
