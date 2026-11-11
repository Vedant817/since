<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type {
    ChatMeta,
    Claim,
    Conversation,
    DiffRow,
    RecallHit,
    Source,
    StreamEvent,
    Turn,
  } from '../shared/types.js';
  import {
    browserTimezone,
    createConversation,
    getConversation,
    getHealth,
    mergeClaims,
    seedDemo,
    streamChat,
    type Health,
  } from '../client/lib/api.js';
  import Composer from './components/Composer.svelte';
  import DemoBanner from './components/DemoBanner.svelte';
  import EmptyState from './components/EmptyState.svelte';
  import Header from './components/Header.svelte';
  import Icon from './components/Icon.svelte';
  import MemoryDrawer from './components/MemoryDrawer.svelte';
  import Message from './components/Message.svelte';

  interface PendingState {
    text: string;
    statuses: Array<{ step: string; detail?: string }>;
    sources: Source[];
    recall: RecallHit[];
    diff: DiffRow[];
    meta: ChatMeta | null;
    error?: string;
  }

  const STORAGE_KEY = 'since-conversation-id';
  const timezone = browserTimezone();

  const demoPrompts = [
    { label: '3 Nov recall', query: 'What did I ask you on 3 November?' },
    {
      label: 'Is it still true?',
      query: 'What did I ask on 3 November, and is it still true?',
    },
    { label: 'Pipedrive since Monday', query: 'What changed at Pipedrive since Monday?' },
  ];

  let health = $state<Health | null>(null);
  let healthError = $state<string | null>(null);
  let booting = $state(true);
  let bootError = $state<string | null>(null);
  let pageError = $state<string | null>(null);
  let conversation = $state<Conversation | null>(null);
  let turns = $state<Turn[]>([]);
  let claims = $state<Claim[]>([]);
  let streaming = $state<PendingState | null>(null);
  let recallByTurn = $state<Record<string, RecallHit[]>>({});
  let memoryOpen = $state(false);
  let demoLoading = $state(false);
  let demoNotice = $state(false);
  let theme = $state<'light' | 'dark'>('light');
  let scrollEl: HTMLElement | undefined = $state();

  let controller: AbortController | null = null;
  let abortRequested = false;
  let stickToBottom = $state(true);

  let mode = $derived(health?.mode ?? 'demo');
  let claimsCount = $derived(claims.filter((claim) => claim.status === 'active').length);
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
  let hasTurns = $derived(turns.length > 0 || streaming !== null);

  function getStored(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function setStored(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Storage can be disabled; the session still works without persistence.
    }
  }

  function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return 'Something went wrong. Check the server log and try again.';
  }

  async function loadConversation(id: string) {
    const payload = await getConversation(id);
    conversation = payload.conversation;
    turns = payload.turns;
    claims = payload.claims;
    recallByTurn = {};
    setStored(STORAGE_KEY, payload.conversation.id);
  }

  async function seedDemoConversation() {
    demoLoading = true;
    try {
      const result = await seedDemo(timezone);
      await loadConversation(result.conversationId);
      demoNotice = true;
      bootError = null;
    } finally {
      demoLoading = false;
    }
  }

  async function startBlank() {
    if (streaming) stop();
    const result = await createConversation(timezone);
    conversation = result.conversation;
    turns = [];
    claims = [];
    recallByTurn = {};
    streaming = null;
    demoNotice = false;
    setStored(STORAGE_KEY, result.conversation.id);
    await tick();
    scrollEl?.scrollTo({ top: 0 });
  }

  async function bootstrap() {
    booting = true;
    healthError = null;
    bootError = null;
    pageError = null;
    try {
      health = await getHealth();
    } catch (error) {
      healthError = errorMessage(error);
      booting = false;
      return;
    }

    try {
      const saved = getStored(STORAGE_KEY);
      let restored = false;
      if (saved) {
        try {
          await loadConversation(saved);
          restored = true;
        } catch {
          setStored(STORAGE_KEY, null);
        }
      }
      if (!restored) {
        if (health.mode === 'demo') await seedDemoConversation();
        else await startBlank();
      }
    } catch (error) {
      bootError = errorMessage(error);
    } finally {
      booting = false;
      await tick();
      scrollToBottom(true);
    }
  }

  function recallForTurn(turn: Turn): RecallHit[] {
    const cached = recallByTurn[turn.id];
    if (cached && cached.length > 0) return cached;
    const ids = turn.meta?.recallUserTurnIds;
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const ordered = [...turns].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const hits: RecallHit[] = [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const userTurn = ordered.find((candidate) => candidate.id === id && candidate.role === 'user');
      if (!userTurn) continue;
      const answerTurn = ordered.find(
        (candidate) =>
          candidate.role === 'assistant' &&
          candidate.createdAt >= userTurn.createdAt,
      );
      hits.push({ userTurn, answerTurn });
    }
    return hits;
  }

  function handleEvent(event: StreamEvent) {
    const state = streaming;
    if (!state) return;
    switch (event.type) {
      case 'status': {
        const step = String(event.step ?? '');
        if (!step) break;
        const detail =
          typeof event.detail === 'string' && event.detail.length > 0 ? event.detail : undefined;
        const last = state.statuses[state.statuses.length - 1];
        if (last?.step === step) {
          state.statuses = [...state.statuses.slice(0, -1), { step, detail }];
        } else if (last?.step !== step) {
          state.statuses = [...state.statuses, { step, detail }];
        }
        break;
      }
      case 'meta':
        state.meta = event as unknown as ChatMeta;
        break;
      case 'recall':
        if (Array.isArray(event.hits)) state.recall = event.hits as RecallHit[];
        break;
      case 'sources':
        if (Array.isArray(event.sources)) state.sources = event.sources as Source[];
        break;
      case 'diff':
        if (Array.isArray(event.rows)) state.diff = event.rows as DiffRow[];
        break;
      case 'draft': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (event.replace) state.text = delta;
        else state.text += delta;
        break;
      }
      case 'answer': {
        const incomingTurn = event.turn as Turn | undefined;
        const incomingClaims = Array.isArray(event.claims) ? (event.claims as Claim[]) : [];
        if (incomingTurn) {
          turns = [...turns.filter((turn) => turn.id !== incomingTurn.id), incomingTurn];
          if (state.recall.length > 0) recallByTurn[incomingTurn.id] = state.recall;
        }
        claims = mergeClaims(claims, incomingClaims);
        streaming = null;
        break;
      }
      case 'error':
        state.error =
          typeof event.message === 'string' && event.message.length > 0
            ? event.message
            : 'The answer stream failed.';
        break;
      case 'done':
        if (streaming && !streaming.error) streaming = null;
        break;
    }
  }

  async function send(message: string) {
    if (!conversation) return;
    if (streaming) return;
    pageError = null;

    const optimistic: Turn = {
      id: `pending-${crypto.randomUUID()}`,
      conversationId: conversation.id,
      role: 'user',
      text: message,
      createdAt: new Date().toISOString(),
      sources: [],
      citations: [],
      meta: { pending: true },
    };
    turns = [...turns, optimistic];
    streaming = {
      text: '',
      statuses: [],
      sources: [],
      recall: [],
      diff: [],
      meta: null,
    };
    abortRequested = false;
    controller = new AbortController();
    stickToBottom = true;
    requestAnimationFrame(() => scrollToBottom(true));

    try {
      await streamChat({
        conversationId: conversation.id,
        message,
        timezone,
        signal: controller.signal,
        onEvent: handleEvent,
      });
    } catch (error) {
      if (!abortRequested) {
        const text = errorMessage(error);
        if (streaming) streaming.error = text;
        else pageError = text;
      }
    } finally {
      controller = null;
      abortRequested = false;
    }
  }

  function stop() {
    abortRequested = true;
    controller?.abort();
    controller = null;
    streaming = null;
  }

  async function useSuggestion(prompt: string) {
    if (booting || streaming) return;
    try {
      if (!conversation) {
        if (health?.mode === 'demo') await seedDemoConversation();
        else await startBlank();
      } else if (health?.mode === 'demo' && turns.length === 0) {
        await seedDemoConversation();
      }
      await send(prompt);
    } catch (error) {
      pageError = errorMessage(error);
    }
  }

  async function loadDemo() {
    if (streaming) stop();
    try {
      await seedDemoConversation();
      await tick();
      scrollToBottom(true);
    } catch (error) {
      pageError = errorMessage(error);
    }
  }

  async function newChat() {
    try {
      await startBlank();
    } catch (error) {
      pageError = errorMessage(error);
    }
  }

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    setStored('since-theme', theme);
  }

  function jumpToBottom() {
    scrollToBottom(true);
  }

  function scrollToBottom(force = false) {
    if (!scrollEl) return;
    if (!force && !stickToBottom) return;
    scrollEl.scrollTo({
      top: scrollEl.scrollHeight,
      behavior: streaming ? 'auto' : 'smooth',
    });
  }

  function handleScroll() {
    if (!scrollEl) return;
    stickToBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 140;
  }

  $effect(() => {
    const draftLength = streaming?.text.length ?? 0;
    const statusCount = streaming?.statuses.length ?? 0;
    const sourceCount = streaming?.sources.length ?? 0;
    const turnCount = turns.length;
    if (draftLength + statusCount + sourceCount + turnCount === 0) return;
    if (memoryOpen) return;
    void tick().then(() => scrollToBottom());
  });

  onMount(() => {
    theme =
      document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    void bootstrap();
    return () => {
      controller?.abort();
    };
  });
