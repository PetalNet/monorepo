/**
 * Snackbar stack (foundations §2.1 bottom-edge contract): bottom-left, capped at 2 visible + a "N
 * more" collapse, clear of the centered dock. Every fired op lands a snackbar naming the op, with
 * an undo where the op supports it (§4.2).
 */
export interface Snack {
	id: number;
	message: string;
	op?: string;
	undo?: { op: string; args: Record<string, unknown> };
	onUndo?: () => void | Promise<void>;
	actionLabel?: "Undo" | "Retry";
	tone: "good" | "warn" | "danger";
}

let seq = 0;
class SnackbarStore {
	items = $state<Snack[]>([]);

	push(s: Omit<Snack, "id">): number {
		const id = ++seq;
		this.items = [...this.items, { ...s, id }];
		// auto-dismiss after 6s unless it carries an undo the user may want.
		const ttl = s.undo ? 9000 : 6000;
		setTimeout(() => {
			this.dismiss(id);
		}, ttl);
		return id;
	}

	dismiss(id: number): void {
		this.items = this.items.filter((i) => i.id !== id);
	}
}

export const snackbar = new SnackbarStore();
