// Shared task-state vocabulary so every surface (TaskRow, SearchBox, …) reads the same.
// The LEFT indicator is our own kind icon (idea/question/doc/task — not GitHub's issue
// circle), TINTED by a status class. Shape = kind, colour = state.

// status → colour class (CSS owns the actual hue; intuitive, not GitHub's green=open).
const STATUS_CLS = {
	inbox: "todo",
	todo: "todo",
	doing: "doing",
	review: "review",
	blocked: "blocked",
	done: "done",
	dropped: "dropped",
};

export const statusClass = (status) => STATUS_CLS[status] ?? "todo";

// kind → our icon name (lucide via Icon.svelte). Not GitHub iconography.
const KIND_ICON = { task: "task", idea: "idea", question: "question", doc: "doc", upload: "doc" };

export const kindIcon = (kind) => KIND_ICON[kind] ?? "task";
