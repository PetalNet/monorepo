import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';

/// The borderless tonal text field used across auth + onboarding: filled
/// surface-container, no enabled border, a hairline-free focus ring in ink.
class TonalField extends StatelessWidget {
  const TonalField({
    required this.controller,
    required this.label,
    this.obscure = false,
    this.keyboardType,
    this.hint,
    this.maxLines = 1,
    this.mono = false,
    this.autocorrect = false,
    super.key,
  });

  final TextEditingController controller;
  final String label;
  final bool obscure;
  final TextInputType? keyboardType;
  final String? hint;
  final int maxLines;

  /// Tabular content (codes, phrases) renders in the mono family.
  final bool mono;
  final bool autocorrect;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      keyboardType: keyboardType,
      maxLines: maxLines,
      autocorrect: autocorrect,
      enableSuggestions: autocorrect,
      style: mono
          ? context.text.bodyLarge?.copyWith(fontFamily: 'JetBrains Mono')
          : context.text.bodyLarge,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        hintStyle: context.text.bodyMedium?.copyWith(
          color: context.colors.onSurfaceVariant,
        ),
        filled: true,
        fillColor: context.colors.surfaceContainer,
        border: OutlineInputBorder(
          borderRadius: context.radii.brSm,
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: context.radii.brSm,
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: context.radii.brSm,
          borderSide: BorderSide(color: context.colors.onSurface, width: 1.5),
        ),
      ),
    );
  }
}
