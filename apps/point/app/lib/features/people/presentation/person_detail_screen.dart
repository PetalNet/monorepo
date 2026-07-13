import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:latlong2/latlong.dart';
import 'package:point_app/features/crypto/verification.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/presentation/temp_share_sheet.dart';
import 'package:point_app/features/people/presentation/verify_sheet.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/photo_dot.dart';
import 'package:point_app/widgets/presence_dot.dart';

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
    final person =
        people.where((p) => p.userId == userId).firstOrNull ??
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
                  SizedBox(height: context.space.md),
                  _StatusLine(person: person),
                  SizedBox(height: context.space.xl),
                  _TempShareTile(person: person),
                  SizedBox(height: context.space.md),
                  _VerifyTile(person: person),
                  SizedBox(height: context.space.md),
                  _HideFromTile(person: person),
                  SizedBox(height: context.space.md),
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
class _FocusMap extends ConsumerStatefulWidget {
  const _FocusMap({required this.person});
  final Person person;

  @override
  ConsumerState<_FocusMap> createState() => _FocusMapState();
}

class _FocusMapState extends ConsumerState<_FocusMap>
    with SingleTickerProviderStateMixin {
  final _mapController = MapController();
  late final AnimationController _cameraAnimation;
  LatLng? _cameraFrom;
  LatLng? _cameraTarget;
  bool _mapReady = false;
  bool _following = true;

  @override
  void initState() {
    super.initState();
    _cameraAnimation = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 240),
    )..addListener(_onCameraTick);
  }

  @override
  void dispose() {
    _cameraAnimation.dispose();
    _mapController.dispose();
    super.dispose();
  }

  bool get _reducedMotion {
    final preference = ref.read(settingsProvider).motion;
    return preference == MotionPreference.reduced ||
        (preference == MotionPreference.system &&
            MediaQuery.disableAnimationsOf(context));
  }

  void _onCameraTick() {
    final from = _cameraFrom;
    final target = _cameraTarget;
    if (!_mapReady || from == null || target == null) return;
    final t = Curves.easeOutQuart.transform(_cameraAnimation.value);
    _mapController.move(
      _FocusLatLngTween(begin: from, end: target).lerp(t),
      15,
    );
  }

  void _followPosition(LatLng point) {
    if (!_following || _cameraAnimation.isAnimating) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_mapReady || !_following) return;
      _cameraAnimation.stop();
      _mapController.move(point, _mapController.camera.zoom);
    });
  }

  void _resumeFollowing(LatLng point) {
    setState(() => _following = true);
    if (!_mapReady || _reducedMotion) {
      if (_mapReady) _mapController.move(point, 15);
      return;
    }
    _cameraFrom = _mapController.camera.center;
    _cameraTarget = point;
    _cameraAnimation.forward(from: 0);
  }

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.sizeOf(context).height * 0.42;
    final person = widget.person;
    if (!person.hasLocation) {
      return SizedBox(
        height: height,
        child: ColoredBox(
          color: context.colors.surfaceContainerLowest,
          child: Center(
            child: Text(
              'No recent location',
              style: context.text.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
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
            mapController: _mapController,
            options: MapOptions(
              initialCenter: point,
              initialZoom: 15,
              interactionOptions: const InteractionOptions(
                flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
              ),
              onMapReady: () => _mapReady = true,
              onPositionChanged: (_, hasGesture) {
                if (!hasGesture || !_following) return;
                _cameraAnimation.stop();
                setState(() => _following = false);
              },
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
              _AnimatedFocusMarkerLayer(
                person: person,
                motion: ref.watch(livePresenceProvider)[person.userId],
                reducedMotion: _reducedMotion,
                onPosition: _followPosition,
              ),
            ],
          ),
          if (!_following)
            Positioned(
              right: context.space.md,
              bottom: context.space.md,
              child: FloatingActionButton.small(
                heroTag: 'follow-${person.userId}',
                tooltip: 'Follow ${person.displayName}',
                onPressed: () => _resumeFollowing(point),
                child: const Icon(Icons.near_me),
              ),
            ),
        ],
      ),
    );
  }
}

class _AnimatedFocusMarkerLayer extends StatelessWidget {
  const _AnimatedFocusMarkerLayer({
    required this.person,
    required this.motion,
    required this.reducedMotion,
    required this.onPosition,
  });

  final Person person;
  final PeerMarkerMotion? motion;
  final bool reducedMotion;
  final ValueChanged<LatLng> onPosition;

  @override
  Widget build(BuildContext context) {
    final target = LatLng(person.lat!, person.lon!);
    final previous = motion?.previous;
    final begin = previous?.lat == null || previous?.lon == null
        ? target
        : LatLng(previous!.lat!, previous.lon!);
    return TweenAnimationBuilder<LatLng>(
      tween: _FocusLatLngTween(begin: begin, end: target),
      duration: motion?.duration(reducedMotion: reducedMotion) ?? Duration.zero,
      curve: Curves.easeOutQuart,
      builder: (context, point, child) {
        onPosition(point);
        return MarkerLayer(
          markers: [
            Marker(
              point: point,
              width: 96,
              height: 72,
              alignment: Alignment.topCenter,
              child: child!,
            ),
          ],
        );
      },
      child: PresenceMarker(person: person),
    );
  }
}

