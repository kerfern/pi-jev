# Protected-Path Policy Implementation Plan

> **Archived plan.** Implementation committed locally as `545bc5a1dead34a95ba4f6358044b585133b0505` on `main`, based on `v0.2.3`. Verified with `npm run typecheck` and `PI_BIN=pi npm run test:all` (264 passed, 1 skipped; local-mock E2E). The former “no staging or commits” instruction is superseded by current package-only publish approval; other repositories remain separate.

**Goal:** Protect `/Users/kerf/.ssh` and exact `.env` paths only through built-in `read`/`write`/`edit`, while making `/jev off` a session kill switch that releases and invalidates pending Jev decisions.

**Architecture:** Keep the existing wrapped built-in file definitions and guard registration order. Add one shared generation/abort scope used by Jev hooks, classifier calls, confirmations, and filesystem path checks. Check actual file-operation targets after argument mutation; when off, stale Jev work returns without policy effects and wrapped tools delegate to Pi unchanged. Restore router-owned tool narrowing on off without adding tools outside Pi's pre-router active set.

**Tech Stack:** TypeScript, Node filesystem APIs, Vitest; installed Pi runtime 1.4.0; repository SDK 0.85.1.

**Spec:** `docs/superpowers/specs/2026-10-27-protected-path-policy.md`

## Global Constraints

- Protect `/Users/kerf/.ssh` and descendants plus exact `.env` basenames at any depth; allow `.env.local` and other `.env.*` names.
- Guard only wrapped built-in `read`, `write`, and `edit`. Do not categorically block `bash`, `powershell`, `ls`, `grep`, `find`, or unknown/opaque tools; they continue through configured Jev gate behavior.
- Do not claim shell/search/opaque tools are path-confined. Jev is not an OS sandbox; aliases, obfuscation, direct filesystem access, hard links, other processes, and concurrent filesystem races remain outside the boundary.
- `/jev off` invalidates pending enforcement work and disables guard/modules for this session; `/jev on` starts a fresh enforcement generation for new calls; a new session resets enforcement active.
- Keep user-entered `!` / `user_bash` behavior unchanged. Never race/cancel an already-started native filesystem mutation or claim to undo a provider request already received.
- No new dependencies, global configuration, separate updater, or tools absent from Pi's pre-router active set. Preserve current gate skip/disabled/shadow/failure/confirmation behavior.
- Update the tracked pi-harness skill source only; preserve and verify its live symlink. Do not stage or commit either repository.
- Tests must use local mocks/temp fixtures and must not read or modify real `.ssh` contents or make provider requests.
- Preserve all existing dirty work. Before first implementation edit, capture status and tracked/untracked diffs in both repositories; scope edits to this spec.

## Review Focus

1. **Path boundaries:** `/Users/kerf/.ssh` and descendants deny; siblings such as `.ssh-backup` allow; exact `.env` denies at every depth while `.env.*` allows. Test lexical, absolute, relative, `..`, and cwd-resolved inputs.
2. **Aliases and dangling paths:** symlink ancestors, relative symlink targets, dangling symlink targets, nonexistent write paths, and symlink loops must not bypass a protected target or turn safe native errors into Jev policy errors.
3. **Final operation target:** tool-call argument mutation and Pi read-path fallback variants must still be checked at the final wrapped `execute`/filesystem-operation boundary; protected denials must cause no parent creation or write.
4. **Kill-switch races:** off during classification, confirmation, or path resolution must release the pending call before deferred work settles; off→on must not revive stale results or stale cache/in-flight entries. Test stale success and rejection, including deny-on-failure and confirmation paths.
5. **Tool selection and ordering:** guard runs before Jev `tool_call` handlers, unrelated tools pass through, wrapped definitions do not change Pi's active set, `--no-tools` remains empty, and `/jev off` restores router narrowing only from the pre-router active set.

---

### Task 1: Add a shared enforcement epoch

**Files:**
- Create: `src/enforcement.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Test: `test/index.test.ts`

**Interfaces:**
- `EnforcementScope`: immutable `{ generation: number; signal: AbortSignal }` captured at a Jev decision's ingress.
- `EnforcementEpoch`: `capture(): EnforcementScope`, `isCurrent(scope: EnforcementScope): boolean`, and `invalidate(): void`.
- `Deps.enforcement`: the shared session instance. Keep existing activation/config flags; the epoch handles staleness and cancellation, not feature configuration.
- `ENFORCEMENT_CANCELLED`: distinct internal result for cancellation; never collapse it into the existing `null`/fail-open/fail-deny result.

```ts
export interface EnforcementScope {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export class EnforcementEpoch {
  private generation = 0;
  private controller = new AbortController();

