import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/services/server_config.dart';

void main() {
  group('ServerUrlNotifier.normalize', () {
    test('keeps a clean https origin unchanged', () {
      expect(
        ServerUrlNotifier.normalize('https://point.petalcat.dev'),
        'https://point.petalcat.dev',
      );
    });

    test('adds https:// when no scheme is given', () {
      expect(
        ServerUrlNotifier.normalize('point.petalcat.dev'),
        'https://point.petalcat.dev',
      );
    });

    test('strips a trailing slash', () {
      expect(
        ServerUrlNotifier.normalize('https://point.petalcat.dev/'),
        'https://point.petalcat.dev',
      );
    });

    test('strips a trailing /api (the client appends it)', () {
      expect(
        ServerUrlNotifier.normalize('https://point.petalcat.dev/api'),
        'https://point.petalcat.dev',
      );
      expect(
        ServerUrlNotifier.normalize('https://my.server.io/api/'),
        'https://my.server.io',
      );
    });

    test('preserves a custom host and port (self-hosted)', () {
      expect(
        ServerUrlNotifier.normalize('http://10.0.0.5:8330'),
        'http://10.0.0.5:8330',
      );
    });

    test('trims surrounding whitespace', () {
      expect(
        ServerUrlNotifier.normalize('  https://point.petalcat.dev  '),
        'https://point.petalcat.dev',
      );
    });
  });
}
