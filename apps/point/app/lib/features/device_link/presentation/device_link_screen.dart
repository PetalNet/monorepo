import 'package:flutter/material.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/theme/theme_x.dart';

/// PLACEHOLDER (Wave 3 builds the real QR enrollment).
class DeviceLinkScreen extends StatelessWidget {
  const DeviceLinkScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Link a device'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => context.pop(),
        ),
      ),
      body: Center(
        child: Text(
          'Device-link QR',
          style: context.text.titleMedium
              ?.copyWith(color: context.colors.onSurfaceVariant),
        ),
      ),
    );
  }
}
