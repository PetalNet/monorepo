import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/me/avatar_provider.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/data/realtime_sync_coordinator.dart';
import 'package:point_app/features/relay/domain/realtime_sync_models.dart';
import 'package:point_app/features/settings/settings_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/api/point_api.dart';
import 'package:point_app/services/auth_controller.dart';
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
    final peopleValue = ref.watch(peopleControllerProvider);
    final people = ref.watch(peopleWithPresenceProvider);
    final requestsValue = ref.watch(requestsControllerProvider);
    final outgoingValue = ref.watch(outgoingRequestsControllerProvider);
    final requests = requestsValue.value ?? const <ShareRequest>[];
    final outgoing = outgoingValue.value ?? const <OutgoingShareRequest>[];
    final temps = ref.watch(outgoingTempsProvider);
    final supplementalValues = [requestsValue, outgoingValue];
    final hasVisibleSupplementalData =
        requests.isNotEmpty || outgoing.isNotEmpty || temps.isNotEmpty;
    final isInitialLoading =
        (peopleValue.isLoading && !peopleValue.hasValue) ||
        (people.isEmpty &&
            supplementalValues.any(
              (value) => value.isLoading && !value.hasValue,
            ));
    final hasInitialError =
        peopleValue.hasError &&
        !peopleValue.hasValue &&
        !hasVisibleSupplementalData;
    final hasRefreshError =
        !hasInitialError &&
        (peopleValue.hasError ||
            supplementalValues.any((value) => value.hasError));
    final hasAvatarError = people.any(
      (person) => ref.watch(avatarProvider(person.userId)).hasError,
    );

    void openRequests() => Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => const RequestsScreen()));

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
            icon: Badge.count(
              count: requests.length,
              isLabelVisible: requests.isNotEmpty,
              backgroundColor: context.colors.onSurface,
              textColor: context.colors.surface,
              child: const Icon(Icons.inbox_outlined),
            ),
            tooltip: requests.isEmpty
                ? 'Requests'
                : 'Requests, ${requests.length} pending',
            onPressed: openRequests,
          ),
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
        outgoing: outgoing,
        temps: temps.values.toList(),
        isInitialLoading: isInitialLoading,
        hasInitialError: hasInitialError,
        hasRefreshError: hasRefreshError,
        hasAvatarError: hasAvatarError,
        onRetryAvatars: () {
          for (final person in people) {
            ref.invalidate(avatarProvider(person.userId));
          }
        },
        onOpenRequests: openRequests,
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
    required this.outgoing,
    required this.temps,
    required this.isInitialLoading,
    required this.hasInitialError,
    required this.hasRefreshError,
    required this.hasAvatarError,
    required this.onRetryAvatars,
    required this.onOpenRequests,
    required this.onRefresh,
  });

  final List<Person> people;
  final List<ShareRequest> requests;
  final List<OutgoingShareRequest> outgoing;
  final List<TempShare> temps;
  final bool isInitialLoading;
  final bool hasInitialError;
  final bool hasRefreshError;
  final bool hasAvatarError;
  final VoidCallback onRetryAvatars;
  final VoidCallback onOpenRequests;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: switch ((hasInitialError, isInitialLoading)) {
            (true, _) => _PeopleUnavailable(onRetry: onRefresh),
            (false, true) => const _PeopleLoading(),
            _
                when people.isEmpty &&
                    requests.isEmpty &&
                    outgoing.isEmpty &&
                    temps.isEmpty =>
              _RefreshableEmptyPeople(
                hasRefreshError: hasRefreshError,
                onRetry: onRefresh,
              ),
            _ => _PeopleList(
              people: people,
              requests: requests,
              outgoing: outgoing,
              temps: temps,
              hasRefreshError: hasRefreshError,
              hasAvatarError: hasAvatarError,
              onRetry: onRefresh,
              onRetryAvatars: onRetryAvatars,
              onOpenRequests: onOpenRequests,
            ),
          },
        ),
      ),
    );
  }
}

class _PeopleList extends StatelessWidget {
  const _PeopleList({
    required this.people,
    required this.requests,
    required this.outgoing,
    required this.temps,
    required this.hasRefreshError,
    required this.hasAvatarError,
    required this.onRetry,
    required this.onRetryAvatars,
    required this.onOpenRequests,
  });

