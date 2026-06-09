<script lang="ts">
	import { onMount } from "svelte";

	import Card from "$lib/components/Card.svelte";
	import CompareCell from "$lib/components/CompareCell.svelte";
	import Dialog from "$lib/components/Dialog.svelte";
	import Eyebrow from "$lib/components/Eyebrow.svelte";
	import Icon from "$lib/components/Icon.svelte";
	import ProseMark from "$lib/components/ProseMark.svelte";
	import Sdot from "$lib/components/Sdot.svelte";
	import StatusPill from "$lib/components/StatusPill.svelte";
	import Swatch from "$lib/components/Swatch.svelte";
	import ThemeToggle from "$lib/components/ThemeToggle.svelte";
	import Tile from "$lib/components/Tile.svelte";
	import ToastHost from "$lib/components/ToastHost.svelte";
	import {
		A11Y,
		MOTION_TOKENS,
		SPACES,
		SWATCHES,
		TILES,
		TYPE_ROWS,
		type Swatch as SwatchData,
		type Tile as TileData,
	} from "$lib/data";
	import { attachRipple, replayCurves } from "$lib/enhance";
	import { ICON_STRIP } from "$lib/icons";
	import { liveSwatches, liveTiles } from "$lib/live.svelte";
	import { theme } from "$lib/theme.svelte";
	import { toasts } from "$lib/toasts.svelte";

	let dialog = $state<Dialog>();

	// Swatches + tiles: SSR renders the static LIGHT set (in markup at first
	// paint, zero CLS). After hydration we rebuild them from the live computed
	// theme ONLY on an actual theme change (the source's skipBuild logic): the
	// first light paint reuses the static DOM; dark — or any toggle — recolours
	// them. Count + geometry are identical across themes, so never a height shift.
	let swatchData = $state<SwatchData[]>(SWATCHES);
	let tileData = $state<TileData[]>(TILES);
	let firstSync = true;

	$effect(() => {
		const t = theme.current; // track theme changes
		if (firstSync) {
			firstSync = false;
			if (t === "light") return; // light first paint reuses the static markup
		}
		swatchData = liveSwatches();
		tileData = liveTiles();
	});

	onMount(() => {
		const detach = attachRipple();
		return detach;
	});

	// Role chips: a single-select group (enhancement; SSR shows Friend pressed).
	const ROLE_CHIPS = ["Friend", "Household", "Owner"];
	let activeRole = $state("Friend");
</script>

<header class="top">
	<div class="top-inner">
		<div class="brand">
			<span class="mark" aria-hidden="true"></span>
			<span>PetalNet design</span>
			<span class="sub">the system</span>
		</div>
		<div class="spacer"></div>
		<ThemeToggle />
	</div>
</header>

