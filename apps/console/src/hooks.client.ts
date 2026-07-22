import { PublicEnvConfigLayer } from "$lib/config";
import { handleErrorWithSentry } from "@sentry/sveltekit";
import { ClientRuntime } from "svelte-effect-runtime";

ClientRuntime.make(PublicEnvConfigLayer);

export const handleError = handleErrorWithSentry();
