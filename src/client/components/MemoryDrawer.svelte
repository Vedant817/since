<script lang="ts">
  import type { Claim } from '../../shared/types.js';
  import { formatDate, formatRelative, groupClaims, truncate } from '../lib/markdown.js';
  import Icon from './Icon.svelte';

  let {
    open,
    claims,
    timezone,
    onClose,
  }: {
    open: boolean;
    claims: Claim[];
    timezone: string;
    onClose: () => void;
  } = $props();

  let query = $state('');
  let closeButton: HTMLButtonElement | undefined = $state();

  let activeClaims = $derived(claims.filter((claim) => claim.status === 'active'));
  let entities = $derived(new Set(activeClaims.map((claim) => claim.entity)));
  let checkedToday = $derived(
    claims.filter((claim) => {
      if (!claim.lastCheckedAt) return false;
      try {
        return (
          new Date(claim.lastCheckedAt).toLocaleDateString('en-CA', { timeZone: timezone }) ===
          new Date().toLocaleDateString('en-CA', { timeZone: timezone })
        );
      } catch {
        return false;
      }
    }).length,
  );

  let filtered = $derived(
    claims.filter((claim) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return `${claim.entity} ${claim.attribute} ${claim.value}`
        .toLowerCase()
        .includes(needle);
    }),
  );
  let groups = $derived(groupClaims(filtered));

  const volatilityStyle: Record<Claim['volatility'], string> = {
    high: 'border-accent/20 bg-accent-soft/60 text-accent',
    medium: 'border-warning/20 bg-warning-soft/60 text-warning',
    low: 'border-line bg-paper text-muted',
  };

  function host(url: string | undefined): string {
    if (!url) return 'source';
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'source';
    }
  }

  function isDemoUrl(url: string | undefined): boolean {
    return Boolean(url?.includes('demo.since.local'));
  }

  $effect(() => {
    if (open) closeButton?.focus();
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (open && event.key === 'Escape') onClose();
  }}
/>

