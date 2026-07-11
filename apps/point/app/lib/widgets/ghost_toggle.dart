import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';

/// The safety-critical ghost switch (mockup screen 2). Large tactile pill,
/// ≥48dp, inverse-fill + label — **no pulse/ripple, never color** (D-015).
/// `sharing == true` → thumb right, filled track (broadcasting). A `Semantics`
/// toggle exposes on/off to screen readers.
class GhostToggle extends StatelessWidget {
  const GhostToggle({
    required this.sharing,
    required this.onChanged,
    super.key,
  });

  final bool sharing;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final ink = context.colors.onSurface;
    final onInk = context.colors.surface;
    const width = 132.0;
    const height = 64.0;
    const thumb = 52.0;

    return Semantics(
      toggled: sharing,
      label: 'Location sharing',
      hint: sharing ? 'On. Double tap to go dark.' : 'Off. Double tap to share.',
      button: true,
      child: GestureDetector(
        onTap: () => onChanged(!sharing),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          width: width,
          height: height,
          padding: const EdgeInsets.all(6),
          decoration: BoxDecoration(
            color: sharing ? ink : Colors.transparent,
            borderRadius: BorderRadius.circular(context.radii.full),
            border: Border.all(color: ink, width: 1.5),
          ),
          child: AnimatedAlign(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOutCubic,
            alignment: sharing ? Alignment.centerRight : Alignment.centerLeft,
            child: Container(
              width: thumb,
              height: thumb,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: sharing ? onInk : ink,
                shape: BoxShape.circle,
              ),
              child: Icon(
                sharing ? Icons.arrow_forward : Icons.visibility_off,
                size: 22,
                color: sharing ? ink : onInk,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
