import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/features/people/invite.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/pill_button.dart';
import 'package:qr_flutter/qr_flutter.dart';

/// Add a person (spec 01): two paths, no public search. Type their exact handle
/// (`name` on your server, or `name@server` across servers) to send a request,
/// or share your own invite link/QR for them to tap. Both create a pending
/// request the other accepts.
class AddPersonScreen extends ConsumerStatefulWidget {
  const AddPersonScreen({this.prefillHandle, super.key});

  /// When opened from a tapped invite link, the inviter's handle is prefilled.
  final String? prefillHandle;

  @override
  ConsumerState<AddPersonScreen> createState() => _AddPersonScreenState();
}

class _AddPersonScreenState extends ConsumerState<AddPersonScreen> {
  late final TextEditingController _handle =
      TextEditingController(text: widget.prefillHandle ?? '');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _handle.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    final selfDomain = session.userId.split('@').last;
    final target = normalizeHandle(_handle.text, selfDomain: selfDomain);
    if (target.isEmpty || !target.contains('@')) {
      setState(() => _error = 'Enter a handle like name or name@server');
      return;
    }
    if (target == session.userId.toLowerCase()) {
      setState(() => _error = "That's you.");
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiProvider).sendShareRequest(session.token, target);
      await ref.read(requestsControllerProvider.notifier).refresh();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Request sent to $target')),
      );
      await context.pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } on Object {
      if (mounted) setState(() => _error = 'Could not send the request.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final myId = ref.watch(authControllerProvider).value?.userId ?? '';
    return Scaffold(
      appBar: AppBar(
        title: const Text('Add a person'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => context.pop(),
        ),
      ),
      body: SafeArea(
        child: ListView(
          padding: EdgeInsets.all(context.space.xl),
          children: [
            Text('By handle', style: context.text.titleMedium),
            SizedBox(height: context.space.sm),
            _HandleField(
              controller: _handle,
              onSubmitted: _busy ? null : (_) => _send(),
            ),
            if (_error != null) ...[
              SizedBox(height: context.space.sm),
              Text(
                _error!,
                style: context.text.bodySmall
                    ?.copyWith(color: context.colors.onSurfaceVariant),
              ),
            ],
            SizedBox(height: context.space.lg),
            PillButton(
              label: 'Send request',
              loading: _busy,
              onPressed: _busy ? null : _send,
            ),
            SizedBox(height: context.space.xxl),
            const _OrDivider(),
            SizedBox(height: context.space.xxl),
            Text('Your invite', style: context.text.titleMedium),
            SizedBox(height: context.space.xs),
            Text(
              'Let someone scan or tap this to add you.',
              style: context.text.bodyMedium
                  ?.copyWith(color: context.colors.onSurfaceVariant),
            ),
            SizedBox(height: context.space.lg),
            if (myId.isNotEmpty) _InviteCard(userId: myId),
          ],
        ),
      ),
    );
  }
}

class _HandleField extends StatelessWidget {
  const _HandleField({required this.controller, this.onSubmitted});
  final TextEditingController controller;
  final ValueChanged<String>? onSubmitted;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      autocorrect: false,
      enableSuggestions: false,
      keyboardType: TextInputType.emailAddress,
      textInputAction: TextInputAction.send,
      onSubmitted: onSubmitted,
      style: context.text.bodyLarge?.copyWith(fontFamily: AppTheme.monoFamily),
      decoration: InputDecoration(
        hintText: 'name  or  name@server',
        filled: true,
        fillColor: context.colors.surfaceContainer,
        prefixIcon: const Icon(Icons.alternate_email),
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

class _OrDivider extends StatelessWidget {
  const _OrDivider();
  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(child: Divider(color: context.colors.outline)),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: context.space.md),
          child: Text(
            'OR',
            style: context.text.labelMedium
                ?.copyWith(color: context.colors.onSurfaceVariant),
          ),
        ),
        Expanded(child: Divider(color: context.colors.outline)),
      ],
    );
  }
}

/// A white QR card (scannable in either theme) of the invite link, plus the
/// handle and a copy action.
class _InviteCard extends StatelessWidget {
  const _InviteCard({required this.userId});
  final String userId;

  @override
  Widget build(BuildContext context) {
    final link = inviteLinkFor(userId);
    return Column(
      children: [
        Container(
          padding: EdgeInsets.all(context.space.lg),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: context.radii.brLg,
          ),
          child: QrImageView(
            data: link,
            size: 200,
            backgroundColor: Colors.white,
          ),
        ),
        SizedBox(height: context.space.md),
        SelectableText(
          userId,
          textAlign: TextAlign.center,
          style: context.text.titleMedium?.copyWith(
            fontFamily: AppTheme.monoFamily,
            letterSpacing: 0,
          ),
        ),
        SizedBox(height: context.space.md),
        OutlinedButton.icon(
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: link));
            if (context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Invite link copied')),
              );
            }
          },
          icon: const Icon(Icons.copy),
          label: const Text('Copy invite link'),
        ),
      ],
    );
  }
}
