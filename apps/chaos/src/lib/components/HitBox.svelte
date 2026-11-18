<script lang="ts">
	import { resolve } from "$app/paths";
	import { clock, day, plural } from "$lib/format";
	import type { HitCheck } from "$lib/server/hit/check";

	import SourceLine from "./SourceLine.svelte";

	let { check, door }: { check: HitCheck; door: string } = $props();

	const hits = $derived(
		check.kind === "result" ? check.findings.filter((finding) => finding.hit) : [],
	);
</script>

<section class="hit" id="hit" aria-labelledby="hit-title">
	<h2 id="hit-title">Does it hit me?</h2>
	<p class="what">
		Type a domain. We read its public DNS records, name the providers they point at, and set each
		one against the status board and CISA's exploited list.
	</p>

	<form method="get" action="{resolve('/')}#hit" data-sveltekit-noscroll data-sveltekit-keepfocus>
		<input type="hidden" name="door" value={door} />
		<label for="domain">Domain</label>
		<div class="field">
			<input
				id="domain"
				name="domain"
				type="text"
				inputmode="url"
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				placeholder="example.org"
				value={"domain" in check ? check.domain : ""}
				aria-describedby={check.kind === "invalid" ? "domain-error" : undefined}
				aria-invalid={check.kind === "invalid"}
				required
			/>
			<button type="submit">Check</button>
		</div>
		{#if check.kind === "invalid"}
			<p class="error" id="domain-error">
				That is not a public domain name. Type one like example.org, with no path.
			</p>
		{/if}
	</form>

	<div aria-live="polite">
		{#if check.kind === "busy"}
			<p class="note">Too many checks in the last minute. Try again shortly.</p>
		{:else if check.kind === "missing"}
			<p class="note">{check.domain} does not exist in public DNS.</p>
		{:else if check.kind === "failed"}
			<p class="note">
				The DNS lookup for {check.domain} failed, so there is no answer. Nothing is assumed.
			</p>
		{:else if check.kind === "result"}
			<p class="verdict">
				{#if check.findings.length === 0}
					Public DNS for {check.domain} names none of the providers we track.
				{:else if hits.length === 0}
					Nothing on this panel hits {check.domain} right now.
				{:else}
					{plural(hits.length, "provider", "providers")} behind {check.domain}
					{hits.length === 1 ? "has" : "have"} something on this panel.
				{/if}
			</p>
			{#if check.findings.length > 0}
				<ul>
					{#each check.findings as finding (finding.id)}
						<li class:on={finding.hit}>
							<h3>
								{finding.name}
								<span>{finding.hit ? "On the panel" : "Clear"}</span>
							</h3>
							<p class="signs">
								{#each finding.signs as sign (sign.evidence)}
									<span><b>{sign.role}</b> <code>{sign.evidence}</code></span>
								{/each}
							</p>
							{#if finding.status?.claim}
								<p>
									Status page:
									<a href={finding.status.page} rel="external noreferrer"
										>{finding.status.claim.text}</a
									>.
									{#if finding.status.probe}
										Our probe: {finding.status.probe.reachable ? "reachable" : "not reachable"}.
									{/if}
								</p>
							{/if}
							{#if finding.exploited.worst}
								{@const top = finding.exploited.worst}
								<p>
									CISA listed {plural(
										finding.exploited.count,
										"exploited vulnerability",
										"exploited vulnerabilities",
									)} in {finding.name} products in the last 30 days. Worst:
									<a href="https://nvd.nist.gov/vuln/detail/{top.cveId}" rel="external noreferrer"
										>{top.name}</a
									>, added {day(top.dateAdded)}. Whether it touches {check.domain} depends on which products
									it runs.
								</p>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			<p class="note">Checked {clock(check.checkedAt)}. The domain is not stored or logged.</p>
		{/if}
	</div>

	<details>
		<summary>How it reads</summary>
		<p>
			This is a stand-in for DepMap, which maps a site's whole stack by crawling it. This box reads
			only public DNS: name servers, mail exchangers, the mail senders in the SPF record, what www
			points at, and the TXT records services use to prove an account. Fixed rules in code name the
			provider. It never connects to the domain, and it cannot see software inside a network, so an
			empty answer does not mean a domain depends on nothing.
		</p>
	</details>
	<SourceLine
		sources={[
			{ label: "Public DNS", href: "https://www.iana.org/domains/root/servers" },
			{
				label: "CISA KEV catalog",
				href: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
			},
		]}
		checkedAt={check.kind === "result" ? check.checkedAt : undefined}
	/>
</section>

<style>
	.hit {
		display: grid;
		gap: 0.75rem;
		padding: 1.5rem 1rem;
		background: var(--color-base-100);
	}
	@media (min-width: 60rem) {
		.hit {
			padding: 2rem 3rem;
		}
	}
	h2 {
		margin: 0;
		font-size: clamp(1.75rem, 1.3rem + 2.2vw, 3rem);
		font-weight: 300;
		line-height: 1.1;
	}
	.what {
		max-inline-size: 62ch;
		margin: 0;
		color: var(--color-muted);
	}
	form {
		display: grid;
		gap: 0.25rem;
		max-inline-size: 36rem;
		margin-block-start: 0.5rem;
	}
	label {
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	.field {
		display: flex;
		gap: 1px;
		background: var(--color-rule-strong);
		border-radius: 2px;
	}
	input[type="text"] {
		flex: 1;
		min-inline-size: 0;
		block-size: 3rem;
		padding-inline: 1rem;
		background: var(--color-base-200);
		color: var(--color-base-content);
		font: inherit;
		font-family: var(--font-mono), monospace;
		border-start-start-radius: 2px;
		border-end-start-radius: 2px;
	}
	input::placeholder {
		color: var(--color-muted);
	}
	button {
		block-size: 3rem;
		padding-inline: 1.5rem;
		background: var(--color-neutral);
		color: var(--color-neutral-content);
		font: inherit;
		font-weight: 500;
		cursor: pointer;
		border-start-end-radius: 2px;
		border-end-end-radius: 2px;
		transition: background-color 200ms var(--ease-out-expo);
	}
	button:hover {
		background: var(--color-primary);
		color: var(--color-primary-content);
	}
	:is(input, button):focus-visible {
		position: relative;
		z-index: 1;
	}
	.error {
		margin: 0.25rem 0 0;
		color: var(--color-error);
	}
	.verdict {
		max-inline-size: 30ch;
		margin: 1rem 0 0;
		font-size: 1.375rem;
		line-height: 1.25;
		text-wrap: balance;
		animation: settle 500ms var(--ease-out-expo);
	}
	@keyframes settle {
		from {
			opacity: 0.4;
			clip-path: inset(0 0 100% 0);
		}
	}
	.note {
		margin: 0.5rem 0 0;
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	ul {
		display: grid;
		column-gap: 3rem;
		margin: 0.5rem 0 0;
		padding: 0;
		list-style: none;
	}
	@media (min-width: 60rem) {
		ul {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	li {
		padding-block: 0.75rem;
		border-block-start: 1px solid var(--color-rule);
		font-size: 0.9375rem;
	}
	li p {
		max-inline-size: 60ch;
		margin: 0.25rem 0 0;
	}
	h3 {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin: 0;
		font-size: 1rem;
		font-weight: 500;
	}
	h3 span {
		font-size: 0.8125rem;
		font-weight: 400;
		color: var(--color-muted);
	}
	.on h3 span {
		font-weight: 500;
		color: var(--color-primary);
	}
	.signs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.5rem;
		color: var(--color-muted);
	}
	.signs b {
		font-weight: 400;
	}
	code {
		font-family: var(--font-mono), monospace;
		font-size: 0.8125rem;
		color: var(--color-base-content);
		overflow-wrap: anywhere;
	}
	details {
		font-size: 0.8125rem;
		color: var(--color-muted);
	}
	summary {
		inline-size: max-content;
		padding-block: 0.25rem;
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: var(--color-rule-strong);
		text-underline-offset: 0.2em;
	}
	details p {
		max-inline-size: 62ch;
		margin: 0.25rem 0 0;
	}
</style>
