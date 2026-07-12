import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/presentation/share_sheet.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/initials_avatar.dart';
import 'package:point_app/widgets/person_row.dart';

/// People (spec 06): incoming requests pinned at top (accept / decline), then
/// the active people — avatar, name, one-line status + last-updated — each
/// tapping through to that person's detail.
class PeopleScreen extends ConsumerWidget {
  const PeopleScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final people = ref.watch(peopleWithPresenceProvider);
    final requests = ref.watch(requestsControllerProvider).value ?? const [];

    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            const BrandDot(),
            SizedBox(width: context.space.sm),
            const Text('People'),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.person_add_alt),
            tooltip: 'Add person',
            onPressed: () => ShareSheet.show(context),
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: (people.isEmpty && requests.isEmpty)
              ? const _EmptyPeople()
              : ListView(
                  padding: EdgeInsets.only(top: context.space.sm),
                  children: [
                    if (requests.isNotEmpty)
                      _RequestsSection(requests: requests),
                    if (requests.isNotEmpty && people.isNotEmpty)
                      Divider(
                        height: context.space.xl,
                        color: context.colors.outline.withValues(alpha: 0.4),
                      ),
                    for (final p in people)
                      PersonRow(
                        person: p,
                        onTap: () => context.push(PersonDetailRoute(p.userId)),
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}

/// The pinned incoming-requests block: a labeled section of accept/decline rows.
class _RequestsSection extends StatelessWidget {
  const _RequestsSection({required this.requests});
  final List<ShareRequest> requests;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(
            context.space.lg,
            context.space.md,
            context.space.lg,
            context.space.sm,
          ),
          child: Text(
            'REQUESTS',
            style: context.text.labelMedium
                ?.copyWith(color: context.colors.onSurfaceVariant),
          ),
        ),
        for (final r in requests) _RequestRow(request: r),
      ],
    );
  }
}

class _RequestRow extends ConsumerStatefulWidget {
  const _RequestRow({required this.request});
  final ShareRequest request;

  @override
  ConsumerState<_RequestRow> createState() => _RequestRowState();
}

class _RequestRowState extends ConsumerState<_RequestRow> {
  bool _busy = false;

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.request;
    final ctrl = ref.read(requestsControllerProvider.notifier);
    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: context.space.lg,
        vertical: context.space.sm,
      ),
      child: Row(
        children: [
          InitialsAvatar(name: r.fromDisplayName),
          SizedBox(width: context.space.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(r.fromDisplayName, style: context.text.titleMedium),
                SizedBox(height: context.space.xxs),
                Text(
                  r.fromUserId,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.bodySmall?.copyWith(
                    fontFamily: AppTheme.monoFamily,
                    letterSpacing: 0,
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          if (_busy)
            Padding(
              padding: EdgeInsets.all(context.space.sm),
              child: const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          else ...[
            IconButton(
              tooltip: 'Decline',
              icon: const Icon(Icons.close),
              onPressed: () => _run(() => ctrl.decline(r)),
            ),
            IconButton.filled(
              tooltip: 'Accept',
              icon: const Icon(Icons.check),
              onPressed: () => _run(() => ctrl.accept(r)),
            ),
          ],
        ],
      ),
    );
  }
}

class _EmptyPeople extends StatelessWidget {
  const _EmptyPeople();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(context.space.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('No one yet.', style: context.text.titleLarge),
            SizedBox(height: context.space.sm),
            Text(
              'Add someone to start sharing your location.',
              textAlign: TextAlign.center,
              style: context.text.bodyMedium
                  ?.copyWith(color: context.colors.onSurfaceVariant),
            ),
            SizedBox(height: context.space.xl),
            FilledButton.icon(
              onPressed: () => ShareSheet.show(context),
              icon: const Icon(Icons.person_add_alt),
              label: const Text('Add a person'),
            ),
          ],
        ),
      ),
    );
  }
}
