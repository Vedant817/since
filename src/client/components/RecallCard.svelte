<script lang="ts">
  import type { RecallHit } from '../../shared/types.js';
  import { formatDate, stripCitationMarkers, truncate } from '../lib/markdown.js';
  import Icon from './Icon.svelte';

  let {
    hits,
    timezone,
  }: {
    hits: RecallHit[];
    timezone: string;
  } = $props();

  let dates = $derived([
    ...new Set(hits.map((hit) => formatDate(hit.userTurn.createdAt, timezone))),
  ]);
</script>

{#if hits.length > 0}
  <section
    class="mt-4 overflow-hidden rounded-xl border border-accent/20 bg-accent-soft/30"
    aria-label="Recalled exchanges"
  >
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-accent/15 px-3.5 py-2.5">
      <span class="flex h-5 w-5 items-center justify-center rounded-md bg-accent/10 text-accent">
        <Icon name="layers" size={12} />
      </span>
      <span class="mono-label text-accent">Recalled from memory</span>
      <span class="text-[10px] text-muted">
        {hits.length} {hits.length === 1 ? 'exchange' : 'exchanges'}
        {#if dates.length > 0}· {dates.slice(0, 2).join(' · ')}{/if}
      </span>
    </div>

    <ol class="divide-y divide-accent/10">
      {#each hits.slice(0, 6) as hit (hit.userTurn.id)}
        <li class="px-3.5 py-3">
          <div class="flex items-baseline justify-between gap-3">
            <span class="mono-label text-faint">{formatDate(hit.userTurn.createdAt, timezone)}</span>
            <span class="text-[10px] text-faint">You asked</span>
          </div>
          <p class="serif mt-1 text-[15px] leading-snug text-ink">
            “{truncate(hit.userTurn.text, 260)}”
          </p>
          {#if hit.answerTurn}
            <details class="group mt-1.5">
              <summary
                class="inline-flex cursor-pointer list-none items-center gap-1 text-[10px] font-medium text-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden"
              >
                <Icon name="chevronDown" size={11} class="transition-transform group-open:rotate-180" />
                The answer I gave
              </summary>
              <p
                class="mt-1.5 border-l-2 border-accent/25 pl-2.5 text-[11px] leading-relaxed text-muted"
              >
                {truncate(stripCitationMarkers(hit.answerTurn.text), 380)}
              </p>
            </details>
          {/if}
        </li>
      {/each}
    </ol>

    {#if hits.length > 6}
      <p class="border-t border-accent/10 px-3.5 py-2 text-[10px] text-faint">
        +{hits.length - 6} more {hits.length - 6 === 1 ? 'exchange' : 'exchanges'} in this range
      </p>
    {/if}
  </section>
{/if}
