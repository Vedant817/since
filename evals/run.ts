import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentResult, Intent } from '../src/shared/types.js';
import { runAgentTurn } from '../src/server/agent/loop.js';
import { loadConfig, type AppConfig } from '../src/server/config.js';
import type { LlmClient } from '../src/server/llm/openai.js';
import { openDatabase } from '../src/server/memory/db.js';
import { seedDemoHistory } from '../src/server/memory/seed.js';
import { createConversation } from '../src/server/memory/turns.js';
import { createRuntime } from '../src/server/runtime.js';
import type { SearchResult } from '../src/server/search/types.js';
import type { WebSearchInput, WebSearchTool } from '../src/server/search/service.js';
import {
  EVAL_NOW,
  scenarios,
  type Check,
  type EvalMode,
  type Scenario,
} from './scenarios.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE_PATH = resolve(ROOT, 'evals/fixtures/search.json');
const RESULTS_DIR = resolve(ROOT, 'evals/results');

interface RecordedCall {
  query: string;
  startDate: string | null;
  endDate: string | null;
  results: SearchResult[];
}

interface SearchFixture {
  version: 1;
  provider: string;
  note: string;
  scenarios: Record<string, RecordedCall[]>;
}

interface ScenarioRun {
  scenario: Scenario;
  result: AgentResult;
  checks: Check[];
  calls: RecordedCall[];
  pass: boolean;
}

interface ScenarioStats {
  searchQueries: number;
  searchErrors: number;
  sources: number;
  citations: number;
  recallHits: number;
  diff: { total: number; changed: number; unchanged: number; unclear: number };
  newClaims: number;
  grounding: {
    total: number;
    verified: number;
    rejected: number;
    rejectionRate: number;
  };
}

interface ScenarioResult {
  id: string;
  name: string;
  pass: boolean;
  expectedIntent: Intent;
  intent: Intent;
  checks: Check[];
  stats: ScenarioStats;
}

interface EvalReport {
  version: 1;
  mode: EvalMode;
  clock: string;
  runtime: {
    llm: string;
    search: string;
    note: string;
  };
  scenarios: ScenarioResult[];
  metrics: {
    scenarios: { total: number; passed: number; passRate: number };
    intentAccuracy: number;
    recallExpectationAccuracy: number;
    groundedCitationCoverage: number;
    grounding: {
      total: number;
      verified: number;
      rejected: number;
      rejectionRate: number;
    };
    reverification: { checks: number; changed: number; unchanged: number; unclear: number };
    newClaimsStored: number;
    searchQueries: number;
  };
}

class FixtureSearch implements WebSearchTool {
  readonly name = 'web_search' as const;
  readonly description = 'Replay a recorded search transcript.';
  position = 0;
  readonly failures: string[] = [];

  constructor(
    private readonly calls: RecordedCall[],
    private readonly scenarioId: string,
  ) {}

  get total(): number {
    return this.calls.length;
  }

  async run(input: WebSearchInput): Promise<SearchResult[]> {
    const call = this.calls[this.position];
    if (!call) {
      const message = `${this.scenarioId}: unexpected search call: ${input.query}`;
      this.failures.push(message);
      throw new Error(message);
    }
    const startDate = input.startDate ?? null;
    const endDate = input.endDate ?? null;
    if (call.query !== input.query || call.startDate !== startDate || call.endDate !== endDate) {
      const message =
        `${this.scenarioId}: search transcript mismatch. ` +
        `Expected ${JSON.stringify({ query: call.query, startDate: call.startDate, endDate: call.endDate })}, ` +
        `received ${JSON.stringify({ query: input.query, startDate, endDate })}`;
      this.failures.push(message);
      throw new Error(message);
    }
    this.position += 1;
    return call.results.map((result) => ({ ...result }));
  }
}

function createRecordingSearch(inner: WebSearchTool, calls: RecordedCall[]): WebSearchTool {
  return {
    name: 'web_search',
    description: inner.description,
    async run(input, signal) {
      // Reserve the slot before awaiting so concurrent searches keep their
      // invocation order. Completion order is not deterministic under mapLimit.
      const call: RecordedCall = {
        query: input.query,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        results: [],
      };
      calls.push(call);
      const results = await inner.run(input, signal);
      call.results = results;
      return results;
    },
  };
}

