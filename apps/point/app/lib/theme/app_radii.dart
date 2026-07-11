import 'package:flutter/material.dart';

/// Typed radius scale (D-015: curvy & slick). Pulled from the theme so leaf
/// widgets never hardcode `circular(n)`.
///
/// xs 8 · sm 12 · md 16 · lg 24 · xl 28 (bottom sheets / hero surfaces) ·
/// full 999 (avatars, presence dots, pill toggles).
@immutable
class AppRadii extends ThemeExtension<AppRadii> {
  const AppRadii({
    this.xs = 8,
    this.sm = 12,
    this.md = 16,
    this.lg = 24,
    this.xl = 28,
    this.full = 999,
  });

  final double xs;
  final double sm;
  final double md;
  final double lg;
  final double xl;
  final double full;

  Radius get rXs => Radius.circular(xs);
  Radius get rSm => Radius.circular(sm);
  Radius get rMd => Radius.circular(md);
  Radius get rLg => Radius.circular(lg);
  Radius get rXl => Radius.circular(xl);

  BorderRadius get brSm => BorderRadius.circular(sm);
  BorderRadius get brMd => BorderRadius.circular(md);
  BorderRadius get brLg => BorderRadius.circular(lg);
  BorderRadius get brXl => BorderRadius.circular(xl);

  /// The top-only 28 radius for bottom sheets (mockup: sheets get big top
  /// corners, square bottom).
  BorderRadius get sheetTop =>
      BorderRadius.vertical(top: Radius.circular(xl));

  @override
  AppRadii copyWith({
    double? xs,
    double? sm,
    double? md,
    double? lg,
    double? xl,
    double? full,
  }) {
    return AppRadii(
      xs: xs ?? this.xs,
      sm: sm ?? this.sm,
      md: md ?? this.md,
      lg: lg ?? this.lg,
      xl: xl ?? this.xl,
      full: full ?? this.full,
    );
  }

  @override
  AppRadii lerp(AppRadii? other, double t) {
    if (other == null) return this;
    return AppRadii(
      xs: lerpDouble(xs, other.xs, t),
      sm: lerpDouble(sm, other.sm, t),
      md: lerpDouble(md, other.md, t),
      lg: lerpDouble(lg, other.lg, t),
      xl: lerpDouble(xl, other.xl, t),
      full: lerpDouble(full, other.full, t),
    );
  }

  static double lerpDouble(double a, double b, double t) => a + (b - a) * t;
}
