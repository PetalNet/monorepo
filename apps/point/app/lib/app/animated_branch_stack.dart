import 'package:flutter/material.dart';

/// Keeps every shell branch mounted (so per-branch state survives tab switches,
/// like the default `IndexedStack`) **and** animates the switch with a subtle
/// shared-axis fade — the D-015 acceptance bar: the shell animates between
/// branches, never a hard indexed-stack cut.
class AnimatedBranchStack extends StatefulWidget {
  const AnimatedBranchStack({
    required this.activeBranch,
    required this.branches,
    super.key,
  });

  final int activeBranch;
  final List<Widget> branches;

  @override
  State<AnimatedBranchStack> createState() => _AnimatedBranchStackState();
}

class _AnimatedBranchStackState extends State<AnimatedBranchStack>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 260),
    value: 1,
  );
  late int _current = widget.activeBranch;
  int _previous = -1;

  @override
  void didUpdateWidget(AnimatedBranchStack old) {
    super.didUpdateWidget(old);
    if (widget.activeBranch != _current) {
      _previous = _current;
      _current = widget.activeBranch;
      _controller.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final t = Curves.easeOutCubic.transform(_controller.value);
        return Stack(
          fit: StackFit.expand,
          children: [
            for (var i = 0; i < widget.branches.length; i++)
              _branch(i, t),
          ],
        );
      },
    );
  }

  Widget _branch(int index, double t) {
    final isActive = index == _current;
    final isOutgoing = index == _previous && _controller.value < 1;
    if (!isActive && !isOutgoing) {
      // Mounted but offstage — state preserved, not painted, not interactive.
      return Offstage(
        child: TickerMode(enabled: false, child: widget.branches[index]),
      );
    }
    final entering = isActive;
    final opacity = entering ? t : 1 - t;
    // Slight vertical rise for the incoming branch (shared-axis Z feel).
    final dy = entering ? (1 - t) * 8.0 : 0.0;
    return IgnorePointer(
      ignoring: !isActive,
      child: Opacity(
        opacity: opacity.clamp(0, 1),
        child: Transform.translate(
          offset: Offset(0, dy),
          child: widget.branches[index],
        ),
      ),
    );
  }
}
