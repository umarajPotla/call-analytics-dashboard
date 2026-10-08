# Insight eval results

- `results/` — one JSON file per live run (`pnpm eval --live`): summary scores and every case's outcome.
- `recordings/` — raw model answers from `--record` runs. `pnpm eval` replays them in CI against the current guardrails, so a change to the prompt rules or checks is tested against real model output for free.

The cases and guardrail probes themselves are code: `src/insights/eval/`.
