import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:latlong2/latlong.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/initials_avatar.dart';

/// One person's detail (spec 06/08): a map focused on them (or a calm
/// no-location state), their handle (federation shown quiet), and the share
/// controls. Per-person hide and verify land in later waves; this wave wires the
/// map focus, the identity, and "Stop sharing".
class PersonDetailScreen extends ConsumerWidget {
  const PersonDetailScreen({required this.userId, super.key});

  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final people = ref.watch(peopleWithPresenceProvider);
    final person = people.where((p) => p.userId == userId).firstOrNull ??
        Person(
          userId: userId,
          displayName: userId.split('@').first,
          presence: PresenceState.away,
          subtitle: userId,
        );

    return Scaffold(
      appBar: AppBar(
        title: Text(person.displayName),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => context.pop(),
        ),
      ),
      body: SafeArea(
        child: Column(
          children: [
            _FocusMap(person: person),
            Expanded(
              child: ListView(
                padding: EdgeInsets.all(context.space.lg),
                children: [
                  _IdentityHeader(person: person),
                  SizedBox(height: context.space.xl),
                  _StopSharingTile(person: person),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A fixed-height map focused on the person, or a calm placeholder when there's
/// no recent location (dark / away / not yet located).
class _FocusMap extends StatelessWidget {
  const _FocusMap({required this.person});
  final Person person;

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.sizeOf(context).height * 0.42;
    if (!person.hasLocation) {
      return SizedBox(
        height: height,
        child: ColoredBox(
          color: context.colors.surfaceContainerLowest,
          child: Center(
            child: Text(
              'No recent location',
              style: context.text.bodyMedium
                  ?.copyWith(color: context.colors.onSurfaceVariant),
            ),
          ),
        ),
      );
    }
    final point = LatLng(person.lat!, person.lon!);
    return SizedBox(
      height: height,
      child: Stack(
        children: [
          Positioned.fill(child: ColoredBox(color: context.colors.surface)),
          FlutterMap(
            options: MapOptions(
              initialCenter: point,
              initialZoom: 15,
              interactionOptions: const InteractionOptions(
                flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
              ),
            ),
            children: [
              TileLayer(
                urlTemplate:
                    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
                subdomains: const ['a', 'b', 'c', 'd'],
                retinaMode: RetinaMode.isHighDensity(context),
                userAgentPackageName: 'dev.petalcat.point',
                tileBuilder: (context, child, tile) => child,
              ),
              MarkerLayer(
                markers: [
                  Marker(
                    point: point,
                    width: 96,
                    height: 72,
                    alignment: Alignment.topCenter,
                    child: PresenceMarker(person: person),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _IdentityHeader extends StatelessWidget {
  const _IdentityHeader({required this.person});
  final Person person;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        InitialsAvatar(name: person.displayName, size: 52),
        SizedBox(width: context.space.md),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(person.displayName, style: context.text.titleLarge),
              SizedBox(height: context.space.xxs),
              Text(
                person.userId,
                style: context.text.bodyMedium?.copyWith(
                  fontFamily: AppTheme.monoFamily,
                  letterSpacing: 0,
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Removes the mutual share, then closes the detail. Confirms first — it's not a
/// one-tap-undo action.
class _StopSharingTile extends ConsumerWidget {
  const _StopSharingTile({required this.person});
  final Person person;

  Future<void> _stop(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Stop sharing with ${person.displayName}?'),
        content: const Text(
          "You'll stop seeing each other. You can add them again later.",
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Stop sharing'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    await ref.read(apiProvider).deleteShare(session.token, person.userId);
    await ref.read(peopleControllerProvider.notifier).refresh();
    await ref.read(requestsControllerProvider.notifier).refresh();
    if (context.mounted) await context.pop();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Material(
      color: context.colors.surfaceContainerHigh,
      borderRadius: context.radii.brMd,
      child: InkWell(
        onTap: () => _stop(context, ref),
        borderRadius: context.radii.brMd,
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: context.space.lg,
            vertical: context.space.md,
          ),
          child: Row(
            children: [
              Icon(Icons.link_off, color: context.colors.onSurface),
              SizedBox(width: context.space.md),
              Text('Stop sharing', style: context.text.titleMedium),
            ],
          ),
        ),
      ),
    );
  }
}
