import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:kaisel/kaisel.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/app/routes.dart';
import 'package:point_app/features/me/avatar_provider.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/people_presence.dart';
import 'package:point_app/features/people/presentation/temp_share_sheet.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/features/people/temp_shares_controller.dart';
import 'package:point_app/features/relay/data/realtime_sync_coordinator.dart';
import 'package:point_app/features/relay/domain/realtime_sync_models.dart';
import 'package:point_app/features/relay/relay_controller.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/features/settings/haptics.dart';
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
enum _PeopleAddAction { ongoing, temporary }

Duration _mutationTransitionDuration(BuildContext context, WidgetRef ref) {
  final preference = ref.watch(settingsProvider.select((s) => s.motion));
  final reduced =
      preference == MotionPreference.reduced ||
      (preference == MotionPreference.system &&
          MediaQuery.disableAnimationsOf(context));
  return reduced ? Duration.zero : const Duration(milliseconds: 180);
}

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
    final outgoingTemps = ref.watch(outgoingTempsProvider);
    final incomingTemps = ref.watch(incomingTempsProvider);
    final incomingTempPeople = ref.watch(incomingTempPeopleProvider);
    final supplementalValues = [requestsValue, outgoingValue];
    final hasVisibleSupplementalData =
        requests.isNotEmpty ||
        outgoing.isNotEmpty ||
        outgoingTemps.isNotEmpty ||
        incomingTemps.isNotEmpty;
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
            const Flexible(
              child: Text(
                'People',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            SizedBox(width: context.space.sm),
            const Expanded(child: RelayHealthIndicator()),
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
          PopupMenuButton<_PeopleAddAction>(
            icon: const Icon(Icons.person_add_alt),
            tooltip: 'Add or share',
            onSelected: (action) {
              switch (action) {
                case _PeopleAddAction.ongoing:
                  unawaited(context.push(const AddPersonRoute()));
                case _PeopleAddAction.temporary:
                  unawaited(TempShareSheet.showForHandle(context));
              }
            },
            itemBuilder: (context) => const [
              PopupMenuItem(
                value: _PeopleAddAction.ongoing,
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.people_outline),
                  title: Text('Share ongoing'),
                  subtitle: Text('You see each other'),
                ),
              ),
              PopupMenuItem(
                value: _PeopleAddAction.temporary,
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.schedule),
                  title: Text('Share temporarily'),
                  subtitle: Text('They see you for a while'),
                ),
              ),
            ],
          ),
        ],
      ),
      body: _PeopleBody(
        people: people,
        requests: requests,
        outgoing: outgoing,
        outgoingTemps: outgoingTemps.values.toList(),
        incomingTemps: incomingTemps,
        incomingTempPeople: incomingTempPeople,
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

class _PeopleBody extends ConsumerWidget {
  const _PeopleBody({
    required this.people,
    required this.requests,
    required this.outgoing,
    required this.outgoingTemps,
    required this.incomingTemps,
    required this.incomingTempPeople,
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
  final List<TempShare> outgoingTemps;
  final Map<String, TempShare> incomingTemps;
  final List<Person> incomingTempPeople;
  final bool isInitialLoading;
  final bool hasInitialError;
  final bool hasRefreshError;
  final bool hasAvatarError;
  final VoidCallback onRetryAvatars;
  final VoidCallback onOpenRequests;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: AnimatedSwitcher(
            duration: _mutationTransitionDuration(context, ref),
            switchInCurve: Curves.easeOutQuart,
            switchOutCurve: Curves.easeOutQuart,
            transitionBuilder: (child, animation) =>
                FadeTransition(opacity: animation, child: child),
            child: switch ((hasInitialError, isInitialLoading)) {
              (true, _) => _PeopleUnavailable(onRetry: onRefresh),
              (false, true) => const _PeopleLoading(),
              _
                  when people.isEmpty &&
                      requests.isEmpty &&
                      outgoing.isEmpty &&
                      outgoingTemps.isEmpty &&
                      incomingTemps.isEmpty =>
                _RefreshableEmptyPeople(
                  hasRefreshError: hasRefreshError,
                  onRetry: onRefresh,
                ),
              _ => _PeopleList(
                people: people,
                requests: requests,
                outgoing: outgoing,
                outgoingTemps: outgoingTemps,
                incomingTemps: incomingTemps,
                incomingTempPeople: incomingTempPeople,
                hasRefreshError: hasRefreshError,
                hasAvatarError: hasAvatarError,
                onRetry: onRefresh,
                onRetryAvatars: onRetryAvatars,
                onOpenRequests: onOpenRequests,
              ),
            },
          ),
        ),
      ),
    );
  }
}

