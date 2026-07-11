import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/widgets/ghost_toggle.dart';
import 'package:point_app/widgets/initials_avatar.dart';
import 'package:point_app/widgets/presence_dot.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.dark(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
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
    testWidgets('exposes toggle state to a11y and is a large tap target',
        (tester) async {
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
