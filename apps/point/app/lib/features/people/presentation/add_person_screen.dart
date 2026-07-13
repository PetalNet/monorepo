import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/features/me/me_profile_provider.dart';
import 'package:point_app/features/people/invite.dart';
import 'package:point_app/features/people/presentation/people_screen.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/pill_button.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

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
  late final TextEditingController _handle = TextEditingController(
    text: widget.prefillHandle ?? '',
  );
  bool _busy = false;
  String? _error;
  String? _sentTarget;

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
      setState(() => _error = 'Enter a handle or Point invite code');
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
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.message;
        });
      }
      return;
    } on Object {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = 'Could not send the request.';
        });
      }
      return;
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _sentTarget = target;
    });
    try {
      await ref.read(outgoingRequestsControllerProvider.notifier).refresh();
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Sent. Pull to refresh requests.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final myId = ref.watch(authControllerProvider).value?.userId ?? '';
    final sentTarget = _sentTarget;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Add a person'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => context.pop(),
        ),
      ),
      body: sentTarget != null
          ? _RequestedState(
              target: sentTarget,
              onDone: () => context.pop(),
              onViewRequests: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const RequestsScreen(),
                ),
              ),
            )
          : SafeArea(
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
                      style: context.text.bodySmall?.copyWith(
                        color: context.colors.onSurfaceVariant,
                      ),
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
                    style: context.text.bodyMedium?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                  SizedBox(height: context.space.lg),
                  const _InviteBlockedNote(),
                  if (myId.isNotEmpty) InviteCard(userId: myId),
                ],
              ),
            ),
    );
  }
}

class _RequestedState extends StatelessWidget {
  const _RequestedState({
    required this.target,
    required this.onDone,
    required this.onViewRequests,
  });

  final String target;
  final VoidCallback onDone;
  final VoidCallback onViewRequests;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Padding(
            padding: EdgeInsets.all(context.space.xl),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.schedule,
                  color: context.colors.onSurface,
                ),
                SizedBox(height: context.space.lg),
                Text('Requested', style: context.text.headlineSmall),
                SizedBox(height: context.space.sm),
                Text(
                  target,
                  textAlign: TextAlign.center,
                  style: context.text.bodyMedium?.copyWith(
                    fontFamily: AppTheme.monoFamily,
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
                SizedBox(height: context.space.sm),
                Text(
                  'Pending',
                  style: context.text.labelLarge?.copyWith(
                    color: context.colors.onSurface,
                  ),
                ),
                SizedBox(height: context.space.xl),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: onViewRequests,
                    child: const Text('View requests'),
                  ),
                ),
                SizedBox(height: context.space.sm),
                SizedBox(
                  width: double.infinity,
                  child: TextButton(
                    onPressed: onDone,
                    child: const Text('Done'),
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
        hintText: 'name, name@server, or invite code',
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
            style: context.text.labelMedium?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ),
        Expanded(child: Divider(color: context.colors.outline)),
      ],
    );
  }
}

typedef InviteShareCallback = Future<void> Function(String text, Rect origin);

Future<void> _shareInviteWithSystem(String text, Rect origin) async {
  await SharePlus.instance.share(
    ShareParams(
      text: text,
      subject: 'Add me on Point',
      sharePositionOrigin: origin,
    ),
  );
}

/// A high-contrast QR card plus native sharing and a checksummed fallback code.
/// The callback seam keeps the share-sheet state transition deterministic in
/// widget tests without replacing the production platform integration.
class InviteCard extends StatefulWidget {
  const InviteCard({
    required this.userId,
    this.onShare = _shareInviteWithSystem,
    super.key,
  });

  final String userId;
  final InviteShareCallback onShare;

  @override
  State<InviteCard> createState() => _InviteCardState();
}

class _InviteCardState extends State<InviteCard> {
  bool _sharing = false;

  Future<void> _share() async {
    if (_sharing) return;
    setState(() => _sharing = true);
    final box = context.findRenderObject()! as RenderBox;
    final origin = box.localToGlobal(Offset.zero) & box.size;
    try {
      await widget.onShare(inviteShareTextFor(widget.userId), origin);
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not open the share sheet.')),
        );
      }
    } finally {
      if (mounted) setState(() => _sharing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final link = inviteLinkFor(widget.userId);
    final code = inviteCodeFor(widget.userId);
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
          widget.userId,
          textAlign: TextAlign.center,
          style: context.text.titleMedium?.copyWith(
            fontFamily: AppTheme.monoFamily,
            letterSpacing: 0,
          ),
        ),
        SizedBox(height: context.space.sm),
        Text(
          'No QR? Enter this code',
          style: context.text.bodySmall?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
        SizedBox(height: context.space.xs),
        Semantics(
          label: 'Invite code $code',
          child: SelectableText(
            code,
            textAlign: TextAlign.center,
            style: context.text.titleSmall?.copyWith(
              fontFamily: AppTheme.monoFamily,
              letterSpacing: 0,
            ),
          ),
        ),
        SizedBox(height: context.space.md),
        SizedBox(
          width: double.infinity,
          child: FilledButton.icon(
            onPressed: _sharing ? null : _share,
            icon: Icon(_sharing ? Icons.hourglass_top : Icons.ios_share),
            label: Text(_sharing ? 'Sharing…' : 'Share invite'),
          ),
        ),
        SizedBox(height: context.space.sm),
        SizedBox(
          width: double.infinity,
          child: OutlinedButton.icon(
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
        ),
      ],
    );
  }
}

/// Honest warning when the owner's own privacy setting would swallow the
/// invites they hand out: "Who can add you: No one" silently drops every
/// inbound request, including ones from this QR.
class _InviteBlockedNote extends ConsumerWidget {
  const _InviteBlockedNote();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProfileProvider).value;
    if (me == null || me.whoCanAddMe == 'anyone') {
      return const SizedBox.shrink();
    }
    final blocked = me.whoCanAddMe == 'nobody';
    return Padding(
      padding: EdgeInsets.only(bottom: context.space.lg),
      child: Container(
        padding: EdgeInsets.all(context.space.md),
        decoration: BoxDecoration(
          color: context.colors.surfaceContainer,
          borderRadius: context.radii.brSm,
        ),
        child: Text(
          blocked
              ? 'Your privacy setting is "No one", so requests from this '
                    'invite will not reach you. Loosen it under Privacy '
                    'first.'
              : 'Your privacy setting only allows people on your server, so '
                    'this invite will not work across servers.',
          style: context.text.bodySmall?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}
