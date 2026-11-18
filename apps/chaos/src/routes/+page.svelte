<script lang="ts">
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();

	const day = (iso: string) =>
		new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
			month: "long",
			day: "numeric",
			timeZone: "UTC",
		});
</script>

<main>
	<p class="eyebrow">{data.label} · {day(data.date)}</p>
	<h1>Today's door</h1>

	{#if !data.current}
		<p class="quiet">
			No current KEV data: the last successful check was not today, so this page says nothing about
			today.
		</p>
	{:else if data.addedToday === 0}
		<p class="quiet">
			As of the last check, CISA has added nothing to its Known Exploited Vulnerabilities list
			today.
		</p>
	{/if}

	{#if data.item && data.shownDate}
		{@const item = data.item}
		<article>
			<p class="eyebrow">
				{#if data.addedToday === 0}Last addition on record, {day(data.shownDate)}{:else}Worst of {data.shownCount}
					added today{/if}
				· cause: <strong>{data.cause}</strong>
			</p>
			<h2>{item.name}</h2>
			<p>{item.description}</p>
			<dl>
				<dt>CVE</dt>
				<dd>{item.cveId}</dd>
				<dt>Product</dt>
				<dd>{item.vendor} {item.product}</dd>
				<dt>Ransomware use</dt>
				<dd>{item.ransomware ? "Known to CISA" : "Not known to CISA"}</dd>
				<dt>US agencies must fix by</dt>
				<dd>{day(item.dueDate)}</dd>
			</dl>
			<p>
				Primary source:
				<a
					href="https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve={item.cveId}"
					rel="noreferrer">CISA KEV entry</a
				>
				· <a href="https://nvd.nist.gov/vuln/detail/{item.cveId}" rel="noreferrer">NVD record</a>
			</p>
		</article>
		<p class="rule">
			How "worst" is picked: the KEV list has no severity score, so entries CISA ties to ransomware
			come first, then the earliest fix deadline. "Attack" means CISA lists it as exploited in the
			wild.
		</p>
	{/if}

	<footer>
		{#if data.checkedAt}
			KEV last checked {new Date(data.checkedAt).toUTCString()}.
		{:else}
			No successful KEV pull yet.
		{/if}
	</footer>
</main>

<style>
	:global(body) {
		margin: 0;
		font:
			1rem/1.55 system-ui,
			sans-serif;
		color: light-dark(#1b1b1f, #ececf1);
		background: light-dark(#faf8f5, #121216);
	}
	main {
		max-width: 40rem;
		margin: 0 auto;
		padding: 3rem 1.25rem;
	}
	h1 {
		margin: 0 0 1.5rem;
		font-size: 2.25rem;
		line-height: 1.1;
	}
	h2 {
		margin: 0.25rem 0 0.75rem;
		font-size: 1.3rem;
		line-height: 1.25;
	}
	.eyebrow {
		margin: 0;
		font-size: 0.8rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: light-dark(#6a6a75, #a0a0ad);
	}
	.eyebrow strong {
		color: light-dark(#a3231f, #ff8a80);
	}
	article {
		margin: 1.5rem 0;
		padding: 1.25rem;
		border: 1px solid light-dark(#dcd8d0, #33333c);
		border-radius: 0.5rem;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 1rem;
		margin: 1rem 0;
	}
	dt,
	.rule,
	footer {
		color: light-dark(#6a6a75, #a0a0ad);
	}
	dd {
		margin: 0;
	}
	.rule,
	footer {
		font-size: 0.85rem;
	}
	a {
		color: inherit;
	}
</style>
