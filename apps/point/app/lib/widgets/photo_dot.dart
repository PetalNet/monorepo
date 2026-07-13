import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/me/avatar_provider.dart';
import 'package:point_app/widgets/initials_avatar.dart';

enum PersonSharedElement { avatar, marker }

/// A stable, typed identity for a person's shared elements.
///
/// Avatar and marker flights intentionally use separate tags: person detail
/// contains both destinations at once, so sharing one tag would create a
/// duplicate-Hero failure.
@immutable
class PersonHeroTag {
  const PersonHeroTag(this.userId, this.element);

  final String userId;
  final PersonSharedElement element;

  @override
  bool operator ==(Object other) =>
      other is PersonHeroTag &&
      other.userId == userId &&
      other.element == element;

  @override
  int get hashCode => Object.hash(userId, element);

  @override
  String toString() => 'PersonHeroTag($userId, ${element.name})';
}

/// Declares exactly which person identities may take part in Hero flights in
/// this route subtree.
///
/// Point's shell keeps every branch mounted. An explicit scope prevents an
/// inactive branch, or an unrelated PhotoDot elsewhere in the app, from
/// registering a duplicate tag.
class PersonSharedElementScope extends InheritedWidget {
  const PersonSharedElementScope({
    required this.elements,
    required super.child,
    this.animateMarkerOrigin = false,
    super.key,
  });

  final Set<PersonSharedElement> elements;
  final bool animateMarkerOrigin;

  static bool allows(BuildContext context, PersonSharedElement element) =>
      context
          .dependOnInheritedWidgetOfExactType<PersonSharedElementScope>()
          ?.elements
          .contains(element) ??
      false;

  static bool animateMarkerFromOrigin(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<PersonSharedElementScope>()
          ?.animateMarkerOrigin ??
      false;

  @override
  bool updateShouldNotify(PersonSharedElementScope oldWidget) =>
      !setEquals(oldWidget.elements, elements) ||
      oldWidget.animateMarkerOrigin != animateMarkerOrigin;
}

/// Opt-in shared identity used by the active shell branch and person detail.
class PersonSharedElementHero extends StatelessWidget {
  const PersonSharedElementHero({
    required this.userId,
    required this.element,
    required this.child,
    super.key,
  });

  final String userId;
  final PersonSharedElement element;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (!PersonSharedElementScope.allows(context, element) ||
        !TickerMode.valuesOf(context).enabled) {
      return child;
    }
    return Hero(
      tag: PersonHeroTag(userId, element),
      transitionOnUserGestures: true,
      flightShuttleBuilder: (_, _, direction, from, to) {
        final fromHero = from.widget as Hero;
        final toHero = to.widget as Hero;
        return PersonHeroFlight(
          child: direction == HeroFlightDirection.push
              ? toHero.child
              : fromHero.child,
        );
      },
      child: child,
    );
  }
}

/// Keeps the shared identity on a transparent Material while it crosses route
/// overlays such as the map's person sheet.
class PersonHeroFlight extends StatelessWidget {
  const PersonHeroFlight({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Material(type: MaterialType.transparency, child: child);
  }
}

/// The photo-dot: a person's avatar in a circle, monogram fallback while
/// loading or when they have none. The identity element everywhere a person
/// appears (me-header, rows, markers).
class PhotoDot extends ConsumerWidget {
  const PhotoDot({
    required this.userId,
    required this.name,
    this.size = 56,
    super.key,
  });

  final String userId;
  final String name;
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bytes = ref.watch(avatarProvider(userId)).value;
    final avatar = bytes == null
        ? InitialsAvatar(name: name, size: size)
        : ClipOval(
            child: Image.memory(
              bytes,
              width: size,
              height: size,
              fit: BoxFit.cover,
              gaplessPlayback: true,
              // A corrupt payload falls back to the monogram, not a broken
              // tile.
              errorBuilder: (_, _, _) => InitialsAvatar(name: name, size: size),
            ),
          );
    return PersonSharedElementHero(
      userId: userId,
      element: PersonSharedElement.avatar,
      child: avatar,
    );
  }
}
