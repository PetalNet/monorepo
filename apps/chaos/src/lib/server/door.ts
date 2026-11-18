import { KEV_CAUSE, worst, type Cause, type KevEntry } from "./kev";
import type { Store } from "./store";

/** CISA dates entries in US Eastern time, so a door opens and closes on that clock. */
function doorDate(now: Date): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

export type DoorState = "locked" | "today" | "opened";

export interface StripDoor {
	/** "pre" for the pre-season door, else the December day, "1" to "24". */
	id: string;
	label: string;
	/** The ISO dates the door covers. Numbered doors cover one day. */
	from: string;
	to: string;
	state: DoorState;
	/**
	 * KEV additions on the door's dates so far. Absent for a locked door, and for an open door the
	 * page cannot vouch for: no pull has succeeded today (today's door) or since it closed.
	 */
	added: number | undefined;
}

export interface Reading {
	door: StripDoor;
	/**
	 * Today's door: a pull has succeeded today. An opened door: a pull has succeeded since the door
	 * closed. The page claims nothing about the door's dates without it.
	 */
	current: boolean;
	/** Additions on the dates this reading is about: today for today's door, else every door date. */
	added: number;
	/**
	 * The worst entry of the reading's dates. Today's door falls back to CISA's last day of
	 * additions, under that day's own date, when nothing was added today.
	 */
	item: KevEntry | undefined;
	shownDate: string | undefined;
	shownCount: number;
	cause: Cause;
}

export interface Panel {
	/** Today on the door clock. */
	date: string;
	strip: StripDoor[];
	reading: Reading;
	/** Additions today. Absent with no pull today, and once the season is over. */
	addedToday: number | undefined;
	/** The next door to unlock and the instant it does. Absent once every door is open. */
	next: { label: string; opensAt: string } | undefined;
	catalogSize: number;
	checkedAt: string | undefined;
}

/** A season starts with the pre-season door on November 18 and runs into the next year. */
function seasonYear(date: string): number {
	const year = Number(date.slice(0, 4));

	return date.slice(5) >= "11-18" ? year : year - 1;
}

function seasonDoors(year: number): Pick<StripDoor, "id" | "label" | "from" | "to">[] {
	const y = String(year);

	return [
		{ id: "pre", label: "Pre-season", from: `${y}-11-18`, to: `${y}-11-30` },
		...Array.from({ length: 24 }, (_, index) => {
			const day = `${y}-12-${String(index + 1).padStart(2, "0")}`;

			return { id: String(index + 1), label: `Door ${String(index + 1)}`, from: day, to: day };
		}),
	];
}

function doorState(door: { from: string; to: string }, date: string): DoorState {
	if (date < door.from) {
		return "locked";
	}

	return date <= door.to ? "today" : "opened";
}

/** The instant `date` starts on the door clock: midnight US Eastern, whichever offset is in force. */
function startOf(date: string): string {
	const start = [4, 5]
		.map((hour) => new Date(`${date}T0${String(hour)}:00:00Z`))
		.find(
			(instant) => doorDate(instant) === date && doorDate(new Date(instant.getTime() - 1)) !== date,
		);

	if (!start) {
		throw new Error(`no US Eastern midnight found for ${date}`);
	}

	return start.toISOString();
}

/** Whether a successful pull covers the door: today for today's door, after it closed otherwise. */
function vouched(
	door: { to: string; state: DoorState },
	date: string,
	checkedDate: string,
): boolean {
	return door.state === "today" ? checkedDate === date : checkedDate > door.to;
}

function readDoor(store: Store, door: StripDoor, date: string, checkedDate: string): Reading {
	if (door.state === "today") {
		const today = store.addedBetween(date, date);
		const shownDate = today.length > 0 ? date : store.latestDayBefore(date);
		const shown =
			today.length > 0 ? today : shownDate ? store.addedBetween(shownDate, shownDate) : [];

		return {
			door,
			current: vouched(door, date, checkedDate),
			added: today.length,
			item: worst(shown),
			shownDate,
			shownCount: shown.length,
			cause: KEV_CAUSE,
		};
	}

	const entries = store.addedBetween(door.from, door.to);
	const item = worst(entries);

	return {
		door,
		current: vouched(door, date, checkedDate),
		added: entries.length,
		item,
		shownDate: item?.dateAdded,
		shownCount: entries.length,
		cause: KEV_CAUSE,
	};
}

/**
 * The season strip and one door's reading. `wanted` is the door a visitor asked for. A locked or
 * unknown door falls back to today's door, or to the last opened door once the season is over.
 */
export function panel(store: Store, now: Date, wanted?: string): Panel {
	const date = doorDate(now);
	const checkedAt = store.checkedAt();
	const checkedDate = checkedAt ? doorDate(new Date(checkedAt)) : "";
	const doors = seasonDoors(seasonYear(date));
	const counts = store.countsByDay(doors[0]?.from ?? date, date);
	const strip = doors.map((door): StripDoor => {
		const state = doorState(door, date);
		let added: number | undefined;

		if (state !== "locked" && vouched({ ...door, state }, date, checkedDate)) {
			added = 0;

			for (const [day, count] of counts) {
				if (day >= door.from && day <= door.to) {
					added += count;
				}
			}
		}

		return { ...door, state, added };
	});
	const open = strip.filter((door) => door.state !== "locked");
	const door =
		open.find((candidate) => candidate.id === wanted) ??
		open.find((candidate) => candidate.state === "today") ??
		open.at(-1);

	if (!door) {
		throw new Error("a season always has its pre-season door open");
	}

	const locked = strip.find((candidate) => candidate.state === "locked");

	return {
		date,
		strip,
		reading: readDoor(store, door, date, checkedDate),
		addedToday:
			checkedDate === date && strip.some((candidate) => candidate.state === "today")
				? (counts.get(date) ?? 0)
				: undefined,
		next: locked && { label: locked.label, opensAt: startOf(locked.from) },
		catalogSize: store.size(),
		checkedAt,
	};
}
