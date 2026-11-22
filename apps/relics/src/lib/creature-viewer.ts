import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { creatureModels } from "./creatures.ts";

type Model = (typeof creatureModels)[keyof typeof creatureModels];

function isMesh(object: THREE.Object3D): object is THREE.Mesh {
	return object instanceof THREE.Mesh;
}

export interface CreatureViewer {
	setActive: (active: boolean) => void;
	setPaused: (paused: boolean) => void;
	setColor: (color: string | null) => void;
	dispose: () => void;
}

function disposeObject(root: THREE.Object3D) {
	const geometries = new Set<THREE.BufferGeometry>();
	const materials = new Set<THREE.Material>();
	const textures = new Set<THREE.Texture>();

	root.traverse((object) => {
		if (!isMesh(object)) {
			return;
		}

		geometries.add(object.geometry);

		for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
			materials.add(material);

			for (const value of Object.values(material)) {
				if (value instanceof THREE.Texture) {
					textures.add(value);
				}
			}
		}
	});

	for (const texture of textures) {
		texture.dispose();
	}

	for (const material of materials) {
		material.dispose();
	}

	for (const geometry of geometries) {
		geometry.dispose();
	}
}

function contactShadow() {
	const canvas = document.createElement("canvas");

	canvas.width = 128;
	canvas.height = 128;
	const context = canvas.getContext("2d");

	if (!context) {
		throw new Error("Canvas unavailable");
	}

	const gradient = context.createRadialGradient(64, 64, 5, 64, 64, 64);

	gradient.addColorStop(0, "rgba(62,62,35,.29)");
	gradient.addColorStop(0.5, "rgba(62,62,35,.15)");
	gradient.addColorStop(1, "rgba(62,62,35,0)");
	context.fillStyle = gradient;
	context.fillRect(0, 0, 128, 128);

	return new THREE.CanvasTexture(canvas);
}

function clearing(world: THREE.Group) {
	const island = new THREE.Mesh(
		new THREE.SphereGeometry(1, 48, 20),
		new THREE.MeshStandardMaterial({ color: "#dce0c1", roughness: 1 }),
	);

	island.scale.set(2.12, 0.13, 1.47);
	island.position.y = -0.13;
	island.receiveShadow = true;
	world.add(island);

	const shadow = new THREE.Mesh(
		new THREE.PlaneGeometry(2.9, 2.15),
		new THREE.MeshBasicMaterial({ map: contactShadow(), transparent: true, depthWrite: false }),
	);

	shadow.rotation.x = -Math.PI / 2;
	shadow.position.set(0, 0.008, 0);
	world.add(shadow);
	const batches = new Map<string, THREE.BufferGeometry[]>();

	function prop(
		geometry: THREE.BufferGeometry,
		color: string,
		x: number,
		y: number,
		z: number,
		sx: number,
		sy: number,
		sz: number,
		rz = 0,
	) {
		geometry.applyMatrix4(
			new THREE.Matrix4().compose(
				new THREE.Vector3(x, y, z),
				new THREE.Quaternion().setFromEuler(new THREE.Euler(0, x * 2, rz)),
				new THREE.Vector3(sx, sy, sz),
			),
		);

		const batch = batches.get(color) ?? [];

		batch.push(geometry);
		batches.set(color, batch);
	}

	for (const [x, z, h] of [
		[-1.45, 0.25, 0.31],
		[-1.2, 0.85, 0.21],
		[1.48, -0.08, 0.3],
		[0.92, -0.87, 0.2],
		[-0.5, -1.02, 0.2],
	] satisfies [number, number, number][]) {
		for (let i = 0; i < 3; i++) {
			prop(
				new THREE.ConeGeometry(0.045, 1, 3),
				"#7f965d",
				x + (i - 1) * 0.07,
				h / 2,
				z + (i % 2) * 0.04,
				1,
				h,
				1,
				(i - 1) * 0.23,
			);
		}
	}

	for (const [x, z, r] of [
		[1.3, 0.75, 0.16],
		[-1.51, -0.5, 0.18],
		[1.52, 0.47, 0.09],
		[-1.25, -0.65, 0.1],
	] satisfies [number, number, number][]) {
		prop(new THREE.IcosahedronGeometry(1, 1), "#b8b29a", x, 0.05, z, r, r * 0.55, r * 0.8);
	}

	const fx = -1.08,
		fz = -0.28;

	prop(new THREE.CylinderGeometry(0.018, 0.024, 0.57, 6), "#738856", fx, 0.25, fz, 1, 1, 1, -0.15);

	for (let i = 0; i < 5; i++) {
		const angle = (i * Math.PI * 2) / 5;

		prop(
			new THREE.SphereGeometry(1, 10, 6),
			"#fff3d6",
			fx + Math.cos(angle) * 0.105,
			0.54 + Math.sin(angle) * 0.105,
			fz,
			0.1,
			0.073,
			0.04,
			angle,
		);
	}

	prop(new THREE.SphereGeometry(0.065, 12, 8), "#d0a144", fx, 0.54, fz + 0.045, 1, 1, 0.7);

	for (const [color, geometries] of batches) {
		const merged = mergeGeometries(geometries);

		for (const geometry of geometries) {
			geometry.dispose();
		}

		const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color, roughness: 0.95 }));

		mesh.castShadow = true;
		world.add(mesh);
	}
}

