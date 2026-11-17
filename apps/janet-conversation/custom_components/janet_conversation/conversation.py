from __future__ import annotations

import logging

from homeassistant.components import conversation
from homeassistant.components.conversation import ChatLog, ConversationEntity, ConversationInput, ConversationResult
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .head import Sentence
from .session import Sessions

_LOGGER = logging.getLogger(__name__)
UNREACHABLE = "I can't reach Janet right now."


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    add([JanetConversationEntity(entry)])


class JanetConversationEntity(ConversationEntity):
    _attr_has_entity_name = True
    _attr_name = None
    _attr_supported_features = conversation.ConversationEntityFeature(0)

    def __init__(self, entry: ConfigEntry) -> None:
        self.entry = entry
        self._attr_unique_id = entry.entry_id

    @property
    def supported_languages(self) -> list[str] | str:
        return MATCH_ALL

    @property
    def _sessions(self) -> Sessions:
        return self.entry.runtime_data

    def _device_name(self, user_input: ConversationInput) -> str | None:
        device_id = user_input.device_id
        if device_id is None:
            return None
        device = dr.async_get(self.hass).async_get(device_id)
        return (device.name_by_user or device.name) if device else None

    async def _async_handle_message(self, user_input: ConversationInput, chat_log: ChatLog) -> ConversationResult:
        sessions = self._sessions
        ha_id = chat_log.conversation_id
        user_id = user_input.context.user_id if user_input.context else None
        device = self._device_name(user_input)

        async def deltas():
            yield {"role": "assistant"}
            spoke = False
            try:
                async for item in sessions.turn(ha_id, user_id, device, user_input.text):
                    if isinstance(item, Sentence):
                        spoke = True
                        yield {"content": item.text + " "}
            except Exception as error:  # a broken head must be heard, not a stack trace
                _LOGGER.warning("Janet turn failed: %s", error)
                if not spoke:
                    yield {"content": UNREACHABLE}

        async for _ in chat_log.async_add_delta_content_stream(self.entity_id, deltas()):
            pass
        return conversation.async_get_result_from_chat_log(user_input, chat_log)
