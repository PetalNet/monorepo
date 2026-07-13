import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/initials_avatar.dart';
import 'package:point_app/widgets/presence_dot.dart';
import 'package:url_launcher/url_launcher.dart';

/// Result of handing a map destination to the operating system.
enum DirectionsOutcome { opened, coordinatesCopied, failed }

/// Injectable seam for the marker sheet's asynchronous directions action.
typedef DirectionsOpener =
    Future<DirectionsOutcome> Function({
      required double latitude,
      required double longitude,
    });

/// Launches one external directions candidate.
typedef DirectionsUriLauncher = Future<bool> Function(Uri uri);

/// Writes a coordinate pair to a user-controlled fallback destination.
typedef CoordinatesWriter = Future<void> Function(String coordinates);

Future<bool> _launchExternally(Uri uri) =>
    launchUrl(uri, mode: LaunchMode.externalApplication);

Future<void> _copyCoordinates(String coordinates) =>
    Clipboard.setData(ClipboardData(text: coordinates));

/// Opens a destination without attaching a person's identity or Point account
/// data. The platform gets first choice of installed handlers for the standard
/// `geo:` URI, then a universal HTTPS directions URL is tried. If neither can
/// open, the raw coordinates are copied so the destination is never lost.
Future<DirectionsOutcome> openDirections({
  required double latitude,
  required double longitude,
  DirectionsUriLauncher launcher = _launchExternally,
  CoordinatesWriter coordinatesWriter = _copyCoordinates,
  bool preferGeo = !kIsWeb,
}) async {
  if (!latitude.isFinite ||
      !longitude.isFinite ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180) {
    return DirectionsOutcome.failed;
  }

  final coordinates =
      '${latitude.toStringAsFixed(6)},'
      '${longitude.toStringAsFixed(6)}';
  final geoUri = Uri(
    scheme: 'geo',
    path: '0,0',
    queryParameters: {'q': coordinates},
  );
  final webUri = Uri.https('www.google.com', '/maps/dir/', {
    'api': '1',
    'destination': coordinates,
  });

  // Browsers report a `geo:` window-open as successful even when no handler
  // exists. Start with the universal URL there; native platforms retain the
  // standards-based intent so the OS can offer its installed-app chooser.
  for (final uri in [if (preferGeo) geoUri, webUri]) {
    try {
      if (await launcher(uri)) return DirectionsOutcome.opened;
    } on Exception {
      // A missing or rejecting platform handler is expected; try the fallback.
    }
  }

  try {
    await coordinatesWriter(coordinates);
    return DirectionsOutcome.coordinatesCopied;
  } on Exception {
    return DirectionsOutcome.failed;
  }
}

/// Compact bottom sheet shown when a person's map marker is tapped: who they
/// are, their last place / last-updated line, and quick actions (focus the map
/// on them; open their detail — wired in a later wave). Monochrome, form-first.
class PersonMapSheet extends StatefulWidget {
  const PersonMapSheet({
    required this.person,
    required this.onFocus,
    this.onOpenDetail,
    this.directionsOpener = openDirections,
    super.key,
  });

  final Person person;
  final VoidCallback onFocus;
  final VoidCallback? onOpenDetail;
  final DirectionsOpener directionsOpener;

  static Future<void> show(
    BuildContext context, {
    required Person person,
    required VoidCallback onFocus,
    VoidCallback? onOpenDetail,
    DirectionsOpener directionsOpener = openDirections,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => PersonMapSheet(
        person: person,
        onFocus: onFocus,
        onOpenDetail: onOpenDetail,
        directionsOpener: directionsOpener,
      ),
    );
  }

  @override
  State<PersonMapSheet> createState() => _PersonMapSheetState();
}

class _PersonMapSheetState extends State<PersonMapSheet> {
  bool _openingDirections = false;

  Future<void> _openDirections() async {
    if (_openingDirections || !widget.person.hasLocation) return;

    setState(() => _openingDirections = true);
    final messenger = ScaffoldMessenger.maybeOf(context);
    final outcome = await widget.directionsOpener(
      latitude: widget.person.lat!,
      longitude: widget.person.lon!,
    );
    if (!mounted) return;

    switch (outcome) {
      case DirectionsOutcome.opened:
        Navigator.of(context).pop();
      case DirectionsOutcome.coordinatesCopied:
        Navigator.of(context).pop();
        messenger?.showSnackBar(
          const SnackBar(
            content: Text('No maps app found. Coordinates copied.'),
          ),
        );
      case DirectionsOutcome.failed:
        setState(() => _openingDirections = false);
        messenger?.showSnackBar(
          const SnackBar(
            content: Text("Couldn't open directions or copy coordinates."),
          ),
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_openingDirections,
      child: SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            context.space.lg,
            0,
            context.space.lg,
            context.space.lg,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  InitialsAvatar(name: widget.person.displayName),
                  SizedBox(width: context.space.md),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          widget.person.displayName,
                          style: context.text.titleMedium,
                        ),
                        SizedBox(height: context.space.xxs),
                        Text(
                          widget.person.subtitle.isEmpty
                              ? widget.person.userId
                              : widget.person.subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: context.text.bodySmall?.copyWith(
                            fontFamily: AppTheme.monoFamily,
                            letterSpacing: 0,
                            color: context.colors.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  PresenceDot(state: widget.person.presence, size: 16),
                ],
              ),
              SizedBox(height: context.space.lg),
              Row(
                children: [
                  Expanded(
                    child: _SheetAction(
                      icon: Icons.my_location,
                      label: 'Focus',
                      onTap: _openingDirections
                          ? null
                          : () {
                              Navigator.of(context).pop();
                              widget.onFocus();
                            },
                    ),
                  ),
                  SizedBox(width: context.space.sm),
                  Expanded(
                    child: _SheetAction(
                      icon: Icons.directions_outlined,
                      label: _openingDirections ? 'Opening…' : 'Directions',
                      onTap: widget.person.hasLocation && !_openingDirections
                          ? _openDirections
                          : null,
                    ),
                  ),
                  if (widget.onOpenDetail != null) ...[
                    SizedBox(width: context.space.sm),
                    Expanded(
                      child: _SheetAction(
                        icon: Icons.chevron_right,
                        label: 'Details',
                        onTap: _openingDirections
                            ? null
                            : () {
                                Navigator.of(context).pop();
                                widget.onOpenDetail!();
                              },
                      ),
                    ),
                  ],
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SheetAction extends StatelessWidget {
  const _SheetAction({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      enabled: onTap != null,
      label: label,
      onTap: onTap,
      child: ExcludeSemantics(
        child: Material(
          color: context.colors.surfaceContainerHigh,
          borderRadius: context.radii.brMd,
          child: InkWell(
            onTap: onTap,
            borderRadius: context.radii.brMd,
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: context.space.xs,
                vertical: context.space.md,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    icon,
                    size: 18,
                    color: onTap == null
                        ? context.colors.onSurfaceVariant
                        : context.colors.onSurface,
                  ),
                  SizedBox(height: context.space.xs),
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: context.text.titleSmall?.copyWith(
                      color: onTap == null
                          ? context.colors.onSurfaceVariant
                          : context.colors.onSurface,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
