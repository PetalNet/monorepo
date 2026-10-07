import type { RecordingMode } from "./prompts";

export interface Progress {
	mode?: RecordingMode;
	name: string;
	participantId: string;
	setId: string;
	index: number;
	accepted: number;
	skipped: number;
}
export interface Take {
	id: string;
	setId: string;
	participantId: string;
	index: number;
	wav: ArrayBuffer;
	attempts: number;
	next: number;
	problem: string;
}
function database(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open("hey-janet", 1);
		request.addEventListener("upgradeneeded", () => {
			request.result.createObjectStore("takes", { keyPath: "id" });
			request.result.createObjectStore("state");
		});
		request.addEventListener("success", () => {
			resolve(request.result);
		});
		request.addEventListener("error", () => {
			reject(request.error ?? new Error("Local storage failed"));
		});
	});
}
async function transaction<T>(
	stores: string[],
	mode: IDBTransactionMode,
	work: (tx: IDBTransaction) => IDBRequest<T>,
): Promise<T> {
	const db = await database();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(stores, mode);
		const request = work(tx);
		tx.addEventListener("complete", () => {
			db.close();
			resolve(request.result);
		});
		tx.addEventListener("error", () => {
			db.close();
			reject(tx.error ?? new Error("Local storage failed"));
		});
		tx.addEventListener("abort", () => {
			db.close();
			reject(tx.error ?? new Error("Local storage failed"));
		});
	});
}
function progress() {
	return transaction<Progress | undefined>(
		["state"],
		"readonly",
		(tx) => tx.objectStore("state").get("progress") as IDBRequest<Progress | undefined>,
	);
}
function saveProgress(p: Progress) {
	return transaction(["state"], "readwrite", (tx) =>
		tx.objectStore("state").put({ ...p }, "progress"),
	);
}
function takes() {
	return transaction<Take[]>(
		["takes"],
		"readonly",
		(tx) => tx.objectStore("takes").getAll() as IDBRequest<Take[]>,
	);
}
function accept(t: Take, p: Progress) {
	return transaction(["takes", "state"], "readwrite", (tx) => {
		tx.objectStore("takes").put({ ...t });
		return tx.objectStore("state").put({ ...p }, "progress");
	});
}
function update(t: Take) {
	return transaction(["takes"], "readwrite", (tx) => tx.objectStore("takes").put({ ...t }));
}
function remove(id: string) {
	return transaction(["takes"], "readwrite", (tx) => tx.objectStore("takes").delete(id));
}

function clear() {
	return transaction(["takes", "state"], "readwrite", (tx) => {
		tx.objectStore("takes").clear();
		return tx.objectStore("state").clear();
	});
}

export const queue = { progress, saveProgress, takes, accept, update, remove, clear };
