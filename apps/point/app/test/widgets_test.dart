import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/widgets/ghost_toggle.dart';
import 'package:point_app/widgets/initials_avatar.dart';
import 'package:point_app/widgets/presence_dot.dart';

Widget _host(Widget child) => MaterialApp(
  theme: AppTheme.dark(),
  home: Scaffold(body: Center(child: child)),
);

Widget _relayHost(
  RelayHealth health, {
  VoidCallback? onAction,
  bool reducedMotion = false,
}) => ProviderScope(
  child: MaterialApp(
    theme: AppTheme.dark(pureBlack: true),
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: reducedMotion),
      child: Scaffold(
        appBar: AppBar(
          title: RelayHealthIndicator(health: health, onAction: onAction),
        ),
      ),
    ),
  ),
);

void main() {
  FlutterSecureStorage.setMockInitialValues({});

  group('RelayHealthIndicator', () {
    const states = {
      RelayHealthStatus.connecting: 'Connecting',
      RelayHealthStatus.live: 'Live',
      RelayHealthStatus.reconnecting: 'Reconnecting',
      RelayHealthStatus.offline: 'Offline',
      RelayHealthStatus.cryptoBlocked: 'Secure sync blocked',
    };

    for (final entry in states.entries) {
      testWidgets('renders ${entry.key.name} as text and semantics', (
        tester,
      ) async {
        await tester.pumpWidget(
          _relayHost(
            RelayHealth(
              status: entry.key,
              queueDepth: 0,
              locationBlocked: false,
            ),
          ),
        );
        expect(find.textContaining(entry.value), findsOneWidget);
        expect(
          find.bySemanticsLabel(RegExp('^${entry.value}\\.')),
          findsOneWidget,
        );
      });
    }

    testWidgets('offline retry is reachable and reduced motion is instant', (
      tester,
    ) async {
      var retries = 0;
      await tester.pumpWidget(
        _relayHost(
          const RelayHealth.offline(),
          reducedMotion: true,
          onAction: () => retries++,
        ),
      );
      expect(
        tester.widget<AnimatedSwitcher>(find.byType(AnimatedSwitcher)).duration,
        Duration.zero,
      );
      expect(find.text('Retry'), findsNothing);
      final targetSize = tester.getSize(find.byType(RelayHealthIndicator));
      expect(targetSize.width, greaterThanOrEqualTo(kMinInteractiveDimension));
      expect(targetSize.height, greaterThanOrEqualTo(kMinInteractiveDimension));
      final semantics = tester
          .getSemantics(find.byType(RelayHealthIndicator))
          .getSemanticsData();
      expect(semantics.hasAction(SemanticsAction.tap), isTrue);
      await tester.tap(find.byType(RelayHealthIndicator));
      expect(retries, 1);
    });

    testWidgets('healthy state is compact and has no permanent sync action', (
      tester,
    ) async {
      await tester.pumpWidget(
        _relayHost(
          RelayHealth(
            status: RelayHealthStatus.live,
            queueDepth: 0,
            locationBlocked: false,
            lastSyncAt: DateTime.now(),
          ),
        ),
      );
      expect(find.text('Live · just now'), findsOneWidget);
      expect(find.text('Sync'), findsNothing);
      expect(find.byType(TextButton), findsNothing);
    });

    testWidgets('queued and location-blocked states never claim Live', (
      tester,
    ) async {
      await tester.pumpWidget(
        _relayHost(
          const RelayHealth(
            status: RelayHealthStatus.live,
            queueDepth: 2,
            locationBlocked: false,
          ),
        ),
      );
      expect(find.text('Syncing 2 updates'), findsOneWidget);
      expect(find.text('Live'), findsNothing);

      await tester.pumpWidget(
        _relayHost(
          const RelayHealth(
            status: RelayHealthStatus.live,
            queueDepth: 0,
            locationBlocked: true,
          ),
        ),
      );
      expect(find.text('Location unavailable'), findsOneWidget);
      expect(find.text('Live'), findsNothing);
    });
  });

  group('PresenceDot (form-not-color primitive)', () {
    for (final state in PresenceState.values) {
      testWidgets('renders + labels ${state.name}', (tester) async {
        await tester.pumpWidget(_host(PresenceDot(state: state)));
        expect(find.byType(PresenceDot), findsOneWidget);
        // Each state carries a distinct Semantics label (color-blind safe).
        final expected = switch (state) {
          PresenceState.live => 'Live',
          PresenceState.away => 'Away',
          PresenceState.stale => 'Stale',
          PresenceState.ghosted => 'Ghosted',
        };
        expect(
          find.bySemanticsLabel(expected),
          findsOneWidget,
          reason: 'presence must be distinguishable without color',
        );
      });
    }
  });

  group('GhostToggle (safety-critical control)', () {
    testWidgets('exposes toggle state to a11y and is a large tap target', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(GhostToggle(sharing: true, onChanged: (_) {})),
      );
      // Safety-critical control must carry an a11y label and a ≥48dp target.
      expect(find.bySemanticsLabel('Location sharing'), findsOneWidget);
      final size = tester.getSize(find.byType(GhostToggle));
      expect(size.height, greaterThanOrEqualTo(48));
    });

    testWidgets('tap flips sharing (no color-only signal)', (tester) async {
      bool? next;
      await tester.pumpWidget(
        _host(GhostToggle(sharing: true, onChanged: (v) => next = v)),
      );
      await tester.tap(find.byType(GhostToggle));
      expect(next, isFalse);
    });

    testWidgets('off state flips the other way', (tester) async {
      bool? next;
      await tester.pumpWidget(
        _host(GhostToggle(sharing: false, onChanged: (v) => next = v)),
      );
      await tester.tap(find.byType(GhostToggle));
      expect(next, isTrue);
    });
  });

  group('InitialsAvatar', () {
    testWidgets('single name -> two letters', (tester) async {
      await tester.pumpWidget(_host(const InitialsAvatar(name: 'Aria')));
      expect(find.text('AR'), findsOneWidget);
    });
    testWidgets('two names -> initials', (tester) async {
      await tester.pumpWidget(_host(const InitialsAvatar(name: 'Jesse Kim')));
      expect(find.text('JK'), findsOneWidget);
    });
  });
}
