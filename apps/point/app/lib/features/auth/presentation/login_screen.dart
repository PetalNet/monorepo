import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/pill_button.dart';

/// Sign-in / register, OUTSIDE the shell (D-015). Bold monochrome: big
/// Schibsted headline, tonal fields, a full-width pill primary.
class LoginScreen extends HookConsumerWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final registering = useState(false);
    final username = useTextEditingController();
    final password = useTextEditingController();
    final invite = useTextEditingController();
    final displayName = useTextEditingController();

    final auth = ref.watch(authControllerProvider);
    final busy = auth.isLoading;
    final error = auth.hasError ? auth.error.toString() : null;

    Future<void> submit() async {
      final ctrl = ref.read(authControllerProvider.notifier);
      if (registering.value) {
        await ctrl.register(
          username: username.text.trim(),
          password: password.text,
          displayName:
              displayName.text.trim().isEmpty ? null : displayName.text.trim(),
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
                _Field(controller: username, label: 'Username'),
                SizedBox(height: context.space.md),
                _Field(controller: password, label: 'Password', obscure: true),
                if (registering.value) ...[
                  SizedBox(height: context.space.md),
                  _Field(controller: displayName, label: 'Display name (optional)'),
                  SizedBox(height: context.space.md),
                  _Field(controller: invite, label: 'Invite code (if required)'),
                ],
                if (error != null) ...[
                  SizedBox(height: context.space.md),
                  Text(
                    error,
                    style: context.text.bodySmall
                        ?.copyWith(color: context.colors.onSurfaceVariant),
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

class _Field extends StatelessWidget {
  const _Field({
    required this.controller,
    required this.label,
    this.obscure = false,
  });

  final TextEditingController controller;
  final String label;
  final bool obscure;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      style: context.text.bodyLarge,
      decoration: InputDecoration(
        labelText: label,
        filled: true,
        fillColor: context.colors.surfaceContainer,
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
