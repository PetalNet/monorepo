import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';

/// Circular initials avatar on a tonal surface (mockup: "AR", "JP", …).
/// Monochrome — the ring/fill never carries hue in v1.
class InitialsAvatar extends StatelessWidget {
  const InitialsAvatar({required this.name, this.size = 44, super.key});

  final String name;
  final double size;

  String get _initials {
    final parts = name.trim().split(RegExp(r'\s+'));
    if (parts.isEmpty || parts.first.isEmpty) return '?';
    if (parts.length == 1) {
      return parts.first.characters.take(2).toString().toUpperCase();
    }
    return (parts.first.characters.first + parts.last.characters.first)
        .toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: context.colors.surfaceContainerHighest,
        shape: BoxShape.circle,
      ),
      child: Text(
        _initials,
        style: context.text.labelLarge?.copyWith(
          fontWeight: FontWeight.w700,
          color: context.colors.onSurface,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}
