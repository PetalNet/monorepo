import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';

/// PLACEHOLDER (Wave 3 builds the real map + presence markers). Kept on-brand
/// so the shell renders; replaced with the mockup-matching screen.
class MapScreen extends StatelessWidget {
  const MapScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: context.colors.onSurface,
                shape: BoxShape.circle,
              ),
            ),
            SizedBox(width: context.space.sm),
            const Text('Point'),
          ],
        ),
      ),
      body: Center(
        child: Text(
          'Map + presence',
          style: context.text.titleMedium
              ?.copyWith(color: context.colors.onSurfaceVariant),
        ),
      ),
    );
  }
}
