import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/initials_avatar.dart';
import 'package:point_app/widgets/presence_dot.dart';

void main() => runApp(const ProviderScope(child: PointApp()));

/// Temporary design-system harness (Wave 1). Real router + screens land in the
/// next waves; this proves the theme, fonts, and presence primitive render.
class PointApp extends StatelessWidget {
  const PointApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Point',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.dark,
      home: const _ThemePreview(),
    );
  }
}

class _ThemePreview extends StatelessWidget {
  const _ThemePreview();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            const _BrandDot(),
            SizedBox(width: context.space.sm),
            const Text('Point'),
          ],
        ),
      ),
      body: ListView(
        padding: EdgeInsets.all(context.space.lg),
        children: [
          Text('Bold, monochrome, tactile.', style: context.text.displaySmall),
          SizedBox(height: context.space.xl),
          for (final (state, label, sub) in const [
            (PresenceState.live, 'Aria', '0.4 mi · moving'),
            (PresenceState.away, 'Jesse', '2.1 mi · away'),
            (PresenceState.stale, 'Mom', 'last seen 2h ago'),
            (PresenceState.ghosted, 'Dex', 'hidden · ghosting'),
          ])
            _PreviewRow(name: label, subtitle: sub, state: state),
        ],
      ),
    );
  }
}

class _BrandDot extends StatelessWidget {
  const _BrandDot();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(
        color: context.colors.onSurface,
        shape: BoxShape.circle,
      ),
    );
  }
}

class _PreviewRow extends StatelessWidget {
  const _PreviewRow({
    required this.name,
    required this.subtitle,
    required this.state,
  });

  final String name;
  final String subtitle;
  final PresenceState state;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.symmetric(vertical: context.space.sm),
      child: Row(
        children: [
          InitialsAvatar(name: name),
          SizedBox(width: context.space.lg),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, style: context.text.titleMedium),
                Text(
                  subtitle,
                  style: context.text.bodySmall?.copyWith(
                    fontFamily: AppTheme.monoFamily,
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          PresenceDot(state: state),
        ],
      ),
    );
  }
}
