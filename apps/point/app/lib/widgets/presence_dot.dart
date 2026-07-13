import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/theme/theme_x.dart';

/// Presence encoded by **form, not color** (D-015): solid = live, hollow ring =
/// away, dashed ring = stale, slashed = ghosted. Greyscale-only and color-blind
/// safe. Used both as a list-row trailing mark and (larger) as a map marker.
class PresenceDot extends StatefulWidget {
  const PresenceDot({
    required this.state,
    this.size = 12,
    this.updateToken,
    super.key,
  });

  final PresenceState state;
  final double size;

  /// Identity of the latest accepted live update.
  ///
  /// Changing a non-null token acknowledges the update once. Callers that do
  /// not represent live-updating locations leave this null and remain static.
  final Object? updateToken;

  @override
  State<PresenceDot> createState() => _PresenceDotState();
}

class _PresenceDotState extends State<PresenceDot>
    with SingleTickerProviderStateMixin {
  static const _acknowledgmentDuration = Duration(milliseconds: 180);
  static const _stateTransitionDuration = Duration(milliseconds: 180);
  static const _acknowledgmentScale = 1.06;

  late final AnimationController _controller;
  late final Animation<double> _scale;
  bool _reducedMotion = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: _acknowledgmentDuration,
    );
    _scale = TweenSequence<double>([
      TweenSequenceItem(
        tween: Tween<double>(
          begin: 1,
          end: _acknowledgmentScale,
        ).chain(CurveTween(curve: Curves.easeOutQuart)),
        weight: 40,
      ),
      TweenSequenceItem(
        tween: Tween<double>(
          begin: _acknowledgmentScale,
          end: 1,
        ).chain(CurveTween(curve: Curves.easeOutQuart)),
        weight: 60,
      ),
    ]).animate(_controller);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reducedMotion = ReducedMotionScope.of(context);
    if (_reducedMotion) _resetAcknowledgment();
  }

  @override
  void didUpdateWidget(PresenceDot oldWidget) {
    super.didUpdateWidget(oldWidget);
    final receivedNewUpdate =
        oldWidget.updateToken != null &&
        widget.updateToken != null &&
        oldWidget.updateToken != widget.updateToken;
    if (widget.state != PresenceState.live || _reducedMotion) {
      _resetAcknowledgment();
    } else if (receivedNewUpdate) {
      _controller.forward(from: 0);
    }
  }

  void _resetAcknowledgment() {
    _controller
      ..stop()
      ..value = 0;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tone = context.presence.toneFor(widget.state);
    return Semantics(
      label: _semanticLabel,
      child: SizedBox.square(
        dimension: widget.size,
        child: ScaleTransition(
          scale: _scale,
          child: AnimatedSwitcher(
            duration: _reducedMotion ? Duration.zero : _stateTransitionDuration,
            reverseDuration: _reducedMotion
                ? Duration.zero
                : _stateTransitionDuration,
            switchInCurve: Curves.easeOutQuart,
            switchOutCurve: Curves.easeOutQuart,
            transitionBuilder: (child, animation) =>
                FadeTransition(opacity: animation, child: child),
            child: CustomPaint(
              key: ValueKey(widget.state),
              painter: _PresencePainter(widget.state, tone),
            ),
          ),
        ),
      ),
    );
  }

  String get _semanticLabel => switch (widget.state) {
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
