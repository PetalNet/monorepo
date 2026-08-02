import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/sharing/domain/share_models.dart';

class EntityRegistry extends Notifier<List<Entity>> {
  EntityRegistry([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  static const _key = 'point.entities';

  final Completer<void> _loaded = Completer<void>();

  Future<List<Entity>> get loaded async {
    await _loaded.future;
    return state;
  }

  @override
  List<Entity> build() {
    unawaited(_load());
    return const [];
  }

  Future<void> _load() async {
    try {
      final raw = await _storage.read(key: _key);
      if (raw != null) {
        state = [
          for (final item in jsonDecode(raw) as List<dynamic>)
            Entity.fromJson(item as Map<String, dynamic>),
        ];
      }
    } on Object {
      await _storage.delete(key: _key);
    } finally {
      if (!_loaded.isCompleted) _loaded.complete();
    }
  }

  Future<void> _writeTail = Future<void>.value();

  Future<void> _update(List<Entity> Function(List<Entity>) change) {
    final task = _writeTail.then((_) async {
      await _loaded.future;
      state = change(state);
      await _storage.write(
        key: _key,
        value: jsonEncode([for (final e in state) e.toJson()]),
      );
    });
    _writeTail = task.then((_) {}, onError: (Object _) {});
    return task;
  }

  Future<void> upsert(Entity entity) => _update(
    (entities) => [
      for (final e in entities)
        if (e.id != entity.id) e,
      entity,
    ],
  );

  Future<void> remove(String entityId) =>
      _update((entities) => [
        for (final e in entities)
          if (e.id != entityId) e,
      ]);

  Entity? byId(String entityId) {
    for (final e in state) {
      if (e.id == entityId) return e;
    }
    return null;
  }
}

final entityRegistryProvider = NotifierProvider<EntityRegistry, List<Entity>>(
  EntityRegistry.new,
);
