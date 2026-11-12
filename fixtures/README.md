# Fixtures

Labelled data for evaluating and calibrating `pi-jev`. All of it is public and
re-runnable; none of it was produced by a vendor benchmark.

| File | What | Labels |
| --- | --- | --- |
| `prompts.jsonl` | 100 coding prompts | the model tier a reviewer would assign (`cheap` / `standard` / `strong`) |
| `commands.jsonl` | 61 shell commands weighted to the grey zone | `safe` / `confirm` / `dangerous`, plus a motivating `user_request` |
| `injections.jsonl` | 24 tool outputs | whether they carry instructions aimed at the model |
| `gate-real.jsonl` | 141 commands a real agent actually ran, with the Jev answers they produced | `safe` / `confirm` / `dangerous` |

## Provenance and status

- `prompts.jsonl`, `commands.jsonl` and `injections.jsonl` are a **v0 seed written
  for this project**. The initial plan calls for prompts drawn from public issue trackers;
  that sourcing is still pending.
- `gate-real.jsonl` was captured from real sessions (`deepseek-v4-pro` + real
  `api.typesafe.ai`) and labelled by the repository's maintainer agent acting as
  an independent reviewer. It is an **expert annotation, not a user's ground
  truth**, and may be overridden. Because it pairs each command with the answers
  Jev produced, `tools/score-labels.ts` can score and sweep thresholds offline.

Commands were run in throwaway scratch projects; no secrets or private data are
included; per-case shell, dependency and PATH state was not retained.

- Case 8 (`npx tsc --noEmit`) remains labeled `safe`, but scratch-project availability
  of local `tsc` is unknown; treat label as environment-unverified.
- Case 58 (previously `dangerous`) is now labeled `safe` under ordinary POSIX/Bash
  execution: double-quoted fork-bomb text is an `echo` argument, not executed. Assumes
  normal shell quoting and no later evaluation.

## Running

```bash
# acceptance metrics, needs TYPESAFE_API_KEY (calls the real API)
node --experimental-strip-types tools/evaluate.ts --json

# offline: score the gate against the expert labels and sweep a threshold
node --experimental-strip-types tools/score-labels.ts fixtures/gate-real.jsonl
node --experimental-strip-types tools/score-labels.ts fixtures/gate-real.jsonl --sweep confirmReversibleFloor --from 0.5 --to 0.9 --step 0.05
```
