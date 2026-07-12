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
  const PresenceMarker({required this.person, super.key});

  final Person person;

  @override
  Widget build(BuildContext context) {
    return Column(
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
                  style: context.text.labelMedium
                      ?.copyWith(color: context.colors.onSurface),
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
  }

  String get _initials {
    final parts = person.displayName.trim().split(RegExp(r'\s+'));
    if (parts.isEmpty || parts.first.isEmpty) return '?';
    return parts.first.characters.take(2).toString().toUpperCase();
  }

  String get _when => person.presence == PresenceState.live
      ? 'now'
      : (person.distanceLabel ?? 'away');
}

/// A tiny mono label pill under the marker.
class _LabelPill extends StatelessWidget {
  const _LabelPill({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 92),
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
          maxLines: 1,
          softWrap: false,
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
