<script lang="ts">
  import type { Health } from '../lib/api.js';
  import Icon from './Icon.svelte';

  let {
    health,
    claimsCount,
    checkedToday,
    theme,
    hasTurns,
    onToggleTheme,
    onToggleMemory,
    onNewChat,
  }: {
    health: Health | null;
    claimsCount: number;
    checkedToday: number;
    theme: 'light' | 'dark';
    hasTurns: boolean;
    onToggleTheme: () => void;
    onToggleMemory: () => void;
    onNewChat: () => void;
  } = $props();
</script>

<header class="sticky top-0 z-20 border-b border-line/80 bg-paper/88 backdrop-blur-xl">
  <div class="mx-auto flex h-[66px] max-w-column items-center gap-3 px-5">
    <a href="/" class="group flex min-w-0 items-center gap-2.5" aria-label="Since home">
      <span
        class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-ink text-paper shadow-sm"
      >
        <span class="serif -mt-px text-[19px] font-semibold leading-none">S</span>
        <span class="absolute right-[5px] top-[5px] h-1 w-1 rounded-full bg-accent"></span>
      </span>
      <span class="min-w-0">
        <span class="serif block text-[22px] font-medium leading-none tracking-[-0.02em]">Since</span>
        <span class="mono-label hidden text-faint sm:block">Memory that checks itself</span>
      </span>
    </a>

    <span class="flex-1"></span>

    {#if health?.mode === 'demo'}
      <span
        class="hidden items-center gap-1.5 rounded-full border border-warning/25 bg-warning-soft px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-warning sm:inline-flex"
        title={`Live mode needs ${health.missingKeys.join(' and ')}. Answers use a small demo corpus.`}
      >
        <span class="h-1.5 w-1.5 rounded-full bg-warning"></span>
        Demo
      </span>
    {:else if health?.mode === 'live'}
      <span
        class="hidden items-center gap-1.5 rounded-full border border-positive/25 bg-positive-soft px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-positive sm:inline-flex"
        title={`Live search via ${health.searchProvider}; model ${health.models?.smart ?? 'configured'}.`}
      >
        <span class="h-1.5 w-1.5 rounded-full bg-positive"></span>
        Live
      </span>
    {/if}

    <button
      type="button"
      class="btn-ghost relative h-9 gap-1.5 px-2.5 text-[11px]"
      onclick={onToggleMemory}
      aria-label="Open stored claims"
      title="Stored claims"
    >
      <Icon name="layers" size={16} />
      <span class="hidden font-medium tabular-nums sm:inline">{claimsCount}</span>
      {#if checkedToday > 0}
        <span
          class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-positive ring-2 ring-paper"
          title={`${checkedToday} claims checked today`}
        ></span>
      {/if}
    </button>

    <button
      type="button"
      class="btn-ghost h-9 w-9"
      onclick={onToggleTheme}
      aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
      title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
    </button>

    {#if hasTurns}
      <button
        type="button"
        class="btn-ghost h-9 gap-1.5 px-2.5 text-[11px]"
        onclick={onNewChat}
        title="Start a new, empty conversation"
      >
        <Icon name="plus" size={16} />
        <span class="hidden font-medium sm:inline">New</span>
      </button>
    {/if}
  </div>
</header>
