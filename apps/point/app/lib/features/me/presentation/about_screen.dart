import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/theme/theme_x.dart';

final _packageInfoProvider = FutureProvider<PackageInfo>(
  (_) => PackageInfo.fromPlatform(),
);

/// About: what this build is and what it stands on.
class AboutScreen extends ConsumerWidget {
  const AboutScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final info = ref.watch(_packageInfoProvider).value;
    return Scaffold(
      appBar: AppBar(
        title: const Text('About'),
        actions: [
          IconButton(
            icon: const Icon(Icons.close),
            onPressed: () => context.pop(),
          ),
        ],
      ),
      body: ListView(
        children: [
          Padding(
            padding: EdgeInsets.all(context.space.lg),
            child: Row(
              children: [
                Container(
                  width: 14,
                  height: 14,
                  decoration: BoxDecoration(
                    color: context.colors.onSurface,
                    shape: BoxShape.circle,
                  ),
                ),
                SizedBox(width: context.space.md),
                Text('Point', style: context.text.headlineSmall),
              ],
            ),
          ),
          Padding(
            padding: EdgeInsets.symmetric(horizontal: context.space.lg),
            child: Text(
              'Location sharing that answers to no one but your people. '
              'End-to-end encrypted, self-hostable, federated.',
              style: context.text.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ),
          SizedBox(height: context.space.lg),
          const Divider(),
          ListTile(
            title: const Text('Version'),
            subtitle: Text(
              info == null ? '' : '${info.version} (${info.buildNumber})',
              style: context.text.bodySmall?.copyWith(
                fontFamily: 'JetBrains Mono',
              ),
            ),
          ),
          const ListTile(
            title: Text('License'),
            subtitle: Text('AGPL 3.0. The server and this app are open.'),
          ),
          SettingsNavRow(
            title: 'Open source licenses',
            onTap: () => showLicensePage(
              context: context,
              applicationName: 'Point',
            ),
          ),
        ],
      ),
    );
  }
}
