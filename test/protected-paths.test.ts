import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { lstat as fsLstat, mkdir, readlink as fsReadlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { isProtectedPath, register } from "../src/protected-paths.ts";
import type { ProtectedPathLookup } from "../src/protected-paths.ts";
import { EnforcementEpoch } from "../src/enforcement.ts";
import { register as registerGate } from "../src/modules/gate.ts";
import { makeConfig, makeDeps } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type TestTool = {
  name: string;
  execute: (
    toolCallId: string,
    input: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
};

function harness(
  cwd: string,
  initialTools: string[] = ["read", "write", "edit", "bash", "ls", "grep", "find"],
  isEnabled: () => boolean = () => true,
  lookup?: ProtectedPathLookup,
) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, unknown>();
  const activeTools = [...initialTools];
  const activeToolSnapshots: string[][] = [];
  const enforcement = new EnforcementEpoch();
  const pi = {
    on(event: string, handler: Handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(next: string[]) {
      activeTools.splice(0, activeTools.length, ...next);
      activeToolSnapshots.push([...next]);
    },
  } as unknown as ExtensionAPI;
  register(pi, isEnabled, enforcement, lookup);
  return { pi, handlers, tools, activeTools, activeToolSnapshots, cwd, enforcement };
}

async function emit(
  handlers: Map<string, Handler[]>,
  eventName: string,
  event: unknown,
  ctx: unknown,
): Promise<unknown> {
  for (const handler of handlers.get(eventName) ?? []) {
    const result = await handler(event, ctx);
    if (result && typeof result === "object" && "block" in result && result.block === true) return result;
  }
  return undefined;
}

function tool(h: ReturnType<typeof harness>, name: string): TestTool {
  const registered = h.tools.get(name);
  if (!registered) throw new Error(`Missing registered tool ${name}`);
  return registered as TestTool;
}

async function start(h: ReturnType<typeof harness>): Promise<void> {
  await emit(h.handlers, "session_start", { type: "session_start", reason: "startup" }, { cwd: h.cwd });
}

const call = (h: ReturnType<typeof harness>, name: string, input: unknown) =>
  emit(
    h.handlers,
    "tool_call",
    { type: "tool_call", toolCallId: "test-call", toolName: name, input },
    { cwd: h.cwd },
  );

describe("protected-path policy", () => {
  let roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots = [];
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pi-jev-protected-paths-"));
    roots.push(root);
    return root;
  }

  it("protects exact .env basenames and the literal SSH root with path boundaries", () => {
    expect(isProtectedPath("/Users/kerf/.ssh")).toBe(true);
    expect(isProtectedPath("/Users/kerf/.ssh/id_ed25519")).toBe(true);
    expect(isProtectedPath("/Users/kerf/.ssh-copy/id_ed25519")).toBe(false);
    expect(isProtectedPath("/tmp/project/.env")).toBe(true);
    expect(isProtectedPath("/tmp/project/.env", true)).toBe(false);
    expect(isProtectedPath("/tmp/project/nested/.env")).toBe(true);
    expect(isProtectedPath("/tmp/project/.env.local")).toBe(false);
    expect(isProtectedPath("/tmp/project/.envrc")).toBe(false);
  });

  it("bypasses tool-call and filesystem checks while disabled, then restores them", async () => {
    const root = await tempRoot();
    const envFile = join(root, ".env");
    await writeFile(envFile, "original");
    let enabled = true;
    const h = harness(root, undefined, () => enabled);
    await start(h);
    enabled = false;

    await expect(call(h, "bash", { command: "git status" })).resolves.toBeUndefined();
    await expect(call(h, "mcp__opaque_tool", {})).resolves.toBeUndefined();
    await expect(call(h, "read", { path: envFile })).resolves.toBeUndefined();
    await expect(
      tool(h, "read").execute("read", { path: envFile }, undefined, undefined, { cwd: root }),
    ).resolves.toBeTruthy();
    await expect(
      tool(h, "write").execute(
        "write",
        { path: envFile, content: "off-write" },
        undefined,
        undefined,
        { cwd: root },
      ),
    ).resolves.toBeTruthy();
    await expect(
      tool(h, "edit").execute(
        "edit",
        { path: envFile, edits: [{ oldText: "off-write", newText: "off-edit" }] },
        undefined,
        undefined,
        { cwd: root },
      ),
    ).resolves.toBeTruthy();
    await expect(readFile(envFile, "utf8")).resolves.toBe("off-edit");

    enabled = true;
    await expect(call(h, "bash", { command: "git status" })).resolves.toBeUndefined();
    await expect(call(h, "read", { path: envFile })).resolves.toMatchObject({ block: true });
    await expect(
      tool(h, "write").execute(
        "write",
        { path: envFile, content: "blocked" },
        undefined,
        undefined,
        { cwd: root },
      ),
    ).rejects.toThrow("pi-jev protected-path policy denied this model tool call");
  });

  it("leaves non-file tools to existing gate hooks", async () => {
    const root = await tempRoot();
    const h = harness(root);
    await start(h);
    let downstreamCalls = 0;
    h.handlers.get("tool_call")?.push(() => {
      downstreamCalls += 1;
    });
    for (const name of ["bash", "powershell", "ls", "grep", "find", "mcp__opaque_tool"]) {
      await expect(call(h, name, { command: "touch marker" })).resolves.toBeUndefined();
    }
    expect(downstreamCalls).toBe(6);
    await expect(call(h, "read", { path: join(root, "safe.txt") })).resolves.toBeUndefined();
    expect(downstreamCalls).toBe(7);
  });

  it("fails closed only for direct file tools before wrapper registration", async () => {
    const root = await tempRoot();
    const h = harness(root);
    let downstreamCalls = 0;
    h.handlers.get("tool_call")?.push(() => {
      downstreamCalls += 1;
    });

    await expect(call(h, "bash", { command: "git status" })).resolves.toBeUndefined();
    await expect(call(h, "mcp__opaque_tool", {})).resolves.toBeUndefined();
    await expect(call(h, "read", { path: join(root, "safe.txt") })).resolves.toMatchObject({ block: true });
    expect(downstreamCalls).toBe(2);
  });

  it("keeps the active tool set unchanged when registering wrappers, including no-tools", async () => {
    for (const initial of [["read", "bash"], []]) {
      const root = await tempRoot();
      const h = harness(root, initial);
      await start(h);
      expect(h.activeTools).toEqual(initial);
      expect(h.activeToolSnapshots.at(-1)).toEqual(initial);
      expect(h.tools.has("read")).toBe(true);
      expect(h.tools.has("write")).toBe(true);
      expect(h.tools.has("edit")).toBe(true);
    }
  });

  it("normalizes tilde, @, and file-URL paths before the Jev gate", async () => {
    const root = await tempRoot();
    const h = harness(root);
    await start(h);
    const protectedPaths = [
      "~/.env",
      "@/Users/kerf/.ssh/id_ed25519",
      `file://${join(root, ".env")}`,
      ".env",
      `${root}/nested/../.env`,
    ];

    for (const path of protectedPaths) {
      await expect(call(h, "read", { path })).resolves.toMatchObject({ block: true });
    }
  });

  it("denies .env reads, writes, and edits without changing file contents", async () => {
    const root = await tempRoot();
    const envFile = join(root, ".env");
    await writeFile(envFile, "original\n");
    const h = harness(root);
    await start(h);

    await expect(tool(h, "read").execute("read", { path: envFile }, undefined, undefined, { cwd: root })).rejects.toThrow(
      /protected/i,
    );
    await expect(
      tool(h, "write").execute("write", { path: envFile, content: "overwritten\n" }, undefined, undefined, { cwd: root }),
    ).rejects.toThrow("pi-jev protected-path policy denied this model tool call");
    await expect(
      tool(h, "edit").execute(
        "edit",
        { path: envFile, edits: [{ oldText: "original", newText: "edited" }] },
        undefined,
        undefined,
        { cwd: root },
      ),
    ).rejects.toThrow("pi-jev protected-path policy denied this model tool call");
    await expect(readFile(envFile, "utf8")).resolves.toBe("original\n");
  });

  it("allows .env.* and non-protected writes", async () => {
    const root = await tempRoot();
    const h = harness(root);
    await start(h);

    await expect(
      tool(h, "write").execute("write", { path: ".env.local", content: "allowed\n" }, undefined, undefined, { cwd: root }),
    ).resolves.toBeTruthy();
    await expect(readFile(join(root, ".env.local"), "utf8")).resolves.toBe("allowed\n");
    await expect(
      tool(h, "write").execute("write", { path: "nested/file.txt", content: "safe\n" }, undefined, undefined, { cwd: root }),
    ).resolves.toBeTruthy();
    await expect(readFile(join(root, "nested/file.txt"), "utf8")).resolves.toBe("safe\n");
  });

  it("follows symlink aliases, rejects dangling links, and permits safe aliases", async () => {
    const root = await tempRoot();
    const envFile = join(root, ".env");
    const safeFile = join(root, "safe.txt");
    const envAlias = join(root, "env-alias");
    const safeAlias = join(root, "safe-alias");
    const dangling = join(root, "dangling");
    await writeFile(envFile, "secret\n");
    await writeFile(safeFile, "safe\n");
    await symlink(envFile, envAlias);
    await symlink(safeFile, safeAlias);
    await symlink(join(root, "missing-target"), dangling);

    const h = harness(root);
    await start(h);

    await expect(tool(h, "read").execute("read", { path: envAlias }, undefined, undefined, { cwd: root })).rejects.toThrow(
      /protected/i,
    );
    await expect(tool(h, "read").execute("read", { path: dangling }, undefined, undefined, { cwd: root })).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(tool(h, "read").execute("read", { path: safeAlias }, undefined, undefined, { cwd: root })).resolves.toBeTruthy();
    await expect(
      tool(h, "write").execute("write", { path: safeAlias, content: "updated\n" }, undefined, undefined, { cwd: root }),
    ).resolves.toBeTruthy();
    await expect(readFile(envFile, "utf8")).resolves.toBe("secret\n");
    await expect(readFile(safeFile, "utf8")).resolves.toBe("updated\n");
  });

  it("protects targets reached through relative symlinks and symlink ancestors", async () => {
    const root = await tempRoot();
    const envFile = join(root, ".env");
    const envAlias = join(root, "relative-env-alias");
    const directoryAlias = join(root, "project-alias");
    await writeFile(envFile, "secret\n");
    await symlink(".env", envAlias);
    await symlink(root, directoryAlias);
    const h = harness(root);
    await start(h);

    await expect(tool(h, "read").execute("read", { path: envAlias }, undefined, undefined, { cwd: root })).rejects.toThrow(
      "pi-jev protected-path policy denied this model tool call",
    );
    await expect(
      tool(h, "write").execute(
        "write",
        { path: join(directoryAlias, ".env"), content: "must not overwrite\n" },
        undefined,
        undefined,
        { cwd: root },
      ),
    ).rejects.toThrow("pi-jev protected-path policy denied this model tool call");
    await expect(readFile(envFile, "utf8")).resolves.toBe("secret\n");
  });

  it("resolves symlink-target dot-dot only after following preceding symlinks", async () => {
    const root = await tempRoot();
    const redirect = join(root, "redirect");
    const alias = join(root, "alias");
    await symlink("/Users/kerf/.ssh/subdir", redirect);
    await symlink("redirect/../id_ed25519", alias);
    const protectedLookups: string[] = [];
    const lookup: ProtectedPathLookup = {
      lstat: async (path) => {
        if (path.startsWith("/Users/kerf/.ssh")) {
          protectedLookups.push(path);
          throw new Error("test forbids protected-path lookup");
        }
        return fsLstat(path);
      },
      readlink: (path) => fsReadlink(path, { encoding: "utf8" }),
    };
    const h = harness(root, undefined, () => true, lookup);
    await start(h);

    await expect(call(h, "read", { path: alias })).resolves.toMatchObject({ block: true });
    expect(protectedLookups).toEqual([]);
  });

  it("guards Pi read filename variants at their resolved filesystem target", async () => {
    const root = await tempRoot();
    const envFile = join(root, ".env");
    const requested = join(root, "account's");
    const curlyQuoteVariant = join(root, "account’s");
    await writeFile(envFile, "secret\n");
    await symlink(envFile, curlyQuoteVariant);
    const h = harness(root);
    await start(h);

    await expect(
      tool(h, "read").execute("read", { path: requested }, undefined, undefined, { cwd: root }),
    ).rejects.toThrow("pi-jev protected-path policy denied this model tool call");
  });

  it("keeps an invalidated file-call scope through the gate and wrapped operation", async () => {
    const root = await tempRoot();
    const safeFile = join(root, "safe.txt");
    const alias = join(root, "stale-alias");
    const syntheticEnv = join(root, ".env");
    await writeFile(safeFile, "safe after off/on");
    await symlink(safeFile, alias);

    let invalidated = false;
    let epoch!: EnforcementEpoch;
    const lookup: ProtectedPathLookup = {
      lstat: async (path) => {
        if (path.endsWith("stale-alias") && !invalidated) {
          invalidated = true;
          epoch.invalidate();
          epoch.invalidate();
        }
        return path.endsWith("/.env") ? fsLstat(safeFile) : fsLstat(path);
      },
      readlink: async (path) =>
        path.endsWith("stale-alias") ? syntheticEnv : fsReadlink(path, { encoding: "utf8" }),
    };
    const h = harness(root, undefined, () => true, lookup);
    epoch = h.enforcement;
    const { deps } = makeDeps({
      config: makeConfig({ modules: { gate: { enabled: true } } }),
      enforcement: h.enforcement,
    });
    registerGate(h.pi, deps);
    await start(h);

    const toolCallId = "stale-after-off-on";
    await expect(
      emit(
        h.handlers,
        "tool_call",
        { type: "tool_call", toolCallId, toolName: "read", input: { path: alias } },
        { cwd: root },
      ),
    ).resolves.toBeUndefined();
    expect(invalidated).toBe(true);
    const scope = h.enforcement.callScope(toolCallId);
    expect(scope).toBeDefined();
    expect(h.enforcement.isCurrent(scope!)).toBe(false);

    await expect(
      tool(h, "read").execute(toolCallId, { path: alias }, undefined, undefined, { cwd: root }),
    ).resolves.toMatchObject({ content: [{ text: "safe after off/on" }] });
    expect(h.enforcement.callScope(toolCallId)).toBeUndefined();
  });

  it("releases preflight-blocked call scopes on tool_execution_end", async () => {
    const root = await tempRoot();
    const h = harness(root);
    await start(h);
    const toolCallId = "blocked-before-execute";
    const scope = h.enforcement.captureCall(toolCallId);
    h.enforcement.invalidate();
    h.enforcement.invalidate();

    expect(h.enforcement.callScope(toolCallId)).toBe(scope);
    await emit(
      h.handlers,
      "tool_execution_end",
      { type: "tool_execution_end", toolCallId, toolName: "read", result: {}, isError: true },
      { cwd: root },
    );
    expect(h.enforcement.callScope(toolCallId)).toBeUndefined();
  });

  it("preserves Pi's narrow no-break-space AM/PM alias at the operation boundary", async () => {
    const root = await tempRoot();
    const safeFile = join(root, "safe.txt");
    const requested = join(root, "capture PM.txt");
    const aliasName = `capture${String.fromCharCode(0x202f)}PM.txt`;
    const resolved = join(root, aliasName);
    const syntheticEnv = join(root, ".env");
    await writeFile(safeFile, "safe fixture\n");
    await symlink(safeFile, resolved);
    const lookup: ProtectedPathLookup = {
      lstat: async (path) => (path.endsWith("/.env") ? fsLstat(safeFile) : fsLstat(path)),
      readlink: async (path) =>
        path.endsWith(aliasName) ? syntheticEnv : fsReadlink(path, { encoding: "utf8" }),
    };
    const h = harness(root, undefined, () => true, lookup);
    await start(h);

    await expect(
      tool(h, "read").execute("am-pm-fallback", { path: requested }, undefined, undefined, { cwd: root }),
    ).rejects.toThrow("pi-jev protected-path policy denied this model tool call");
  });

  it("rechecks the final tool arguments before the SDK performs filesystem work", async () => {
    const root = await tempRoot();
    const envFile = join(root, ".env");
    await writeFile(envFile, "secret\n");
    const h = harness(root);
    await start(h);

    const event = { type: "tool_call", toolCallId: "mutated", toolName: "read", input: { path: join(root, "safe.txt") } };
    h.handlers.get("tool_call")?.push((payload) => {
      (payload as typeof event).input.path = envFile;
    });
    const guardResult = await emit(h.handlers, "tool_call", event, { cwd: root });
    expect(guardResult).toBeUndefined();
    expect(event.input.path).toBe(envFile);
    await expect(
      tool(h, "read").execute("mutated", event.input, undefined, undefined, { cwd: root }),
    ).rejects.toThrow("pi-jev protected-path policy denied this model tool call");
    await expect(readFile(envFile, "utf8")).resolves.toBe("secret\n");
  });

  it("blocks writes through dangling symlinks to exact .env paths", async () => {
    const root = await tempRoot();
    const envFile = join(root, ".env");
    const danglingEnvAlias = join(root, "dangling-env-alias");
    await symlink(envFile, danglingEnvAlias);
    const h = harness(root);
    await start(h);

    const writeError = await tool(h, "write")
      .execute(
        "write",
        { path: danglingEnvAlias, content: "must not be created\n" },
        undefined,
        undefined,
        { cwd: root },
      )
      .then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    await expect(readFile(envFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(writeError).toBe("pi-jev protected-path policy denied this model tool call");
  });

  it("blocks edits through dangling symlinks to exact .env paths", async () => {
    const root = await tempRoot();
    const envFile = join(root, ".env");
    const danglingEnvAlias = join(root, "dangling-env-alias");
    await symlink(envFile, danglingEnvAlias);
    const h = harness(root);
    await start(h);

    const editError = await tool(h, "edit")
      .execute(
        "edit",
        { path: danglingEnvAlias, edits: [{ oldText: "old", newText: "new" }] },
        undefined,
        undefined,
        { cwd: root },
      )
      .then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    await expect(readFile(envFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(editError).toBe("pi-jev protected-path policy denied this model tool call");
  });

  it("preserves native errors for writes through dangling symlink ancestors", async () => {
    const root = await tempRoot();
    const missingDirectory = join(root, "missing-directory");
    const danglingAlias = join(root, "dangling-directory-alias");
    await symlink(missingDirectory, danglingAlias);
    const h = harness(root);
    await start(h);

    await expect(
      tool(h, "write").execute(
        "write",
        { path: join(danglingAlias, "created.txt"), content: "safe\n" },
        undefined,
        undefined,
        { cwd: root },
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(missingDirectory, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves EACCES when only the policy lookup is denied", async () => {
    const root = await tempRoot();
    const safeFile = join(root, "safe.txt");
    await writeFile(safeFile, "native operation succeeds\n");
    const lookup: ProtectedPathLookup = {
      lstat: async (path) => {
        if (path === safeFile) throw Object.assign(new Error("lookup denied"), { code: "EACCES" });
        return fsLstat(path);
      },
      readlink: (path) => fsReadlink(path, { encoding: "utf8" }),
    };
    const h = harness(root, undefined, () => true, lookup);
    await start(h);

    await expect(
      tool(h, "read").execute("read", { path: safeFile }, undefined, undefined, { cwd: root }),
    ).resolves.toMatchObject({ content: [{ text: "native operation succeeds\n" }] });
  });

  it("preserves native errors for safe missing paths and symlink loops, and allows .env directories", async () => {
    const root = await tempRoot();
    const envDirectory = join(root, ".env");
    const notDirectory = join(root, "not-directory");
    const loopA = join(root, "loop-a");
    const loopB = join(root, "loop-b");
    await mkdir(envDirectory, { recursive: true });
    await writeFile(notDirectory, "ordinary file\n");
    await symlink("loop-b", loopA);
    await symlink("loop-a", loopB);
    const h = harness(root);
    await start(h);

    await expect(
      tool(h, "read").execute("read", { path: join(root, "missing", "file.txt") }, undefined, undefined, { cwd: root }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      tool(h, "read").execute("read", { path: join(notDirectory, "child.txt") }, undefined, undefined, { cwd: root }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(tool(h, "read").execute("read", { path: loopA }, undefined, undefined, { cwd: root })).rejects.toMatchObject({
      code: "ELOOP",
    });
    await expect(
      tool(h, "write").execute(
        "write",
        { path: join(envDirectory, "child.txt"), content: "directory is not a protected file\n" },
        undefined,
        undefined,
        { cwd: root },
      ),
    ).resolves.toBeTruthy();
    await expect(readFile(join(envDirectory, "child.txt"), "utf8")).resolves.toBe("directory is not a protected file\n");
    await expect(tool(h, "read").execute("read", { path: envDirectory }, undefined, undefined, { cwd: root })).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  it("cancels path lookup and keeps off-to-on work on its original scope", async () => {
    const root = await tempRoot();
    const envFile = join(root, ".env");
    await writeFile(envFile, "fixture-secret\n");
    let enabled = true;
    let holdFirstLookup = true;
    let releaseLookup!: () => void;
    let signalLookupStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    const lookup: ProtectedPathLookup = {
      lstat: async (path) => {
        if (holdFirstLookup) {
          holdFirstLookup = false;
          signalLookupStarted();
          await held;
        }
        return fsLstat(path);
      },
      readlink: (path) => fsReadlink(path, { encoding: "utf8" }),
    };
    const h = harness(root, undefined, () => enabled, lookup);
    await start(h);
    const pending = call(h, "read", { path: envFile });
    await started;

    enabled = false;
    h.enforcement.invalidate();
    enabled = true;
    const released = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    releaseLookup();
    await pending;

    expect(released).toBe(true);
    await expect(
      tool(h, "read").execute("test-call", { path: envFile }, undefined, undefined, { cwd: root }),
    ).resolves.toBeTruthy();
    await expect(call(h, "read", { path: envFile })).resolves.toMatchObject({ block: true });
  });

  it("denies malformed paths without disclosing the requested path", async () => {
    const root = await tempRoot();
    const h = harness(root);
    await start(h);

    const result = await call(h, "read", { path: "\u0000/private/.env" });
    expect(result).toMatchObject({ block: true });
    expect(JSON.stringify(result)).not.toContain("/private/.env");
  });
});
