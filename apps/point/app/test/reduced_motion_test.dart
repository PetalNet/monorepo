import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:point_app/features/ghost/ghost_controller.dart';
import 'package:point_app/features/ghost/presentation/ghost_screen.dart';
import 'package:point_app/features/me/presentation/settings_widgets.dart';
import 'package:point_app/features/onboarding/presentation/privacy_fork_screen.dart';
import 'package:point_app/features/settings/app_settings.dart';
import 'package:point_app/services/api/models.dart';
import 'package:point_app/theme/app_theme.dart';
import 'package:point_app/widgets/ghost_toggle.dart';
import 'package:point_app/widgets/pill_button.dart';

Widget _host({required bool reduced, required bool sharing}) => MaterialApp(
  theme: AppTheme.dark(),
  builder: (context, child) => ReducedMotionScope(
    reduced: reduced,
    child: child ?? const SizedBox.shrink(),
  ),
  home: Scaffold(
    body: Center(
      child: GhostToggle(sharing: sharing, onChanged: (_) {}),
    ),
  ),
);

Widget _motionHost({
  required Widget child,
  bool? reduced,
  bool systemDisabled = false,
}) => MaterialApp(
  theme: AppTheme.dark(),
  builder: (context, appChild) {
    final mediaQuery = MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(disableAnimations: systemDisabled),
      child: appChild ?? const SizedBox.shrink(),
    );
    return reduced == null
        ? mediaQuery
        : ReducedMotionScope(reduced: reduced, child: mediaQuery);
  },
  home: Scaffold(body: child),
);

class _Ghost extends GhostController {
  @override
  Future<GhostState> build() async => const GhostState(active: false);
}

void main() {
  group('reduced-motion resolution', () {
    test('system follows the operating-system preference', () {
      expect(
        resolveReducedMotion(
          preference: MotionPreference.system,
          systemDisabled: false,
        ),
        isFalse,
      );
      expect(
        resolveReducedMotion(
          preference: MotionPreference.system,
          systemDisabled: true,
        ),
        isTrue,
      );
    });

    test('explicit reduced and full settings override the system', () {
      expect(
        resolveReducedMotion(
          preference: MotionPreference.reduced,
          systemDisabled: false,
        ),
        isTrue,
      );
      expect(
        resolveReducedMotion(
          preference: MotionPreference.full,
          systemDisabled: true,
        ),
        isFalse,
      );
    });
  });

  group('GhostToggle state transition', () {
    testWidgets('moves immediately when motion is reduced', (tester) async {
      await tester.pumpWidget(_host(reduced: true, sharing: false));
      final start = tester.getCenter(find.byIcon(Icons.visibility_off)).dx;

      await tester.pumpWidget(_host(reduced: true, sharing: true));
      final end = tester.getCenter(find.byIcon(Icons.arrow_forward)).dx;

      expect(end, greaterThan(start));
    });

    testWidgets('preserves the semantic transition at full motion', (
      tester,
    ) async {
      await tester.pumpWidget(_host(reduced: false, sharing: false));
      final start = tester.getCenter(find.byIcon(Icons.visibility_off)).dx;

      await tester.pumpWidget(_host(reduced: false, sharing: true));
      expect(tester.getCenter(find.byIcon(Icons.arrow_forward)).dx, start);

      await tester.pump(const Duration(milliseconds: 100));
      final midpoint = tester.getCenter(find.byIcon(Icons.arrow_forward)).dx;
      expect(midpoint, greaterThan(start));

      await tester.pumpAndSettle();
      final end = tester.getCenter(find.byIcon(Icons.arrow_forward)).dx;
      expect(end, greaterThan(midpoint));
    });
  });

  testWidgets('named primitives all use zero-duration reduced transitions', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [ghostControllerProvider.overrideWith(_Ghost.new)],
        child: _motionHost(
          reduced: true,
          child: Column(
            children: [
              PillButton(label: 'Continue', onPressed: () {}),
              SettingsChoiceRow<int>(
                title: 'Choice',
                value: 1,
                options: const [(1, 'One', null), (2, 'Two', null)],
                onSelected: (_) {},
              ),
              const Expanded(child: GhostScreen()),
            ],
          ),
        ),
      ),
    );

    expect(
      tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity)).duration,
      Duration.zero,
    );
    expect(
      tester
          .widgetList<AnimatedContainer>(find.byType(AnimatedContainer))
          .map((widget) => widget.duration),
      everyElement(Duration.zero),
    );

    await tester.tap(find.text('Choice'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widgetList<AnimatedContainer>(find.byType(AnimatedContainer))
          .map((widget) => widget.duration),
      everyElement(Duration.zero),
    );
  });

  testWidgets('OS-disabled onboarding choices transition synchronously', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        child: _motionHost(
          systemDisabled: true,
          child: const PrivacyForkScreen(),
        ),
      ),
    );
    await tester.pump();

    final cards = tester.widgetList<AnimatedContainer>(
      find.byType(AnimatedContainer),
    );
    expect(cards, isNotEmpty);
    expect(
      cards.map((widget) => widget.duration),
      everyElement(Duration.zero),
    );

    await tester.scrollUntilVisible(
      find.text('Convenient'),
      240,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Convenient'));
    await tester.pump();
    expect(
      tester
          .widgetList<AnimatedContainer>(find.byType(AnimatedContainer))
          .map((widget) => widget.duration),
      everyElement(Duration.zero),
    );
  });
}
