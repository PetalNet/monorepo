<script>
  import Icon from '$lib/Icon.svelte';
  import { enhance } from '$app/forms';
  let { data } = $props();
  let kind = $state('task');
  const KIND_ICON = { task: 'task', doc: 'doc', question: 'question' };
</script>

<svelte:head><title>new · tasks</title></svelte:head>

<div class="screen newscreen">
  <header class="page-head">
    <a class="back" href="/">
      <span style="transform:scaleX(-1);display:inline-flex"><Icon name="arrow" size={13} /></span>
      board
    </a>
    <h1>new</h1>
    <div class="kindtabs">
      {#each ['task', 'doc', 'question'] as k}
        <button type="button" class="kindtab" class:on={kind === k} onclick={() => (kind = k)}>
          <Icon name={KIND_ICON[k]} size={13} />{k}
        </button>
      {/each}
    </div>
  </header>

  <form method="POST" action="?/create" use:enhance class="nf">
    <input type="hidden" name="kind" value={kind} />
    <input class="title-in" name="title" autocomplete="off" required
           placeholder={kind === 'question' ? 'The question…' : kind === 'doc' ? 'Doc title…' : 'Task title…'} />

    <div class="nf-grid">
      <label class="afield">
        <span class="af-lbl">project</span>
        <input name="project" list="projs" placeholder="(none)" />
        <datalist id="projs">{#each data.projects as p}<option value={p.name}></option>{/each}</datalist>
      </label>
      {#if kind === 'task'}
        <label class="afield">
          <span class="af-lbl">priority</span>
          <select name="priority"><option value="0">P0</option><option value="1">P1</option><option value="2" selected>P2</option><option value="3">P3</option></select>
        </label>
      {/if}
    </div>

    {#if kind === 'task'}
      <section class="nf-sec">
        <div class="ds-head"><span class="ds-ic"><Icon name="doc" size={12} /></span><h2>notes / plan</h2></div>
        <textarea name="body" rows="5" placeholder="optional — drop research / the plan here"></textarea>
      </section>
      <label class="chk mono"><input type="checkbox" name="up_next" /> <Icon name="bolt" size={12} /> up next</label>
    {:else if kind === 'doc'}
      <section class="nf-sec">
        <div class="ds-head"><span class="ds-ic"><Icon name="doc" size={12} /></span><h2>body · markdown</h2></div>
        <textarea name="body" rows="14" class="mono" placeholder="# Brief / ADR…"></textarea>
      </section>
    {:else}
      <section class="nf-sec">
        <div class="ds-head"><span class="ds-ic"><Icon name="doc" size={12} /></span><h2>context · markdown</h2></div>
        <textarea name="body" rows="5" placeholder="background for the decision"></textarea>
      </section>
      <section class="nf-sec">
        <div class="ds-head"><span class="ds-ic"><Icon name="question" size={12} /></span><h2>options</h2><span class="ds-extra mono dim">one per line · "value | label"</span></div>
        <textarea name="options" rows="4" class="mono" placeholder={"yes | Yes, do it\nno | No"}></textarea>
      </section>
    {/if}

    <div class="save-bar">
      <label class="chk mono"><input type="checkbox" name="private" /> <Icon name="lock" size={12} /> private — only you</label>
      <button class="save" type="submit">create {kind}</button>
    </div>
  </form>
</div>

<style>
  .newscreen { max-width: 760px; }
  .page-head h1 { margin-top: 4px; }

  .kindtabs { display: flex; gap: 7px; margin-top: 14px; }
  .kindtab {
    display: inline-flex; align-items: center; gap: 6px; text-transform: capitalize;
    font: inherit; font-size: 13px; color: var(--text-3);
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius); padding: 8px 15px; cursor: pointer; transition: .12s;
  }
  .kindtab:hover { color: var(--text-1); border-color: var(--border); }
  .kindtab.on { border-color: var(--accent-ln); background: var(--accent-bg); color: var(--accent-b); }
  .kindtab svg { opacity: .8; }

  .nf { margin-top: 22px; }
  .title-in {
    width: 100%; background: none; border: none; border-bottom: 1px solid var(--border-sub);
    color: var(--text-1); font-family: var(--sans); font-size: 22px; font-weight: 650;
    letter-spacing: -.02em; padding: 4px 0; outline: none;
  }
  .title-in:focus { border-bottom-color: var(--accent-ln); }
  .title-in::placeholder { color: var(--text-4); font-weight: 500; }

  .nf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 18px; }
  .afield { display: flex; flex-direction: column; gap: 6px; }
  .af-lbl { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); }

  .nf-sec { margin-top: 22px; }

  .nf textarea, .nf input:not([type=checkbox]), .nf select {
    width: 100%; font: inherit; font-size: 14px; color: var(--text-1); resize: vertical;
    background: var(--surface-1); border: 1px solid var(--border-sub); border-radius: var(--radius); padding: 11px 13px; outline: none;
  }
  .nf textarea.mono { font-family: var(--mono); font-size: 13px; }
  .nf textarea:focus, .nf input:focus, .nf select:focus { border-color: var(--accent-ln); background: var(--surface-2); }
  .nf select { cursor: pointer; }

  .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-3); cursor: pointer; margin-top: 14px; }
  .chk input { width: auto; accent-color: var(--accent); }
  .chk svg { color: var(--text-4); }

  .save-bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-sub); }
  .save-bar .chk { margin-top: 0; }
  .save {
    margin-left: auto; padding: 9px 18px; border-radius: var(--radius); text-transform: capitalize;
    background: var(--accent); color: #1a1205; border: none; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: .12s;
  }
  .save:hover { background: var(--accent-b); }
</style>
