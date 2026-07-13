import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/services/server_config.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/photo_dot.dart';

/// The third tab: you and your settings, one surface (Wave B). Borderless
/// me-header, a hairline, the go-dark toggle as the single live control, then
/// the grouped categories.
class MeScreen extends ConsumerWidget {
  const MeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) return const SizedBox.shrink();

    return Scaffold(
      appBar: AppBar(title: const Text('Me')),
      body: ListView(
        padding: EdgeInsets.only(bottom: context.space.xl),
        children: [
          _MeHeader(session: session),
          const Divider(),
          const _GoDarkRow(),
          const Divider(),
          const SettingsSection('Settings'),
          SettingsNavRow(
            icon: Icons.lock_outline,
            title: 'Privacy',
            subtitle: 'Map provider, who can add you, go dark',
            onTap: () => context.push(const SettingsPrivacyRoute()),
          ),
          SettingsNavRow(
            icon: Icons.tune,
            title: 'Look and feel',
            subtitle: 'Theme, motion, haptics, units, text size',
            onTap: () => context.push(const SettingsLookRoute()),
          ),
          SettingsNavRow(
            icon: Icons.notifications_none,
            title: 'Notifications',
            subtitle: 'How Point reaches this phone',
            onTap: () => context.push(const SettingsNotificationsRoute()),
          ),
          SettingsNavRow(
            icon: Icons.person_outline,
            title: 'Account',
            subtitle: 'Server, devices, sign out',
            onTap: () => context.push(const SettingsAccountRoute()),
          ),
          SettingsNavRow(
            icon: Icons.info_outline,
            title: 'About',
            subtitle: 'Version and licenses',
            onTap: () => context.push(const SettingsAboutRoute()),
          ),
        ],
      ),
    );
  }
}

/// Borderless identity header: photo-dot, name, handle at server. The whole
/// block is the way into the identity editor.
class _MeHeader extends ConsumerWidget {
  const _MeHeader({required this.session});
  final Session session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final serverHost = Uri.tryParse(ref.watch(serverUrlProvider))?.host ?? '';
    return Semantics(
      button: true,
      label: 'Edit your name and photo',
      child: InkWell(
        onTap: () => context.push(const IdentityRoute()),
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            context.space.lg,
            context.space.lg,
            context.space.lg,
            context.space.lg,
          ),
          child: Row(
            children: [
              PhotoDot(
                userId: session.userId,
                name: session.displayName,
                size: 64,
              ),
              SizedBox(width: context.space.lg),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      session.displayName,
                      style: context.text.titleLarge,
                      overflow: TextOverflow.ellipsis,
                    ),
                    SizedBox(height: context.space.xs / 2),
                    Text(
                      '@${session.userId.split('@').first}'
                      ' · $serverHost',
                      style: context.text.bodySmall?.copyWith(
                        fontFamily: 'JetBrains Mono',
                        color: context.colors.onSurfaceVariant,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              Icon(
                Icons.edit_outlined,
                size: 20,
                color: context.colors.onSurfaceVariant,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The one live control on the surface: the global go-dark switch, always a
/// single tap from the top of the tab.
class _GoDarkRow extends ConsumerWidget {
  const _GoDarkRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ghost = ref.watch(ghostControllerProvider).value;
    final sharing = ghost?.isSharing ?? true;
    return SwitchListTile(
      secondary: Icon(
        sharing ? Icons.visibility_outlined : Icons.visibility_off_outlined,
        color: context.colors.onSurface,
      ),
      title: Text(sharing ? "You're sharing" : "You're dark"),
      subtitle: Text(
        sharing
            ? 'Flip to go dark. No one is told.'
            : 'No one can see your location.',
      ),
      value: !sharing,
      onChanged: (goDark) {
        Haptics.impact(ref);
        unawaited(
          ref
              .read(ghostControllerProvider.notifier)
              .setSharing(sharing: !goDark),
        );
      },
    );
  }
}
