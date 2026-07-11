import 'package:flutter/material.dart';

/// The reserved chromatic channel (D-015). v1 spends **zero hue**: the first
/// appearance of color in the product means "this entity is bridged from
/// another network" (v2). This extension exists as the typed slot so v1 code
/// can reference "bridge accent" semantics without hardcoding a color — but in
/// v1 every accessor returns null / a neutral, so nothing renders hue.
@immutable
class BridgeAccent extends ThemeExtension<BridgeAccent> {
  const BridgeAccent({this.accent});

  /// Null in v1 (no bridges). v2 assigns each external network a saturated hue.
  final Color? accent;

  bool get isActive => accent != null;

  @override
  BridgeAccent copyWith({Color? accent}) =>
      BridgeAccent(accent: accent ?? this.accent);

  @override
  BridgeAccent lerp(BridgeAccent? other, double t) {
    if (other == null) return this;
    return BridgeAccent(accent: Color.lerp(accent, other.accent, t));
  }
}
