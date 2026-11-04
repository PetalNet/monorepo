<script>
	// Single icon surface for the app — maps our internal names to lucide-svelte
	// (the lab DS icon set, matching Nexus). Replaces the hand-rolled #i-* SVG symbols.
	// Usage: <Icon name="board" size={20} />
	import {
		House,
		LayoutDashboard,
		FolderKanban,
		Inbox,
		SquareCheckBig,
		CircleQuestionMark,
		FileText,
		Lightbulb,
		Zap,
		Check,
		Ban,
		ArrowRight,
		Plus,
		Lock,
		StickyNote,
		Moon,
		Sun,
		CircleDot,
		CircleCheck,
		MessageSquare,
		Images,
		Ellipsis,
		ChevronDown,
		ChevronLeft,
		ChevronRight,
		Flame,
		Activity,
		Clock,
		ShieldCheck,
		ListChecks,
		PanelLeftClose,
		PanelLeft,
		Pencil,
		X,
		Search,
		LogOut,
	} from "@lucide/svelte";

	const MAP = {
		// primary nav / domain
		cockpit: House,
		desk: House,
		board: LayoutDashboard,
		browse: LayoutDashboard,
		projects: FolderKanban,
		inbox: Inbox,
		task: SquareCheckBig,
		question: CircleQuestionMark,
		doc: FileText,
		idea: Lightbulb,
		bolt: Zap,
		fleet: Zap,
		gallery: Images,
		// status / action
		check: Check,
		block: Ban,
		arrow: ArrowRight,
		plus: Plus,
		lock: Lock,
		sticky: StickyNote,
		moon: Moon,
		sun: Sun,
		comment: MessageSquare,
		iopen: CircleDot,
		iclosed: CircleCheck,
		fire: Flame,
		pulse: Activity,
		clock: Clock,
		shield: ShieldCheck,
		edit: Pencil,
		close: X,
		// chrome
		more: Ellipsis,
		chevdown: ChevronDown,
		car: ChevronDown,
		chevleft: ChevronLeft,
		chevright: ChevronRight,
		search: Search,
		signout: LogOut,
		collapse: PanelLeftClose,
		expand: PanelLeft,
		brand: ListChecks,
	};

	let { name, size = 20, strokeWidth = 1.9, class: klass = "" } = $props();
	const Cmp = $derived(MAP[name] ?? CircleQuestionMark);
</script>

<Cmp {size} {strokeWidth} class={klass} absoluteStrokeWidth />
