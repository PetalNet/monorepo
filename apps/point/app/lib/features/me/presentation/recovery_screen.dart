import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/features/recovery/recovery_service.dart';
import 'package:point_app/features/recovery/recovery_words.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/confirm_sheet.dart';
import 'package:point_app/widgets/pill_button.dart';

/// Always-reachable account recovery (Wave E), Account → Recovery. Shows the
/// 12-word phrase for THIS account so it can be re-saved, refreshes the
/// encrypted backup, and enrolls if this device never did. Honest throughout:
/// if the phrase is lost, nobody can restore the account.
class RecoveryScreen extends ConsumerStatefulWidget {
  const RecoveryScreen({super.key});

  @override
  ConsumerState<RecoveryScreen> createState() => _RecoveryScreenState();
}

enum _State { loading, phrase, notEnrolled, existsElsewhere, error }

class _RecoveryScreenState extends ConsumerState<RecoveryScreen> {
  _State _state = _State.loading;
  List<String> _words = const [];
  bool _revealed = false;
  bool _busy = false;
  String? _note;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final session = await ref.read(authControllerProvider.future);
      if (session == null || !mounted) return;
      final recovery = ref.read(recoveryServiceProvider);
      final existing = await ref
          .read(apiProvider)
          .getRecoveryBackup(session.token);
      final cached = await recovery.cachedCode(session.userId);
      if (!mounted) return;