class _FocusLatLngTween extends Tween<LatLng> {
  _FocusLatLngTween({required super.begin, required super.end});

  @override
  LatLng lerp(double t) {
    final start = begin!;
    final finish = end!;
    final longitudeDelta =
        (finish.longitude - start.longitude + 540) % 360 - 180;
    final longitude = start.longitude + longitudeDelta * t;
    return LatLng(
      start.latitude + (finish.latitude - start.latitude) * t,
      (longitude + 540) % 360 - 180,
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
        PhotoDot(userId: person.userId, name: person.displayName, size: 52),
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

/// The person's live/dark status, form-marked. Dark reads "Dark since HH:MM"
/// beside a stale (last-known) mark — never a colour.
class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.person});
  final Person person;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        PresenceDot(state: person.presence, size: 14),
        SizedBox(width: context.space.sm),
        Expanded(
          child: Text(
            person.subtitle.isEmpty ? 'Sharing' : person.subtitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: context.text.bodyMedium?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }
}

/// Optional out-of-band key verification (spec 08). Shows a check once verified.
class _VerifyTile extends ConsumerWidget {
  const _VerifyTile({required this.person});
  final Person person;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final verified = ref.watch(verificationProvider).contains(person.userId);
    return Material(
      color: context.colors.surfaceContainerHigh,
      borderRadius: context.radii.brMd,
      child: InkWell(
        onTap: () => VerifySheet.show(context, person),
        borderRadius: context.radii.brMd,
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: context.space.lg,
            vertical: context.space.md,
          ),
          child: Row(
            children: [
              Icon(
                verified ? Icons.verified_user : Icons.shield_outlined,
                color: context.colors.onSurface,
              ),
              SizedBox(width: context.space.md),
              Text(
                verified ? 'Verified' : 'Verify ${person.displayName}',
                style: context.text.titleMedium,
              ),
              const Spacer(),
              Icon(Icons.chevron_right, color: context.colors.onSurfaceVariant),
            ],
          ),
        ),
      ),
    );
  }
}

/// Per-person hide: go dark to just this person. When on, they see your frozen
/// last-known + "dark since" (never a "they hid" notice — symmetric, silent).
class _HideFromTile extends ConsumerWidget {
  const _HideFromTile({required this.person});
  final Person person;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ghost = ref.watch(ghostControllerProvider).value;
    final hidden = ghost?.isHiddenFrom(person.userId) ?? false;
    return Container(
      decoration: BoxDecoration(
        color: context.colors.surfaceContainerHigh,
        borderRadius: context.radii.brMd,
      ),
      child: SwitchListTile(
        value: hidden,
        onChanged: (v) => ref
            .read(ghostControllerProvider.notifier)
            .setHiddenFrom(person.userId, hidden: v),
        title: Text(
          'Hide from ${person.displayName}',
          style: context.text.titleMedium,
        ),
        subtitle: Text(
          hidden
              ? 'They see your last-known only. No one is told.'
              : "They can see your live location while you're sharing.",
          style: context.text.bodySmall?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
        contentPadding: EdgeInsets.symmetric(horizontal: context.space.lg),
        shape: RoundedRectangleBorder(borderRadius: context.radii.brMd),
      ),
    );
  }
}

/// Start (or, if one is running, show + stop) a one-way temporary share to this
/// person.
class _TempShareTile extends ConsumerWidget {
  const _TempShareTile({required this.person});
  final Person person;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final temp = ref.watch(outgoingTempsProvider)[person.userId];
    if (temp != null) {
      return Material(
        color: context.colors.surfaceContainerHigh,
        borderRadius: context.radii.brMd,
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: context.space.lg,
            vertical: context.space.md,
          ),
          child: Row(
            children: [
              Icon(Icons.arrow_forward, color: context.colors.onSurface),
              SizedBox(width: context.space.md),
              Expanded(
                child: Text(
                  'Sharing until ${clockHm(temp.expiresAt.millisecondsSinceEpoch)}',
                  style: context.text.titleMedium,
                ),
              ),
              TextButton(
                onPressed: () => ref
                    .read(tempSharesControllerProvider.notifier)
                    .stop(temp.id),
                child: const Text('Stop'),
              ),
            ],
          ),
        ),
      );
    }
    return Material(
      color: context.colors.surfaceContainerHigh,
      borderRadius: context.radii.brMd,
      child: InkWell(
        onTap: () => TempShareSheet.show(context, person),
        borderRadius: context.radii.brMd,
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: context.space.lg,
            vertical: context.space.md,
          ),
          child: Row(
            children: [
              Icon(Icons.schedule, color: context.colors.onSurface),
              SizedBox(width: context.space.md),
              Text('Share temporarily', style: context.text.titleMedium),
            ],
          ),
        ),
      ),
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
