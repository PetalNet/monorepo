import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/app/point_app.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/presentation/share_sheet.dart';
import 'package:point_app/theme/theme_x.dart';
import 'package:point_app/widgets/person_row.dart';

/// People + share (mockup screen 3): dense calm rows, then a "Share your
/// location" action strip that opens the share bottom sheet.
class PeopleScreen extends ConsumerWidget {
  const PeopleScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final peopleAsync = ref.watch(peopleControllerProvider);
    final people = peopleAsync.value ?? const [];

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
            icon: const Icon(Icons.add),
            tooltip: 'Add person',
            onPressed: () => ShareSheet.show(context),
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: Column(
            children: [
              Expanded(
                child: people.isEmpty
                    ? const _EmptyPeople()
                    : ListView.builder(
                        padding: EdgeInsets.only(top: context.space.sm),
                        itemCount: people.length,
                        itemBuilder: (context, i) =>
                            PersonRow(person: people[i]),
                      ),
              ),
              const _ShareStrip(),
            ],
          ),
        ),
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
          ],
        ),
      ),
    );
  }
}

/// The pinned "Share your location" strip: Add person · For 1 hour · Link.
class _ShareStrip extends StatelessWidget {
  const _ShareStrip();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: EdgeInsets.all(context.space.lg),
      padding: EdgeInsets.all(context.space.md),
      decoration: BoxDecoration(
        color: context.colors.surfaceContainer,
        borderRadius: context.radii.brXl,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(
              context.space.sm,
              context.space.sm,
              context.space.sm,
              context.space.md,
            ),
            child: Text('Share your location', style: context.text.titleMedium),
          ),
          Row(
            children: [
              _ShareTile(
                icon: Icons.person_add_alt,
                label: 'Add\nperson',
                onTap: () => ShareSheet.show(context),
              ),
              _ShareTile(
                icon: Icons.schedule,
                label: 'For 1\nhour',
                onTap: () => ShareSheet.show(context, timed: true),
              ),
              _ShareTile(
                icon: Icons.arrow_forward,
                label: 'Link',
                onTap: () => ShareSheet.show(context, link: true),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ShareTile extends StatelessWidget {
  const _ShareTile({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Padding(
        padding: EdgeInsets.all(context.space.xs),
        child: Material(
          color: context.colors.surfaceContainerHigh,
          borderRadius: context.radii.brMd,
          child: InkWell(
            onTap: onTap,
            borderRadius: context.radii.brMd,
            child: Padding(
              padding: EdgeInsets.symmetric(vertical: context.space.lg),
              child: Column(
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: context.colors.surface,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(icon, size: 20, color: context.colors.onSurface),
                  ),
                  SizedBox(height: context.space.sm),
                  Text(
                    label,
                    textAlign: TextAlign.center,
                    style: context.text.labelLarge,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
