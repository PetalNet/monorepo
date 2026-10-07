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
	let recorder: Recorder | null = null;
	let flushing = $state(false);
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
		if (flushing || !navigator.onLine || !progress || !consent || stage === "landing") return;
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
		if (!consent || busy) return;
		busy = true;
		message = "";
		try {
			const response = await fetch("/api/session", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, consent }),
			});
			if (!response.ok) throw new Error("Could not start. Check your connection and try again.");
			const p = (await response.json()) as { id: string };
			if (progress && progress.participantId !== p.id)
				throw new Error("This session belongs to another participant. Start over to record.");
			progress ??= {
				name: name.trim(),
				participantId: p.id,
				setId: crypto.randomUUID(),
				index: 0,
				accepted: 0,
				skipped: 0,
			};
			await queue.saveProgress(progress);
			stage = progress.index >= prompts.length ? "done" : "ready";
			void flush(true);
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
			await refresh();
			progress = next;
			revoke();
			stage = next.index >= prompts.length ? "done" : "ready";
			if (stage === "done") recorder?.close();
			void flush();
		} catch {
			message =
				"Could not save this take on your device. Free some browser storage and try again; your take is still here.";
		} finally {
			busy = false;
		}
	}
	async function reconnect() {
		if (!progress || !consent) return;
		busy = true;
		try {
			const response = await fetch("/api/session", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: progress.name, consent }),
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
	async function startOver() {
		if (busy || flushing) return;
		busy = true;
		try {
			const response = await fetch("/api/session", { method: "DELETE" });
			if (!response.ok) throw new Error("Could not reset this session. Try again.");
			await queue.clear();
			recorder?.close();
			revoke();
			window.location.assign(resolve("/"));
		} catch (e) {
			message = e instanceof Error ? e.message : "Could not clear saved progress.";
			busy = false;
		}
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
<main class="mx-auto max-w-3xl p-4 sm:p-6">
	<header class="border-base-300 flex items-center justify-between gap-4 border-b pt-2 pb-6">
		<a
			class="text-base-content flex items-center gap-2 font-semibold no-underline"
			href={resolve("/")}><Mic size={20} /> Hey Janet</a
		><span class="text-base-content">Recording booth</span>
	</header>
	{#if progress}<div class="my-4">
			<button
				class="btn btn-ghost text-primary min-h-12 border-0 shadow-none"
				disabled={busy || flushing || stage === "recording"}
				onclick={() => {
					void startOver();
				}}>Not {progress.name}? Start over</button
			>
			<small class="block"
				>Starting over clears saved progress and unuploaded takes from this device.</small
			>
		</div>{/if}
	{#if stage === "landing"}
		<section class="max-w-xl pt-8 pb-6">
			<span class="text-primary font-semibold">A little of your voice. A better Janet.</span>
			<h1>Help Janet<br />hear you.</h1>
			<p>
				Say “Hey Janet” a few different ways, then a few phrases that sound close. Your real voice
				helps Parker teach Janet when to listen.
			</p>
			<p class="text-base-content">40 short phrases · About 3 minutes · No account needed</p>
		</section>
		<form
			class="grid max-w-lg gap-6"
			onsubmit={(e) => {
				e.preventDefault();
				void start();
			}}
		>
			<div>
				<label class="block" for="first-name">Your first name</label><input
					class="input bg-base-100 min-h-12 w-full border-0"
					id="first-name"
					disabled={!!progress}
					name="given-name"
					autocomplete="given-name"
					required
					maxlength="60"
					bind:value={name}
				/>
			</div>
			<label class="flex items-start gap-4 text-sm leading-relaxed font-normal"
				><input
					class="checkbox checkbox-primary shrink-0"
					type="checkbox"
					autocomplete="off"
					required
					bind:checked={consent}
				/><span
					>I agree that my recordings go into Parker’s Janet wake-word training set. I can ask to
					have them deleted by contacting the person who sent me this link.</span
				></label
			>
			<button
				class="btn btn-primary min-h-12 border-0 shadow-none"
				type="submit"
				disabled={!loaded || busy || !consent || !name.trim()}
				>{busy ? "Starting…" : progress ? "Resume recording" : "Start recording"}<ArrowRight
					size={20}
				/></button
			>
			{#if data.auth}<p>
					Signed in with PetalNet as {data.auth.name || name}.
					<a href={resolve("/admin")}>Review recordings</a>
				</p>{:else if data.oidcEnabled}<a href={resolve("/auth/login")}
					>Sign in with PetalNet <span class="text-base-content">(optional)</span></a
				>{/if}
		</form>
	{:else if stage === "done"}
		<section class="max-w-xl pt-8 pb-6">
			<Check size={40} />
			<h1>That’s a wrap,<br />{progress?.name}.</h1>
			<p>Thank you for helping Janet recognize more voices.</p>
			<p>{progress?.accepted} takes accepted. {progress?.skipped} skipped.</p>
			<div class="bg-base-100 my-4 p-4 leading-relaxed" role="status">
				{totalPending
					? `${String(totalPending)} takes are saved on this device and waiting to upload. Keep this page open while they finish.`
					: "Your takes have uploaded. You can close this page."}
			</div>
		</section>
		<button
			class="btn btn-primary min-h-12 border-0 shadow-none"
			onclick={() => {
				void more();
			}}>Record another set<ArrowRight size={20} /></button
		>
	{:else}
		<div class="flex flex-wrap items-center gap-4" style="margin-block-start:32px">
			<span>Hi, {progress?.name}</span><span class="text-base-content"
				>Phrase {(progress?.index ?? 0) + 1} of {prompts.length}</span
			>
		</div>
		<progress
			class="progress progress-primary h-1 w-full"
			max={prompts.length}
			value={progress?.index ?? 0}
			aria-label="Set progress"
		></progress>
		<section class="station" aria-label="Current phrase">
			<span class="text-primary font-semibold"
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
			{#if recording.peak < 1500 / 32768 || recording.clipped}<p
					class="bg-base-100 my-4 p-4 leading-relaxed"
					role="status"
				>
					{recording.clipped
						? "This take may be distorted. Move a little farther from the mic and try again."
						: "This take is very quiet. Try moving closer to the mic."} You can still use it if it sounds
					right.
				</p>{/if}
			<div class="flex flex-wrap items-center gap-4">
				<button
					class="btn btn-primary min-h-12 border-0 shadow-none"
					disabled={busy}
					onclick={() => {
						void advance();
					}}>Use this take<Check size={20} /></button
				><button
					class="btn bg-base-100 text-base-content min-h-12 border-0 shadow-none"
					onclick={() => {
						revoke();
						stage = "ready";
					}}><RotateCcw size={20} />Redo</button
				>
			</div>
		{:else}<button
				class="btn btn-primary min-h-12 min-h-18 w-full border-0 text-lg shadow-none"
				disabled={busy}
				onclick={() => {
					void record();
				}}
				>{#if stage === "recording"}<Square size={24} />Stop recording{:else}<Mic size={24} />{busy
						? "Opening microphone…"
						: "Record"}{/if}</button
			>{/if}
		<div class="flex flex-wrap items-center gap-4" style="margin-block-start:16px">
			<button
				class="btn btn-ghost text-primary min-h-12 border-0 shadow-none"
				disabled={busy || stage === "recording"}
				onclick={() => {
					void advance(true);
				}}>Skip this phrase</button
			><small>Space to record or stop</small>
		</div>
		{#if micError}<p class="bg-base-100 my-4 p-4 leading-relaxed" role="alert">{micError}</p>{/if}
	{/if}
	{#if message}<p class="bg-base-100 my-4 p-4 leading-relaxed" role="alert">{message}</p>{/if}
	{#if totalPending}<div class="my-6 min-h-12 leading-relaxed" role="status">
			{totalPending}
			{totalPending === 1 ? "take" : "takes"} saved on this device, waiting to upload.{#if pending[0]?.problem}<p
				>
					{pending[0].problem}
				</p>{/if}<button
				class="btn btn-ghost text-primary min-h-12 border-0 shadow-none"
				disabled={busy || !consent || stage === "landing"}
				onclick={() => {
					void reconnect();
				}}>Retry uploads</button
			>
		</div>{/if}
	<footer
		class="border-base-300 text-base-content mt-10 flex flex-wrap justify-between gap-4 border-t py-6 text-sm"
	>
		<span
			>{progress
				? `${String(progress.accepted)} accepted in this set`
				: "Your voice stays in Parker’s training set."}</span
		><span
			>{progress && !totalPending ? "All accepted takes uploaded" : "Made for real voices."}</span
		>{#if data.auth?.admin}<a href={resolve("/admin")}>Curate recordings</a>{/if}
	</footer>
</main>