</script>

<svelte:head>
  <title>Since — memory that checks itself</title>
</svelte:head>

<div class="flex h-[100dvh] flex-col overflow-hidden bg-paper">
  <Header
    {health}
    {claimsCount}
    {checkedToday}
    {theme}
    {hasTurns}
    onToggleTheme={toggleTheme}
    onToggleMemory={() => (memoryOpen = true)}
    onNewChat={newChat}
  />

  {#if health?.mode === 'demo' && !healthError}
    <DemoBanner
      mode={health.mode}
      missingKeys={health.missingKeys}
      prompts={demoPrompts}
      onPrompt={useSuggestion}
    />
  {/if}

  {#if pageError}
    <div class="shrink-0 border-b border-accent/20 bg-accent-soft/60">
      <div class="mx-auto flex max-w-column items-start gap-2 px-4 py-2 text-[11px] text-accent sm:px-5">
        <Icon name="alert" size={13} class="mt-px shrink-0" />
        <span class="flex-1">{pageError}</span>
        <button
          type="button"
          class="text-accent/70 transition-colors hover:text-accent"
          onclick={() => (pageError = null)}
          aria-label="Dismiss error"
        >
          <Icon name="x" size={13} />
        </button>
      </div>
    </div>
  {/if}

  <main
    class="relative flex-1 overflow-y-auto overscroll-contain"
    bind:this={scrollEl}
    onscroll={handleScroll}
  >
    <div class="mx-auto flex min-h-full max-w-column flex-col px-4 sm:px-5">
      {#if booting}
        <div class="flex flex-1 flex-col items-center justify-center gap-3 py-20">
          <span
            class="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface shadow-sm"
          >
            <span class="serif text-[20px] font-semibold text-ink">S</span>
          </span>
          <span class="status-dot"></span>
          <p class="text-[11px] text-muted">Opening your memory…</p>
        </div>
      {:else if healthError}
        <div class="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <span
            class="flex h-11 w-11 items-center justify-center rounded-full border border-warning/25 bg-warning-soft text-warning"
          >
            <Icon name="alert" size={19} />
          </span>
          <h2 class="serif mt-3 text-[22px] text-ink">The server is not answering</h2>
          <p class="mt-1.5 max-w-[24rem] text-[12px] leading-relaxed text-muted">
            {healthError}
          </p>
          <p class="mt-1 max-w-[24rem] text-[11px] leading-relaxed text-faint">
            Start it with <code class="font-mono">npm run dev</code> and make sure port 8787 is free.
          </p>
          <button
            type="button"
            class="mt-4 rounded-lg border border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-ink transition-colors hover:border-ink/25"
            onclick={bootstrap}
          >
            Try again
          </button>
        </div>
      {:else if bootError && !conversation}
        <div class="flex flex-1 flex-col items-center justify-center py-20 text-center">
          <span
            class="flex h-11 w-11 items-center justify-center rounded-full border border-accent/20 bg-accent-soft text-accent"
          >
            <Icon name="alert" size={19} />
          </span>
          <h2 class="serif mt-3 text-[22px] text-ink">Could not open a conversation</h2>
          <p class="mt-1.5 max-w-[26rem] text-[12px] leading-relaxed text-muted">{bootError}</p>
          <button
            type="button"
            class="mt-4 rounded-lg border border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-ink transition-colors hover:border-ink/25"
            onclick={bootstrap}
          >
            Retry
          </button>
        </div>
      {:else if demoLoading && !conversation}
        <div class="flex flex-1 flex-col items-center justify-center gap-3 py-20">
          <span class="status-dot"></span>
          <p class="text-[11px] text-muted">Seeding the sample conversation…</p>
        </div>
      {:else if turns.length === 0 && !streaming}
        <EmptyState
          mode={mode}
          loadingDemo={demoLoading}
          onPrompt={useSuggestion}
          onLoadDemo={loadDemo}
        />
      {:else}
        {#if demoNotice}
          <div
            class="mt-5 flex flex-wrap items-start gap-2 rounded-xl border border-warning/20 bg-warning-soft/45 px-3.5 py-2.5 sm:flex-nowrap"
          >
            <Icon name="spark" size={14} class="mt-0.5 shrink-0 text-warning" />
            <p class="min-w-0 flex-1 text-[10.5px] leading-relaxed text-muted">
              <span class="font-medium text-warning">Sample history loaded.</span>
              Three earlier conversations were seeded so you can test recall. This is not your
              data, and no live search ran.
            </p>
            <div class="flex shrink-0 items-center gap-2">
              <button
                type="button"
                class="text-[10px] font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
                onclick={newChat}
              >
                Start blank
              </button>
              <button
                type="button"
                class="text-faint transition-colors hover:text-muted"
                onclick={() => (demoNotice = false)}
                aria-label="Dismiss sample history note"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          </div>
        {/if}

        <div class="flex-1 space-y-9 pb-10 pt-6">
          {#each turns as turn (turn.id)}
            <Message
              {turn}
              {timezone}
              mode={mode}
              recall={turn.role === 'assistant' ? recallForTurn(turn) : []}
            />
          {/each}

          {#if streaming}
            <Message pending={streaming} {timezone} mode={mode} />
          {/if}
        </div>
      {/if}
    </div>

    {#if hasTurns}
      <button
        type="button"
        class="sticky bottom-3 left-1/2 z-10 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-raised/95 text-muted shadow-md backdrop-blur transition-colors hover:text-ink"
        class:opacity-0={stickToBottom}
        class:pointer-events-none={stickToBottom}
        onclick={jumpToBottom}
        aria-label="Scroll to the latest message"
        title="Jump to latest"
      >
        <Icon name="chevronDown" size={14} />
      </button>
    {/if}
  </main>

  {#if health && !healthError}
    <Composer
      {timezone}
      mode={health.mode}
      disabled={booting || !conversation}
      streaming={streaming !== null}
      onSend={send}
      onStop={stop}
    />
  {/if}

  <MemoryDrawer
    open={memoryOpen}
    {claims}
    {timezone}
    onClose={() => (memoryOpen = false)}
  />
</div>
