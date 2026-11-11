<script lang="ts">
  import Icon from './Icon.svelte';

  let {
    mode,
    loadingDemo = false,
    onPrompt,
    onLoadDemo,
  }: {
    mode: 'live' | 'demo';
    loadingDemo?: boolean;
    onPrompt: (prompt: string) => void;
    onLoadDemo: () => void;
  } = $props();

  const demoPrompts = [
    {
      query: 'What did I ask you on 3 November?',
      label: 'What did I ask you on 3 November?',
      hint: 'Exact recall, resolved to the right civil date',
      icon: 'clock',
    },
    {
      query: 'What did I ask on 3 November, and is it still true?',
      label: 'What did I ask on 3 November, and is it still true?',
      hint: 'Recall plus a claim-by-claim re-check',
      icon: 'refresh',
    },
    {
      query: 'What changed at Pipedrive since Monday?',
      label: 'What changed at Pipedrive since Monday?',
      hint: 'Stored CRM claims compared with newer sources',
      icon: 'search',
    },
    {
      query: 'What did I ask you the other day?',
      label: 'What did I ask you the other day?',
      hint: 'A vague date should get one clarifying question',
      icon: 'alert',
    },
  ];

  const livePrompts = [
    {
      query: 'Compare current managed Postgres pricing for a small app.',
      label: 'Compare current managed Postgres pricing.',
      hint: 'A fresh answer with quoted, checked citations',
      icon: 'search',
    },
    {
      query: 'What did I ask you last week?',
      label: 'What did I ask you last week?',
      hint: 'Recall from this conversation',
      icon: 'clock',
    },
    {
      query: 'Have any of the tools we discussed raised their prices?',
      label: 'Have any tools we discussed raised prices?',
      hint: 'Re-check the claim ledger against today',
      icon: 'refresh',
    },
  ];

  let prompts = $derived(mode === 'demo' ? demoPrompts : livePrompts);
</script>

<section class="flex min-h-full flex-col justify-center py-10 sm:py-14">
  <p class="mono-label text-accent">A chat agent with a memory</p>
  <h1 class="serif mt-3 max-w-[15em] text-[2.15rem] font-medium leading-[1.04] tracking-[-0.025em] text-ink sm:text-[2.7rem]">
    I remember what I told you — <span class="text-accent">and I check if it’s still true.</span>
  </h1>
  <p class="mt-4 max-w-[42rem] text-[0.95rem] leading-relaxed text-muted">
    Since keeps a dated ledger of its answers, with the exact quote behind every claim. Come back
    later and ask what you discussed — or whether the answer still holds.
  </p>

  <div class="mt-7 grid gap-2 sm:grid-cols-3">
    <div class="rounded-xl border border-line/80 bg-surface/60 px-3.5 py-3">
      <Icon name="clock" size={16} class="text-accent" />
      <p class="mt-2 text-[12px] font-semibold text-ink">Temporal recall</p>
      <p class="mt-0.5 text-[11px] leading-relaxed text-muted">
        “Last Tuesday” resolves to a real date in your timezone, not a guess.
      </p>
    </div>
    <div class="rounded-xl border border-line/80 bg-surface/60 px-3.5 py-3">
      <Icon name="layers" size={16} class="text-accent" />
      <p class="mt-2 text-[12px] font-semibold text-ink">A claim ledger</p>
      <p class="mt-0.5 text-[11px] leading-relaxed text-muted">
        Prices and features are stored with an as-of date and the source quote.
      </p>
    </div>
    <div class="rounded-xl border border-line/80 bg-surface/60 px-3.5 py-3">
      <Icon name="check" size={16} class="text-accent" />
      <p class="mt-2 text-[12px] font-semibold text-ink">A grounding gate</p>
      <p class="mt-0.5 text-[11px] leading-relaxed text-muted">
        A citation survives only if its quote exists in the cited source text.
      </p>
    </div>
  </div>

  <div class="mt-8">
    <div class="flex items-baseline justify-between gap-3">
      <span class="mono-label text-faint">
        {mode === 'demo' ? 'Try the sample history' : 'Start with a question'}
      </span>
      {#if mode === 'demo'}
        <button
          type="button"
          class="text-[11px] font-medium text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent disabled:opacity-50"
          onclick={onLoadDemo}
          disabled={loadingDemo}
        >
          {loadingDemo ? 'Loading…' : 'Load sample history'}
        </button>
      {/if}
    </div>

    <div class="mt-2.5 flex flex-col gap-2">
      {#each prompts as prompt (prompt.query)}
        <button
          type="button"
          class="group flex w-full items-center gap-3 rounded-xl border border-line bg-surface/70 px-3.5 py-2.5 text-left transition-all hover:-translate-y-px hover:border-ink/20 hover:bg-raised hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
          onclick={() => onPrompt(prompt.query)}
          disabled={loadingDemo}
        >
          <span
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-paper text-muted transition-colors group-hover:border-accent/30 group-hover:text-accent"
          >
            <Icon name={prompt.icon} size={15} />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-[13px] font-medium text-ink">{prompt.label}</span>
            <span class="mt-0.5 block text-[11px] text-muted">{prompt.hint}</span>
          </span>
          <Icon
            name="arrowUp"
            size={14}
            class="rotate-45 text-faint transition-colors group-hover:text-accent"
          />
        </button>
      {/each}
    </div>

    {#if mode === 'demo'}
      <p class="mt-3 text-[10px] leading-relaxed text-faint">
        Demo mode uses a small built-in CRM and Postgres corpus. No live web search or model ran.
        Add keys to <code class="font-mono text-[10px]">.env</code> for live answers.
      </p>
    {/if}
  </div>
</section>
