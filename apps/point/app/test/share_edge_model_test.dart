import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/sharing/data/entity_registry.dart';
import 'package:point_app/features/sharing/data/share_edge_store.dart';
import 'package:point_app/features/sharing/domain/share_models.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('domain models', () {
    test('entity json roundtrip preserves every field', () {
      const entity = Entity(
        id: 'ent-1',
        type: EntityType.person,
        displayName: 'Janet',
        ownerIsMe: true,
      );
      expect(Entity.fromJson(entity.toJson()), entity);
    });

    test('unknown entity type parses to person, gated types survive', () {
      expect(EntityType.parse('hovercraft'), EntityType.person);
      expect(EntityType.parse('bridgeSource'), EntityType.bridgeSource);
      expect(EntityType.parse('item'), EntityType.item);
    });

    test('audience keys are distinct per kind and parse back', () {
      const group = Audience.group('g-1');
      const person = Audience.individual('bob@point.dev');
      expect(group.key, 'grp:g-1');
      expect(person.key, 'usr:bob@point.dev');
      expect(Audience.parseKey(group.key), group);
      expect(Audience.parseKey(person.key), person);
      expect(Audience.parseKey('zone:downtown'), isNull);
      expect(
        const Audience.group('x').key == const Audience.individual('x').key,
        isFalse,
      );
    });

    test('share setting json roundtrip with and without expiry', () {
      final timed = ShareSetting(
        fidelity: Fidelity.fuzzed,
        fuzzRadiusM: 300,
        expiresAt: DateTime.utc(2026, 7, 17, 23, 59),
      );
      expect(ShareSetting.fromJson(timed.toJson()), timed);
      const indefinite = ShareSetting(fidelity: Fidelity.off);
      expect(ShareSetting.fromJson(indefinite.toJson()), indefinite);
      expect(indefinite.expiresAt, isNull);
    });

    test('fidelity defaults and fuzz radius default follow the spec', () {
      expect(ShareSetting.initial.fidelity, Fidelity.precise);
      expect(ShareSetting.initial.perAudienceDefault, isTrue);
      expect(const ShareSetting(fidelity: Fidelity.fuzzed).fuzzRadiusM, 1000.0);
      expect(Fidelity.parse('nonsense'), Fidelity.precise);
    });

    test('isActive enforces off and expiry semantics', () {
      final now = DateTime.utc(2026, 7, 17, 12);
      const precise = ShareSetting(fidelity: Fidelity.precise);
      expect(precise.isActive(now), isTrue);
      expect(const ShareSetting(fidelity: Fidelity.off).isActive(now), isFalse);
      final expired = ShareSetting(
        fidelity: Fidelity.fuzzed,
        expiresAt: now.subtract(const Duration(minutes: 1)),
      );
      expect(expired.isActive(now), isFalse);
      final live = ShareSetting(
        fidelity: Fidelity.fuzzed,
        expiresAt: now.add(const Duration(hours: 1)),
      );
      expect(live.isActive(now), isTrue);
    });

    test('copyWith can clear expiry without touching other fields', () {
      final timed = ShareSetting(
        fidelity: Fidelity.fuzzed,
        fuzzRadiusM: 5000,
        expiresAt: DateTime.utc(2026, 7, 18),
      );
      final cleared = timed.copyWith(expiresAt: null);
      expect(cleared.expiresAt, isNull);
      expect(cleared.fidelity, Fidelity.fuzzed);
      expect(cleared.fuzzRadiusM, 5000.0);
      expect(timed.copyWith().expiresAt, timed.expiresAt);
    });
  });

  group('entity registry', () {
    setUp(() => FlutterSecureStorage.setMockInitialValues({}));

    test('upsert, replace and remove persist across a restart', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final registry = container.read(entityRegistryProvider.notifier);
      await registry.loaded;
      const self = Entity(
        id: 'self',
        type: EntityType.person,
        displayName: 'Me',
        ownerIsMe: true,
      );
      await registry.upsert(self);
      await registry.upsert(
        const Entity(
          id: 'tag-1',
          type: EntityType.item,
          displayName: 'Backpack',
          ownerIsMe: true,
        ),
      );
      await registry.upsert(self.copyWith(displayName: 'Janet'));
      expect(container.read(entityRegistryProvider).length, 2);
      expect(registry.byId('self')?.displayName, 'Janet');

      await registry.remove('tag-1');

      final restarted = ProviderContainer();
      addTearDown(restarted.dispose);
      final reloaded = await restarted
          .read(entityRegistryProvider.notifier)
          .loaded;
      expect(reloaded, [self.copyWith(displayName: 'Janet')]);
    });

    test('a corrupt blob resets to empty instead of wedging', () async {
      FlutterSecureStorage.setMockInitialValues({
        'point.entities': 'not-json',
      });
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final entities = await container
          .read(entityRegistryProvider.notifier)
          .loaded;
      expect(entities, isEmpty);
    });
  });

  group('share edge store', () {
    setUp(() => FlutterSecureStorage.setMockInitialValues({}));

    test('explicit edge wins, audience default fills, initial backstops',
        () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final store = container.read(shareEdgeStoreProvider.notifier);
      await store.loaded;
      const partner = Audience.individual('partner@point.dev');
      const friends = Audience.group('g-friends');
      const work = Audience.group('g-work');

      await store.setEdge(
        'self',
        friends,
        const ShareSetting(fidelity: Fidelity.fuzzed),
      );
      await store.setAudienceDefault(
        work,
        const ShareSetting(fidelity: Fidelity.off),
      );

      final s = container.read(shareEdgeStoreProvider);
      expect(s.effectiveSetting('self', friends).fidelity, Fidelity.fuzzed);
      expect(s.effectiveSetting('self', friends).perAudienceDefault, isFalse);
      expect(s.effectiveSetting('self', work).fidelity, Fidelity.off);
      expect(s.effectiveSetting('self', work).perAudienceDefault, isTrue);
      expect(s.effectiveSetting('self', partner), ShareSetting.initial);
      expect(s.explicitEdge('self', partner), isNull);
    });

    test('the same entity holds different fidelity per audience at once',
        () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final store = container.read(shareEdgeStoreProvider.notifier);
      await store.loaded;
      const partner = Audience.individual('partner@point.dev');
      const friends = Audience.group('g-friends');
      const work = Audience.group('g-work');
      await store.setEdge(
        'self',
        partner,
        const ShareSetting(fidelity: Fidelity.precise),
      );
      await store.setEdge(
        'self',
        friends,
        const ShareSetting(fidelity: Fidelity.fuzzed),
      );
      await store.setEdge(
        'self',
        work,
        const ShareSetting(fidelity: Fidelity.off),
      );
      final s = container.read(shareEdgeStoreProvider);
      expect(s.effectiveSetting('self', partner).fidelity, Fidelity.precise);
      expect(s.effectiveSetting('self', friends).fidelity, Fidelity.fuzzed);
      expect(s.effectiveSetting('self', work).fidelity, Fidelity.off);
    });

    test('edges and defaults persist across a restart', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final store = container.read(shareEdgeStoreProvider.notifier);
      await store.loaded;
      const friends = Audience.group('g-friends');
      final expiry = DateTime.utc(2026, 7, 17, 23, 59);
      await store.setEdge(
        'self',
        friends,
        ShareSetting(
          fidelity: Fidelity.fuzzed,
          fuzzRadiusM: 300,
          expiresAt: expiry,
        ),
      );
      await store.setAudienceDefault(
        friends,
        const ShareSetting(fidelity: Fidelity.fuzzed),
      );

      final restarted = ProviderContainer();
      addTearDown(restarted.dispose);
      final reloaded = await restarted
          .read(shareEdgeStoreProvider.notifier)
          .loaded;
      final edge = reloaded.explicitEdge('self', friends);
      expect(edge?.fidelity, Fidelity.fuzzed);
      expect(edge?.fuzzRadiusM, 300.0);
      expect(edge?.expiresAt, expiry);
      expect(
        reloaded.effectiveSetting('other', friends).fidelity,
        Fidelity.fuzzed,
      );
      expect(
        reloaded.effectiveSetting('other', friends).perAudienceDefault,
        isTrue,
      );
    });

    test('removeEdge falls back to the audience default', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final store = container.read(shareEdgeStoreProvider.notifier);
      await store.loaded;
      const friends = Audience.group('g-friends');
      await store.setAudienceDefault(
        friends,
        const ShareSetting(fidelity: Fidelity.fuzzed),
      );
      await store.setEdge(
        'self',
        friends,
        const ShareSetting(fidelity: Fidelity.precise),
      );
      expect(
        container
            .read(shareEdgeStoreProvider)
            .effectiveSetting('self', friends)
            .fidelity,
        Fidelity.precise,
      );
      await store.removeEdge('self', friends);
      final s = container.read(shareEdgeStoreProvider);
      expect(s.explicitEdge('self', friends), isNull);
      expect(s.effectiveSetting('self', friends).fidelity, Fidelity.fuzzed);
      expect(s.edges.containsKey('self'), isFalse);
    });

    test('a corrupt blob resets to empty state', () async {
      FlutterSecureStorage.setMockInitialValues({
        'point.share_edges': '{broken',
      });
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final reloaded = await container
          .read(shareEdgeStoreProvider.notifier)
          .loaded;
      expect(reloaded.edges, isEmpty);
      expect(reloaded.audienceDefaults, isEmpty);
    });

    test('persisted json shape is stable and snake_cased', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final store = container.read(shareEdgeStoreProvider.notifier);
      await store.loaded;
      await store.setEdge(
        'self',
        const Audience.group('g-1'),
        const ShareSetting(fidelity: Fidelity.fuzzed, fuzzRadiusM: 5000),
      );
      const storage = FlutterSecureStorage();
      final raw = await storage.read(key: 'point.share_edges');
      final decoded = jsonDecode(raw!) as Map<String, dynamic>;
      final edge =
          ((decoded['edges'] as Map<String, dynamic>)['self']
                  as Map<String, dynamic>)['grp:g-1']
              as Map<String, dynamic>;
      expect(edge['fidelity'], 'fuzzed');
      expect(edge['fuzz_radius_m'], 5000.0);
      expect(edge['per_audience_default'], false);
    });
  });
}
