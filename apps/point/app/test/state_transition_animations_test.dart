import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/location/self_location_provider.dart';
import 'package:point_app/features/map/map_tiles.dart';
import 'package:point_app/features/map/presentation/map_screen.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/features/me/avatar_provider.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/presentation/people_screen.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/widgets/presence_dot.dart';

const _mara = Person(
  userId: 'mara@point.dev',
  displayName: 'Mara',
  presence: PresenceState.live,
  lat: 38.627,
  lon: -90.199,
);
const _parker = Person(
  userId: 'parker@point.dev',
  displayName: 'Parker',
  presence: PresenceState.live,
);

class _PeopleSource extends Notifier<List<Person>> {
  @override
  List<Person> build() => const [_mara];

  List<Person> get people => state;
  set people(List<Person> value) => state = value;
}

final _peopleSourceProvider = NotifierProvider<_PeopleSource, List<Person>>(
  _PeopleSource.new,
);

class _StaticPeople extends PeopleController {
  @override
  Future<List<Person>> build() async => const [_mara];
}

class _EmptyRequests extends RequestsController {
  @override
  Future<List<ShareRequest>> build() async => const [];
}

class _EmptyOutgoing extends OutgoingRequestsController {
  @override
  Future<List<OutgoingShareRequest>> build() async => const [];
}

class _EmptyLivePresence extends LivePresence {
  @override
  Map<String, PeerMarkerMotion> build() => const {};
}

class _HealthyRelay extends RelayHealthNotifier {
  @override
  RelayHealth build() => const RelayHealth(
    status: RelayHealthStatus.live,
    queueDepth: 0,
    locationBlocked: false,
  );
}

Widget _presenceHost({required PresenceState state, bool reduced = false}) =>
    MaterialApp(
      theme: AppTheme.dark(pureBlack: true),
      home: MediaQuery(
        data: MediaQueryData(disableAnimations: reduced),
        child: Scaffold(
          body: Center(child: PresenceDot(state: state)),
        ),
      ),
    );

Widget _peopleHost(ProviderContainer container, {bool reduced = false}) =>
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: AppTheme.dark(pureBlack: true),
        home: MediaQuery(
          data: MediaQueryData(disableAnimations: reduced),
          child: const PeopleScreen(),
        ),
      ),
    );

ProviderContainer _peopleContainer() => ProviderContainer(
  overrides: [
    peopleControllerProvider.overrideWith(_StaticPeople.new),
    peopleWithPresenceProvider.overrideWith(
      (ref) => ref.watch(_peopleSourceProvider),
    ),
    requestsControllerProvider.overrideWith(_EmptyRequests.new),
    outgoingRequestsControllerProvider.overrideWith(_EmptyOutgoing.new),
    outgoingTempsProvider.overrideWithValue(const {}),
    incomingTempsProvider.overrideWithValue(const {}),
    incomingTempPeopleProvider.overrideWithValue(const []),
    avatarProvider(
      _mara.userId,
    ).overrideWith((ref) async => null),
    avatarProvider(
      _parker.userId,
    ).overrideWith((ref) async => null),
  ],
);

ProviderContainer _mapContainer({bool tileFailure = false}) =>
    ProviderContainer(
      overrides: [
        peopleWithPresenceProvider.overrideWith(
          (ref) => ref.watch(_peopleSourceProvider),
        ),
        incomingTempPeopleProvider.overrideWithValue(const []),
        livePresenceProvider.overrideWith(_EmptyLivePresence.new),
        relayHealthProvider.overrideWith(_HealthyRelay.new),
        selfLocationProvider.overrideWith((ref) => const Stream.empty()),
        serverTileInfoProvider.overrideWith((ref) async {
          if (tileFailure) throw StateError('offline');
          return const ServerTileInfo();
        }),
        tileSourceProvider.overrideWithValue(null),
      ],
    );

