import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/features/map/map_tiles.dart';
import 'package:point_app/features/me/me_profile_provider.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/theme_x.dart';

/// Privacy: the map provider's one home, who can add me, go-dark default.
class PrivacySettingsScreen extends ConsumerStatefulWidget {
  const PrivacySettingsScreen({super.key});

  @override
  ConsumerState<PrivacySettingsScreen> createState() =>
      _PrivacySettingsScreenState();
}

class _PrivacySettingsScreenState extends ConsumerState<PrivacySettingsScreen> {
  /// Server-held setting, loaded from /api/me; null while in flight.
  String? _whoCanAddMe;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    // Await: a cold resume can build this screen while the session restores.
    final session = await ref.read(authControllerProvider.future);
    if (session == null) return;
    try {
      final me = await ref.read(apiProvider).getMe(session.token);
      if (mounted) setState(() => _whoCanAddMe = me.whoCanAddMe);
    } on Object {
      // Row shows a quiet retry state below.
      if (mounted) setState(() => _whoCanAddMe = '');
    }
  }

  Future<void> _setWhoCanAddMe(String value) async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    final before = _whoCanAddMe;
    setState(() => _whoCanAddMe = value);
    try {
      await ref.read(apiProvider).updatePrivacy(session.token, value);
      // Anything watching the profile (the invite-blocked note) follows.
      ref.invalidate(meProfileProvider);
    } on Object {
      // The server didn't take it: show the truth, not the wish.
      if (mounted) setState(() => _whoCanAddMe = before);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not save. Try again.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Privacy'),
        actions: [
          IconButton(
            icon: const Icon(Icons.close),
            onPressed: () => context.pop(),
          ),
        ],
      ),
      body: ListView(
        children: [
          const SettingsSection('Map'),
          SettingsChoiceRow<MapProviderChoice>(
            title: 'Map provider',
            value: settings.mapProvider,
            sheetBody:
                'Each tier is exactly what it says. There is no way to make '
                'a surveillance company a little private, so Point does not '
                'pretend to.',
            options: const [
              (
                MapProviderChoice.selfHosted,
                'Your own server',
                'Map tiles come from your home server. Where you look never '
                    'leaves your people.',
              ),
              (
                MapProviderChoice.proxied,
                'Proxied provider',
                'A polished map fetched through your server, so the provider '
                    'sees the server, never you.',
              ),
            ],
            onSelected: (v) {
              Haptics.tick(ref);
              unawaited(
                ref
                    .read(settingsProvider.notifier)
                    .update((s) => s.copyWith(mapProvider: v)),
              );
            },
          ),
          Padding(
            padding: EdgeInsets.fromLTRB(
              context.space.lg,
              0,
              context.space.lg,
              context.space.md,
            ),
            child: Builder(
              builder: (context) {
                final source = ref.watch(tileSourceProvider);
                return Text(
                  source == null
                      ? 'Checking what your server offers.'
                      : tileSourceDescription(source),
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                );
              },
            ),
          ),
          const Divider(),
          const SettingsSection('Sharing'),
          if (_whoCanAddMe == null)
            const ListTile(
              title: Text('Who can add you'),
              subtitle: Text('Loading'),
            )
          else if (_whoCanAddMe!.isEmpty)
            ListTile(
              title: const Text('Who can add you'),
              subtitle: const Text('Could not load. Tap to retry.'),
              onTap: () {
                setState(() => _whoCanAddMe = null);
                unawaited(_load());
              },
            )
          else
            SettingsChoiceRow<String>(
              title: 'Who can add you',
              value: _whoCanAddMe!,
              sheetBody:
                  'Blocked requests are silently dropped, so nobody can '
                  'probe this setting. You can always add people yourself.',
              options: const [
                (
                  'anyone',
                  'Anyone with your exact handle',
                  'There is no public search. Someone must already know '
                      'your handle to ask.',
                ),
                (
                  'same_server',
                  'Only people on your server',
                  'Requests from other Point servers are dropped.',
                ),
                (
                  'nobody',
                  'No one',
                  'You send every request. Nothing comes in.',
                ),
              ],
              onSelected: (v) {
                Haptics.tick(ref);
                unawaited(_setWhoCanAddMe(v));
              },
            ),
          const Divider(),
          const SettingsSection('Go dark'),
          SettingsToggleRow(
            title: 'Start each sign-in dark',
            subtitle:
                'New sessions begin with sharing off until you turn it on.',
            value: settings.goDarkDefault,
            onChanged: (v) {
              Haptics.tick(ref);
              unawaited(
                ref
                    .read(settingsProvider.notifier)
                    .update((s) => s.copyWith(goDarkDefault: v)),
              );
            },
          ),
          Padding(
            padding: EdgeInsets.all(context.space.lg),
            child: Text(
              'The go dark switch itself lives on the Me tab and on the map, '
              'one tap away.',
              style: context.text.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
