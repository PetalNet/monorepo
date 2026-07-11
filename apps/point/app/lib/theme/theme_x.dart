import 'package:flutter/material.dart';
import 'package:point_app/theme/app_radii.dart';
import 'package:point_app/theme/app_spacing.dart';
import 'package:point_app/theme/bridge_accent.dart';
import 'package:point_app/theme/presence_tokens.dart';

/// Ergonomic access to the design-system theme extensions.
extension ThemeX on BuildContext {
  ColorScheme get colors => Theme.of(this).colorScheme;
  TextTheme get text => Theme.of(this).textTheme;
  AppRadii get radii => Theme.of(this).extension<AppRadii>()!;
  AppSpacing get space => Theme.of(this).extension<AppSpacing>()!;
  PresenceTokens get presence => Theme.of(this).extension<PresenceTokens>()!;
  BridgeAccent get bridgeAccent => Theme.of(this).extension<BridgeAccent>()!;
}
