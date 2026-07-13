import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/features/people/invite.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/haptics.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/pill_button.dart';

/// Start a temporary share (spec 03). ONE-WAY by default — "my live location for
/// X min", they see you, you don't auto-see them, it auto-expires — with the
/// direction made unmistakable, plus an opt-in "both ways".
class TempShareSheet extends ConsumerStatefulWidget {
  const TempShareSheet({this.person, super.key});

  /// A known person when opened from their detail, or null when starting from
  /// the People add menu and resolving an exact handle first.
  final Person? person;

  static Future<void> show(BuildContext context, Person person) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        sheetAnimationStyle: _animationStyle(context),
        builder: (_) => TempShareSheet(person: person),
      );

  static Future<void> showForHandle(BuildContext context) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        sheetAnimationStyle: _animationStyle(context),
        builder: (_) => const TempShareSheet(),
      );

  static AnimationStyle? _animationStyle(BuildContext context) {
    final preference = ProviderScope.containerOf(
      context,
      listen: false,
    ).read(settingsProvider).motion;
    final reduced =
        preference == MotionPreference.reduced ||
        (preference == MotionPreference.system &&
            MediaQuery.disableAnimationsOf(context));
    return reduced ? AnimationStyle.noAnimation : null;
  }

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
  late Person? _person = widget.person;
  final _handle = TextEditingController();
  String? _handleError;

  @override
  void dispose() {
    _handle.dispose();
    super.dispose();
  }

  void _continueWithHandle() {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    final target = normalizeHandle(
      _handle.text,
      selfDomain: session.userId.split('@').last,
    );
    if (target.isEmpty || !target.contains('@')) {
      setState(() => _handleError = 'Enter an exact Point handle');
      return;
    }
    if (target == session.userId.toLowerCase()) {
      setState(() => _handleError = "That's you.");
      return;
    }
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() {
      _handleError = null;
      _person = Person(
        userId: target,
        displayName: target.split('@').first,
        presence: PresenceState.away,
        subtitle: target,
      );
    });
  }

  Future<void> _start() async {
    final session = ref.read(authControllerProvider).value;
    final person = _person;
    if (session == null || person == null) return;
    Haptics.commit(ref);
    setState(() => _busy = true);
    final name = person.displayName;

    // Step 1: create the temp share. If THIS fails, nothing happened — surface
    // it and keep the sheet open so the user can retry without a duplicate.
    try {
      await ref
          .read(tempSharesControllerProvider.notifier)
          .share(person.userId, minutes: _minutes);
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
            .sendShareRequest(session.token, person.userId);
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
    // Keep auth initialized before an exact-handle submit; a read performed
    // only inside the callback would observe the notifier's initial loading
    // value on this standalone entry path.
    ref.watch(authControllerProvider);
    final person = _person;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          context.space.lg,
          0,
          context.space.lg,
          context.space.lg + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: SingleChildScrollView(
          child: person == null
              ? _buildTargetStep(context)
              : _buildShareStep(context, person),
        ),
      ),
    );
  }

  Widget _buildTargetStep(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Share temporarily', style: context.text.headlineSmall),
        SizedBox(height: context.space.sm),
        Text(
          "They see you. You don't see them.",
          style: context.text.bodyMedium?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
        SizedBox(height: context.space.xl),
        Text('Exact handle', style: context.text.titleMedium),
        SizedBox(height: context.space.sm),
        TextField(
          controller: _handle,
          autocorrect: false,
          enableSuggestions: false,
          keyboardType: TextInputType.emailAddress,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _continueWithHandle(),
          style: context.text.bodyLarge?.copyWith(
            fontFamily: AppTheme.monoFamily,
          ),
          decoration: InputDecoration(
            hintText: 'name@server',
            errorText: _handleError,
            filled: true,
            fillColor: context.colors.surfaceContainerHigh,
            prefixIcon: const Icon(Icons.alternate_email),
            border: OutlineInputBorder(
              borderRadius: context.radii.brSm,
              borderSide: BorderSide.none,
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: context.radii.brSm,
              borderSide: BorderSide(
                color: context.colors.onSurface,
                width: 1.5,
              ),
            ),
          ),
        ),
        SizedBox(height: context.space.lg),
        PillButton(label: 'Continue', onPressed: _continueWithHandle),
      ],
    );
  }

  Widget _buildShareStep(BuildContext context, Person person) {
    final name = person.displayName;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (widget.person == null)
          TextButton.icon(
            onPressed: _busy ? null : () => setState(() => _person = null),
            icon: const Icon(Icons.arrow_back),
            label: const Text('Change person'),
          ),
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
          runSpacing: context.space.sm,
          children: [
            for (final (m, label) in _options)
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 48),
                child: ChoiceChip(
                  label: Text(label),
                  selected: _minutes == m,
                  onSelected: (_) {
                    if (_minutes == m) return;
                    Haptics.selection(ref);
                    setState(() => _minutes = m);
                  },
                ),
              ),
          ],
        ),
        SizedBox(height: context.space.lg),
        SwitchListTile(
          value: _bothWays,
          onChanged: _busy
              ? null
              : (v) {
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
