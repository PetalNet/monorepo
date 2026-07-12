import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';

/// The signed-in user's own map marker: a flat photo-dot (monogram fallback in
/// v1 — no avatar upload) at a FIXED 44dp screen size with a thin ring,
/// center-anchored on the exact coordinate, inside a 48dp invisible hit target.
/// Fixed screen size means it never scales with map zoom (flutter_map renders
/// markers in screen space).
class SelfMarker extends StatelessWidget {
  const SelfMarker({required this.name, this.onTap, super.key});

  /// Fixed marker box — pass as the flutter_map `Marker` width/height so the hit
  /// target and layout stay stable regardless of zoom.
  static const double size = 48;
  static const double _dot = 44;
  static const double _ring = 2;

  final String name;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'You',
      button: onTap != null,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: SizedBox(
          width: size,
          height: size,
          child: Center(
            child: Container(
              width: _dot,
              height: _dot,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: context.colors.surfaceContainerHighest,
                border: Border.all(
                  color: context.colors.onSurface,
                  width: _ring,
                ),
              ),
              child: Text(
                _initials,
                style: context.text.titleMedium
                    ?.copyWith(color: context.colors.onSurface),
              ),
            ),
          ),
        ),
      ),
    );
  }

  String get _initials {
    final parts = name.trim().split(RegExp(r'\s+'));
    if (parts.isEmpty || parts.first.isEmpty) return '?';
    if (parts.length == 1) {
      return parts.first.characters.take(2).toString().toUpperCase();
    }
    return (parts.first.characters.first + parts[1].characters.first)
        .toUpperCase();
  }
}
