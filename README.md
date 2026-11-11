<img src="assets/icon.svg" width="64" height="64" alt="Since icon">

# Since

**I remember what I told you — and I check if it's still true.**

Since is a chat agent with temporal memory. It does not treat chat history as a pile of text to
re-read. It resolves the date you mean, recalls the conversation that happened inside that civil
day, extracts dated claims from what it told you, and re-checks those claims against current
sources. When something changed, it shows you the old value, the new value, the date, and an exact
quote from the source.

The interface is one quiet column: chat, inline citation chips, a recall card, a diff table, and a
read-only memory drawer. It is deliberately a single-user local app.

---

## Run it

Requires **Node 22+**.

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. The API runs on **http://localhost:8787** and Vite proxies `/api`.

No API keys are required to start. The first load in demo mode seeds a sample history and labels
it clearly. Use **Start blank** to begin with an empty ledger.

### Demo mode vs live mode

| | Demo mode | Live mode |
| --- | --- | --- |
| Trigger | An LLM key or a search key is missing | One LLM key **and** one search key are present |
| Search | Built-in CRM/Postgres corpus, no network | Tavily or Brave Search (real web search) |
| Writing | Deterministic templates | Streamed OpenAI-compatible model |
| Labels | Every source says **demo**; banner and composer say demo | No demo labels |
| Purpose | Exercise recall, re-verification, grounding, and the ledger without secrets | Real research and current claims |

#### Free alternatives for live mode (no OpenAI key required)

`OPENAI_API_KEY` works, but you can also run live mode with free-tier providers:

