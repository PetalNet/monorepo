import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/pill_button.dart';

/// The standard confirm bottom sheet: headline, muted body, a pill primary
/// that resolves true, and a quiet text secondary that resolves false. Used
/// wherever a decision deserves one honest beat of friction.
class ConfirmSheet extends StatelessWidget {
  const ConfirmSheet({
    required this.title,
    required this.body,
    required this.primaryLabel,
    required this.secondaryLabel,
    super.key,
  });

  final String title;
  final String body;
  final String primaryLabel;
  final String secondaryLabel;

  /// Shows the sheet; resolves true on the primary, false otherwise.
  static Future<bool> show(
    BuildContext context, {
    required String title,
    required String body,
    required String primaryLabel,
    required String secondaryLabel,
  }) async {
    final choice = await showModalBottomSheet<bool>(
      context: context,
      builder: (context) => ConfirmSheet(
        title: title,
        body: body,
        primaryLabel: primaryLabel,
        secondaryLabel: secondaryLabel,
      ),
    );
    return choice ?? false;
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          context.space.xl,
          context.space.md,
          context.space.xl,
          context.space.xl,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(title, style: context.text.headlineSmall),
            SizedBox(height: context.space.md),
            Text(
              body,
              style: context.text.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            SizedBox(height: context.space.xl),
            PillButton(
              label: primaryLabel,
              onPressed: () => Navigator.of(context).pop(true),
            ),
            SizedBox(height: context.space.xs),
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: Text(secondaryLabel),
            ),
          ],
        ),
      ),
    );
  }
}
