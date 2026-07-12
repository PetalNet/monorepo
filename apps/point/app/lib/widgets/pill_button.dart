import 'package:flutter/material.dart';
import 'package:point_app/theme/theme_x.dart';

/// A full-width pill primary — inverse-filled (onSurface bg, surface ink), the
/// bold monochrome CTA from the mockup. `full`-radius, ≥48dp.
class PillButton extends StatelessWidget {
  const PillButton({
    required this.label,
    required this.onPressed,
    this.loading = false,
    this.trailing,
    super.key,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool loading;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final ink = context.colors.onSurface;
    final onInk = context.colors.surface;
    final disabled = onPressed == null && !loading;
    return Semantics(
      button: true,
      enabled: !disabled,
      label: label,
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 160),
        opacity: disabled ? 0.4 : 1,
        child: Material(
          color: ink,
          borderRadius: BorderRadius.circular(context.radii.full),
          child: InkWell(
            onTap: onPressed,
            borderRadius: BorderRadius.circular(context.radii.full),
            child: Container(
              height: 56,
              alignment: Alignment.center,
              padding: EdgeInsets.symmetric(horizontal: context.space.xl),
              child: loading
                  ? SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                        strokeWidth: 2.4,
                        valueColor: AlwaysStoppedAnimation(onInk),
                      ),
                    )
                  : Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          label,
                          style: context.text.titleMedium?.copyWith(
                            color: onInk,
                          ),
                        ),
                        if (trailing != null) ...[
                          SizedBox(width: context.space.sm),
                          IconTheme(
                            data: IconThemeData(color: onInk),
                            child: trailing!,
                          ),
                        ],
                      ],
                    ),
            ),
          ),
        ),
      ),
    );
  }
}
