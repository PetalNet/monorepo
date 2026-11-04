<script>
  // Single icon surface for the app — maps our internal names to lucide-svelte
  // (the lab DS icon set, matching Nexus). Replaces the hand-rolled #i-* SVG symbols.
  // Usage: <Icon name="board" size={20} />
  import {
    Home, LayoutDashboard, FolderKanban, Inbox, SquareCheckBig, CircleHelp,
    FileText, Lightbulb, Zap, Check, Ban, ArrowRight, Plus, Lock, StickyNote,
    Moon, Sun, CircleDot, CircleCheck, MessageSquare, Images, MoreHorizontal,
    ChevronDown, ChevronLeft, ChevronRight, Flame, Activity, Clock, ShieldCheck,
    ListChecks, PanelLeftClose, PanelLeft, Pencil, X, Search, LogOut
  } from '@lucide/svelte';

  const MAP = {
    // primary nav / domain
    cockpit: Home, desk: Home, board: LayoutDashboard, browse: LayoutDashboard,
    projects: FolderKanban, inbox: Inbox, task: SquareCheckBig, question: CircleHelp,
    doc: FileText, idea: Lightbulb, bolt: Zap, fleet: Zap, gallery: Images,
    // status / action
    check: Check, block: Ban, arrow: ArrowRight, plus: Plus, lock: Lock,
    sticky: StickyNote, moon: Moon, sun: Sun, comment: MessageSquare,
    iopen: CircleDot, iclosed: CircleCheck, fire: Flame, pulse: Activity,
    clock: Clock, shield: ShieldCheck, edit: Pencil, close: X,
    // chrome
    more: MoreHorizontal, chevdown: ChevronDown, car: ChevronDown,
    chevleft: ChevronLeft, chevright: ChevronRight, search: Search, signout: LogOut,
    collapse: PanelLeftClose, expand: PanelLeft, brand: ListChecks
  };

  let { name, size = 20, strokeWidth = 1.9, class: klass = '' } = $props();
  const Cmp = $derived(MAP[name] ?? CircleHelp);
</script>

<Cmp {size} {strokeWidth} class={klass} absoluteStrokeWidth />
