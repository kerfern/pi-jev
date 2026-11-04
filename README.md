# pi-jev

A typed classification layer for the [Pi coding agent](https://pi.dev), backed by
a configurable System One endpoint (TypeSafe by default; OpenRouter also supported).

Coding agents make dozens of implicit decisions per session that nobody classifies:
which model tier a prompt deserves, whether a file operation is reversible, whether
a 4,000-line build log is worth a place in the context window, whether the agent is
still working on what was asked. `pi-jev` turns each of those into an explicit Jev
question with a calibrated probability, a confidence value, and a threshold that is
reviewable in one file.

Five independently switchable modules, one request per hook, shadow mode by default. A session-scoped policy protects sensitive paths only through wrapped built-in `read`/`write`/`edit`; it does not sandbox shell, search, or opaque tools. `/jev off` disables the policy and invalidates pending Jev decisions.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | config, client, cache, budget, telemetry, `/jev` | implemented |
| 1 | `router` | implemented, shadow |
| 2 | `gate` | implemented, shadow; `block` opt-in |
| 3 | `shield` | implemented, shadow |
| 4 | `prune` + `watchdog` | implemented, disabled by default |
| 5 | release + measured numbers | `@riposta/pi-jev@0.2.3` published; current protected-path/OpenRouter changes are local and unpublished |

Every Jev module ships in **shadow mode**: it classifies, logs the counterfactual
decision, and makes no module enforcement changes until promoted. The direct-file
protected-path policy is active by default; it covers wrapped built-in
`read`/`write`/`edit` only and is disabled by `/jev off` for the session.
See [Promoting a module](#promoting-a-module).

The repo's development SDK is `0.85.1`; the managed Pi runtime `1.4.0` has
passed the local-mock E2E. These are distinct versions. `test/pi/run-e2e.mjs`
drives real `pi` sessions offline with scripted models and asserts that the
router preserves Pi's active tool selection, configured gate handling applies to
shell calls, safe read/write/edit and `/jev off`/`on` flows work, a live shield
withholds injected content, and a `pi install`ed package auto-loads. Dedicated
unit tests cover protected direct-file targets (see [Testing](#testing)).

### Measured results (v0 fixtures, tuned defaults)

Produced by `tools/evaluate.ts` against the labelled fixtures in this repository
(real `api.typesafe.ai`, `jev-latest`). These are the only numbers this project
quotes.

| Module | Metric | Target | Measured |
| --- | --- | --- | --- |
| router | tier accuracy vs labels | ≥ 80% | **90–92%** across runs |
| router | added latency p50 | ≤ 600 ms | **288–673 ms** (load-dependent) |
| gate | false negatives on dangerous | 0 | **0/19** |
| gate | false positives on safe | ≤ 10% | **5.0%** (1/20) |
| shield | injection detection | ≥ 90% | **93.3%** (14/15) |
| all | failures that block Pi | 0 | **0** |

Not yet measured: router net cost change (needs model pricing), gate disk-cache
hit rate over real sessions (needs a warm log), prune token saving. See
[Calibration notes](#calibration-notes) for what tuning the first run required.

> The numbers above are `pi-jev`'s own, from the fixtures in this repository,
> not a vendor benchmark. The fixtures are a v0 seed (see
> [Evaluation and calibration](#evaluation-and-calibration)); re-run
> `tools/evaluate.ts` yourself to reproduce or refute them.

## Install

`pi-jev` is a [Pi](https://pi.dev) extension, so Pi comes first.

### 1. Install Pi

Pi requires **Node `>= 22.19`**.

```bash
# installer (recommended)
curl -fsSL https://pi.dev/install.sh | sh

# or npm
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Verify with `pi --version`. Pi also needs a model provider — an API key (for
example `ANTHROPIC_API_KEY`) or `/login` inside Pi. Jev auth is configured below;
a Pi-stored key can be shared when both use the same provider. See the [Pi
docs](https://pi.dev/docs/latest).

### 2. Configure Jev API auth

By default, `pi-jev` uses TypeSafe. Set `TYPESAFE_API_KEY` or sign in through
Pi's masked provider flow:

```
/login typesafe
```

The configured environment variable wins; Pi-stored auth is the fallback. To
use OpenRouter, configure `apiKeyProvider`, `apiKeyEnv`, `model`, and `baseUrl`
together as shown in [OpenRouter configuration](#openrouter-configuration)
below; provider selection alone leaves the TypeSafe endpoint and model active.
Then sign in with `/login openrouter` or set `OPENROUTER_API_KEY`. Jev asks Pi
only for the selected provider's key; it never falls back to another provider.
`/jev auth` reports selected provider and whether auth comes from the environment
or Pi.

### 3. Install pi-jev

Pi `>= 0.85.0` is required.

```bash
# from npm
pi install npm:@riposta/pi-jev

# or from git
pi install git:github.com/riposta/pi-jev
```

> **Use the scoped `@riposta/pi-jev`, not `pi-jev`.** The unscoped npm name
> `pi-jev` belongs to an unrelated project (`github.com/TheoOliveira/pi-jev`),
> so `pi install npm:pi-jev` would install someone else's code.

For local development, run Pi with the extension directly:

```bash
npm install
pi -e ./src/index.ts

# or install this checkout as a package (no publish needed)
pi install /absolute/path/to/pi-jev
```

Update a published install later with `pi update npm:@riposta/pi-jev`.

Every Jev module starts in shadow mode, so classification changes nothing until
you promote one (see [Promoting a module](#promoting-a-module)). The protected-path
guard takes effect as soon as the extension loads and is disabled by `/jev off` for the session.

`pi-jev` sends metadata and sampled tool output to its configured Jev endpoint
(TypeSafe by default; OpenRouter when selected). Read [Privacy](#privacy) before
enabling it on a repository you care about.

## Commands

Everything lives under `/jev`. Run it with no arguments for the status summary.

| Command | Scope | Does |
| --- | --- | --- |
| `/jev` | — | Status: the status line, active model and `QUESTIONS_VERSION`, each module's `off` / `shadow` / `live` state, and request/token/cost usage. An unknown subcommand prints the same summary. |
| `/jev auth` | — | Shows whether the selected provider key is available and where it came from (env or `/login <provider>`). |
| `/jev explain [hook]` | — | The most recent classification — overall, or for a specific `router`/`gate`/`shield`/`prune`/`watchdog`: every answer with its probability or score, the decision, the threshold/reason that fired, latency and token usage. |
| `/jev shadow <module> on\|off` | session | Toggles shadow for one module: `router`, `gate`, `shield`, `prune` or `watchdog`. In shadow, the module classifies and logs but changes nothing (`[shadow]` + `wouldHaveBeen` in the log). |
| `/jev off` | process + inheriting children | Disables Jev modules and direct-file protection, cancels pending Jev decisions/prompts/path checks, and restores router-owned tool narrowing when Pi's active selection has not changed externally. Applies to newly spawned Pi descendants that inherit the off marker; does not affect existing children or native filesystem mutations already started. |
| `/jev on` | process | Clears this process's off marker and starts a fresh enforcement generation; future inheriting Pi descendants start with Jev enabled. Stale work from before the toggle remains canceled. |
| `/jev stats [days]` | — | Reads `<telemetry.dir>/*.jsonl` for the last `days` (default `1`) and prints the decision mix, gate confirm labels (`allow`/`deny`/`unknown`) and cache hits. |
| `/jev trace [n]` | — | Prints the last `n` decisions (default `5`), one line each. |
| `/jev recommend` | — | Reads the gate labels from the log and suggests whether to relax the confirm thresholds. |

With `telemetry.traceWidget` (or `PI_JEV_TRACE_WIDGET=1`), the interactive UI
shows a live widget of the last eight decisions under the editor — the same
one-liners `/jev trace` prints.

`shadow` is **session-only**. `/jev off` and `/jev on` control this Pi process;
`off` also disables newly spawned Pi descendants that inherit its environment
marker, while existing children are unchanged. These toggles are not written to
config. To make a module change permanent, set `modules.<name>.shadow` (or
`enabled`) in `~/.pi/agent/jev.json`, or `.pi/jev.json` in a trusted project.
The status line shows `jev <tier> · <n> req · <cost|tokens>` and can report `jev off — <reason>`
when classification fails open; direct-file protection remains active in that state.
`/jev off` is the explicit process kill switch for Jev decisions and direct-file
protection; it invalidates pending work but does not interrupt native filesystem
mutations already in progress. Newly spawned Pi descendants that inherit the
marker also start off. `/jev on` clears the marker and begins a fresh generation
for new calls; already-running child processes are unchanged.

```text
/jev                  # status + usage
/jev explain          # why the last decision happened
/jev shadow gate off  # promote the gate for this session
/jev stats 7          # decision mix from the last week
```

## Protected-path policy

While Jev is active, wrapped built-in `read`, `write`, and `edit` reject
`/Users/kerf/.ssh` and descendants, plus exact `.env` file basenames at any
depth. `.env.local` and other `.env.*` names remain allowed; a directory named
`.env` is not treated as an exact `.env` file. Checks cover path aliases through
symlinks and recheck final arguments and actual filesystem-operation targets.
Unresolvable safe targets retain Pi's native filesystem errors.

This is **not a sandbox**. Other tools—including `bash`, `powershell`, `ls`,
`grep`, `find`, and unknown/opaque tools—flow through to the existing Jev gate
configuration; they are not categorically blocked by this path policy and can
access protected paths if their configured handling allows it or gate is off.
Human-entered `!` commands, other extensions/processes, hard-link aliases (not
reliably detectable), and concurrent filesystem races are outside the boundary.

`/jev off` invalidates pending Jev decisions and prompts, then disables the path
policy for this process and newly spawned Pi descendants that inherit its
marker. A stale check is not revived by `/jev on`; new calls use a fresh
generation. Existing child processes and native filesystem mutations already
started are not canceled, so this extension-level guard does not replace OS
permissions.

## How it works

```
user prompt ─► router (before_agent_start) ─► model tier, thinking level, tool loadout

read/write/edit ─► direct-file path guard ─┐
other tool calls ──────────────────────────┴─► configured gate
                                                (`/jev off` invalidates Jev work)
tool_result ─► shield + prune (one shared request)
turn_end ────► watchdog (every N) ─► loop / false-completion advice
```

`index.ts` contains no decision logic. It loads config, builds the client,
redactor and telemetry singletons, and calls each module's `register(pi, deps)`.
Modules never import each other; shared state goes through `deps`.

### The two files that matter

- [`src/questions.ts`](src/questions.ts) — every question, with its rationale.
- [`src/config.ts`](src/config.ts) — every default and threshold.

A `QUESTIONS_VERSION` hash is computed from `questions.ts`; editing it invalidates
the in-memory cache, the on-disk gate cache, and marks log records as a different
generation so calibration never mixes generations.

Disk gate cache stores classifier answers, not final decisions or user approvals;
each hit is re-evaluated under current gate policy. New disk keys are opaque
digests over normalized endpoint/model, question version, state hash/generation,
and gate action identity (tool, full input, gate state, cwd). Provider identity and
credentials are excluded. Existing `.pi/jev-cache.json` entries are left untouched;
legacy keys may contain normalized command text.

## Configuration

Resolution order: built-in defaults → `~/.pi/agent/jev.json` → `.pi/jev.json`
(only when `ctx.isProjectTrusted()`) → environment overrides. An invalid file
disables the extension with a clear message rather than falling back silently.

### OpenRouter configuration

For Liquid D1 Ultra through OpenRouter, configure:

```json
{
  "model": "liquid/d1-ultra",
  "baseUrl": "https://openrouter.ai/api",
  "apiKeyProvider": "openrouter",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

A complete annotated example lives in [`examples/jev.json`](examples/jev.json).

Frequently changed values:

```jsonc
{
  "model": "jev-latest",
  "modules": {
    "router": { "shadow": true, "tiers": { "cheap": { "provider": "anthropic", "model": "claude-haiku-4-5", "thinking": "off" } } },
    "gate":   { "shadow": true, "allowBlock": false, "onFailure": "allow" },
    "prune":  { "enabled": false, "minLines": 150 }
  },
  "residency": { "enabled": false, "allowedModels": [], "allowedRepos": [] },
  "telemetry": { "logStateContent": false }
}
```

Environment overrides: `PI_JEV_MODEL`, `PI_JEV_BASE_URL`, `PI_JEV_API_KEY_PROVIDER`,
`PI_JEV_API_KEY_ENV`,
`PI_JEV_LOG_DIR`, `PI_JEV_LOG_STATE_CONTENT`, `PI_JEV_OFF`,
`PI_JEV_<MODULE>_ENABLED`, `PI_JEV_<MODULE>_SHADOW`, `PI_JEV_<MODULE>_TIMEOUT_MS`,
`PI_JEV_GATE_FASTPATH_ENABLED`, `PI_JEV_GATE_RULES_ENABLED`,
`PI_JEV_WATCHDOG_REQUIRE_EVIDENCE`, `PI_JEV_TRACE_WIDGET`,
`PI_JEV_MAX_REQUESTS`, `PI_JEV_MAX_TOKENS`.

### Timeouts, budget and failure

Timeouts are per request class and configurable
(`PI_JEV_<MODULE>_TIMEOUT_MS`): `router` 2500 ms, `gate` 2000 ms,
`shield`+`prune` 3000 ms, `watchdog` 2000 ms. These are the calibrated defaults;
the initial plan's original 800/400/1500/1000 ms measured below the real p50/p95 and made
the hooks fail open (see [Calibration notes](#calibration-notes)). On expiry, a
missing key, a `401`, or a budget breach the client returns `null` and the Jev
module fails **open**. The protected-path guard remains active unless `/jev off`
was issued in this session.

- `401` disables the layer for the session.
- `422` disables the offending request class and logs the question id (a bug in
  `questions.ts`).
- three consecutive timeouts or network failures disable that class.
- budget breach disables or warns per `budget.onBreach`.

When the gate is live and non-shadow, a classification failure falls back to
`allow` by default; set `gate.onFailure: "deny"` for fail-closed.

## Modules

| Module | Hook | Default | What it does |
| --- | --- | --- | --- |
| `router` | `before_agent_start` | enabled, shadow | picks a model from the models Pi reports available (configured tiers are the fallback), thinking level and tool loadout; nudges on underspecification |
| `gate` | `tool_call` | enabled, shadow | deterministic fast path for obvious commands (works offline), then allow / confirm / block based on blast radius, reversibility, regenerable artefacts, intent drift, secrets, exfiltration, unverified code, installs and privilege/remote execution; optional semantic lint of writes/edits against project rules |
| `shield` | `tool_result` | enabled, shadow | withholds prompt-injected output, masks secrets and personal data |
| `prune` | `tool_result` | disabled | replaces low-relevance output with a summary and a temp-file pointer |
| `watchdog` | `turn_end` | disabled | detects looping, runaway (near-identical consecutive replies), references to non-existent files, and unverified completion (a "done" claim with no test/build/lint and no read-back counts as false-done); injects advice, never aborts |

`shield` and `prune` share **one** Jev request on `tool_result` and split the
answers in code. That orchestration lives in `index.ts` so the two modules stay
independent and the "one request per hook" rule holds. Exact-repeat
`jev-failure` suggestions are suppressed among the latest 64 distinct
fingerprints per session; changed evidence remains eligible.

The router asks Pi for the models it can actually use
(`modelRegistry.getAvailable()`) and sends that list to Jev, which picks one
directly; the configured `tiers` stay as the fallback when the list is empty or
the answer is missing. A configured tier whose provider/model is not installed
in Pi is reported once instead of failing silently.

When the router judges a prompt read-only it intersects Pi's current tool
selection with `read`, `bash`, `ls`, `grep` and `find`; it never adds tools Pi
excluded at startup. A later write-capable prompt restores the router baseline.
`/jev off` restores that baseline only if the active selection still matches
Jev's last router-owned selection; an externally changed selection becomes the
new baseline. Set `modules.router.readOnlyThreshold` to `0` to disable router
narrowing (not direct-file protection).

The path policy runs before Jev's gate for direct built-in `read`/`write`/`edit`
only. Other enabled tools proceed to configured gate handling; shell/search tools
are not sandboxed and may access protected paths. Gate fast-path and classifier
settings still decide whether those calls pass, confirm, or block. The shield
pattern-matches classic injection phrasing before a network request. Jev is
asked only for judgments code cannot express.

`gate.rules` optionally sends each `write`/`edit` plus your project Markdown
rules (`AGENTS.md`, `CLAUDE.md`, `.pi/rules.md`, `pi-jev.md`) in the gate's
single request, one Noul per rule. A violated rule is fed back to the agent
(`onViolation: "steer"`, the default) instead of interrupting you. Enable with
`{"modules":{"gate":{"rules":{"enabled":true}}}}`.

The gate's `confirmMode: "steer"` sends ordinary confirms for allowed file-tool
calls back to the agent without a prompt. Keep `"ask"` when those still require
user approval. Gate settings govern calls that reach the gate, including
shell/search tools. Protected direct-file targets are denied before the gate and
cannot be authorized by gate settings.
Blocks and `withoutUi: "deny"` are unaffected. A block downgraded by
`allowBlock: false`, or an unambiguously destructive fast-path entry downgraded
by `fastPath.block: false`, still prompts with UI; neither can be steered away.
Without UI, the configured `withoutUi` behavior still applies.

The Rule 6 investigation pilot is opt-in only in a trusted project's `.pi/jev.json`:
`modules.gate.lowConfidenceMode` defaults to `"ask"`; `"investigate-once"` is honored only from that project config (not user/global config or environment) and only when the gate is live. It blocks a low-confidence-only Rule 6 action, then permits one built-in `read` result that survives shield/prune. Jev re-evaluates the exact same action once with the redacted result capped at 4 KiB; the recheck treats it as untrusted evidence, not directions. Changed arguments discard evidence; missing, failed, withheld or pruned evidence and unresolved Rule 6 return to confirmation, or block when no UI is available. Rules 1–5 and defaults are unchanged. This adds up to 4 KiB of repository result text to a gate request; do not enable where repository content may not leave the machine. Pilot stays inactive unless separately enabled.

A TUI `"ask"` dialog displays the action input after configured redaction:
structured file-tool arguments, including write/edit content. It shows exact
absolute paths for local review, which reveals local directory names. Secret
and custom-pattern redaction still applies. Terminal control characters
display as visible escapes (for example, `\u001b`); line breaks remain intact.
RPC confirmations retain marked absolute prefixes and basenames because their
messages are forwarded to the client. This changes confirmation display only;
provider, cache, and log redaction stay unchanged. The preview is capped at
2,000 characters and marks longer previews as truncated. Redaction is
pattern-based; do not treat it as a guarantee that arbitrary secrets are removed.

### Promoting a module

1. Run in shadow long enough to collect data (target: 200+ router decisions,
   300+ gate decisions).
2. Sweep the thresholds:
   ```bash
   node --experimental-strip-types tools/calibrate.ts .pi/jev-log --question confirmBlastRadius --from 1 --to 3 --step 0.25
   ```
3. Adjust `config.ts` / `.pi/jev.json`. No code changes.
4. For the gate, the `userChoice` recorded on every confirm prompt is a free label.
5. Flip one module out of shadow (`/jev shadow gate off`, then set it in config).
   Watch for a week. Repeat.

For the gate specifically: `confirm` first; leave `allowBlock: false` until the
log shows zero false negatives on `fixtures/commands.jsonl` and the disk-cache hit
rate clears 50 %.

### Collecting real labels

Every confirm answer is a supervised label. The gate's `userChoice` records it
alongside the full probability vector for free. To collect them, make `confirm`
live (block stays off) and use Pi normally. Put this in `~/.pi/agent/jev.json`:

```jsonc
{ "modules": { "gate": { "enabled": true, "shadow": false, "allowBlock": false } } }
```

Then, in a project where you have been working:

```bash
node --experimental-strip-types tools/labels.ts .pi/jev-log
node --experimental-strip-types tools/labels.ts .pi/jev-log --sweep confirmBlastRadius --from 1 --to 3 --step 0.25
```

`labels` prints allow/deny totals, the deny rate per decision-table rule and the
commands you denied. With `--sweep` it replays the recorded answers and shows how
the deny rate moves as a threshold changes. Target 300+ gate decisions before
touching the numbers (initial_plan.md §13.3). Nothing is blocked while `allowBlock` is false.

## Privacy

**What leaves the machine.** Prompts, file paths, write/edit content, diff
summaries and sampled tool output are sent to the configured Jev `baseUrl`
(TypeSafe by default; OpenRouter when selected). Shell/search calls are not blocked
by the direct-file path policy; when gate classification runs, their command
metadata may be sent to Jev. Human-entered `!` commands are outside this extension.
This is not a no-egress boundary. Do not enable it where repository content may
not leave.

**Provider handling.** With OpenRouter, requests may be sent to a routed provider.
Provider logging and retention policies vary; review [OpenRouter's current provider
policies](https://openrouter.ai/docs/guides/privacy/provider-logging) and model
provider terms. Do not assume zero retention or no training.

**Redaction.** `src/redact.ts` runs deterministic, pattern-based scrubbing before
any request leaves: credential shapes, bearer tokens, private key blocks,
connection strings, `.env` assignments, JWTs, emails, and absolute paths reduced
to basenames. It is deliberately over-eager. `redaction.patterns: "strict"` adds
cards, national identifiers, IPs and phone numbers; a custom JSON array of regex
sources is also accepted, either as a file path or inline as
`{ "patterns": { "custom": ["…"] } }`.

**The known limitation.** `shield` exists to catch secrets patterns miss, but
content must reach Jev to be classified. Pattern redaction reduces exposure; it
does not eliminate it. A deployment where no repository content may leave should
run `router` and `gate` on redacted metadata only, with `shield` and `prune`
disabled.

**Controls.** Opt-in per project (`residency.enabled` + `residency.allowedRepos`),
project trust for project-local config, hash-only telemetry by default
(`logStateContent: false`), and a session kill switch (`/jev off`) that disables
Jev modules and the protected-path guard. An unset API key makes classification
fail open but leaves the guard active. `baseUrl` is configurable for a self-hosted
proxy that terminates TLS and applies organisational redaction. The API key is
used only for requests to that endpoint.
It can also point at Vercel AI Gateway
(`model: "typesafe-ai/jev"`, a gateway `baseUrl`) where a zero-data-retention
setting is available for the TypeSafe side of the traffic.

## Testing

```bash
npm test          # full unit suite; no provider requests
npm run typecheck
npm run test:coverage
npm run test:pi   # end-to-end against the real `pi` CLI (needs pi >= 0.85 on PATH)
```

The client and extension hook wiring are tested against a **real local HTTP
server** speaking the TypeSafe wire shape (`test/helpers.ts`), not a stubbed
`fetch`. That covers timeout, abort, `401`/`422`/`429`, cache
hit/miss/versioning, disk cache, budget breach and redaction. Decision tables
(including boundaries) are tested with stubbed answers. `test/index.test.ts`
embeds a fake Pi harness and asserts real hook effects: model switched, tool
calls confirmed/blocked, and result content replaced. `test/protected-paths.test.ts`
checks the path policy, its `/jev off`/`on` toggle, and wrapped filesystem operations.

### End-to-end against real Pi

`test/pi/run-e2e.mjs` runs actual `pi` offline against local mocks — an
OpenAI-compatible model server and a TypeSafe `/v1/systemone` server — with
scripted models. It verifies:

1. **dev load** (`pi -e ./src/index.ts`): router classifies the prompt, shell
   calls reach configured gate handling, a live gate blocks a safe write when
   no UI is available, and a live shield replaces injected `read` output with
   the withheld notice.
2. **package install** (`pi install /absolute/path/to/pi-jev`, then a normal run
   with no `-e`): the installed plugin auto-loads from settings and classifies.
3. **RPC confirmation and file ops**: deny then allow a safe write, approve safe
   edit, verify resulting file contents and recorded `userChoice` labels.
4. **kill switch commands**: run `/jev off` and `/jev on` through Pi's RPC
   extension-command path while safe reads continue.
5. **tool selection and user shell**: a read-only router decision does not add
   tools disabled by `--no-tools`; RPC bash exercises Pi's `user_bash` path, also
   used by the human-entered `!` command, outside model-tool gate hooks.

```bash
npm run test:pi
# KEEP_TMP=1 npm run test:pi   # keep the temp workspace for inspection
```

Requires Pi's own engine: Node `>= 22.19`. Set `PI_BIN` to point at a specific
`pi` binary.

A live smoke test runs only when `TYPESAFE_API_KEY` is set:

```bash
TYPESAFE_API_KEY=... npm test -- test/live.test.ts
```

There is also a full live Pi run — a real `pi` session whose classification
calls go to the real `api.typesafe.ai` (only the LLM is scripted):

```bash
TYPESAFE_API_KEY=... npm run test:pi:live
```

And a fully live run with a real Anthropic-compatible model provider and the
router live, so it verifies that the router actually switches the model:

```bash
ANTHROPIC_API_KEY=... BASE_URL=https://api.deepseek.com/anthropic \
  TYPESAFE_API_KEY=... npm run test:pi:live-model
```

The last one was verified with `pi 0.85.1` + `deepseek-flash` → `deepseek-v4-pro`
(a `standard` classification) + real Jev. Note that Pi does not emit a
`model_select` event for a model set by an extension during `before_agent_start`;
the assertion uses the model on the assistant messages instead.

## Evaluation and calibration

```bash
# acceptance metrics from the labelled fixtures (needs a key)
node --experimental-strip-types tools/evaluate.ts --json

# threshold sweep over a log (no key needed)
node --experimental-strip-types tools/calibrate.ts <file-or-dir> --question confirmBlastRadius --from 1 --to 3 --step 0.25

# re-issue recorded states against edited questions (needs a key + logStateContent)
node --experimental-strip-types tools/replay.ts <file-or-dir> --limit 50

# offline threshold sweep over a saved evaluate report (no key needed)
node --experimental-strip-types tools/sweep.ts /tmp/jev-eval.json

# offline: score the gate against expert labels and sweep a threshold
node --experimental-strip-types tools/score-labels.ts fixtures/gate-real.jsonl
```

Fixtures live in [`fixtures/`](fixtures/): 100 labelled prompts, 61 labelled
commands weighted toward the grey zone, 24 synthetic injection cases, and 141
real commands labelled by the maintainer agent with the answers Jev produced.

> The fixture sets are a v0 seed except `gate-real.jsonl`. The initial plan calls for
> prompts drawn from public issue trackers; that sourcing is still pending. Treat
> the numbers as a smoke signal, not the published figure.

### Calibration notes

The first real run against `jev-latest` required three changes, all applied to
the defaults in this repository:

1. **Confidence floors were miscalibrated.** The initial plan applies one floor to every
   answer, but a multi-level Score spreads probability, so `reasoning_needed`
   confidence is naturally much lower than a Choice's. With the original 0.55
   floor, 40 of 48 `standard` prompts were escalated to `strong`. Added a
   separate `router.reasoningConfidenceFloor`, calibrated to `0`, and kept the
   Choice floor (`confidenceFloor: 0.4`). Router accuracy went from 47% to 90%.
2. **The gate missed one irreversible local command.** `git reset --hard` scored
   as low blast radius and reversible enough. Row 4 was extended (config-driven)
   with `confirmIrreversibleBlastRadius: 1.0` + `confirmReversibleFloor: 0.7`:
   *not cleanly reversible and beyond scratch files → confirm*. On the fixtures
   this catches all 19 dangerous commands and 0 safe ones.
3. **The initial plan timeouts were below real latency.** Measured p50 673 ms / p95
   1752 ms for a single `api.typesafe.ai` call, against budgets of 400–800 ms.
   The three-strike rule then disabled hooks, making the layer inert. Defaults
   raised to p95 + margin.
4. **The speculative `domain` question was pure cost by default.** It is only
   read when `router.skillRouting` is on, so it is now only sent in that case
   (initial_plan.md §8.2); this cuts ~18% of router input tokens. Router latency is
   network-bound and load-dependent (p50 ~300–670 ms), so the ≤600 ms target is
   met on a quiet link but not guaranteed.
5. **Drift confirmed on read-only exploration.** In a real-session sample, three
   ordinary exploration commands (`cat package.json`, `find …`) scored
   `matches_intent` 0.23–0.29 and so triggered the drift confirm, even though
   their blast radius was 0. The initial plan's drift example is mutating, so rule 3 is
   now gated on `blast_radius ≥ 1.0` (`confirmDriftBlastRadius`): read-only
   detours no longer confirm, mutating ones still do. Safe-local false confirms
   went from 3/9 to 0/9, and to **0/24 on a 141-decision sample**. That larger
   sample also showed build commands (`npm run build`, `make`, `docker build`)
   triggering the irreversible confirm; [`docs/calibration.md`](docs/calibration.md)
   records it as friction to re-validate once labelled data exists.
6. **Build friction needed a new question, not a number.** `npm run build` and
   `git reset --hard` scored almost the same `blast_radius` and `reversible`, so
   no threshold could separate a rebuild from a lost-work reset. Added a gate
   question, `regenerable`, and made the irreversible confirm require
   `regenerable < 0.6`. On the 141-decision sample confirms went 18 → 14 with the
   four build/repack confirms suppressed and every destructive/secret confirm
   kept. This is an addition to the [initial_plan.md §9.3](docs/initial_plan.md)
   question list, made per §7.2
   (split an ambiguous judgment into atomic questions); acceptance was unchanged.
7. **Expert labels over the real commands.** The 141 captured commands were
   labelled `safe`/`confirm`/`dangerous` and stored with Jev's answers as
   [`fixtures/gate-real.jsonl`](fixtures/gate-real.jsonl). At the previous floor
   the gate had 2 false positives (both `rm -rf` in a scratch dir, flagged by the
   uncertainty rule) and 5 missed confirms. With `regenerable` in place the
   reversibility floor could rise from 0.70 to **0.75**, catching
   `git reset --hard origin/main` without re-flagging builds: precision 86.7%,
   recall 76.5%, false positives 2/124 (1.6%), zero missed dangerous. The four
   remaining missed confirms (`ssh`, `sudo`, global installs) needed two more
   questions, not a threshold: `installs_software` and `privileged_or_remote`
   measured 0.99 and 0.98/0.89 with no safe command above 0.22/0.05, lifting
   recall to 100% at 89.5% precision. The gate now asks nine questions where
   [`initial_plan.md` §9.3](docs/initial_plan.md) listed six, each addition
   forced by labelled evidence.

Each is a number change or a config-driven rule; none rewrote a prompt. Re-run
`sweep.ts` and `evaluate.ts` after any `questions.ts` or threshold edit.

## Repository layout

```
src/            index, config, questions, client, redact, telemetry, types, modules/
tools/          calibrate.ts, replay.ts, evaluate.ts, sweep.ts, labels.ts, score-labels.ts
fixtures/       prompts.jsonl, commands.jsonl, injections.jsonl
examples/       jev.json
docs/           initial_plan.md, calibration.md
test/           unit, client integration, and index wiring tests
test/pi/        real-Pi end-to-end harness (mock model + mock Jev servers)
```

## Known limitations

- The fixtures are not yet sourced from public trackers (see above).
- `matches_intent` and `is_underspecified` are unproven; watch them in shadow. In
  the fully live run, ordinary exploratory commands (`find`, `ls`) scored
  `matches_intent` between 0.11 and 0.47 even though their blast radius was 0, so
  a live `confirm` would prompt often until this is calibrated on real sessions.
- TypeSafe has cold-start outliers: the first call after idle can take several
  seconds, well past the router budget, and the router then fails open. Warm the
  connection or raise `PI_JEV_ROUTER_TIMEOUT_MS` for latency-sensitive setups.
- `watchdog` turn summaries are built locally from tool names and error lines; no
  second model call. Whether they are good enough as state is an open question.
- Where TypeSafe processes and retains request data is not documented publicly and
  must be established before a regulated deployment. `shield` sends the most
  sensitive content and is gated on that answer.
- The extension is Pi-only. The question catalogue is portable; the hook bindings
  are not.
- No subagent/background-task triage: Pi's extension API (as of 0.85) does not
  expose subagent or background-task events, so there is no hook to judge
  child-task reports. `/jev off` propagates to newly spawned Pi descendants that
  inherit its marker, but cannot observe or control already-running children.
  Runaway detection and the evidence-based done-check cover observable symptoms;
  full subagent triage still needs a Pi hook that does not exist yet.

## Licence

MIT, matching Pi.
