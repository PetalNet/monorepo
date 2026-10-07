<!-- THESIS: A recording station for one real voice at a time.
OWN-WORLD: Lab Material surfaces, plum action, precise 8px rhythm.
STORY: Consent, speak, listen, accept; see where each take is saved.
FIRST VIEWPORT: Booth rail, purpose, first name and consent, start action.
FORM: Brief-pinned sequential booth, expanding to a compact review list for Parker. -->
<script lang="ts">
	import { resolve } from "$app/paths";
	import { Mic, Square, Check, RotateCcw, ArrowRight } from "@lucide/svelte";
	import { onMount } from "svelte";

	import { prompts } from "#lib/prompts.ts";
	import { queue, type Progress, type Take } from "#lib/queue.ts";
	import { Recorder, type Recording } from "#lib/recorder.ts";

	import type { PageData } from "./$types";
	let { data }: { data: PageData } = $props();
	let name = $state(""),
		consent = $state(false),
		stage = $state<"landing" | "ready" | "recording" | "review" | "done">("landing");
	let progress = $state<Progress | null>(null),
		pending = $state<Take[]>([]),
		recording = $state<Recording | null>(null),
		preview = $state(""),
		level = $state(0),
		message = $state(""),
		micError = $state(""),
		busy = $state(false),
		loaded = $state(false);
	let recorder: Recorder | null = null,
		flushing = false;
	const prompt = $derived(prompts[progress?.index ?? 0]);
	const totalPending = $derived(pending.length);
	function revoke() {
		if (preview) URL.revokeObjectURL(preview);
		preview = "";
		recording = null;
	}
	async function refresh() {
		pending = await queue.takes();
	}
	async function uploadNext(items: Take[]): Promise<void> {
		const take = items.shift();
		if (!take) return;
		try {
			const response = await fetch(
				`/api/clips?id=${take.id}&set=${take.setId}&prompt=${String(take.index)}`,
				{
					method: "POST",
					headers: { "Content-Type": "audio/wav", "X-Participant-Id": take.participantId },
					body: take.wav,
					signal: AbortSignal.timeout(20000),
				},
			);
			if (!response.ok) {
				const failure = (await response.json().catch(() => null)) as { message?: unknown } | null;
				throw new Error(
					typeof failure?.message === "string"
						? failure.message
						: "Upload paused. Your take is saved here; please try again.",
				);
			}
			await queue.remove(take.id);
		} catch (e) {
			take.attempts++;
			take.next = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(take.attempts, 6));
			take.problem =
				e instanceof TypeError
					? "Connection interrupted. Your take is saved here."
					: e instanceof Error
						? e.message
						: "Waiting for a connection.";
			await queue.update(take);
			return;
		}
		await uploadNext(items);
	}
	async function flush(force = false) {
		if (flushing || !navigator.onLine || !progress) return;
		flushing = true;
		try {
			const items = (await queue.takes()).filter(
				(t) => t.participantId === progress?.participantId && (force || t.next <= Date.now()),
			);
			await uploadNext(items);
			await refresh();
		} catch {
			message = "Could not open saved takes. Keep this tab open and allow browser storage.";
		} finally {
			flushing = false;
		}
	}
	onMount(() => {
		name = data.auth?.name ?? "";
		void (async () => {
			try {
				progress = (await queue.progress()) ?? null;
				await refresh();
				if (progress) {
					name = progress.name;
					consent = true;
					stage = progress.index >= prompts.length ? "done" : "ready";
				}
				loaded = true;
				await flush();
			} catch {
				message =
					"This browser cannot save recordings locally. Allow site storage, then reload before recording.";
			}
		})();
		const timer = window.setInterval(() => {
			void flush();
		}, 3000);
		const online = () => {
			void flush(true);
		};
		window.addEventListener("online", online);
		return () => {
			clearInterval(timer);
			window.removeEventListener("online", online);
			recorder?.close();
			revoke();
		};
	});
	async function start() {
		busy = true;
		message = "";
		try {
			const response = await fetch("/api/session", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, consent: true }),
			});
			if (!response.ok) throw new Error("Could not start. Check your connection and try again.");
			const p = (await response.json()) as { id: string };
			progress = {
				name: name.trim(),
				participantId: p.id,
				setId: crypto.randomUUID(),
				index: 0,
				accepted: 0,
				skipped: 0,
			};
			await queue.saveProgress(progress);
			stage = "ready";
		} catch (e) {
			message = e instanceof Error ? e.message : "Could not save your session.";
		} finally {
			busy = false;
		}
	}
	async function connect() {
		if (recorder?.stream) return true;
		micError = "";
		recorder = new Recorder(
			(v) => {
				level = v;
			},
			(r) => {
				recording = r;
				preview = URL.createObjectURL(r.wav);
				stage = "review";
			},
			() => {
				micError = "The microphone disconnected. Reconnect it and record this phrase again.";
				stage = "ready";
			},
		);
		try {
			await recorder.open();
			return true;
		} catch {
			micError =
				"Microphone access is blocked or unavailable. Allow the microphone in your browser’s site settings, then tap Record again. On iPhone, use Safari and check Settings → Apps → Safari → Microphone. Close other apps using the mic.";
			recorder = null;
			return false;
		}
	}
	async function record() {
		if (busy) return;
		if (stage === "recording") {
			recorder?.stop();
			return;
		}
		busy = true;
		revoke();
		try {
			if (await connect()) {
				stage = "recording";
				await recorder?.start();
			}
		} finally {
			busy = false;
		}
	}
	async function advance(skip = false) {
		if (!progress || busy) return;
		busy = true;
		try {
			const next = {
				...progress,
				index: progress.index + 1,
				accepted: progress.accepted + (skip ? 0 : 1),
				skipped: progress.skipped + (skip ? 1 : 0),
			};
			if (!skip && recording) {
				await queue.accept(
					{
						id: crypto.randomUUID(),
						setId: progress.setId,
						participantId: progress.participantId,
						index: progress.index,
						wav: await recording.wav.arrayBuffer(),
						attempts: 0,
						next: 0,
						problem: "",
					},
					next,
				);
			} else await queue.saveProgress(next);
			progress = next;
			revoke();
			stage = next.index >= prompts.length ? "done" : "ready";
			if (stage === "done") recorder?.close();
			await refresh();
			void flush();
		} catch {
			message =
				"Could not save this take on your device. Free some browser storage and try again; your take is still here.";
		} finally {
			busy = false;
		}
	}
	async function reconnect() {
		if (!progress) return;
		busy = true;
		try {
			const response = await fetch("/api/session", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: progress.name, consent: true }),
			});
			const p = (await response.json()) as { id?: string };
			if (!response.ok || p.id !== progress.participantId) {
				message =
					"This session cannot be restored automatically. Keep this browser data and contact Parker.";
				return;
			}
			await flush(true);
		} finally {
			busy = false;
		}
	}
	async function more() {
		if (!progress) return;
		const next = { ...progress, setId: crypto.randomUUID(), index: 0, accepted: 0, skipped: 0 };
		await queue.saveProgress(next);
		progress = next;
		stage = "ready";
	}
	function keyboard(e: KeyboardEvent) {
		if (
			e.code !== "Space" ||
			e.repeat ||
			!(e.target instanceof HTMLElement) ||
			["INPUT", "BUTTON", "A", "SELECT", "AUDIO"].includes(e.target.tagName)
		)
			return;
		if (stage === "ready" || stage === "recording") {
			e.preventDefault();
			void record();
		}
	}
