// CRT phosphor field — a WebGL fragment shader adapted from the ghostty crt.glsl
// look (barrel curvature, scanlines, a slow refresh scan, grain, phosphor bloom).
//
// It renders an AMBIENT tube behind the page rather than post-processing the DOM
// (that would need rendering the live document to a texture). The content layer
// sits on top with its own scanline overlay tuned to match, so the whole thing
// reads as one glass tube. Kept deliberately low-contrast so the readout stays
// legible. Honors prefers-reduced-motion by freezing the animation.

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_phosphor;

// cheap hash noise
float hash(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res.xy;

  // barrel distortion of the coordinate space -> tube curvature
  vec2 cc = uv - 0.5;
  float dist = dot(cc, cc);
  vec2 buv = uv + cc * dist * 0.28;

  // off-tube pixels are the black bezel
  if (buv.x < 0.0 || buv.x > 1.0 || buv.y < 0.0 || buv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // ambient phosphor glow: low-frequency animated field, brightest low-center
  float glow = 0.0;
  glow += smoothstep(1.0, 0.0, length((buv - vec2(0.5, 0.36)) * vec2(1.0, 1.35))) * 0.5;
  float drift = hash(floor(buv * 90.0) + floor(u_time * 1.5)) * 0.06;

  // scanlines
  float scan = 0.5 + 0.5 * sin(buv.y * u_res.y * 1.5);
  scan = mix(1.0, scan, 0.10);

  // slow vertical refresh band
  float band = smoothstep(0.06, 0.0, abs(fract(buv.y - u_time * 0.06) - 0.5)) * 0.05;

  // vignette
  float vig = smoothstep(0.85, 0.15, dist);

  // grain flicker
  float grain = (hash(buv * u_res.xy + u_time * 60.0) - 0.5) * 0.04;

  float intensity = (glow + drift + band) * scan * vig + grain;
  intensity = max(intensity, 0.0);

  vec3 col = u_phosphor * intensity;
  // faint per-channel offset at the edges = chromatic aberration
  col.r *= 1.0 + dist * 0.35;
  col.b *= 1.0 - dist * 0.15;

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
	const sh = gl.createShader(type);
	if (!sh) return null;
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		gl.deleteShader(sh);
		return null;
	}
	return sh;
}

export interface CrtHandle {
	destroy: () => void;
}

/** Attach the CRT field to a canvas. Returns a handle whose destroy() tears it fully down. */
export function mountCrt(canvas: HTMLCanvasElement, phosphor: [number, number, number]): CrtHandle {
	const gl = (canvas.getContext("webgl", { antialias: false, alpha: false }) ||
		canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;

	// Graceful fallback: no WebGL -> leave the canvas transparent, CSS handles the rest.
	if (!gl) return { destroy: () => {} };
	// Narrowed alias: TS re-widens `gl` to `| null` inside the deferred closures below.
	const g: WebGLRenderingContext = gl;

	const vs = compile(gl, gl.VERTEX_SHADER, VERT);
	const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
	const prog = gl.createProgram();
	if (!vs || !fs || !prog) return { destroy: () => {} };
	gl.attachShader(prog, vs);
	gl.attachShader(prog, fs);
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { destroy: () => {} };
	gl.useProgram(prog);

	const buf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	const aPos = gl.getAttribLocation(prog, "a_pos");
	gl.enableVertexAttribArray(aPos);
	gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

	const uRes = gl.getUniformLocation(prog, "u_res");
	const uTime = gl.getUniformLocation(prog, "u_time");
	const uPhos = gl.getUniformLocation(prog, "u_phosphor");
	gl.uniform3f(uPhos, phosphor[0], phosphor[1], phosphor[2]);

	const reduce =
		typeof window !== "undefined" &&
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

	let raf = 0;
	let disposed = false;
	const start = typeof performance !== "undefined" ? performance.now() : 0;

	function resize() {
		const dpr = Math.min(window.devicePixelRatio || 1, 1.5); // cap for fill-rate
		const w = Math.floor(canvas.clientWidth * dpr);
		const h = Math.floor(canvas.clientHeight * dpr);
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		g.viewport(0, 0, canvas.width, canvas.height);
		g.uniform2f(uRes, canvas.width, canvas.height);
	}

	function frame(now: number) {
		if (disposed) return;
		resize();
		g.uniform1f(uTime, reduce ? 0 : (now - start) / 1000);
		g.drawArrays(g.TRIANGLES, 0, 3);
		if (!reduce) raf = requestAnimationFrame(frame);
	}

	resize();
	if (reduce) {
		frame(start); // one static paint
	} else {
		raf = requestAnimationFrame(frame);
	}
	window.addEventListener("resize", resize);

	return {
		destroy() {
			disposed = true;
			cancelAnimationFrame(raf);
			window.removeEventListener("resize", resize);
			g.deleteProgram(prog);
			g.deleteShader(vs);
			g.deleteShader(fs);
			g.deleteBuffer(buf);
		},
	};
}
