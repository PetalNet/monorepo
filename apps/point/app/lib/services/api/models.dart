import 'package:point_app/theme/presence_tokens.dart';

/// A signed-in session: the server JWT + the identity it authenticates.
class Session {
  const Session({
    required this.token,
    required this.userId,
    required this.displayName,
    required this.isAdmin,
  });

  factory Session.fromJson(Map<String, dynamic> json) => Session(
    token: json['token'] as String,
    userId: json['user_id'] as String,
    displayName: json['display_name'] as String? ?? json['user_id'] as String,
    isAdmin: json['is_admin'] as bool? ?? false,
  );

  final String token;
  final String userId;
  final String displayName;
  final bool isAdmin;

  /// The bare local name (before `@domain`).
  String get handle => userId.split('@').first;

  Session copyWith({String? displayName}) => Session(
    token: token,
    userId: userId,
    displayName: displayName ?? this.displayName,
    isAdmin: isAdmin,
  );
}

/// A person the signed-in user shares with (People + map).
class Person {
  const Person({
    required this.userId,
    required this.displayName,
    required this.presence,
    this.subtitle = '',
    this.distanceLabel,
    this.lat,
    this.lon,
  });

  final String userId;
  final String displayName;
  final PresenceState presence;

  /// Mono-rendered status line, e.g. `0.4 mi · moving` or `Last seen 2h ago`.
  final String subtitle;
  final String? distanceLabel;
  final double? lat;
  final double? lon;

  bool get hasLocation => lat != null && lon != null;
}

/// A pending incoming share request.
class ShareRequest {
  const ShareRequest({
    required this.id,
    required this.fromUserId,
    required this.fromDisplayName,
  });

  factory ShareRequest.fromJson(Map<String, dynamic> json) => ShareRequest(
    id: json['id'] as String,
    fromUserId: json['from_user_id'] as String,
    // The server serializes the requester's name as `from_display_name`.
    fromDisplayName:
        json['from_display_name'] as String? ??
        json['display_name'] as String? ??
        (json['from_user_id'] as String).split('@').first,
  );

  final String id;
  final String fromUserId;
  final String fromDisplayName;

  /// The bare local name (before `@domain`).
  String get fromHandle => fromUserId.split('@').first;
}

/// A temporary, one-way live-location share: `fromUserId` pushes their location
/// to `toUserId` until [expiresAt], then it auto-stops. Direction is the whole
/// point — the recipient sees the sharer, not vice-versa.
class TempShare {
  const TempShare({
    required this.id,
    required this.fromUserId,
    required this.toUserId,
    required this.expiresAt,
  });

  factory TempShare.fromJson(Map<String, dynamic> json) => TempShare(
    id: json['id'] as String,
    fromUserId: json['from_user_id'] as String,
    toUserId: json['to_user_id'] as String,
    expiresAt: DateTime.parse(json['expires_at'] as String),
  );

  final String id;
  final String fromUserId;
  final String toUserId;
  final DateTime expiresAt;
}

/// The signed-in user's own ghost/broadcast state: the global kill-switch plus
/// the per-person hide set (user ids I'm hidden from).
class GhostState {
  const GhostState({required this.active, this.hiddenFrom = const {}});

  factory GhostState.fromJson(Map<String, dynamic> json) => GhostState(
    active: json['active'] as bool? ?? false,
    hiddenFrom: {
      for (final t in (json['targets'] as List<dynamic>? ?? const []))
        t as String,
    },
  );

  /// Ghost ON = not sharing with anyone (dark). Ghost OFF = broadcasting.
  final bool active;

  /// User ids I've individually gone dark to (per-person hide).
  final Set<String> hiddenFrom;

  bool get isSharing => !active;

  bool isHiddenFrom(String userId) => hiddenFrom.contains(userId);

  GhostState copyWith({bool? active, Set<String>? hiddenFrom}) => GhostState(
    active: active ?? this.active,
    hiddenFrom: hiddenFrom ?? this.hiddenFrom,
  );
}

/// The signed-in user's profile row (GET /api/me).
class MeProfile {
  const MeProfile({
    required this.userId,
    required this.displayName,
    required this.whoCanAddMe,
    required this.hasAvatar,
    required this.ghostActive,
  });

  factory MeProfile.fromJson(Map<String, dynamic> json) => MeProfile(
    userId: json['user_id'] as String,
    displayName: json['display_name'] as String? ?? '',
    whoCanAddMe: json['who_can_add_me'] as String? ?? 'anyone',
    hasAvatar: json['has_avatar'] as bool? ?? false,
    ghostActive: json['ghost_active'] as bool? ?? false,
  );

  final String userId;
  final String displayName;
  final String whoCanAddMe;
  final bool hasAvatar;
  final bool ghostActive;
}
