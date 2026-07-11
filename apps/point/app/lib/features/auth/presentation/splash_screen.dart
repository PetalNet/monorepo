import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';

/// Shown while the persisted session is restored (auth resolves, then the
/// `router.set` listener routes to Login or the shell).
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: context.colors.surface,
      body: Center(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 14,
              height: 14,
              decoration: BoxDecoration(
                color: context.colors.onSurface,
                shape: BoxShape.circle,
              ),
            ),
            SizedBox(width: context.space.md),
            Text('Point', style: context.text.headlineMedium),
          ],
        ),
      ),
    );
  }
}
