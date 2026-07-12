import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/features/me/avatar_image.dart';
import 'package:point_app/features/me/avatar_provider.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/photo_dot.dart';
import 'package:point_app/widgets/pill_button.dart';
import 'package:point_app/widgets/tonal_field.dart';

/// The identity editor: your name and your photo-dot, exactly what your
/// people see.
class IdentityScreen extends ConsumerStatefulWidget {
  const IdentityScreen({super.key});

  @override
  ConsumerState<IdentityScreen> createState() => _IdentityScreenState();
}

class _IdentityScreenState extends ConsumerState<IdentityScreen> {
  late final TextEditingController _name;
  bool _busy = false;
  String? _note;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(
      text: ref.read(authControllerProvider).value?.displayName ?? '',
    );
    // A cold resume can build this screen before the session restores; fill
    // the field once it lands (without clobbering anything already typed).
    unawaited(
      ref.read(authControllerProvider.future).then((s) {
        if (mounted && s != null && _name.text.isEmpty) {
          _name.text = s.displayName;
        }
      }),
    );
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _pickPhoto() async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    final picked = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      maxWidth: 1200,
      maxHeight: 1200,
    );
    if (picked == null || !mounted) return;
    setState(() {
      _busy = true;
      _note = null;
    });
    try {
      final raw = await picked.readAsBytes();
      final jpeg = await compute(preparePhotoDot, raw);
      if (jpeg == null) {
        setState(() => _note = 'That file does not read as a photo.');
        return;
      }
      await ref
          .read(apiProvider)
          .uploadAvatar(session.token, jpeg, mime: 'image/jpeg');
      ref.invalidate(avatarProvider(session.userId));
    } on Object {
      if (mounted) {
        setState(() => _note = 'Could not upload the photo. Try again.');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _removePhoto() async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    setState(() {
      _busy = true;
      _note = null;
    });
    try {
      await ref.read(apiProvider).deleteAvatar(session.token);
      ref.invalidate(avatarProvider(session.userId));
    } on Object {
      if (mounted) setState(() => _note = 'Could not remove it. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _note = 'A name is what your people see. Keep one.');
      return;
    }
    setState(() {
      _busy = true;
      _note = null;
    });
    try {
      final accepted = await ref
          .read(apiProvider)
          .updateProfile(session.token, name);
      await ref
          .read(authControllerProvider.notifier)
          .updateDisplayName(accepted);
      if (!mounted) return;
      await context.pop();
    } on Object {
      if (mounted) setState(() => _note = 'Could not save. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(authControllerProvider).value;
    if (session == null) return const SizedBox.shrink();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Your identity'),
        actions: [
          IconButton(
            icon: const Icon(Icons.close),
            onPressed: () => context.pop(),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: EdgeInsets.all(context.space.xl),
          children: [
            Center(
              child: PhotoDot(
                userId: session.userId,
                name: session.displayName,
                size: 96,
              ),
            ),
            SizedBox(height: context.space.md),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                TextButton(
                  onPressed: _busy ? null : () => unawaited(_pickPhoto()),
                  child: const Text('Change photo'),
                ),
                SizedBox(width: context.space.md),
                TextButton(
                  onPressed: _busy ? null : () => unawaited(_removePhoto()),
                  child: const Text('Remove'),
                ),
              ],
            ),
            SizedBox(height: context.space.xl),
            TonalField(controller: _name, label: 'Display name'),
            SizedBox(height: context.space.sm),
            Text(
              'Your handle stays @${session.handle}. The name and photo are '
              'what your people see.',
              style: context.text.bodySmall?.copyWith(
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
              label: 'Save',
              loading: _busy,
              onPressed: _busy ? null : () => unawaited(_save()),
            ),
          ],
        ),
      ),
    );
  }
}
