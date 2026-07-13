import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/ghost/who_sees_me.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/theme/theme_x.dart';

/// Adaptive shell chrome: a bottom [NavigationBar] on compact widths, a
/// [NavigationRail] on medium+ (Material breakpoints via `MediaQuery.sizeOf`).
/// Monochrome — the selected indicator is tonal, never a hue.
class ShellChrome extends ConsumerWidget {
  const ShellChrome({
    required this.activeBranch,
    required this.branchContent,
    required this.onSwitch,
    super.key,
  });

  final int activeBranch;
  final Widget branchContent;
  final void Function(int branch) onSwitch;

  static const List<(IconData, IconData, String)> _destinations = [
    (Icons.near_me_outlined, Icons.near_me, 'Map'),
    (Icons.people_alt_outlined, Icons.people_alt, 'People'),
    (Icons.person_outline, Icons.person, 'Me'),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final width = MediaQuery.sizeOf(context).width;
    final expanded = width >= 600;
    final requestCount = ref.watch(
      requestsControllerProvider.select((value) => value.value?.length ?? 0),
    );

    if (expanded) {
      return Scaffold(
        // The who-sees-me strip spans the full bottom on wide layouts; as the
        // terminal bar it consumes the system bottom inset itself.
        bottomNavigationBar: const WhoSeesMeBar(bottomSafe: true),
        body: Row(
          children: [
            NavigationRail(
              selectedIndex: activeBranch,
              onDestinationSelected: onSwitch,
              labelType: NavigationRailLabelType.all,
              backgroundColor: context.colors.surface,
              indicatorColor: context.colors.surfaceContainerHighest,
              destinations: [
                for (final (index, destination) in _destinations.indexed)
                  NavigationRailDestination(
                    icon: _DestinationIcon(
                      icon: destination.$1,
                      label: destination.$3,
                      count: index == 1 ? requestCount : 0,
                    ),
                    selectedIcon: _DestinationIcon(
                      icon: destination.$2,
                      label: destination.$3,
                      count: index == 1 ? requestCount : 0,
                    ),
                    label: Text(destination.$3),
                  ),
              ],
            ),
            const VerticalDivider(width: 1),
            Expanded(child: branchContent),
          ],
        ),
      );
    }

    return Scaffold(
      body: branchContent,
      // The always-on who-sees-me strip sits directly above the tab bar so it's
      // glanceable on every tab (spec 05) — one tap from the full list.
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const WhoSeesMeBar(),
          NavigationBar(
            selectedIndex: activeBranch,
            onDestinationSelected: onSwitch,
            backgroundColor: context.colors.surface,
            indicatorColor: context.colors.surfaceContainerHighest,
            destinations: [
              for (final (index, destination) in _destinations.indexed)
                NavigationDestination(
                  icon: _DestinationIcon(
                    icon: destination.$1,
                    label: destination.$3,
                    count: index == 1 ? requestCount : 0,
                  ),
                  selectedIcon: _DestinationIcon(
                    icon: destination.$2,
                    label: destination.$3,
                    count: index == 1 ? requestCount : 0,
                  ),
                  label: destination.$3,
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _DestinationIcon extends StatelessWidget {
  const _DestinationIcon({
    required this.icon,
    required this.label,
    required this.count,
  });

  final IconData icon;
  final String label;
  final int count;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: count == 0 ? label : '$label, $count pending requests',
      excludeSemantics: true,
      child: Badge.count(
        count: count,
        isLabelVisible: count > 0,
        backgroundColor: context.colors.onSurface,
        textColor: context.colors.surface,
        child: Icon(icon),
      ),
    );
  }
}
