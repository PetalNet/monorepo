<script lang="ts">
	import type { CostComparisonMetric, CostComparisonResult } from "$lib/data/cost";

	import Icon from "./Icon.svelte";
	import IconButton from "./IconButton.svelte";

	interface Props {
		result: CostComparisonResult | null;
		loading: boolean;
		error: string | null;
		onclose: () => void;
		onrerun: () => void;
	}

	let { result, loading, error, onclose, onrerun }: Props = $props();
	let copied = $state(false);

	const labels: Record<CostComparisonMetric["key"], string> = {
		cost: "Total cost",
		tokens: "Total tokens",
		sessions: "Sessions",
		cost_per_session: "Cost / session",
		tokens_per_session: "Tokens / session",
		input_tokens: "Input tokens",
		output_tokens: "Output tokens",
		cache_creation_tokens: "Cache write",
		cache_read_tokens: "Cache read",
	};
	const moneyKeys = new Set<CostComparisonMetric["key"]>(["cost", "cost_per_session"]);
	const integerKeys = new Set<CostComparisonMetric["key"]>(["sessions"]);

	function compact(value: number): string {
		const absolute = Math.abs(value);
		if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
		if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
		return Math.round(value).toLocaleString();
	}

	function formatMetric(metric: CostComparisonMetric, side: "left" | "right"): string {
		const amount = metric[side];
		if (moneyKeys.has(metric.key)) return `$${amount.toFixed(2)}`;
		if (integerKeys.has(metric.key)) return String(Math.round(amount));
		return compact(amount);
	}

	function delta(metric: CostComparisonMetric): string {
		const prefix = metric.delta > 0 ? "+" : metric.delta < 0 ? "−" : "";
		const magnitude = Math.abs(metric.delta);
		if (moneyKeys.has(metric.key)) return `${prefix}$${magnitude.toFixed(2)}`;
		return `${prefix}${compact(magnitude)}`;
	}

	function ratio(metric: CostComparisonMetric): string {
		return metric.ratio === null ? "no baseline" : `${metric.ratio.toFixed(2)}×`;
	}

	async function copyQuery() {
		if (!result) return;
		try {
			await navigator.clipboard.writeText(result.receipt.query);
			copied = true;
			setTimeout(() => (copied = false), 1_500);
		} catch {
			copied = false;
		}
	}
</script>

