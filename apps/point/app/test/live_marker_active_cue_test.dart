import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/map/presentation/presence_marker.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/widgets/presence_dot.dart';

Widget _host(Widget child, {bool reducedMotion = false}) => MaterialApp(
  theme: AppTheme.dark(pureBlack: true),
  home: ReducedMotionScope(
    reduced: reducedMotion,
    child: Scaffold(body: Center(child: child)),
  ),
);

ScaleTransition _scale(WidgetTester tester) => tester.widget<ScaleTransition>(
  find.descendant(
    of: find.byType(PresenceDot),
    matching: find.byType(ScaleTransition),
  ),
);

class _FixedLivePresence extends LivePresence {
  _FixedLivePresence(this.initial);

  final PeerMarkerMotion initial;

  @override
  Map<String, PeerMarkerMotion> build() => {'morgan@point.test': initial};

  void emit(PeerMarkerMotion motion) {
    state = {'morgan@point.test': motion};
  }
}

void main() {
  testWidgets('live marker acknowledges a new fix once, then settles', (
    tester,
  ) async {
    final person = ValueNotifier(
      const Person(
        userId: 'morgan@point.test',
        displayName: 'Morgan Lee',
        presence: PresenceState.live,
        subtitle: 'Sharing · now',
        lat: 38.6,
        lon: -90.2,
      ),
    );
    addTearDown(person.dispose);

    await tester.pumpWidget(
      _host(
        ValueListenableBuilder(
          valueListenable: person,
          builder: (_, value, _) => PresenceMarker(person: value),
        ),
      ),
    );
    expect(_scale(tester).scale.value, 1);

    person.value = const Person(
      userId: 'morgan@point.test',
      displayName: 'Morgan Lee',
      presence: PresenceState.live,
      subtitle: 'Sharing · now',
      lat: 38.6001,
      lon: -90.2001,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 40));

    expect(_scale(tester).scale.value, greaterThan(1));

    await tester.pump(const Duration(milliseconds: 140));
    expect(_scale(tester).scale.value, 1);
  });

  testWidgets('stationary accepted fix uses its newer timestamp as the cue', (
    tester,
  ) async {
    const firstTimestamp = 1752000000000;
    const secondTimestamp = firstTimestamp + 1000;
    final first = PeerMarkerMotion.initial(
      const PeerFix(
        userId: 'morgan@point.test',
        data: {
          'lat': 38.6,
          'lon': -90.2,
          'timestamp': firstTimestamp,
        },
      ),
    );
    final second = first.advance(
      const PeerFix(
        userId: 'morgan@point.test',
        data: {
          'lat': 38.6,
          'lon': -90.2,
          'timestamp': secondTimestamp,
        },
      ),
      now: DateTime.fromMillisecondsSinceEpoch(secondTimestamp),
    );
    late _FixedLivePresence livePresence;
    late StateSetter rebuildMarker;
    final person = Person(
      userId: 'morgan@point.test',
      displayName: 'Morgan Lee',
      presence: PresenceState.live,
      subtitle: 'Sharing · now',
      lat: 38.6,
      lon: -90.2,
      profileVersion: DateTime.fromMillisecondsSinceEpoch(1),
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          livePresenceProvider.overrideWith(
            () => livePresence = _FixedLivePresence(first),
          ),
        ],
        child: _host(
          StatefulBuilder(
            builder: (_, setState) {
              rebuildMarker = setState;
              return PresenceMarker(person: person);
            },
          ),
        ),
      ),
    );

    livePresence.emit(second);
    rebuildMarker(() {});
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 40));

    expect(_scale(tester).scale.value, greaterThan(1));
  });

  testWidgets('marker identity replacement does not inherit an active cue', (
    tester,
  ) async {
    final person = ValueNotifier(
      const Person(
        userId: 'morgan@point.test',
        displayName: 'Morgan Lee',
        presence: PresenceState.live,
        lat: 38.6,
        lon: -90.2,
      ),
    );
    addTearDown(person.dispose);
    await tester.pumpWidget(
      _host(
        ValueListenableBuilder(
          valueListenable: person,
          builder: (_, value, _) => PresenceMarker(person: value),
        ),
      ),
    );

    person.value = const Person(
      userId: 'parker@point.test',
      displayName: 'Parker Jones',
      presence: PresenceState.live,
      lat: 38.61,
      lon: -90.21,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 40));

    expect(_scale(tester).scale.value, 1);
  });

  testWidgets('non-live updates never animate and stop an active cue', (
    tester,
  ) async {
    var state = PresenceState.live;
    var token = 1;
    late StateSetter update;
    await tester.pumpWidget(
      _host(
        StatefulBuilder(
          builder: (_, setState) {
            update = setState;
            return PresenceDot(state: state, updateToken: token);
          },
        ),
      ),
    );

    update(() => token = 2);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 40));
    expect(_scale(tester).scale.value, greaterThan(1));

    update(() {
      state = PresenceState.stale;
      token = 3;
    });
    await tester.pump();
    expect(_scale(tester).scale.value, 1);
  });

  testWidgets('reduced motion acknowledges updates without animation', (
    tester,
  ) async {
    var token = 1;
    late StateSetter update;
    await tester.pumpWidget(
      _host(
        StatefulBuilder(
          builder: (_, setState) {
            update = setState;
            return PresenceDot(state: PresenceState.live, updateToken: token);
          },
        ),
        reducedMotion: true,
      ),
    );

    update(() => token = 2);
    await tester.pump();

    expect(_scale(tester).scale.value, 1);
  });
}
