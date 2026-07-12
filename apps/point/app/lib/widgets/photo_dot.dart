import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/me/avatar_provider.dart';
import 'package:point_app/widgets/initials_avatar.dart';

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
    if (bytes == null) return InitialsAvatar(name: name, size: size);
    return ClipOval(
      child: Image.memory(
        bytes,
        width: size,
        height: size,
        fit: BoxFit.cover,
        gaplessPlayback: true,
        // A corrupt payload falls back to the monogram, not a broken tile.
        errorBuilder: (_, _, _) => InitialsAvatar(name: name, size: size),
      ),
    );
  }
}
