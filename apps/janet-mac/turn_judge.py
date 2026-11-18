"""The turn detector lives in packages/janet-turn (janet_turn.turn_judge). This file keeps the old path working.

install.sh copies it next to a janet_turn/ directory; in the repository the package is found under packages/.
Run as a script it runs the package's command line, and imported it is the package's module itself.
"""

import sys
from pathlib import Path

_here = Path(__file__).resolve().parent
for _root in (_here, _here.parents[1] / "packages" / "janet-turn"):
    if (_root / "janet_turn").is_dir():
        sys.path.insert(0, str(_root))
        break

import janet_turn.turn_judge as _impl  # noqa: E402

if __name__ == "__main__":
    raise SystemExit("turn_judge has no command line")
else:
    sys.modules[__name__] = _impl
