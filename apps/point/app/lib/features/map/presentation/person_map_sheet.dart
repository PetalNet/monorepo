import 'package:flutter/material.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/initials_avatar.dart';
import 'package:point_app/widgets/presence_dot.dart';

/// Compact bottom sheet shown when a person's map marker is tapped: who they
/// are, their last place / last-updated line, and quick actions (focus the map
/// on them; open their detail — wired in a later wave). Monochrome, form-first.
class PersonMapSheet extends StatelessWidget {
  const PersonMapSheet({
    required this.person,
    required this.onFocus,
    this.onOpenDetail,
    super.key,
  });

  final Person person;
  final VoidCallback onFocus;
  final VoidCallback? onOpenDetail;

  static Future<void> show(
    BuildContext context, {
    required Person person,
    required VoidCallback onFocus,
    VoidCallback? onOpenDetail,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => PersonMapSheet(
        person: person,
        onFocus: onFocus,
        onOpenDetail: onOpenDetail,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
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
                InitialsAvatar(name: person.displayName),
                SizedBox(width: context.space.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(person.displayName, style: context.text.titleMedium),
                      SizedBox(height: context.space.xxs),
                      Text(
                        person.subtitle.isEmpty ? person.userId : person.subtitle,
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
                PresenceDot(state: person.presence, size: 16),
              ],
            ),
            SizedBox(height: context.space.lg),
            Row(
              children: [
                Expanded(
                  child: _SheetAction(
                    icon: Icons.my_location,
                    label: 'Focus',
                    onTap: () {
                      Navigator.of(context).pop();
                      onFocus();
                    },
                  ),
                ),
                if (onOpenDetail != null) ...[
                  SizedBox(width: context.space.sm),
                  Expanded(
                    child: _SheetAction(
                      icon: Icons.chevron_right,
                      label: 'Details',
                      onTap: () {
                        Navigator.of(context).pop();
                        onOpenDetail!();
                      },
                    ),
                  ),
                ],
              ],
            ),
          ],
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
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: context.colors.surfaceContainerHigh,
      borderRadius: context.radii.brMd,
      child: InkWell(
        onTap: onTap,
        borderRadius: context.radii.brMd,
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: context.space.md),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 18, color: context.colors.onSurface),
              SizedBox(width: context.space.sm),
              Text(label, style: context.text.titleMedium),
            ],
          ),
        ),
      ),
    );
  }
}
