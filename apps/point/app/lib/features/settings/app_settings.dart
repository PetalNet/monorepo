import 'package:flutter/foundation.dart';

/// Which basemap the map screen renders (honest tiers, D-024):
/// [selfHosted] = OSM tiles from the connected home-server's own tileserver
/// (hosted OSM fallback when the instance runs none); [proxied] = a polished
/// vector provider reached only through the Point server, so the provider
/// never sees the user.
enum MapProviderChoice {
  selfHosted,
  proxied;

  static MapProviderChoice parse(String? raw) => values.firstWhere(
    (v) => v.name == raw,
    orElse: () => MapProviderChoice.selfHosted,
  );
}

/// How push notifications reach this device: UnifiedPush through the user's
/// own distributor, or Google's FCM.
enum NotifTransport {
  unifiedPush,
  fcm;

  static NotifTransport parse(String? raw) => values.firstWhere(
    (v) => v.name == raw,
    orElse: () => NotifTransport.unifiedPush,
  );
}

/// Persisted app-level settings. Immutable value type; the controller owns
/// mutation + persistence. Defaults are the private tier.
@immutable
class AppSettings {
  const AppSettings({
    this.mapProvider = MapProviderChoice.selfHosted,
    this.transport = NotifTransport.unifiedPush,
    this.fcmFallback = false,
    this.transportChosen = false,
  });

  factory AppSettings.fromJson(Map<String, dynamic> json) => AppSettings(
    mapProvider: MapProviderChoice.parse(json['map_provider'] as String?),
    transport: NotifTransport.parse(json['transport'] as String?),
    fcmFallback: json['fcm_fallback'] as bool? ?? false,
    transportChosen: json['transport_chosen'] as bool? ?? false,
  );

  /// The rendered basemap tier. One home: Privacy settings (deep-linked from
  /// Look & feel).
  final MapProviderChoice mapProvider;

  /// The push transport this device registers with.
  final NotifTransport transport;

  /// Whether a UnifiedPush choice may fall back to FCM when no distributor is
  /// available. Never flipped silently; the user owns it.
  final bool fcmFallback;

  /// Set once the onboarding privacy fork (or a later explicit Settings
  /// change) has recorded a deliberate transport choice. The launch gate
  /// routes into the fork until this is true.
  final bool transportChosen;

  Map<String, dynamic> toJson() => {
    'map_provider': mapProvider.name,
    'transport': transport.name,
    'fcm_fallback': fcmFallback,
    'transport_chosen': transportChosen,
  };

  AppSettings copyWith({
    MapProviderChoice? mapProvider,
    NotifTransport? transport,
    bool? fcmFallback,
    bool? transportChosen,
  }) => AppSettings(
    mapProvider: mapProvider ?? this.mapProvider,
    transport: transport ?? this.transport,
    fcmFallback: fcmFallback ?? this.fcmFallback,
    transportChosen: transportChosen ?? this.transportChosen,
  );

  @override
  bool operator ==(Object other) =>
      other is AppSettings &&
      other.mapProvider == mapProvider &&
      other.transport == transport &&
      other.fcmFallback == fcmFallback &&
      other.transportChosen == transportChosen;

  @override
  int get hashCode =>
      Object.hash(mapProvider, transport, fcmFallback, transportChosen);
}
