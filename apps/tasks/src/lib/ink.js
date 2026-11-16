// Pencil markup over gallery artifacts.
//
// inkLayer is serialized with Function.prototype.toString into interactive artifacts (the
// opaque-origin iframe can't load modules), so it must not reference anything outside its
// own body. The viewer calls it directly for html artifacts, and scripts/render-markup.mjs
// injects it to draw saved ink into a PNG, so all three surfaces share one renderer.
//
// Stroke: { tool: 'pen' | 'hl', color: '#rrggbb', width, vw, pts: [x, y, pressure, ...], anchor? }
// x/y are page coordinates (CSS px from the document's top-left) in the layout the stroke was
// drawn in; vw is that page width. Text reflows differently per browser and font, so absolute y
// lands on other content elsewhere. anchor = { p, dx, dy, up } pins the stroke to the element
// under it: p is a child-index path from the nearest id'd ancestor ('#id/2/0') or the root
// ('/1/3'). dy is the offset in CSS px from that element's top to the centre of the stroke's box,
// and dx the offset from the left of its ancestor `up` levels higher, the nearest one whose box
// spans the centre horizontally, so a note in the margin beside a word doesn't follow the word
// sideways when the line rewraps. Rendering translates the stroke by however far those boxes
// moved, falling back to pts when p no longer resolves to a visible element. A scrolling box is as deep as an anchor goes,
// since its scroll position is not saved.
//
// Messages in (handle): set {strokes} | arm {on} | tool {tool, color} | undo | clear.
// Messages out (emit): change {strokes, canUndo}.
export function inkLayer(win, { host = null, page = null, emit }) {
	const doc = win.document;
	// The document the strokes sit on: this one, or (html artifacts) the same-origin frame the
	// host overlay covers, whose page coordinates equal the overlay's.
	const pageDoc = () => (page ? page() : doc);
	const NS = "http://www.w3.org/2000/svg";
	const HL_COLOR = "#ffd400";
	const PEN_WIDTH = 4;
	const HL_WIDTH = 18;
	const ERASE_RADIUS = 12;
	// Strokes drawn one after another this close side by side are one mark, up to GROUP_HEIGHT
	// tall; see joins.
	const NEAR = 25;
	const GROUP_HEIGHT = 240;
	const docMode = !host;
	let strokes = [];
	let history = [];
	let armed = false;
	let tool = "pen";
	let color = "#e5484d";
	let svg = null;
	let active = null;
	let penDown = false;

	const shifts = new Map();

	const r1 = (n) => Math.round(n * 10) / 10;
	const viewWidth = () => Math.round(docMode ? doc.documentElement.clientWidth : host.clientWidth);

	function fit() {
		svg.style.height = "0px";
		const h = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0);

		svg.style.width = `${doc.documentElement.clientWidth}px`;
		svg.style.height = `${h}px`;
		render();
	}

	function ensureSvg() {
		if (svg) {
			return;
		}

		svg = doc.createElementNS(NS, "svg");
		svg.dataset.ink = "";
		svg.setAttribute("aria-hidden", "true");

		svg.style.cssText =
			`position:absolute;left:0;top:0;overflow:visible;z-index:2147483647;` +
			`pointer-events:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;${
				docMode ? "" : "width:100%;height:100%;"
			}`;

		(host || doc.documentElement).append(svg);

		if (docMode) {
			fit();

			if (win.ResizeObserver) {
				new win.ResizeObserver(fit).observe(doc.body || doc.documentElement);
			}

			win.addEventListener("resize", fit);
		} else if (win.ResizeObserver) {
			new win.ResizeObserver(render).observe(host);
		}

		svg.addEventListener("pointerdown", down);
		svg.addEventListener("pointermove", move);
		svg.addEventListener("pointerup", up);
		svg.addEventListener("pointercancel", up);

		// Finger touch must keep scrolling, so touch-action stays auto. A pen contact is kept
		// from panning by cancelling its touch events (Safari marks them touchType 'stylus').
		const blockPen = (e) => {
			if (!armed) {
				return;
			}

			const stylus = Array.prototype.some.call(e.touches || [], (t) => t.touchType === "stylus");

			if (penDown || stylus) {
				e.preventDefault();
			}
		};

		svg.addEventListener("touchstart", blockPen, { passive: false });
		svg.addEventListener("touchmove", blockPen, { passive: false });
	}

	// [left, top, right, bottom] of a stroke as drawn, moved by shift.
	function bounds(s, [sx, sy] = [0, 0]) {
		const p = s.pts;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;

		for (let i = 0; i < p.length; i += 3) {
			x0 = Math.min(x0, p[i]);
			x1 = Math.max(x1, p[i]);
			y0 = Math.min(y0, p[i + 1]);
			y1 = Math.max(y1, p[i + 1]);
		}

		return [x0 + sx, y0 + sy, x1 + sx, y1 + sy];
	}

	function center(pts) {
		const b = bounds({ pts });

		return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
	}

	const union = (a, b) => [
		Math.min(a[0], b[0]),
		Math.min(a[1], b[1]),
		Math.max(a[2], b[2]),
		Math.max(a[3], b[3]),
	];
	// Whether a stroke with bounds b continues the mark with bounds u: beside it on the same line
	// (letters of a word overlap vertically; highlights on successive rows don't), and the mark
	// stays short enough to follow one element.
	const joins = (u, b) =>
		b[0] - NEAR <= u[2] &&
		u[0] - NEAR <= b[2] &&
		b[1] < u[3] &&
		u[1] < b[3] &&
		Math.max(u[3], b[3]) - Math.min(u[1], b[1]) <= GROUP_HEIGHT;

	function box(el) {
		const r = el.getBoundingClientRect();
		const w = el.ownerDocument.defaultView;

		return r.width > 0 && r.height > 0
			? { x: r.left + w.scrollX, y: r.top + w.scrollY, w: r.width, h: r.height }
			: null;
	}

	// Fixed and sticky boxes move with the scroll position, so they can't hold a stroke.
	function pinned(el) {
		const pos = el.ownerDocument.defaultView.getComputedStyle(el).position;

		return pos === "fixed" || pos === "sticky";
	}

	function scrolls(el) {
		const o = el.ownerDocument.defaultView.getComputedStyle(el).overflowY;

		return (o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight;
	}

	// The deepest element whose box holds page point (x, y), searched by geometry rather than
	// hit-testing so it works off-screen. Children are tried topmost first.
	function deepest(pd, x, y) {
		let el = pd.body;

		if (!el || pinned(el)) {
			return null;
		}

		for (;;) {
			let next = null;

			for (let c = el.lastElementChild; c; c = c.previousElementSibling) {
				const b = box(c);

				if (
					b &&
					x >= b.x &&
					x <= b.x + b.w &&
					y >= b.y &&
					y <= b.y + b.h &&
					!c.matches("svg[data-ink]") &&
					!pinned(c)
				) {
					next = c;

					break;
				}
			}

			if (!next || scrolls(next)) {
				return next || el;
			}

			el = next;
		}
	}

	function pathOf(el) {
		const pd = el.ownerDocument;
		const steps = [];

		while (el !== pd.documentElement) {
			if (el.id && pd.getElementById(el.id) === el && /^[^\s/]{1,100}$/.test(el.id)) {
				return `#${el.id}${steps.join("")}`;
			}

			steps.unshift(`/${Array.prototype.indexOf.call(el.parentElement.children, el)}`);
			el = el.parentElement;
		}

		return steps.join("");
	}

	function resolve(pd, p) {
		const m = /^(?:#([^/]+))?((?:\/\d+)*)$/.exec(p);
		let el = m && (m[1] ? pd.getElementById(m[1]) : pd.documentElement);

		for (const i of m ? m[2].split("/").slice(1) : []) {
			el = el?.children[Number(i)];
		}

		return el || null;
	}

	// The element a mark centred at (cx, cy) belongs to. A mark written beside a paragraph hits a
	// tall container's margin there, so then the line through the centre is swept across the page
	// for the smallest element on it. Inline boxes move within their line as text rewraps, so the
	// anchor is their block. up counts the levels to the nearest ancestor spanning cx.
	function pick(cx, cy) {
		const pd = pageDoc();

		if (!pd?.body) {
			return null;
		}

		let best = null;
		const consider = (x) => {
			const el = deepest(pd, x, cy);
			const b = el && el !== pd.body && box(el);

			if (b && (!best || b.h < best.b.h)) {
				best = { el, b };
			}
		};

		consider(cx);

		if (!best || best.b.h > 160) {
			for (let x = 8; x < pd.documentElement.scrollWidth; x += 32) {
				consider(x);
			}
		}

		let el = best?.el;

		while (
			el &&
			el.parentElement !== pd.documentElement &&
			(el.ownerSVGElement || pd.defaultView.getComputedStyle(el).display.startsWith("inline"))
		) {
			el = el.parentElement;
		}

		const b = el && box(el);

		if (!b) {
			return null;
		}

		let xel = el;
		let xb = b;
		let up = 0;

		while ((cx < xb.x || cx > xb.x + xb.w) && xel.parentElement && xel !== pd.body) {
			xel = xel.parentElement;
			xb = box(xel) || xb;
			up += 1;
		}

		return { el, up };
	}

	// Pin strokes to one element, each with its own offset, so a word written in several strokes
	// moves as one.
	function anchorTo({ el, up }, list) {
		const b = box(el);
		let xel = el;

		for (let i = 0; i < up && xel.parentElement; i++) {
			xel = xel.parentElement;
		}

		const xb = box(xel) || b;
		const p = pathOf(el);

		return list.map((s) => {
			const [cx, cy] = center(s.pts);

			return { ...s, anchor: { p, dx: r1(cx - xb.x), dy: r1(cy - b.y), up } };
		});
	}

	function anchorGroup(list) {
		const u = list.map((s) => bounds(s)).reduce(union);
		const t = pick((u[0] + u[2]) / 2, (u[1] + u[3]) / 2);

		return t ? anchorTo(t, list) : list;
	}

	function shiftOf(s) {
		const pd = s.anchor && pageDoc();
		const el = pd && resolve(pd, s.anchor.p);
		const b = el && box(el);

		if (!b) {
			return [0, 0];
		}

		let xel = el;

		for (let i = 0; i < (s.anchor.up || 0) && xel.parentElement; i++) {
			xel = xel.parentElement;
		}

		const xb = box(xel) || b;
		const [cx, cy] = center(s.pts);

		return [xb.x + s.anchor.dx - cx, b.y + s.anchor.dy - cy];
	}

	function outline(s) {
		const p = s.pts;
		const n = p.length / 3;

		if (s.tool === "hl" || n < 2) {
			let d = `M${p[0]} ${p[1]}`;

			if (n < 2) {
				return `${d}l0.01 0`;
			}

			for (let i = 3; i < p.length; i += 3) {
				d += `L${p[i]} ${p[i + 1]}`;
			}

			return d;
		}

		const left = [];
		const right = [];

		for (let i = 0; i < n; i++) {
			const a = Math.max(0, i - 1) * 3;
			const b = Math.min(n - 1, i + 1) * 3;
			const dx = p[b] - p[a];
			const dy = p[b + 1] - p[a + 1];
			const len = Math.hypot(dx, dy) || 1;
			const rad = (s.width * (0.35 + 0.9 * p[i * 3 + 2])) / 2;
			const nx = (-dy / len) * rad;
			const ny = (dx / len) * rad;
			const x = p[i * 3];
			const y = p[i * 3 + 1];

			left.push(`${r1(x + nx)} ${r1(y + ny)}`);
			right.push(`${r1(x - nx)} ${r1(y - ny)}`);
		}

		const capEnd = (s.width * (0.35 + 0.9 * p[(n - 1) * 3 + 2])) / 2;
		const capStart = (s.width * (0.35 + 0.9 * p[2])) / 2;

		return `M${left.join("L")}A${r1(capEnd)} ${r1(capEnd)} 0 0 1 ${right[n - 1]}L${right.toReversed().join("L")}A${r1(capStart)} ${r1(capStart)} 0 0 1 ${left[0]}Z`;
	}

	function paint(s, el, shift = [0, 0]) {
		el ||= doc.createElementNS(NS, "path");
		el.setAttribute("d", outline(s));
		el.setAttribute("transform", `translate(${r1(shift[0])} ${r1(shift[1])})`);

		if (s.tool === "hl") {
			el.setAttribute("fill", "none");
			el.setAttribute("stroke", s.color);
			el.setAttribute("stroke-width", s.width);
			el.setAttribute("stroke-linecap", "round");
			el.setAttribute("stroke-linejoin", "round");
			el.setAttribute("opacity", "0.38");
		} else {
			el.setAttribute("fill", s.color);
		}

		return el;
	}

	function render() {
		if (!svg && strokes.length === 0) {
			return;
		}

		ensureSvg();
		shifts.clear();

		for (const s of strokes) {
			shifts.set(s, shiftOf(s));
		}

		svg.replaceChildren(...strokes.map((s) => paint(s, null, shifts.get(s))));

		if (active?.el) {
			svg.append(active.el);
		}
	}

	// Strokes saved before anchors existed are placed right only in the layout they were drawn
	// in. When the page is open at that width, pin them to what they cover, once.
	function anchorLegacy() {
		const w = viewWidth();
		const legacy = (s) => s && !s.anchor && s.vw === w;
		const next = [];
		let n = 0;

		for (let i = 0; i < strokes.length;) {
			if (!legacy(strokes[i])) {
				next.push(strokes[i++]);

				continue;
			}

			let j = i + 1;
			let u = bounds(strokes[i]);

			while (legacy(strokes[j]) && joins(u, bounds(strokes[j]))) {
				u = union(u, bounds(strokes[j]));
				j += 1;
			}

			const group = anchorGroup(strokes.slice(i, j));

			n += group.filter((s) => s.anchor).length;
			next.push(...group);
			i = j;
		}

		if (n > 0) {
			strokes = next;
			changed();
		}
	}

	function changed() {
		render();
		emit({ ink: "change", strokes, canUndo: history.length > 0 });
	}

	function commit(next) {
		history.push(strokes);
		strokes = next;
		changed();
	}

	function local(e) {
		const r = svg.getBoundingClientRect();

		return [r1(e.clientX - r.left), r1(e.clientY - r.top)];
	}

	function eraseAt(e) {
		const [x, y] = local(e);
		const keep = strokes.filter((s) => {
			const lim = (ERASE_RADIUS + s.width / 2) ** 2;
			const [sx, sy] = shifts.get(s) || [0, 0];

			for (let i = 0; i < s.pts.length; i += 3) {
				const dx = s.pts[i] + sx - x;
				const dy = s.pts[i + 1] + sy - y;

				if (dx * dx + dy * dy < lim) {
					return false;
				}
			}

			return true;
		});

		if (keep.length !== strokes.length) {
			strokes = keep;
			render();
		}
	}

	function down(e) {
		if (!armed || active || e.pointerType === "touch") {
			return;
		}

		if (e.pointerType === "mouse" && e.button !== 0) {
			return;
		}

		e.preventDefault();
		penDown = e.pointerType === "pen";

		try {
			svg.setPointerCapture(e.pointerId);
		} catch {
			/* capture is best-effort */
		}

		if (tool === "erase") {
			active = { id: e.pointerId, before: strokes };
			eraseAt(e);

			return;
		}

		const [x, y] = local(e);
		const pr = penDown && e.pressure > 0 ? Math.round(e.pressure * 100) / 100 : 0.5;
		const s = {
			tool,
			color: tool === "hl" ? HL_COLOR : color,
			width: tool === "hl" ? HL_WIDTH : PEN_WIDTH,
			vw: viewWidth(),
			pts: [x, y, pr],
		};

		active = { id: e.pointerId, s, el: paint(s) };
		svg.append(active.el);
	}

	function move(e) {
		if (!active || e.pointerId !== active.id) {
			return;
		}

		e.preventDefault();
		const evs = e.getCoalescedEvents?.() || [];

		for (const ev of evs.length > 0 ? evs : [e]) {
			if (!active.s) {
				eraseAt(ev);

				continue;
			}

			const p = active.s.pts;
			const [x, y] = local(ev);

			if (Math.hypot(x - p[p.length - 3], y - p[p.length - 2]) < 1.5) {
				continue;
			}

			p.push(x, y, penDown && ev.pressure > 0 ? Math.round(ev.pressure * 100) / 100 : 0.5);
		}

		if (active.s) {
			paint(active.s, active.el);
		}
	}

	function up(e) {
		if (!active || e.pointerId !== active.id) {
			return;
		}

		const a = active;

		active = null;
		penDown = false;

		if (a.s) {
			const prev = strokes.at(-1);
			let u = null;

			for (let i = strokes.length - 1; i >= 0 && strokes[i].anchor?.p === prev?.anchor?.p; i--) {
				const b = bounds(strokes[i], shifts.get(strokes[i]));

				u = u ? union(u, b) : b;
			}

			const pd = pageDoc();
			const el = prev?.anchor && pd && joins(u, bounds(a.s)) && resolve(pd, prev.anchor.p);

			commit(
				strokes.concat(
					el && box(el) ? anchorTo({ el, up: prev.anchor.up }, [a.s]) : anchorGroup([a.s]),
				),
			);
		} else if (strokes !== a.before) {
			history.push(a.before);
			changed();
		}
	}

	function handle(m) {
		if (m.ink === "set") {
			strokes = Array.isArray(m.strokes) ? m.strokes : [];
			history = [];
			render();
		} else if (m.ink === "arm") {
			armed = Boolean(m.on);

			if (armed) {
				ensureSvg();
				anchorLegacy();
			}

			if (svg) {
				svg.style.pointerEvents = armed ? "auto" : "none";
				svg.style.cursor = armed ? "crosshair" : "";
			}
		} else if (m.ink === "tool") {
			tool = m.tool === "hl" || m.tool === "erase" ? m.tool : "pen";

			if (typeof m.color === "string") {
				color = m.color;
			}
		} else if (m.ink === "undo") {
			if (history.length > 0) {
				strokes = history.pop();
				changed();
			}
		} else if (m.ink === "clear" && strokes.length > 0) {
			commit([]);
		}
	}

	return { handle };
}

// The bootstrap appended to an interactive artifact when the viewer asks for ?ink=1. Inert
// until the parent sends {ink:'init'}; it answers {ink:'ready'} to the origin that sent it
// and from then on relays messages between the parent and the layer.
const BOOT =
	`<script>(function(){var P=window.parent;if(P===window)return;var T=null;` +
	`var L=(${inkLayer.toString()})(window,{emit:function(m){if(T)P.postMessage(m,T)}});` +
	`window.addEventListener('message',function(e){var d=e.data;if(e.source!==P||!d||typeof d.ink!=='string')return;` +
	`if(d.ink==='init'){T=e.origin;P.postMessage({ink:'ready'},T);return}L.handle(d)})})();</script>`;

export function injectInk(html) {
	const at = html.toLowerCase().lastIndexOf("</body>");

	return at === -1 ? html + BOOT : html.slice(0, at) + BOOT + html.slice(at);
}