  final List<Person> people;
  final List<ShareRequest> requests;
  final List<OutgoingShareRequest> outgoing;
  final List<TempShare> temps;
  final bool hasRefreshError;
  final bool hasAvatarError;
  final Future<void> Function() onRetry;
  final VoidCallback onRetryAvatars;
  final VoidCallback onOpenRequests;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.only(top: context.space.sm),
      children: [
        if (hasRefreshError) _PeopleRefreshError(onRetry: onRetry),
        if (hasAvatarError) _AvatarRefreshError(onRetry: onRetryAvatars),
        if (requests.isNotEmpty)
          _RequestsSection(requests: requests, onOpenRequests: onOpenRequests),
        if (outgoing.isNotEmpty)
          _OutgoingRequestsSummary(
            count: outgoing.length,
            onOpenRequests: onOpenRequests,
          ),
        if (temps.isNotEmpty) _TempSection(temps: temps, people: people),
        if ((requests.isNotEmpty || outgoing.isNotEmpty || temps.isNotEmpty) &&
            people.isNotEmpty)
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
  const _RefreshableEmptyPeople({
    required this.hasRefreshError,
    required this.onRetry,
  });

  final bool hasRefreshError;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          if (hasRefreshError) _PeopleRefreshError(onRetry: onRetry),
          SizedBox(
            height: hasRefreshError
                ? (constraints.maxHeight - 96).clamp(0, double.infinity)
                : constraints.maxHeight,
            child: const _EmptyPeople(),
          ),
        ],
      ),
    );
  }
}

class _PeopleLoading extends StatelessWidget {
  const _PeopleLoading();

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      key: const ValueKey('people-loading'),
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.symmetric(
        horizontal: context.space.lg,
        vertical: context.space.md,
      ),
      itemCount: 5,
      itemBuilder: (context, index) => const _PeopleSkeletonRow(),
    );
  }
}