</script>

<svelte:head
	><title>Hey Janet · Recording booth</title><meta
		name="description"
		content="Lend your voice to Parker’s Janet wake-word training set. About three minutes, no account needed."
	/></svelte:head
>
<svelte:window onkeydown={keyboard} />
<main class="shell">
	<header class="topbar">
		<a class="brand" href={resolve("/")}><Mic size={20} /> Hey Janet</a><span class="muted"
			>Recording booth</span
		>
	</header>
	{#if stage === "landing"}
		<section class="intro">
			<span class="kind">A little of your voice. A better Janet.</span>
			<h1>Help Janet<br />hear you.</h1>
			<p>
				Say “Hey Janet” a few different ways, then a few phrases that sound close. Your real voice
				helps Parker teach Janet when to listen.
			</p>
			<p class="muted">40 short phrases · About 3 minutes · No account needed</p>
		</section>
		<form
			class="form"
			onsubmit={(e) => {
				e.preventDefault();
				void start();
			}}
		>
			<div>
				<label for="first-name">Your first name</label><input
					id="first-name"
					name="given-name"
					autocomplete="given-name"
					required
					maxlength="60"
					bind:value={name}
				/>
			</div>
			<label class="consent"
				><input type="checkbox" required bind:checked={consent} /><span
					>I agree that my recordings go into Parker’s Janet wake-word training set. I can ask to
					have them deleted by contacting the person who sent me this link.</span
				></label
			>
			<button type="submit" disabled={!loaded || busy || !consent || !name.trim()}
				>{busy ? "Starting…" : "Start recording"}<ArrowRight size={20} /></button
			>
			{#if data.auth}<p>
					Signed in with PetalNet as {data.auth.name || name}.
					<a href={resolve("/admin")}>Review recordings</a>
				</p>{:else if data.oidcEnabled}<a href={resolve("/auth/login")}
					>Sign in with PetalNet <span class="muted">(optional)</span></a
				>{/if}
		</form>
	{:else if stage === "done"}
		<section class="intro">
			<Check size={40} />
			<h1>That’s a wrap,<br />{progress?.name}.</h1>
			<p>Thank you for helping Janet recognize more voices.</p>
			<p>{progress?.accepted} takes accepted. {progress?.skipped} skipped.</p>
			<div class="notice" role="status">
				{totalPending
					? `${String(totalPending)} takes are saved on this device and waiting to upload. Keep this page open while they finish.`
					: "Your takes have uploaded. You can close this page."}
			</div>
		</section>
		<button
			onclick={() => {
				void more();
			}}>Record another set<ArrowRight size={20} /></button
		>
	{:else}
		<div class="row" style="margin-block-start:32px">
			<span>Hi, {progress?.name}</span><span class="muted"
				>Phrase {(progress?.index ?? 0) + 1} of {prompts.length}</span
			>
		</div>
		<progress
			class="progress"
			max={prompts.length}
			value={progress?.index ?? 0}
			aria-label="Set progress"
		></progress>
		<section class="station" aria-label="Current phrase">
			<span class="kind"
				>{prompt.kind === "pos" ? "Wake phrase" : "Near miss · should not wake Janet"}</span
			>
			<h1 class="phrase">“{prompt.say}”</h1>
			<p class="direction">{prompt.how}</p>
			<div
				class="meter"
				role="meter"
				aria-label="Microphone level"
				aria-valuemin="0"
				aria-valuemax="100"
				aria-valuenow={Math.round(level * 100)}
			>
				<div
					class="meter-fill"
					style:transform={`scaleX(${String(Math.min(1, level * 1.8))})`}
				></div>
			</div>
			<small
				>{stage === "recording"
					? "Listening. Say the phrase once."
					: stage === "review"
						? "Listen back before you continue."
						: "Tap Record, then speak when you see “Listening”."}</small
			>
		</section>
		{#if stage === "review" && recording}
			<audio controls src={preview} aria-label="Play your take"></audio>
			{#if recording.peak < 1500 / 32768 || recording.clipped}<p class="notice" role="status">
					{recording.clipped
						? "This take may be distorted. Move a little farther from the mic and try again."
						: "This take is very quiet. Try moving closer to the mic."} You can still use it if it sounds
					right.
				</p>{/if}
			<div class="row">
				<button
					disabled={busy}
					onclick={() => {
						void advance();
					}}>Use this take<Check size={20} /></button
				><button
					class="secondary"
					onclick={() => {
						revoke();
						stage = "ready";
					}}><RotateCcw size={20} />Redo</button
				>
			</div>
		{:else}<button
				class="record"
				disabled={busy}
				onclick={() => {
					void record();
				}}
				>{#if stage === "recording"}<Square size={24} />Stop recording{:else}<Mic size={24} />{busy
						? "Opening microphone…"
						: "Record"}{/if}</button
			>{/if}
		<div class="row" style="margin-block-start:16px">
			<button
				class="text-button"
				disabled={busy || stage === "recording"}
				onclick={() => {
					void advance(true);
				}}>Skip this phrase</button
			><small>Space to record or stop</small>
		</div>
		{#if micError}<p class="notice" role="alert">{micError}</p>{/if}
	{/if}
	{#if message}<p class="notice" role="alert">{message}</p>{/if}
	{#if totalPending}<div class="status" role="status">
			{totalPending}
			{totalPending === 1 ? "take" : "takes"} saved on this device, waiting to upload.{#if pending[0]?.problem}<p
				>
					{pending[0].problem}
				</p>{/if}<button
				class="text-button"
				disabled={busy}
				onclick={() => {
					void reconnect();
				}}>Retry uploads</button
			>
		</div>{/if}
	<footer class="footer">
		<span
			>{progress
				? `${String(progress.accepted)} accepted in this set`
				: "Your voice stays in Parker’s training set."}</span
		><span
			>{progress && !totalPending ? "All accepted takes uploaded" : "Made for real voices."}</span
		>{#if data.auth?.admin}<a href={resolve("/admin")}>Curate recordings</a>{/if}
	</footer>
</main>