async function runScenario(
  scenario: Scenario,
  mode: EvalMode,
  config?: AppConfig,
  fixtureCalls: RecordedCall[] = [],
): Promise<ScenarioRun> {
  const now = new Date(scenario.now);
  const db = openDatabase(':memory:');
  try {
    let search: WebSearchTool;
    let llm: LlmClient | null = null;
    let runtimeMode: 'live' | 'demo' = 'demo';
    let calls: RecordedCall[] = [];
    let fixture: FixtureSearch | undefined;

    if (mode === 'replay') {
      fixture = new FixtureSearch(fixtureCalls, scenario.id);
      search = fixture;
    } else {
      if (!config) throw new Error('Runtime config is required outside replay mode.');
      const runtime = createRuntime(config, db, now);
      calls = [];
      search = createRecordingSearch(runtime.searchTool, calls);
      runtimeMode = runtime.config.mode;
      llm = mode === 'live' ? runtime.llm : null;
    }

    const conversationId = scenario.seed
      ? seedDemoHistory(db, { timezone: scenario.timezone, now })
      : createConversation(db, {
          timezone: scenario.timezone,
          createdAt: now.toISOString(),
        }).id;

    const result = await runAgentTurn(
      {
        db,
        llm,
        search,
        mode: runtimeMode,
        userTimezone: scenario.timezone,
        now: () => now,
      },
      {
        conversationId,
        message: scenario.message,
        timezone: scenario.timezone,
        emit: () => undefined,
      },
    );

    const checks = scenario.checks({ result, mode });
    if (mode === 'replay' && fixture) {
      checks.push({
        name: 'replays the recorded search transcript',
        pass: fixture.failures.length === 0 && fixture.position === fixture.total,
        expected: `${fixture.total} search calls`,
        actual:
          fixture.failures.length === 0
            ? `${fixture.position}/${fixture.total} matched`
            : fixture.failures.join('; '),
      });
    }
    if (mode === 'replay') {
      checks.push({
        name: 'uses the deterministic runtime',
        pass: result.mode === 'demo' && result.assistantTurn.meta?.mode === 'demo',
        expected: 'demo mode with no model',
        actual: result.mode,
      });
    }
    if (mode === 'live') {
      checks.push({
        name: 'uses the live runtime',
        pass: result.mode === 'live',
        expected: 'live',
        actual: result.mode,
      });
    }
    const pass = mode === 'record' || checks.every((entry) => entry.pass);
    return { scenario, result, checks, calls, pass };
  } finally {
    db.close();
  }
}

