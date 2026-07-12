import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/presentation/person_detail_screen.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// Craft-only render preview of PersonDetail (Wave 4): a dark person with a
/// frozen last-known map, "dark since", and the per-person hide toggle.
void main() {
  runApp(
    ProviderScope(
      overrides: [
        peopleControllerProvider.overrideWith(_PreviewPeople.new),
        ghostControllerProvider.overrideWith(_PreviewGhost.new),
        authControllerProvider.overrideWith(_PreviewAuth.new),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.dark(pureBlack: true),
        darkTheme: AppTheme.dark(pureBlack: true),
        themeMode: ThemeMode.dark,
        home: const PersonDetailScreen(userId: 'mara@fieldstone.social'),
      ),
    ),
  );
}

class _PreviewAuth extends AuthController {
  @override
  Future<Session?> build() async => const Session(
        userId: 'parker@point.petalcat.dev',
        token: 't',
        displayName: 'Parker H',
        isAdmin: true,
      );
}

class _PreviewPeople extends PeopleController {
  @override
  Future<List<Person>> build() async => const [
        Person(
          userId: 'mara@fieldstone.social',
          displayName: 'Mara Quinn',
          presence: PresenceState.stale,
          subtitle: 'Dark since 14:07',
          lat: 38.627,
          lon: -90.199,
        ),
      ];
}

class _PreviewGhost extends GhostController {
  @override
  Future<GhostState> build() async => const GhostState(active: false);
}
