/**
 * Module: gate.
 *
 * Hook: `tool_call`. Frequency: high — the only module where volume matters.
 * Risk: high — this one can block work.
 *
 * Including the original user request in the state is the design choice that
 * distinguishes this from every regex-based gate: it makes drift detectable
 * (initial_plan.md §9.2, 9.6).
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { effectiveSkipCommands } from "../config.ts";
import { GATE_INVESTIGATION_QUESTIONS, GATE_QUESTIONS, withRuleQuestions } from "../questions.ts";
import type {
  Answer,
  Answers,
  AskMeta,
  Config,
  Deps,
  GateDecision,
  GateOutcome,
  GateReadOnlyEvidenceTool,
  GateRulesConfig,
} from "../types.ts";
import { ENFORCEMENT_CANCELLED, combineAbortSignals, raceWithAbort } from "../enforcement.ts";
import { formatStatus, hashState } from "../telemetry.ts";

export type GateAnswers = Answers<typeof GATE_QUESTIONS>;

/* -------------------------------------------------------------------------- */
/* Pre-flight skips (initial_plan.md §6.4)                                                 */
/* -------------------------------------------------------------------------- */

const SHELL_OPERATORS = /[|&;<>`$()\n]/;

/**
 * Flags that make an otherwise read-only prefix able to mutate or execute
 * arbitrary code. The allowlist is prefix-based, so `find` would otherwise
 * skip `find . -delete` and `git branch` would skip `git branch -D`. A command
 * carrying any of these is always classified (never skipped).
 */
const DANGEROUS_FLAGS: readonly RegExp[] = [
  /(?:^|\s)-delete(?:\s|$)/, // find -delete
  /(?:^|\s)-exec(?:dir)?(?:\s|$)/, // find -exec / -execdir
  /(?:^|\s)-ok(?:dir)?(?:\s|$)/, // find -ok / -okdir
  /(?:^|\s)--(?:delete|force)(?:\s|=|$)/, // git branch --delete, rm --force
  /(?:^|\s)-[dD](?:\s|$)/, // git branch -d / -D
  /(?:^|\s)--fix(?:-dry-run)?(?:\s|=|$)/, // eslint --fix
  /(?:^|\s)--output(?:\s|=|$)/, // git diff --output=FILE
  /(?:^|\s)-i(?:\s|$)/, // sed -i (defensive; sed is not allowlisted today)
  /(?:^|\s)--in-place(?:\s|=|$)/,
];

/**
 * True when the command is exactly a read-only prefix and contains no chaining,
 * redirection, or flag that turns the prefix into a mutation.
 */
export function isSkippedCommand(command: string, allowlist: readonly string[]): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (SHELL_OPERATORS.test(trimmed)) return false;
  if (DANGEROUS_FLAGS.some((pattern) => pattern.test(trimmed))) return false;
  return allowlist.some((prefix) => {
    if (trimmed === prefix) return true;
    return trimmed.startsWith(`${prefix} `) || trimmed.startsWith(`${prefix}\t`);
  });
}

export function isSkippedTool(tool: string, skipTools: readonly string[]): boolean {
  return skipTools.includes(tool);
}

/* -------------------------------------------------------------------------- */
/* Command normalisation for the on-disk cache                                */
/* -------------------------------------------------------------------------- */

/**
 * Normalizes paths and numbers before they are included in the opaque cache
 * digest. Exact tool input is also included, so changed arguments never share
 * a cache entry because of normalization.
 */
export function normaliseCommand(command: string): string {
  return command
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\?)+/g, "<path>")
    .replace(/(?:\/(?:Users|home|private|var|tmp|opt|srv|etc|Volumes)\/[^\s"'`),;:]*)/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Opaque identity for cached gate answers. Hash full tool input plus gate
 * context and cwd; never persist raw command text.
 */
