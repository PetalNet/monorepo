<script lang="ts">
	import { AgentCapabilityValidator, ContainmentFixValidator } from "#lib/actors/schema.ts";
	import { requestAgentCapability, resolveContainmentConflict } from "#lib/authority.remote.ts";

	import ConsoleField from "./ConsoleField.svelte";

	const requestForm = requestAgentCapability.preflight(AgentCapabilityValidator);
	const resolutionForm = resolveContainmentConflict.preflight(ContainmentFixValidator);
	let requestResult = $state(requestForm.result);
	let resolutionResult = $state(resolutionForm.result);
	let failure = $state("");
	const pending = $derived(requestForm.pending > 0 || resolutionForm.pending > 0);
	const conflicts = $derived(
		requestResult && !requestResult.ok && "conflicts" in requestResult ? requestResult : undefined,
	);
	const fixes = $derived([
		...new Map(
			(conflicts?.fixes ?? [])
				.filter((fix) => fix.available)
				.map(({ action, agentId, personId, capability }) => [
					JSON.stringify({
						action,
						agentId,
						personId: action === "remove-agent-capability" ? "" : personId,
						capability,
					}),
					{ action, agentId, personId, capability },
				]),
		).values(),
	]);
</script>

<form
	class="grid gap-4"
	{...requestForm.enhance(async (form) => {
		failure = "";
		requestResult = undefined;
		resolutionResult = undefined;

		try {
			if (await form.submit()) {
				requestResult = form.result;
			}
		} catch (cause) {
			failure =
				cause instanceof Error ? cause.message : "Could not request this permission. Try again.";
		}
	})}
	aria-busy={pending}
>
	<ConsoleField
		label="Agent ID"
		field={requestForm.fields.agentId}
		value={resolutionResult?.ok ? resolutionResult.agentId : undefined}
		maxlength={120}
	/>
	<ConsoleField
		label="Capability"
		field={requestForm.fields.capability}
		value={resolutionResult?.ok ? resolutionResult.capability : undefined}
		maxlength={120}
	/>
	<button class="btn btn-primary justify-self-start" disabled={pending}
		>{requestForm.pending > 0 ? "Requesting…" : "Request capability"}</button
	>
</form>

{#if failure}<p class="text-error mt-4" role="alert">{failure}</p>{/if}
{#if requestResult?.ok}<p class="mt-4" role="status">Capability granted.</p>
{:else if requestResult && "message" in requestResult}<p class="text-error mt-4" role="alert">
		{requestResult.message}
	</p>{/if}
{#if resolutionResult?.ok}<p class="mt-4" role="status">
		Resolution applied. Submit the capability request again to grant it.
	</p>
{:else if resolutionResult}<p class="text-error mt-4" role="alert">
		Could not apply this resolution. Sign in and try again.
	</p>{/if}

{#if conflicts}
	<section class="mt-8" aria-labelledby="permission-conflict-heading">
		<h2 id="permission-conflict-heading" class="text-xl font-medium">Permission conflict</h2>
		<ul class="mt-4 grid gap-2">
			{#each conflicts.conflicts as conflict (`${conflict.agentId}:${conflict.personId}`)}
				<li class="break-words">
					Person {conflict.personId} lacks {conflict.missingCapabilities.join(", ")}.
				</li>
			{/each}
		</ul>
		{#if fixes.length === 0}<p class="mt-4">A home owner must resolve this conflict.</p>{/if}
	</section>
{/if}

<form
	{...resolutionForm.enhance(async (form) => {
		failure = "";
		resolutionResult = undefined;

		try {
			if (await form.submit()) {
				resolutionResult = form.result;

				if (resolutionResult?.ok) {
					requestResult = undefined;
				}
			}
		} catch (cause) {
			failure =
				cause instanceof Error ? cause.message : "Could not apply this resolution. Try again.";
		}
	})}
	aria-busy={pending}
>
	{#if fixes.length > 0}
		<fieldset class="mt-4 grid gap-4" disabled={pending}>
			<legend class="mb-4">Choose a resolution</legend>
			{#each fixes as fix (JSON.stringify(fix))}
				<label class="flex items-start gap-3">
					<input
						class="radio radio-sm border-base-content mt-0.5 border"
						{...resolutionForm.fields.fix.as("radio", JSON.stringify(fix))}
						required
					/>
					<span class="min-w-0 break-words">
						{fix.action === "grant-person-capability"
							? `Grant ${fix.capability} to ${fix.personId}`
							: fix.action === "remove-agent-access"
								? `Remove ${fix.personId}'s access to this Agent`
								: `Remove ${fix.capability} from this Agent`}
					</span>
				</label>
			{/each}
			<button class="btn btn-neutral justify-self-start"
				>{resolutionForm.pending > 0 ? "Applying…" : "Apply resolution"}</button
			>
		</fieldset>
	{/if}
	{#each resolutionForm.fields.fix.issues() ?? [] as issue, index (index)}
		<p class="text-error mt-4" role="alert">{issue.message}</p>
	{/each}
</form>
