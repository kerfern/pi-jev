import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  access as fsAccess,
  lstat,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readlink as fsReadlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";
import { ENFORCEMENT_CANCELLED, raceWithAbort } from "./enforcement.ts";
import type { EnforcementEpoch, EnforcementScope } from "./enforcement.ts";

const SSH_ROOT = "/Users/kerf/.ssh";
const DENIED_MESSAGE = "pi-jev protected-path policy denied this model tool call";
const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;
const ALLOWED_FILE_TOOLS = new Set(["read", "write", "edit"]);
const MAX_SYMLINKS = 40;

export interface ProtectedPathLookup {
  lstat(path: string): Promise<Stats>;
  readlink(path: string): Promise<string>;
}

const defaultLookup: ProtectedPathLookup = {
  lstat,
  readlink: (path) => fsReadlink(path, { encoding: "utf8" }),
};

class ProtectedPathError extends Error {
  constructor() {
    super(DENIED_MESSAGE);
    this.name = "ProtectedPathError";
  }
}

interface ResolvedTarget {
  path: string;
  isDirectory: boolean;
}

interface CallScopeContext {
  scope: EnforcementScope;
  cwd: string;
}

function isSameOrDescendant(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function isWithinSshRoot(filePath: string): boolean {
  return isAbsolute(filePath) && isSameOrDescendant(resolve(filePath), SSH_ROOT);
}

/** Lexical check for the literal protected root and exact `.env` basenames. */
export function isProtectedPath(filePath: string, isDirectory = false): boolean {
  if (!isAbsolute(filePath) || filePath.includes("\0")) return true;
  const normalized = resolve(filePath);
  return isSameOrDescendant(normalized, SSH_ROOT) || (!isDirectory && basename(normalized) === ".env");
}

function resolveInputPath(inputPath: unknown, cwd: string): string {
  if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.includes("\0")) {
    throw new ProtectedPathError();
  }

  let normalized = inputPath.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = resolve(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      throw new ProtectedPathError();
    }
  }
  if (normalized.includes("\0")) throw new ProtectedPathError();
  // Pi's built-in file tools resolve relative paths against cwd before accessing the filesystem.
  return resolve(cwd, normalized);
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

function pathFromParts(root: string, parts: readonly string[]): string {
  return parts.length === 0 ? root : join(root, ...parts);
}

function splitAbsolutePath(filePath: string): { root: string; parts: string[] } {
  const root = parse(filePath).root;
  return { root, parts: filePath.slice(root.length).split(sep).filter(Boolean) };
}

/** Resolve symlink targets component-wise so their `..` segments follow links first. */
async function resolveTarget(filePath: string, lookup: ProtectedPathLookup): Promise<ResolvedTarget> {
  const initial = splitAbsolutePath(filePath);
  let root = initial.root;
  let parts: string[] = [];
  let pending = initial.parts;
  let missing = false;
  let stats: Stats | undefined;
  let symlinkCount = 0;

  while (pending.length > 0) {
    const component = pending.shift()!;
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (missing) return { path: pathFromParts(root, parts), isDirectory: false };
      if (parts.length > 0) parts.pop();
      stats = undefined;
      continue;
    }

    parts.push(component);
    const candidate = pathFromParts(root, parts);
    // Never stat or readlink inside protected SSH root.
    if (isWithinSshRoot(candidate)) throw new ProtectedPathError();
    if (missing) {
      stats = undefined;
      continue;
    }

    let current: Stats;
    try {
      current = await lookup.lstat(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        missing = true;
        stats = undefined;
        continue;
      }
      // Preserve native EACCES, ENOTDIR, ELOOP, and other lookup failures.
      return { path: candidate, isDirectory: false };
    }

    if (current.isSymbolicLink()) {
      symlinkCount += 1;
      if (symlinkCount > MAX_SYMLINKS) return { path: candidate, isDirectory: false };
      let target: string;
      try {
        target = await lookup.readlink(candidate);
      } catch {
        return { path: candidate, isDirectory: false };
      }

      parts.pop();
      stats = undefined;
      if (isAbsolute(target)) {
        const targetPath = splitAbsolutePath(target);
        root = targetPath.root;
        parts = [];
        pending = [...targetPath.parts, ...pending];
      } else {
        pending = [...target.split(sep).filter(Boolean), ...pending];
      }
      continue;
    }

    stats = current;
    if (pending.length > 0 && !current.isDirectory()) return { path: candidate, isDirectory: false };
  }

  const finalPath = pathFromParts(root, parts);
  if (missing) return { path: finalPath, isDirectory: false };
  if (!stats) {
    try {
      stats = await lookup.lstat(finalPath);
    } catch {
      return { path: finalPath, isDirectory: false };
    }
  }
  return { path: finalPath, isDirectory: stats.isDirectory() };
}

async function assertSafePath(filePath: string, lookup: ProtectedPathLookup, targetIsDirectory = false): Promise<void> {
  if (!isAbsolute(filePath) || filePath.includes("\0")) throw new ProtectedPathError();
  if (isWithinSshRoot(filePath)) throw new ProtectedPathError();

  const target = await resolveTarget(filePath, lookup);
  const isDirectory = targetIsDirectory || target.isDirectory;
  if (isProtectedPath(filePath, isDirectory) || isProtectedPath(target.path, isDirectory)) {
    throw new ProtectedPathError();
  }
}

function inputPath(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProtectedPathError();
  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string") throw new ProtectedPathError();
  return path;
}

function denied() {
  return { block: true, reason: DENIED_MESSAGE } as const;
}

