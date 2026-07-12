import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/services/server_config.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/confirm_sheet.dart';

/// Account: the server you live on, devices, and the way out.
class AccountScreen extends ConsumerWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(authControllerProvider).value;
    final serverHost = Uri.tryParse(ref.watch(serverUrlProvider))?.host ?? '';

    return Scaffold(
      appBar: AppBar(
        title: const Text('Account'),
        actions: [
          IconButton(
            icon: const Icon(Icons.close),
            onPressed: () => context.pop(),
          ),
        ],
      ),
      body: ListView(
        children: [
          const SettingsSection('Home server'),
          ListTile(
            title: const Text('Server'),
            subtitle: Text(serverHost),
          ),
          ListTile(
            title: const Text('Handle'),
            subtitle: Text(session?.userId ?? ''),
          ),
          const Divider(),
          const SettingsSection('Devices'),
          SettingsNavRow(
            icon: Icons.qr_code_2_outlined,
            title: 'Link a device',
            subtitle: 'View from a tablet or a second phone',
            onTap: () => context.push(const DeviceLinkRoute()),
          ),
          const Divider(),
          const SettingsSection('Session'),
          ListTile(
            leading: Icon(Icons.logout, color: context.colors.onSurface),
            title: const Text('Sign out'),
            onTap: () => unawaited(_signOut(context, ref)),
          ),
        ],
      ),
    );
  }

  Future<void> _signOut(BuildContext context, WidgetRef ref) async {
    final sure = await ConfirmSheet.show(
      context,
      title: 'Sign out?',
      body:
          'Sharing from this phone stops until you sign back in. Your '
          'people and your keys stay put.',
      primaryLabel: 'Sign out',
      secondaryLabel: 'Stay',
    );
    if (sure) await ref.read(authControllerProvider.notifier).logout();
  }
}
