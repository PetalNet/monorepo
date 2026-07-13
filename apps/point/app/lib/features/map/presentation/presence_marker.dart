import 'package:flutter/material.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/presence_dot.dart';

/// A map presence marker (mockup screen 1): a large form-based [PresenceDot]
/// with the person's initials, and a small mono label pill beneath. Monochrome
/// — form carries state, never color.
class PresenceMarker extends StatelessWidget {
  const PresenceMarker({required this.person, this.onTap, super.key});

  final Person person;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final marker = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 44,
          height: 44,
          child: Stack(
            alignment: Alignment.center,
            children: [
              // Tonal disc so initials read over any tile.
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: context.colors.surfaceContainerHighest,
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: Text(
                  _initials,
                  style: context.text.labelMedium?.copyWith(
                    color: context.colors.onSurface,
                  ),
                ),
              ),
              PresenceDot(state: person.presence, size: 44),
            ],
          ),
        ),
        const SizedBox(height: 2),
        _LabelPill(text: '${person.displayName} · $_when'),
      ],
    );

    if (onTap == null) return marker;
    return Semantics(
      label: '${person.displayName}, $_semanticStatus, $_semanticFreshness',
      hint: 'Opens location actions and person details',
      button: true,
      onTap: onTap,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        excludeFromSemantics: true,
        onTap: onTap,
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

  String get _when => person.presence == PresenceState.live
      ? (_compactFreshness ?? 'recent')
      : (person.distanceLabel ?? 'away');
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
