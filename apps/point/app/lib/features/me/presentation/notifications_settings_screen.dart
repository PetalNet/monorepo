import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/features/push/push_service.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:unifiedpush/unifiedpush.dart';

/// Notifications: the transport this build can actually register, its live
/// delivery health, and the honest list of what notifies at all.
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
  bool _testingNotification = false;

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
    final push = ref.watch(pushServiceProvider);

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
          const ListTile(
            title: Text('Delivery'),
            subtitle: Text(
              'UnifiedPush · wake-up pings contain no who or where',
            ),
            trailing: Icon(Icons.check),
          ),
          Semantics(
            enabled: false,
            child: const ListTile(
              enabled: false,
              title: Text('Google FCM'),
              subtitle: Text(
                'Not included in this build. Point will not save it as a '
                'delivery choice.',
              ),
            ),
          ),
          ListTile(
            title: const Text('Distributor'),
            subtitle: Text(
              _distributors.isEmpty
                  ? 'None installed — background delivery is off'
                  : _label(_distributors.first),
            ),
            trailing: Icon(
              Icons.chevron_right,
              color: context.colors.onSurfaceVariant,
            ),
            onTap: () => context.push(const OnboardingDistributorRoute()),
          ),
          const Divider(),
          const SettingsSection('Delivery health'),
          ValueListenableBuilder<PushDeliveryHealth>(
            valueListenable: push.deliveryHealth,
            builder: (context, health, _) => ListTile(
              title: const Text('Registered transport'),
              subtitle: Text(_healthLabel(context, health)),
            ),
          ),
          ListTile(
            title: const Text('Test notification'),
            subtitle: const Text(
              'Sends a private test through this phone’s notification channel',
            ),
            trailing: _testingNotification
                ? const Icon(Icons.hourglass_top)
                : const Icon(Icons.notifications_none),
            enabled: !_testingNotification,
            onTap: _testingNotification
                ? null
                : () => unawaited(_sendTest(push)),
          ),
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

  Future<void> _sendTest(PushService push) async {
    Haptics.tick(ref);
    setState(() => _testingNotification = true);
    final shown = await push.sendTestNotification();
    if (!mounted) return;
    setState(() => _testingNotification = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          shown
              ? 'Test notification sent'
              : 'Could not send a test notification',
        ),
      ),
    );
  }

  static String _healthLabel(BuildContext context, PushDeliveryHealth health) {
    if (health.isLoading) return 'Checking…';
    if (!health.isAvailable) return 'Status unavailable';
    if (!health.isRegistered) return 'Not registered · No endpoint synced';
    final transport = switch (health.registeredTransport) {
      'unifiedpush' => 'UnifiedPush',
      'fcm' => 'Google FCM',
      _ => 'Unknown transport',
    };
    final syncedAt = health.syncedAt;
    if (syncedAt == null) return '$transport · Sync time unavailable';
    final date = MaterialLocalizations.of(context).formatMediumDate(syncedAt);
    final time = MaterialLocalizations.of(
      context,
    ).formatTimeOfDay(TimeOfDay.fromDateTime(syncedAt));
    return '$transport · Last endpoint sync $date at $time';
  }
}