class _PeopleList extends ConsumerWidget {
  const _PeopleList({
    required this.people,
    required this.requests,
    required this.outgoing,
    required this.outgoingTemps,
    required this.incomingTemps,
    required this.incomingTempPeople,
    required this.hasRefreshError,
    required this.hasAvatarError,
    required this.onRetry,
    required this.onRetryAvatars,
    required this.onOpenRequests,
  });

  final List<Person> people;
  final List<ShareRequest> requests;
  final List<OutgoingShareRequest> outgoing;
  final List<TempShare> outgoingTemps;
  final Map<String, TempShare> incomingTemps;
  final List<Person> incomingTempPeople;
  final bool hasRefreshError;
  final bool hasAvatarError;
  final Future<void> Function() onRetry;
  final VoidCallback onRetryAvatars;
  final VoidCallback onOpenRequests;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final duration = _mutationTransitionDuration(context, ref);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.only(top: context.space.sm),
      children: [
        if (hasRefreshError) _PeopleRefreshError(onRetry: onRetry),
        if (hasAvatarError) _AvatarRefreshError(onRetry: onRetryAvatars),
        _AnimatedRequestsPreview(
          requests: requests,
          onOpenRequests: onOpenRequests,
        ),
        _MutationSlot(
          duration: duration,
          stateKey: outgoing.isEmpty ? null : outgoing.length,
          child: outgoing.isEmpty
              ? null
              : _OutgoingRequestsSummary(
                  count: outgoing.length,
                  onOpenRequests: onOpenRequests,
                ),
        ),
        _MutationSlot(
          duration: duration,
          stateKey: incomingTemps.isEmpty ? null : 'incoming-temps',
          child: incomingTemps.isEmpty
              ? null
              : _IncomingTempSection(
                  temps: incomingTemps,
                  people: incomingTempPeople,
                ),
        ),
        _MutationSlot(
          duration: duration,
          stateKey: outgoingTemps.isEmpty ? null : 'outgoing-temps',
          child: outgoingTemps.isEmpty
              ? null
              : _TempSection(temps: outgoingTemps, people: people),
        ),
        _MutationSlot(
          duration: duration,
          stateKey:
              (requests.isNotEmpty ||
                      outgoing.isNotEmpty ||
                      outgoingTemps.isNotEmpty ||
                      incomingTemps.isNotEmpty) &&
                  people.isNotEmpty
              ? 'supplemental-divider'
              : null,
          child:
              (requests.isNotEmpty ||
                      outgoing.isNotEmpty ||
                      outgoingTemps.isNotEmpty ||
                      incomingTemps.isNotEmpty) &&
                  people.isNotEmpty
              ? Divider(
                  height: context.space.xl,
                  color: context.colors.outline.withValues(alpha: 0.4),
                )
              : null,
        ),
        _AnimatedDiffList<Person>(
          items: people,
          idOf: (person) => person.userId,
          duration: duration,
          itemBuilder: (context, person) => PersonRow(
            key: ValueKey('person-${person.userId}'),
            person: person,
            onTap: () => context.push(PersonDetailRoute(person.userId)),
          ),
        ),
      ],
    );
  }
}

class _MutationSlot extends StatelessWidget {
  const _MutationSlot({
    required this.duration,
    required this.stateKey,
    required this.child,
  });

  final Duration duration;
  final Object? stateKey;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: duration,
      reverseDuration: duration,
      switchInCurve: Curves.easeOutQuart,
      switchOutCurve: Curves.easeOutQuart,
      transitionBuilder: _buildMutationTransition,
      child: child == null
          ? SizedBox.shrink(key: ValueKey('empty-$stateKey'))
          : KeyedSubtree(key: ValueKey(stateKey), child: child!),
    );
  }
}

Widget _buildMutationTransition(Widget child, Animation<double> animation) {
  final eased = CurvedAnimation(parent: animation, curve: Curves.easeOutQuart);
  return FadeTransition(
    opacity: eased,
    child: SizeTransition(
      sizeFactor: eased,
      alignment: Alignment.topCenter,
      child: child,
    ),
  );
}

