import 'package:flutter/material.dart';
import 'package:point_app/features/ghost/who_sees_me.dart';
import 'package:point_app/theme/theme_x.dart';

/// Adaptive shell chrome: a bottom [NavigationBar] on compact widths, a
/// [NavigationRail] on medium+ (Material breakpoints via `MediaQuery.sizeOf`).
/// Monochrome — the selected indicator is tonal, never a hue.
class ShellChrome extends StatelessWidget {
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
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final expanded = width >= 600;

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
                for (final (icon, active, label) in _destinations)
                  NavigationRailDestination(
                    icon: Icon(icon),
                    selectedIcon: Icon(active),
                    label: Text(label),
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
              for (final (icon, active, label) in _destinations)
                NavigationDestination(
                  icon: Icon(icon),
                  selectedIcon: Icon(active),
                  label: label,
                ),
            ],
          ),
        ],
      ),
    );
  }
}
