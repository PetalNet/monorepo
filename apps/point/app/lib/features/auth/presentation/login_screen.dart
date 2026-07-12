import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/services/server_config.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/pill_button.dart';
import 'package:point_app/widgets/tonal_field.dart';

/// Sign-in / register, OUTSIDE the shell (D-015). Bold monochrome: big
/// Schibsted headline, tonal fields, a full-width pill primary. The home
/// server was chosen one step back (server pick); a quiet row here says
/// which one and offers the way back.
class LoginScreen extends HookConsumerWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final registering = useState(false);
    final username = useTextEditingController();
    final password = useTextEditingController();
    final invite = useTextEditingController();
    final displayName = useTextEditingController();

    final serverUrl = ref.watch(serverUrlProvider);
    final serverHost = Uri.tryParse(serverUrl)?.host ?? serverUrl;

    final auth = ref.watch(authControllerProvider);
    final busy = auth.isLoading;
    final error = auth.hasError ? auth.error.toString() : null;

    Future<void> submit() async {
      final ctrl = ref.read(authControllerProvider.notifier);
      if (registering.value) {
        await ctrl.register(
          username: username.text.trim(),
          password: password.text,
          displayName: displayName.text.trim().isEmpty
              ? null
              : displayName.text.trim(),
          inviteCode: invite.text.trim().isEmpty ? null : invite.text.trim(),
        );
      } else {
        await ctrl.login(username.text.trim(), password.text);
      }
    }

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: ListView(
              padding: EdgeInsets.all(context.space.xl),
              shrinkWrap: true,
              children: [
                Row(
                  children: [
                    Container(
                      width: 12,
                      height: 12,
                      decoration: BoxDecoration(
                        color: context.colors.onSurface,
                        shape: BoxShape.circle,
                      ),
                    ),
                    SizedBox(width: context.space.sm),
                    Text('Point', style: context.text.titleLarge),
                  ],
                ),
                SizedBox(height: context.space.xxl),
                Text(
                  registering.value ? 'Make an\naccount.' : 'Welcome\nback.',
                  style: context.text.displaySmall,
                ),
                SizedBox(height: context.space.xl),
                TonalField(controller: username, label: 'Username'),
                SizedBox(height: context.space.md),
                TonalField(
                  controller: password,
                  label: 'Password',
                  obscure: true,
                ),
                if (registering.value) ...[
                  SizedBox(height: context.space.md),
                  TonalField(
                    controller: displayName,
                    label: 'Display name (optional)',
                  ),
                  SizedBox(height: context.space.md),
                  TonalField(
                    controller: invite,
                    label: 'Invite code (if required)',
                  ),
                ],
                SizedBox(height: context.space.md),
                _ServerRow(host: serverHost, busy: busy),
                if (error != null) ...[
                  SizedBox(height: context.space.md),
                  Text(
                    error,
                    style: context.text.bodySmall?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                ],
                SizedBox(height: context.space.xl),
                PillButton(
                  label: registering.value ? 'Create account' : 'Sign in',
                  loading: busy,
                  onPressed: busy ? null : submit,
                ),
                SizedBox(height: context.space.md),
                TextButton(
                  onPressed: busy
                      ? null
                      : () => registering.value = !registering.value,
                  child: Text(
                    registering.value
                        ? 'Have an account? Sign in'
                        : 'New here? Create an account',
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

/// The chosen home server, one tap from changing it (pops back to the
/// server-pick step beneath this screen).
class _ServerRow extends StatelessWidget {
  const _ServerRow({required this.host, required this.busy});
  final String host;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Server $host. Change server.',
      child: Material(
        color: context.colors.surfaceContainer,
        borderRadius: context.radii.brSm,
        child: InkWell(
          onTap: busy ? null : () => context.pop(),
          borderRadius: context.radii.brSm,
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: context.space.lg,
              vertical: context.space.md,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'SERVER',
                        style: context.text.labelSmall?.copyWith(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                      SizedBox(height: context.space.xs / 2),
                      Text(
                        host,
                        style: context.text.bodyLarge?.copyWith(
                          fontFamily: 'JetBrains Mono',
                        ),
                      ),
                    ],
                  ),
                ),
                Text(
                  'Change',
                  style: context.text.labelLarge?.copyWith(
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
