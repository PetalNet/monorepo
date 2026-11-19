/** "3h ago" for a SQLite UTC timestamp ("2026-11-19 02:30:29"). */
export function ago(ts) {
	if (!ts) {
		return "";
	}

	const s = Math.round((Date.now() - new Date(ts.replace(" ", "T") + "Z").getTime()) / 1000);

	if (s < 60) {
		return "just now";
	}

	if (s < 3600) {
		return Math.round(s / 60) + "m ago";
	}

	if (s < 86400) {
		return Math.round(s / 3600) + "h ago";
	}

	if (s < 604800) {
		return Math.round(s / 86400) + "d ago";
	}

	return Math.round(s / 604800) + "w ago";
}