export function register(
  pi: ExtensionAPI,
  isEnabled: () => boolean,
  enforcement: EnforcementEpoch,
  lookup: ProtectedPathLookup = defaultLookup,
): void {
  let toolsReady = false;
  const scopeStorage = new AsyncLocalStorage<CallScopeContext>();

  const assertSafePathIfCurrent = async (
    filePath: string,
    cwd: string,
    scope: EnforcementScope,
    targetIsDirectory = false,
    operationPath = false,
  ): Promise<void> => {
    if (!isEnabled() || !enforcement.isCurrent(scope)) return;
    const absolutePath = operationPath ? filePath : resolveInputPath(filePath, cwd);
    try {
      const result = await raceWithAbort(assertSafePath(absolutePath, lookup, targetIsDirectory), scope.signal);
      if (result === ENFORCEMENT_CANCELLED || !enforcement.isCurrent(scope)) return;
    } catch (error) {
      if (!enforcement.isCurrent(scope)) return;
      throw error;
    }
  };

  const withCallScope = async <T>(
    toolCallId: string,
    filePath: string,
    cwd: string,
    execute: () => Promise<T>,
  ): Promise<T> => {
    const scope = enforcement.callScope(toolCallId) ?? enforcement.captureCall(toolCallId);
    try {
      await assertSafePathIfCurrent(filePath, cwd, scope);
      return await scopeStorage.run({ scope, cwd }, execute);
    } finally {
      enforcement.releaseCall(toolCallId);
    }
  };

  const assertOperationPath = async (filePath: string, targetIsDirectory = false): Promise<void> => {
    const context = scopeStorage.getStore();
    if (!context) return;
    await assertSafePathIfCurrent(filePath, context.cwd, context.scope, targetIsDirectory, true);
  };

  pi.on("tool_call", async (event, ctx) => {
    if (!ALLOWED_FILE_TOOLS.has(event.toolName)) return;
    const scope = enforcement.captureCall(event.toolCallId);
    if (!isEnabled()) return;
    if (!toolsReady) {
      enforcement.releaseCall(event.toolCallId);
      return denied();
    }

    try {
      await assertSafePathIfCurrent(inputPath(event.input), ctx.cwd, scope);
      return;
    } catch (error) {
      enforcement.releaseCall(event.toolCallId);
      if (error instanceof ProtectedPathError) return denied();
      // Let Pi's native operation report ordinary lookup failures.
      return;
    }
  });

  pi.on("tool_result", (event) => {
    enforcement.releaseCall(event.toolCallId);
  });

  pi.on("tool_execution_end", (event) => {
    enforcement.releaseCall(event.toolCallId);
  });

  pi.on("session_start", (_event, ctx) => {
    toolsReady = false;
    // registerTool refreshes the live registry; restore the user's exact tool selection afterward.
    const activeTools = pi.getActiveTools();

    try {
      const readTool = createReadToolDefinition(ctx.cwd, {
        operations: {
          access: async (path) => {
            await assertOperationPath(path);
            await fsAccess(path, constants.R_OK);
          },
          readFile: async (path) => {
            await assertOperationPath(path);
            return fsReadFile(path);
          },
          detectImageMimeType: async (path) => {
            await assertOperationPath(path);
            return detectSupportedImageMimeTypeFromFile(path);
          },
        },
      });
      // Guard requested and resolved paths; resolved checks also catch Pi filename variants.
      const executeRead = readTool.execute;
      readTool.execute = async (toolCallId, params, signal, onUpdate, toolCtx) => {
        const requestedPath = params.path;
        const cwd = toolCtx?.cwd || ctx.cwd;
        return withCallScope(toolCallId, requestedPath, cwd, () =>
          executeRead(toolCallId, { ...params, path: requestedPath }, signal, onUpdate, toolCtx),
        );
      };

      const writeTool = createWriteToolDefinition(ctx.cwd, {
        operations: {
          mkdir: async (path) => {
            await assertOperationPath(path, true);
            await fsMkdir(path, { recursive: true });
          },
          writeFile: async (path, content) => {
            await assertOperationPath(path);
            await fsWriteFile(path, content, "utf8");
          },
        },
      });
      const executeWrite = writeTool.execute;
      writeTool.execute = async (toolCallId, params, signal, onUpdate, toolCtx) => {
        const requestedPath = params.path;
        const cwd = toolCtx?.cwd || ctx.cwd;
        return withCallScope(toolCallId, requestedPath, cwd, () =>
          executeWrite(toolCallId, { ...params, path: requestedPath }, signal, onUpdate, toolCtx),
        );
      };

      const editTool = createEditToolDefinition(ctx.cwd, {
        operations: {
          access: async (path) => {
            await assertOperationPath(path);
            await fsAccess(path, constants.R_OK | constants.W_OK);
          },
          readFile: async (path) => {
            await assertOperationPath(path);
            return fsReadFile(path);
          },
          writeFile: async (path, content) => {
            await assertOperationPath(path);
            return fsWriteFile(path, content, "utf8");
          },
        },
      });
      const executeEdit = editTool.execute;
      editTool.execute = async (toolCallId, params, signal, onUpdate, toolCtx) => {
        const requestedPath = params.path;
        const cwd = toolCtx?.cwd || ctx.cwd;
        return withCallScope(toolCallId, requestedPath, cwd, () =>
          executeEdit(toolCallId, { ...params, path: requestedPath }, signal, onUpdate, toolCtx),
        );
      };

      pi.registerTool(readTool);
      pi.registerTool(writeTool);
      pi.registerTool(editTool);
    } finally {
      pi.setActiveTools(activeTools);
    }

    toolsReady = true;
  });
}
