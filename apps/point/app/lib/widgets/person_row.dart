import 'package:flutter/material.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/initials_avatar.dart';
import 'package:point_app/widgets/presence_dot.dart';

/// A person list row (mockup screens 1 + 3): avatar · name (bold) · status
/// (mono, muted) · trailing presence mark. Shared by Map and People.
class PersonRow extends StatelessWidget {
  const PersonRow({required this.person, this.onTap, super.key});

  final Person person;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: context.space.lg,
          vertical: context.space.md,
        ),
        child: Row(
          children: [
            InitialsAvatar(name: person.displayName),
            SizedBox(width: context.space.lg),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(person.displayName, style: context.text.titleMedium),
                  if (person.subtitle.isNotEmpty)
                    Text(
                      person.subtitle,
                      style: context.text.bodySmall?.copyWith(
                        fontFamily: AppTheme.monoFamily,
                        color: context.colors.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
            SizedBox(width: context.space.md),
            PresenceDot(state: person.presence),
          ],
        ),
      ),
    );
  }
}
