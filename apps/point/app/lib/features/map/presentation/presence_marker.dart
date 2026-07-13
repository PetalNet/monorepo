import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/photo_dot.dart';
import 'package:point_app/widgets/presence_dot.dart';

typedef PresenceMarkerTap = FutureOr<void> Function();

/// A map presence marker (mockup screen 1): a large form-based [PresenceDot]
/// with the person's initials, and a small mono label pill beneath. Monochrome
/// — form carries state, never color.
class PresenceMarker extends StatelessWidget {
  const PresenceMarker({
    required this.person,
    this.timeFormat = TimeFormat.h24,
    this.onTap,
    super.key,
  });

  final Person person;
  final TimeFormat timeFormat;
  final PresenceMarkerTap? onTap;

  @override
  Widget build(BuildContext context) {
    final marker = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _MarkerSharedElement(person: person, initials: _initials),
        const SizedBox(height: 2),
        _LabelPill(text: '${person.displayName} · $_when'),
      ],
    );

    if (onTap == null) return marker;
    void openPerson() {
      int? captureToken;
      if (PersonSharedElementScope.allows(
        context,
        PersonSharedElement.marker,
      )) {
        captureToken = PersonMarkerTransition.capture(context, person.userId);
      }
      final completion = onTap!();
      if (captureToken != null && completion is Future<void>) {
        unawaited(
          completion.whenComplete(() async {
            // Let a detail route created by the sheet's Details action consume
            // the origin on its next frame. A plain dismissal leaves it
            // unconsumed and this bounded cleanup disarms stale navigation.
            await Future<void>.delayed(const Duration(milliseconds: 300));
            PersonMarkerTransition.clear(person.userId, captureToken!);
          }),
        );
      } else if (captureToken != null) {
        PersonMarkerTransition.clear(person.userId, captureToken);
      }
    }

    return Semantics(
      label: '${person.displayName}, $_semanticStatus, $_semanticFreshness',
      hint: 'Opens location actions and person details',
      button: true,
      onTap: openPerson,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        excludeFromSemantics: true,
        onTap: openPerson,
        child: marker,
      ),
    );
  }

  String get _semanticStatus => switch (person.presence) {
    PresenceState.live => 'Live',
    PresenceState.away => 'Away',
    PresenceState.stale => 'Stale',
    PresenceState.ghosted => 'Ghosted',
  };

  String get _semanticFreshness {
    final darkSince = _darkSince;
    if (darkSince != null) return darkSince;
    if (person.presence == PresenceState.stale) return 'dark';
    final compact = _compactFreshness;
    if (compact == null) return 'updated recently';
    if (compact == 'now') return 'updated now';
    final match = RegExp(r'^(\d+)([mhd])$').firstMatch(compact);
    if (match == null) return 'updated recently';
    final amount = int.parse(match.group(1)!);
    final unit = switch (match.group(2)) {
      'm' => 'minute',
      'h' => 'hour',
      _ => 'day',
    };
    return 'updated $amount $unit${amount == 1 ? '' : 's'} ago';
  }

  String get _initials {
    final parts = person.displayName.trim().split(RegExp(r'\s+'));
    if (parts.isEmpty || parts.first.isEmpty) return '?';
    return parts.first.characters.take(2).toString().toUpperCase();
  }

  String? get _compactFreshness {
    final candidate = person.subtitle.trim().split('·').last.trim();
    return candidate == 'now' || RegExp(r'^\d+[mhd]$').hasMatch(candidate)
        ? candidate
        : null;
  }

  String? get _darkSince {
    final at = person.darkSinceAt;
    return at == null ? null : 'dark since ${clockHm(at, format: timeFormat)}';
  }

  String get _when => switch (person.presence) {
    PresenceState.live => _compactFreshness ?? 'recent',
    PresenceState.stale => _darkSince ?? 'dark',
    PresenceState.away => 'last known',
    PresenceState.ghosted => 'dark',
  };
}

class _MarkerSharedElement extends StatefulWidget {
  const _MarkerSharedElement({required this.person, required this.initials});

  final Person person;
  final String initials;

  @override
  State<_MarkerSharedElement> createState() => _MarkerSharedElementState();
}

class _MarkerSharedElementState extends State<_MarkerSharedElement>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  OverlayEntry? _flight;
  bool _scheduled = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 240),
    )..addListener(_markOverlayNeedsBuild);
  }

  @override
  void dispose() {
    _flight?.remove();
    PersonMarkerTransition._end(widget.person.userId);
    _controller.dispose();
    super.dispose();
  }

  void _markOverlayNeedsBuild() => _flight?.markNeedsBuild();

  void _scheduleOriginFlight() {
    if (_scheduled) return;
    _scheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final origin = PersonMarkerTransition.take(widget.person.userId);
      final renderBox = context.findRenderObject() as RenderBox?;
      final overlay = Overlay.maybeOf(context, rootOverlay: true);
      if (origin == null || renderBox == null || overlay == null) {
        if (mounted) setState(() {});
        return;
      }
      final destination = renderBox.localToGlobal(Offset.zero) & renderBox.size;
      _flight = OverlayEntry(
        builder: (context) {
          final progress = Curves.easeOutQuart.transform(_controller.value);
          final rect = Rect.lerp(origin, destination, progress)!;
          return Positioned.fromRect(
            rect: rect,
            child: IgnorePointer(
              child: PersonHeroFlight(
                child: _MarkerIdentity(
                  person: widget.person,
                  initials: widget.initials,
                ),
              ),
            ),
          );
        },
      );
      overlay.insert(_flight!);
      PersonMarkerTransition._begin(widget.person.userId);
      setState(() {});
      unawaited(
        _controller.forward().whenComplete(() {
          _flight?.remove();
          _flight = null;
          PersonMarkerTransition._end(widget.person.userId);
          if (mounted) setState(() {});
        }),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final identity = _MarkerIdentity(
      person: widget.person,
      initials: widget.initials,
    );
    final animateFromOrigin =
        PersonSharedElementScope.animateMarkerFromOrigin(context) &&
        PersonMarkerTransition.has(widget.person.userId);
    if (animateFromOrigin && !_scheduled) {
      _scheduleOriginFlight();
      return Visibility(
        visible: false,
        maintainAnimation: true,
        maintainSize: true,
        maintainState: true,
        child: identity,
      );
    }
    if (_flight != null) {
      return Visibility(
        visible: false,
        maintainAnimation: true,
        maintainSize: true,
        maintainState: true,
        child: identity,
      );
    }
    return PersonSharedElementHero(
      userId: widget.person.userId,
      element: PersonSharedElement.marker,
      child: identity,
    );
  }
}

