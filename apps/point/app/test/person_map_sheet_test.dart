import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/map/presentation/person_map_sheet.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';

void main() {
  group('openDirections', () {
    test('opens a geo URI first without identity data', () async {
      final launched = <Uri>[];

      final outcome = await openDirections(
        latitude: 41.878113,
        longitude: -87.629799,
        launcher: (uri) async {
          launched.add(uri);
          return true;
        },
        coordinatesWriter: (_) async => fail('coordinates were copied'),
      );

      expect(outcome, DirectionsOutcome.opened);
      expect(launched, hasLength(1));
      expect(launched.single.scheme, 'geo');
      expect(launched.single.queryParameters['q'], '41.878113,-87.629799');
      expect(launched.single.toString(), isNot(contains('mara')));
    });

    test('falls back from geo to HTTPS directions', () async {
      final launched = <Uri>[];

      final outcome = await openDirections(
        latitude: 41.878113,
        longitude: -87.629799,
        launcher: (uri) async {
          launched.add(uri);
          return launched.length == 2;
        },
        coordinatesWriter: (_) async => fail('coordinates were copied'),
      );

      expect(outcome, DirectionsOutcome.opened);
      expect(launched.map((uri) => uri.scheme), ['geo', 'https']);
      expect(launched.last.host, 'www.google.com');
      expect(launched.last.path, '/maps/dir/');
      expect(launched.last.queryParameters, {
        'api': '1',
        'destination': '41.878113,-87.629799',
      });
    });

    test('starts with HTTPS when geo handlers cannot be detected', () async {
      final launched = <Uri>[];

      final outcome = await openDirections(
        latitude: 41.878113,
        longitude: -87.629799,
        preferGeo: false,
        launcher: (uri) async {
          launched.add(uri);
          return true;
        },
      );

      expect(outcome, DirectionsOutcome.opened);
      expect(launched, hasLength(1));
      expect(launched.single.scheme, 'https');
    });

    test('copies coordinates when neither URI can open', () async {
      String? copied;

      final outcome = await openDirections(
        latitude: 41.878113,
        longitude: -87.629799,
        launcher: (_) async => false,
        coordinatesWriter: (coordinates) async => copied = coordinates,
      );

      expect(outcome, DirectionsOutcome.coordinatesCopied);
      expect(copied, '41.878113,-87.629799');
    });

    test('reports failure for invalid coordinates without launching', () async {
      var launchCount = 0;

      final outcome = await openDirections(
        latitude: 91,
        longitude: -87.629799,
        launcher: (_) async {
          launchCount += 1;
          return true;
        },
      );

      expect(outcome, DirectionsOutcome.failed);
      expect(launchCount, 0);
    });
  });

  testWidgets('Directions enters a busy state and closes after handoff', (
    tester,
  ) async {
    final handoff = Completer<DirectionsOutcome>();
    await _pumpSheet(
      tester,
      directionsOpener: ({required latitude, required longitude}) {
        expect(latitude, 41.878113);
        expect(longitude, -87.629799);
        return handoff.future;
      },
    );

    await tester.tap(find.text('Directions'));
    await tester.pump();

    expect(find.text('Opening…'), findsOneWidget);
    expect(
      tester
          .widget<InkWell>(
            find.ancestor(
              of: find.text('Opening…'),
              matching: find.byType(InkWell),
            ),
          )
          .onTap,
      isNull,
    );
    expect(
      tester
          .widget<InkWell>(
            find.ancestor(
              of: find.text('Focus'),
              matching: find.byType(InkWell),
            ),
          )
          .onTap,
      isNull,
    );

    await tester.tapAt(const Offset(10, 10));
    await tester.pump();
    expect(find.byType(PersonMapSheet), findsOneWidget);

    handoff.complete(DirectionsOutcome.opened);
    await tester.pumpAndSettle();

    expect(find.byType(PersonMapSheet), findsNothing);
  });

  testWidgets('copied-coordinate fallback confirms recovery', (tester) async {
    await _pumpSheet(
      tester,
      directionsOpener: ({required latitude, required longitude}) async =>
          DirectionsOutcome.coordinatesCopied,
    );

    await tester.tap(find.text('Directions'));
    await tester.pumpAndSettle();

    expect(find.byType(PersonMapSheet), findsNothing);
    expect(find.text('No maps app found. Coordinates copied.'), findsOneWidget);
  });

  testWidgets('Directions exposes an enabled button semantic', (tester) async {
    final semantics = tester.ensureSemantics();
    await _pumpSheet(
      tester,
      directionsOpener: ({required latitude, required longitude}) async =>
          DirectionsOutcome.opened,
    );

    expect(
      tester.getSemantics(find.text('Directions')),
      matchesSemantics(
        label: 'Directions',
        isButton: true,
        hasEnabledState: true,
        isEnabled: true,
        hasTapAction: true,
      ),
    );
    semantics.dispose();
  });
}

const _person = Person(
  userId: 'mara@example.test',
  displayName: 'Mara',
  presence: PresenceState.live,
  lat: 41.878113,
  lon: -87.629799,
);

Future<void> _pumpSheet(
  WidgetTester tester, {
  required DirectionsOpener directionsOpener,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.dark(pureBlack: true),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => PersonMapSheet.show(
              context,
              person: _person,
              onFocus: () {},
              onOpenDetail: () {},
              directionsOpener: directionsOpener,
            ),
            child: const Text('Show sheet'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Show sheet'));
  await tester.pumpAndSettle();
}