| Purpose | Option | Env var | Notes |
| --- | --- | --- | --- |
| LLM (recommended free) | [Groq](https://console.groq.com/keys) | `GROQ_API_KEY` | OpenAI-compatible, fast free tier. Defaults: `llama-3.1-8b-instant` (fast) / `llama-3.3-70b-versatile` (smart). |
| LLM | [OpenRouter](https://openrouter.ai/keys) | `OPENROUTER_API_KEY` | Free `:free` models available (rate-limited); models/availability may vary. |
| LLM | [Google AI Studio](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` | Gemini via OpenAI-compatible endpoint (free tier, subject to quotas). |
| LLM | OpenAI | `OPENAI_API_KEY` | Paid; defaults `gpt-4.1-mini` / `gpt-4.1`. |
| Search (best content) | [Tavily](https://tavily.com) | `TAVILY_API_KEY` | Returns extracted page content (best for grounding). Free tier available. |
| Search (alternative) | [Brave Search API](https://brave.com/search/api/) | `BRAVE_SEARCH_API_KEY` | Free tier available; uses result descriptions/snippets as content. |

Set one LLM key and one search key in `.env` (see [`.env.example`](.env.example)), then restart `npm run dev`. You can override base URL/models with `OPENAI_BASE_URL`, `MODEL_FAST`, `MODEL_SMART`.

**This repository was built and verified in this environment without live credentials.** The live path (including these provider integrations) is implemented but has not been executed here. Deterministic tests, replay evals, and demo-mode UI checks are the verified evidence. See [Evaluation](#evaluation). Free-tier availability, quotas, and model names are provider-controlled and may change.

### Try these prompts

With the sample history loaded:

1. `What did I ask you on 3 November?`
2. `What did I ask on 3 November, and is it still true?`
3. `What changed at Pipedrive since Monday?`
4. `Has HubSpot changed its price since Monday?`

For a blank conversation in demo mode:

5. `Compare HubSpot, Salesforce, Pipedrive, Zoho CRM, and Close pricing.`
6. `Compare Neon, Supabase, and Amazon RDS pricing.`

The sample dates are relative to the day you open the app: the most recent **3 November**, the most
recent **Monday**, and the most recent prior **Tuesday**. The ledger stores claims from those
conversations, so the re-check prompts have something concrete to compare.

---

## What it does

- **Resolves civil dates, not strings.** “3 November” in `Asia/Kolkata` means
  `2026-11-02T18:30Z` through `2026-11-03T18:30Z`, not the server's local day. “Since Monday” is a
  half-open range from Monday 00:00 through now.
- **Recalls the conversation in that range.** SQLite FTS5 finds matching turns when no date is
  given; date ranges use the turn timestamps directly. Pure recall never searches the web.
- **Stores atomic claims.** A claim is `entity + attribute + value + as-of + source URL + exact
  quote + volatility`.
- **Re-checks against today.** Each stored claim is compared with current evidence and gets one of
  `changed`, `unchanged`, or `unclear`. A changed claim creates a new claim and marks the old one
  superseded; an unchanged check only updates the check date.
- **Gates every citation.** A sentence with `[S1]` survives only if the cited source contains the
  exact quoted text after normalization. The gate reports what it rejected.
- **Refuses to guess.** Vague dates produce one clarifying question. Missing evidence produces an
  explicit “unclear” or “I could not ground a claim,” never a fabricated value.
- **Keeps prompt injection in the data layer.** Source and user text are delimited and sanitized;
  injected instructions cannot become answer sentences or citations.

---

## How a turn flows

```text
Browser (Svelte 5)
   │  POST /api/chat, SSE
   ▼
Hono server
   │
   ├─ route          fresh | recall | reverify | recall_reverify | clarify
   ├─ resolve date   chrono + IANA timezone + civil-day boundaries
   ├─ recall         SQLite turns, FTS5, range claims
   ├─ search         web_search only: Tavily or Brave in live mode (skipped for recall)
   ├─ compare        stored claims ↔ today's sources
   ├─ write          streamed model answer, or deterministic demo answer
   ├─ ground         exact-quote citation gate, drop unsupported sentences
   ├─ remember       extract claims, append to SQLite
   └─ emit           status → meta → recall → sources → diff → draft → answer → done
```

The browser only receives user-facing status steps. There is no chain-of-thought stream.

---

## Temporal memory

### Resolution rules

- Phrases are parsed against **noon on the user's civil date**, then their components are
  re-interpreted in the user's IANA timezone. This avoids the classic bug where the server's
  timezone silently shifts “3 November.”
- A date-only phrase resolves to a **half-open civil day**, `[start, next day's start)`. A range
  ending after now is capped at now.
- `since X` resolves to `[X, now]`. `last week` is the previous Monday-to-Monday civil week.
- Relative phrases use the most recent past occurrence unless the phrase says “next”.
- Dates outside a **±2-year window** are clamped, and the answer says so.
- Vague phrases such as “the other day” are marked ambiguous and produce exactly one clarifying
  question.

### DST is a first-class case

Timezone conversion goes through `Intl.DateTimeFormat` and civil-day arithmetic, not fixed
millisecond offsets. A New York day around the end of DST is 25 hours long:

```text
What did I ask yesterday?   now = 2026-11-02T17:00Z   America/New_York
→ 2026-11-01T04:00Z .. 2026-11-02T05:00Z   (25 hours)
```

The temporal suite covers 39 cases including DST boundaries, month/year windows, time-specific
phrases, and the ±2-year clamp.

---

## Grounding gate

For a live draft, the fast model is asked to return the shortest verbatim quote supporting each
sentence/source pair. The server then performs its own exact substring check after normalization
(case, Unicode, smart quotes, punctuation, whitespace, HTML). A sentence is kept only if at least
one cited source passes. Unsupported citations are removed from surviving sentences; if no
citation survives, the draft is replaced with a deterministic source digest.

`evals/results/replay.json` records the gate's counts per scenario. In the committed replay, all 12
citations across all scenarios are verified and 0 are rejected. That is a property of the recorded
inputs, not a claim that the gate can never reject text.

---

## Claim ledger

SQLite in WAL mode, five tables:

| Table | Purpose |
| --- | --- |
| `conversations` | timezone, title, created time |
| `turns` | user/assistant text, resolution range, sources, citations, intent, meta |
| `claims` | atomic dated claims, source URL, exact quote, volatility, status |
| `claim_checks` | every re-check: verdict, new value, quote, confidence, timestamp |
| `search_cache` | normalized query → results, with a TTL |

Volatility determines how long a claim is considered fresh for prioritization:

| Volatility | TTL | Examples |
| --- | --- | --- |
| high | 24 hours | pricing, availability, versions, leadership |
| medium | 7 days | features, limits, docs, support |
| low | 30 days | definitions, history |

When a re-check has no explicit date range, claims past their TTL are checked first. The memory
drawer shows the volatility window, as-of date, last-checked date, source, and exact quote. The
ledger is append-only: no original claim text is rewritten.

Search results are cached for **6 hours** for high-volatility queries and **24 hours** otherwise.

---

## Only one external tool

`web_search` is the agent's only external tool. In live mode it is backed by **Tavily** (returns
extracted page content in the same response, best for grounding) or **Brave Search** (free-tier
alternative using descriptions/snippets). There is no second fetch, browser tool, or scraping path.
The planner issues one query per entity by default (maximum 8), runs at most 4 in parallel, and
prefers recent results within the resolved range. In demo mode the same interface is backed by a
small deterministic corpus.

The codebase does not include LangChain, LangGraph, an external database, a queue, a vector store,
MCP, uploads, voice, auth, or multi-user workspaces.

---

## Evaluation

```bash
npm test                  # 62 unit/integration tests, no keys, no network
npm run eval              # replay the committed search fixture (default)
npm run eval:record       # record search transcripts into evals/fixtures/search.json
npm run eval:live         # full live run; requires both API keys
```

### What the eval modes actually do

- **`replay` (default):** loads `evals/fixtures/search.json`, replays the recorded search calls in
  order, runs the real agent, and asserts behavior. The model is disabled, so synthesis is
  deterministic. No network. Running it twice produces byte-identical JSON.
- **`record`:** runs the scenarios with the current runtime, captures each `web_search` call and
  its results, and writes the fixture. With no keys it records the demo corpus; with
  `TAVILY_API_KEY` it records live search. Synthesis stays deterministic so the fixture can be
  replayed without a model.
- **`live`:** requires `OPENAI_API_KEY` and `TAVILY_API_KEY`, runs the full live agent, and writes
  `evals/results/live.json`. It includes wall-clock and live-source variability, so it is not
  deterministic.

### Committed replay result

`evals/results/replay.json` was produced by `npm run eval` with the fixed clock
`2026-11-11T04:30:00.000Z`:

| Metric | Result |
| --- | --- |
| Scenarios | **8 / 8 passed** |
| Intent routing | **8 / 8** |
| Recall expectation (hits, including the intentional empty DST recall) | **3 / 3** |
| Scenarios expecting citations with full grounded coverage | **4 / 4** |
| Grounding gate | **12 verified, 0 rejected** |
| Re-verification checks | **5** (2 changed, 2 unchanged, 1 unclear) |
| New claims stored | **10** |
| Search queries replayed | **7** |

Scenarios:

| ID | What it proves |
| --- | --- |
| `crm` | Fresh multi-entity answer, citations, claims stored, demo labels |
| `recall-3-nov` | Exact 3 November IST boundaries, two recalled questions, no web search |
| `postgres` | Managed Postgres comparison with grounded citations and claims |
| `no-change` | HubSpot price re-check stays unchanged; no invented change |
| `ambiguity` | “The other day” asks exactly one date question and invents no range |
| `injection` | Injected source instructions never reach the answer or citations |
| `dst-boundary` | New York 1 November resolves to a 25-hour day and recalls nothing |
| `recall-reverify-3-nov` | Recall plus four claim checks: 2 changed, 1 unchanged, 1 unclear |

### Honest limits of this evidence

- There are **no live API keys** in the build environment. `npm run eval:live` has not been run,
  and the live model-written path is unverified. Do not read the replay numbers as live-model
  accuracy.
- The replay exercises the real routing, temporal, search-ranking, claim, grounding, and SQLite
  code. The recorded search payloads come from the demo corpus.
- Metrics are scenario assertions, not a benchmark. Eight scenarios are enough to catch the
  specific failure modes this project cares about; they are not a broad quality measurement.

---

## Configuration

Copy `.env.example` to `.env` and fill in what you need.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | API/server port |
| `DATABASE_PATH` | `./data/since.db` | SQLite file; use `:memory:` for ephemeral runs |
| `USER_TZ` | `UTC` | Fallback timezone for API clients |
| `OPENAI_API_KEY` | — | OpenAI LLM key (paid) |
| `GROQ_API_KEY` | — | Groq LLM key (free tier, OpenAI-compatible) |
| `OPENROUTER_API_KEY` | — | OpenRouter LLM key (free `:free` models available) |
| `GEMINI_API_KEY` | — | Google AI Studio key via OpenAI-compatible endpoint |
| `OPENAI_BASE_URL` | provider default | Override for any OpenAI-compatible `/chat/completions` endpoint |
| `MODEL_FAST` | provider default | Routing, citation verification, claim extraction/comparison |
| `MODEL_SMART` | provider default | Streamed fresh-answer synthesis |
| `TAVILY_API_KEY` | — | Tavily web search (extracted content) |
| `BRAVE_SEARCH_API_KEY` | — | Brave Search API (descriptions/snippets) |

Live mode is selected when **one LLM key and one search key** are present. Provider presets set
sensible default base URLs and models (e.g. Groq → `llama-3.1-8b-instant` / `llama-3.3-70b-versatile`).
Otherwise the app stays in clearly labeled demo mode. See [`.env.example`](.env.example).

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Mode, missing keys, search provider, models, server time |
| `POST` | `/api/conversations` | Create a conversation |
| `GET` | `/api/conversations/:id` | Conversation, turns, and claims |
| `GET` | `/api/claims?conversationId=...` | Claims for one conversation |
| `POST` | `/api/demo/seed` | Seed the sample history |
| `POST` | `/api/chat` | SSE stream of `status`, `meta`, `recall`, `sources`, `diff`, `draft`, `answer`, `done`, `error` |

---

## Project layout

```text
src/
  server/
    agent/        router, temporal resolver, claims, grounding, synthesis, loop
    llm/          OpenAI-compatible client (JSON + streaming)
    memory/       SQLite schema, turns, claim store, demo seed
    search/       Tavily client, cache/search service, demo corpus
    routes/       Hono API + SSE
    config.ts     environment and demo/live selection
    index.ts      server entry, static client serving
  client/
    components/   chat, recall card, diff table, sources, memory drawer
    lib/          API client, markdown rendering, formatting
  shared/         types used by both sides
tests/            temporal, grounding, claims, agent integration
evals/
  run.ts          replay / record / live harness
  scenarios.ts    eight scenarios and assertions
  fixtures/       recorded search transcript
  results/        committed replay metrics
```

`npm run build` type-checks and builds the client into `dist/client`; `npm start` serves the built
client and API from port 8787.

---

## Design notes and tradeoffs

The full rationale is in [DESIGN.md](DESIGN.md). The short version:

- **A claim ledger, not chat RAG.** Re-reading old chunks produces plausible summaries but cannot
  answer “is this still true?” A dated, atomic claim with a source and quote can be compared.
- **Deterministic where correctness matters.** Recall and re-verification answers are templates.
  The model may write fresh research, but it may not invent a remembered date or a changed price.
- **The gate is independent of the model.** The verifier can propose quotes; the server still
  checks the bytes.
- **SQLite is a feature.** One process, WAL, FTS5, no infrastructure. The whole state is a file the
  user can inspect or delete.
- **Demo mode is a product state, not a hidden fallback.** The UI says demo in the header, banner,
  composer, sources, and claim drawer.

Known gaps:

- Live provider behavior is unverified here.
- One user, one process, no auth. Do not expose it to the public internet as-is.
- No background re-check scheduler; checks happen when you ask, with TTLs used to prioritize.
- The heuristic claim extractor is deliberately conservative and demo-oriented; live extraction is
  model-assisted.
- `npm audit` may report transitive advisories; see the final note in `DESIGN.md`.

---

Built for the minimi hiring challenge. The product name is **Since**; the tagline is the promise.
