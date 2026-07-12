import 'dart:typed_data';

import 'package:image/image.dart' as img;

/// Turn any picked photo into the photo-dot payload: center-cropped square,
/// scaled to 256px, JPEG at quality 82. Comfortably inside the server's
/// 128 KiB cap and identical everywhere it renders. Returns null when the
/// bytes do not decode as an image.
Uint8List? preparePhotoDot(Uint8List raw) {
  final decoded = img.decodeImage(raw);
  if (decoded == null) return null;
  // Bake the EXIF orientation in BEFORE cropping, or portrait photos rotate.
  final oriented = img.bakeOrientation(decoded);
  final side = oriented.width < oriented.height
      ? oriented.width
      : oriented.height;
  final cropped = img.copyCrop(
    oriented,
    x: (oriented.width - side) ~/ 2,
    y: (oriented.height - side) ~/ 2,
    width: side,
    height: side,
  );
  final scaled = img.copyResize(
    cropped,
    width: 256,
    height: 256,
    interpolation: img.Interpolation.average,
  );
  return Uint8List.fromList(img.encodeJpg(scaled, quality: 82));
}