export function gateCacheKey(tool: string, input: Record<string, unknown>, state: GateState, cwd: string): string {
  return hashState({
    normalizedCommand: normaliseCommand(state.command),
    tool,
    input,
    state,
    cwd,
  });
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export function describeToolInput(tool: string, input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command;
  if (typeof input.path === "string") {
    const extra = JSON.stringify(input).slice(0, 2000);
    return `${tool} ${input.path}\n${extra}`;
  }
  return `${tool} ${JSON.stringify(input).slice(0, 2000)}`;
}

export interface GateState {
  tool: string;
  command: string;
  cwd_basename: string;
  user_request: string;
  recent_commands: string[];
  /** One bounded, redacted read-only result used for Rule 6 re-evaluation. */
  investigation_evidence?: {
    tool: GateReadOnlyEvidenceTool;
    content: string;
    truncated: boolean;
  };
  /** Proposed content for a write/edit, when project rules are being judged. */
  change?: string;
  /** Project rules the change is judged against (indexed to match `rule_N`). */
  project_rules?: Array<{ title: string; body: string; paths?: string[] }>;
}

export interface GateEvidenceResult {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text?: string;
}

export type GateEvidenceObserver = (result: GateEvidenceResult) => void;

interface PendingInvestigation {
  actionKey: string;
  resultConsumed: boolean;
  candidate?: { toolCallId: string; tool: GateReadOnlyEvidenceTool };
  evidence?: NonNullable<GateState["investigation_evidence"]>;
}

const READ_ONLY_EVIDENCE_TOOLS = new Set<GateReadOnlyEvidenceTool>(["read"]);
const MAX_INVESTIGATION_EVIDENCE_BYTES = 4_096;

function isReadOnlyEvidenceTool(tool: string): tool is GateReadOnlyEvidenceTool {
  return READ_ONLY_EVIDENCE_TOOLS.has(tool as GateReadOnlyEvidenceTool);
}

function truncateUtf8(text: string, maxBytes: number): { content: string; truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) return { content: text.slice(0, end), truncated: true };
    bytes += characterBytes;
    end += character.length;
  }
  return { content: text, truncated: false };
}

/* -------------------------------------------------------------------------- */
/* Decision (initial_plan.md §9.4)                                                         */
/* -------------------------------------------------------------------------- */

export function decideGate(answers: GateAnswers, config: Config): GateDecision {
  const t = config.modules.gate.thresholds;
  const blast = answers.blast_radius.score;
  const reversible = answers.reversible.noul;
  const confidence = answers.blast_radius.confidence;
  const intent = answers.matches_intent.noul;
  const secrets = answers.touches_secrets.noul;
  const exfil = answers.exfiltrates.noul;
  const unverified = answers.unverified_code.noul;
  const regenerable = answers.regenerable?.noul ?? 0;
  const installs = answers.installs_software?.noul ?? 0;
  const privileged = answers.privileged_or_remote?.noul ?? 0;

  const numbers = {
    blast_radius: blast,
    reversible,
    confidence,
    matches_intent: intent,
    touches_secrets: secrets,
    exfiltrates: exfil,
    unverified_code: unverified,
    regenerable,
    installs_software: installs,
    privileged_or_remote: privileged,
  };

  if (unverified > t.blockUnverifiedCode) {
    return { outcome: "block", rule: 1, reason: `unverified external code (${unverified.toFixed(2)})`, numbers };
  }
  if (blast >= t.blockBlastRadius && reversible < t.blockReversible) {
    return {
      outcome: "block",
      rule: 2,
      reason: `blast radius ${blast.toFixed(1)}/3 and irreversible (${reversible.toFixed(2)})`,
      numbers,
    };
  }
  if (intent < t.confirmIntentDrift && blast >= t.confirmDriftBlastRadius) {
    return { outcome: "confirm", rule: 3, reason: `outside the original request (${intent.toFixed(2)})`, numbers };
  }
  if (blast >= t.confirmBlastRadius) {
    return {
      outcome: "confirm",
      rule: 4,
      branch: "shared",
      reason: `blast radius ${blast.toFixed(1)}/3`,
      numbers,
    };
  }
  // Added after the first calibration run (initial_plan.md §13.3): a command that is not
  // cleanly reversible and reaches beyond the files being worked on is worth a
  // look even below the shared-resource line — unless it only refreshes
  // regenerable artefacts (a build or a repack), which is friction, not risk.
  if (
    blast >= t.confirmIrreversibleBlastRadius &&
    reversible < t.confirmReversibleFloor &&
    regenerable < t.confirmRegenerableThreshold
  ) {
    return {
      outcome: "confirm",
      rule: 4,
      branch: "irreversible",
      reason: `not cleanly reversible (${reversible.toFixed(2)}) at blast radius ${blast.toFixed(1)}/3`,
      numbers,
    };
  }
  const trustSignals: Array<[string, number, number]> = [
    ["touches secrets", secrets, t.confirmSecrets],
    ["sends data out", exfil, t.confirmExfiltration],
    ["installs software", installs, t.confirmInstallsSoftware],
    ["privileged or remote", privileged, t.confirmPrivilegedOrRemote],
  ];
  const fired = trustSignals.filter(([, value, threshold]) => value > threshold).sort((a, b) => b[1] - a[1])[0];
  if (fired) {
    return { outcome: "confirm", rule: 5, reason: `${fired[0]} (${fired[1].toFixed(2)})`, numbers };
  }
  if (confidence < t.confidenceFloor) {
    return { outcome: "confirm", rule: 6, reason: `unsure about blast radius (confidence ${confidence.toFixed(2)})`, numbers };
  }
  return { outcome: "allow", rule: 7, reason: "within thresholds", numbers };
}

