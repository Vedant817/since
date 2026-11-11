<script lang="ts">
  import type {
    ChatMeta,
    DiffRow,
    GroundingReport,
    RecallHit,
    Source,
    Turn,
  } from '../../shared/types.js';
  import {
    formatLatency,
    formatRelative,
    intentLabel,
    renderMarkdown,
  } from '../lib/markdown.js';
  import DiffTable from './DiffTable.svelte';
  import Icon from './Icon.svelte';
  import RecallCard from './RecallCard.svelte';
  import Sources from './Sources.svelte';
  import StatusTrail from './StatusTrail.svelte';

  interface PendingView {
    text: string;
    statuses: Array<{ step: string; detail?: string }>;
    sources: Source[];
    recall: RecallHit[];
    diff: DiffRow[];
    meta: ChatMeta | null;
    error?: string;
  }

  let {
    turn = null,
    pending = null,
    recall = [],
    timezone,
    mode,
  }: {
    turn?: Turn | null;
    pending?: PendingView | null;
    recall?: RecallHit[];
    timezone: string;
    mode: 'live' | 'demo';
  } = $props();

  let root: HTMLDivElement | undefined = $state();
  let activeSource = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  let turnKey = $derived(turn?.id ?? 'pending');
  let text = $derived(pending?.text ?? turn?.text ?? '');
  let isStreaming = $derived(Boolean(pending && !pending.error));
  let sources = $derived(pending?.sources ?? turn?.sources ?? []);
  let recallHits = $derived(pending?.recall ?? recall);
  let diff = $derived(
    pending?.diff ?? ((turn?.meta?.diff as DiffRow[] | undefined) ?? []),
  );
  let chatMeta = $derived(
    (pending?.meta ?? ((turn?.meta as unknown as ChatMeta | undefined) ?? null)) as ChatMeta | null,
  );
  let intent = $derived(turn?.intent ?? chatMeta?.intent);
  let resolutionNote = $derived(
    pending?.meta?.resolutionNote ??
      turn?.resolutionNote ??
      (turn?.meta?.resolutionNote as string | undefined),
  );
  let assumption = $derived(
    pending?.meta?.assumption ?? (turn?.meta?.assumption as string | undefined),
  );
  let note = $derived(pending?.meta?.note ?? (turn?.meta?.note as string | undefined));
  let report: GroundingReport | undefined = $derived(
    (pending?.meta?.grounding ?? (turn?.meta?.grounding as GroundingReport | undefined)) ??
      undefined,
  );
  let entities = $derived(chatMeta?.entities ?? []);
  let queries = $derived(chatMeta?.searchQueries ?? []);
  let claimsExtracted = $derived(
    chatMeta?.claimsExtracted ?? (turn?.meta?.claimsExtracted as number | undefined) ?? 0,
  );
  let latency = $derived(turn?.latencyMs);
  let showResolution = $derived(
    Boolean(
      resolutionNote &&
        !/^No (specific )?date range detected\.$/i.test(resolutionNote),
    ),
  );

  function highlightChip(sourceId: string) {
    if (!root) return;
    root
      .querySelectorAll('.citation-chip.is-active')
      .forEach((chip) => chip.classList.remove('is-active'));
    root
      .querySelectorAll(`[data-cite="${sourceId}"]`)
      .forEach((chip) => chip.classList.add('is-active'));
  }

  function jumpToSource(sourceId: string) {
    activeSource = sourceId;
    highlightChip(sourceId);
    const target = document.getElementById(`src-${turnKey}-${sourceId}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      activeSource = null;
    }, 2600);
  }

  function handleProseClick(event: MouseEvent) {
    const button = (event.target as HTMLElement).closest('[data-cite]') as HTMLElement | null;
    if (!button || !root?.contains(button)) return;
    const sourceId = button.dataset.cite;
    if (!sourceId) return;
    jumpToSource(sourceId);
  }

  $effect(() => {
    const node = root;
    if (!node) return;
    const handler = (event: MouseEvent) => handleProseClick(event);
    node.addEventListener('click', handler);
    return () => node.removeEventListener('click', handler);
  });
</script>

{#if turn?.role === 'user'}
  <div class="message-in flex justify-end">
    <div class="max-w-[86%]">
      <div class="mb-1 flex items-center justify-end gap-2 pr-1">
        <span class="mono-label text-faint">You</span>
        <span class="text-[10px] text-faint">{formatRelative(turn.createdAt)}</span>
      </div>
      <div
        class="whitespace-pre-wrap rounded-2xl rounded-tr-[4px] border border-line bg-raised px-4 py-3 text-[0.93rem] leading-relaxed text-ink shadow-sm"
      >
        {turn.text}
      </div>
    </div>
  </div>
{:else}
  <div class="message-in min-w-0" bind:this={root}>
    <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-ink text-paper shadow-sm"
      >
        <span class="serif -mt-px text-[14px] font-semibold leading-none">S</span>
      </span>
      <span class="serif text-[15px] font-medium leading-none text-ink">Since</span>
      {#if intent}
        <span
          class="rounded-full border border-line bg-surface px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.06em] text-muted"
        >
          {intentLabel(intent)}
        </span>
      {/if}
      <span class="flex-1"></span>
      {#if isStreaming}
        <span class="text-[10px] text-faint">working…</span>
      {:else}
        <span class="text-[10px] text-faint">
          {turn ? formatRelative(turn.createdAt) : 'now'}
        </span>
        {#if latency}
          <span class="font-mono text-[9px] text-faint/80">{formatLatency(latency)}</span>
        {/if}
      {/if}
    </div>

    {#if showResolution}
      <div
        class="mb-3 flex flex-wrap items-start gap-x-1.5 gap-y-0.5 pl-0.5 text-[10.5px] leading-relaxed text-muted"
      >
        <Icon name="clock" size={11} class="mt-0.5 shrink-0 text-faint" />
        <span>{resolutionNote}</span>
        {#if assumption}
          <span class="text-faint">· {assumption}</span>
        {/if}
      </div>
    {/if}

    {#if pending}
      <StatusTrail statuses={pending.statuses} active={!pending.error} />
    {/if}

    {#if note}
      <div
        class="mb-3 flex items-start gap-2 rounded-lg border border-warning/20 bg-warning-soft/50 px-3 py-2 text-[11px] leading-relaxed text-warning"
      >
        <Icon name="alert" size={13} class="mt-px shrink-0" />
        <span>{note}</span>
      </div>
    {/if}

    {#if pending?.error}
      <div
        class="mb-3 flex items-start gap-2 rounded-lg border border-accent/20 bg-accent-soft/50 px-3 py-2.5 text-[12px] leading-relaxed text-accent"
      >
        <Icon name="alert" size={14} class="mt-px shrink-0" />
        <span>{pending.error}</span>
      </div>
    {/if}

    {#if isStreaming && !text}
      <div class="space-y-2 py-1" aria-hidden="true">
        <div class="h-2.5 w-[68%] animate-pulse rounded-full bg-line/60"></div>
        <div class="h-2.5 w-[91%] animate-pulse rounded-full bg-line/45 [animation-delay:120ms]"></div>
        <div class="h-2.5 w-[54%] animate-pulse rounded-full bg-line/35 [animation-delay:240ms]"></div>
      </div>
    {:else}
      <div
        class="prose {isStreaming ? 'prose-streaming' : ''}"
        role="region"
        aria-label="Answer"
      >
        {@html renderMarkdown(text, sources)}
      </div>
    {/if}

    {#if recallHits.length > 0}
      <RecallCard hits={recallHits} {timezone} />
    {/if}

    {#if diff.length > 0}
      <DiffTable rows={diff} {sources} onCite={jumpToSource} />
    {/if}

    {#if isStreaming && pending?.sources.length}
      <div class="mt-3 text-[10px] text-faint">
        {pending.sources.length} sources retrieved. Writing is grounded to their text.
      </div>
    {/if}

    {#if !isStreaming}
      <Sources sources={sources} turnId={turnKey} activeId={activeSource} />
    {/if}

    {#if report && report.total > 0}
      <div
        class="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-[10.5px] leading-relaxed {report.rejected ===
        0
          ? 'border-positive/20 bg-positive-soft/45 text-positive'
          : 'border-warning/25 bg-warning-soft/45 text-warning'}"
      >
        <Icon name={report.rejected > 0 ? 'alert' : 'check'} size={13} class="shrink-0" />
        {#if report.rejected === 0}
          <span>
            Grounding gate passed — {report.verified} of {report.total} cited
            {report.total === 1 ? 'sentence' : 'sentences'} matched an exact quote in the cited source.
          </span>
        {:else}
          <span>
            {report.verified} of {report.total} cited sentences passed; {report.rejected}
            {report.rejected === 1 ? 'was' : 'were'} rejected and removed by the grounding gate.
          </span>
        {/if}
      </div>
    {/if}

    {#if !isStreaming && claimsExtracted > 0}
      <div class="mt-2 flex items-center gap-1.5 text-[10px] text-faint">
        <Icon name="database" size={11} />
        <span>
          {claimsExtracted} {claimsExtracted === 1 ? 'claim' : 'claims'} added to memory
        </span>
      </div>
    {/if}

    {#if !isStreaming && (entities.length > 0 || queries.length > 0 || report || mode === 'demo')}
      <details class="group mt-3">
        <summary
          class="inline-flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-medium text-faint transition-colors hover:text-muted [&::-webkit-details-marker]:hidden"
        >
          <Icon name="filter" size={11} />
          Answer details
          <Icon name="chevronDown" size={11} class="transition-transform group-open:rotate-180" />
        </summary>
        <div
          class="mt-2 grid gap-2 rounded-lg border border-line/70 bg-surface/50 px-3 py-2.5 text-[10px] leading-relaxed text-muted sm:grid-cols-2"
        >
          <div>
            <span class="mono-label text-faint">Mode</span>
            <p class="mt-0.5">
              {mode === 'demo'
                ? 'Demo — built-in corpus, no live search'
                : `Live — ${chatMeta?.model ?? 'configured model'}`}
            </p>
          </div>
          {#if entities.length > 0}
            <div>
              <span class="mono-label text-faint">Entities</span>
              <p class="mt-0.5">{entities.join(' · ')}</p>
            </div>
          {/if}
          {#if queries.length > 0}
            <div class="sm:col-span-2">
              <span class="mono-label text-faint">Search queries</span>
              <p class="mt-0.5 font-mono text-[9.5px] leading-relaxed">{queries.join(' · ')}</p>
            </div>
          {/if}
          {#if report}
            <div>
              <span class="mono-label text-faint">Citation gate</span>
              <p class="mt-0.5">
                {report.verified}/{report.total} passed · {report.rejected} rejected
              </p>
            </div>
          {/if}
          {#if latency}
            <div>
              <span class="mono-label text-faint">Turn latency</span>
              <p class="mt-0.5">{formatLatency(latency)}</p>
            </div>
          {/if}
        </div>
      </details>
    {/if}
  </div>
{/if}
