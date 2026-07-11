import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:qr_flutter/qr_flutter.dart';

/// Device-linking enrollment (decision 10): an already-trusted device shows
/// this; the new device scans it. **The server never injects a device** — only
/// a device you already hold authorizes another. High-contrast black QR on a
/// white card (works in both themes) + a tabular mono fallback code.
class DeviceLinkScreen extends StatelessWidget {
  const DeviceLinkScreen({super.key});

  // TODO(fable): real device-link challenge (short-lived, signed by this
  // device's key) from the enrollment service.
  static const _payload = 'point://link/PT-4K9X-22H7-J3QF';
  static const _fallbackCode = 'PT-4K9X-22H7';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => context.pop(),
        ),
        title: const Text('Link a device'),
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: EdgeInsets.all(context.space.xl),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    'Scan from your new device',
                    style: context.text.headlineSmall,
                    textAlign: TextAlign.center,
                  ),
                  SizedBox(height: context.space.sm),
                  Text(
                    'Your identity stays on your devices — the server never '
                    'adds a device for you.',
                    textAlign: TextAlign.center,
                    style: context.text.bodyMedium
                        ?.copyWith(color: context.colors.onSurfaceVariant),
                  ),
                  SizedBox(height: context.space.xl),
                  const _QrCard(payload: _payload),
                  SizedBox(height: context.space.xl),
                  Text(
                    'Or enter this code',
                    style: context.text.labelMedium
                        ?.copyWith(color: context.colors.onSurfaceVariant),
                  ),
                  SizedBox(height: context.space.sm),
                  const _FallbackCode(code: _fallbackCode),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _QrCard extends StatelessWidget {
  const _QrCard({required this.payload});
  final String payload;

  @override
  Widget build(BuildContext context) {
    // Explicitly white card / black QR — deliberately theme-independent so the
    // code always scans, in light or dark.
    return Container(
      padding: EdgeInsets.all(context.space.xl),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: context.radii.brLg,
      ),
      child: QrImageView(
        data: payload,
        size: 240,
        eyeStyle: const QrEyeStyle(color: Colors.black),
        dataModuleStyle: const QrDataModuleStyle(color: Colors.black),
      ),
    );
  }
}

class _FallbackCode extends StatelessWidget {
  const _FallbackCode({required this.code});
  final String code;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: context.radii.brSm,
      onTap: () => Clipboard.setData(ClipboardData(text: code)),
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: context.space.lg,
          vertical: context.space.md,
        ),
        decoration: BoxDecoration(
          color: context.colors.surfaceContainer,
          borderRadius: context.radii.brSm,
        ),
        child: Text(
          code,
          style: context.text.titleLarge?.copyWith(
            fontFamily: AppTheme.monoFamily,
            letterSpacing: 3,
          ),
        ),
      ),
    );
  }
}
