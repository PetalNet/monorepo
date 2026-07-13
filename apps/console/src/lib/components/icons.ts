import ChartLine from "@lucide/svelte/icons/chart-line";
import CircleCheck from "@lucide/svelte/icons/circle-check";
import CircleHelp from "@lucide/svelte/icons/circle-help";
import DoorOpen from "@lucide/svelte/icons/door-open";
import Kanban from "@lucide/svelte/icons/kanban";
import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
import LibraryBig from "@lucide/svelte/icons/library-big";
import Mail from "@lucide/svelte/icons/mail";
import Mails from "@lucide/svelte/icons/mails";
import MousePointer2 from "@lucide/svelte/icons/mouse-pointer-2";
import RadioTower from "@lucide/svelte/icons/radio-tower";
import ReceiptText from "@lucide/svelte/icons/receipt-text";
import Send from "@lucide/svelte/icons/send";
import Server from "@lucide/svelte/icons/server";
import ShieldCheck from "@lucide/svelte/icons/shield-check";
import Sparkles from "@lucide/svelte/icons/sparkles";
import SquareTerminal from "@lucide/svelte/icons/square-terminal";
import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
import UsersRound from "@lucide/svelte/icons/users-round";
/**
 * Lucide icon registry. Every icon the shell uses is imported explicitly (keeps tree-shaking
 * honest) and mapped by its Lucide id so string-keyed callers (nav, fix_ops, signage) resolve
 * without dynamic import. Lucide only — never emoji or inline SVG in the UI (eli bar). Janet is
 * `sparkles`, never `bot` (lore veto).
 */
import type { Component } from "svelte";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LucideIcon = Component<any>;

export const ICONS: Record<string, LucideIcon> = {
	"chart-line": ChartLine,
	"circle-check": CircleCheck,
	"circle-help": CircleHelp,
	"door-open": DoorOpen,
	kanban: Kanban,
	"layout-dashboard": LayoutDashboard,
	"library-big": LibraryBig,
	mail: Mail,
	mails: Mails,
	"mouse-pointer-2": MousePointer2,
	"radio-tower": RadioTower,
	"receipt-text": ReceiptText,
	send: Send,
	server: Server,
	"shield-check": ShieldCheck,
	sparkles: Sparkles,
	"square-terminal": SquareTerminal,
	"triangle-alert": TriangleAlert,
	"users-round": UsersRound,
};
