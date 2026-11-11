<script lang="ts">
  import Icon from './Icon.svelte';

  let {
    timezone,
    mode,
    disabled = false,
    streaming = false,
    onSend,
    onStop,
  }: {
    timezone: string;
    mode: 'live' | 'demo';
    disabled?: boolean;
    streaming?: boolean;
    onSend: (message: string) => void;
    onStop: () => void;
  } = $props();

  let draft = $state('');
  let textarea: HTMLTextAreaElement | undefined = $state();

  const MAX_LENGTH = 4000;

  function resize() {
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }

  function submit() {
    const value = draft.trim();
    if (!value || disabled) return;
    draft = '';
    if (textarea) {
      textarea.value = '';
      resize();
    }
    onSend(value);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit();
  }

  function handleInput() {
    resize();
  }
</script>

<div class="shrink-0 border-t border-line/80 bg-paper/92 backdrop-blur-xl">
  <div class="mx-auto max-w-column px-4 pb-3 pt-3 sm:px-5">
    <div
      class="rounded-2xl border border-line bg-raised shadow-[0_1px_0_rgb(255_255_255/0.4)_inset,0_12px_36px_-28px_rgb(40_30_18/0.55)] transition-colors focus-within:border-ink/25"
    >
      <textarea
        bind:this={textarea}
        bind:value={draft}
        oninput={handleInput}
        onkeydown={handleKeydown}
        rows="1"
        maxlength={MAX_LENGTH}
        disabled={disabled}
        placeholder={streaming
          ? 'Since is still working on this one…'
          : mode === 'demo'
            ? 'Ask about the CRM shortlist or Postgres — or what we discussed earlier…'
            : 'Ask anything — or what we discussed earlier…'}
        aria-label="Message Since"
        class="block max-h-[180px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[0.95rem] leading-relaxed text-ink outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-60"
      ></textarea>

      <div class="flex items-center gap-2 px-3 pb-2.5 pt-1.5">
        <span
          class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] {mode ===
          'demo'
            ? 'border-warning/25 bg-warning-soft text-warning'
            : 'border-positive/25 bg-positive-soft text-positive'}"
        >
          <span
            class="h-1 w-1 rounded-full {mode === 'demo' ? 'bg-warning' : 'bg-positive'}"
          ></span>
          {mode === 'demo' ? 'demo corpus' : 'live web'}
        </span>

        <span class="hidden text-[10px] text-faint sm:inline">
          Enter to send · Shift + Enter for a new line
        </span>

        <span class="flex-1"></span>

        {#if streaming}
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-muted transition-colors hover:border-accent/40 hover:text-accent"
            onclick={onStop}
            aria-label="Stop generating"
            title="Stop"
          >
            <Icon name="stop" size={13} />
          </button>
        {:else}
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-paper transition-all hover:bg-accent disabled:cursor-not-allowed disabled:bg-line disabled:text-faint"
            onclick={submit}
            disabled={disabled || draft.trim().length === 0}
            aria-label="Send message"
            title="Send"
          >
            <Icon name="arrowUp" size={16} stroke={2} />
          </button>
        {/if}
      </div>
    </div>

    <div class="mt-2 flex items-center justify-between gap-3 px-1 text-[10px] text-faint">
      <span>Dates resolve in {timezone}</span>
      <span class="hidden sm:inline">Since checks sources. It does not guess.</span>
    </div>
  </div>
</div>
