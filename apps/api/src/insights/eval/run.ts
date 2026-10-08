/**
 * Insights eval suite.
 *
 *   pnpm eval                      offline, deterministic (CI): guardrail probes, template answers for every case,
 *                                  and a replay of every committed recording of real model answers
 *   pnpm eval --live               run the cases against the model in LLM_BASE_URL / LLM_MODEL
 *   pnpm eval --live --runs 3      repeat each case (models are not deterministic)
 *   pnpm eval --live --record      also save the raw answers to evals/recordings/<model>.json for replay in CI
 *
 * Live runs write evals/results/<timestamp>-<model>.json. Exit code 1 if a gate fails.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CircuitBreaker, LlmGateway, type LlmProvider, OpenAICompatibleProvider } from "../gateway";
import { InsightGenerator, loadPrompt, PROMPT_VERSION } from "../generator";
import { CASES, type EvalCase } from "./cases";
import {
  type CaseScore,
  RecordingProvider,
  replayRecording,
  runProbes,
  type Summary,
  scoreCase,
  summarize,
} from "./harness";

const { values: args } = parseArgs({
  // Accept both `pnpm eval --live` and `pnpm eval -- --live`.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    live: { type: "boolean", default: false },
    runs: { type: "string", default: "1" },
    record: { type: "boolean", default: false },
  },
});

// Run from apps/api (pnpm eval does), or point EVALS_DIR elsewhere, e.g. a mounted folder in Docker.
const EVALS_DIR = process.env.EVALS_DIR ?? join(process.cwd(), "evals");
const prompt = loadPrompt();
let failed = false;
const gate = (ok: boolean, label: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
};

async function runCases(provider: LlmProvider | null, setCase: (name: string) => void, runs: number) {
  const gateway = provider
    ? new LlmGateway(provider, new CircuitBreaker(1000), undefined, async () => {})
    : null;
  const generator = new InsightGenerator(gateway, prompt);
  const scores: CaseScore[] = [];
  for (const c of CASES) {
    for (let r = 0; r < runs; r++) {
      setCase(c.name);
      scores.push(scoreCase(c, await generator.generate(forModel(c))));
    }
  }
  return scores;
}

function printScores(scores: CaseScore[], s: Summary) {
  console.table(
    scores.map((x) => ({
      case: x.case,
      outcome: x.outcome,
      coverage: x.coverage.toFixed(2),
      forbidden: x.forbiddenCited.length,
      direction_err: x.directionErrors,
      insights: x.insights,
      ms: Math.round(x.latencyMs),
    })),
  );
  console.log(s);
}

function gates(s: Summary, llm: boolean) {
  gate(s.forbiddenCitations === 0, "never cites low-volume or noisy facts");
  gate(s.directionErrors === 0, "never states the wrong direction of a change");
  gate(s.noSignalFailures === 0, "quiet periods are answered without calling the model");
  gate(s.coverage >= (llm ? 0.8 : 1), `covers the key findings (coverage ${s.coverage.toFixed(2)})`);
  if (llm) {
    gate(
      s.fallbacks <= Math.floor(s.modelCalls * 0.1),
      `<= 10% of answers fall back to the template (${s.fallbacks}/${s.modelCalls})`,
    );
  }
}

/** What the service sends the model: notable facts only, top 8 by impact. */
const forModel = (c: EvalCase) =>
  c.facts
    .filter((f) => f.notable)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 8);

console.log("\n== Guardrail probes (deterministic) ==");
const probes = runProbes();
console.table(probes);
gate(
  probes.every((p) => p.pass),
  `${probes.filter((p) => p.pass).length}/${probes.length} probes behave as expected`,
);

console.log("\n== Template answers (no model) ==");
{
  const scores = await runCases(null, () => {}, 1);
  const s = summarize(scores);
  printScores(scores, s);
  gates(s, false);
}

const recDir = join(EVALS_DIR, "recordings");
for (const file of existsSync(recDir) ? readdirSync(recDir).filter((f) => f.endsWith(".json")) : []) {
  const rec = JSON.parse(readFileSync(join(recDir, file), "utf8")) as {
    model: string;
    promptVersion?: string;
    answers: Record<string, string[]>;
  };
  console.log(
    `\n== Recorded answers vs today's guardrails: ${rec.model}, prompt ${rec.promptVersion ?? "?"} (${file}) ==`,
  );
  const rows = replayRecording(rec.answers, forModel);
  console.table(rows);
  const total = rows.reduce((a, r) => a + r.answers, 0);
  const accepted = rows.reduce((a, r) => a + r.accepted, 0);
  console.log(
    `  ${accepted}/${total} recorded answers would reach a user today; the rest fall back to the template.`,
  );
  gate(
    rows.every((r) => r.forbiddenInAccepted === 0 && r.wrongDirectionInAccepted === 0),
    "no accepted answer cites noise or states a wrong direction",
  );
}

if (args.live) {
  const { LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, LLM_TIMEOUT_MS } = process.env;
  if (!LLM_BASE_URL || !LLM_MODEL) {
    console.error("--live needs LLM_BASE_URL and LLM_MODEL");
    process.exit(2);
  }
  const runs = Number(args.runs);
  console.log(`\n== Live: ${LLM_MODEL} x ${runs} run(s) per case ==`);
  const base = new OpenAICompatibleProvider({
    baseUrl: LLM_BASE_URL,
    model: LLM_MODEL,
    apiKey: LLM_API_KEY,
    timeoutMs: Number(LLM_TIMEOUT_MS ?? 30_000),
  });
  const recorder = new RecordingProvider(base);
  const scores = await runCases(
    recorder,
    (n) => {
      recorder.current = n;
    },
    runs,
  );
  const s = summarize(scores);
  printScores(scores, s);
  gates(s, true);

  const slug = LLM_MODEL.replace(/[^a-z0-9.-]+/gi, "_");
  mkdirSync(join(EVALS_DIR, "results"), { recursive: true });
  const out = join(
    EVALS_DIR,
    "results",
    `${new Date().toISOString().slice(0, 16).replace(":", "")}-${slug}-${PROMPT_VERSION}.json`,
  );
  writeFileSync(
    out,
    `${JSON.stringify({ model: LLM_MODEL, promptVersion: PROMPT_VERSION, runs, summary: s, scores }, null, 2)}\n`,
  );
  console.log(`results: ${out}`);
  if (args.record) {
    mkdirSync(recDir, { recursive: true });
    const rec = join(recDir, `${slug}.${PROMPT_VERSION}.json`);
    const body = {
      model: LLM_MODEL,
      promptVersion: PROMPT_VERSION,
      recordedAt: new Date().toISOString(),
      answers: recorder.recordings,
    };
    writeFileSync(rec, `${JSON.stringify(body, null, 2)}\n`);
    console.log(`recording: ${rec}`);
  }
}

console.log(failed ? "\nEVALS FAILED" : "\nEVALS PASSED");
process.exit(failed ? 1 : 0);