/**
 * Rows 1 and 2 are disabled until `gate.allowBlock` is set after shadow data
 * exists. A disabled block degrades to confirm rather than allow, so nothing is
 * lost from the user's view.
 */
export function enforceBlockPolicy(decision: GateDecision, allowBlock: boolean): GateDecision {
  if (decision.outcome === "block" && !allowBlock) {
    return {
      ...decision,
      outcome: "confirm",
      blockDowngraded: true,
      reason: `${decision.reason} [block disabled → confirm]`,
    };
  }
  return decision;
}

/* -------------------------------------------------------------------------- */
/* Deterministic fast path (initial_plan.md §6.4, TypeSafe: don't ask the      */
/* model what code can decide)                                                */
/* -------------------------------------------------------------------------- */

interface FastPathPattern {
  pattern: RegExp;
  reason: string;
}

/** Unambiguously destructive: block, or mandatory confirm when `block` is off. */
const FAST_PATH_BLOCK: readonly FastPathPattern[] = [
  { pattern: /\brm\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*[rR][A-Za-z]*[fF][A-Za-z]*\s+\/(?:\s|$|\*)/, reason: "recursive delete of the filesystem root" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:disk|sd|nvme|rdisk)/, reason: "raw write to a block device" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\bmkfs(?:\.\w+)?\b/, reason: "filesystem format" },
  { pattern: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i, reason: "destructive SQL" },
];

/** Recoverable or recoverable-with-pain: worth a confirmation even offline. */
const FAST_PATH_CONFIRM: readonly FastPathPattern[] = [
  { pattern: /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/, reason: "force push rewrites remote history" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "hard reset discards local changes" },
  { pattern: /\bgit\s+clean\s+-[A-Za-z]*[fFxXdD]/, reason: "git clean deletes untracked files" },
  { pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/, reason: "piping a remote script into a shell" },
  { pattern: /\b(?:sudo|doas)\b/, reason: "privilege escalation" },
  { pattern: /\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\s+(?:-g|--global)\b/, reason: "global package install" },
  { pattern: /\b(?:kubectl|helm)\s+delete\b/, reason: "cluster resource deletion" },
  { pattern: /\bterraform\s+(?:destroy|apply\s+-auto-approve)\b/, reason: "unattended infrastructure change" },
];

/**
 * Decides obvious commands in code, before any network call. `block` decides
 * whether an unambiguously destructive pattern blocks or degrades to a
 * confirmation that cannot be steered away.
 */
