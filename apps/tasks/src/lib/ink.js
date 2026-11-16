// Pencil markup over gallery artifacts.
//
// inkLayer is serialized with Function.prototype.toString into interactive artifacts (the
// opaque-origin iframe can't load modules), so it must not reference anything outside its
// own body. The viewer calls it directly for html artifacts, and scripts/render-markup.mjs
// injects it to draw saved ink into a PNG, so all three surfaces share one renderer.
//
// Stroke: { tool: 'pen' | 'hl', color: '#rrggbb', width, vw, pts: [x, y, pressure, ...] }
// x/y are page coordinates (CSS px from the document's top-left); vw is the page width the
// stroke was drawn at, so a different viewport width is detectable.
//
// Messages in (handle): set {strokes} | arm {on} | tool {tool, color} | undo | clear.
// Messages out (emit): change {strokes, canUndo}.
export function inkLayer(win, { host = null, emit }) {
	const doc = win.document;
	const NS = "http://www.w3.org/2000/svg";
	const HL_COLOR = "#ffd400";
	const PEN_WIDTH = 4;
	const HL_WIDTH = 18;
	const ERASE_RADIUS = 12;
	const docMode = !host;
	let strokes = [];
	let history = [];
	let armed = false;
	let tool = "pen";
	let color = "#e5484d";
	let svg = null;
	let active = null;
	let penDown = false;

	const r1 = (n) => Math.round(n * 10) / 10;
	const viewWidth = () => Math.round(docMode ? doc.documentElement.clientWidth : host.clientWidth);

	function fit() {
		svg.style.height = "0px";
		const h = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0);

		svg.style.width = `${doc.documentElement.clientWidth}px`;
		svg.style.height = `${h}px`;
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

	function paint(s, el) {
		el ||= doc.createElementNS(NS, "path");
		el.setAttribute("d", outline(s));

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
		svg.replaceChildren(...strokes.map((s) => paint(s)));
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

			for (let i = 0; i < s.pts.length; i += 3) {
				const dx = s.pts[i] - x;
				const dy = s.pts[i + 1] - y;

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
			commit(strokes.concat([a.s]));
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