export function createCreatureViewer({
	canvas,
	model,
	color,
	signal,
	onReady,
	onError,
}: {
	canvas: HTMLCanvasElement;
	model: Model;
	color: string | null;
	signal: AbortSignal;
	onReady: () => void;
	onError: () => void;
}): CreatureViewer {
	const scene = new THREE.Scene();
	const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 40);
	const world = new THREE.Group();
	const manager = new THREE.LoadingManager();
	const decoder = new DRACOLoader(manager).setDecoderPath("/creatures/draco/").setWorkerLimit(1);
	const events = new AbortController();
	const request = new AbortController();
	const cancelled = () => request.signal.aborted;
	const reduced = matchMedia("(prefers-reduced-motion: reduce)");
	let renderer: THREE.WebGLRenderer | undefined;
	let resizeObserver: ResizeObserver | undefined;
	let intersectionObserver: IntersectionObserver | undefined;
	let disposed = false;
	let loaded = false;
	let active = false;
	let paused = false;
	let inView = false;
	let frame = 0;
	let yaw = 0;
	let shadowYaw: number | undefined;
	let pointer: number | null = null;
	let previousX = 0;
	let friend: THREE.Group | undefined;
	const tintMaterials = new Map<THREE.MeshStandardMaterial, THREE.Color>();
	const key = new THREE.DirectionalLight("#fff2d5", 2.6);

	function visible() {
		return active && inView && !document.hidden && !disposed && loaded;
	}

	function moving() {
		return visible() && !paused && !reduced.matches && pointer === null;
	}

	function render(time = 0, initial = false) {
		if (!renderer || disposed || !loaded || (!initial && !visible())) {
			return;
		}

		world.rotation.y = yaw;

		if (friend) {
			friend.rotation.z = moving() ? Math.sin(time * 0.0013) * 0.018 : 0;
		}

		if (shadowYaw !== yaw) {
			renderer.shadowMap.needsUpdate = true;
			shadowYaw = yaw;
		}

		renderer.render(scene, camera);
	}

	function tick(time: number) {
		frame = 0;

		try {
			render(time);
		} catch {
			fail();

			return;
		}

		if (moving()) {
			frame = requestAnimationFrame(tick);
		}
	}

	function sync() {
		cancelAnimationFrame(frame);
		frame = 0;
		shadowYaw = undefined;

		if (visible()) {
			frame = requestAnimationFrame(tick);
		}
	}

	function resize() {
		if (!renderer || disposed) {
			return;
		}

		const { width, height } =
			canvas.parentElement?.getBoundingClientRect() ?? canvas.getBoundingClientRect();

		if (width <= 0 || height <= 0) {
			return;
		}

		const span = Math.max(3.85, 4.8 / (width / height));

		camera.left = (-span * width) / height / 2;
		camera.right = -camera.left;
		camera.top = span / 2;
		camera.bottom = -span / 2;
		camera.updateProjectionMatrix();
		renderer.setSize(width, height, false);
		sync();
	}

	function releasePointer() {
		if (pointer !== null && canvas.hasPointerCapture(pointer)) {
			canvas.releasePointerCapture(pointer);
		}

		pointer = null;
	}

	function dispose() {
		if (disposed) {
			return;
		}

		disposed = true;
		request.abort();
		manager.abort();
		events.abort();
		signal.removeEventListener("abort", dispose);
		cancelAnimationFrame(frame);
		releasePointer();
		resizeObserver?.disconnect();
		intersectionObserver?.disconnect();
		decoder.dispose();
		disposeObject(scene);
		key.shadow.dispose();
		tintMaterials.clear();
		scene.clear();
		renderer?.dispose();
		renderer?.forceContextLoss();
	}

	function fail() {
		if (disposed) {
			return;
		}

		dispose();
		onError();
	}

	function setColor(next: string | null) {
		color = next;

		for (const [material, original] of tintMaterials) {
			material.color.copy(original);

			if (next && /^#[0-9a-f]{6}$/i.test(next)) {
				material.color.set(next);
			}
		}

		sync();
	}

	const viewer: CreatureViewer = {
		setActive(next) {
			active = next;

			if (!active) {
				releasePointer();
			}

			sync();
		},
		setPaused(next) {
			paused = next;
			sync();
		},
		setColor,
		dispose,
	};

	async function start() {
		try {
			if (typeof AbortSignal.any !== "function") {
				throw new TypeError("Cancellable decoder loading unavailable");
			}

			if (signal.aborted) {
				dispose();

				return;
			}

			signal.addEventListener("abort", dispose, { once: true });
			renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "low-power" });
			renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
			renderer.setClearColor("#fbf5e7");
			renderer.outputColorSpace = THREE.SRGBColorSpace;
			renderer.toneMapping = THREE.NeutralToneMapping;
			renderer.toneMappingExposure = 0.9;
			renderer.shadowMap.enabled = true;
			renderer.shadowMap.autoUpdate = false;
			renderer.shadowMap.type = THREE.PCFSoftShadowMap;
			camera.position.set(4.1, 3.2, 7);
			camera.lookAt(0, 1, 0);
			scene.add(world, new THREE.HemisphereLight("#fff8e5", "#afab8e", 2), key);
			key.position.set(-3, 7, 5);
			key.castShadow = true;
			key.shadow.mapSize.set(512, 512);

			Object.assign(key.shadow.camera, {
				left: -4,
				right: 4,
				top: 4,
				bottom: -4,
				near: 1,
				far: 18,
			});

			key.shadow.normalBias = 0.025;
			key.shadow.bias = -0.0003;
			key.shadow.radius = 4;
			clearing(world);
			const options = { signal: events.signal };

			canvas.addEventListener(
				"webglcontextlost",
				(event) => {
					event.preventDefault();
					fail();
				},
				options,
			);

			canvas.addEventListener(
				"keydown",
				(event) => {
					if (!visible() || !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) {
						return;
					}

					event.preventDefault();
					yaw = event.key === "Home" ? 0 : yaw + (event.key === "ArrowLeft" ? -0.25 : 0.25);
					sync();
				},
				options,
			);

			canvas.addEventListener(
				"pointerdown",
				(event) => {
					if (!visible() || !event.isPrimary || event.button !== 0) {
						return;
					}

					pointer = event.pointerId;
					previousX = event.clientX;
					canvas.setPointerCapture(pointer);
					sync();
				},
				options,
			);

			canvas.addEventListener(
				"pointermove",
				(event) => {
					if (pointer !== event.pointerId || !visible()) {
						return;
					}

					yaw += (event.clientX - previousX) * 0.012;
					previousX = event.clientX;
					sync();
				},
				options,
			);

			for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
				canvas.addEventListener(
					name,
					() => {
						releasePointer();
						sync();
					},
					options,
				);
			}

			document.addEventListener(
				"visibilitychange",
				() => {
					if (document.hidden) {
						releasePointer();
					}

					sync();
				},
				options,
			);

			reduced.addEventListener("change", sync, options);
			resizeObserver = new ResizeObserver(resize);
			resizeObserver.observe(canvas.parentElement ?? canvas);

			intersectionObserver = new IntersectionObserver(([entry]) => {
				inView = entry.isIntersecting;

				if (!inView) {
					releasePointer();
				}

				sync();
			});

			intersectionObserver.observe(canvas.parentElement ?? canvas);
			const response = await fetch(model.url, { signal: request.signal });

			if (!response.ok) {
				throw new Error("Creature unavailable");
			}

			const bytes = await response.arrayBuffer();

			if (cancelled()) {
				return;
			}

			const loader = new GLTFLoader(manager).setDRACOLoader(decoder);
			const gltf = await loader.parseAsync(bytes, "");

			if (cancelled()) {
				for (const root of gltf.scenes) {
					disposeObject(root);
				}

				return;
			}

			const object = gltf.scene;

			friend = new THREE.Group();
			friend.add(object);
			world.add(friend);
			const box = new THREE.Box3().setFromObject(object);
			const size = box.getSize(new THREE.Vector3());
			const center = box.getCenter(new THREE.Vector3());
			const scale = model.size / (model.axis === "width" ? size.x : size.y);

			object.scale.multiplyScalar(scale);
			object.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
			friend.rotation.y = model.rotation;

			object.traverse((part) => {
				if (!isMesh(part)) {
					return;
				}

				part.castShadow = true;
				part.receiveShadow = true;

				for (const material of Array.isArray(part.material) ? part.material : [part.material]) {
					if (material instanceof THREE.MeshStandardMaterial && material.name === model.material) {
						tintMaterials.set(material, material.color.clone());
					}
				}
			});

			setColor(color);
			loaded = true;
			resize();
			render(0, true);
			onReady();
		} catch {
			fail();
		} finally {
			decoder.dispose();
		}
	}

	void start();

	return viewer;
}
