"""Janet as a Home Assistant conversation agent: a client of the voice head's /v1/conversations API."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_OWNER, CONF_TOKEN, CONF_URL
from .head import HeadClient
from .session import Sessions

PLATFORMS = ["conversation"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    head = HeadClient(async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_TOKEN])
    entry.runtime_data = Sessions(head, entry.data[CONF_OWNER])
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
