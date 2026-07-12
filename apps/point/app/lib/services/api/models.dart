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
        fromDisplayName: json['from_display_name'] as String? ??
            json['display_name'] as String? ??
            (json['from_user_id'] as String).split('@').first,
      );

  final String id;
  final String fromUserId;
  final String fromDisplayName;

  /// The bare local name (before `@domain`).
  String get fromHandle => fromUserId.split('@').first;
}

/// The signed-in user's own ghost/broadcast state.
class GhostState {
  const GhostState({required this.active});

  factory GhostState.fromJson(Map<String, dynamic> json) =>
      GhostState(active: json['active'] as bool? ?? false);

  /// Ghost ON = not sharing (dark). Ghost OFF = broadcasting.
  final bool active;

  bool get isSharing => !active;
}
