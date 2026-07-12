import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:point_app/features/map/presentation/self_marker.dart';
import 'package:point_app/theme/app_theme.dart';

Widget _wrap(Widget child) =>
    MaterialApp(theme: AppTheme.dark(pureBlack: true), home: Scaffold(body: child));

void main() {
  group('SelfMarker', () {
    testWidgets('two-word name → two initials', (tester) async {
      await tester.pumpWidget(_wrap(const SelfMarker(name: 'Parker Hasenkamp')));
      expect(find.text('PH'), findsOneWidget);
    });

    testWidgets('single-word name → first two letters', (tester) async {
      await tester.pumpWidget(_wrap(const SelfMarker(name: 'eli')));
      expect(find.text('EL'), findsOneWidget);
    });

    testWidgets('empty name → placeholder', (tester) async {
      await tester.pumpWidget(_wrap(const SelfMarker(name: '   ')));
      expect(find.text('?'), findsOneWidget);
    });

    testWidgets('is a 48dp hit target with a tap callback', (tester) async {
      var tapped = false;
      await tester.pumpWidget(
        _wrap(SelfMarker(name: 'You', onTap: () => tapped = true)),
      );
      await tester.tap(find.byType(SelfMarker));
      expect(tapped, isTrue);
    });
  });
}
