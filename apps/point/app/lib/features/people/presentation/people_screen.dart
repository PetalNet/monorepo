import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/data/realtime_sync_coordinator.dart';
import 'package:point_app/features/relay/domain/realtime_sync_models.dart';
import 'package:point_app/features/settings/settings_controller.dart';
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
    final temps = ref.watch(outgoingTempsProvider);

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
            onPressed: () => context.push(const AddPersonRoute()),
          ),
        ],
      ),
      body: _PeopleBody(
        people: people,
        requests: requests,
        temps: temps.values.toList(),
        onRefresh: () => ref
            .read(realtimeSyncCoordinatorProvider)
            .syncNow(RealtimeSyncReason.manualRefresh),
      ),
    );
  }
}

class _PeopleBody extends StatelessWidget {
  const _PeopleBody({
    required this.people,
    required this.requests,
    required this.temps,
    required this.onRefresh,
  });

  final List<Person> people;
  final List<ShareRequest> requests;
  final List<TempShare> temps;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: (people.isEmpty && requests.isEmpty && temps.isEmpty)
              ? const _RefreshableEmptyPeople()
              : _PeopleList(
                  people: people,
                  requests: requests,
                  temps: temps,
                ),
        ),
      ),
    );
  }
}

class _PeopleList extends StatelessWidget {
  const _PeopleList({
    required this.people,
    required this.requests,
    required this.temps,
  });

  final List<Person> people;
  final List<ShareRequest> requests;
  final List<TempShare> temps;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.only(top: context.space.sm),
      children: [
        if (requests.isNotEmpty) _RequestsSection(requests: requests),
        if (temps.isNotEmpty) _TempSection(temps: temps, people: people),
        if ((requests.isNotEmpty || temps.isNotEmpty) && people.isNotEmpty)
          Divider(
            height: context.space.xl,
            color: context.colors.outline.withValues(alpha: 0.4),
          ),
        for (final person in people)
          PersonRow(
            person: person,
            onTap: () => context.push(PersonDetailRoute(person.userId)),
          ),
      ],
    );
  }
}

class _RefreshableEmptyPeople extends StatelessWidget {
  const _RefreshableEmptyPeople();

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(
            height: constraints.maxHeight,
            child: const _EmptyPeople(),
          ),
        ],
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
            style: context.text.labelMedium?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ),
        for (final r in requests) _RequestRow(request: r),
      ],
    );
  }
}

/// The outgoing one-way temp shares, shown DISTINCTLY from ongoing (two-way)
/// people: an out-arrow, "→ Name · until HH:MM", and a Stop.
class _TempSection extends ConsumerWidget {
  const _TempSection({required this.temps, required this.people});
  final List<TempShare> temps;
  final List<Person> people;

  String _name(String userId) =>
      people
          .where((p) => p.userId == userId)
          .map((p) => p.displayName)
          .firstOrNull ??
      userId.split('@').first;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
            'SHARING TEMPORARILY',
            style: context.text.labelMedium?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ),
        for (final t in temps)
          Padding(
            padding: EdgeInsets.symmetric(
              horizontal: context.space.lg,
              vertical: context.space.sm,
            ),
            child: Row(
              children: [
                Icon(
                  Icons.arrow_forward,
                  size: 20,
                  color: context.colors.onSurface,
                ),
                SizedBox(width: context.space.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(_name(t.toUserId), style: context.text.titleMedium),
                      SizedBox(height: context.space.xxs),
                      Text(
                        'Sees you until '
                        '${clockHm(t.expiresAt.millisecondsSinceEpoch, format: ref.watch(settingsProvider.select((s) => s.timeFormat)))}',
                        style: context.text.bodySmall?.copyWith(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                TextButton(
                  onPressed: () => ref
                      .read(tempSharesControllerProvider.notifier)
                      .stop(t.id),
                  child: const Text('Stop'),
                ),
              ],
            ),
          ),
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
              style: context.text.bodyMedium?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            SizedBox(height: context.space.xl),
            FilledButton.icon(
              onPressed: () => context.push(const AddPersonRoute()),
              icon: const Icon(Icons.person_add_alt),
              label: const Text('Add a person'),
            ),
          ],
        ),
      ),
    );
  }
}
