export interface AssistantContextChip {
	label: string;
}

export interface LibraryChatMessage {
	id: string;
	role: "user" | "assistant" | "error";
	content: string;
}

export type LibraryView = "list" | "graph" | "kanban" | "table";
