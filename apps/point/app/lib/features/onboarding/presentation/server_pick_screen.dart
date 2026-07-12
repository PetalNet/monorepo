import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/onboarding/presentation/onboarding_scaffold.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/server_config.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/tonal_field.dart';

/// First-run step 1: choose the home server. The address is checked against a
/// real `/.well-known/point` fetch before it is accepted, so a typo fails
/// here, not at sign-in.
class ServerPickScreen extends HookConsumerWidget {
  const ServerPickScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final server = useTextEditingController(text: ref.read(serverUrlProvider));
    final checking = useState(false);
    final error = useState<String?>(null);

    Future<void> submit() async {
      final origin = ServerUrlNotifier.normalize(server.text);
      checking.value = true;
      error.value = null;
      try {
        await PointApi.probe(origin);
        await ref.read(serverUrlProvider.notifier).set(origin);
        if (context.mounted) await context.push(const LoginRoute());
      } on ApiException catch (e) {
        error.value = switch (e.statusCode) {
          0 => 'That address did not answer. Check it and try again.',
          _ => 'That address answers, but not as a Point server.',
        };
      } finally {
        checking.value = false;
      }
    }

    return OnboardingScaffold(
      step: OnboardingProgress.server,
      headline: 'Your home\nserver.',
      body:
          'Point is not one big service. Your account lives on a server '
          'run by someone you trust, and it can talk to people on every '
          'other Point server. If you are not sure, keep the default.',
      primaryLabel: 'Continue',
      primaryLoading: checking.value,
      onPrimary: checking.value ? null : submit,
      children: [
        TonalField(
          controller: server,
          label: 'Server address',
          keyboardType: TextInputType.url,
        ),
        if (error.value != null) ...[
          SizedBox(height: context.space.md),
          Text(
            error.value!,
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ],
        SizedBox(height: context.space.lg),
        Text(
          'Anyone can run one. Yours federates with the rest, so you and '
          'your people never have to be on the same server.',
          style: context.text.bodySmall?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}
