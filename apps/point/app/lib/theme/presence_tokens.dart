import 'package:flutter/material.dart';

/// Presence is encoded by **form, not color** (D-015). These tokens carry the
/// greyscale tones the form-based presence dot renders with — never a hue.
/// Distinguishable in pure greyscale and to color-blind users.
enum PresenceState {
  /// Solid filled — live/sharing now.
  live,

  /// Hollow ring — away.
  away,

  /// Dashed ring — stale / last-known.
  stale,

  /// Slashed — ghosted / hidden.
  ghosted,
}

@immutable
class PresenceTokens extends ThemeExtension<PresenceTokens> {
  const PresenceTokens({
    required this.ink,
    required this.muted,
    required this.faint,
  });

  /// Strong tone for a live/solid mark (usually `onSurface`).
  final Color ink;

  /// Medium tone for away/stale rings (usually `onSurfaceVariant`).
  final Color muted;

  /// Faint tone for the ghosted slash / dashed strokes.
  final Color faint;

  Color toneFor(PresenceState s) => switch (s) {
        PresenceState.live => ink,
        PresenceState.away => muted,
        PresenceState.stale => muted,
        PresenceState.ghosted => faint,
      };

  @override
  PresenceTokens copyWith({Color? ink, Color? muted, Color? faint}) {
    return PresenceTokens(
      ink: ink ?? this.ink,
      muted: muted ?? this.muted,
      faint: faint ?? this.faint,
    );
  }

  @override
  PresenceTokens lerp(PresenceTokens? other, double t) {
    if (other == null) return this;
    return PresenceTokens(
      ink: Color.lerp(ink, other.ink, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      faint: Color.lerp(faint, other.faint, t)!,
    );
  }
}
