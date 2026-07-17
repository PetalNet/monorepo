import 'package:flutter/foundation.dart';

enum EntityType {
  person,
  item,
  bridgeSource;

  static EntityType parse(String? raw) =>
      values.firstWhere((v) => v.name == raw, orElse: () => EntityType.person);
}

@immutable
class Entity {
  const Entity({
    required this.id,
    required this.type,
    required this.displayName,
    required this.ownerIsMe,
  });

  factory Entity.fromJson(Map<String, dynamic> json) => Entity(
    id: json['id'] as String,
    type: EntityType.parse(json['type'] as String?),
    displayName: json['display_name'] as String? ?? '',
    ownerIsMe: json['owner_is_me'] as bool? ?? false,
  );

  final String id;
  final EntityType type;
  final String displayName;
  final bool ownerIsMe;

  Map<String, dynamic> toJson() => {
    'id': id,
    'type': type.name,
    'display_name': displayName,
    'owner_is_me': ownerIsMe,
  };

  Entity copyWith({String? displayName}) => Entity(
    id: id,
    type: type,
    displayName: displayName ?? this.displayName,
    ownerIsMe: ownerIsMe,
  );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Entity &&
          other.id == id &&
          other.type == type &&
          other.displayName == displayName &&
          other.ownerIsMe == ownerIsMe;

  @override
  int get hashCode => Object.hash(id, type, displayName, ownerIsMe);
}

@immutable
sealed class Audience {
  const Audience();

  const factory Audience.group(String groupId) = GroupAudience;
  const factory Audience.individual(String userId) = IndividualAudience;

  static Audience? parseKey(String raw) {
    if (raw.startsWith('grp:')) return Audience.group(raw.substring(4));
    if (raw.startsWith('usr:')) return Audience.individual(raw.substring(4));
    return null;
  }

  String get key;
}

final class GroupAudience extends Audience {
  const GroupAudience(this.groupId);

  final String groupId;

  @override
  String get key => 'grp:$groupId';

  @override
  bool operator ==(Object other) =>
      identical(this, other) || other is GroupAudience && other.groupId == groupId;

  @override
  int get hashCode => Object.hash(runtimeType, groupId);
}

final class IndividualAudience extends Audience {
  const IndividualAudience(this.userId);

  final String userId;

  @override
  String get key => 'usr:$userId';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is IndividualAudience && other.userId == userId;

  @override
  int get hashCode => Object.hash(runtimeType, userId);
}

enum Fidelity {
  precise,
  fuzzed,
  off;

  static Fidelity parse(String? raw) =>
      values.firstWhere((v) => v.name == raw, orElse: () => Fidelity.precise);
}

const defaultFuzzRadiusM = 1000.0;

@immutable
class ShareSetting {
  const ShareSetting({
    required this.fidelity,
    this.fuzzRadiusM = defaultFuzzRadiusM,
    this.expiresAt,
    this.perAudienceDefault = false,
  });

  factory ShareSetting.fromJson(Map<String, dynamic> json) => ShareSetting(
    fidelity: Fidelity.parse(json['fidelity'] as String?),
    fuzzRadiusM:
        (json['fuzz_radius_m'] as num?)?.toDouble() ?? defaultFuzzRadiusM,
    expiresAt: json['expires_at'] == null
        ? null
        : DateTime.parse(json['expires_at'] as String).toUtc(),
    perAudienceDefault: json['per_audience_default'] as bool? ?? false,
  );

  static const initial = ShareSetting(
    fidelity: Fidelity.precise,
    perAudienceDefault: true,
  );

  final Fidelity fidelity;
  final double fuzzRadiusM;
  final DateTime? expiresAt;
  final bool perAudienceDefault;

  bool isActive(DateTime now) =>
      fidelity != Fidelity.off &&
      (expiresAt == null || now.isBefore(expiresAt!));

  Map<String, dynamic> toJson() => {
    'fidelity': fidelity.name,
    'fuzz_radius_m': fuzzRadiusM,
    if (expiresAt != null) 'expires_at': expiresAt!.toUtc().toIso8601String(),
    'per_audience_default': perAudienceDefault,
  };

  static const _unset = Object();

  ShareSetting copyWith({
    Fidelity? fidelity,
    double? fuzzRadiusM,
    Object? expiresAt = _unset,
    bool? perAudienceDefault,
  }) => ShareSetting(
    fidelity: fidelity ?? this.fidelity,
    fuzzRadiusM: fuzzRadiusM ?? this.fuzzRadiusM,
    expiresAt: identical(expiresAt, _unset)
        ? this.expiresAt
        : expiresAt as DateTime?,
    perAudienceDefault: perAudienceDefault ?? this.perAudienceDefault,
  );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ShareSetting &&
          other.fidelity == fidelity &&
          other.fuzzRadiusM == fuzzRadiusM &&
          other.expiresAt == expiresAt &&
          other.perAudienceDefault == perAudienceDefault;

  @override
  int get hashCode =>
      Object.hash(fidelity, fuzzRadiusM, expiresAt, perAudienceDefault);
}