/// Coordinates the manual marker flight across the intermediate map sheet.
///
/// Flutter Heroes only pair adjacent routes, while Point deliberately keeps a
/// compact modal sheet between the map and detail. The captured origin lets the
/// destination marker preserve identity across that route boundary.
class PersonMarkerTransition {
  const PersonMarkerTransition._();

  static const _maxAge = Duration(minutes: 5);
  static final _origins =
      <String, ({Rect rect, DateTime capturedAt, int token})>{};
  static final _activeUsers = ValueNotifier<Set<String>>(const {});
  static final _settled = <String, Completer<void>>{};
  static int _nextToken = 0;

  static ValueListenable<Set<String>> get activeUsers => _activeUsers;

  static bool isAnimating(String userId) => _activeUsers.value.contains(userId);

  static void _begin(String userId) {
    _activeUsers.value = {..._activeUsers.value, userId};
    _settled[userId] = Completer<void>();
  }

  static void _end(String userId) {
    if (_activeUsers.value.contains(userId)) {
      _activeUsers.value = {..._activeUsers.value}..remove(userId);
    }
    _settled.remove(userId)?.complete();
  }

  static Future<void> whenSettled(String userId) =>
      _settled[userId]?.future ?? Future<void>.value();

  static int? capture(BuildContext context, String userId) {
    final renderBox = context.findRenderObject() as RenderBox?;
    if (renderBox == null || !renderBox.hasSize) return null;
    final bounds = renderBox.localToGlobal(Offset.zero) & renderBox.size;
    final marker = Rect.fromLTWH(bounds.center.dx - 22, bounds.top, 44, 44);
    final token = ++_nextToken;
    _origins[userId] = (
      rect: marker,
      capturedAt: DateTime.now(),
      token: token,
    );
    return token;
  }

  static void clear(String userId, int token) {
    if (_origins[userId]?.token == token) _origins.remove(userId);
  }

  static bool has(String userId) {
    final origin = _origins[userId];
    if (origin == null) return false;
    if (DateTime.now().difference(origin.capturedAt) <= _maxAge) return true;
    _origins.remove(userId);
    return false;
  }

  static Rect? take(String userId) {
    if (!has(userId)) return null;
    return _origins.remove(userId)?.rect;
  }
}

class _MarkerIdentity extends StatelessWidget {
  const _MarkerIdentity({required this.person, required this.initials});

  final Person person;
  final String initials;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 44,
      height: 44,
      child: Stack(
        alignment: Alignment.center,
        children: [
          // Tonal disc so initials read over any tile and during Hero flight.
          Material(
            color: context.colors.surfaceContainerHighest,
            shape: const CircleBorder(),
            child: SizedBox.square(
              dimension: 40,
              child: Center(
                child: Text(
                  initials,
                  style: context.text.labelMedium?.copyWith(
                    color: context.colors.onSurface,
                  ),
                ),
              ),
            ),
          ),
          PresenceDot(
            key: ValueKey(person.userId),
            state: person.presence,
            size: 44,
            updateToken: _updateToken(context),
          ),
        ],
      ),
    );
  }

  Object _updateToken(BuildContext context) {
    final hasProviderScope =
        context.findAncestorWidgetOfExactType<ProviderScope>() != null ||
        context.findAncestorWidgetOfExactType<UncontrolledProviderScope>() !=
            null;
    if (!hasProviderScope) {
      // PresenceMarker is also rendered in isolated design/test hosts. The
      // production map has a ProviderScope and therefore uses accepted-fix
      // identity; coordinates keep standalone rendering deterministic.
      return (person.lat, person.lon);
    }
    final target = ProviderScope.containerOf(
      context,
      listen: false,
    ).read(livePresenceProvider)[person.userId]?.target;
    return target?.timestamp ?? target?.receivedAt ?? (person.lat, person.lon);
  }
}

/// A tiny mono label pill under the marker.
class _LabelPill extends StatelessWidget {
  const _LabelPill({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 140),
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: context.space.sm,
          vertical: context.space.xxs,
        ),
        decoration: BoxDecoration(
          color: context.colors.surfaceContainer,
          borderRadius: BorderRadius.circular(context.radii.full),
        ),
        child: Text(
          text,
          maxLines: 2,
          softWrap: true,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: context.text.labelSmall?.copyWith(
            fontFamily: AppTheme.monoFamily,
            letterSpacing: 0,
            color: context.colors.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}
