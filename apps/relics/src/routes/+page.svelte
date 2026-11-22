<svelte:head>
	<title>Petal Relics · A little friend, a new story</title>
	<meta
		name="description"
		content="Found a little friend? Tap its tag and give it a name. No sign-up. Just a name."
	/>
</svelte:head>
<section class="home-story">
	<h1>Found a<br />little friend?</h1>
	<p class="intro">Tap its tag!</p>
	<div class="flourish" aria-hidden="true"></div>
	<img
		src="/storybook/snail-placeholder.svg"
		alt="A little illustrated snail saying hello"
		width="300"
		height="240"
	/>
	<p>
		Hold your phone near your friend's tag to open its page. Give it a name, add your first name,
		and let your little story begin.
	</p>
	<p class="note">No sign-up. Just a name.</p>
	<details>
		<summary>Need a hand with the tag?</summary>
		<p>
			Unlock your phone and hold the top or back of it close to the tag. Tap the link that appears.
			If you have a QR code instead, open your camera and scan it.
		</p>
	</details>
</section>

<style>
	.home-story {
		max-width: 390px;
		margin: 12px auto 0;
	}
	.home-story h1 {
		font-size: 2.5rem;
	}
	.intro {
		margin-block-start: 16px;
		font-size: 1.25rem;
	}
	.home-story img {
		width: 100%;
		height: 260px;
		margin-block: 16px;
		object-fit: contain;
	}
	.note {
		font-family: var(--font-note);
		font-size: 1.5rem;
		margin-block: 24px;
	}
	details {
		margin-block-start: 32px;
		font-size: 0.875rem;
		color: var(--muted);
	}
</style>