typedef _DiffItemBuilder<T> = Widget Function(BuildContext context, T item);
typedef _DiffId<T> = Object Function(T item);

/// A nested, non-scrolling list that preserves keyed rows long enough for
/// semantic insertion and removal transitions. Initial rows render in place;
/// only subsequent state changes spend the motion budget.
class _AnimatedDiffList<T> extends StatefulWidget {
  const _AnimatedDiffList({
    required this.items,
    required this.idOf,
    required this.itemBuilder,
    required this.duration,
  });

  final List<T> items;
  final _DiffId<T> idOf;
  final _DiffItemBuilder<T> itemBuilder;
  final Duration duration;

  @override
  State<_AnimatedDiffList<T>> createState() => _AnimatedDiffListState<T>();
}

class _AnimatedDiffListState<T> extends State<_AnimatedDiffList<T>>
    with TickerProviderStateMixin {
  late List<_DiffEntry<T>> _entries;

  @override
  void initState() {
    super.initState();
    _entries = [
      for (final item in widget.items)
        _DiffEntry(
          item: item,
          controller: AnimationController(
            vsync: this,
            duration: widget.duration,
            value: 1,
          ),
        ),
    ];
  }

  @override
  void didUpdateWidget(_AnimatedDiffList<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    _reconcile();
  }

  void _reconcile() {
    final existing = {
      for (final entry in _entries) widget.idOf(entry.item): entry,
    };
    for (final entry in existing.values) {
      entry.controller.duration = widget.duration;
    }
    final nextIds = widget.items.map(widget.idOf).toSet();
    final next = <_DiffEntry<T>>[];

    for (final item in widget.items) {
      final id = widget.idOf(item);
      final entry = existing[id];
      if (entry != null) {
        entry
          ..item = item
          ..exiting = false;
        if (widget.duration == Duration.zero) {
          entry.controller.value = 1;
        } else {
          unawaited(entry.controller.forward());
        }
        next.add(entry);
        continue;
      }
      final controller = AnimationController(
        vsync: this,
        duration: widget.duration,
        value: widget.duration == Duration.zero ? 1 : 0,
      );
      next.add(_DiffEntry(item: item, controller: controller));
      if (widget.duration != Duration.zero) {
        unawaited(controller.forward());
      }
    }

    for (var oldIndex = 0; oldIndex < _entries.length; oldIndex++) {
      final entry = _entries[oldIndex];
      if (nextIds.contains(widget.idOf(entry.item))) continue;
      if (widget.duration == Duration.zero) {
        entry.exiting = false;
        entry.controller.dispose();
        continue;
      }
      if (!entry.exiting) {
        entry.exiting = true;
        entry.controller.reverse().whenCompleteOrCancel(() {
          if (!mounted || !entry.exiting) return;
          setState(() => _entries.remove(entry));
          entry.controller.dispose();
        });
      }
      next.insert(oldIndex.clamp(0, next.length), entry);
    }

    _entries = next;
  }

  Widget _transition(_DiffEntry<T> entry) => _buildMutationTransition(
    IgnorePointer(
      ignoring: entry.exiting,
      child: ExcludeSemantics(
        excluding: entry.exiting,
        child: KeyedSubtree(
          key: ValueKey(widget.idOf(entry.item)),
          child: Builder(
            builder: (context) => widget.itemBuilder(context, entry.item),
          ),
        ),
      ),
    ),
    entry.controller,
  );

  @override
  void dispose() {
    for (final entry in _entries) {
      entry.exiting = false;
      entry.controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: _entries.length,
      itemBuilder: (context, index) => _transition(_entries[index]),
    );
  }
}

class _DiffEntry<T> {
  _DiffEntry({required this.item, required this.controller});

  T item;
  final AnimationController controller;
  bool exiting = false;
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
class _AnimatedRequestsPreview extends ConsumerWidget {
  const _AnimatedRequestsPreview({
    required this.requests,
    required this.onOpenRequests,
  });

  final List<ShareRequest> requests;
  final VoidCallback onOpenRequests;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return AnimatedSwitcher(
      duration: _mutationTransitionDuration(context, ref),
      switchInCurve: Curves.easeOutQuart,
      switchOutCurve: Curves.easeOutQuart,
      transitionBuilder: _buildMutationTransition,
      child: requests.isEmpty
          ? const SizedBox.shrink(key: ValueKey('no-request-preview'))
          : _RequestsSection(
              key: const ValueKey('request-preview'),
              requests: requests,
              onOpenRequests: onOpenRequests,
            ),
    );
  }
}

