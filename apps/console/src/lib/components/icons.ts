import ArrowLeft from "@lucide/svelte/icons/arrow-left";
import ArrowRight from "@lucide/svelte/icons/arrow-right";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import Bell from "@lucide/svelte/icons/bell";
import BellOff from "@lucide/svelte/icons/bell-off";
import BookOpen from "@lucide/svelte/icons/book-open";
import ChartLine from "@lucide/svelte/icons/chart-line";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import CircleAlert from "@lucide/svelte/icons/circle-alert";
import CircleCheck from "@lucide/svelte/icons/circle-check";
import CircleDashed from "@lucide/svelte/icons/circle-dashed";
import CircleHelp from "@lucide/svelte/icons/circle-help";
import CircleX from "@lucide/svelte/icons/circle-x";
import Clock from "@lucide/svelte/icons/clock";
import Coins from "@lucide/svelte/icons/coins";
import Columns2 from "@lucide/svelte/icons/columns-2";
import Copy from "@lucide/svelte/icons/copy";
import DoorClosed from "@lucide/svelte/icons/door-closed";
import DoorOpen from "@lucide/svelte/icons/door-open";
import Ellipsis from "@lucide/svelte/icons/ellipsis";
import Eye from "@lucide/svelte/icons/eye";
import FileText from "@lucide/svelte/icons/file-text";
import FlaskConical from "@lucide/svelte/icons/flask-conical";
import Folder from "@lucide/svelte/icons/folder";
import GitBranch from "@lucide/svelte/icons/git-branch";
import Hammer from "@lucide/svelte/icons/hammer";
import Image from "@lucide/svelte/icons/image";
import Inbox from "@lucide/svelte/icons/inbox";
import Kanban from "@lucide/svelte/icons/kanban";
import KeyRound from "@lucide/svelte/icons/key-round";
import Keyboard from "@lucide/svelte/icons/keyboard";
import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
import Library from "@lucide/svelte/icons/library";
import LibraryBig from "@lucide/svelte/icons/library-big";
import ListOrdered from "@lucide/svelte/icons/list-ordered";
import LockKeyhole from "@lucide/svelte/icons/lock-keyhole";
import Mail from "@lucide/svelte/icons/mail";
import MailX from "@lucide/svelte/icons/mail-x";
import Mailbox from "@lucide/svelte/icons/mailbox";
import Mails from "@lucide/svelte/icons/mails";
import MessageSquare from "@lucide/svelte/icons/message-square";
import Microscope from "@lucide/svelte/icons/microscope";
import Milestone from "@lucide/svelte/icons/milestone";
import MousePointer2 from "@lucide/svelte/icons/mouse-pointer-2";
import Package from "@lucide/svelte/icons/package";
import PhoneForwarded from "@lucide/svelte/icons/phone-forwarded";
import Pin from "@lucide/svelte/icons/pin";
import Quote from "@lucide/svelte/icons/quote";
import Radio from "@lucide/svelte/icons/radio";
import RadioTower from "@lucide/svelte/icons/radio-tower";
import ReceiptText from "@lucide/svelte/icons/receipt-text";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import Reply from "@lucide/svelte/icons/reply";
import ScrollText from "@lucide/svelte/icons/scroll-text";
import Search from "@lucide/svelte/icons/search";
import Send from "@lucide/svelte/icons/send";
import Server from "@lucide/svelte/icons/server";
import Shield from "@lucide/svelte/icons/shield";
import ShieldCheck from "@lucide/svelte/icons/shield-check";
import Signpost from "@lucide/svelte/icons/signpost";
import Siren from "@lucide/svelte/icons/siren";
import Smartphone from "@lucide/svelte/icons/smartphone";
import Sparkles from "@lucide/svelte/icons/sparkles";
import SquareTerminal from "@lucide/svelte/icons/square-terminal";
import Stamp from "@lucide/svelte/icons/stamp";
import Timer from "@lucide/svelte/icons/timer";
import TrainFront from "@lucide/svelte/icons/train-front";
import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
import UsersRound from "@lucide/svelte/icons/users-round";
import X from "@lucide/svelte/icons/x";
/**
 * Lucide icon registry. Every icon the shell uses is imported explicitly (keeps tree-shaking
 * honest) and mapped by its Lucide id so string-keyed callers (nav, fix_ops, signage) resolve
 * without dynamic import. Lucide only — never emoji or inline SVG in the UI (eli bar). Janet is
 * `sparkles`, never `bot` (lore veto).
 */
import type { Component } from "svelte";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LucideIcon = Component<any>;

export const ICONS = {
	"arrow-left": ArrowLeft,
	"arrow-right": ArrowRight,
	"arrow-up": ArrowUp,
	bell: Bell,
	"bell-off": BellOff,
	"book-open": BookOpen,
	"chart-line": ChartLine,
	"chevron-right": ChevronRight,
	"chevron-down": ChevronDown,
	"circle-alert": CircleAlert,
	"circle-check": CircleCheck,
	"circle-dashed": CircleDashed,
	"circle-help": CircleHelp,
	"circle-x": CircleX,
	clock: Clock,
	coins: Coins,
	"columns-2": Columns2,
	copy: Copy,
	"door-closed": DoorClosed,
	"door-open": DoorOpen,
	ellipsis: Ellipsis,
	eye: Eye,
	"file-text": FileText,
	"flask-conical": FlaskConical,
	folder: Folder,
	"git-branch": GitBranch,
	hammer: Hammer,
	image: Image,
	inbox: Inbox,
	kanban: Kanban,
	"key-round": KeyRound,
	keyboard: Keyboard,
	"layout-dashboard": LayoutDashboard,
	library: Library,
	"library-big": LibraryBig,
	"list-ordered": ListOrdered,
	"lock-keyhole": LockKeyhole,
	mail: Mail,
	"mail-x": MailX,
	mailbox: Mailbox,
	mails: Mails,
	"message-square": MessageSquare,
	microscope: Microscope,
	milestone: Milestone,
	"mouse-pointer-2": MousePointer2,
	package: Package,
	pin: Pin,
	"phone-forwarded": PhoneForwarded,
	quote: Quote,
	radio: Radio,
	"radio-tower": RadioTower,
	"receipt-text": ReceiptText,
	"refresh-cw": RefreshCw,
	reply: Reply,
	"scroll-text": ScrollText,
	search: Search,
	send: Send,
	server: Server,
	shield: Shield,
	"shield-check": ShieldCheck,
	signpost: Signpost,
	siren: Siren,
	smartphone: Smartphone,
	sparkles: Sparkles,
	"square-terminal": SquareTerminal,
	stamp: Stamp,
	timer: Timer,
	"train-front": TrainFront,
	"triangle-alert": TriangleAlert,
	"users-round": UsersRound,
	x: X,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/**
 * Broad-string callers (navigation and Library kind maps) cannot be checked at their call sites.
 * Keep their possible values here so `svelte-check` fails if the registry drops one.
 */
type RuntimeIconName =
	| "chart-line"
	| "circle-check"
	| "file-text"
	| "folder"
	| "kanban"
	| "layout-dashboard"
	| "library-big"
	| "list-ordered"
	| "microscope"
	| "milestone"
	| "package"
	| "quote"
	| "radio-tower"
	| "server"
	| "shield-check"
	| "square-terminal"
	| "users-round";

type RegistryCoverage = Exclude<RuntimeIconName, IconName> extends never ? string : never;

export function hasIcon(name: RegistryCoverage): name is IconName {
	return Object.hasOwn(ICONS, name);
}