class _PeopleSkeletonRow extends StatelessWidget {
  const _PeopleSkeletonRow();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Loading person',
      child: ExcludeSemantics(
        child: SizedBox(
          height: 80,
          child: Row(
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: context.colors.surfaceContainerHigh,
                ),
              ),
              SizedBox(width: context.space.md),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    FractionallySizedBox(
                      widthFactor: 0.48,
                      child: Container(
                        height: 14,
                        decoration: BoxDecoration(
                          color: context.colors.surfaceContainerHigh,
                          borderRadius: context.radii.brSm,
                        ),
                      ),
                    ),
                    SizedBox(height: context.space.sm),
                    FractionallySizedBox(
                      widthFactor: 0.72,
                      child: Container(
                        height: 10,
                        decoration: BoxDecoration(
                          color: context.colors.surfaceContainer,
                          borderRadius: context.radii.brSm,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PeopleUnavailable extends StatelessWidget {
  const _PeopleUnavailable({required this.onRetry});

  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) => ListView(
        key: const ValueKey('people-unavailable'),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(
            height: constraints.maxHeight,
            child: Center(
              child: Padding(
                padding: EdgeInsets.all(context.space.xl),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.cloud_off_outlined, size: 32),
                    SizedBox(height: context.space.md),
                    Text('People unavailable', style: context.text.titleLarge),
                    SizedBox(height: context.space.sm),
                    Text(
                      'Check your connection to your Point server, then try again.',
                      textAlign: TextAlign.center,
                      style: context.text.bodyMedium?.copyWith(
                        color: context.colors.onSurfaceVariant,
                      ),
                    ),
                    SizedBox(height: context.space.xl),
                    FilledButton.icon(
                      onPressed: onRetry,
                      icon: const Icon(Icons.refresh),
                      label: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PeopleRefreshError extends StatelessWidget {
  const _PeopleRefreshError({required this.onRetry});

  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      container: true,
      label: 'Some information could not load. Showing what is available.',
      child: ColoredBox(
        color: context.colors.surfaceContainer,
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: context.space.lg),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 64),
            child: Row(
              children: [
                const Icon(Icons.cloud_off_outlined),
                SizedBox(width: context.space.md),
                const Expanded(
                  child: Text(
                    'Some information could not load. Showing what is available.',
                  ),
                ),
                TextButton(onPressed: onRetry, child: const Text('Retry')),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AvatarRefreshError extends StatelessWidget {
  const _AvatarRefreshError({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      container: true,
      label: 'Some photos could not load.',
      child: ColoredBox(
        color: context.colors.surfaceContainer,
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: context.space.lg),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 64),
            child: Row(
              children: [
                const Icon(Icons.account_circle_outlined),
                SizedBox(width: context.space.md),
                const Expanded(child: Text('Some photos could not load.')),
                TextButton(onPressed: onRetry, child: const Text('Retry')),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The pinned incoming-requests block: a labeled section of accept/decline rows.
class _RequestsSection extends StatelessWidget {
  const _RequestsSection({
    required this.requests,
    required this.onOpenRequests,
  });
  final List<ShareRequest> requests;
  final VoidCallback onOpenRequests;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(
            context.space.lg,
            context.space.md,
            context.space.sm,
            context.space.xxs,
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'Requests',
                  style: context.text.titleSmall?.copyWith(
                    color: context.colors.onSurface,
                  ),
                ),
              ),
              TextButton(
                onPressed: onOpenRequests,
                child: Text(
                  requests.length > 2 ? 'View all ${requests.length}' : 'Open',
                ),
              ),
            ],
          ),
        ),
        for (final r in requests.take(2))
          _RequestRow(key: ValueKey('preview-${r.id}'), request: r),
      ],
    );
  }
}

class _OutgoingRequestsSummary extends StatelessWidget {
  const _OutgoingRequestsSummary({
    required this.count,
    required this.onOpenRequests,
  });

  final int count;
  final VoidCallback onOpenRequests;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.symmetric(horizontal: context.space.lg),
      leading: const Icon(Icons.outbox_outlined),
      title: Text('$count sent ${count == 1 ? 'request' : 'requests'} pending'),
      subtitle: const Text('Open to review or cancel'),
      trailing: const Icon(Icons.chevron_right),
      onTap: onOpenRequests,
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

/// One authoritative place to review incoming and sent requests. It reuses the
/// same Riverpod state as the People preview and shell badge, so all three
/// surfaces reconcile together after a lifecycle action.
class RequestsScreen extends ConsumerWidget {
  const RequestsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final incomingValue = ref.watch(requestsControllerProvider);
    final outgoingValue = ref.watch(outgoingRequestsControllerProvider);
    final incoming = incomingValue.value ?? const <ShareRequest>[];
    final outgoing = outgoingValue.value ?? const <OutgoingShareRequest>[];

    Future<void> refresh() async {
      await Future.wait([
        ref.read(requestsControllerProvider.notifier).refresh(),
        ref.read(outgoingRequestsControllerProvider.notifier).refresh(),
      ]);
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Requests')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: switch ((incomingValue, outgoingValue)) {
            (AsyncError(:final error), _) when incoming.isEmpty =>
              _RequestsError(error: error, onRetry: refresh),
            (_, AsyncError(:final error)) when outgoing.isEmpty =>
              _RequestsError(error: error, onRetry: refresh),
            _ when incomingValue.isLoading && outgoingValue.isLoading =>
              const _RequestsLoading(),
            _ => _RequestsContent(
              incoming: incoming,
              outgoing: outgoing,
              onRefresh: refresh,
            ),
          },
        ),
      ),
    );
  }
}

sealed class _RequestsEntry {
  const _RequestsEntry();
}

class _RequestsHeaderEntry extends _RequestsEntry {
  const _RequestsHeaderEntry(this.label, this.count);
  final String label;
  final int count;
}

class _RequestsEmptyEntry extends _RequestsEntry {
  const _RequestsEmptyEntry(this.message);
  final String message;
}

class _IncomingRequestEntry extends _RequestsEntry {
  const _IncomingRequestEntry(this.request);
  final ShareRequest request;
}

class _OutgoingRequestEntry extends _RequestsEntry {
  const _OutgoingRequestEntry(this.request);
  final OutgoingShareRequest request;
}

class _RequestsContent extends StatelessWidget {
  const _RequestsContent({
    required this.incoming,
    required this.outgoing,
    required this.onRefresh,
  });

  final List<ShareRequest> incoming;
  final List<OutgoingShareRequest> outgoing;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    final entries = <_RequestsEntry>[
      _RequestsHeaderEntry('Incoming', incoming.length),
      if (incoming.isEmpty)
        const _RequestsEmptyEntry('No requests need your attention.')
      else
        for (final request in incoming) _IncomingRequestEntry(request),
      _RequestsHeaderEntry('Sent', outgoing.length),
      if (outgoing.isEmpty)
        const _RequestsEmptyEntry('No sent requests are pending.')
      else
        for (final request in outgoing) _OutgoingRequestEntry(request),
    ];

    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView.builder(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: EdgeInsets.only(
          top: context.space.sm,
          bottom: context.space.xxl,
        ),
        itemCount: entries.length,
        itemBuilder: (context, index) => switch (entries[index]) {
          _RequestsHeaderEntry(:final label, :final count) => _RequestsHeader(
            label: label,
            count: count,
          ),
          _RequestsEmptyEntry(:final message) => _RequestsEmpty(
            message: message,
          ),
          _IncomingRequestEntry(:final request) => _RequestRow(
            key: ValueKey('incoming-${request.id}'),
            request: request,
            showTimestamp: true,
          ),
          _OutgoingRequestEntry(:final request) => _OutgoingRequestRow(
            key: ValueKey('outgoing-${request.id}'),
            request: request,
          ),
        },
      ),
    );
  }
}

class _RequestsHeader extends StatelessWidget {
  const _RequestsHeader({required this.label, required this.count});
  final String label;
  final int count;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        context.space.lg,
        context.space.lg,
        context.space.lg,
        context.space.sm,
      ),
      child: Row(
        children: [
          Expanded(child: Text(label, style: context.text.titleMedium)),
          Text(
            '$count',
            style: context.text.labelLarge?.copyWith(
              fontFamily: AppTheme.monoFamily,
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

class _RequestsEmpty extends StatelessWidget {
  const _RequestsEmpty({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: context.space.lg,
        vertical: context.space.md,
      ),
      child: Text(
        message,
        style: context.text.bodyMedium?.copyWith(
          color: context.colors.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _RequestsLoading extends StatelessWidget {
  const _RequestsLoading();

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.all(context.space.lg),
      itemCount: 4,
      itemBuilder: (context, index) => Padding(
        padding: EdgeInsets.symmetric(vertical: context.space.sm),
        child: Container(
          height: context.space.xxl + context.space.xl,
          decoration: BoxDecoration(
            color: context.colors.surfaceContainer,
            borderRadius: context.radii.brSm,
          ),
        ),
      ),
    );
  }
}

class _RequestsError extends StatelessWidget {
  const _RequestsError({required this.error, required this.onRetry});
  final Object error;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(context.space.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Could not load requests.', style: context.text.titleMedium),
            SizedBox(height: context.space.sm),
            Text(
              '$error',
              textAlign: TextAlign.center,
              style: context.text.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            SizedBox(height: context.space.lg),
            FilledButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}

enum _OutgoingRequestState { pending, expired, failed, cancelled }

class _OutgoingRequestRow extends ConsumerStatefulWidget {
  const _OutgoingRequestRow({required this.request, super.key});
  final OutgoingShareRequest request;

  @override
  ConsumerState<_OutgoingRequestRow> createState() =>
      _OutgoingRequestRowState();
}

class _OutgoingRequestRowState extends ConsumerState<_OutgoingRequestRow> {
  late _OutgoingRequestState _state = widget.request.isExpired
      ? _OutgoingRequestState.expired
      : _OutgoingRequestState.pending;
  bool _retryAction = false;
  bool _retried = false;

  Future<void> _cancel() async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    setState(() {
      _retryAction = false;
      _state = _OutgoingRequestState.cancelled;
    });
    try {
      await ref
          .read(apiProvider)
          .cancelRequest(session.token, widget.request.id);
    } on Object {
      if (mounted) setState(() => _state = _OutgoingRequestState.failed);
      return;
    }
    if (!mounted) return;
    setState(() => _state = _OutgoingRequestState.cancelled);
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Request cancelled.')));
    try {
      await ref.read(outgoingRequestsControllerProvider.notifier).refresh();
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Cancelled. Pull to refresh the list.')),
        );
      }
    }
  }

  Future<void> _retry() async {
    final session = ref.read(authControllerProvider).value;
    if (session == null) return;
    setState(() {
      _retryAction = true;
      _retried = true;
      _state = _OutgoingRequestState.pending;
    });
    try {
      final api = ref.read(apiProvider);
      try {
        await api.cancelRequest(session.token, widget.request.id);
      } on ApiException catch (error) {
        if (error.statusCode != 404) rethrow;
      }
      await api.sendShareRequest(session.token, widget.request.toUserId);
    } on Object {
      if (mounted) setState(() => _state = _OutgoingRequestState.failed);
      return;
    }
    if (!mounted) return;
    setState(() {
      _retried = true;
      _state = _OutgoingRequestState.pending;
    });
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Request sent again.')));
    try {
      await ref.read(outgoingRequestsControllerProvider.notifier).refresh();
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Sent. Pull to refresh the list.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final request = widget.request;
    final createdAt = request.createdAt;
    final status = switch (_state) {
      _OutgoingRequestState.pending =>
        _retried
            ? 'Requested again'
            : createdAt == null
            ? 'Pending'
            : 'Requested ${relativeSince(createdAt.millisecondsSinceEpoch)}',
      _OutgoingRequestState.expired => 'Expired. Send it again?',
      _OutgoingRequestState.failed =>
        _retryAction
            ? 'Could not retry. Try again.'
            : 'Could not cancel. Try again.',
      _OutgoingRequestState.cancelled => 'Cancelled',
    };

    return ListTile(
      contentPadding: EdgeInsets.symmetric(horizontal: context.space.lg),
      minVerticalPadding: context.space.sm,
      leading: InitialsAvatar(name: request.toDisplayName),
      title: Text(request.toDisplayName),
      subtitle: Text('$status\n${request.toUserId}'),
      isThreeLine: true,
      trailing: switch (_state) {
        _OutgoingRequestState.cancelled => const Icon(Icons.check),
        _OutgoingRequestState.expired => TextButton(
          onPressed: _retry,
          child: const Text('Retry'),
        ),
        _OutgoingRequestState.failed => TextButton(
          onPressed: _retryAction ? _retry : _cancel,
          child: const Text('Retry'),
        ),
        _OutgoingRequestState.pending => TextButton(
          onPressed: _cancel,
          child: const Text('Cancel'),
        ),
      },
    );
  }
}

class _RequestRow extends ConsumerStatefulWidget {
  const _RequestRow({
    required this.request,
    this.showTimestamp = false,
    super.key,
  });
  final ShareRequest request;
  final bool showTimestamp;

  @override
  ConsumerState<_RequestRow> createState() => _RequestRowState();
}

class _RequestRowState extends ConsumerState<_RequestRow> {
  bool _busy = false;
  String? _transition;
  String? _error;

  Future<void> _run({
    required String complete,
    required bool refreshPeople,
    required Future<void> Function() action,
  }) async {
    setState(() {
      _busy = true;
      _transition = complete;
      _error = null;
    });
    try {
      await action();
    } on Object {
      if (mounted) {
        setState(() {
          _transition = null;
          _error = 'Could not update. Try again.';
        });
      }
      return;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('$complete.')));
    try {
      await ref.read(requestsControllerProvider.notifier).refresh();
      if (refreshPeople) {
        await ref.read(peopleControllerProvider.notifier).refresh();
      }
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$complete. Pull to refresh the list.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.request;
    final session = ref.read(authControllerProvider).value;
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
                if (widget.showTimestamp && r.createdAt != null)
                  Text(
                    'Requested ${relativeSince(r.createdAt!.millisecondsSinceEpoch)}',
                    style: context.text.bodySmall?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                if (_transition != null)
                  Text(_transition!, style: context.text.labelLarge),
                if (_error != null)
                  Text(
                    _error!,
                    style: context.text.bodySmall?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
          if (_busy)
            Padding(
              padding: EdgeInsets.all(context.space.sm),
              child: const Icon(Icons.schedule),
            )
          else ...[
            IconButton(
              tooltip: 'Decline',
              icon: const Icon(Icons.close),
              onPressed: () => _run(
                complete: 'Declined',
                refreshPeople: false,
                action: () async {
                  if (session == null) return;
                  await ref
                      .read(apiProvider)
                      .rejectRequest(session.token, r.id);
                },
              ),
            ),
            IconButton.filled(
              tooltip: 'Accept',
              icon: const Icon(Icons.check),
              onPressed: () => _run(
                complete: 'Accepted',
                refreshPeople: true,
                action: () async {
                  if (session == null) return;
                  await ref
                      .read(apiProvider)
                      .acceptRequest(session.token, r.id);
                },
              ),
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
