import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/features/map/presentation/map_screen.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';

Widget _host(Widget child) => MaterialApp(
  theme: AppTheme.dark(pureBlack: true),
  home: Scaffold(body: Center(child: child)),
);

void main() {
  testWidgets(
    'marker consolidates identity, state, freshness, and tap action',
    (tester) async {
      var opened = false;
      const person = Person(
        userId: 'morgan@point.test',
        displayName: 'Morgan Lee',
        presence: PresenceState.live,
        subtitle: 'Sharing · 4m',
        lat: 38.6,
        lon: -90.2,
      );

      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        _host(
          SizedBox(
            width: 144,
            height: 92,
            child: PresenceMarker(person: person, onTap: () => opened = true),
          ),
        ),
      );

      final node = tester.getSemantics(find.byType(PresenceMarker));
      expect(node.label, 'Morgan Lee, Live, updated 4 minutes ago');
      expect(node.hint, 'Opens location actions and person details');
      expect(node.flagsCollection.isButton, isTrue);
      expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      expect(find.bySemanticsLabel('Live'), findsNothing);
      await tester.tap(find.byType(PresenceMarker));
      expect(opened, isTrue);
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      semantics.dispose();
    },
  );

  testWidgets('marker never invents exact freshness for unknown status text', (
    tester,
  ) async {
    const person = Person(
      userId: 'morgan@point.test',
      displayName: 'Morgan Lee',
      presence: PresenceState.live,
      subtitle: '0.4 mi · moving',
      lat: 38.6,
      lon: -90.2,
    );

    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      _host(const PresenceMarker(person: person, onTap: _noop)),
    );

    final node = tester.getSemantics(find.byType(PresenceMarker));
    expect(node.label, 'Morgan Lee, Live, updated recently');
    expect(node.label, isNot(contains('updated now')));
    semantics.dispose();
  });

  testWidgets('people-list action switches away from the map branch', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark(pureBlack: true),
        home: KaiselBranchedShell.specs(
          branches: [
            KaiselBranchSpec<_MapTestRoute>(
              initial: const _MapTestRoot(),
              builder: (_, _) => Scaffold(
                appBar: AppBar(
                  actions: const [ViewPeopleListButton()],
                ),
                body: const Text('Map branch'),
              ),
            ),
            KaiselBranchSpec<_PeopleTestRoute>(
              initial: const _PeopleTestRoot(),
              builder: (_, _) => const Scaffold(body: Text('People branch')),
            ),
          ],
          chromeBuilder: (_, _, content, _) => content,
        ),
      ),
    );

    expect(find.text('Map branch'), findsOneWidget);
    await tester.tap(find.byTooltip('View people list'));
    await tester.pump();
    expect(find.text('People branch'), findsOneWidget);
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
  });
}

void _noop() {}

sealed class _MapTestRoute extends KaiselRoute {
  const _MapTestRoute();
}

final class _MapTestRoot extends _MapTestRoute {
  const _MapTestRoot();
}

sealed class _PeopleTestRoute extends KaiselRoute {
  const _PeopleTestRoute();
}

final class _PeopleTestRoot extends _PeopleTestRoute {
  const _PeopleTestRoot();
}
