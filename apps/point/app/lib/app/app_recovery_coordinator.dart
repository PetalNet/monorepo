import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/app/session_transition.dart';
import 'package:point_app/features/map/map_tiles.dart';
import 'package:point_app/features/relay/data/realtime_sync_coordinator.dart';
import 'package:point_app/features/relay/domain/realtime_sync_models.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';

/// Binds recovery to the two app-level entry points that can make remote data
/// reachable again: an established identity and a foreground transition.
///
/// Keeping this as a widget makes the binding follow the app's mounted
/// lifetime and lets tests drive real auth emissions and Flutter lifecycle
/// notifications rather than calling recovery methods directly.
class AppRecoveryBinding extends ConsumerStatefulWidget {
  const AppRecoveryBinding({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<AppRecoveryBinding> createState() => _AppRecoveryBindingState();
}

class _AppRecoveryBindingState extends ConsumerState<AppRecoveryBinding>
    with WidgetsBindingObserver {
  final _sessions = SessionTracker();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    ref
      ..read(appRecoveryCoordinatorProvider)
      ..listenManual(authControllerProvider, _onAuth, fireImmediately: true);
  }

  void _onAuth(AsyncValue<Session?>? previous, AsyncValue<Session?> next) {
    if (_sessions.onEmission(previous, next) == SessionTransition.establish) {
      unawaited(
        ref.read(appRecoveryCoordinatorProvider).sessionEstablished(),
      );
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(ref.read(appRecoveryCoordinatorProvider).appResumed());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// Reconciles durable app state and private-map discovery at the lifecycle
/// boundaries where a mobile connection can become useful again.
///
/// Realtime data keeps its own serialized retry contract. Map discovery is a
/// separate best-effort nudge: a failed discovery retries in the background,
/// while a same-server last-known source remains renderable.
class AppRecoveryCoordinator {
  AppRecoveryCoordinator(this._ref) {
    _relaySub = _ref.read(relayControllerProvider).syncRequests.listen((
      reason,
    ) {
      if (reason == RealtimeSyncReason.wsAuthenticated) {
        _retryTileDiscoveryIfFailed();
      }
    });
    _connectivitySub = _ref
        .read(connectivityChangesProvider)
        .listen(_onConnectivityChanged);
    _ref
      ..listen(serverTileInfoProvider, _onTileInfoChanged)
      ..listen(authControllerProvider, (_, next) {
        if (next.value == null) _resetTileRetry();
      });
  }

  final Ref _ref;
  StreamSubscription<RealtimeSyncReason>? _relaySub;
  StreamSubscription<List<ConnectivityResult>>? _connectivitySub;
  Timer? _tileRetryTimer;
  int _tileRetryAttempt = 0;
  bool _sawNoConnectivity = false;
  bool _hasConnectivitySnapshot = false;

  /// An independent lifecycle nudge. Overlapping calls are serialized by the
  /// authoritative coordinator; tile discovery only restarts when unresolved
  /// or failed, so cached content never flashes away on a healthy resume.
  Future<RealtimeSyncDiff> recover(RealtimeSyncReason reason) {
    _retryTileDiscoveryIfFailed();
    return _ref.read(realtimeSyncCoordinatorProvider).syncNow(reason);
  }

  Future<RealtimeSyncDiff> sessionEstablished() =>
      recover(RealtimeSyncReason.sessionEstablished);

  Future<RealtimeSyncDiff> appResumed() =>
      recover(RealtimeSyncReason.appResumed);

  /// User escape hatch. Automatic recovery remains the normal path.
  void retryMapNow() {
    _tileRetryTimer?.cancel();
    _tileRetryTimer = null;
    _ref.invalidate(serverTileInfoProvider);
  }

  void _retryTileDiscoveryIfFailed() {
    final tileInfo = _ref.read(serverTileInfoProvider);
    if (tileInfo.hasError && !tileInfo.isLoading) retryMapNow();
  }

  void _onTileInfoChanged(
    AsyncValue<ServerTileInfo>? previous,
    AsyncValue<ServerTileInfo> next,
  ) {
    if (next.hasValue && !next.hasError) {
      _resetTileRetry();
      return;
    }
    if (next.isLoading || !next.hasError || _tileRetryTimer != null) return;
    final delays = _ref.read(mapRecoveryBackoffProvider);
    final delay = delays[_tileRetryAttempt.clamp(0, delays.length - 1)];
    _tileRetryAttempt++;
    _tileRetryTimer = Timer(delay, () {
      _tileRetryTimer = null;
      if (_ref.read(authControllerProvider).value != null) {
        _ref.invalidate(serverTileInfoProvider);
      }
    });
  }

  void _onConnectivityChanged(List<ConnectivityResult> results) {
    final connected = results.any(
      (result) => result != ConnectivityResult.none,
    );
    if (!connected) {
      _hasConnectivitySnapshot = true;
      _sawNoConnectivity = true;
      return;
    }
    final shouldRecover = _sawNoConnectivity || !_hasConnectivitySnapshot;
    _hasConnectivitySnapshot = true;
    _sawNoConnectivity = false;
    if (!shouldRecover) return;
    if (_ref.read(authControllerProvider).value != null) {
      unawaited(recover(RealtimeSyncReason.networkRegained));
    }
  }

  void _resetTileRetry() {
    _tileRetryTimer?.cancel();
    _tileRetryTimer = null;
    _tileRetryAttempt = 0;
  }

  Future<void> dispose() async {
    _resetTileRetry();
    await _relaySub?.cancel();
    await _connectivitySub?.cancel();
  }
}

/// Platform connectivity is only a recovery nudge, never proof that the
/// internet or a homeserver is reachable. All requests retain their normal
/// timeout/error handling.
final connectivityChangesProvider = Provider<Stream<List<ConnectivityResult>>>(
  (_) => Connectivity().onConnectivityChanged,
);

/// Short at first for transient radio changes, capped so a prolonged outage
/// never becomes a request loop.
final mapRecoveryBackoffProvider = Provider<List<Duration>>(
  (_) => const [
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
    Duration(seconds: 16),
    Duration(seconds: 32),
  ],
);

final appRecoveryCoordinatorProvider = Provider<AppRecoveryCoordinator>((ref) {
  final coordinator = AppRecoveryCoordinator(ref);
  ref.onDispose(() => unawaited(coordinator.dispose()));
  return coordinator;
});
