import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/initials_avatar.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(authControllerProvider).value;
    final appearance = ref.watch(appearanceProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('You')),
      body: ListView(
        padding: EdgeInsets.symmetric(vertical: context.space.md),
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(
              context.space.lg,
              context.space.md,
              context.space.lg,
              context.space.xl,
            ),
            child: Row(
              children: [
                InitialsAvatar(name: session?.displayName ?? '?', size: 56),
                SizedBox(width: context.space.lg),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        session?.displayName ?? '',
                        style: context.text.titleLarge,
                      ),
                      Text(
                        session?.userId ?? '',
                        style: context.text.bodySmall?.copyWith(
                          fontFamily: 'JetBrains Mono',
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const _SectionLabel('Appearance'),
          for (final a in Appearance.values)
            ListTile(
              title: Text(_appearanceLabel(a)),
              trailing: appearance == a
                  ? Icon(Icons.check, color: context.colors.onSurface)
                  : null,
              onTap: () => ref.read(appearanceProvider.notifier).select(a),
            ),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.qr_code_2_outlined),
            title: const Text('Link a device'),
            subtitle: const Text('Add a device to view from anywhere'),
            onTap: () => context.push(const DeviceLinkRoute()),
          ),
          const Divider(),
          ListTile(
            leading: const Icon(Icons.logout),
            title: const Text('Sign out'),
            onTap: () => ref.read(authControllerProvider.notifier).logout(),
          ),
        ],
      ),
    );
  }

  String _appearanceLabel(Appearance a) => switch (a) {
        Appearance.light => 'Light',
        Appearance.dark => 'Dark',
        Appearance.pureBlack => 'Pure Black (OLED)',
      };
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        context.space.lg,
        context.space.md,
        context.space.lg,
        context.space.xs,
      ),
      child: Text(
        text.toUpperCase(),
        style: context.text.labelMedium
            ?.copyWith(color: context.colors.onSurfaceVariant),
      ),
    );
  }
}
