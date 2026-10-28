# Protected-path policy (revised)

**Status:** Implementation committed locally as `545bc5a1dead34a95ba4f6358044b585133b0505` on `main`, based on `v0.2.3`. `npm run typecheck` and `PI_BIN=pi npm run test:all` passed (264 passed, 1 skipped; local-mock E2E); independent review found no supported blockers. This package `main` is the publish target; other repository source changes remain separate.

This revision supersedes the earlier policy's blanket denial of shell/search/opaque tools and its rule that `/jev off` could not disable the path guard. Earlier approval of those stricter rules no longer applies.

## Goal

Keep ordinary Pi tools usable while protecting selected paths for direct built-in file operations. Make `/jev off` a reliable session kill switch: no Jev decision may block an action after the user turns Jev off.

## Policy

- While Jev is active, built-in `read`, `write`, and `edit` reject `/Users/kerf/.ssh` and descendants, plus exact `.env` basenames at any depth. `.env.local` and other `.env.*` names remain allowed.
- Do not categorically deny `bash`, `powershell`, `ls`, `grep`, `find`, or unknown/opaque tools. Do not add tools to Pi's active tool set. If Pi already exposes a tool, let it continue through the existing Jev gate behavior, including current skip, disabled, shadow, failure, and confirmation settings.
- Do not claim path protection for shell, search, or opaque tools. Jev classification and command heuristics are not a sandbox and cannot reliably detect aliases, obfuscation, indirect file access, or exfiltration. Such tools may read, modify, or send protected paths even while Jev and its gate are enabled.
- Human-entered `!` commands remain outside this extension policy; do not change `user_bash` behavior.
- `/jev off` disables Jev enforcement, including the direct-file guard, for the current session. While off, model calls may use all tools Pi has already enabled and access the protected paths. `/jev on` restores enforcement for new calls. A new session resets the guard active; module activation otherwise follows normal startup/config behavior.
- Turning Jev off invalidates pending Jev decisions. An in-flight classification, confirmation, or filesystem path check must not later block, confirm, steer, or emit a Jev policy error. If Jev is turned back on before that old work completes, the old result remains invalid; only new calls use the re-enabled policy. Cancel or race out pending enforcement work so it does not hold a tool call after off. Native filesystem errors remain. A denial completed before `/jev off` is not retroactively undone.

## Enforcement

- Register the protected-path check before other Jev `tool_call` hooks.
- Keep wrapped built-in `read`/`write`/`edit` definitions and check targets at the filesystem-operation boundary, so hook argument mutation cannot authorize a protected direct-file operation.
- When the kill switch is off, those wrappers must pass operations through without a Jev path-policy denial.
- If wrapped file tools have not finished registering, fail closed for those direct file operations only; do not deny unrelated already-enabled tools solely because registration is incomplete.
- The kill switch must invalidate asynchronous outcomes across the gate and path guard. Use an epoch/cancellation mechanism so an `off` followed by `on` cannot revive stale work. Never claim that cancellation can undo an already completed action or a network request already received by a provider.

## Limits

This is scoped extension-level protection, not an OS sandbox. Protected paths are guarded only for the wrapped built-in `read`/`write`/`edit` operations while Jev is active. Shell/search/opaque tools, trusted extension code that directly accesses the filesystem or replaces effective built-in tool definitions, human shell commands, other processes, hard-link aliases, and concurrent filesystem races remain outside the boundary. `/jev off` intentionally removes all Jev enforcement for the session.

## Compatibility and survival

The intended managed Pi runtime is 1.4.0; the repo development SDK is 0.85.1. Keep implementation on APIs available in both versions and verify against installed runtime. Add no dependencies, global configuration, or separate updater. Update the existing pi-harness Pi-upgrade repair skill from its tracked source and preserve its live symlink.

## Verification

- Unit coverage: `/Users/kerf/.ssh` and descendants denied by direct file tools; exact `.env` denied; `.env.*` allowed; aliases, symlink ancestors, dangling links, malformed paths, nonexistent writes, and later argument mutation.
- Tool coverage: the guard no longer categorically blocks any already-enabled tool; configured gate behavior remains in effect when enabled, and ordinary Pi tool selection is unchanged.
- Kill-switch coverage: `/jev off` disables direct path checks and Jev gate/module enforcement; `/jev on` restores checks for new calls; new sessions restore the guard. Off during classification, confirmation, and filesystem path resolution must release the pending tool call without Jev denial. Off then on before old work resolves must not revive its result. Preserve native filesystem errors.
- Integration: local-mock Pi E2E on installed Pi 1.4.0; no provider requests. Verify direct safe writes and guarded paths, configured gate behavior, active tool selection, and human `!` command behavior remain unchanged.
- Run `npm run typecheck`, `npm run test:all`, and `git diff --check`. No lint script exists in this repo.

## Earlier policy, now superseded

The previous approved version protected the same direct-file targets but also categorically denied shell/search/opaque tools and kept the guard active through `/jev off`. The user later requested a less restrictive blocker and a reliable `/jev off` kill switch. The current policy intentionally narrows the protected-path guarantee to wrapped built-in file tools and explicitly accepts shell/opaque bypass risk rather than pretending Jev is a sandbox.

No tool whitelist, shell parser, OS sandbox, new protected path, or configurable protected-path setting is included in this revision.

## Decision record

User approved advisor recommendation: allow already-enabled tools to flow through existing gate configuration without a categorical protected-path denial; retain `/Users/kerf/.ssh` and exact `.env` checks for wrapped `read`/`write`/`edit`; make `/jev off` invalidate pending Jev outcomes, including across off→on. Security trade-off was stated explicitly: shell/search/opaque tools can access protected paths, and Jev classification cannot guarantee otherwise.

Written-spec review remains pending before implementation planning.

---

Earlier recorded approval: initial global protected-path policy approved by user. This section is retained as history only; its superseded rules are not current behavior.