double _rowOpacity(WidgetTester tester, String userId) {
  final row = find.byKey(ValueKey('person-$userId'));
  final transition = find.ancestor(
    of: row,
    matching: find.byType(FadeTransition),
  );
  return tester.widget<FadeTransition>(transition.first).opacity.value;
}

bool _rowIgnoresInput(WidgetTester tester, String userId) {
  final transition = find.ancestor(
    of: find.byKey(ValueKey('person-$userId')),
    matching: find.byType(IgnorePointer),
  );
  return tester.widget<IgnorePointer>(transition.first).ignoring;
}

double _markerOpacity(WidgetTester tester) {
  final transition = find.ancestor(
    of: find.byType(PresenceMarker),
    matching: find.byType(FadeTransition),
  );
  return tester.widget<FadeTransition>(transition.first).opacity.value;
}

void main() {
  FlutterSecureStorage.setMockInitialValues({});

  testWidgets('presence form crossfades live to stale before settling', (
    tester,
  ) async {
    await tester.pumpWidget(_presenceHost(state: PresenceState.live));
    await tester.pumpWidget(_presenceHost(state: PresenceState.stale));
    await tester.pump(const Duration(milliseconds: 91));

    expect(
      find.descendant(
        of: find.byType(PresenceDot),
        matching: find.byType(CustomPaint),
      ),
      findsNWidgets(2),
    );
    expect(find.bySemanticsLabel('Stale'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 90));
    expect(
      find.descendant(
        of: find.byType(PresenceDot),
        matching: find.byType(CustomPaint),
      ),
      findsOneWidget,
    );
  });

  testWidgets('failed map discovery never covers a cached person marker', (
    tester,
  ) async {
    final container = _mapContainer(tileFailure: true);
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const MapScreen(),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Map unavailable'), findsOneWidget);
    expect(find.byType(PresenceMarker), findsOneWidget);
  });

  testWidgets('reduced motion snaps presence form changes', (tester) async {
    await tester.pumpWidget(
      _presenceHost(state: PresenceState.live, reduced: true),
    );
    await tester.pumpWidget(
      _presenceHost(state: PresenceState.stale, reduced: true),
    );
    await tester.pump();

    expect(
      find.descendant(
        of: find.byType(PresenceDot),
        matching: find.byType(CustomPaint),
      ),
      findsOneWidget,
    );
  });

  testWidgets('accepted people insert and removed shares exit by keyed row', (
    tester,
  ) async {
    final container = _peopleContainer();
    addTearDown(container.dispose);
    await tester.pumpWidget(_peopleHost(container));
    await tester.pumpAndSettle();

    container.read(_peopleSourceProvider.notifier).people = const [
      _mara,
      _parker,
    ];
    await tester.pump();
    expect(
      find.byKey(const ValueKey('person-parker@point.dev')),
      findsOneWidget,
    );
    expect(_rowOpacity(tester, _parker.userId), 0);

    await tester.pump(const Duration(milliseconds: 90));
    expect(_rowOpacity(tester, _parker.userId), inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 90));
    expect(_rowOpacity(tester, _parker.userId), 1);

    container.read(_peopleSourceProvider.notifier).people = const [
      _parker,
      _mara,
    ];
    await tester.pump();
    expect(find.byKey(const ValueKey('person-mara@point.dev')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('person-parker@point.dev')),
      findsOneWidget,
    );

    container.read(_peopleSourceProvider.notifier).people = const [_parker];
    await tester.pump();
    expect(find.byKey(const ValueKey('person-mara@point.dev')), findsOneWidget);
    expect(_rowIgnoresInput(tester, _mara.userId), isTrue);
    await tester.pump(const Duration(milliseconds: 90));
    expect(_rowOpacity(tester, _mara.userId), inExclusiveRange(0, 1));

    container.read(_peopleSourceProvider.notifier).people = const [
      _mara,
      _parker,
    ];
    await tester.pump();
    expect(find.byKey(const ValueKey('person-mara@point.dev')), findsOneWidget);
    expect(_rowIgnoresInput(tester, _mara.userId), isFalse);
    await tester.pump(const Duration(milliseconds: 90));
    expect(_rowOpacity(tester, _mara.userId), 1);

    container.read(_peopleSourceProvider.notifier).people = const [_parker];
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 181));
    expect(find.byKey(const ValueKey('person-mara@point.dev')), findsNothing);
  });

  testWidgets('reduced motion applies people diffs in one frame', (
    tester,
  ) async {
    final container = _peopleContainer();
    addTearDown(container.dispose);
    await tester.pumpWidget(_peopleHost(container, reduced: true));
    await tester.pumpAndSettle();

    container.read(_peopleSourceProvider.notifier).people = const [_parker];
    await tester.pump();

    expect(find.byKey(const ValueKey('person-mara@point.dev')), findsNothing);
    expect(
      find.byKey(const ValueKey('person-parker@point.dev')),
      findsOneWidget,
    );
    expect(_rowOpacity(tester, _parker.userId), 1);
  });

  testWidgets('marker fades through stale form before removal', (tester) async {
    final container = _mapContainer();
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const MapScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(PresenceMarker), findsOneWidget);

    container.read(_peopleSourceProvider.notifier).people = const [];
    await tester.pump();
    expect(find.byType(PresenceMarker), findsOneWidget);
    expect(find.byKey(const ValueKey(PresenceState.stale)), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 90));
    expect(_markerOpacity(tester), inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 91));
    expect(find.byType(PresenceMarker), findsNothing);
  });

  testWidgets('coincident people collapse into one accessible cluster', (
    tester,
  ) async {
    final container = _mapContainer();
    addTearDown(container.dispose);
    container.read(_peopleSourceProvider.notifier).people = const [
      _mara,
      Person(
        userId: 'parker@point.dev',
        displayName: 'Parker',
        presence: PresenceState.stale,
        subtitle: 'Last place · Dark',
        lat: 38.627,
        lon: -90.199,
      ),
    ];
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const MapScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(PresenceMarker), findsNothing);
    expect(find.bySemanticsLabel('2 people here'), findsOneWidget);
    expect(find.text('Mara · now'), findsNothing);
    expect(find.textContaining('Ghosted'), findsNothing);
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    semantics.dispose();
  });

  testWidgets('nearby people separate after the cluster zoom action', (
    tester,
  ) async {
    final container = _mapContainer();
    addTearDown(container.dispose);
    container.read(_peopleSourceProvider.notifier).people = const [
      _mara,
      Person(
        userId: 'parker@point.dev',
        displayName: 'Parker',
        presence: PresenceState.live,
        lat: 38.627,
        lon: -90.198,
      ),
    ];
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const MapScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.bySemanticsLabel('2 people here'));
    await tester.pumpAndSettle();

    expect(find.bySemanticsLabel('2 people here'), findsNothing);
    expect(find.byType(PresenceMarker), findsNWidgets(2));
  });

  testWidgets('coincident cluster offers a people list at maximum zoom', (
    tester,
  ) async {
    final container = _mapContainer();
    addTearDown(container.dispose);
    container.read(_peopleSourceProvider.notifier).people = const [
      _mara,
      Person(
        userId: 'parker@point.dev',
        displayName: 'Parker',
        presence: PresenceState.live,
        lat: 38.627,
        lon: -90.199,
      ),
    ];
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const MapScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    for (var i = 0; i < 3; i++) {
      await tester.tap(find.bySemanticsLabel('2 people here'));
      await tester.pumpAndSettle();
    }

    expect(find.text('People here'), findsOneWidget);
    expect(find.text('Mara'), findsOneWidget);
    expect(find.text('Parker'), findsOneWidget);
  });

  testWidgets(
    'fix past the old five-minute TTL stays mapped with dark last-known status',
    (tester) async {
      final container = _mapContainer();
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: AppTheme.dark(pureBlack: true),
            home: const MapScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(PresenceMarker), findsOneWidget);
      expect(find.byKey(const ValueKey(PresenceState.live)), findsOneWidget);

      final now = DateTime(2026, 7, 13, 12);
      final darkAt = now.subtract(const Duration(minutes: 16));
      final stale = mergePresence(
        _mara,
        PeerFix(
          userId: _mara.userId,
          data: {
            'lat': _mara.lat,
            'lon': _mara.lon,
            'accuracy': 24,
            'timestamp': darkAt.millisecondsSinceEpoch,
          },
        ),
        now: now,
      );
      container.read(_peopleSourceProvider.notifier).people = [stale];
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 181));

      expect(find.byType(PresenceMarker), findsOneWidget);
      expect(find.byKey(const ValueKey(PresenceState.stale)), findsOneWidget);
      final marker = tester.widget<PresenceMarker>(find.byType(PresenceMarker));
      expect(
        find.text(
          'Mara · dark since '
          '${clockHm(darkAt.millisecondsSinceEpoch, format: marker.timeFormat)}',
        ),
        findsOneWidget,
      );
      expect(marker.person.lat, _mara.lat);
      expect(marker.person.lon, _mara.lon);
    },
  );

  testWidgets('ghost intent is normalized to the neutral dark marker', (
    tester,
  ) async {
    final container = _mapContainer();
    addTearDown(container.dispose);
    container.read(_peopleSourceProvider.notifier).people = const [
      Person(
        userId: 'mara@point.dev',
        displayName: 'Mara',
        presence: PresenceState.ghosted,
        subtitle: 'Ghosted',
        lat: 38.627,
        lon: -90.199,
      ),
    ];
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const MapScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(PresenceMarker), findsOneWidget);
    expect(find.byKey(const ValueKey(PresenceState.stale)), findsOneWidget);
    expect(find.byKey(const ValueKey(PresenceState.ghosted)), findsNothing);
    expect(find.text('Mara · dark'), findsOneWidget);
    expect(
      tester.getSemantics(find.byType(PresenceMarker)).label,
      'Mara, Stale, dark',
    );
    semantics.dispose();
  });

  testWidgets('reduced motion removes markers without an exit timeline', (
    tester,
  ) async {
    final container = _mapContainer();
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: AppTheme.dark(pureBlack: true),
          home: const MediaQuery(
            data: MediaQueryData(disableAnimations: true),
            child: MapScreen(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    container.read(_peopleSourceProvider.notifier).people = const [];
    await tester.pump();
    expect(find.byType(PresenceMarker), findsNothing);
  });

  testWidgets('enabling reduced motion safely completes an active row exit', (
    tester,
  ) async {
    final container = _peopleContainer();
    addTearDown(container.dispose);
    container.read(_peopleSourceProvider.notifier).people = const [
      _mara,
      _parker,
    ];
    await tester.pumpWidget(_peopleHost(container));
    await tester.pumpAndSettle();

    container.read(_peopleSourceProvider.notifier).people = const [_parker];
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 90));
    await tester.pumpWidget(_peopleHost(container, reduced: true));
    await tester.pump();

    expect(find.byKey(const ValueKey('person-mara@point.dev')), findsNothing);
  });

  testWidgets(
    'enabling reduced motion safely completes an active marker exit',
    (
      tester,
    ) async {
      final container = _mapContainer();
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: AppTheme.dark(pureBlack: true),
            home: const MapScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      container.read(_peopleSourceProvider.notifier).people = const [];
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 90));
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: AppTheme.dark(pureBlack: true),
            home: const MediaQuery(
              data: MediaQueryData(disableAnimations: true),
              child: MapScreen(),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.byType(PresenceMarker), findsNothing);
    },
  );
}
