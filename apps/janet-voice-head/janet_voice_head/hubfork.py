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
    """Idle forks wait here between conversations; a conversation owns its fork alone while it runs."""

    def __init__(self, hub: Hub, surface: str = SURFACE, reuse_within: float = REUSE_WITHIN_S, warm_wait: float = 20.0):
        self._hub, self.surface, self._reuse_within, self._warm_wait = hub, surface, reuse_within, warm_wait
        self._lock = threading.Lock()
        self._idle: list[tuple[str, float]] = []  # (node, when the hub last finished a turn on it)
        self._warm: dict[str, threading.Event] = {}
        self._last_turn: dict[str, float] = {}

    def claim(self, label: str) -> str:
        """A fork for one conversation: an idle one the hub has not been about to merge, otherwise a new one."""
        now = time.monotonic()
        with self._lock:
            self._idle = [(n, t) for n, t in self._idle if now - t < self._reuse_within]
            if self._idle:
                node, _ = self._idle.pop()
                return node
        node = self._hub.fork_create(label, self.surface)
        done = threading.Event()
        with self._lock:
            self._warm[node] = done
            self._last_turn[node] = time.monotonic()
        # The first turn of a fork pays its catch-up and cache load; paying it while the speaker is still talking hides it.
        threading.Thread(target=self._warm_up, args=(node, done), daemon=True).start()
        return node

    def ready(self, node: str) -> None:
        """Waits, briefly, for the warm-up turn so the first real ask does not race it."""
        with self._lock:
            done = self._warm.get(node)
        if done is not None:
            done.wait(self._warm_wait)

    def touched(self, node: str) -> None:
        with self._lock:
            self._last_turn[node] = time.monotonic()

    def release(self, node: str) -> None:
        with self._lock:
            self._idle.append((node, self._last_turn.get(node, time.monotonic())))

    def replace(self, label: str, dead: str) -> str:
        with self._lock:
            self._warm.pop(dead, None)
            self._last_turn.pop(dead, None)
        return self.claim(label)

    def _warm_up(self, node: str, done: threading.Event) -> None:
        try:
            self._hub.fork_ask(node, WARM_UP, uuid.uuid4().hex, self.surface, lambda _: None)
        except (HubError, OSError) as error:
            log.warning("could not warm fork %s: %s", node, error)
        finally:
            done.set()
            self.touched(node)
