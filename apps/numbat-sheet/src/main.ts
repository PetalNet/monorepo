import { mount } from "svelte";

import App from "./App.svelte";

const target = document.querySelector("#app");

if (!target) {
	throw new Error("index.html has no #app element");
}

mount(App, { target });