  capture(): EnforcementScope {
    return { generation: this.generation, signal: this.controller.signal };
  }

  isCurrent(scope: EnforcementScope): boolean {
    return scope.generation === this.generation;
  }

  invalidate(): void {
    this.controller.abort();
    this.generation += 1;
    this.controller = new AbortController();
  }
}

export const ENFORCEMENT_CANCELLED = Symbol("ENFORCEMENT_CANCELLED");
```

- **Step 1: Write a failing integration test in `test/index.test.ts`.** Hold a gate classification promise, start a tool call, invoke `/jev off`, then assert the tool-call hook has returned before the held promise settles. Current boolean-only behavior must fail this assertion by remaining pending, not by throwing a test/setup error. Add a second assertion that off→on does not make the old result current.
- **Step 2: Run `npm test -- test/index.test.ts`.** Confirm the new behavioral assertion fails for the expected reason: the hook remains pending on classification.
- **Step 3: Implement the smallest epoch controller.** `invalidate()` aborts the current controller, advances generation, and creates a fresh controller. Keep tokens immutable; integration coverage exercises the helper's generation/signal contract.
- **Step 4: Wire invalidation to `/jev off`, `/jev on`, and new-session reset.** Invalidate synchronously on each transition; off/on must produce different scopes even if an old promise settles after re-enable. Add an index assertion that `/jev on` enforces new calls and `session_start` restores the guard active while honoring normal config/module activation.
- **Step 5: Re-run `npm test -- test/index.test.ts` and `npm run typecheck`.**

### Task 2: Make gate and classifier work cancellation-safe

**Files:**
- Modify: `src/client.ts`
- Modify: `src/modules/gate.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Test: `test/client.test.ts`, `test/gate.test.ts`, `test/index.test.ts`

**Interfaces:** Each gate invocation captures one `EnforcementScope` and passes it through `Deps.ask`/client options. Combine its signal with Pi's call signal. Every continuation checks `isCurrent(scope)` before changing gate state, prompting, logging a policy decision, steering, or returning `{ block: true }`.

```ts
const scope = deps.enforcement.capture();
const result = await deps.ask("gate", state, questions, {
  signal: ctx.signal,
  scope,
});
if (!deps.enforcement.isCurrent(scope)) return;
if (result === ENFORCEMENT_CANCELLED) return;
```

The cancellation branch must run before interpreting a missing classification, applying `onFailure`, or consuming confirmation output.

- **Step 1: Add deferred-classifier regression tests.** Assert `/jev off` releases a pending tool call before the classifier promise settles. Resolve and reject the deferred promise after off; neither outcome may block, prompt, steer, or emit a Jev policy error. Repeat off→on and assert the old result remains invalid while a new call is enforced. Add regression assertions that enabled-call behavior remains unchanged under configured skip, disabled, shadow, failure, and confirmation settings.
- **Step 2: Run the focused gate/client tests and confirm the new assertions fail on current boolean-only behavior.**
- **Step 3: Pass the shared scope through classifier execution.** Abort where supported; race out uncooperative work. Return `ENFORCEMENT_CANCELLED` for invalidated work so cancellation cannot trigger `failOpen(onFailure="deny")`, a fast-path fallback, or a stale denial.
- **Step 4: Partition or invalidate cache/in-flight work by generation.** A stale response cannot populate cache, satisfy a new-generation request, or reuse an old in-flight promise.
- **Step 5: Make confirmation cancellation distinct from user denial.** Call `ctx.ui.confirm(..., { signal })` using a combined signal; after await, re-check the original scope before reading the boolean. Test prompt dismissal and off→on.
- **Step 6: Run `npm test -- test/client.test.ts test/gate.test.ts test/index.test.ts` and `npm run typecheck`.**

### Task 3: Invalidate other Jev module continuations

**Files:**
- Modify: `src/modules/router.ts`
- Modify: `src/modules/watchdog.ts`
- Modify: `src/modules/shield.ts`
- Modify: `src/modules/prune.ts`
- Modify: `src/index.ts`
- Test: `test/router.test.ts`, `test/watchdog.test.ts`, `test/shield.test.ts`, `test/prune.test.ts`, `test/index.test.ts`

- **Step 1: Add deferred tests for each module that awaits classifier/UI work.** During off, resolve the old work; assert no stale model/tool mutation, shield/prune result replacement, watchdog/gate denial, steer, or Jev policy error occurs.
- **Step 2: Run the focused module tests and confirm each new race assertion fails before implementation.**
- **Step 3: Capture one scope at each hook ingress.** After every await, check the same scope before state changes or externally visible effects. Do not recapture after off→on.
- **Step 4: Race only Jev decisions and prompts.** Do not race native file mutations or release Pi's mutation queue while an operation may still finish.
- **Step 5: Run `npm test -- test/router.test.ts test/watchdog.test.ts test/shield.test.ts test/prune.test.ts test/index.test.ts` and `npm run typecheck`.**

### Task 4: Narrow and harden direct-file protection

**Files:**
- Modify: `src/protected-paths.ts`
- Test: `test/protected-paths.test.ts`
- Verify wrapper registration in: `src/index.ts`

**Interfaces:** Keep the current final-argument `execute` wrapper and actual-target operation adapters. Carry the `EnforcementScope` captured for the same `toolCallId` into the wrapper; clean up token bookkeeping in `finally`. The check resolves the same cwd/path variants Pi's built-ins use.

- **Step 1: Add failing cases for non-file tools and registration readiness.** `bash`, `powershell`, `ls`, `grep`, `find`, and unknown tools must return to the existing gate; incomplete file-wrapper registration may fail closed only for direct `read`/`write`/`edit` calls.
- **Step 2: Add path regressions before changing the resolver.** Cover SSH root/descendant/sibling, exact `.env` vs `.env.*`, relative cwd, `..`, symlink ancestors, relative symlink targets, dangling links, nonexistent parents, loops, malformed input, and aliases to protected targets. Verify no protected write creates a parent or file.
- **Step 3: Add final-operation and cancellation regressions.** Mutate the path in a later `tool_call` hook, then verify read/write/edit wrappers inspect the final params and every actual filesystem operation. Cover Pi read filename-variant fallback resolving to `.env`. Defer `lstat`/`realpath`; assert off releases the call before resolution settles, the stale call passes through without a Jev denial even after off→on, and new calls remain guarded.
- **Step 4: Verify RED with `npm test -- test/protected-paths.test.ts`.**
- **Step 5: Replace ancestor-only resolution with loop-aware component resolution.** Compare both lexical and canonical targets; follow symlinks with `lstat`/`readlink`, resolve relative targets against their parent, and retain unresolved suffixes for nonexistent writes. Do not normalize a symlink target's `..` before resolving preceding symlinks. Check the final file target before `mkdir`; do not treat a `.env` directory as an exact `.env` file.
- **Step 6: Preserve native failures.** A path-resolution `ENOENT`, `EACCES`, or `ENOTDIR` for an unprotected target must reach the original built-in behavior rather than becoming a generic Jev policy denial. Cancellation may race resolution, but never a native mutation or Pi's mutation queue.
- **Step 7: Verify GREEN with `npm test -- test/protected-paths.test.ts`.**

### Task 5: Restore router-owned tool narrowing when Jev turns off

**Files:**
- Modify: `src/modules/router.ts`
- Modify: `src/index.ts`
- Test: `test/router.test.ts`, `test/index.test.ts`, `test/pi/run-e2e.mjs`

**Interfaces:** `router.register()` exposes a synchronous restore callback to the `/jev off` handler. Router state tracks the pre-router active tool list and its last applied selection. This restores `write`/`edit` when they were active in Pi's pre-router selection; it never revives tools excluded by Pi startup configuration.

```ts
let preRouterTools: string[] | undefined;
let lastRouterTools: string[] | undefined;

function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name) => right.includes(name));
}

function captureOrRebaseTools(): string[] {
  const current = pi.getActiveTools();
  if (!preRouterTools || !lastRouterTools || !sameToolSet(current, lastRouterTools)) {
    preRouterTools = [...current];
  }
  return preRouterTools;
}

function applyReadOnly(): void {
  lastRouterTools = captureOrRebaseTools().filter((name) => READ_ONLY_TOOLS.includes(name));
  pi.setActiveTools(lastRouterTools);
}

function restoreTools(): void {
  if (!preRouterTools || !lastRouterTools) return;
  const current = pi.getActiveTools();
  if (sameToolSet(current, lastRouterTools)) pi.setActiveTools(preRouterTools);
  else preRouterTools = [...current]; // external selection becomes the new baseline
  lastRouterTools = undefined;
}
```

- **Step 1: Add failing tests.** Start with Pi-active `read`, `write`, `edit`, `bash`, and search tools; apply a read-only route; assert `/jev off` restores the pre-router selection so `write`/`edit` are available. If Pi starts with `--no-tools`, assert router and off do not add any tools. Change the tool selection externally after Jev narrows it; verify the external selection becomes authoritative.
- **Step 2: Verify the new tests fail against current behavior.**
- **Step 3: Narrow by intersection, not a fixed replacement list.** Compute `READ_ONLY_TOOLS ∩ preRouterActiveTools`, so router cannot activate tools Pi did not enable. Record full-loadout decisions as router-owned selections too, so restoration compares against the last actual router write.
- **Step 4: Restore conditionally on off.** If the current active list still matches Jev's last applied list, restore the pre-router list. If it differs, preserve that external selection and rebase the router baseline to it for future decisions rather than replaying a stale snapshot. Invalidate pending router work before restoration so an old decision cannot narrow tools after off→on.
- **Step 5: Run `npm test -- test/router.test.ts test/index.test.ts` and verify the E2E active-tool assertions.**

**Known API limit:** Pi exposes current active tools, not provenance for a tool already hidden by Jev. Conditional restoration preserves detectable external changes; a user disabling an already-hidden tool cannot be distinguished from Jev's own narrowing. Never add names absent from the pre-router selection.

### Task 6: Update policy docs and installed-runtime E2E

**Files:**
- Modify: `README.md`
- Modify: `test/pi/run-e2e.mjs`
- Modify tracked source: `/Users/kerf/Projects/pi-harness/docs/skills/fix-broken-pi-extension-after-upgrade/SKILL.md`
- Verify live link: `/Users/kerf/.pi/agent/pi-hermes-memory/skills/fix-broken-pi-extension-after-upgrade/SKILL.md`
- Modify: `docs/superpowers/specs/2026-10-27-protected-path-policy.md` (status metadata only; do not change approved policy text)

- **Step 1: Update README policy and limits.** State direct-file scope, `/jev off` behavior, router tool restoration, and explicit shell/search/opaque bypass risk. Do not claim Jev is a sandbox.
- **Step 2: Correct the protected-path bullet in the tracked pi-harness skill.** Remove claims that non-file tools are categorically denied; document current gate flow, direct-file scope, off/on invalidation, local-mock verification, and the known limits. Edit tracked source, not the live symlink; preserve the current uncommitted `version: 31` revision and set `updated: "2026-10-28"` for this single draft update.
- **Step 3: Verify symlink identity and content.** Confirm the live `SKILL.md` remains a symlink to the tracked source and both resolve to identical content.
- **Step 4: Run local-mock E2E on installed Pi 1.4.0.** Verify safe read/write/edit, off/on, active-tool selection including `--no-tools`, configured gate behavior, and unchanged human `!` behavior. Make no provider request. Protected targets remain covered by synthetic unit tests; E2E avoids direct protected-fixture access after the safety-net block.
- **Step 5: Correct approved-spec status metadata only.** Replace the stale “written spec awaiting review” status with `Direction and written spec approved by user in chat (2026-10-28); implementation plan pending review.` Do not alter approved policy content.

## Final Verification

Run from `/Users/kerf/Projects/systemone/pi-jev`:

```sh
npm run typecheck
npm run test:all
git diff --check
```

Also verify `pi --version` is 1.4.0, repository SDK is 0.85.1, the pi-harness live symlink is intact, and no protected fixture test read or wrote real secret files. Report existing unrelated failures separately; do not stage or commit.

Observed constraint: the CC Safety Net blocked direct inspection of a temporary synthetic `.env` fixture. No retry or alternate access was attempted, and no real secret files were accessed. Final E2E avoids reading protected fixtures while Jev is off; synthetic unit tests cover protected targets and off/on behavior.

## Execution Recommendation

Use subagent-driven implementation in serial shared-worktree slices, with independent review after the security-sensitive tasks and a final reviewer pass. The checkout already contains substantial uncommitted user work, so do not use a clean worktree that would omit it; parent must inspect every actual diff and command result.