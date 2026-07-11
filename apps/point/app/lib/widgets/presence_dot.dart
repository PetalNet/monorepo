import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/theme/theme_x.dart';

/// Presence encoded by **form, not color** (D-015): solid = live, hollow ring =
/// away, dashed ring = stale, slashed = ghosted. Greyscale-only and color-blind
/// safe. Used both as a list-row trailing mark and (larger) as a map marker.
class PresenceDot extends StatelessWidget {
  const PresenceDot({required this.state, this.size = 12, super.key});

  final PresenceState state;
  final double size;

  @override
  Widget build(BuildContext context) {
    final tone = context.presence.toneFor(state);
    return Semantics(
      label: _semanticLabel,
      child: SizedBox.square(
        dimension: size,
        child: CustomPaint(painter: _PresencePainter(state, tone)),
      ),
    );
  }

  String get _semanticLabel => switch (state) {
        PresenceState.live => 'Live',
        PresenceState.away => 'Away',
        PresenceState.stale => 'Stale',
        PresenceState.ghosted => 'Ghosted',
      };
}

class _PresencePainter extends CustomPainter {
  const _PresencePainter(this.state, this.tone);

  final PresenceState state;
  final Color tone;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.width / 2;
    final stroke = math.max(1.4, size.width * 0.12);

    switch (state) {
      case PresenceState.live:
        canvas.drawCircle(c, r, Paint()..color = tone);
      case PresenceState.away:
        canvas.drawCircle(
          c,
          r - stroke / 2,
          Paint()
            ..color = tone
            ..style = PaintingStyle.stroke
            ..strokeWidth = stroke,
        );
      case PresenceState.stale:
        _dashedRing(canvas, c, r - stroke / 2, stroke);
      case PresenceState.ghosted:
        // Hollow ring + a diagonal slash through it.
        final p = Paint()
          ..color = tone
          ..style = PaintingStyle.stroke
          ..strokeWidth = stroke
          ..strokeCap = StrokeCap.round;
        canvas.drawCircle(c, r - stroke / 2, p);
        final d = r * 0.72;
        canvas.drawLine(c + Offset(-d, d), c + Offset(d, -d), p);
    }
  }

  void _dashedRing(Canvas canvas, Offset c, double radius, double stroke) {
    final paint = Paint()
      ..color = tone
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;
    const dashes = 10;
    const sweep = math.pi * 2 / dashes;
    const gap = sweep * 0.45;
    for (var i = 0; i < dashes; i++) {
      final start = i * sweep;
      canvas.drawArc(
        Rect.fromCircle(center: c, radius: radius),
        start,
        sweep - gap,
        false,
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_PresencePainter old) =>
      old.state != state || old.tone != tone;
}
