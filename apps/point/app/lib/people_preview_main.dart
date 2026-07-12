import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/people/people_controller.dart';
import 'package:point_app/features/people/presentation/people_screen.dart';
import 'package:point_app/features/people/requests_controller.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/services/auth_controller.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// Craft-only render preview of the People tab (Wave 2): a pinned incoming
/// request + active people rows. The real request→accept→list→detail path is
/// verified against the live test server separately; this is for pixel craft.
void main() {
  runApp(
    ProviderScope(
      overrides: [
        peopleControllerProvider.overrideWith(_PreviewPeople.new),
        requestsControllerProvider.overrideWith(_PreviewRequests.new),
        authControllerProvider.overrideWith(_PreviewAuth.new),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.dark(pureBlack: true),
        darkTheme: AppTheme.dark(pureBlack: true),
        themeMode: ThemeMode.dark,
        home: const PeopleScreen(),
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
          userId: 'eli@point.petalcat.dev',
          displayName: 'Eli',
          presence: PresenceState.live,
          subtitle: 'Sharing · 2m',
          lat: 38.631,
          lon: -90.201,
        ),
        Person(
          userId: 'mara@fieldstone.social',
          displayName: 'Mara Quinn',
          presence: PresenceState.away,
          subtitle: 'mara@fieldstone.social',
        ),
      ];
}

class _PreviewRequests extends RequestsController {
  @override
  Future<List<ShareRequest>> build() async => const [
        ShareRequest(
          id: '1',
          fromUserId: 'devon@point.petalcat.dev',
          fromDisplayName: 'Devon R',
        ),
      ];
}
