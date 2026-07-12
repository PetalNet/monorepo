import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/services/server_config.dart';

/// The three honest tile tiers (Wave C). Each is exactly what it says; there
/// is no cleaned-up-surveillance middle ground.
enum TileTier {
  /// The connected home-server's own tileserver: map data never leaves your
  /// people's servers.
  selfHosted,

  /// A public OSM raster mirror, used only when the self-hosted tier is
  /// chosen but the instance runs no tileserver. Honest fallback, honestly
  /// labeled.
  hostedFallback,

  /// The Point server proxies an upstream provider: polished cartography,
  /// and the provider only ever sees the server.
  proxied,
}

/// A resolved tile source the map can render right now.
@immutable
class TileSource {
  const TileSource({
    required this.tier,
    required this.urlTemplate,
    this.subdomains = const [],
    this.headers = const {},
    this.retina = false,
  });

  final TileTier tier;
  final String urlTemplate;
  final List<String> subdomains;

  /// Extra request headers (the proxied tier authenticates to OUR server).
  final Map<String, String> headers;

  /// Whether the template understands {r} retina naming.
  final bool retina;

  @override
  bool operator ==(Object other) =>
      other is TileSource &&
      other.tier == tier &&
      other.urlTemplate == urlTemplate &&
      other.retina == retina;

  @override
  int get hashCode => Object.hash(tier, urlTemplate, retina);
}

/// The public OSM mirror used when a self-hosted tileserver is absent: the
/// CARTO dark raster set (OSM-derived, monochrome, no key). It sees the
/// device's IP like any public tile CDN; the Privacy screen says so.
const TileSource kHostedFallback = TileSource(
  tier: TileTier.hostedFallback,
  urlTemplate: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  subdomains: ['a', 'b', 'c', 'd'],
  retina: true,
);

/// What the connected server advertises in /.well-known/point.
class ServerTileInfo {
  const ServerTileInfo({this.tilesTemplate, this.tileProxy = false});
  final String? tilesTemplate;
  final bool tileProxy;
}

/// The connected home-server's advertised map endpoints. Refreshes when the
/// server choice changes. A fetch failure THROWS (rather than caching a false
/// "advertises nothing") so the tier resolution can hold — a private-tier user
/// must never be quietly downgraded to a public mirror by one flaky launch
/// request. Riverpod surfaces the error/loading state to [tileSourceProvider].
final serverTileInfoProvider = FutureProvider<ServerTileInfo>((ref) async {
  final origin = ref.watch(serverUrlProvider);
  // A few quick retries so a single flaky launch request doesn't leave the map
  // dark for the whole session; a persistent failure still (correctly) resolves
  // to "unknown" and the map shows no tiles rather than leaking to a CDN.
  Object? lastError;
  for (var attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await Future<void>.delayed(Duration(seconds: attempt));
    }
    try {
      final r = await http
          .get(Uri.parse('$origin/.well-known/point'))
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) {
        lastError = StateError('well-known ${r.statusCode}');
        continue;
      }
      final v = jsonDecode(r.body) as Map<String, dynamic>;
      final endpoints = v['endpoints'] as Map<String, dynamic>? ?? const {};
      return ServerTileInfo(
        tilesTemplate: endpoints['tiles'] as String?,
        tileProxy: endpoints['tile_proxy'] as bool? ?? false,
      );
    } on Object catch (e) {
      lastError = e;
    }
  }
  throw StateError('well-known unreachable: $lastError');
});

/// Resolve the map provider CHOICE (Privacy setting / onboarding fork) into a
/// renderable [TileSource], against what the connected server actually offers.
///
/// Returns NULL while the server's advertised endpoints are still loading (or
/// failed to load): the map then shows only its dark surface and fetches no
/// tiles at all. This is the privacy floor — a self-hosted-tier user must
/// never have their neighborhood tiles requested from a public CDN in the
/// window before we know whether their server runs a tileserver. Only once we
/// have a DEFINITIVE answer do we fall back to the public mirror.
final tileSourceProvider = Provider<TileSource?>((ref) {
  final choice = ref.watch(settingsProvider.select((s) => s.mapProvider));
  final infoAsync = ref.watch(serverTileInfoProvider);
  // Unresolved (loading OR error): render nothing rather than leak.
  final info = infoAsync.value;
  if (info == null) return null;
  final origin = ref.watch(serverUrlProvider);
  final token = ref.watch(authControllerProvider).value?.token;

  switch (choice) {
    case MapProviderChoice.selfHosted:
      final template = info.tilesTemplate;
      if (template == null || template.isEmpty) return kHostedFallback;
      return TileSource(tier: TileTier.selfHosted, urlTemplate: template);
    case MapProviderChoice.proxied:
      if (!info.tileProxy || token == null) {
        // The instance proxies nothing (or we are signed out): the private
        // default is the only honest stand-in. Never Google-by-surprise.
        return kHostedFallback;
      }
      return TileSource(
        tier: TileTier.proxied,
        urlTemplate: '$origin/api/tiles/{z}/{x}/{y}',
        headers: {'authorization': 'Bearer $token'},
      );
  }
});

/// One honest sentence about what the map is doing right now, for the
/// Privacy screen.
String tileSourceDescription(TileSource source) => switch (source.tier) {
  TileTier.selfHosted =>
    'Tiles come from your own server. Map data never leaves your people.',
  TileTier.hostedFallback =>
    'Your server offers no map source for this choice, so a public '
        'OpenStreetMap mirror is used. It sees this device, not your '
        'account.',
  TileTier.proxied =>
    'Tiles are fetched by your server on your behalf. The provider sees '
        'your server, never you.',
};