<main class="wrap">
	<section class="hero settle" id="top">
		<div class="eyebrow">
			<span class="ico"><Icon name="sparkles" /></span>
			The shared system
		</div>
		<h1>Paper and ink.<br />One accent.<br />Quiet by default.</h1>
		<p class="ethos">
			The system behind everything PetalCat ships: launchpad, status pages, trackers, and the apps
			to come.
			<b>Paper and ink, one accent, cards done quietly, Geist, plain language.</b>
			This page wears it. Flip Paper to Ink up top.
		</p>
		<div class="hero-line">
			<span class="pip" aria-hidden="true"></span> A healthy lab is undramatic
		</div>
	</section>

	<section id="color">
		<Eyebrow no="01" icon="palette" label="Color" />
		<h2>Two stories: paper and ink</h2>
		<p class="lede">
			Not one palette inverted. Ink runs warmer. One accent does the signaling; status colors are
			functional only. The accent is theme-aware: deeper on paper, brighter on ink. Swatches read
			live from the active theme.
		</p>
		<div class="swatch-grid" id="swatches">
			{#each swatchData as s (s.name)}
				<Swatch swatch={s} />
			{/each}
		</div>
	</section>

	<section id="type">
		<Eyebrow no="02" icon="type" label="Typography" />
		<h2>Geist, used well</h2>
		<p class="lede">
			One face for UI, one mono for codes and timestamps. No third font. Weight and tracking stay
			light; only the hero leans into negative tracking. Fonts are self-hosted at build by the
			<a href="https://npmx.dev/fontless" rel="noopener">fontless</a> Vite plugin, no CDN.
		</p>
		<div class="mt-s3">
			{#each TYPE_ROWS as row (row.sampleCls)}
				<div class="type-row">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="type-spec">{@html row.spec}</div>
					<div class="type-sample"><span class={row.sampleCls}>{row.sample}</span></div>
				</div>
			{/each}
		</div>
	</section>

	<section id="spacing">
		<Eyebrow no="03" icon="ruler" label="Spacing" />
		<h2>An 8-point rhythm</h2>
		<p class="lede">
			Spacing lands on multiples of 8, with a 4 for tight pairs. The container caps at 880, centered,
			single-column.
		</p>
		<div class="mt-14" id="spaces">
			{#each SPACES as sp (sp.lbl)}
				<div class="space-row">
					<span class="space-lbl">{sp.lbl}</span><span class="space-bar {sp.bar}"></span><span
						class="space-use">{sp.use}</span>
				</div>
			{/each}
		</div>
	</section>

	<section id="components">
		<Eyebrow no="04" icon="blocks" label="Components" />
		<h2>Few, on purpose</h2>
		<p class="lede">
			Filled cards for content, an outlined variant for tappable tiles. The accent shown in its real
			states.
		</p>

		<div class="sub-h">Cards</div>
		<div class="demo-grid">
			<Card
				variant="filled"
				variantLabel="Filled · content"
				title="Lab health"
				body="Tunnel connected, 14 days uninterrupted. Storage pool healthy. No alerts in 48 hours." />
			<Card
				variant="outlined"
				variantLabel="Outlined · tappable"
				title="Hover me"
				body="A 1px outline. On hover a faint accent state-layer appears; the outline holds. No lift." />
		</div>

		<div class="sub-h">Tiles</div>
		<div class="demo-grid mt-14" id="tiles">
			{#each tileData as t (t.name)}
				<Tile tile={t} />
			{/each}
		</div>

		<div class="sub-h">Buttons</div>
		<div class="btn-row mt-14">
			<button class="btn btn-primary">Open</button>
			<button class="btn btn-ghost">Cancel</button>
			<span class="state-note">Tab to see the focus ring</span>
		</div>

		<div class="sub-h">Input</div>
		<div class="field mt-14">
			<label for="demo-input">Search the lab</label>
			<input id="demo-input" type="text" placeholder="Type to filter" />
		</div>

		<div class="sub-h">Chips and status</div>
		<div class="chips-stack">
			<div class="role-chips" id="rolechips">
				{#each ROLE_CHIPS as role (role)}
					<button
						class="role-chip"
						aria-pressed={activeRole === role}
						onclick={() => (activeRole = role)}>{role}</button>
				{/each}
			</div>
			<div class="status-pills">
				<StatusPill state="ok" label="Healthy" />
				<StatusPill state="warn" pulse label="Checking" />
				<StatusPill state="down" label="Down" />
			</div>
		</div>

		<div class="sub-h">List</div>
		<div class="lab-list mt-14">
			<div class="lab-item">
				<Sdot state="ok" /> Photos <span class="ago mono">2m</span>
			</div>
			<div class="lab-item">
				<Sdot state="ok" /> Passwords <span class="ago mono">11m</span>
			</div>
			<div class="lab-item">
				<Sdot state="warn" /> Backups, checking <span class="ago mono">now</span>
			</div>
		</div>

		<div class="sub-h">Skeleton loading</div>
		<p class="lede mt-6">
			Placeholders for content that hasn't landed yet. A calm tinted block with one slow shimmer,
			never a flash. Reserve the real layout so nothing shifts when content arrives. The shimmer
			holds still under reduced motion.
		</p>
		<div class="demo-grid mt-14">
			<div class="skeleton-card" role="status" aria-busy="true" aria-label="Loading lab health">
				<div class="skeleton-head">
					<div class="skeleton skeleton-avatar" aria-hidden="true"></div>
					<div class="lines">
						<div class="skeleton skeleton-title" aria-hidden="true"></div>
						<div class="skeleton skeleton-line short mt-half" aria-hidden="true"></div>
					</div>
				</div>
				<div class="skeleton skeleton-line long" aria-hidden="true"></div>
				<div class="skeleton skeleton-line" aria-hidden="true"></div>
				<div class="skeleton skeleton-line short" aria-hidden="true"></div>
			</div>
			<div class="skeleton-card" role="status" aria-busy="true" aria-label="Loading preview">
				<div class="skeleton skeleton-box" aria-hidden="true"></div>
				<div class="skeleton skeleton-title mt-s3" aria-hidden="true"></div>
				<div class="skeleton skeleton-line long mt-5eq" aria-hidden="true"></div>
				<div class="skeleton skeleton-line short" aria-hidden="true"></div>
			</div>
		</div>

		<div class="sub-h">Dialog and notice</div>
		<div class="btn-row mt-14">
			<button class="btn btn-ghost" id="open-dialog" onclick={() => dialog?.open()}>
				Open a dialog
			</button>
			<button class="btn btn-ghost" id="fire-toast" onclick={() => toasts.fire("A new question arrived.")}>
				Show a notice
			</button>
			<span class="state-note">Real modal + toast components</span>
		</div>

		<div class="sub-h">Markdown editing, ProseMark</div>
		<p class="lede mt-6">
			A live <a href="https://prosemark.com/">ProseMark</a> editor, themed to this spec. Opens
			rendered; flip Read and Edit. Read and edit share identical metrics, so the swap doesn't shift
			a pixel.
		</p>
		<ProseMark />
	</section>

	<section id="motion">
		<Eyebrow no="05" icon="activity" label="Motion" />
		<h2>Every change, quietly</h2>
		<p class="lede">
			Every state change animates, fast and subtle enough to read as "nice," not noticeable. Idle
			stays silent; nothing reveals on scroll. <code>prefers-reduced-motion</code> is a real branch
			in the code.
		</p>

		<div class="motion-block">
			<h3>Light and dark, an instant cut</h3>
			<div class="hint">
				The theme swaps instantly, with no cross-fade and no flash. Paint props are suspended for
				one frame so the tokens flip hard; the reserved scrollbar gutter keeps it jump-free.
			</div>
			<button class="btn btn-ghost" id="motion-toggle" onclick={() => theme.toggle()}>
				Flip the theme
			</button>
		</div>

		<div class="motion-block">
			<h3>Button presses, tactile</h3>
			<div class="hint">A press-scale and a quick accent ink-in from the point you pressed.</div>
			<div class="btn-row">
				<button class="btn btn-primary">Open</button>
				<button class="btn btn-ghost">Cancel</button>
				<button class="btn btn-ghost">Try me</button>
			</div>
		</div>

		<div class="motion-block">
			<h3>Motion tokens</h3>
			<div class="hint">The canonical values. Replay to watch each curve.</div>
			<div class="token-table" id="token-table">
				{#each MOTION_TOKENS as tok (tok.name)}
					<div class="token-row">
						<span class="token-name">{tok.name}</span><span class="token-val">{tok.val}</span><span
							class="token-use">{tok.use}</span><span class="curve {tok.curve}"
							><span class="dot"></span></span>
					</div>
				{/each}
			</div>
			<div class="mt-14">
				<button class="replay-all" id="replay-curves" onclick={replayCurves}>Replay curves</button>
			</div>
		</div>

		<div class="rm-note">
			<span class="ico" aria-hidden="true"><Icon name="circle-check" /></span>
			<span><b>Reduced motion.</b>
				<span class="d"
					>Theme swaps instantly, presses change color only, pulses stop. Honors the live OS
					setting.</span></span>
		</div>
	</section>

	<section id="voice">
		<Eyebrow no="06" icon="message-square" label="Voice" />
		<h2>Plain language, less of it</h2>
		<p class="lede">
			Human descriptions over jargon. Minimum viable text. Empty states say something, briefly. Never
			an em dash in a UI string.
		</p>
		<div class="compare">
			<CompareCell kind="bad">
				<div class="card-body body-ink">"Media stack. OIDC outpost. Secrets store, reverse-proxied."</div>
				<div class="what">Correct words, wrong audience.</div>
			</CompareCell>
			<CompareCell kind="good">
				<div class="card-body body-ink">"Movies and music. Your passwords. VPN access."</div>
				<div class="what">Human descriptions for humans.</div>
			</CompareCell>
			<CompareCell kind="bad">
				<div class="card-body body-ink">"All caught up, no open questions right now."</div>
				<div class="what">Says it twice.</div>
			</CompareCell>
			<CompareCell kind="good">
				<div class="card-body body-ink">"All caught up."</div>
				<div class="what">Minimum viable.</div>
			</CompareCell>
			<CompareCell kind="bad">
				<div class="card-body mono body-ink-mono12">87 services · containers on host</div>
				<div class="what">Static info posing as health.</div>
			</CompareCell>
			<CompareCell kind="good">
				<div class="card-body body-ink">"Tunnel connected, 14 days steady. No alerts in 48 hours."</div>
				<div class="what">Health in sentences.</div>
			</CompareCell>
		</div>
	</section>

	<section id="icons">
		<Eyebrow no="07" icon="shapes" label="Iconography" />
		<h2>Lucide, only</h2>
		<p class="lede">
			One icon library: lucide. No inline SVG by hand, no emoji. A glyph that lucide lacks is added to
			one external file and used from there. Off-the-shelf brand marks come from the dashboard-icons
			set for tiles.
		</p>
		<div class="icon-row">
			<div class="icon-card">
				<div class="ibox">
					<span aria-hidden="true"><Icon name="blocks" /></span>
				</div>
				<h4>Lucide set</h4>
				<p>The single source. Stroked in the accent, 24-grid, 2px round.</p>
				<div class="icon-strip" id="icon-strip" aria-hidden="true">
					{#each ICON_STRIP as glyph (glyph)}
						<span
							><svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
								><!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html glyph}</svg></span>
					{/each}
				</div>
			</div>
			<div class="icon-card">
				<div class="ibox">
					<span aria-hidden="true"><Icon name="layout" /></span>
				</div>
				<h4>Brand marks</h4>
				<p>Real service logos from dashboard-icons, used on launcher tiles.</p>
			</div>
			<div class="icon-card">
				<div class="ibox">
					<span aria-hidden="true"><Icon name="map-pin" /></span>
				</div>
				<h4>Native, external</h4>
				<p>Something lucide lacks gets drawn once into the icon file. Never inlined ad hoc.</p>
			</div>
		</div>
	</section>

	<section id="anti">
		<Eyebrow no="08" icon="triangle" label="Anti-patterns" />
		<h2>Shipped, regretted, reverted</h2>
		<p class="lede">Learned the hard way. Don't rediscover them.</p>
		<div class="compare">
			<CompareCell kind="bad">
				<div class="pal timid">
					<span></span><span></span><span></span><span></span><span></span>
				</div>
				<div class="what">An even palette. Nothing signals.</div>
			</CompareCell>
			<CompareCell kind="good">
				<div class="pal one">
					<span></span><span></span><span></span><span></span><span></span>
				</div>
				<div class="what">One accent. A signal, not a wash.</div>
			</CompareCell>
			<CompareCell kind="bad">
				<div class="alive-row">
					<span class="fake-alive"></span><span class="card-body body-flush"
						>A breathing dot on idle</span>
				</div>
				<div class="what">Fake aliveness on healthy things.</div>
			</CompareCell>
			<CompareCell kind="good">
				<div class="alive-row">
					<span class="calm-alive"></span><span class="card-body body-flush">Healthy, still</span>
				</div>
				<div class="what">Pulse only what's being polled.</div>
			</CompareCell>
			<CompareCell kind="bad">
				<div class="aurora" aria-hidden="true"></div>
				<div class="what">An aurora gradient. AI-slop forever after.</div>
			</CompareCell>
			<CompareCell kind="good">
				<div class="solid-mark"><span class="m" aria-hidden="true"></span></div>
				<div class="what">Solid color. No gradients on surfaces.</div>
			</CompareCell>
		</div>
	</section>

	<section id="a11y">
		<Eyebrow no="09" icon="accessibility" label="Accessibility" />
		<h2>Built in, not bolted on</h2>
		<ul class="a11y-list">
			{#each A11Y as item (item.title)}
				<li>
					<span class="tick"><Icon name="circle-check" /></span><span
						><b>{item.title}</b>
						<span class="d">{item.desc}</span></span>
				</li>
			{/each}
		</ul>
	</section>

	<footer>
		<div>
			PetalNet design system. Paper and ink, one accent, cards done quietly, Geist, plain language.
		</div>
		<div class="mono mt-6">A living guide that wears the system it describes.</div>
	</footer>
</main>

<Dialog bind:this={dialog} />
<ToastHost />