export function matchFastPath(
  command: string,
  block: boolean,
): { outcome: GateOutcome; reason: string; blockDowngraded?: true } | undefined {
  for (const entry of FAST_PATH_BLOCK) {
    if (entry.pattern.test(command)) {
      return block
        ? { outcome: "block", reason: `pattern: ${entry.reason}` }
        : { outcome: "confirm", blockDowngraded: true, reason: `pattern: ${entry.reason}` };
    }
  }
  for (const entry of FAST_PATH_CONFIRM) {
    if (entry.pattern.test(command)) return { outcome: "confirm", reason: `pattern: ${entry.reason}` };
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Project rules (semantic lint of writes/edits)                              */
/* -------------------------------------------------------------------------- */

export interface ParsedRule {
  title: string;
  body: string;
  paths?: string[];
}

/** Splits a Markdown rules file into one rule per heading. */
export function parseRules(markdown: string, max: number): ParsedRule[] {
  const lines = markdown.split("\n");
  const rules: ParsedRule[] = [];
  let current: { title: string; body: string[] } | undefined;
  const flush = () => {
    if (!current || rules.length >= max) return;
    const body = current.body.join("\n").trim();
    const [first, ...rest] = body.split("\n");
    const paths = first?.toLowerCase().startsWith("paths:")
      ? first
          .slice("paths:".length)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined;
    rules.push({ title: current.title, body: paths ? rest.join("\n").trim() : body, ...(paths ? { paths } : {}) });
  };
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      flush();
      if (rules.length >= max) break;
      current = { title: heading[1] as string, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return rules.slice(0, max);
}

/** Reads the configured rules files from `cwd`, ignoring missing ones. */
export function loadRules(cwd: string, config: GateRulesConfig): ParsedRule[] {
  const rules: ParsedRule[] = [];
  for (const file of config.files) {
    if (rules.length >= config.maxRules) break;
    const path = isAbsolute(file) ? file : join(cwd, file);
    try {
      rules.push(...parseRules(readFileSync(path, "utf8"), config.maxRules - rules.length));
    } catch {
      // Missing rules file is normal.
    }
  }
  return rules.slice(0, config.maxRules);
}

function pathMatches(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
    return new RegExp(`^${escaped}$`).test(filePath);
  });
}

/** Rules that apply to this write/edit, honouring an optional `paths:` filter. */
export function rulesForTool(rules: readonly ParsedRule[], input: Record<string, unknown>): ParsedRule[] {
  const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
  return rules.filter((rule) => !rule.paths || (path !== undefined && pathMatches(path, rule.paths)));
}

/** The proposed change, for the classifier. Truncated; it is only state. */
export function describeChange(input: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof input.path === "string") parts.push(`path: ${input.path}`);
  if (typeof input.content === "string") parts.push(input.content);
  if (typeof input.newText === "string") parts.push(input.newText);
  if (typeof input.oldText === "string") parts.push(`(was)\n${input.oldText}`);
  if (parts.length === 0) parts.push(JSON.stringify(input));
  return parts.join("\n").slice(0, 8_000);
}

export interface RuleViolation {
  index: number;
  title: string;
  probability: number;
}

/** Reads the per-rule Noul answers and returns the ones above the threshold. */
export function evaluateRuleViolations(
  answers: Record<string, Answer | undefined>,
  rules: readonly ParsedRule[],
  config: GateRulesConfig,
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  rules.forEach((rule, index) => {
    const answer = answers[`rule_${index}`];
    if (answer?.type === "noul" && answer.noul > config.violationThreshold) {
      violations.push({ index, title: rule.title, probability: answer.noul });
    }
  });
  return violations;
}