{#if open}
  <div class="fixed inset-0 z-40">
    <button
      type="button"
      class="absolute inset-0 bg-ink/20 backdrop-blur-[2px]"
      onclick={onClose}
      aria-label="Close memory drawer"
      tabindex="-1"
    ></button>

    <div
      class="absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-line bg-paper shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="Stored claims"
    >
      <div class="flex items-start gap-3 border-b border-line/80 px-5 pb-4 pt-5">
        <div class="min-w-0 flex-1">
          <p class="mono-label text-accent">Memory</p>
          <h2 class="serif mt-1 text-[26px] font-medium leading-none tracking-[-0.02em] text-ink">
            What Since remembers
          </h2>
          <p class="mt-2 text-[11px] leading-relaxed text-muted">
            Every stored claim keeps its as-of date, source, and exact quote. Read only.
          </p>
        </div>
        <button
          bind:this={closeButton}
          type="button"
          class="btn-ghost -mr-1 h-8 w-8 shrink-0"
          onclick={onClose}
          aria-label="Close memory drawer"
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      <div class="grid grid-cols-3 divide-x divide-line/70 border-b border-line/70 bg-surface/50">
        <div class="px-4 py-3">
          <p class="font-mono text-[17px] font-medium leading-none text-ink">{activeClaims.length}</p>
          <p class="mono-label mt-1 text-faint">active claims</p>
        </div>
        <div class="px-4 py-3">
          <p class="font-mono text-[17px] font-medium leading-none text-ink">{entities.size}</p>
          <p class="mono-label mt-1 text-faint">entities</p>
        </div>
        <div class="px-4 py-3">
          <p class="font-mono text-[17px] font-medium leading-none text-ink">{checkedToday}</p>
          <p class="mono-label mt-1 text-faint">checked today</p>
        </div>
      </div>

      <div class="border-b border-line/70 px-4 py-2.5">
        <label class="relative block">
          <Icon
            name="search"
            size={13}
            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            bind:value={query}
            type="search"
            placeholder="Filter claims, entities, values…"
            class="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-2.5 text-[11px] text-ink outline-none placeholder:text-faint focus:border-ink/25"
          />
        </label>
      </div>

      <div class="flex-1 overflow-y-auto px-4 py-4">
        {#if groups.length === 0}
          <div class="flex h-full flex-col items-center justify-center px-6 text-center">
            <span
              class="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface text-faint"
            >
              <Icon name="layers" size={18} />
            </span>
            <p class="serif mt-3 text-[17px] text-ink">
              {claims.length === 0 ? 'Nothing stored yet' : 'No claims match that filter'}
            </p>
            <p class="mt-1 max-w-[18rem] text-[11px] leading-relaxed text-muted">
              {claims.length === 0
                ? 'Ask a fresh question. Since stores the dated, sourced claims it can verify.'
                : 'Try a vendor name, an attribute like “pricing”, or clear the filter.'}
            </p>
          </div>
        {:else}
          <div class="space-y-5">
            {#each groups as group (group.entity)}
              <section>
                <div class="mb-2 flex items-baseline justify-between gap-2">
                  <h3 class="serif text-[17px] font-medium leading-none text-ink">{group.entity}</h3>
                  <span class="font-mono text-[9px] text-faint">
                    {group.claims.length} {group.claims.length === 1 ? 'claim' : 'claims'}
                  </span>
                </div>
                <div class="space-y-1.5">
                  {#each group.claims as claim (claim.id)}
                    <article
                      class="rounded-lg border border-line/80 bg-surface/70 px-3 py-2.5"
                      class:opacity-60={claim.status === 'superseded'}
                    >
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span
                          class="rounded border border-line bg-paper px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.05em] text-muted"
                        >
                          {claim.attribute}
                        </span>
                        <span
                          class="rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.05em] {volatilityStyle[
                            claim.volatility
                          ]}"
                          title="{claim.volatility} volatility — re-check window {claim.volatility ===
                          'high'
                            ? '24 hours'
                            : claim.volatility === 'medium'
                              ? '7 days'
                              : '30 days'}"
                        >
                          {claim.volatility}
                        </span>
                        {#if claim.status === 'superseded'}
                          <span
                            class="rounded border border-line bg-paper px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.05em] text-faint"
                          >
                            superseded
                          </span>
                        {/if}
                      </div>

                      <p class="mt-1.5 text-[12px] leading-relaxed text-ink">
                        {truncate(claim.value, 240)}
                      </p>

                      <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-faint">
                        <span>As of {formatDate(claim.asOf)}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {claim.lastCheckedAt
                            ? `Checked ${formatRelative(claim.lastCheckedAt)}`
                            : 'Not re-checked yet'}
                        </span>
                        {#if claim.sourceUrl}
                          <span aria-hidden="true">·</span>
                          {#if isDemoUrl(claim.sourceUrl)}
                            <span class="inline-flex items-center gap-0.5 text-warning">
                              demo source
                            </span>
                          {:else}
                            <a
                              href={claim.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              class="inline-flex items-center gap-0.5 underline decoration-line underline-offset-2 hover:text-ink"
                            >
                              {host(claim.sourceUrl)}
                              <Icon name="external" size={8} />
                            </a>
                          {/if}
                        {/if}
                      </div>

                      {#if claim.quote}
                        <details class="group mt-1.5">
                          <summary
                            class="inline-flex cursor-pointer list-none items-center gap-1 text-[9px] font-medium text-faint transition-colors hover:text-muted [&::-webkit-details-marker]:hidden"
                          >
                            <Icon
                              name="chevronDown"
                              size={9}
                              class="transition-transform group-open:rotate-180"
                            />
                            Source quote
                          </summary>
                          <blockquote
                            class="mt-1 border-l border-accent/25 pl-2 text-[10px] italic leading-relaxed text-muted"
                          >
                            “{truncate(claim.quote, 260)}”
                          </blockquote>
                        </details>
                      {/if}
                    </article>
                  {/each}
                </div>
              </section>
            {/each}
          </div>
        {/if}
      </div>

      <div class="border-t border-line/80 bg-surface/50 px-4 py-3">
        <p class="flex items-start gap-1.5 text-[9.5px] leading-relaxed text-faint">
          <Icon name="check" size={11} class="mt-px shrink-0 text-positive" />
          <span>
            The ledger is append-only. A re-check adds evidence and, when a value changed, a new
            claim; the older claim is marked superseded, never rewritten.
          </span>
        </p>
      </div>
    </div>
  </div>
{/if}
