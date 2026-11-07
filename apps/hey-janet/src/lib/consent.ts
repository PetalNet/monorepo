import { z } from "zod";

export const consentVersion = "2026-10-07";
export const consentSchema = z.object({
	version: z.literal(consentVersion),
	at: z.iso.datetime(),
	wakeWord: z.boolean(),
	speakerRecognition: z.boolean(),
});
export type Consent = z.infer<typeof consentSchema>;