function statsFor(result: AgentResult): ScenarioStats {
  const diff = { total: result.diff.length, changed: 0, unchanged: 0, unclear: 0 };
  for (const row of result.diff) diff[row.verdict] += 1;
  return {
    searchQueries: result.meta.searchQueries?.length ?? 0,
    searchErrors: result.meta.searchErrors ?? 0,
    sources: result.sources.length,
    citations: result.assistantTurn.citations.length,
    recallHits: result.recall.length,
    diff,
    newClaims: result.meta.claimsExtracted ?? 0,
    grounding: {
      total: result.grounding.total,
      verified: result.grounding.verified,
      rejected: result.grounding.rejected,
      rejectionRate: result.grounding.rejectionRate,
    },
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function buildMetrics(runs: ScenarioRun[]): EvalReport['metrics'] {
  const passed = runs.filter((run) => run.pass).length;
  const intentMatches = runs.filter((run) => run.result.intent === run.scenario.expectedIntent).length;
  const recallScenarios = runs.filter(
    (run) => run.scenario.expectedRecallHits !== undefined,
  );
  const recallMatches = recallScenarios.filter(
    (run) => run.result.recall.length === run.scenario.expectedRecallHits,
  ).length;
  const citationScenarios = runs.filter((run) => run.scenario.expectsCitations);
  const groundedCitationScenarios = citationScenarios.filter(
    (run) =>
      run.result.assistantTurn.citations.length > 0 &&
      run.result.grounding.rejected === 0 &&
      run.result.assistantTurn.citations.every((citation) => citation.quote !== undefined),
  ).length;

  const grounding = runs.reduce(
    (total, run) => ({
      total: total.total + run.result.grounding.total,
      verified: total.verified + run.result.grounding.verified,
      rejected: total.rejected + run.result.grounding.rejected,
    }),
    { total: 0, verified: 0, rejected: 0 },
  );
  const reverification = runs.reduce(
    (total, run) => {
      for (const row of run.result.diff) total[row.verdict] += 1;
      total.checks += run.result.diff.length;
      return total;
    },
    { checks: 0, changed: 0, unchanged: 0, unclear: 0 },
  );

  return {
    scenarios: { total: runs.length, passed, passRate: ratio(passed, runs.length) },
    intentAccuracy: ratio(intentMatches, runs.length),
    recallExpectationAccuracy: ratio(recallMatches, recallScenarios.length),
    groundedCitationCoverage: ratio(groundedCitationScenarios, citationScenarios.length),
    grounding: {
      ...grounding,
      rejectionRate: ratio(grounding.rejected, grounding.total),
    },
    reverification,
    newClaimsStored: runs.reduce(
      (total, run) => total + (run.result.meta.claimsExtracted ?? 0),
      0,
    ),
    searchQueries: runs.reduce(
      (total, run) => total + (run.result.meta.searchQueries?.length ?? 0),
      0,
    ),
  };
}

function buildReport(
  mode: EvalMode,
  runs: ScenarioRun[],
  runtime: EvalReport['runtime'],
): EvalReport {
  return {
    version: 1,
    mode,
    clock: EVAL_NOW,
    runtime,
    scenarios: runs.map((run) => ({
      id: run.scenario.id,
      name: run.scenario.name,
      pass: run.pass,
      expectedIntent: run.scenario.expectedIntent,
      intent: run.result.intent,
      checks: run.checks,
      stats: statsFor(run.result),
    })),
    metrics: buildMetrics(runs),
  };
}

function readFixture(): SearchFixture {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `No search fixture at ${FIXTURE_PATH}. Run \`npm run eval:record\` first.`,
    );
  }
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Partial<SearchFixture>;
  if (parsed.version !== 1 || typeof parsed.scenarios !== 'object' || !parsed.scenarios) {
    throw new Error(`Unsupported search fixture at ${FIXTURE_PATH}.`);
  }
  return parsed as SearchFixture;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printSummary(runs: ScenarioRun[], mode: EvalMode): void {
  console.log(`\nSince evals — ${mode}\n`);
  const nameWidth = Math.max(8, ...runs.map((run) => run.scenario.id.length));
  console.log(`${'scenario'.padEnd(nameWidth)}  ${'intent'.padEnd(16)}  result   checks`);
  for (const run of runs) {
    const passedChecks = run.checks.filter((entry) => entry.pass).length;
    console.log(
      `${run.scenario.id.padEnd(nameWidth)}  ${run.result.intent.padEnd(16)}  ${
        run.pass ? 'PASS' : 'FAIL'
      }     ${passedChecks}/${run.checks.length}`,
    );
    if (!run.pass) {
      for (const entry of run.checks.filter((check) => !check.pass)) {
        console.log(`  - ${entry.name}: expected ${entry.expected}; got ${entry.actual}`);
      }
    }
  }

  const metrics = buildMetrics(runs);
  console.log(
    `\n${metrics.scenarios.passed}/${metrics.scenarios.total} scenarios (${percent(
      metrics.scenarios.passRate,
    )}) • intent ${percent(metrics.intentAccuracy)} • recall ${percent(
      metrics.recallExpectationAccuracy,
    )} • grounded citations ${percent(metrics.groundedCitationCoverage)}`,
  );
  console.log(
    `grounding ${metrics.grounding.verified}/${metrics.grounding.total} verified • ` +
      `re-checks ${metrics.reverification.checks} • new claims ${metrics.newClaimsStored} • ` +
      `queries ${metrics.searchQueries}`,
  );
}

function parseMode(argv: string[]): { mode: EvalMode; help: boolean } {
  let mode: EvalMode = 'replay';
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--mode') {
      const value = argv[index + 1];
      if (value !== 'replay' && value !== 'record' && value !== 'live') {
        throw new Error('--mode must be replay, record, or live.');
      }
      mode = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (value !== 'replay' && value !== 'record' && value !== 'live') {
        throw new Error('--mode must be replay, record, or live.');
      }
      mode = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { mode, help };
}

async function main(): Promise<void> {
  const { mode, help } = parseMode(process.argv.slice(2));
  if (help) {
    console.log(`Since evals

Usage:
  npm run eval                 Replay the recorded search fixture (default)
  npm run eval:record          Record search transcripts into evals/fixtures/search.json
  npm run eval:live            Run with live OpenAI + Tavily credentials

Flags:
  --mode replay|record|live
  --help

Replay is deterministic and needs no API keys. Record without keys captures the
built-in demo corpus; record with keys captures live search results. Record uses
deterministic synthesis, so the fixture can be replayed without a model.
Live mode exercises the full live agent and writes evals/results/live.json.
`);
    return;
  }

  if (mode === 'live') {
    const config = loadConfig(process.env);
    if (config.mode !== 'live') {
      console.error(
        `Live evals need a complete environment. Missing: ${config.missingKeys.join(', ') || 'unknown'}.`,
      );
      process.exitCode = 1;
      return;
    }
    const runs: ScenarioRun[] = [];
    for (const scenario of scenarios) {
      const run = await runScenario(scenario, mode, config);
      runs.push(run);
    }
    const report = buildReport(mode, runs, {
      llm: `${config.openai?.fastModel ?? 'unknown'} (routing/extraction) + ${
        config.openai?.smartModel ?? 'unknown'
      } (synthesis)`,
      search: 'tavily',
      note: 'Live run. Search results and model output are not deterministic.',
    });
    writeJson(resolve(RESULTS_DIR, 'live.json'), report);
    printSummary(runs, mode);
    console.log(`\nWrote evals/results/live.json`);
    process.exitCode = runs.every((run) => run.pass) ? 0 : 1;
    return;
  }

  const config = loadConfig(process.env);

  if (mode === 'record') {
    const runs: ScenarioRun[] = [];
    const fixtureScenarios: Record<string, RecordedCall[]> = {};
    const providers = new Set<string>();
    for (const scenario of scenarios) {
      const run = await runScenario(scenario, mode, config);
      runs.push(run);
      fixtureScenarios[scenario.id] = run.calls;
      providers.add(config.mode === 'live' && config.tavilyApiKey ? 'tavily' : 'demo');
    }
    const provider = providers.size === 1 ? [...providers][0]! : [...providers].join('+');
    const fixture: SearchFixture = {
      version: 1,
      provider,
      note:
        provider === 'demo'
          ? 'Recorded from the built-in demo corpus. No network access; replay is fully deterministic.'
          : 'Recorded from live Tavily search. Replay uses these results with deterministic synthesis and no model.',
      scenarios: fixtureScenarios,
    };
    writeJson(FIXTURE_PATH, fixture);
    console.log(`\nRecorded ${runs.length} scenarios from ${provider} search.`);
    console.log(`Wrote evals/fixtures/search.json (${Object.values(fixtureScenarios).flat().length} calls).`);
    console.log('Run `npm run eval` to replay without credentials.');
    return;
  }

  const fixture = readFixture();
  const runs: ScenarioRun[] = [];
  for (const scenario of scenarios) {
    const calls = fixture.scenarios[scenario.id];
    if (!calls) {
      throw new Error(`Fixture is missing scenario ${scenario.id}. Re-record with npm run eval:record.`);
    }
    runs.push(await runScenario(scenario, mode, undefined, calls));
  }
  const report = buildReport(mode, runs, {
    llm: 'none — deterministic templates',
    search:
      fixture.provider === 'demo'
        ? 'recorded demo corpus (no network)'
        : `recorded ${fixture.provider} search (no network)`,
    note: fixture.note,
  });
  writeJson(resolve(RESULTS_DIR, 'replay.json'), report);
  printSummary(runs, mode);
  console.log(`\nWrote evals/results/replay.json`);
  process.exitCode = runs.every((run) => run.pass) ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
