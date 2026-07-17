import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/sharing/domain/share_models.dart';

@immutable
class ShareEdgeState {
  const ShareEdgeState({
    this.edges = const {},
    this.audienceDefaults = const {},
  });

  factory ShareEdgeState.fromJson(Map<String, dynamic> json) => ShareEdgeState(
    edges: {
      for (final entityEntry
          in (json['edges'] as Map<String, dynamic>? ?? const {}).entries)
        entityEntry.key: Map.unmodifiable({
          for (final audienceEntry
              in (entityEntry.value as Map<String, dynamic>).entries)
            audienceEntry.key: ShareSetting.fromJson(
              audienceEntry.value as Map<String, dynamic>,
            ),
        }),
    },
    audienceDefaults: {
      for (final entry
          in (json['audience_defaults'] as Map<String, dynamic>? ?? const {})
              .entries)
        entry.key: ShareSetting.fromJson(entry.value as Map<String, dynamic>),
    },
  );

  final Map<String, Map<String, ShareSetting>> edges;
  final Map<String, ShareSetting> audienceDefaults;

  Map<String, dynamic> toJson() => {
    'edges': {
      for (final entityEntry in edges.entries)
        if (entityEntry.value.isNotEmpty)
          entityEntry.key: {
            for (final audienceEntry in entityEntry.value.entries)
              audienceEntry.key: audienceEntry.value.toJson(),
          },
    },
    'audience_defaults': {
      for (final entry in audienceDefaults.entries)
        entry.key: entry.value.toJson(),
    },
  };

  ShareSetting? explicitEdge(String entityId, Audience audience) =>
      edges[entityId]?[audience.key];

  ShareSetting effectiveSetting(String entityId, Audience audience) {
    final explicit = explicitEdge(entityId, audience);
    if (explicit != null) return explicit;
    final audienceDefault = audienceDefaults[audience.key];
    if (audienceDefault != null) {
      return audienceDefault.copyWith(perAudienceDefault: true);
    }
    return ShareSetting.initial;
  }
}

class ShareEdgeStore extends Notifier<ShareEdgeState> {
  ShareEdgeStore([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  static const _key = 'point.share_edges';

  final Completer<void> _loaded = Completer<void>();

  Future<ShareEdgeState> get loaded async {
    await _loaded.future;
    return state;
  }

  @override
  ShareEdgeState build() {
    unawaited(_load());
    return const ShareEdgeState();
  }

  Future<void> _load() async {
    try {
      final raw = await _storage.read(key: _key);
      if (raw != null) {
        state = ShareEdgeState.fromJson(
          jsonDecode(raw) as Map<String, dynamic>,
        );
      }
    } on Object {
      await _storage.delete(key: _key);
    } finally {
      if (!_loaded.isCompleted) _loaded.complete();
    }
  }

  Future<void> _writeTail = Future<void>.value();

  Future<void> _update(ShareEdgeState Function(ShareEdgeState) change) {
    final task = _writeTail.then((_) async {
      await _loaded.future;
      state = change(state);
      await _storage.write(key: _key, value: jsonEncode(state.toJson()));
    });
    _writeTail = task.then((_) {}, onError: (Object _) {});
    return task;
  }

  Future<void> setEdge(
    String entityId,
    Audience audience,
    ShareSetting setting,
  ) => _update(
    (s) => ShareEdgeState(
      edges: {
        ...s.edges,
        entityId: Map.unmodifiable({
          ...?s.edges[entityId],
          audience.key: setting.copyWith(perAudienceDefault: false),
        }),
      },
      audienceDefaults: s.audienceDefaults,
    ),
  );

  Future<void> removeEdge(String entityId, Audience audience) => _update((s) {
    final forEntity = s.edges[entityId];
    if (forEntity == null || !forEntity.containsKey(audience.key)) return s;
    final remaining = {...forEntity}..remove(audience.key);
    final edges = {...s.edges};
    if (remaining.isEmpty) {
      edges.remove(entityId);
    } else {
      edges[entityId] = Map.unmodifiable(remaining);
    }
    return ShareEdgeState(edges: edges, audienceDefaults: s.audienceDefaults);
  });

  Future<void> setAudienceDefault(Audience audience, ShareSetting setting) =>
      _update(
        (s) => ShareEdgeState(
          edges: s.edges,
          audienceDefaults: {
            ...s.audienceDefaults,
            audience.key: setting.copyWith(perAudienceDefault: true),
          },
        ),
      );
}

final shareEdgeStoreProvider = NotifierProvider<ShareEdgeStore, ShareEdgeState>(
  ShareEdgeStore.new,
);
