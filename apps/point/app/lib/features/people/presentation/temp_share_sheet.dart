import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/pill_button.dart';

/// Start a temporary share (spec 03). ONE-WAY by default — "my live location for
/// X min", they see you, you don't auto-see them, it auto-expires — with the
/// direction made unmistakable, plus an opt-in "both ways".
class TempShareSheet extends ConsumerStatefulWidget {
  const TempShareSheet({required this.person, super.key});

  final Person person;

  static Future<void> show(BuildContext context, Person person) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (_) => TempShareSheet(person: person),
      );

  @override
  ConsumerState<TempShareSheet> createState() => _TempShareSheetState();
}

class _TempShareSheetState extends ConsumerState<TempShareSheet> {
  static const _options = [
    (15, '15 min'),
    (60, '1 hour'),
    (480, '8 hours'),
  ];
  int _minutes = 60;
  bool _bothWays = false;
  bool _busy = false;

  Future<void> _start() async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    Haptics.commit(ref);
    setState(() => _busy = true);
    final name = widget.person.displayName;

    // Step 1: create the temp share. If THIS fails, nothing happened — surface
    // it and keep the sheet open so the user can retry without a duplicate.
    try {
      await ref
          .read(tempSharesControllerProvider.notifier)
          .share(widget.person.userId, minutes: _minutes);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
        setState(() => _busy = false);
      }
      return;
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("Couldn't start the share.")),
        );
        setState(() => _busy = false);
      }
      return;
    }

    // Step 2: the temp IS live now. "Both ways" additionally asks them to share
    // back — a real ongoing request. If only THIS fails, the temp still stands,
    // so report the partial outcome rather than a total failure (and never
    // re-run step 1, which would duplicate the temp).
    var askedBack = _bothWays;
    if (_bothWays) {
      try {
        await ref
            .read(apiProvider)
            .sendShareRequest(session.token, widget.person.userId);
      } on Object {
        askedBack = false;
      }
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          _bothWays
              ? (askedBack
                    ? 'Sharing with $name; asked them to share back'
                    : "Sharing with $name; couldn't ask them to share back")
              : '$name can see you for ${_label(_minutes)}',
        ),
      ),
    );
    await context.pop();
  }

  String _label(int m) => _options.firstWhere((o) => o.$1 == m).$2;

  @override
  Widget build(BuildContext context) {
    final name = widget.person.displayName;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          context.space.lg,
          0,
          context.space.lg,
          context.space.lg,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Share with $name for a while',
              style: context.text.headlineSmall,
            ),
            SizedBox(height: context.space.md),
            _DirectionCard(name: name, bothWays: _bothWays),
            SizedBox(height: context.space.xl),
            Text('For how long', style: context.text.titleMedium),
            SizedBox(height: context.space.sm),
            Wrap(
              spacing: context.space.sm,
              children: [
                for (final (m, label) in _options)
                  ChoiceChip(
                    label: Text(label),
                    selected: _minutes == m,
                    onSelected: (_) {
                      if (_minutes == m) return;
                      Haptics.selection(ref);
                      setState(() => _minutes = m);
                    },
                  ),
              ],
            ),
            SizedBox(height: context.space.lg),
            SwitchListTile(
              value: _bothWays,
              onChanged: (v) {
                Haptics.selection(ref);
                setState(() => _bothWays = v);
              },
              title: const Text('Both ways'),
              subtitle: Text(
                'Also ask $name to share their location with you.',
                style: context.text.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
              contentPadding: EdgeInsets.zero,
            ),
            SizedBox(height: context.space.lg),
            PillButton(
              label: 'Start sharing',
              loading: _busy,
              onPressed: _busy ? null : _start,
            ),
          ],
        ),
      ),
    );
  }
}

/// The unmistakable direction indicator: an arrow FROM you TO them (or a
/// two-headed arrow for both ways).
class _DirectionCard extends StatelessWidget {
  const _DirectionCard({required this.name, required this.bothWays});
  final String name;
  final bool bothWays;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.all(context.space.lg),
      decoration: BoxDecoration(
        color: context.colors.surfaceContainerHigh,
        borderRadius: context.radii.brMd,
      ),
      child: Row(
        children: [
          Icon(
            bothWays ? Icons.sync_alt : Icons.arrow_forward,
            color: context.colors.onSurface,
          ),
          SizedBox(width: context.space.md),
          Expanded(
            child: Text(
              bothWays
                  ? 'You and $name see each other.'
                  : "$name sees your live location. You won't see them.",
              style: context.text.bodyMedium,
            ),
          ),
        ],
      ),
    );
  }
}
