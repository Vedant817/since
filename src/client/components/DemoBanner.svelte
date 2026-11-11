<script lang="ts">
  let {
    mode,
    missingKeys,
    prompts,
    onPrompt,
  }: {
    mode: 'live' | 'demo';
    missingKeys: string[];
    prompts: Array<{ label: string; query: string }>;
    onPrompt: (prompt: string) => void;
  } = $props();
</script>

{#if mode === 'demo'}
  <div class="shrink-0 border-b border-warning/20 bg-warning-soft/55">
    <div
      class="mx-auto flex max-w-column flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-2 sm:px-5"
    >
      <span
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning/25 bg-warning-soft px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-warning"
        title={missingKeys.length > 0
          ? `Live mode needs ${missingKeys.join(' and ')}.`
          : undefined}
      >
        <span class="h-1 w-1 rounded-full bg-warning"></span>
        Demo
      </span>
      <span class="text-[10px] leading-snug text-muted">
        Sample history · built-in corpus · <span class="text-faint">no live search ran</span>
      </span>
      <span class="ml-auto flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {#each prompts.slice(0, 3) as prompt (prompt.query)}
          <button
            type="button"
            class="shrink-0 rounded-full border border-line/80 bg-raised/70 px-2.5 py-1 text-[10px] text-muted transition-colors hover:border-accent/30 hover:text-accent"
            onclick={() => onPrompt(prompt.query)}
            title={prompt.label}
          >
            {prompt.label}
          </button>
        {/each}
      </span>
    </div>
  </div>
{/if}
