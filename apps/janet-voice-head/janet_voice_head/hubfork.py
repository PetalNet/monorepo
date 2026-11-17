"""A warm hub fork per surface, so a conversation does not wait for a fork to spawn."""

import logging
import threading
import time

from .merge import Hub, HubError

log = logging.getLogger("janet-voice-head")
SURFACE = "voice-desk"
# The hub parks an idle fork after 15 minutes; replace the spare well before that.
SPARE_MAX_AGE_S = 600.0


class ForkPool:
    def __init__(self, hub: Hub, surface: str = SURFACE, max_age: float = SPARE_MAX_AGE_S):
        self._hub, self.surface, self._max_age = hub, surface, max_age
        self._lock = threading.Lock()
        self._spare: tuple[str, float] | None = None
        self._refilling = False
        self.refill()

    def claim(self, label: str) -> str:
        """A fork for one conversation: the warm spare if it is fresh, otherwise a new one."""
        with self._lock:
            spare, self._spare = self._spare, None
        threading.Thread(target=self.refill, daemon=True).start()
        if spare is not None and time.monotonic() - spare[1] < self._max_age:
            return spare[0]
        return self._hub.fork_create(label, self.surface)

    def fresh(self, label: str) -> str:
        return self._hub.fork_create(label, self.surface)

    def refill(self) -> None:
        with self._lock:
            if self._refilling or self._spare is not None:
                return
            self._refilling = True
        try:
            node = self._hub.fork_create("voice-desk spare", self.surface)
            with self._lock:
                self._spare = (node, time.monotonic())
        except HubError as error:
            log.warning("no warm fork: %s", error)
        finally:
            with self._lock:
                self._refilling = False

    def maintain(self) -> None:
        with self._lock:
            stale = self._spare is not None and time.monotonic() - self._spare[1] >= self._max_age
            if stale:
                self._spare = None
        self.refill()
