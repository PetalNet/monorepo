import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/features/map/presentation/person_map_sheet.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/features/people/presentation/person_detail_screen.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/widgets/photo_dot.dart';

const _person = Person(
  userId: 'morgan@point.test',
  displayName: 'Morgan Lee',
  presence: PresenceState.live,
  subtitle: 'Sharing · now',
  lat: 38.6,
  lon: -90.2,
);

class _TransitionHost extends StatelessWidget {
  const _TransitionHost({
    required this.elements,
    required this.child,
  });

  final Set<PersonSharedElement> elements;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ProviderScope(
      child: MaterialApp(
        theme: AppTheme.dark(pureBlack: true),
        home: PersonSharedElementScope(
          elements: elements,
          child: Scaffold(body: child),
        ),
      ),
    );
  }
}

class _MapSheetFlightSource extends StatelessWidget {
  const _MapSheetFlightSource({this.reduced = false});

  final bool reduced;

  @override
  Widget build(BuildContext context) {
    final elements = reduced
        ? const <PersonSharedElement>{}
        : const {PersonSharedElement.marker};
    return PersonSharedElementScope(
      elements: elements,
      child: Scaffold(
        body: Center(
          child: PresenceMarker(
            person: _person,
            onTap: () => PersonMapSheet.show(
              context,
              person: _person,
              onFocus: () {},
              onOpenDetail: () {
                final page = PersonDetailTransitionPage(
                  reduced: reduced,
                  child: PersonMarkerFlightPopGate(
                    userId: _person.userId,
                    child: PersonSharedElementScope(
                      elements: elements,
                      animateMarkerOrigin: !reduced,
                      child: const Scaffold(
                        body: Center(child: PresenceMarker(person: _person)),
                      ),
                    ),
                  ),
                );
                unawaited(
                  Navigator.of(context).push(page.createRoute(context)),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

void main() {
  test('person tags are stable per user and distinct per identity surface', () {
    expect(
      const PersonHeroTag('morgan@point.test', PersonSharedElement.avatar),
      const PersonHeroTag('morgan@point.test', PersonSharedElement.avatar),
    );
    expect(
      const PersonHeroTag('morgan@point.test', PersonSharedElement.avatar),
      isNot(
        const PersonHeroTag('morgan@point.test', PersonSharedElement.marker),
      ),
    );
  });

  testWidgets('full motion exposes separate avatar and marker Hero states', (
    tester,
  ) async {
    await tester.pumpWidget(
      const _TransitionHost(
        elements: {
          PersonSharedElement.avatar,
          PersonSharedElement.marker,
        },
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            PhotoDot(
              userId: 'morgan@point.test',
              name: 'Morgan Lee',
              size: 44,
            ),
            PresenceMarker(person: _person),
          ],
        ),
      ),
    );

    final tags = tester
        .widgetList<Hero>(find.byType(Hero))
        .map((hero) => hero.tag)
        .toSet();
    expect(tags, {
      const PersonHeroTag('morgan@point.test', PersonSharedElement.avatar),
      const PersonHeroTag('morgan@point.test', PersonSharedElement.marker),
    });
  });

  testWidgets('reduced motion removes shared-element flights', (tester) async {
    await tester.pumpWidget(
      const _TransitionHost(
        elements: {},
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            PhotoDot(userId: 'morgan@point.test', name: 'Morgan Lee'),
            PresenceMarker(person: _person),
          ],
        ),
      ),
    );

    expect(find.byType(Hero), findsNothing);
  });

  testWidgets('preserved inactive branches do not register duplicate Heroes', (
    tester,
  ) async {
    await tester.pumpWidget(
      const _TransitionHost(
        elements: {PersonSharedElement.avatar},
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            PhotoDot(userId: 'morgan@point.test', name: 'Morgan Lee'),
            TickerMode(
              enabled: false,
              child: PhotoDot(
                userId: 'morgan@point.test',
                name: 'Morgan Lee',
              ),
            ),
          ],
        ),
      ),
    );

    expect(find.byType(PhotoDot), findsNWidgets(2));
    expect(find.byType(Hero), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'an early back waits for the marker flight before returning to the map',
    (
      tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            theme: AppTheme.dark(pureBlack: true),
            home: const _MapSheetFlightSource(),
          ),
        ),
      );

      await tester.tap(find.byType(PresenceMarker));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Details'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 80));

      expect(PersonMarkerTransition.isAnimating(_person.userId), isTrue);
      expect(tester.takeException(), isNull);

      unawaited(
        Navigator.of(
          tester.element(find.byType(PresenceMarker).last),
        ).maybePop(),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 80));

      expect(PersonMarkerTransition.isAnimating(_person.userId), isTrue);
      expect(find.byType(PersonMarkerFlightPopGate), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.pumpAndSettle();
      expect(PersonMarkerTransition.isAnimating(_person.userId), isFalse);
      expect(find.byType(PersonMarkerFlightPopGate), findsNothing);
      expect(find.byType(PresenceMarker), findsOneWidget);
    },
  );

  testWidgets(
    'reduced map-sheet navigation is immediate and has no Hero flight',
    (
      tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            theme: AppTheme.dark(pureBlack: true),
            home: const _MapSheetFlightSource(reduced: true),
          ),
        ),
      );

      await tester.tap(find.byType(PresenceMarker));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Details'));
      await tester.pump();

      expect(
        find.byType(PersonHeroFlight, skipOffstage: false),
        findsNothing,
      );
      expect(find.byType(PresenceMarker), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('dismissing the map sheet disarms its captured marker origin', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const _MapSheetFlightSource(),
        ),
      ),
    );

