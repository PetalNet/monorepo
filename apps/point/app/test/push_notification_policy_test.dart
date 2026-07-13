import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/push/push_service.dart';
import 'package:point_app/features/relay/domain/realtime_sync_models.dart';

void main() {
  const baseline = PushSnapshot(
    people: {'@friend:point.test'},
    incoming: {'request-old'},
  );

  test('a new incoming request is announced exactly once', () {
    const changed = PushSnapshot(
      people: {'@friend:point.test'},
      incoming: {'request-old', 'request-new'},
    );

    final first = PushNotificationPolicy.notices(baseline, changed);
    final duplicate = PushNotificationPolicy.notices(changed, changed);

    expect(first, hasLength(1));
    expect(first.single.kind, PushNoticeKind.incomingRequest);
    expect(first.single.payload, 'requests');
    expect(first.single.badge, 2);
    expect(duplicate, isEmpty);
  });

  test('first healthy wake establishes a silent persisted baseline', () {
    const current = PushSnapshot(
      people: {'@friend:point.test'},
      incoming: {'already-there'},
    );

    final decision = PushWakePolicy.decide(
      previous: null,
      current: current,
    );

    expect(decision.nextSnapshot, same(current));
    expect(decision.notices, isEmpty);
  });

  test('known transition emits once and persisted state dedupes next wake', () {
    const changed = PushSnapshot(
      people: {'@friend:point.test'},
      incoming: {'request-old', 'request-new'},
    );

    final first = PushWakePolicy.decide(
      previous: baseline,
      current: changed,
    );
    final duplicate = PushWakePolicy.decide(
      previous: first.nextSnapshot,
      current: changed,
    );

    expect(first.nextSnapshot, same(changed));
    expect(first.notices, hasLength(1));
    expect(duplicate.notices, isEmpty);
  });

  test('new person produces direction-neutral sharing-started notice', () {
    const changed = PushSnapshot(
      people: {'@friend:point.test', '@pending:point.test'},
      incoming: {'request-old'},
    );

    final notices = PushNotificationPolicy.notices(baseline, changed);

    expect(notices, hasLength(1));
    expect(notices.single.kind, PushNoticeKind.sharingStarted);
    expect(notices.single.payload, 'person:%40pending%3Apoint.test');
  });

  test('declined or cancelled outgoing request is not called accepted', () {
    const changed = PushSnapshot(
      people: {'@friend:point.test'},
      incoming: {'request-old'},
    );

    expect(PushNotificationPolicy.notices(baseline, changed), isEmpty);
  });

  test('removals and unchanged state do not produce notifications', () {
    const changed = PushSnapshot(
      people: {},
      incoming: {},
    );

    expect(PushNotificationPolicy.notices(baseline, changed), isEmpty);
    expect(PushNotificationPolicy.notices(baseline, baseline), isEmpty);
  });

  test('persisted stale local changes are excluded by authoritative diff', () {
    const changed = PushSnapshot(
      people: {'@friend:point.test', '@local-accept:point.test'},
      incoming: {'request-old', 'request-new'},
    );

    final decision = PushWakePolicy.decide(
      previous: baseline,
      current: changed,
      incomingAdded: {'request-new'},
      sharesAdded: const {},
    );

    expect(decision.notices, hasLength(1));
    expect(decision.notices.single.kind, PushNoticeKind.incomingRequest);
  });

  test('only external sync reasons announce; every reason may persist', () {
    expect(PushSyncPolicy.announces(RealtimeSyncReason.pushWake), isTrue);
    expect(PushSyncPolicy.announces(RealtimeSyncReason.shareRequest), isTrue);
    expect(PushSyncPolicy.announces(RealtimeSyncReason.relayEvent), isTrue);
    expect(PushSyncPolicy.announces(RealtimeSyncReason.appResumed), isFalse);
    expect(PushSyncPolicy.announces(RealtimeSyncReason.manualRefresh), isFalse);
  });

  test('failed external sync carries announcement intent through retry', () {
    final state = PushSyncAnnouncementState();

    expect(
      state.observe(RealtimeSyncReason.pushWake, healthy: false),
      isFalse,
    );
    expect(state.observe(RealtimeSyncReason.retry, healthy: true), isTrue);
    expect(state.observe(RealtimeSyncReason.retry, healthy: true), isFalse);
  });

  test('snapshot round-trip keeps only stable identifiers', () {
    final encoded = jsonEncode(baseline.toJson());
    final decoded = PushSnapshot.fromJson(
      jsonDecode(encoded) as Map<String, dynamic>,
    );

    expect(decoded.people, baseline.people);
    expect(decoded.incoming, baseline.incoming);
    expect(encoded, isNot(contains('display')));
    expect(encoded, isNot(contains('location')));
  });

  test('notification ids are stable per transition and event', () {
    const first = PushNotice(
      kind: PushNoticeKind.incomingRequest,
      eventId: 'same-event',
      destination: RequestsPushDestination(),
      badge: 1,
    );
    const duplicate = PushNotice(
      kind: PushNoticeKind.incomingRequest,
      eventId: 'same-event',
      destination: RequestsPushDestination(),
      badge: 2,
    );
    const otherKind = PushNotice(
      kind: PushNoticeKind.sharingStarted,
      eventId: 'same-event',
      destination: PersonPushDestination('test'),
      badge: 0,
    );

    expect(first.notificationId, duplicate.notificationId);
    expect(first.notificationId, isNot(otherKind.notificationId));
  });

  test('notification destinations round-trip through platform payloads', () {
    final requests = PushDestination.fromPayload('requests');
    final person = PushDestination.fromPayload(
      'person:%40friend%3Apoint.test',
    );

    expect(requests, isA<RequestsPushDestination>());
    expect(person, isA<PersonPushDestination>());
    expect((person! as PersonPushDestination).userId, '@friend:point.test');
    expect(person.payload, 'person:%40friend%3Apoint.test');
    expect(PushDestination.fromPayload(null), isNull);
    expect(PushDestination.fromPayload('unknown'), isNull);
  });
}
