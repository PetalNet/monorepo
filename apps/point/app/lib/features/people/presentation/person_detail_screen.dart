import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:latlong2/latlong.dart';
import 'package:point_app/features/crypto/verification.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/presentation/temp_share_sheet.dart';
import 'package:point_app/features/people/presentation/verify_sheet.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';
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
    final incomingTempPeople = ref.watch(incomingTempPeopleProvider);
    final incomingTemp = ref.watch(incomingTempsProvider)[userId];
    final ongoingPerson = people.where((p) => p.userId == userId).firstOrNull;
    final person =
        ongoingPerson ??
        incomingTempPeople.where((p) => p.userId == userId).firstOrNull ??
        Person(
          userId: userId,
          displayName: userId.split('@').first,
          presence: PresenceState.away,
          subtitle: userId,
        );
    final incomingOnly = ongoingPerson == null && incomingTemp != null;

    return PersonMarkerFlightPopGate(
      userId: userId,
      child: Scaffold(
        appBar: AppBar(
          title: Text(person.displayName),
          leading: IconButton(
            icon: const Icon(Icons.close),
            onPressed: () =>
                unawaited(_closeAfterMarkerFlight(context, userId)),
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
                    if (incomingOnly) ...[
                      _IncomingTempDetail(person: person, temp: incomingTemp),
                      SizedBox(height: context.space.md),
                      _TempShareTile(person: person),
                    ] else ...[
                      _TempShareTile(person: person),
                      SizedBox(height: context.space.md),
                      _VerifyTile(person: person),
                      SizedBox(height: context.space.md),
                      _HideFromTile(person: person),
                      SizedBox(height: context.space.md),
                      _StopSharingTile(person: person),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

Future<void> _closeAfterMarkerFlight(
  BuildContext context,
  String userId,
) async {
  await PersonMarkerTransition.whenSettled(userId);
  if (context.mounted) await context.pop();
}

class PersonMarkerFlightPopGate extends StatefulWidget {
  const PersonMarkerFlightPopGate({
    required this.userId,
    required this.child,
    super.key,
  });

  final String userId;
  final Widget child;

  @override
  State<PersonMarkerFlightPopGate> createState() =>
      _PersonMarkerFlightPopGateState();
}

class _PersonMarkerFlightPopGateState extends State<PersonMarkerFlightPopGate> {
  bool _popPending = false;

  Future<void> _onPopInvoked(bool didPop, Object? result) async {
    if (didPop || _popPending) return;
    _popPending = true;
    await PersonMarkerTransition.whenSettled(widget.userId);
    if (!mounted) return;
    Navigator.of(context).pop(result);
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<Set<String>>(
      valueListenable: PersonMarkerTransition.activeUsers,
      builder: (context, activeUsers, _) => PopScope<Object?>(
        canPop: !activeUsers.contains(widget.userId),
        onPopInvokedWithResult: _onPopInvoked,
        child: widget.child,
      ),
    );
  }
}

/// Recipient-side truth for a temp-only sender. It deliberately omits mutual
/// share controls: the sender is sharing one-way and the recipient is not.
class _IncomingTempDetail extends ConsumerWidget {
  const _IncomingTempDetail({required this.person, required this.temp});

  final Person person;
  final TempShare temp;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final format = ref.watch(settingsProvider.select((s) => s.timeFormat));
    return Semantics(
      container: true,
      label:
          '${person.displayName} is sharing with you temporarily. You are not sharing back.',
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: context.colors.surfaceContainerHigh,
          borderRadius: context.radii.brMd,
        ),
        child: Padding(
          padding: EdgeInsets.all(context.space.lg),
          child: Row(
            children: [
              Icon(Icons.arrow_back, color: context.colors.onSurface),
              SizedBox(width: context.space.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${person.displayName} → You',
                      style: context.text.titleMedium,
                    ),
                    SizedBox(height: context.space.xxs),
                    Text(
                      'You can see them until '
                      '${clockHm(temp.expiresAt.millisecondsSinceEpoch, format: format)}. '
                      "You aren't sharing back.",
                      style: context.text.bodySmall?.copyWith(
                        color: context.colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
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
                timeFormat: ref.watch(
                  settingsProvider.select((settings) => settings.timeFormat),
                ),
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
    required this.timeFormat,
    required this.reducedMotion,
    required this.onPosition,
  });

  final Person person;
  final PeerMarkerMotion? motion;
  final TimeFormat timeFormat;
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
      child: PresenceMarker(person: person, timeFormat: timeFormat),
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

  Future<void> _setHidden(
    BuildContext context,
    WidgetRef ref, {
    required bool hidden,
  }) async {
    final messenger = ScaffoldMessenger.of(context);
    final view = View.of(context);
    final direction = Directionality.of(context);
    final canAnnounce = MediaQuery.supportsAnnounceOf(context);
    final succeeded = await ref
        .read(ghostControllerProvider.notifier)
        .setHiddenFrom(person.userId, hidden: hidden);
    final message = succeeded
        ? hidden
              ? '${person.displayName} now sees your last-known location.'
              : '${person.displayName} can see your live location again.'
        : 'Could not update who sees you. Try again.';
    messenger.showSnackBar(SnackBar(content: Text(message)));
    if (canAnnounce) {
      unawaited(SemanticsService.sendAnnouncement(view, message, direction));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ghost = ref.watch(ghostControllerProvider).value;
    final hidden = ghost?.isHiddenFrom(person.userId) ?? false;
    final mutation = ref.watch(
      ghostMutationsProvider.select((mutations) => mutations[person.userId]),
    );
    final busy = mutation?.isRunning ?? false;
    final failed = mutation?.phase == GhostMutationPhase.failed;
    return Container(
      decoration: BoxDecoration(
        color: context.colors.surfaceContainerHigh,
        borderRadius: context.radii.brMd,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SwitchListTile(
            value: hidden,
            onChanged: busy
                ? null
                : (value) {
                    Haptics.commit(ref);
                    _setHidden(context, ref, hidden: value);
                  },
            title: Text(
              'Hide from ${person.displayName}',
              style: context.text.titleMedium,
            ),
            subtitle: Text(
              busy
                  ? 'Updating who can see you…'
                  : hidden
                  ? 'They see your last-known only. No one is told.'
                  : "They can see your live location while you're sharing.",
              style: context.text.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            contentPadding: EdgeInsets.symmetric(horizontal: context.space.lg),
            shape: RoundedRectangleBorder(borderRadius: context.radii.brMd),
          ),
          if (failed)
            Semantics(
              liveRegion: true,
              child: Padding(
                padding: EdgeInsets.fromLTRB(
                  context.space.lg,
                  0,
                  context.space.lg,
                  context.space.md,
                ),
                child: Row(
                  children: [
                    const Expanded(
                      child: Text('Could not update who sees you.'),
                    ),
                    TextButton(
                      onPressed: () =>
                          _setHidden(context, ref, hidden: !hidden),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Start (or, if one is running, show + stop) a one-way temporary share to this
/// person.
class _TempShareTile extends ConsumerWidget {
  const _TempShareTile({required this.person});
  final Person person;

  Future<void> _stop(
    BuildContext context,
    WidgetRef ref,
    TempShare temp,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    final view = View.of(context);
    final direction = Directionality.of(context);
    final canAnnounce = MediaQuery.supportsAnnounceOf(context);
    final outcome = await ref
        .read(tempSharesControllerProvider.notifier)
        .stop(temp.id);
    final message = switch (outcome) {
      MutationOutcome.succeeded ||
      MutationOutcome.succeededNeedsRefresh => 'Temporary sharing stopped.',
      MutationOutcome.failed => 'Could not stop sharing. Try again.',
      MutationOutcome.ignored => null,
    };
    if (message == null) return;
    messenger.showSnackBar(SnackBar(content: Text(message)));
    if (canAnnounce) {
      unawaited(SemanticsService.sendAnnouncement(view, message, direction));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mutations = ref.watch(tempShareMutationsProvider);
    final mutation = mutations.values
        .where((item) => item.share.toUserId == person.userId)
        .firstOrNull;
    final temp =
        ref.watch(outgoingTempsProvider)[person.userId] ?? mutation?.share;
    if (temp != null) {
      final failed = mutation?.phase == TempShareMutationPhase.failed;
      final busy = mutation?.isRunning ?? false;
      return Material(
        color: context.colors.surfaceContainerHigh,
        borderRadius: context.radii.brMd,
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: context.space.lg,
            vertical: context.space.md,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
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
                    onPressed: busy
                        ? null
                        : () {
                            Haptics.warning(ref);
                            _stop(context, ref, temp);
                          },
                    child: Text(
                      busy
                          ? 'Stopping…'
                          : failed
                          ? 'Retry'
                          : 'Stop',
                    ),
                  ),
                ],
              ),
              if (failed)
                Semantics(
                  liveRegion: true,
                  child: const Text('Could not stop sharing. Try again.'),
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
    final currentPhase = ref.read(
      stopSharingMutationsProvider.select(
        (mutations) => mutations[person.userId],
      ),
    );
    if (currentPhase == MutationPhase.running) return;
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
            onPressed: () {
              Haptics.warning(ref);
              Navigator.of(ctx).pop(true);
            },
            child: const Text('Stop sharing'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final outcome = await ref
        .read(stopSharingMutationsProvider.notifier)
        .stop(person.userId);
    if (!context.mounted || outcome == MutationOutcome.ignored) return;
    if (outcome == MutationOutcome.failed) {
      const message = 'Could not stop sharing. Try again.';
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text(message)));
      if (MediaQuery.supportsAnnounceOf(context)) {
        unawaited(
          SemanticsService.sendAnnouncement(
            View.of(context),
            message,
            Directionality.of(context),
          ),
        );
      }
      return;
    }
    final message = outcome == MutationOutcome.succeededNeedsRefresh
        ? 'Sharing stopped. Pull to refresh people.'
        : 'Sharing stopped.';
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
    if (MediaQuery.supportsAnnounceOf(context)) {
      unawaited(
        SemanticsService.sendAnnouncement(
          View.of(context),
          message,
          Directionality.of(context),
        ),
      );
    }
    await context.pop();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final phase = ref.watch(
      stopSharingMutationsProvider.select(
        (mutations) => mutations[person.userId],
      ),
    );
    final busy = phase == MutationPhase.running;
    final failed = phase == MutationPhase.failed;
    return Material(
      color: context.colors.surfaceContainerHigh,
      borderRadius: context.radii.brMd,
      child: InkWell(
        onTap: busy ? null : () => _stop(context, ref),
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
              Expanded(
                child: Text(
                  busy
                      ? 'Stopping sharing…'
                      : failed
                      ? 'Could not stop sharing'
                      : 'Stop sharing',
                  style: context.text.titleMedium,
                ),
              ),
              if (busy)
                const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else if (failed)
                const Text('Retry'),
            ],
          ),
        ),
      ),
    );
  }
}
