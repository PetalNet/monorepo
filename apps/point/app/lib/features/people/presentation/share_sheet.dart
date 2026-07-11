import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';

/// The share bottom sheet (mockup: rounded 28 top, grab handle). Direct /
/// timed / link, per the "Share your location" strip.
///
// TODO(fable): wire to PointApi.sendShareRequest / createTempShare / link.
class ShareSheet extends StatelessWidget {
  const ShareSheet({this.timed = false, this.link = false, super.key});

  final bool timed;
  final bool link;

  static Future<void> show(
    BuildContext context, {
    bool timed = false,
    bool link = false,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => ShareSheet(timed: timed, link: link),
    );
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          context.space.lg,
          context.space.sm,
          context.space.lg,
          context.space.xl,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              link
                  ? 'Share a link'
                  : timed
                      ? 'Share for a while'
                      : 'Share your location',
              style: context.text.headlineSmall,
            ),
            SizedBox(height: context.space.xs),
            Text(
              link
                  ? 'Anyone with the link can see you until it expires.'
                  : timed
                      ? 'They see you for a set time, then it stops on its own.'
                      : 'Add someone by their Point address (name@server).',
              style: context.text.bodyMedium
                  ?.copyWith(color: context.colors.onSurfaceVariant),
            ),
            SizedBox(height: context.space.xl),
            _Option(
              icon: Icons.person_add_alt,
              title: 'Add a person',
              subtitle: 'name@their.server',
              onTap: () => Navigator.of(context).pop(),
            ),
            _Option(
              icon: Icons.schedule,
              title: 'For 1 hour',
              subtitle: 'Temporary — auto-stops',
              onTap: () => Navigator.of(context).pop(),
            ),
            _Option(
              icon: Icons.link,
              title: 'Create a link',
              subtitle: 'Send anywhere',
              onTap: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      ),
    );
  }
}

class _Option extends StatelessWidget {
  const _Option({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: context.space.sm),
      child: Material(
        color: context.colors.surfaceContainerHigh,
        borderRadius: context.radii.brMd,
        child: ListTile(
          shape: RoundedRectangleBorder(borderRadius: context.radii.brMd),
          leading: Icon(icon, color: context.colors.onSurface),
          title: Text(title, style: context.text.titleMedium),
          subtitle: Text(
            subtitle,
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          onTap: onTap,
        ),
      ),
    );
  }
}
