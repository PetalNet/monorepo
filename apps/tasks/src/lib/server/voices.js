// Text-to-speech voices, configured as comma-separated name=id pairs in ELEVEN_VOICES.
// The client only ever sees and sends a name; the server maps it to the provider id.
export const VOICES = Object.fromEntries(
	(process.env.ELEVEN_VOICES || "")
		.split(",")
		.map((pair) => pair.split("=").map((part) => part.trim()))
		.filter(([name, id]) => name && id),
);

export const VOICE_NAMES = Object.keys(VOICES);
