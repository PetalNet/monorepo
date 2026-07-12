import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/onboarding/onboarding_flow.dart';
import 'package:point_app/features/onboarding/onboarding_gate.dart';
import 'package:point_app/features/onboarding/presentation/onboarding_scaffold.dart';
import 'package:point_app/features/recovery/recovery_service.dart';
import 'package:point_app/features/recovery/recovery_words.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/pill_button.dart';
import 'package:point_app/widgets/tonal_field.dart';

/// Onboarding: save the recovery phrase (locked copy). A brand-new account
/// enrolls immediately and shows its 12 words. An account that already has a
/// server backup (signing in on a new device) is offered the honest fork
/// first: restore with the existing phrase, or start over with a new one.
class RecoverySaveScreen extends ConsumerStatefulWidget {
  const RecoverySaveScreen({super.key});

  @override
  ConsumerState<RecoverySaveScreen> createState() => _RecoverySaveScreenState();
}

enum _Mode { loading, words, restoreChoice, restore, error }

class _RecoverySaveScreenState extends ConsumerState<RecoverySaveScreen> {
  _Mode _mode = _Mode.loading;
  List<String> _words = const [];
  String? _error;
  bool _busy = false;
  final _phraseInput = TextEditingController();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _phraseInput.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    // Await (don't just read): on a cold resume this screen can build while
    // the persisted session is still restoring.
    final session = await ref.read(authControllerProvider.future);
    if (session == null) return;
    final recovery = ref.read(recoveryServiceProvider);
    try {
      // Already enrolled on this device: just re-show the phrase.
      final cached = await recovery.cachedCode();
      if (cached != null) {
        _show(_Mode.words, words: codeToWords(cached));
        return;
      }
      // A backup already on the server means this account has a phrase from
      // another device: offer restore before anything destructive.
      final api = ref.read(apiProvider);
      final existing = await api.getRecoveryBackup(session.token);
      if (existing != null) {
        _show(_Mode.restoreChoice);
        return;
      }
      await _enroll(session.token);
    } on Object {
      _show(
        _Mode.error,
        error: 'Could not reach your server. Check the connection and retry.',
      );
    }
  }

  Future<void> _enroll(String token) async {
    final code = await ref.read(recoveryServiceProvider).enroll(token);
    _show(_Mode.words, words: codeToWords(code));
  }

  void _show(_Mode mode, {List<String> words = const [], String? error}) {
    if (!mounted) return;
    setState(() {
      _mode = mode;
      _words = words;
      _error = error;
    });
  }

  Future<void> _confirmSaved() async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      builder: (context) => const _SavedConfirmSheet(),
    );
    if (saved != true || !mounted) return;
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    await ref.read(onboardingGateProvider).markRecoverySaved(session.userId);
    if (!mounted) return;
    await continueOnboarding(ref, context.router<AppRoute>());
  }

  Future<void> _restore() async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final relay = ref.read(relayControllerProvider);
    try {
      final code = parseRecoveryInput(_phraseInput.text);
      // Quiesce the relay while the identity underneath it is swapped.
      await relay.stop();
      final ok = await ref
          .read(recoveryServiceProvider)
          .restore(
            token: session.token,
            identity: session.userId,
            code: code,
          );
      await relay.start(session);
      if (!ok) {
        setState(() => _error = 'No backup found for this account.');
        return;
      }
      // The restored identity replaces whatever pool sign-in uploaded.
      await relay.reprovisionKeyPackages();
      await ref.read(onboardingGateProvider).markRecoverySaved(session.userId);
      if (!mounted) return;
      await continueOnboarding(ref, context.router<AppRoute>());
    } on FormatException {
      setState(
        () => _error =
            'That does not read as a recovery phrase. '
            'Enter the 12 words with spaces between them.',
      );
    } on RecoveryFailure catch (e) {
      setState(() => _error = e.message);
    } on Object {
      setState(() => _error = 'Something failed on the way. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Start over with a fresh phrase, replacing the old backup. Gated on an
  /// honest confirm because the old phrase stops working.
  Future<void> _startFresh() async {
    final sure = await showModalBottomSheet<bool>(
      context: context,
      builder: (context) => const _ReplaceBackupSheet(),
    );
    if (sure != true || !mounted) return;
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    setState(() => _busy = true);
    try {
      await _enroll(session.token);
      // The fresh identity replaces the old device's now-orphaned pool.
      await ref.read(relayControllerProvider).reprovisionKeyPackages();
    } on Object {
      _show(
        _Mode.error,
        error: 'Could not reach your server. Check the connection and retry.',
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return switch (_mode) {
      _Mode.loading => const Scaffold(
        body: Center(child: CircularProgressIndicator(strokeWidth: 2.4)),
      ),
      _Mode.error => OnboardingScaffold(
        step: OnboardingProgress.recovery,
        headline: 'Save your\nrecovery phrase',
        body: _error ?? '',
        primaryLabel: 'Retry',
        onPrimary: () {
          _show(_Mode.loading);
          unawaited(_load());
        },
      ),
      _Mode.words => OnboardingScaffold(
        step: OnboardingProgress.recovery,
        headline: 'Save your\nrecovery phrase',
        body:
            'These words are the only way back into your account if you '
            'lose your device. Point is end-to-end encrypted, so no one '
            'can reset them for you, not even us. Write them down or keep '
            'them in your password manager.',
        primaryLabel: 'I saved it.',
        onPrimary: _confirmSaved,
        children: [
          _WordGrid(words: _words),
          SizedBox(height: context.space.md),
          Align(
            child: TextButton.icon(
              onPressed: () async {
                await Clipboard.setData(
                  ClipboardData(text: _words.join(' ')),
                );
              },
              icon: const Icon(Icons.copy_outlined, size: 18),
              label: const Text('Copy phrase'),
            ),
          ),
        ],
      ),
      _Mode.restoreChoice => OnboardingScaffold(
        step: OnboardingProgress.recovery,
        headline: 'This account has\na recovery phrase',
        body:
            'A backup from another device is already saved on your '
            'server. Restoring with your phrase brings your keys and your '
            'shares to this device.',
        primaryLabel: 'Enter my phrase',
        onPrimary: () => _show(_Mode.restore),
        secondaryLabel: 'Start over with a new phrase',
        onSecondary: _busy ? null : _startFresh,
      ),
      _Mode.restore => OnboardingScaffold(
        step: OnboardingProgress.recovery,
        headline: 'Enter your\nrecovery phrase',
        body:
            'Type the 12 words you saved, in order. The backup is '
            'decrypted right here on this device.',
        primaryLabel: 'Restore',
        primaryLoading: _busy,
        onPrimary: _busy ? null : _restore,
        secondaryLabel: 'Back',
        onSecondary: _busy ? null : () => _show(_Mode.restoreChoice),
        children: [
          TonalField(
            controller: _phraseInput,
            label: 'Recovery phrase',
            hint: 'valley motion nature ...',
            maxLines: 3,
            mono: true,
          ),
          if (_error != null) ...[
            SizedBox(height: context.space.md),
            Text(
              _error!,
              style: context.text.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    };
  }
}

/// The 12 words, numbered, two columns, mono. High-contrast tonal panel so
/// the phrase reads as one saveable object.
class _WordGrid extends StatelessWidget {
  const _WordGrid({required this.words});
  final List<String> words;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.all(context.space.lg),
      decoration: BoxDecoration(
        color: context.colors.surfaceContainer,
        borderRadius: context.radii.brMd,
      ),
      child: Row(
        children: [
          for (final half in [0, 6]) ...[
            if (half > 0) SizedBox(width: context.space.lg),
            Expanded(
              child: Column(
                children: [
                  for (var i = half; i < half + 6 && i < words.length; i++)
                    Padding(
                      padding: EdgeInsets.symmetric(
                        vertical: context.space.xs,
                      ),
                      child: Row(
                        children: [
                          SizedBox(
                            width: 24,
                            child: Text(
                              '${i + 1}',
                              style: context.text.bodySmall?.copyWith(
                                fontFamily: 'JetBrains Mono',
                                color: context.colors.onSurfaceVariant,
                              ),
                            ),
                          ),
                          Expanded(
                            child: Text(
                              words[i],
                              style: context.text.titleMedium?.copyWith(
                                fontFamily: 'JetBrains Mono',
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// The stored-it-somewhere-safe gate beneath "I saved it."
class _SavedConfirmSheet extends StatelessWidget {
  const _SavedConfirmSheet();

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          context.space.xl,
          context.space.md,
          context.space.xl,
          context.space.xl,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Stored somewhere safe?', style: context.text.headlineSmall),
            SizedBox(height: context.space.md),
            Text(
              'If these words are lost, no one can bring the account back. '
              'Not even us.',
              style: context.text.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            SizedBox(height: context.space.xl),
            PillButton(
              label: 'Yes, it is saved',
              onPressed: () => Navigator.of(context).pop(true),
            ),
            SizedBox(height: context.space.xs),
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Not yet'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Honest confirm before replacing an existing backup with a fresh phrase.
class _ReplaceBackupSheet extends StatelessWidget {
  const _ReplaceBackupSheet();

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          context.space.xl,
          context.space.md,
          context.space.xl,
          context.space.xl,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Replace the old backup?', style: context.text.headlineSmall),
            SizedBox(height: context.space.md),
            Text(
              'You get a new phrase and the old one stops working. Your '
              'people stay, but encrypted history from the old device does '
              'not come along.',
              style: context.text.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            SizedBox(height: context.space.xl),
            PillButton(
              label: 'Replace it',
              onPressed: () => Navigator.of(context).pop(true),
            ),
            SizedBox(height: context.space.xs),
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Go back'),
            ),
          ],
        ),
      ),
    );
  }
}
