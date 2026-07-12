import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/features/crypto/crypto_service.dart';
import 'package:point_app/features/crypto/verification.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/pill_button.dart';
import 'package:qr_flutter/qr_flutter.dart';

/// Optional key verification (spec 08). Shows the pairwise safety number (and a
/// QR of it) so two people can compare out-of-band and confirm no one is
/// intercepting. TOFU already secures the happy path — this is the extra
/// assurance, never required.
class VerifySheet extends ConsumerStatefulWidget {
  const VerifySheet({required this.person, super.key});

  final Person person;

  static Future<void> show(BuildContext context, Person person) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (_) => VerifySheet(person: person),
      );

  @override
  ConsumerState<VerifySheet> createState() => _VerifySheetState();
}

class _VerifySheetState extends ConsumerState<VerifySheet> {
  String? _number;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_compute());
  }

  Future<void> _compute() async {
    // Await the resolved session so this works even if opened before auth has
    // finished restoring.
    final me = (await ref.read(authControllerProvider.future))?.userId;
    if (me == null || !mounted) return;
    final gid = CryptoService.pairwiseGroupId(me, widget.person.userId);
    try {
      final n = await ref.read(cryptoServiceProvider).safetyNumber(gid);
      if (mounted) setState(() => _number = n);
    } on Object {
      if (mounted) {
        setState(() => _error =
            "You'll be able to verify once you've both shared and connected.");
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final name = widget.person.displayName;
    final verified = ref.watch(verificationProvider).contains(widget.person.userId);
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
            Text('Verify $name', style: context.text.headlineSmall),
            SizedBox(height: context.space.xs),
            Text(
              'Compare this with the number on $name’s screen. If they '
              'match, your connection is private end to end.',
              style: context.text.bodyMedium
                  ?.copyWith(color: context.colors.onSurfaceVariant),
            ),
            SizedBox(height: context.space.xl),
            if (_error != null)
              _Unavailable(message: _error!)
            else if (_number == null)
              const Center(child: Padding(
                padding: EdgeInsets.all(24),
                child: CircularProgressIndicator(),
              ))
            else
              _SafetyNumber(number: _number!),
            SizedBox(height: context.space.xl),
            if (_number != null)
              verified
                  ? Row(
                      children: [
                        Icon(Icons.verified_user,
                            color: context.colors.onSurface),
                        SizedBox(width: context.space.sm),
                        Text('Verified', style: context.text.titleMedium),
                        const Spacer(),
                        TextButton(
                          onPressed: () => ref
                              .read(verificationProvider.notifier)
                              .clear(widget.person.userId),
                          child: const Text('Unverify'),
                        ),
                      ],
                    )
                  : PillButton(
                      label: 'They match — mark verified',
                      onPressed: () async {
                        await ref
                            .read(verificationProvider.notifier)
                            .markVerified(widget.person.userId);
                        if (context.mounted) await context.pop();
                      },
                    ),
          ],
        ),
      ),
    );
  }
}

/// The safety number as a QR (to scan-compare) + the digits (to read-compare).
class _SafetyNumber extends StatelessWidget {
  const _SafetyNumber({required this.number});
  final String number;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          padding: EdgeInsets.all(context.space.lg),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: context.radii.brLg,
          ),
          child: QrImageView(
            data: number,
            size: 180,
            backgroundColor: Colors.white,
          ),
        ),
        SizedBox(height: context.space.lg),
        Text(
          number,
          textAlign: TextAlign.center,
          style: context.text.titleLarge?.copyWith(
            fontFamily: AppTheme.monoFamily,
            letterSpacing: 1,
          ),
        ),
      ],
    );
  }
}

class _Unavailable extends StatelessWidget {
  const _Unavailable({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.all(context.space.lg),
      decoration: BoxDecoration(
        color: context.colors.surfaceContainerHigh,
        borderRadius: context.radii.brMd,
      ),
      child: Text(
        message,
        style: context.text.bodyMedium
            ?.copyWith(color: context.colors.onSurfaceVariant),
      ),
    );
  }
}
