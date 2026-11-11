<script lang="ts">
  import type { DiffRow, Source, Verdict } from '../../shared/types.js';
  import { formatDate, formatRelative, truncate } from '../lib/markdown.js';
  import Icon from './Icon.svelte';

  let {
    rows,
    sources,
    onCite,
  }: {
    rows: DiffRow[];
    sources: Source[];
    onCite: (sourceId: string) => void;
  } = $props();

  const verdictStyle: Record<Verdict, string> = {
    changed: 'border-accent/25 bg-accent-soft text-accent',
    unchanged: 'border-positive/25 bg-positive-soft text-positive',
    unclear: 'border-warning/25 bg-warning-soft text-warning',
  };

  const verdictLabel: Record<Verdict, string> = {
    changed: 'Changed',
    unchanged: 'No change',
    unclear: 'Unclear',
  };

  let changed = $derived(rows.filter((row) => row.verdict === 'changed').length);
  let unchanged = $derived(rows.filter((row) => row.verdict === 'unchanged').length);
  let unclear = $derived(rows.filter((row) => row.verdict === 'unclear').length);
  let checkedAt = $derived(rows[0]?.checkedAt);

  function sourceIdForUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    return sources.find((source) => source.url === url)?.id;
  }
</script>

{#if rows.length > 0}
  <section
    class="mt-4 overflow-hidden rounded-xl border border-line bg-surface/80"
    aria-label="Claim re-check"
  >
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line/80 px-3.5 py-2.5">
      <span class="flex h-5 w-5 items-center justify-center rounded-md bg-ink/5 text-ink">
        <Icon name="refresh" size={12} />
      </span>
      <span class="mono-label text-muted">Re-check</span>
      <span class="text-[10px] text-faint">
        {rows.length} {rows.length === 1 ? 'claim' : 'claims'} · checked {formatRelative(checkedAt)}
      </span>
      <span class="ml-auto flex items-center gap-1.5">
        {#if changed > 0}
          <span class="rounded-full border border-accent/20 bg-accent-soft px-1.5 py-0.5 text-[9px] font-semibold text-accent">
            {changed} changed
          </span>
        {/if}
        {#if unchanged > 0}
          <span class="rounded-full border border-positive/20 bg-positive-soft px-1.5 py-0.5 text-[9px] font-semibold text-positive">
            {unchanged} no change
          </span>
        {/if}
        {#if unclear > 0}
          <span class="rounded-full border border-warning/20 bg-warning-soft px-1.5 py-0.5 text-[9px] font-semibold text-warning">
            {unclear} unclear
          </span>
        {/if}
      </span>
    </div>

    <div class="hidden grid-cols-[1fr_1.2fr_1.3fr_auto] gap-3 border-b border-line/60 bg-paper/40 px-3.5 py-1.5 sm:grid">
      <span class="mono-label text-faint">Item</span>
      <span class="mono-label text-faint">Then</span>
      <span class="mono-label text-faint">Now</span>
      <span class="mono-label text-right text-faint">Verdict</span>
    </div>

    <div class="divide-y divide-line/60">
      {#each rows as row (row.claimId)}
        <div class="grid gap-2 px-3.5 py-3 sm:grid-cols-[1fr_1.2fr_1.3fr_auto] sm:gap-3">
          <div class="min-w-0">
            <p class="text-[12px] font-semibold leading-snug text-ink">{row.entity}</p>
            <p class="mt-0.5 text-[10px] capitalize text-faint">{row.attribute}</p>
          </div>

          <div class="min-w-0">
            <span class="mono-label mb-0.5 block text-faint sm:hidden">Then</span>
            <p class="text-[12px] leading-relaxed text-muted">{truncate(row.thenValue, 150)}</p>
            <p class="mt-0.5 text-[10px] text-faint">as of {formatDate(row.thenAsOf)}</p>
          </div>

          <div class="min-w-0">
            <span class="mono-label mb-0.5 block text-faint sm:hidden">Now</span>
            {#if row.verdict === 'changed'}
              <p class="text-[12px] font-medium leading-relaxed text-ink">
                {truncate(row.nowValue ?? 'Changed', 170)}
                {#if sourceIdForUrl(row.nowSourceUrl)}
                  {@const sourceId = sourceIdForUrl(row.nowSourceUrl)}
                  <button
                    type="button"
                    class="ml-0.5 inline-flex h-[15px] min-w-[19px] items-center justify-center rounded border border-accent/30 bg-accent-soft px-1 align-[0.2em] font-mono text-[8px] font-semibold text-accent"
                    onclick={() => sourceId && onCite(sourceId)}
                    title="Jump to source"
                  >
                    {sourceId}
                  </button>
                {/if}
              </p>
            {:else if row.verdict === 'unchanged'}
              <p class="text-[12px] leading-relaxed text-positive">No change found in dated sources</p>
            {:else}
              <p class="text-[12px] leading-relaxed text-muted">
                Not stated in the sources that were checked
              </p>
            {/if}
            {#if row.quote}
              <details class="group mt-1">
                <summary
                  class="inline-flex cursor-pointer list-none items-center gap-1 text-[9px] font-medium text-faint transition-colors hover:text-muted [&::-webkit-details-marker]:hidden"
                >
                  <Icon name="chevronDown" size={10} class="transition-transform group-open:rotate-180" />
                  Evidence quote
                </summary>
                <blockquote
                  class="mt-1 border-l border-line pl-2 font-serif text-[11px] italic leading-relaxed text-muted"
                >
                  “{truncate(row.quote, 240)}”
                </blockquote>
              </details>
            {/if}
          </div>

          <div class="flex items-start sm:justify-end">
            <span
              class="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold {verdictStyle[
                row.verdict
              ]}"
            >
              <span class="h-1 w-1 rounded-full bg-current"></span>
              {verdictLabel[row.verdict]}
            </span>
          </div>
        </div>
      {/each}
    </div>

    <p class="border-t border-line/60 bg-paper/40 px-3.5 py-2 text-[9.5px] leading-relaxed text-faint">
      Then is the stored claim with its original as-of date. Now reflects sources retrieved at
      re-check time. “Unclear” means no dated source stated a checkable value.
    </p>
  </section>
{/if}
