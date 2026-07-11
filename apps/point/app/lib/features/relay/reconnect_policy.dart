import 'dart:math';

/// Reconnect backoff with **jitter** (GO-bar #3). The legacy client had two
/// bugs this fixes: exponential backoff with *no jitter* (so every client
/// reconnects in lockstep and thundering-herds the server), and a counter that
/// reset the moment a socket opened — before it was proven healthy — so the
/// backoff never actually grew on a flapping link.
///
/// Pure + deterministic given an injected RNG, so it unit-tests cleanly.
class ReconnectPolicy {
  ReconnectPolicy({
    this.base = const Duration(seconds: 1),
    this.max = const Duration(seconds: 60),
    this.jitter = 0.5,
    Random? random,
  }) : _random = random ?? Random();

  final Duration base;
  final Duration max;

  /// Fraction of the delay applied as +/- randomisation (0..1).
  final double jitter;
  final Random _random;

  int _attempt = 0;

  /// Reset only once a connection is proven HEALTHY (authenticated), never on
  /// mere socket-open — that was the legacy bug.
  void onConnected() => _attempt = 0;

  /// Compute the next delay and advance the attempt counter.
  Duration nextDelay() {
    final exp = base.inMilliseconds * pow(2, _attempt);
    final capped = min(exp.toDouble(), max.inMilliseconds.toDouble());
    // Full +/- jitter around the capped delay.
    final delta = capped * jitter * (_random.nextDouble() * 2 - 1);
    final ms = (capped + delta).clamp(0, max.inMilliseconds).round();
    _attempt++;
    return Duration(milliseconds: ms);
  }

  int get attempt => _attempt;
}
