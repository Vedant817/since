<script lang="ts">
  import type { Source } from '../../shared/types.js';
  import { formatDate, truncate, sourceLabel } from '../lib/markdown.js';
  import Icon from './Icon.svelte';

  let {
    sources,
    turnId,
    activeId = null,
  }: {
    sources: Source[];
    turnId: string;
    activeId?: string | null;
  } = $props();

  let open = $state(true);
</script>

{#if sources.length > 0}
  <section class="mt-4 border-t border-line/70 pt-3">
    <button
      type="button"
      class="flex w-full items-center gap-2 text-left"
      onclick={() => (open = !open)}
      aria-expanded={open}
    >
      <Icon name="link" size={13} class="text-faint" />
      <span class="mono-label text-muted">Sources</span>
      <span
        class="rounded-full border border-line bg-paper px-1.5 py-px font-mono text-[9px] text-muted"
      >
        {sources.length}
      </span>
      <span class="hidden text-[10px] text-faint sm:inline">
        {sources.every((source) => source.demo)
          ? 'built-in demo corpus'
          : 'retrieved for this answer'}
      </span>
      <span class="flex-1"></span>
      <Icon
        name="chevronDown"
        size={14}
        class="text-faint transition-transform {open ? 'rotate-180' : ''}"
      />
    </button>

    {#if open}
      <ul class="mt-2 grid gap-1.5 sm:grid-cols-2">
        {#each sources as source (source.id)}
          <li
            id={`src-${turnId}-${source.id}`}
            data-source-card={source.id}
            class="scroll-mt-6 rounded-lg border bg-surface/60 px-2.5 py-2 transition-all {activeId ===
            source.id
              ? 'border-accent/40 bg-accent-soft/35 shadow-sm'
              : 'border-line/70 hover:border-line'}"
          >
            <div class="flex items-start gap-2">
              <span
                class="mt-px inline-flex h-[17px] min-w-[22px] shrink-0 items-center justify-center rounded border border-line bg-paper px-1 font-mono text-[8.5px] font-semibold text-muted"
              >
                {source.id}
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-start gap-1">
                  {#if source.demo}
                    <span class="line-clamp-2 text-[11px] font-medium leading-snug text-ink">
                      {source.title}
                    </span>
                  {:else}
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="line-clamp-2 text-[11px] font-medium leading-snug text-ink underline decoration-line underline-offset-2 transition-colors hover:text-accent hover:decoration-accent/40"
                    >
                      {source.title}
                    </a>
                  {/if}
                  {#if !source.demo}
                    <Icon name="external" size={10} class="mt-0.5 shrink-0 text-faint" />
                  {/if}
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9px] text-faint">
                  <span>{sourceLabel(source)}</span>
                  {#if source.publishedAt}
                    <span aria-hidden="true">·</span>
                    <span>{formatDate(source.publishedAt)}</span>
                  {/if}
                  {#if source.demo}
                    <span class="rounded-sm border border-warning/20 bg-warning-soft px-1 py-px text-[8px] font-medium uppercase tracking-wide text-warning">
                      demo
                    </span>
                  {/if}
                </div>
                <p class="mt-1 line-clamp-2 text-[10px] leading-relaxed text-muted">
                  {truncate(source.content, 190)}
                </p>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