/** Escalates a decision when rules were violated; never downgrades a block. */
export function escalateForRules(
  decision: GateDecision,
  violations: readonly RuleViolation[],
  config: GateRulesConfig,
): GateDecision {
  if (violations.length === 0 || decision.outcome === "block") return decision;
  const top = [...violations].sort((a, b) => b.probability - a.probability)[0] as RuleViolation;
  const numbers = { rule_violation: top.probability, rule_index: top.index };
  const reason = `project rule "${top.title}" (${top.probability.toFixed(2)})`;
  if (config.onViolation === "block") {
    return { outcome: "block", rule: 0, branch: "rules", reason, numbers };
  }
  return {
    outcome: "confirm",
    rule: 0,
    branch: "rules",
    steer: config.onViolation === "steer",
    ...(decision.blockDowngraded ? { blockDowngraded: true } : {}),
    reason,
    numbers,
  };
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

export function register(pi: ExtensionAPI, deps: Deps): GateEvidenceObserver {
  let userRequest = "";
  const recentCommands: string[] = [];
  let rules: ParsedRule[] = [];
  let investigationUsed = false;
  let investigationActionKey: string | undefined;
  let investigationDecision: GateDecision | undefined;
  let investigationRecheckDecision: GateDecision | undefined;
  let investigationRecheckInFlight = false;
  let pendingInvestigation: PendingInvestigation | undefined;

  const resetInvestigation = () => {
    investigationUsed = false;
    investigationActionKey = undefined;
    investigationDecision = undefined;
    investigationRecheckDecision = undefined;
    investigationRecheckInFlight = false;
    pendingInvestigation = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    resetInvestigation();
    rules = deps.config.modules.gate.rules.enabled ? loadRules(ctx.cwd, deps.config.modules.gate.rules) : [];
  });

  pi.on("agent_settled", resetInvestigation);

  pi.on("before_agent_start", (event) => {
    userRequest = event.prompt;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!deps.config.modules.gate.enabled || !deps.state.layerEnabled) return;
    const scope = deps.enforcement.callScope(event.toolCallId) ?? deps.enforcement.capture();
    if (!deps.enforcement.isCurrent(scope)) return;
    const tool = event.toolName;
    const config = deps.config.modules.gate;
    const shadow = deps.state.shadow.gate;
    const pilotEnabled = config.lowConfidenceMode === "investigate-once" && !shadow;
    if (isSkippedTool(tool, config.skipTools)) {
      if (
        pilotEnabled &&
        pendingInvestigation &&
        !pendingInvestigation.resultConsumed &&
        !pendingInvestigation.candidate &&
        !pendingInvestigation.evidence &&
        isReadOnlyEvidenceTool(tool)
      ) {
        pendingInvestigation.candidate = { toolCallId: event.toolCallId, tool };
      }
      return;
    }

    const input = event.input as Record<string, unknown>;
    const command = describeToolInput(tool, input);
    if (typeof input.command === "string" && isSkippedCommand(input.command, effectiveSkipCommands(config))) {
      return;
    }

    const actionKey = hashState({
      session: deps.state.sessionId ?? "",
      request: userRequest,
      cwd: ctx.cwd,
      tool,
      input,
    });
    let evidenceForRecheck: GateState["investigation_evidence"];
    let rechecking = false;
    let duplicateRecheck = false;
    let missingEvidence = false;
    if (!pilotEnabled) pendingInvestigation = undefined;
    if (pilotEnabled && investigationUsed && actionKey === investigationActionKey) {
      if (investigationRecheckInFlight) {
        duplicateRecheck = true;
      } else if (pendingInvestigation?.actionKey === actionKey && pendingInvestigation.evidence) {
        evidenceForRecheck = pendingInvestigation.evidence;
        rechecking = true;
        investigationRecheckInFlight = true;
      } else {
        missingEvidence = true;
      }
    }
    pendingInvestigation = undefined;

    const applicableRules = config.rules.enabled ? rulesForTool(rules, input) : [];
    const state: GateState = {
      tool,
      command,
      cwd_basename: basename(ctx.cwd),
      user_request: userRequest,
      recent_commands: [...recentCommands],
    };
    if (evidenceForRecheck) state.investigation_evidence = evidenceForRecheck;
    if (applicableRules.length > 0) {
      state.change = describeChange(input);
      state.project_rules = applicableRules.map((rule) => ({
        title: rule.title,
        body: rule.body,
        paths: rule.paths,
      }));
    }
    recentCommands.push(command);
    while (recentCommands.length > 3) recentCommands.shift();

    // Deterministic fast path first: obvious commands never need Jev, which
    // also means the gate protects a session with no API key.
    const fast = config.fastPath.enabled ? matchFastPath(command, config.fastPath.block) : undefined;

    let computed: GateDecision;
    let meta: AskMeta | undefined;
    let answers: Record<string, Answer | undefined> | undefined;
    let forceRule6Ask = false;
    let forceInvestigationBlock = false;

    if (duplicateRecheck && investigationDecision) {
      computed = {
        ...investigationDecision,
        outcome: "block",
        reason: "low-confidence Rule 6 re-evaluation is already in progress",
      };
    } else if (missingEvidence && investigationDecision) {
      if (investigationRecheckDecision?.outcome === "block") {
        computed = investigationRecheckDecision;
      } else {
        computed = {
          ...investigationDecision,
          outcome: "confirm",
          reason: "low-confidence Rule 6 remains unresolved: no usable read-only evidence",
        };
        forceRule6Ask = true;
      }
    } else if (fast) {
      computed = enforceBlockPolicy(
        {
          outcome: fast.outcome,
          rule: 0,
          branch: "fastpath",
          ...(fast.blockDowngraded ? { blockDowngraded: true } : {}),
          reason: fast.reason,
          numbers: {},
        },
        config.allowBlock,
      );
    } else {
      const gateQuestions = evidenceForRecheck ? GATE_INVESTIGATION_QUESTIONS : GATE_QUESTIONS;
      const questions = withRuleQuestions(
        gateQuestions,
        applicableRules.map((_rule, index) => ({ key: `rule_${index}`, index })),
      );
      const result = await deps.ask("gate", state, questions, {
        signal: ctx.signal,
        scope,
        cacheKey: gateCacheKey(tool, input, state, ctx.cwd),
      });
      if (result === ENFORCEMENT_CANCELLED || !deps.enforcement.isCurrent(scope)) {
        if (rechecking) investigationRecheckInFlight = false;
        return;
      }
      if (!result) {
        if (rechecking && investigationDecision) {
          computed = {
            ...investigationDecision,
            outcome: "confirm",
            reason: "low-confidence Rule 6 remains unresolved: re-evaluation unavailable",
          };
          forceRule6Ask = true;
        } else {
          return failOpen(deps, tool, command);
        }
      } else {
        meta = result.meta;
        answers = result.answers as Record<string, Answer | undefined>;
        computed = enforceBlockPolicy(
          decideGate(result.answers as unknown as GateAnswers, deps.config),
          config.allowBlock,
        );
        if (applicableRules.length > 0) {
          computed = escalateForRules(
            computed,
            evaluateRuleViolations(answers, applicableRules, config.rules),
            config.rules,
          );
        }
      }
    }
    if (rechecking) {
      investigationRecheckInFlight = false;
      investigationRecheckDecision = computed;
    }

    if (pilotEnabled && !investigationUsed && computed.outcome === "confirm" && computed.rule === 6) {
      investigationUsed = true;
      investigationActionKey = actionKey;
      investigationDecision = computed;
      pendingInvestigation = { actionKey, resultConsumed: false };
      forceInvestigationBlock = true;
    } else if (pilotEnabled && investigationUsed && computed.outcome === "confirm" && computed.rule === 6) {
      forceRule6Ask = true;
    }

    let enforced: GateOutcome | "steer" = shadow ? "allow" : computed.outcome;
    let userChoice: "allow" | "deny" | "unknown" | undefined;
    let blockReason: string | undefined;
    let steerReason: string | undefined;

    if (!shadow && forceInvestigationBlock) {
      enforced = "block";
      blockReason = "low-confidence Rule 6; inspect with one read-only tool, then retry this exact action once";
    } else if (!shadow && computed.steer && !computed.blockDowngraded) {
      enforced = "steer";
      steerReason = computed.reason;
    } else if (!shadow && computed.outcome === "confirm") {
      if (config.confirmMode === "steer" && !computed.blockDowngraded && !forceRule6Ask) {
        enforced = "steer";
        steerReason = computed.reason;
      } else if (ctx.hasUI && !(forceRule6Ask && ctx.signal?.aborted)) {
        const redactPreview = ctx.mode === "tui" ? deps.redactLocalPreview : deps.redactPreview;
        const preview =
          typeof input.command === "string"
            ? `${tool}\n${redactPreview(input.command)}`
            : `${tool}\n${JSON.stringify(redactPreview.deep(input), null, 2)}`;
        const displayPreview =
          ctx.mode === "tui"
            ? preview.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, (character) =>
                `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
              )
            : preview;
        const confirmSignal = combineAbortSignals(ctx.signal, scope.signal);
        const confirmed = await raceWithAbort(
          ctx.ui.confirm("Jev: confirm", confirmMessage(computed, displayPreview), { signal: confirmSignal }),
          confirmSignal,
        );
        if (confirmed === ENFORCEMENT_CANCELLED || !deps.enforcement.isCurrent(scope)) {
          if (rechecking) investigationRecheckInFlight = false;
          return;
        }
        const ok = confirmed;
        userChoice = ok ? "allow" : "deny";
        enforced = ok ? "allow" : "block";
        if (!ok) blockReason = `blocked by user: ${computed.reason}`;
      } else {
        // print/json mode: no prompts (initial_plan.md §14, mode behaviour).
        userChoice = "unknown";
        if (forceRule6Ask || config.withoutUi === "deny") {
          enforced = "block";
          blockReason = ctx.signal?.aborted
            ? `re-evaluation interrupted: ${computed.reason}`
            : `no UI to confirm: ${computed.reason}`;
        } else {
          enforced = "allow";
        }
      }
    } else if (!shadow && computed.outcome === "block") {
      blockReason = computed.reason;
    }

    const record = {
      hook: "gate" as const,
      questionsVersion: "",
      stateHash: meta?.stateHash ?? "",
      // Evidence is sent to Jev for re-evaluation but never persisted in gate logs.
      state: evidenceForRecheck ? undefined : meta?.redactedState,
      tool,
      answers,
      decision: enforced,
      shadow,
      wouldHaveBeen: computed.outcome,
      userChoice,
      latencyMs: meta?.latencyMs ?? 0,
      cached: meta?.cached ?? false,
      usage: meta?.usage,
      answeredModel: meta?.answeredModel,
      reason: computed.reason,
      detail: {
        rule: computed.rule,
        branch: computed.branch,
        numbers: computed.numbers,
        fastPath: Boolean(fast),
        // Redacted: telemetry and the durable transcript must not persist
        // credentials that appeared in the command (logStateContent only
        // governs the `state` field, not `detail`).
        command: deps.redact(command).slice(0, 500),
      },
    };
    deps.log(record);
    deps.appendEntry(record);
    deps.state.last.gate = record;
    deps.status(formatStatus(deps.state, deps.config));

    if (steerReason) {
      pi.sendMessage(
        {
          customType: "jev-gate",
          content:
            `Jev: ${steerReason}. Command: ${command.split("\n")[0]} — ` +
            "reconsider before proceeding, or explain why it is intended.",
          display: true,
        },
        { deliverAs: "steer" },
      );
    }
    if (blockReason) {
      deps.enforcement.releaseCall(event.toolCallId);
      return { block: true, reason: `Jev: ${blockReason}` };
    }
    return;
  });

  return (result) => {
    const pending = pendingInvestigation;
    const candidate = pending?.candidate;
    if (!pending || !candidate || candidate.toolCallId !== result.toolCallId || candidate.tool !== result.toolName) {
      return;
    }
    delete pending.candidate;
    pending.resultConsumed = true;
    if (
      deps.config.modules.gate.lowConfidenceMode !== "investigate-once" ||
      deps.state.shadow.gate ||
      !deps.state.layerEnabled ||
      result.isError ||
      typeof result.text !== "string"
    ) {
      return;
    }
    let redacted: string;
    try {
      redacted = deps.redact(result.text);
    } catch {
      return;
    }
    if (redacted.trim().length === 0) return;
    const bounded = truncateUtf8(redacted, MAX_INVESTIGATION_EVIDENCE_BYTES);
    if (bounded.content.trim().length === 0) return;
    pending.evidence = { tool: candidate.tool, content: bounded.content, truncated: bounded.truncated };
  };
}

function failOpen(deps: Deps, tool: string, command: string): { block: true; reason: string } | void {
  const config = deps.config.modules.gate;
  const shadow = deps.state.shadow.gate;
  const deny = !shadow && config.onFailure === "deny";
  deps.log({
    hook: "gate",
    questionsVersion: "",
    stateHash: "",
    tool,
    decision: deny ? "block" : "allow",
    shadow,
    wouldHaveBeen: "fail_open",
    reason: "classification unavailable",
    detail: { command: deps.redact(command).slice(0, 500) },
  });
  deps.status(formatStatus(deps.state, deps.config));
  if (deny) return { block: true, reason: "Jev: classification unavailable and gate.onFailure=deny" };
  return;
}

const MAX_CONFIRM_PREVIEW_CHARS = 2_000;

/** The auditable prompt: decision reason and bounded action preview. */
export function confirmMessage(decision: GateDecision, preview: string): string {
  const visiblePreview =
    preview.length > MAX_CONFIRM_PREVIEW_CHARS
      ? `${preview.slice(0, MAX_CONFIRM_PREVIEW_CHARS)}\n[preview truncated after ${MAX_CONFIRM_PREVIEW_CHARS} characters]`
      : preview;
  return `${decision.reason}\nAction preview (redacted):\n${visiblePreview}\nAllow?`;
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
