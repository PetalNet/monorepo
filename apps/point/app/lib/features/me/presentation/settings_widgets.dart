import 'package:flutter/material.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/theme/theme_x.dart';

/// Resolves the app's motion setting against the platform accessibility flag.
///
/// Full motion is an explicit override; only the system setting follows the
/// operating system's disable-animations preference.
bool resolveReducedMotion({
  required MotionPreference preference,
  required bool systemDisabled,
}) => switch (preference) {
  MotionPreference.system => systemDisabled,
  MotionPreference.reduced => true,
  MotionPreference.full => false,
};

/// Publishes the effective motion preference to every animated primitive.
///
/// The MediaQuery fallback keeps isolated widgets and tests respectful of the
/// OS even when they are rendered outside the app root.
class ReducedMotionScope extends InheritedWidget {
  const ReducedMotionScope({
    required this.reduced,
    required super.child,
    super.key,
  });

  final bool reduced;

  static bool of(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<ReducedMotionScope>()
          ?.reduced ??
      MediaQuery.disableAnimationsOf(context);

  @override
  bool updateShouldNotify(ReducedMotionScope oldWidget) =>
      reduced != oldWidget.reduced;
}

/// Muted uppercase section label between setting groups.
class SettingsSection extends StatelessWidget {
  const SettingsSection(this.label, {super.key});
  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        context.space.lg,
        context.space.lg,
        context.space.lg,
        context.space.xs,
      ),
      child: Text(
        label.toUpperCase(),
        style: context.text.labelSmall?.copyWith(
          color: context.colors.onSurfaceVariant,
          letterSpacing: 1.4,
        ),
      ),
    );
  }
}

/// A drill-in row: title, optional live subtitle, quiet chevron.
class SettingsNavRow extends StatelessWidget {
  const SettingsNavRow({
    required this.title,
    required this.onTap,
    this.subtitle,
    this.icon,
    super.key,
  });

  final String title;
  final String? subtitle;
  final IconData? icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: icon != null
          ? Icon(icon, color: context.colors.onSurfaceVariant)
          : null,
      title: Text(title),
      subtitle: subtitle != null ? Text(subtitle!) : null,
      trailing: Icon(
        Icons.chevron_right,
        color: context.colors.onSurfaceVariant,
      ),
      onTap: onTap,
    );
  }
}

/// An inline enum choice: tap cycles a bottom sheet of options, the current
/// one shown as the subtitle.
class SettingsChoiceRow<T> extends StatelessWidget {
  const SettingsChoiceRow({
    required this.title,
    required this.value,
    required this.options,
    required this.onSelected,
    this.sheetBody,
    super.key,
  });

  final String title;
  final T value;

  /// (value, label, optional description) triples, in display order.
  final List<(T, String, String?)> options;
  final ValueChanged<T> onSelected;

  /// Optional explanatory body at the top of the sheet.
  final String? sheetBody;

  String get _currentLabel =>
      options.firstWhere((o) => o.$1 == value, orElse: () => options.first).$2;

  Future<void> _open(BuildContext context) async {
    final chosen = await showModalBottomSheet<T>(
      context: context,
      builder: (context) => _ChoiceSheet<T>(
        title: title,
        body: sheetBody,
        options: options,
        current: value,
      ),
    );
    if (chosen != null && chosen != value) onSelected(chosen);
  }

  @override
  Widget build(BuildContext context) {
    return ListTile(
      title: Text(title),
      subtitle: Text(_currentLabel),
      trailing: Icon(
        Icons.unfold_more,
        size: 20,
        color: context.colors.onSurfaceVariant,
      ),
      onTap: () => _open(context),
    );
  }
}

class _ChoiceSheet<T> extends StatelessWidget {
  const _ChoiceSheet({
    required this.title,
    required this.options,
    required this.current,
    this.body,
  });

  final String title;
  final String? body;
  final List<(T, String, String?)> options;
  final T current;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          context.space.lg,
          context.space.md,
          context.space.lg,
          context.space.lg,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: EdgeInsets.symmetric(horizontal: context.space.sm),
              child: Text(title, style: context.text.headlineSmall),
            ),
            if (body != null) ...[
              SizedBox(height: context.space.sm),
              Padding(
                padding: EdgeInsets.symmetric(horizontal: context.space.sm),
                child: Text(
                  body!,
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
            SizedBox(height: context.space.md),
            for (final (v, label, description) in options)
              ListTile(
                shape: RoundedRectangleBorder(borderRadius: context.radii.brSm),
                leading: _RadioDot(selected: v == current),
                title: Text(label),
                subtitle: description != null ? Text(description) : null,
                onTap: () => Navigator.of(context).pop(v),
              ),
          ],
        ),
      ),
    );
  }
}

/// Selection by form: ink ring, filled core when chosen.
class _RadioDot extends StatelessWidget {
  const _RadioDot({required this.selected});
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final ink = context.colors.onSurface;
    return Container(
      width: 18,
      height: 18,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: ink, width: 1.5),
      ),
      alignment: Alignment.center,
      child: AnimatedContainer(
        duration: ReducedMotionScope.of(context)
            ? Duration.zero
            : const Duration(milliseconds: 160),
        width: selected ? 9 : 0,
        height: selected ? 9 : 0,
        decoration: BoxDecoration(color: ink, shape: BoxShape.circle),
      ),
    );
  }
}

/// A boolean row with an inline switch.
class SettingsToggleRow extends StatelessWidget {
  const SettingsToggleRow({
    required this.title,
    required this.value,
    required this.onChanged,
    this.subtitle,
    super.key,
  });

  final String title;
  final String? subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      title: Text(title),
      subtitle: subtitle != null ? Text(subtitle!) : null,
      value: value,
      onChanged: onChanged,
    );
  }
}
