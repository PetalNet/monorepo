export const prompts = [
	{
		kind: "pos",
		say: "Hey Janet",
		how: "your normal voice",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "your normal voice, again",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "quietly, like someone's asleep nearby",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "almost a whisper",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "loud, like she's in another room",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "fast, in a hurry",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "slow and relaxed",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "cheerful",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "annoyed",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "tired, a bit mumbled",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "as a question: Hey Janet?",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "sing-song",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "flat and monotone",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "with a pause in the middle: Hey... Janet",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "while turning your head away",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "leaning back from the mic",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "standing up",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "from across the room",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "from across the room, louder",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "while moving around",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "the way you'd say it mid-sentence",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "right after a yawn or a laugh",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "higher pitch than usual",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "lower pitch than usual",
	},
	{
		kind: "pos",
		say: "Hey Janet",
		how: "your normal voice, one more",
	},
	{
		kind: "neg",
		say: "Hey Jane",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Hey Jenna",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Hey Janice",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Janet",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Hey Jarvis",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Hey, can it",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Hey Dad",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "A jacket",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "The planet",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Hey, wait",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Okay, and it",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Hey Jeanette",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "I was talking to Janet yesterday",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Say that again",
		how: "naturally. This one should NOT wake her",
	},
	{
		kind: "neg",
		say: "Hey, did you get it",
		how: "naturally. This one should NOT wake her",
	},
] as const;

const speakerPrompts = [
	{
		kind: "enroll",
		say: "The blue boat drifted past the quiet shore.",
		how: "Read in your usual speaking voice.",
	},
	{
		kind: "enroll",
		say: "Maya packed fresh peaches and a small jar of jam.",
		how: "Read in your usual speaking voice.",
	},
	{
		kind: "enroll",
		say: "At seven forty-five, the number twelve bus turned left.",
		how: "Read the numbers naturally.",
	},
	{
		kind: "enroll",
		say: "Would you rather walk through the woods or visit the museum?",
		how: "Ask it as a real question.",
	},
	{
		kind: "enroll",
		say: "Six bright stars shone above the frozen lake.",
		how: "Read in your usual speaking voice.",
	},
	{
		kind: "enroll",
		say: "Please bring three yellow cups to the kitchen.",
		how: "Say it as if asking a friend.",
	},
	{
		kind: "enroll",
		say: "Oliver's new jacket has a silver zipper.",
		how: "Read in your usual speaking voice.",
	},
	{
		kind: "enroll",
		say: "A gentle breeze moved the thick green leaves.",
		how: "Read in your usual speaking voice.",
	},
	{
		kind: "enroll",
		say: "We paid twenty-six dollars and fifty cents for lunch.",
		how: "Read the numbers naturally.",
	},
	{
		kind: "enroll",
		say: "Close the gate, then follow the gravel path beyond the bridge.",
		how: "Pause at the comma if you like.",
	},
	{
		kind: "free",
		say: "Describe your morning.",
		how: "Speak naturally for 20–30 seconds. Pauses are fine. You can stop whenever you like.",
	},
	{
		kind: "free",
		say: "Tell me about something you're into.",
		how: "Speak naturally for 20–30 seconds. Choose anything you feel comfortable sharing.",
	},
] as const;

export const recordingSets = { wake: prompts, speaker: speakerPrompts };
export type RecordingMode = keyof typeof recordingSets;
export const allPrompts = [...prompts, ...speakerPrompts];
export type Prompt = (typeof allPrompts)[number];
export type PromptKind = Prompt["kind"];
export function maxDuration(kind: PromptKind) {
	return kind === "free" ? 30 : kind === "enroll" ? 15 : 8;
}
