"""One warm hub fork per surface.

The hub owns forks and their merges into main (soft digests on its own thresholds, a hard merge when a fork has been idle
for its idle time). The head only borrows the surface's fork: conversations within a short time of each other share it, so
the cost of spawning one and of its first turn is paid once, not once per conversation.
"""

import logging
import threading
import time
import uuid

from .merge import Hub, HubError

log = logging.getLogger("janet-voice-head")
SURFACE = "voice-desk"
# The hub merges and stops a fork that has been idle for 15 minutes; do not hand out one that is close to it.
REUSE_WITHIN_S = 600.0
WARM_UP = "[Warm-up: nobody is speaking yet. Reply with exactly NO_REPLY.]"


class ForkPool:
    def __init__(self, hub: Hub, surface: str = SURFACE, reuse_within: float = REUSE_WITHIN_S):
        self._hub, self.surface, self._reuse_within = hub, surface, reuse_within
        self._lock = threading.Lock()
        self._node: str | None = None
        self._last_used = 0.0

    def claim(self, label: str) -> str:
        with self._lock:
            if self._node is not None and time.monotonic() - self._last_used < self._reuse_within:
                self._last_used = time.monotonic()
                return self._node
            node = self._node = self._hub.fork_create(label, self.surface)
            self._last_used = time.monotonic()
        # The first turn of a fork pays its catch-up and cache load; paying it while the speaker is still talking hides it.
        threading.Thread(target=self._warm, args=(node,), daemon=True).start()
        return node

    def touch(self, node: str) -> None:
        with self._lock:
            if node == self._node:
                self._last_used = time.monotonic()

    def replace(self, label: str, dead: str) -> str:
        with self._lock:
            if self._node == dead:
                self._node = None
        return self.claim(label)

    def _warm(self, node: str) -> None:
        try:
            self._hub.fork_ask(node, WARM_UP, uuid.uuid4().hex, self.surface, lambda _: None)
        except (HubError, OSError) as error:
            log.warning("could not warm fork %s: %s", node, error)
