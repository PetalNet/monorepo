import { saveServer, settings } from "../../src/settings.ts";

function required<T>(element: T | null): T {
	if (element === null) {
		throw new Error("Options page is missing required controls.");
	}

	return element;
}

const form = required(document.querySelector<HTMLFormElement>("#settings"));
const input = required(document.querySelector<HTMLInputElement>("#server"));
const status = required(document.querySelector<HTMLOutputElement>("#status"));

const { server } = await settings();

input.value = server ?? "";

async function save(value: string): Promise<string> {
	try {
		const approved = await saveServer(value);

		return approved ? "Saved. This server is opt-in." : "Permission was not granted.";
	} catch {
		return "Enter a valid server URL.";
	}
}

form.addEventListener("submit", (event) => {
	event.preventDefault();

	void (async () => {
		if (input.value.trim() === "") {
			await saveServer("");
			status.value = "Local rendering is active.";
		} else {
			status.value = await save(input.value);
		}
	})();
});
