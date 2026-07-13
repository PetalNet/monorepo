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

/// Push capabilities compiled into this app package.
///
/// The standard Point client deliberately ships without Google Services or
/// `firebase_messaging`, so it must never persist FCM as though it were a
/// working transport. A future Firebase flavor should replace this constant
/// only as part of wiring token acquisition end to end.
abstract final class PushBuildCapabilities {
  static const supportsFcm = false;
}

/// The app appearance. Dark is the default; pure black is the OLED variant.
enum Appearance {
  light,
  dark,
  pureBlack;

  static Appearance parse(String? raw) =>
      values.firstWhere((v) => v.name == raw, orElse: () => Appearance.dark);
}

/// Motion: follow the OS accessibility setting, or override either way.
enum MotionPreference {
  system,
  reduced,
  full;

  static MotionPreference parse(String? raw) => values.firstWhere(
    (v) => v.name == raw,
    orElse: () => MotionPreference.system,
  );
}

/// Haptic feedback level for interactive controls.
enum HapticsLevel {
  none,
  standard,
  enhanced;

  static HapticsLevel parse(String? raw) => values.firstWhere(
    (v) => v.name == raw,
    orElse: () => HapticsLevel.standard,
  );
}

/// Distance units for people rows and the map.
enum DistanceUnits {
  miles,
  kilometers;

  static DistanceUnits parse(String? raw) => values.firstWhere(
    (v) => v.name == raw,
    orElse: () => DistanceUnits.miles,
  );
}

/// Clock format for timestamps ("dark since", temp-share expiry).
enum TimeFormat {
  h12,
  h24;

  static TimeFormat parse(String? raw) =>
      values.firstWhere((v) => v.name == raw, orElse: () => TimeFormat.h12);
}

/// Persisted app-level settings. Immutable value type; the controller owns
/// mutation + persistence. Defaults are the private tier, dark theme,
/// standard haptics, miles, 12-hour clock.
@immutable
class AppSettings {
  const AppSettings({
    this.mapProvider = MapProviderChoice.selfHosted,
    NotifTransport transport = NotifTransport.unifiedPush,
    bool fcmFallback = false,
    this.transportChosen = false,
    this.appearance = Appearance.dark,
    this.motion = MotionPreference.system,
    this.haptics = HapticsLevel.standard,
    this.units = DistanceUnits.miles,
    this.timeFormat = TimeFormat.h12,
    this.textScale = 1.0,
    this.goDarkDefault = false,
    this.needsPushMigration = false,
  }) : transport =
           !PushBuildCapabilities.supportsFcm && transport == NotifTransport.fcm
           ? NotifTransport.unifiedPush
           : transport,
       fcmFallback = PushBuildCapabilities.supportsFcm && fcmFallback;

  factory AppSettings.fromJson(Map<String, dynamic> json) {
    final requestedTransport = NotifTransport.parse(
      json['transport'] as String?,
    );
    const supportsFcm = PushBuildCapabilities.supportsFcm;
    final unsupportedFcm =
        requestedTransport == NotifTransport.fcm && !supportsFcm;
    return AppSettings(
      mapProvider: MapProviderChoice.parse(json['map_provider'] as String?),
      transport: unsupportedFcm
          ? NotifTransport.unifiedPush
          : requestedTransport,
      fcmFallback: supportsFcm && (json['fcm_fallback'] as bool? ?? false),
      transportChosen: json['transport_chosen'] as bool? ?? false,
      appearance: Appearance.parse(json['appearance'] as String?),
      motion: MotionPreference.parse(json['motion'] as String?),
      haptics: HapticsLevel.parse(json['haptics'] as String?),
      units: DistanceUnits.parse(json['units'] as String?),
      timeFormat: TimeFormat.parse(json['time_format'] as String?),
      textScale: (json['text_scale'] as num?)?.toDouble() ?? 1.0,
      goDarkDefault: json['go_dark_default'] as bool? ?? false,
      needsPushMigration: unsupportedFcm,
    );
  }

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

  final Appearance appearance;
  final MotionPreference motion;
  final HapticsLevel haptics;
  final DistanceUnits units;
  final TimeFormat timeFormat;

  /// App-wide text scale multiplier (composed with the OS scale).
  final double textScale;

  /// Start each fresh sign-in dark: sharing only begins when the user says so.
  final bool goDarkDefault;

  /// An old or attempted FCM choice was normalized by this non-Firebase build.
  /// PushService uses this transient flag to revoke any legacy registration.
  /// It is intentionally not serialized; the next normal settings write
  /// persists the already-normalized transport without racing that controller.
  final bool needsPushMigration;

  Map<String, dynamic> toJson() => {
    'map_provider': mapProvider.name,
    'transport': transport.name,
    'fcm_fallback': fcmFallback,
    'transport_chosen': transportChosen,
    'appearance': appearance.name,
    'motion': motion.name,
    'haptics': haptics.name,
    'units': units.name,
    'time_format': timeFormat.name,
    'text_scale': textScale,
    'go_dark_default': goDarkDefault,
  };

  AppSettings copyWith({
    MapProviderChoice? mapProvider,
    NotifTransport? transport,
    bool? fcmFallback,
    bool? transportChosen,
    Appearance? appearance,
    MotionPreference? motion,
    HapticsLevel? haptics,
    DistanceUnits? units,
    TimeFormat? timeFormat,
    double? textScale,
    bool? goDarkDefault,
    bool? needsPushMigration,
  }) {
    final requestedTransport = transport ?? this.transport;
    const supportsFcm = PushBuildCapabilities.supportsFcm;
    final unsupportedFcm =
        requestedTransport == NotifTransport.fcm && !supportsFcm;
    return AppSettings(
      mapProvider: mapProvider ?? this.mapProvider,
      transport: unsupportedFcm
          ? NotifTransport.unifiedPush
          : requestedTransport,
      fcmFallback: supportsFcm && (fcmFallback ?? this.fcmFallback),
      transportChosen: transportChosen ?? this.transportChosen,
      appearance: appearance ?? this.appearance,
      motion: motion ?? this.motion,
      haptics: haptics ?? this.haptics,
      units: units ?? this.units,
      timeFormat: timeFormat ?? this.timeFormat,
      textScale: textScale ?? this.textScale,
      goDarkDefault: goDarkDefault ?? this.goDarkDefault,
      needsPushMigration:
          (needsPushMigration ?? this.needsPushMigration) || unsupportedFcm,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is AppSettings &&
      other.mapProvider == mapProvider &&
      other.transport == transport &&
      other.fcmFallback == fcmFallback &&
      other.transportChosen == transportChosen &&
      other.appearance == appearance &&
      other.motion == motion &&
      other.haptics == haptics &&
      other.units == units &&
      other.timeFormat == timeFormat &&
      other.textScale == textScale &&
      other.goDarkDefault == goDarkDefault &&
      other.needsPushMigration == needsPushMigration;

  @override
  int get hashCode => Object.hash(
    mapProvider,
    transport,
    fcmFallback,
    transportChosen,
    appearance,
    motion,
    haptics,
    units,
    timeFormat,
    textScale,
    goDarkDefault,
    needsPushMigration,
  );
}