class _RequestsSection extends ConsumerWidget {
  const _RequestsSection({
    required this.requests,
    required this.onOpenRequests,
    super.key,
  });
  final List<ShareRequest> requests;
  final VoidCallback onOpenRequests;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
        _AnimatedDiffList<ShareRequest>(
          items: requests.take(2).toList(),
          idOf: (request) => request.id,
          duration: _mutationTransitionDuration(context, ref),
          itemBuilder: (context, request) => _RequestRow(
            key: ValueKey('preview-${request.id}'),
            request: request,
          ),
        ),
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

/// Incoming one-way temp shares are recipient relationships, not mutual
/// people. They remain visually separate and open a detail map backed by the
/// sender's decrypted fix even when no permanent `user_shares` row exists.
class _IncomingTempSection extends ConsumerWidget {
  const _IncomingTempSection({required this.temps, required this.people});

  final Map<String, TempShare> temps;
  final List<Person> people;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final format = ref.watch(settingsProvider.select((s) => s.timeFormat));
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
            'SHARING WITH YOU',
            style: context.text.labelMedium?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ),
        _AnimatedDiffList<Person>(
          items: people,
          idOf: (person) => person.userId,
          duration: _mutationTransitionDuration(context, ref),
          itemBuilder: (context, person) => Semantics(
            key: ValueKey('incoming-temp-${person.userId}'),
            button: true,
            label:
                '${person.displayName} is temporarily sharing their location with you',
            child: ListTile(
              minVerticalPadding: context.space.sm,
              contentPadding: EdgeInsets.symmetric(
                horizontal: context.space.lg,
              ),
              leading: Stack(
                clipBehavior: Clip.none,
                children: [
                  InitialsAvatar(name: person.displayName, size: 48),
                  Positioned(
                    right: -4,
                    bottom: -4,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: context.colors.inverseSurface,
                        shape: BoxShape.circle,
                      ),
                      child: Padding(
                        padding: EdgeInsets.all(context.space.xxs),
                        child: Icon(
                          Icons.arrow_back,
                          size: 14,
                          color: context.colors.onInverseSurface,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              title: Text(person.displayName),
              subtitle: Text(
                'You can see them until '
                '${clockHm(temps[person.userId]!.expiresAt.millisecondsSinceEpoch, format: format)}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => context.push(PersonDetailRoute(person.userId)),
            ),
          ),
        ),
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

  Future<void> _stop(
    BuildContext context,
    WidgetRef ref,
    TempShare temp,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    final view = View.of(context);
    final direction = Directionality.of(context);
    final canAnnounce = MediaQuery.supportsAnnounceOf(context);
    final outcome = await ref
        .read(tempSharesControllerProvider.notifier)
        .stop(temp.id);
    final message = switch (outcome) {
      MutationOutcome.succeeded ||
      MutationOutcome.succeededNeedsRefresh => 'Temporary sharing stopped.',
      MutationOutcome.failed => 'Could not stop sharing. Try again.',
      MutationOutcome.ignored => null,
    };
    if (message == null) return;
    messenger.showSnackBar(SnackBar(content: Text(message)));
    if (canAnnounce) {
      unawaited(SemanticsService.sendAnnouncement(view, message, direction));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mutations = ref.watch(tempShareMutationsProvider);
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
        _AnimatedDiffList<TempShare>(
          items: temps,
          idOf: (temp) => temp.id,
          duration: _mutationTransitionDuration(context, ref),
          itemBuilder: (context, t) => Padding(
            key: ValueKey('outgoing-temp-${t.id}'),
            padding: EdgeInsets.symmetric(
              horizontal: context.space.lg,
              vertical: context.space.sm,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
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
                          Text(
                            _name(t.toUserId),
                            style: context.text.titleMedium,
                          ),
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
                      onPressed: () {
                        Haptics.warning(ref);
                        unawaited(_stop(context, ref, t));
                      },
                      child: Text(
                        mutations[t.id]?.phase == TempShareMutationPhase.failed
                            ? 'Retry'
                            : 'Stop',
                      ),
                    ),
                  ],
                ),
                if (mutations[t.id]?.phase == TempShareMutationPhase.failed)
                  Semantics(
                    liveRegion: true,
                    child: Padding(
                      padding: EdgeInsets.only(
                        left: context.space.xxl + context.space.md,
                      ),
                      child: Text(
                        'Could not stop sharing. Try again.',
                        style: context.text.bodySmall?.copyWith(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
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
            _ => AnimatedSwitcher(
              duration: _mutationTransitionDuration(context, ref),
              switchInCurve: Curves.easeOutQuart,
              switchOutCurve: Curves.easeOutQuart,
              transitionBuilder: (child, animation) => SizeTransition(
                sizeFactor: animation,
                alignment: Alignment.topCenter,
                child: child,
              ),
              child: _RequestsContent(
                key: ValueKey(
                  '${incoming.map((request) => request.id).join(',')}|'
                  '${outgoing.map((request) => request.id).join(',')}',
                ),
                incoming: incoming,
                outgoing: outgoing,
                onRefresh: refresh,
              ),
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
    super.key,
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

class _RequestRow extends ConsumerWidget {
  const _RequestRow({
    required this.request,
    this.showTimestamp = false,
    super.key,
  });
  final ShareRequest request;
  final bool showTimestamp;

  Future<void> _run({
    required BuildContext context,
    required WidgetRef ref,
    required RequestMutationAction action,
  }) async {
    final messenger = ScaffoldMessenger.of(context);
    final view = View.of(context);
    final direction = Directionality.of(context);
    final canAnnounce = MediaQuery.supportsAnnounceOf(context);
    final controller = ref.read(requestsControllerProvider.notifier);
    final outcome = switch (action) {
      RequestMutationAction.accept => await controller.accept(request),
      RequestMutationAction.decline => await controller.decline(request),
    };
    final message = switch ((action, outcome)) {
      (_, MutationOutcome.ignored) => null,
      (RequestMutationAction.accept, MutationOutcome.succeeded) =>
        'Request accepted.',
      (RequestMutationAction.accept, MutationOutcome.succeededNeedsRefresh) =>
        'Request accepted. Pull to refresh people.',
      (RequestMutationAction.decline, MutationOutcome.succeeded) =>
        'Request declined.',
      (RequestMutationAction.decline, MutationOutcome.succeededNeedsRefresh) =>
        'Request declined.',
      (RequestMutationAction.accept, MutationOutcome.failed) =>
        'Could not accept the request. Try again.',
      (RequestMutationAction.decline, MutationOutcome.failed) =>
        'Could not decline the request. Try again.',
    };
    if (message == null) return;
    messenger.showSnackBar(SnackBar(content: Text(message)));
    if (canAnnounce) {
      unawaited(SemanticsService.sendAnnouncement(view, message, direction));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = request;
    final mutation = ref.watch(
      requestMutationsProvider.select((mutations) => mutations[r.id]),
    );
    final failed = mutation?.phase == MutationPhase.failed;
    final failedAction = mutation?.action;
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
                if (showTimestamp && r.createdAt != null)
                  Text(
                    'Requested ${relativeSince(r.createdAt!.millisecondsSinceEpoch)}',
                    style: context.text.bodySmall?.copyWith(
                      color: context.colors.onSurfaceVariant,
                    ),
                  ),
                if (failed)
                  Semantics(
                    liveRegion: true,
                    child: Text(
                      failedAction == RequestMutationAction.accept
                          ? 'Could not accept. Try again.'
                          : 'Could not decline. Try again.',
                      style: context.text.bodySmall?.copyWith(
                        color: context.colors.onSurfaceVariant,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (failed) ...[
            TextButton(
              onPressed: () =>
                  _run(context: context, ref: ref, action: failedAction!),
              child: const Text('Retry'),
            ),
          ] else ...[
            IconButton(
              tooltip: 'Decline',
              icon: const Icon(Icons.close),
              onPressed: () {
                Haptics.warning(ref);
                unawaited(
                  _run(
                    context: context,
                    ref: ref,
                    action: RequestMutationAction.decline,
                  ),
                );
              },
            ),
            IconButton.filled(
              tooltip: 'Accept',
              icon: const Icon(Icons.check),
              onPressed: () {
                Haptics.commit(ref);
                unawaited(
                  _run(
                    context: context,
                    ref: ref,
                    action: RequestMutationAction.accept,
                  ),
                );
              },
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
