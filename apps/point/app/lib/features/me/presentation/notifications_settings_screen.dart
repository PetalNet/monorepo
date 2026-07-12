import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:unifiedpush/unifiedpush.dart';

/// Notifications: the transport, its fallback, and the honest list of what
/// notifies at all. Delivery itself lands in Wave D; the choices here are the
/// contract it reads.
class NotificationsSettingsScreen extends ConsumerStatefulWidget {
  const NotificationsSettingsScreen({super.key});

  @override
  ConsumerState<NotificationsSettingsScreen> createState() =>
      _NotificationsSettingsScreenState();
}

class _NotificationsSettingsScreenState
    extends ConsumerState<NotificationsSettingsScreen>
    with WidgetsBindingObserver {
  List<String> _distributors = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_check());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_check());
  }

  Future<void> _check() async {
    try {
      final found = await UnifiedPush.getDistributors();
      if (mounted) setState(() => _distributors = found);
    } on Object {
      // Platform without UP support: stays empty.
    }
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider);
    final notifier = ref.read(settingsProvider.notifier);
    final up = settings.transport == NotifTransport.unifiedPush;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          IconButton(
            icon: const Icon(Icons.close),
            onPressed: () => context.pop(),
          ),
        ],
      ),
      body: ListView(
        children: [
          const SettingsSection('Transport'),
          SettingsChoiceRow<NotifTransport>(
            title: 'Delivery',
            value: settings.transport,
            sheetBody:
                'How a wake-up ping reaches this phone when Point is '
                'closed. The ping never carries who or where.',
            options: const [
              (
                NotifTransport.unifiedPush,
                'UnifiedPush',
                'Through a distributor app you control. Private.',
              ),
              (
                NotifTransport.fcm,
                'Google FCM',
                'Google delivers the ping and sees that Point pinged you. '
                    'Needs a Google build of Point; the standard build uses a '
                    'distributor even on this choice.',
              ),
            ],
            onSelected: (v) {
              Haptics.tick(ref);
              unawaited(
                notifier.update(
                  (s) => s.copyWith(transport: v, transportChosen: true),
                ),
              );
            },
          ),
          if (up) ...[
            ListTile(
              title: const Text('Distributor'),
              subtitle: Text(
                _distributors.isEmpty
                    ? 'None installed yet'
                    : _label(_distributors.first),
              ),
              trailing: Icon(
                Icons.chevron_right,
                color: context.colors.onSurfaceVariant,
              ),
              onTap: () => context.push(const OnboardingDistributorRoute()),
            ),
            SettingsToggleRow(
              title: 'Fall back to Google',
              subtitle:
                  'If no distributor is available, use FCM instead of '
                  'staying silent. Never switched without you.',
              value: settings.fcmFallback,
              onChanged: (v) {
                Haptics.tick(ref);
                unawaited(
                  notifier.update((s) => s.copyWith(fcmFallback: v)),
                );
              },
            ),
          ],
          const Divider(),
          const SettingsSection('What notifies'),
          const ListTile(
            title: Text('Someone asks to share'),
            subtitle: Text('Notifies'),
          ),
          const ListTile(
            title: Text('Someone accepts and starts sharing'),
            subtitle: Text('Notifies'),
          ),
          const ListTile(
            title: Text('A temporary share expires'),
            subtitle: Text('Shows in the app only'),
          ),
          const ListTile(
            title: Text('Going dark, passive moves, being viewed'),
            subtitle: Text('Always silent'),
          ),
          Padding(
            padding: EdgeInsets.all(context.space.lg),
            child: Text(
              'Point never announces that someone went dark. Silence is the '
              'whole point.',
              style: context.text.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }

  static String _label(String pkg) {
    if (pkg.contains('ntfy')) return 'ntfy';
    if (pkg.contains('sunup')) return 'Sunup';
    if (pkg.contains('nextpush')) return 'NextPush';
    return pkg.split('.').last;
  }
}
