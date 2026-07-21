import { handleErrorWithSentry } from "@sentry/sveltekit";
import { ClientRuntime } from "svelte-effect-runtime";

ClientRuntime.make();

export const handleError = handleErrorWithSentry();
