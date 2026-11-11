<script lang="ts">
  import Icon from './Icon.svelte';

  interface Status {
    step: string;
    detail?: string;
  }

  let {
    statuses,
    active = true,
  }: {
    statuses: Status[];
    active?: boolean;
  } = $props();

  const labels: Record<string, string> = {
    resolving: 'Resolving the date',
    recalling: 'Searching your conversation',
    searching: 'Searching the web',
    comparing: 'Comparing stored claims',
    writing: 'Writing the answer',
    grounding: 'Checking citations',
    remembering: 'Updating memory',
  };

  let current = $derived(statuses[statuses.length - 1]);
</script>

{#if statuses.length > 0}
  <div class="mb-3" aria-live="polite">
    <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {#each statuses as status, index (index)}
        {#if index > 0}
          <span class="text-faint/70" aria-hidden="true">→</span>
        {/if}
        <span
          class="inline-flex items-center gap-1 text-[10px] font-medium tracking-[0.02em]"
          class:text-ink={index === statuses.length - 1}
          class:text-faint={index !== statuses.length - 1}
        >
          {#if index === statuses.length - 1 && active}
            <span class="status-dot"></span>
          {:else if index !== statuses.length - 1}
            <Icon name="check" size={10} stroke={2.2} />
          {/if}
          {labels[status.step] ?? status.step}
        </span>
      {/each}
    </div>
    {#if current?.detail}
      <p class="mt-1 text-[11px] leading-relaxed text-muted">{current.detail}</p>
    {/if}
  </div>
{/if}