<div class="compare-shell" aria-live="polite">
	<header>
		<div class="title">
			<Icon name="columns-2" size={16} />
			<div>
				<h2 id="cost-compare-title">Compare cost</h2>
				<p>{result ? `By ${result.dimension} · same ledger window` : "Pairwise ledger query"}</p>
			</div>
		</div>
		<IconButton name="x" label="Close comparison" autofocus onclick={onclose} />
	</header>

	{#if loading}
		<div class="comparison-skeleton" aria-label="Loading cost comparison">
			<div class="skeleton heading"></div>
			{#each Array.from({ length: 7 }, (_, index) => index) as index (index)}
				<div class="skeleton row"></div>
			{/each}
		</div>
	{:else if error}
		<div class="failure" role="alert">
			<Icon name="triangle-alert" size={16} />
			<b>Comparison unavailable</b>
			<p>{error}</p>
			<span>Nothing rendered, nothing pretended.</span>
		</div>
	{:else if result}
		<div class="pair-head">
			<span></span>
			<strong>{result.left.value}</strong>
			<strong>{result.right.value}</strong>
			<span>Right vs left</span>
		</div>
		<div class="metrics">
			{#each result.metrics as metric, __eachKey7 (__eachKey7)}
				{#if metric.key === "input_tokens"}<h3>Token mix</h3>{/if}
				<div class="metric">
					<b>{labels[metric.key]}</b>
					<code>{formatMetric(metric, "left")}</code>
					<code>{formatMetric(metric, "right")}</code>
					<span class:lower={metric.delta < 0}>
						<strong>{delta(metric)}</strong>
						<small>{ratio(metric)}</small>
					</span>
				</div>
			{/each}
		</div>
		<details class="receipt">
			<summary><Icon name="receipt-text" size={12} /> Show the math.</summary>
			<p><b>Cost source · {result.receipt.cost_source}</b><br />Provider-reported cost wins per usage row; otherwise the four token kinds are multiplied by the effective model rates.</p>
			{#if result.receipt.pricing.models.length}
				<div class="rate-table" role="table" aria-label="Effective model rates">
					<div class="rate-head" role="row"><b role="columnheader">Model → matched pattern</b><span role="columnheader">in / out / write / read · USD/M</span></div>
					{#each result.receipt.pricing.models as rate, __eachKey8 (__eachKey8)}
						<div role="row"><span role="cell"><code>{rate.model} → {rate.matched_pattern}</code></span><span role="cell"><code>{rate.input_per_mtok.toFixed(2)} / {rate.output_per_mtok.toFixed(2)} / {rate.cache_creation_per_mtok.toFixed(2)} / {rate.cache_read_per_mtok.toFixed(2)}</code></span></div>
					{/each}
				</div>
			{/if}
			<dl>
				<div><dt>Scope</dt><dd>{result.receipt.scope}</dd></div>
				<div><dt>Source</dt><dd>{result.receipt.source}</dd></div>
				<div><dt>Ledger query</dt><dd>{result.query_ref}</dd></div>
				<div><dt>Price book</dt><dd>{result.pricing_query_ref}</dd></div>
					<div><dt>Price version</dt><dd>{result.receipt.pricing.table_version}</dd></div>
					<div><dt>Price digest</dt><dd>{result.receipt.pricing.digest}</dd></div>
				<div><dt>Result</dt><dd>{result.receipt.row_count} aggregate rows · {result.receipt.session_count} sessions · {result.receipt.execution_ms ?? "—"} ms</dd></div>
				<div><dt>Counted through</dt><dd>{new Date(result.observed_at).toLocaleString()}</dd></div>
				<div><dt>Query</dt><dd>{result.receipt.query}</dd></div>
			</dl>
			<div class="receipt-actions">
				<button type="button" onclick={copyQuery}><Icon name="copy" size={14} />{copied ? "Copied" : "Copy query"}</button>
				<button type="button" onclick={onrerun}><Icon name="refresh-cw" size={14} />Re-run</button>
			</div>
		</details>
	{/if}
</div>

<style>
	.compare-shell{min-height:100%;display:flex;flex-direction:column;gap:var(--s-3)}
	header,.title{display:flex;align-items:center}.title{gap:var(--s-2);flex:1;min-width:0}.title>div{min-width:0}h2{font:500 .9375rem var(--sans)}p{font-size:.75rem;color:var(--text-3);text-wrap:pretty}.pair-head,.metric{display:grid;grid-template-columns:minmax(104px,1fr) minmax(88px,1fr) minmax(88px,1fr) minmax(88px,.8fr);gap:var(--s-2);align-items:center}.pair-head{position:sticky;top:calc(var(--s-4) * -1);z-index:var(--z-sticky);background:var(--s1);padding:var(--s-2) 0;border-bottom:1px solid var(--rule)}.pair-head strong{font:500 .75rem var(--mono);overflow-wrap:anywhere}.pair-head span:last-child{font:400 .6875rem var(--mono);color:var(--text-3);text-align:right}.metrics{display:flex;flex-direction:column}.metric{min-height:48px;border-bottom:1px solid var(--rule)}.metric>b{font-size:.75rem;font-weight:500}.metric code{font:500 .75rem var(--mono);font-variant-numeric:tabular-nums}.metric>span{display:flex;flex-direction:column;align-items:flex-end;color:var(--petal-text);font:500 .75rem var(--mono)}.metric>span.lower{color:var(--jade-text)}.metric small{font:400 .6875rem var(--mono);color:var(--text-3)}h3{font:500 .6875rem var(--mono);color:var(--text-3);padding:var(--s-3) 0 var(--s-1)}.receipt{margin-top:auto;border-top:1px solid var(--rule);padding-top:var(--s-2)}.receipt summary{min-height:32px;display:flex;align-items:center;gap:var(--s-1);cursor:pointer;color:var(--petal-text);font-size:.75rem;font-weight:500}.receipt p{margin:var(--s-2) 0}.receipt dl{font:400 .6875rem var(--mono)}.receipt dl div{display:grid;grid-template-columns:112px 1fr;gap:var(--s-2);padding:var(--s-1) 0}.receipt dt{color:var(--text-3)}.receipt dd{overflow-wrap:anywhere}.rate-table{border-block:1px solid var(--rule);font-size:.6875rem}.rate-table>div{display:grid;grid-template-columns:minmax(160px,1fr) auto;gap:var(--s-2);padding:var(--s-1) 0}.rate-table [role="cell"]:last-child{text-align:right}.rate-head{color:var(--text-3)}.receipt-actions{display:flex;justify-content:flex-end;gap:var(--s-2);padding-top:var(--s-2)}.receipt-actions button{min-height:32px;display:flex;align-items:center;gap:var(--s-1);border:0;background:var(--s2);color:var(--text);padding:0 var(--s-2)}.failure{min-height:240px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:var(--s-2);color:var(--warn-text)}.failure p,.failure span{max-width:36ch}.failure span{font-size:.6875rem;color:var(--text-3)}.comparison-skeleton{display:flex;flex-direction:column;gap:var(--s-2)}.skeleton{background:var(--s3);animation:pulse 1.4s var(--ease-standard) infinite}.skeleton.heading{height:40px}.skeleton.row{height:48px}@keyframes pulse{50%{opacity:.55}}@media(max-width:520px){.pair-head,.metric{grid-template-columns:minmax(88px,1fr) 72px 72px}.pair-head>*:last-child,.metric>span{grid-column:2/-1}.metric>span{flex-direction:row;justify-content:flex-end;gap:var(--s-2)}.rate-table>div{grid-template-columns:1fr}.rate-table [role="cell"]:last-child{text-align:left}}@media(prefers-reduced-motion:reduce){.skeleton{animation:none}}
</style>