      if (cached != null) {
        // We hold the code for this account. If the server backup went missing
        // (a failed first upload, a deleted row), quietly re-upload before
        // showing words the user will trust their account to.
        if (existing == null &&
            !await recovery.refreshBackup(session.token, session.userId)) {
          if (mounted) setState(() => _state = _State.error);
          return;
        }
        if (mounted) {
          setState(() {
            _words = codeToWords(cached);
            _state = _State.phrase;
          });
        }
        return;
      }
      // No local code. If a backup exists on the server, this account already
      // has a phrase from another device — do NOT silently overwrite it; enroll
      // is gated behind an honest confirm below.
      if (mounted) {
        setState(
          () => _state = existing != null
              ? _State.existsElsewhere
              : _State.notEnrolled,
        );
      }
    } on Object {
      if (mounted) setState(() => _state = _State.error);
    }
  }

  Future<void> _enroll() async {
    if (_busy) return;
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    setState(() {
      _busy = true;
      _note = null;
    });
    try {
      final code = await ref
          .read(recoveryServiceProvider)
          .enroll(session.token, session.userId);
      if (!mounted) return;
      setState(() {
        _words = codeToWords(code);
        _revealed = true;
        _state = _State.phrase;
      });
    } on Object {
      if (mounted) setState(() => _note = 'Could not reach your server.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshBackup() async {
    if (_busy) return;
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    setState(() {
      _busy = true;
      _note = null;
    });
    var ok = false;
    try {
      ok = await ref
          .read(recoveryServiceProvider)
          .refreshBackup(session.token, session.userId);
    } on Object {
      ok = false;
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _note = ok
              ? 'Backup updated.'
              : 'Could not update the backup. Try again.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Recovery'),
        actions: [
          IconButton(
            icon: const Icon(Icons.close),
            onPressed: () => context.pop(),
          ),
        ],
      ),
      body: SafeArea(
        child: switch (_state) {
          _State.loading => const Center(
            child: CircularProgressIndicator(strokeWidth: 2.4),
          ),
          _State.error => const _Message(
            title: 'Recovery unavailable',
            body:
                'Could not load your recovery state. Reopen this screen to '
                'try again.',
          ),
          _State.existsElsewhere => ListView(
            padding: EdgeInsets.all(context.space.xl),
            children: [
              Text(
                'This account has a phrase',
                style: context.text.headlineMedium,
              ),
              SizedBox(height: context.space.md),
              Text(
                'A recovery backup is already saved on your server, from '
                'another device. This device does not hold the phrase, so it '
                'cannot show it here. Enter it on a fresh install to restore, '
                'or create a new phrase, which replaces the old one.',
                style: context.text.bodyLarge?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
              if (_note != null) ...[
                SizedBox(height: context.space.md),
                Text(
                  _note!,
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
              SizedBox(height: context.space.xl),
              PillButton(
                label: 'Create a new phrase',
                loading: _busy,
                onPressed: _busy ? null : () => unawaited(_replaceExisting()),
              ),
            ],
          ),
          _State.notEnrolled => ListView(
            padding: EdgeInsets.all(context.space.xl),
            children: [
              Text('Set up recovery', style: context.text.headlineMedium),
              SizedBox(height: context.space.md),
              Text(
                'A recovery phrase is the only way back into your account if '
                'you lose this device. Point is end-to-end encrypted, so no '
                'one can reset it for you, not even us.',
                style: context.text.bodyLarge?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
              if (_note != null) ...[
                SizedBox(height: context.space.md),
                Text(
                  _note!,
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
              SizedBox(height: context.space.xl),
              PillButton(
                label: 'Create a recovery phrase',
                loading: _busy,
                onPressed: _busy ? null : () => unawaited(_enroll()),
              ),
            ],
          ),
          _State.phrase => ListView(
            padding: EdgeInsets.all(context.space.xl),
            children: [
              Text('Your recovery phrase', style: context.text.headlineMedium),
              SizedBox(height: context.space.md),
              Text(
                'These 12 words are the only way back into your account if '
                'you lose your device. Keep them somewhere safe. Anyone with '
                'them can restore your account.',
                style: context.text.bodyMedium?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
              SizedBox(height: context.space.xl),
              if (_revealed)
                _WordGrid(words: _words)
              else
                _HiddenPhrase(onReveal: () => setState(() => _revealed = true)),
              if (_revealed) ...[
                SizedBox(height: context.space.md),
                Align(
                  child: TextButton.icon(
                    onPressed: () => unawaited(
                      Clipboard.setData(
                        ClipboardData(text: _words.join(' ')),
                      ),
                    ),
                    icon: const Icon(Icons.copy_outlined, size: 18),
                    label: const Text('Copy phrase'),
                  ),
                ),
              ],
              const Divider(height: 40),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Update the backup'),
                subtitle: const Text(
                  'Re-encrypt your current keys under this phrase.',
                ),
                trailing: _busy
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.refresh),
                onTap: _busy ? null : () => unawaited(_refreshBackup()),
              ),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Replace my phrase'),
                subtitle: const Text(
                  'Generate a new one; the old stops working.',
                ),
                trailing: const Icon(Icons.chevron_right),
                onTap: _busy ? null : () => unawaited(_replace()),
              ),
              if (_note != null) ...[
                SizedBox(height: context.space.md),
                Text(
                  _note!,
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        },
      ),
    );
  }

  /// Enroll a fresh phrase when the account already has a backup from another
  /// device: gated on an honest confirm because the old phrase stops working.
  Future<void> _replaceExisting() async {
    if (_busy) return;
    final sure = await ConfirmSheet.show(
      context,
      title: 'Replace the existing phrase?',
      body:
          'Your account already has a recovery phrase saved from another '
          'device. A new one replaces it, and the old words stop working.',
      primaryLabel: 'Create a new phrase',
      secondaryLabel: 'Cancel',
    );
    if (!sure || !mounted) return;
    await _enroll();
  }

  Future<void> _replace() async {
    final sure = await ConfirmSheet.show(
      context,
      title: 'Replace your phrase?',
      body:
          'You get a new phrase and the old one stops working. Save the new '
          'words somewhere safe right away.',
      primaryLabel: 'Replace it',
      secondaryLabel: 'Keep the current one',
    );
    if (!sure || !mounted) return;
    await _enroll();
  }
}

/// The 12 words, numbered, two columns, mono.
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
                      padding: EdgeInsets.symmetric(vertical: context.space.xs),
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

/// A tap-to-reveal cover so the phrase isn't shoulder-surfed the instant the
/// screen opens.
class _HiddenPhrase extends StatelessWidget {
  const _HiddenPhrase({required this.onReveal});
  final VoidCallback onReveal;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Reveal recovery phrase',
      child: Material(
        color: context.colors.surfaceContainer,
        borderRadius: context.radii.brMd,
        child: InkWell(
          onTap: onReveal,
          borderRadius: context.radii.brMd,
          child: Container(
            height: 180,
            alignment: Alignment.center,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.visibility_outlined,
                  color: context.colors.onSurfaceVariant,
                ),
                SizedBox(height: context.space.sm),
                Text(
                  'Tap to reveal',
                  style: context.text.titleSmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.title, required this.body});
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(context.space.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title, style: context.text.headlineSmall),
            SizedBox(height: context.space.md),
            Text(
              body,
              textAlign: TextAlign.center,
              style: context.text.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
