import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';

/// PLACEHOLDER (Wave 3 builds the real People list + share sheet).
class PeopleScreen extends StatelessWidget {
  const PeopleScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('People')),
      body: Center(
        child: Text(
          'People & share',
          style: context.text.titleMedium
              ?.copyWith(color: context.colors.onSurfaceVariant),
        ),
      ),
    );
  }
}
