from __future__ import annotations

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_OWNER, CONF_TOKEN, CONF_URL, DOMAIN
from .head import HeadClient, HeadError


class JanetConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict | None = None) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                await HeadClient(async_get_clientsession(self.hass), user_input[CONF_URL], user_input[CONF_TOKEN]).check()
            except HeadError as error:
                errors["base"] = "invalid_auth" if error.status == 401 else "cannot_connect"
            else:
                return self.async_create_entry(title="Janet", data=user_input)
        owner = next((u.id for u in await self.hass.auth.async_get_users() if u.is_owner and u.is_active), "")
        schema = vol.Schema(
            {
                vol.Required(CONF_URL, default="http://10.10.10.202:8791"): str,
                vol.Required(CONF_TOKEN): str,
                vol.Required(CONF_OWNER, default=owner): str,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)