    await tester.tap(find.byType(PresenceMarker));
    await tester.pumpAndSettle();
    Navigator.of(tester.element(find.text('Details'))).pop();
    await tester.pumpAndSettle();
    await tester.pump(const Duration(milliseconds: 301));

    final sourceContext = tester.element(find.byType(PresenceMarker));
    const directPage = PersonDetailTransitionPage(
      child: PersonSharedElementScope(
        elements: {PersonSharedElement.marker},
        animateMarkerOrigin: true,
        child: Scaffold(
          body: Center(child: PresenceMarker(person: _person)),
        ),
      ),
    );
    unawaited(
      Navigator.of(sourceContext).push(directPage.createRoute(sourceContext)),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 80));

    expect(PersonMarkerTransition.isAnimating(_person.userId), isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'person detail transition progresses and reduced mode is instant',
    (
      tester,
    ) async {
      late BuildContext routeContext;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) {
              routeContext = context;
              return const SizedBox.shrink();
            },
          ),
        ),
      );

      final fullRoute =
          const PersonDetailTransitionPage(
                child: Text('Person detail'),
              ).createRoute(routeContext)
              as PageRoute<Object?>;
      final reducedRoute =
          const PersonDetailTransitionPage(
                reduced: true,
                child: Text('Reduced detail'),
              ).createRoute(routeContext)
              as PageRoute<Object?>;
      expect(fullRoute.transitionDuration, const Duration(milliseconds: 240));
      expect(
        fullRoute.reverseTransitionDuration,
        const Duration(milliseconds: 200),
      );
      expect(reducedRoute.transitionDuration, Duration.zero);
      expect(reducedRoute.reverseTransitionDuration, Duration.zero);

      unawaited(Navigator.of(routeContext).push(fullRoute));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 80));

      final scale = tester.widget<ScaleTransition>(
        find.ancestor(
          of: find.text('Person detail'),
          matching: find.byType(ScaleTransition),
        ),
      );
      expect(scale.scale.value, greaterThan(0.985));
      expect(scale.scale.value, lessThan(1));

      await tester.pumpAndSettle();
      expect(scale.scale.value, 1);
    },
  );
}
