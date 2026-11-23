<!--
	/preferences — the same Clarity SPA shell as the root route. The shell reads
	the URL pathname and opens the preferences overlay (matching the legacy SPA,
	where prefs is an injected overlay, not a separate document). Direct loads and
	client navigation both land here; with JS off the search home renders (the
	overlay is the JS-enhanced editor).
-->
<script lang="ts">
	import Page from "../+page.svelte";
</script>

<Page />
