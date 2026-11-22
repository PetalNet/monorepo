<script lang="ts">
	let { value = $bindable("") }: { value?: string } = $props();
	const id = $props.id();
</script>

<div class="field">
	<label for={id}>3D color (optional)</label>
	<div class="color-choice">
		<input
			type="color"
			aria-label="Pick 3D color"
			value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#bf493e"}
			oninput={(event) => {
				value = event.currentTarget.value;
			}}
		/><input
			{id}
			class="input"
			aria-label="3D color hex"
			placeholder="Original model color"
			pattern={"#[0-9a-fA-F]{6}"}
			maxlength="7"
			bind:value
		/>
	</div>
	<small class="muted">Leave blank for the model’s original color. Photos stay as printed.</small>
</div>

<style>
	.color-choice {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	input[type="color"] {
		width: 50px;
		height: 50px;
		padding: 4px;
		background: var(--color-base-200);
		border: 0;
		border-radius: 6px;
		flex-shrink: 0;
	}
	.input {
		min-width: 0;
	}
</style>
