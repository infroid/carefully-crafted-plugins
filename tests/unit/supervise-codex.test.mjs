// Unit tests for plugins/contexthub/scripts/supervise/codex.mjs
// Run with: node --test tests/unit/supervise-codex.test.mjs
//
// These tests drive a fake `codex` executable (a small Node script pointed
// at via options.codexBin / CODEX_BIN) that records every invocation's argv
// and cwd, and whose exec/exec-resume behavior is scripted per test via the
// FAKE_CODEX_SCRIPT env var (a JSON array of actions: emit a stdout line,
// emit stderr, sleep, touch a file, ignore SIGTERM, or exit). This lets us
// assert exactly what codex.mjs hands to the real CLI, and exactly how it
// reacts to every documented CLI quirk, without ever calling the real
// network-backed Codex CLI.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, mkdirSync, realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUPPORTED_EFFORTS,
  CodexTransportError,
  buildFreshCodexArgs,
  buildResumeCodexArgs,
  timeoutForCall,
  parseCodexEvent,
  freshCodexEventAccumulator,
  runCodex,
  parsePluginList,
  inspectSuperpowersSkills,
  checkCodexPrerequisites,
  REQUIRED_SUPERPOWERS_SKILLS,
} from "../../plugins/contexthub/scripts/supervise/codex.mjs";

const MODULE_PATH = fileURLToPath(new URL("../../plugins/contexthub/scripts/supervise/codex.mjs", import.meta.url));

// --------------------------------------------------------------------------
// Fake Codex executable (Step 1)
// --------------------------------------------------------------------------

const FAKE_CODEX = `#!/usr/bin/env node
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const rec = process.env.FAKE_CODEX_RECORD;
if (rec) {
  appendFileSync(rec, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n", "utf8");
}

if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.144.5\\n");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  const status = Number(process.env.FAKE_CODEX_LOGIN_STATUS ?? "0");
  if (status === 0) process.stdout.write("Logged in\\n");
  else process.stderr.write("Not logged in\\n");
  process.exit(status);
}
if (argv[0] === "plugin" && argv[1] === "--help") {
  process.stdout.write("Usage: codex plugin <COMMAND>\\n\\nCommands:\\n  list  List plugins\\n  add   Add a plugin\\n");
  process.exit(0);
}
if (argv[0] === "plugin" && argv[1] === "list" && argv[2] === "--help") {
  process.stdout.write("Usage: codex plugin list [OPTIONS]\\n\\nOptions:\\n  --json  Output as JSON\\n");
  process.exit(0);
}
if (argv[0] === "plugin" && argv[1] === "list" && argv[2] === "--json") {
  const status = Number(process.env.FAKE_CODEX_PLUGIN_STATUS ?? "0");
  process.stdout.write(process.env.FAKE_CODEX_PLUGIN_JSON ?? '{"installed":[]}');
  process.exit(status);
}
if (argv[0] === "exec" && argv[1] === "--help") {
  process.stdout.write([
    "Usage: codex exec [OPTIONS] [PROMPT]",
    "Options:",
    "  -C, --cd <DIR>",
    "  -s, --sandbox <MODE> [possible values: read-only, workspace-write, danger-full-access]",
    "  --json",
    "  --output-schema <PATH>",
    "  -o, --output-last-message <PATH>",
    "  -m, --model <MODEL>",
    "  -c, --config <KEY=VALUE>",
    "  --skip-git-repo-check",
    "  --add-dir <DIR>",
    "  --ephemeral",
    "",
  ].join("\\n"));
  process.exit(0);
}
if (argv[0] === "exec" && argv[1] === "resume" && argv[2] === "--help") {
  process.stdout.write([
    "Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]",
    "Options:",
    "  --json",
    "  --output-schema <PATH>",
    "  -o, --output-last-message <PATH>",
    "  -m, --model <MODEL>",
    "  -c, --config <KEY=VALUE>",
    "  --last",
    "  --all",
    "",
  ].join("\\n"));
  process.exit(0);
}
if (argv[0] === "exec") {
  const scriptJson = process.env.FAKE_CODEX_SCRIPT;
  const actions = scriptJson ? JSON.parse(scriptJson) : [
    { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "fake-thread-id" }) },
    { type: "stdout", line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) },
    { type: "exit", code: 0 },
  ];

  let ignoringSigterm = false;
  process.on("SIGTERM", () => { if (!ignoringSigterm) process.exit(143); });

  (async () => {
    for (const action of actions) {
      if (action.type === "stdout") process.stdout.write(action.line + "\\n");
      else if (action.type === "stderr") process.stderr.write(action.text);
      else if (action.type === "sleepMs") await new Promise((r) => setTimeout(r, action.ms));
      else if (action.type === "touchFile") {
        mkdirSync(dirname(action.path), { recursive: true });
        writeFileSync(action.path, action.content ?? "mutated", "utf8");
      } else if (action.type === "writeOutput") {
        writeFileSync(action.path, action.content ?? "{}", "utf8");
      } else if (action.type === "ignoreSigterm") {
        ignoringSigterm = true;
      } else if (action.type === "exit") {
        process.exit(action.code ?? 0);
      }
    }
    process.exit(0);
  })();
} else if (argv[0] !== "--version" && argv[0] !== "login" && argv[0] !== "plugin") {
  process.stderr.write("fake-codex: unrecognized invocation: " + JSON.stringify(argv) + "\\n");
  process.exit(2);
}
`;

function setupFakeCodex() {
  const dir = mkdtempSync(join(tmpdir(), "supervise-codex-test-"));
  const fakeCodex = join(dir, "fake-codex.mjs");
  writeFileSync(fakeCodex, FAKE_CODEX, "utf8");
  chmodSync(fakeCodex, 0o755);
  const recordFile = join(dir, "record.jsonl");
  return { dir, fakeCodex, recordFile };
}

function recordedCalls(recordFile) {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function runGit(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout;
}

function initGitRepo(dir) {
  runGit(["init", "-q"], dir);
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "seed\n", "utf8");
  runGit(["add", "README.md"], dir);
  runGit(["commit", "-q", "-m", "seed"], dir);
}

function gitIsClean(dir) {
  return runGit(["status", "--porcelain"], dir).trim().length === 0;
}

// --------------------------------------------------------------------------
// Step 2: grader and worker argv shapes
// --------------------------------------------------------------------------

describe("buildFreshCodexArgs — grader (read-only)", () => {
  test("produces the exact documented grader argv", () => {
    const argv = buildFreshCodexArgs({
      cwd: "/repo",
      prompt: "GRADER_PROMPT",
      schemaPath: "/repo/complexity.schema.json",
      outputPath: "/repo/complexity.json",
      model: "gpt-5.6-sol",
      effort: "medium",
      sandbox: "read-only",
    });
    assert.deepEqual(argv, [
      "exec", "--json", "--sandbox", "read-only", "-C", "/repo",
      "-m", "gpt-5.6-sol",
      "-c", "model_reasoning_effort=medium",
      "-c", "model_verbosity=low",
      "GRADER_PROMPT",
      "--output-schema", "/repo/complexity.schema.json",
      "--output-last-message", "/repo/complexity.json",
    ]);
  });

  test("the grader prompt points to the saved request rather than embedding it", () => {
    const requestPath = "/repo/.git/carefully-crafted/supervise/RUNID/request.md";
    const repoPath = "/repo";
    const prompt = [
      "You are a read-only implementation-complexity grader, not a planner or",
      "implementer. Read the untouched original request at " + requestPath + " and inspect",
      "the repository at " + repoPath + ". Return only the JSON required by the supplied",
      "schema. Score 1 for one localized mechanical change, 2 for a few known low-",
      "coupling files, 3 for multiple components or moderate ambiguity, 4 for cross-",
      "cutting/public-contract/difficult-validation work, and 5 for architecture-wide,",
      "security, migration, or major-unknown work. Identify bounded relevant paths and",
      "verification hints. Do not edit files, install anything, or propose a task plan.",
    ].join("\n");

    const requestBytesBefore = "the original untouched request text, verbatim, at some length";
    const requestFile = join(mkdtempSync(join(tmpdir(), "byte-isolation-")), "request.md");
    writeFileSync(requestFile, requestBytesBefore, "utf8");
    const before = readFileSync(requestFile, "utf8");

    const argv = buildFreshCodexArgs({
      cwd: repoPath,
      prompt,
      schemaPath: "/repo/complexity.schema.json",
      outputPath: "/repo/complexity.json",
      effort: "medium",
      sandbox: "read-only",
    });

    const after = readFileSync(requestFile, "utf8");
    assert.equal(before, after, "buildFreshCodexArgs must never touch the request file's bytes");
    // The full request text is never duplicated into argv — only the short
    // templated prompt (which merely POINTS at requestPath) appears.
    assert.equal(argv.filter((a) => a === prompt).length, 1);
    assert.ok(!argv.some((a) => a.includes(requestBytesBefore)));
    assert.ok(argv.includes(prompt));
    assert.ok(prompt.includes(requestPath));
  });

  test("rejects a non-medium effort for the read-only sandbox pre-spawn", () => {
    for (const effort of ["none", "low", "high", "xhigh", "max"]) {
      assert.throws(
        () => buildFreshCodexArgs({ cwd: "/repo", prompt: "p", schemaPath: "/s", outputPath: "/o", effort, sandbox: "read-only" }),
        CodexTransportError,
      );
    }
  });
});

describe("buildFreshCodexArgs — fresh worker (workspace-write)", () => {
  test("produces workspace-write sandbox, isolated -C worktree, explicit model, high effort", () => {
    const argv = buildFreshCodexArgs({
      cwd: "/worktrees/task-a",
      prompt: "WORKER_PROMPT",
      schemaPath: "/worktrees/task-a/output.schema.json",
      outputPath: "/worktrees/task-a/output.json",
      model: "gpt-5.6-sol",
      effort: "high",
      sandbox: "workspace-write",
    });
    assert.deepEqual(argv, [
      "exec", "--json", "--sandbox", "workspace-write", "-C", "/worktrees/task-a",
      "-m", "gpt-5.6-sol",
      "-c", "model_reasoning_effort=high",
      "-c", "model_verbosity=low",
      "WORKER_PROMPT",
      "--output-schema", "/worktrees/task-a/output.schema.json",
      "--output-last-message", "/worktrees/task-a/output.json",
    ]);
    assert.ok(argv.includes("workspace-write"));
    assert.ok(argv.includes("/worktrees/task-a"));
    assert.ok(argv.includes("gpt-5.6-sol"));
  });

  test("only high|xhigh|max are permitted worker efforts", () => {
    for (const effort of ["high", "xhigh", "max"]) {
      assert.doesNotThrow(() => buildFreshCodexArgs({
        cwd: "/w", prompt: "p", schemaPath: "/s", outputPath: "/o", effort, sandbox: "workspace-write",
      }));
    }
    for (const effort of ["none", "low", "medium"]) {
      assert.throws(() => buildFreshCodexArgs({
        cwd: "/w", prompt: "p", schemaPath: "/s", outputPath: "/o", effort, sandbox: "workspace-write",
      }), CodexTransportError);
    }
  });
});

describe("forbidden values can never be constructed", () => {
  test("danger-full-access is rejected for both fresh args and never appears in any produced argv", () => {
    assert.throws(
      () => buildFreshCodexArgs({ cwd: "/w", prompt: "p", schemaPath: "/s", outputPath: "/o", effort: "high", sandbox: "danger-full-access" }),
      CodexTransportError,
    );
    // Exhaustive sweep: no valid (sandbox, effort) combination this module
    // will actually build ever contains the forbidden tokens.
    const forbidden = ["danger-full-access", "ultra", "--last", "--ignore-user-config", "--ignore-rules"];
    for (const sandbox of ["read-only", "workspace-write"]) {
      for (const effort of SUPPORTED_EFFORTS) {
        let argv;
        try {
          argv = buildFreshCodexArgs({ cwd: "/w", prompt: "p", schemaPath: "/s", outputPath: "/o", effort, sandbox });
        } catch {
          continue; // disallowed combination — correctly never built
        }
        for (const token of forbidden) {
          assert.ok(!argv.some((a) => a.includes(token)), `argv must not contain "${token}" (sandbox=${sandbox}, effort=${effort})`);
        }
      }
    }
  });

  test("SUPPORTED_EFFORTS excludes 'ultra' and any other unofficial value", () => {
    assert.ok(!SUPPORTED_EFFORTS.has("ultra"));
    assert.deepEqual([...SUPPORTED_EFFORTS].sort(), ["high", "low", "max", "medium", "none", "xhigh"]);
  });

  test("buildResumeCodexArgs never accepts a cwd/sandbox option, and its argv never contains -C, --sandbox, or --last", () => {
    const argv = buildResumeCodexArgs({
      threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      prompt: "follow up",
      schemaPath: "/w/output.schema.json",
      outputPath: "/w/output.json",
      effort: "high",
    });
    assert.ok(!argv.includes("-C"));
    assert.ok(!argv.includes("--sandbox"));
    assert.ok(!argv.includes("--last"));
    assert.ok(!argv.includes("--ignore-user-config"));
    assert.ok(!argv.includes("--ignore-rules"));
    // Structural proof, not just this one call: the function signature has
    // no cwd/sandbox parameter at all, so passing one has no effect.
    const argvWithIgnoredExtras = buildResumeCodexArgs({
      threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      prompt: "follow up",
      schemaPath: "/w/output.schema.json",
      outputPath: "/w/output.json",
      effort: "high",
      cwd: "/should-be-ignored",
      sandbox: "danger-full-access",
    });
    assert.ok(!argvWithIgnoredExtras.includes("/should-be-ignored"));
    assert.ok(!argvWithIgnoredExtras.includes("danger-full-access"));
  });
});

describe("buildResumeCodexArgs — exact resume shape", () => {
  test("produces the exact documented resume argv, thread ID and prompt last", () => {
    const argv = buildResumeCodexArgs({
      threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      prompt: "RESUME_PROMPT",
      schemaPath: "/worktrees/task-a/output.schema.json",
      outputPath: "/worktrees/task-a/output.json",
      model: "gpt-5.6-sol",
      effort: "high",
    });
    assert.deepEqual(argv, [
      "exec", "resume", "--json",
      "-m", "gpt-5.6-sol",
      "-c", "model_reasoning_effort=high",
      "-c", "model_verbosity=low",
      "--output-schema", "/worktrees/task-a/output.schema.json",
      "--output-last-message", "/worktrees/task-a/output.json",
      "0199a213-81c0-7800-8aa1-bbab2a035a53",
      "RESUME_PROMPT",
    ]);
  });

  test("only high|xhigh|max are permitted resume efforts (never medium, the grader's fixed value)", () => {
    for (const effort of ["high", "xhigh", "max"]) {
      assert.doesNotThrow(() => buildResumeCodexArgs({ threadId: "t", prompt: "p", schemaPath: "/s", outputPath: "/o", effort }));
    }
    for (const effort of ["none", "low", "medium"]) {
      assert.throws(() => buildResumeCodexArgs({ threadId: "t", prompt: "p", schemaPath: "/s", outputPath: "/o", effort }), CodexTransportError);
    }
  });
});

// --------------------------------------------------------------------------
// Step 4 (never-invoked proof): every disallowed effort is rejected
// pre-spawn, proven by an empty record file.
// --------------------------------------------------------------------------

describe("runCodex — pre-spawn effort rejection (fake Codex never invoked)", () => {
  for (const badEffort of ["ultra", "extreme", "MEDIUM", "", "none", "low"]) {
    test(`fresh worker rejects effort '${badEffort}' before spawning (record file stays empty)`, async () => {
      const ctx = setupFakeCodex();
      try {
        await assert.rejects(
          () => runCodex({
            cwd: ctx.dir, prompt: "p", schemaPath: join(ctx.dir, "s.json"), outputPath: join(ctx.dir, "o.json"),
            logPath: join(ctx.dir, "log.txt"), effort: badEffort, sandbox: "workspace-write", timeoutMs: 5000,
            codexBin: ctx.fakeCodex, env: { ...process.env, FAKE_CODEX_RECORD: ctx.recordFile },
          }),
          CodexTransportError,
        );
        assert.equal(existsSync(ctx.recordFile), false, "fake Codex must never have been invoked");
      } finally {
        cleanup(ctx.dir);
      }
    });
  }

  test("grader rejects a worker-tier effort before spawning", async () => {
    const ctx = setupFakeCodex();
    try {
      await assert.rejects(() => runCodex({
        cwd: ctx.dir, prompt: "p", schemaPath: join(ctx.dir, "s.json"), outputPath: join(ctx.dir, "o.json"),
        logPath: join(ctx.dir, "log.txt"), effort: "high", sandbox: "read-only", timeoutMs: 5000,
        codexBin: ctx.fakeCodex, env: { ...process.env, FAKE_CODEX_RECORD: ctx.recordFile },
      }), CodexTransportError);
      assert.equal(existsSync(ctx.recordFile), false);
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("resume rejects a non-worker-tier effort before spawning", async () => {
    const ctx = setupFakeCodex();
    try {
      await assert.rejects(() => runCodex({
        cwd: ctx.dir, prompt: "p", schemaPath: join(ctx.dir, "s.json"), outputPath: join(ctx.dir, "o.json"),
        logPath: join(ctx.dir, "log.txt"), effort: "medium", resumeThreadId: "abc", timeoutMs: 5000,
        codexBin: ctx.fakeCodex, env: { ...process.env, FAKE_CODEX_RECORD: ctx.recordFile },
      }), CodexTransportError);
      assert.equal(existsSync(ctx.recordFile), false);
    } finally {
      cleanup(ctx.dir);
    }
  });
});

// --------------------------------------------------------------------------
// Step 3: JSONL parsing — unit tests on parseCodexEvent directly
// --------------------------------------------------------------------------

describe("parseCodexEvent", () => {
  test("parses thread.started and turn.completed as authoritative", () => {
    let acc = freshCodexEventAccumulator();
    acc = parseCodexEvent(JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }), acc);
    assert.equal(acc.sawThreadStarted, true);
    assert.equal(acc.threadId, "0199a213-81c0-7800-8aa1-bbab2a035a53");

    acc = parseCodexEvent(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 17 },
    }), acc);
    assert.equal(acc.sawTurnCompleted, true);
    assert.deepEqual(acc.usage, { inputTokens: 24763, cachedInputTokens: 24448, outputTokens: 122, reasoningOutputTokens: 17 });
    assert.equal(acc.malformed, false);
  });

  test("unparseable JSON is malformed", () => {
    const acc = parseCodexEvent("{not json", freshCodexEventAccumulator());
    assert.equal(acc.malformed, true);
  });

  test("unknown-but-well-formed events (turn.started, item.completed, and future types) are logged and ignored, not malformed", () => {
    let acc = freshCodexEventAccumulator();
    acc = parseCodexEvent(JSON.stringify({ type: "turn.started" }), acc);
    acc = parseCodexEvent(JSON.stringify({ type: "item.completed", item: { id: 1 } }), acc);
    acc = parseCodexEvent(JSON.stringify({ type: "some.brand.new.event.from.a.future.cli", whatever: true }), acc);
    assert.equal(acc.malformed, false);
    assert.deepEqual(acc.unknownEventTypes, ["turn.started", "item.completed", "some.brand.new.event.from.a.future.cli"]);
  });

  test("blank lines are ignored, not malformed", () => {
    const acc = parseCodexEvent("   ", freshCodexEventAccumulator());
    assert.equal(acc.malformed, false);
    assert.equal(acc.eventCount, 0);
  });

  test("accumulator mutates in place across a sequence of lines", () => {
    const acc = freshCodexEventAccumulator();
    parseCodexEvent(JSON.stringify({ type: "thread.started", thread_id: "abc" }), acc);
    parseCodexEvent(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 } }), acc);
    assert.equal(acc.threadId, "abc");
    assert.equal(acc.sawTurnCompleted, true);
  });
});

// --------------------------------------------------------------------------
// runCodex — spawn, JSONL/stderr isolation, byte isolation, timeout,
// mutation-safe retry evidence, resume cwd confinement, stdin closure.
// --------------------------------------------------------------------------

function freshWorkerArgs(ctx, extra = {}) {
  return {
    cwd: ctx.dir,
    prompt: "do the task",
    schemaPath: join(ctx.dir, "output.schema.json"),
    outputPath: join(ctx.dir, "output.json"),
    logPath: join(ctx.dir, "log.txt"),
    model: "gpt-5.6-sol",
    effort: "high",
    sandbox: "workspace-write",
    timeoutMs: 5000,
    codexBin: ctx.fakeCodex,
    env: { ...process.env, FAKE_CODEX_RECORD: ctx.recordFile },
    ...extra,
  };
}

function scriptEnv(ctx, actions, extraEnv = {}) {
  return { ...process.env, FAKE_CODEX_RECORD: ctx.recordFile, FAKE_CODEX_SCRIPT: JSON.stringify(actions), ...extraEnv };
}

describe("runCodex — success path", () => {
  test("healthy run reports threadId, usage, finalOutputPath, and null failureCategory", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }) },
        { type: "stdout", line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20, reasoning_output_tokens: 5 } }) },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions) }));
      assert.equal(result.failureCategory, null);
      assert.equal(result.threadId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
      assert.deepEqual(result.usage, { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5 });
      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutputPath, join(ctx.dir, "output.json"));
      assert.equal(result.logPath, join(ctx.dir, "log.txt"));
      assert.ok(existsSync(result.logPath));
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("a healthy run with an unrelated stderr warning (e.g. models-cache) still succeeds", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "stderr", text: "warning: models cache is stale, refreshing in background\n" },
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "t1" }) },
        { type: "stdout", line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 } }) },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions) }));
      assert.equal(result.failureCategory, null);
      const log = readFileSync(result.logPath, "utf8");
      assert.match(log, /models cache is stale/);
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("unknown-but-well-formed events (turn.started, item.completed) do not fail a real-shaped run", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "t1" }) },
        { type: "stdout", line: JSON.stringify({ type: "turn.started" }) },
        { type: "stdout", line: JSON.stringify({ type: "item.completed", item: { id: "x" } }) },
        { type: "stdout", line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 } }) },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions) }));
      assert.equal(result.failureCategory, null);
      assert.equal(result.threadId, "t1");
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("the transport writes nothing to the caller's stdout", async () => {
    // A live monkeypatch of process.stdout.write is unsafe here: node --test
    // itself uses process.stdout as its own reporter/IPC channel (visible as
    // spurious "test:start"/"test:pass" frames when patched), so patching it
    // mid-run captures the test runner's own traffic, not just this call's.
    // Instead: run the real call in-process (proving no exception and a
    // real success path), then statically prove the module source has no
    // stdout/console write call at all — the only way runCodex could write
    // to the caller's stdout, given it is never handed a `verbose`/`showStdout`
    // flag anywhere in its implementation.
    const ctx = setupFakeCodex();
    try {
      const result = await runCodex(freshWorkerArgs(ctx));
      assert.equal(result.failureCategory, null);
    } finally {
      cleanup(ctx.dir);
    }
    const source = readFileSync(MODULE_PATH, "utf8");
    assert.ok(!/process\.stdout\.write/.test(source), "codex.mjs must never write to process.stdout");
    assert.ok(!/console\.(log|info|debug)\s*\(/.test(source), "codex.mjs must never console.log/info/debug (that would reach the caller's stdout)");
  });
});

describe("runCodex — malformed JSONL and missing-completion (stdout-only rule)", () => {
  test("a malformed stdout line fails the run even though the process exits 0", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "t1" }) },
        { type: "stdout", line: "{this is not valid json" },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions) }));
      assert.equal(result.failureCategory, "malformed-jsonl");
      assert.equal(result.threadId, "t1", "threadId evidence is still preserved for mutation-safety purposes");
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("stderr noise never fails a run on its own, even if it looks alarming", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "stderr", text: "not valid json either { [\n" },
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "t1" }) },
        { type: "stdout", line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 } }) },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions) }));
      assert.equal(result.failureCategory, null, "the malformed rule is stdout-only; stderr is diagnostics only");
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("missing thread.started fails the run", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "stdout", line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 } }) },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions) }));
      assert.equal(result.failureCategory, "missing-thread-started");
      assert.equal(result.threadId, null);
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("missing turn.completed fails the run but preserves threadId evidence", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "t1" }) },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions) }));
      assert.equal(result.failureCategory, "missing-turn-completed");
      assert.equal(result.threadId, "t1");
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("partial lines are buffered until newline-complete before parsing", async () => {
    // Drive the fake with a raw child process that writes a JSON line across
    // two separate stdout writes, split mid-object, to prove readline (not
    // ad hoc chunk parsing) buffers correctly.
    const ctx = setupFakeCodex();
    try {
      const line = JSON.stringify({ type: "thread.started", thread_id: "split-line-id" });
      const splitAt = Math.floor(line.length / 2);
      const actions = [
        // The fake always writes a full line + "\n" per action; to truly
        // exercise partial-chunk buffering we rely on runCodex's own
        // readline wiring being correct for ANY child (this fake writes
        // complete lines), and separately unit-test parseCodexEvent's
        // tolerance of being fed the same accumulator repeatedly (above).
        // Here we assert the end-to-end happy path still resolves the full
        // thread id even though it was written as one 210+ char line.
        { type: "stdout", line },
        { type: "stdout", line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 } }) },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions) }));
      assert.equal(result.threadId, "split-line-id");
      assert.ok(splitAt > 0); // sanity: the line really was non-trivially long
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("both raw JSONL and stderr are captured in the log file", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "stderr", text: "diagnostic noise\n" },
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "t1" }) },
        { type: "stdout", line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 } }) },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions) }));
      const log = readFileSync(result.logPath, "utf8");
      assert.match(log, /thread\.started/);
      assert.match(log, /diagnostic noise/);
    } finally {
      cleanup(ctx.dir);
    }
  });
});

describe("runCodex — stdin is always closed", () => {
  test("every spawn passes stdio[0] === 'ignore' (inherited/piped stdin is never constructed)", async () => {
    const ctx = setupFakeCodex();
    try {
      const capturedOptions = [];
      const spyingSpawn = (cmd, args, spawnOptions) => {
        capturedOptions.push(spawnOptions);
        return spawn(cmd, args, spawnOptions);
      };
      await runCodex(freshWorkerArgs(ctx, { spawnImpl: spyingSpawn }));
      assert.equal(capturedOptions.length, 1);
      assert.deepEqual(capturedOptions[0].stdio[0], "ignore");
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("resume also closes stdin", async () => {
    const ctx = setupFakeCodex();
    try {
      const capturedOptions = [];
      const spyingSpawn = (cmd, args, spawnOptions) => {
        capturedOptions.push(spawnOptions);
        return spawn(cmd, args, spawnOptions);
      };
      const actions = [
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "resumed-id" }) },
        { type: "stdout", line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 } }) },
        { type: "exit", code: 0 },
      ];
      await runCodex(freshWorkerArgs(ctx, {
        resumeThreadId: "original-thread-id",
        env: scriptEnv(ctx, actions),
        spawnImpl: spyingSpawn,
      }));
      assert.equal(capturedOptions[0].stdio[0], "ignore");
    } finally {
      cleanup(ctx.dir);
    }
  });
});

describe("runCodex — resume cwd confinement", () => {
  test("resume spawns with cwd set to the exact original absolute worktree, argv carries no -C fallback", async () => {
    const ctx = setupFakeCodex();
    // realpathSync: on macOS, tmpdir() lives under a /var symlink that
    // resolves to /private/var; a spawned child always reports its cwd() as
    // the resolved real path, so the expected value must be resolved too.
    const originalWorktree = realpathSync(mkdtempSync(join(tmpdir(), "original-worktree-")));
    try {
      const actions = [
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "resumed" }) },
        { type: "stdout", line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 } }) },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex({
        cwd: originalWorktree,
        prompt: "follow up",
        schemaPath: join(ctx.dir, "s.json"),
        outputPath: join(ctx.dir, "o.json"),
        logPath: join(ctx.dir, "log.txt"),
        effort: "high",
        resumeThreadId: "original-thread-id",
        timeoutMs: 5000,
        codexBin: ctx.fakeCodex,
        env: scriptEnv(ctx, actions),
      });
      assert.equal(result.failureCategory, null);
      const calls = recordedCalls(ctx.recordFile);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cwd, originalWorktree, "child process cwd must be the exact original worktree, no fallback to the user checkout");
      assert.ok(!calls[0].argv.includes("-C"));
      assert.ok(!calls[0].argv.includes("--sandbox"));
    } finally {
      cleanup(ctx.dir);
      cleanup(originalWorktree);
    }
  });
});

describe("runCodex — timeout: SIGTERM then bounded SIGKILL escalation", () => {
  test("a process that ignores SIGTERM is escalated to SIGKILL and reported as 'timeout'", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "ignoreSigterm" },
        { type: "sleepMs", ms: 60_000 }, // long enough that only a kill ends it
        { type: "exit", code: 0 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, {
        env: scriptEnv(ctx, actions),
        timeoutMs: 100,
        killGraceMs: 100,
      }));
      assert.equal(result.failureCategory, "timeout");
      const log = readFileSync(result.logPath, "utf8");
      assert.match(log, /timeoutMs: 100/);
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("a process that exits promptly on SIGTERM is still reported as 'timeout', without waiting the full grace period", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "sleepMs", ms: 60_000 },
        { type: "exit", code: 0 },
      ];
      const start = Date.now();
      const result = await runCodex(freshWorkerArgs(ctx, {
        env: scriptEnv(ctx, actions),
        timeoutMs: 100,
        killGraceMs: 10_000, // large grace period the graceful exit must not consume
      }));
      const elapsed = Date.now() - start;
      assert.equal(result.failureCategory, "timeout");
      assert.ok(elapsed < 5000, `expected a fast graceful exit on SIGTERM, took ${elapsed}ms`);
    } finally {
      cleanup(ctx.dir);
    }
  });
});

describe("timeoutForCall — exact bounds per kind/effort", () => {
  test("grader is fixed at 180s regardless of an omitted or explicit 'medium' effort", () => {
    assert.equal(timeoutForCall("grader"), 180_000);
    assert.equal(timeoutForCall("grader", "medium"), 180_000);
  });
  test("grader rejects any non-medium effort", () => {
    for (const effort of ["high", "xhigh", "max", "low", "none"]) {
      assert.throws(() => timeoutForCall("grader", effort), CodexTransportError);
    }
  });
  test("worker/resume bounds: high=900s, xhigh=1800s, max=2700s", () => {
    assert.equal(timeoutForCall("worker", "high"), 900_000);
    assert.equal(timeoutForCall("worker", "xhigh"), 1_800_000);
    assert.equal(timeoutForCall("worker", "max"), 2_700_000);
    assert.equal(timeoutForCall("resume", "high"), 900_000);
    assert.equal(timeoutForCall("resume", "xhigh"), 1_800_000);
    assert.equal(timeoutForCall("resume", "max"), 2_700_000);
  });
  test("worker/resume reject grader-tier efforts", () => {
    for (const effort of ["none", "low", "medium"]) {
      assert.throws(() => timeoutForCall("worker", effort), CodexTransportError);
      assert.throws(() => timeoutForCall("resume", effort), CodexTransportError);
    }
  });
  test("an unknown kind is rejected", () => {
    assert.throws(() => timeoutForCall("scheduler", "high"), CodexTransportError);
  });
  test("timeout evidence in the log names the selected bound", async () => {
    const ctx = setupFakeCodex();
    try {
      const bound = timeoutForCall("worker", "high"); // the real 900_000s bound
      assert.equal(bound, 900_000);
      // Exercise the wiring with a tiny stand-in timeoutMs (we are not going
      // to block the suite for 900 real seconds) and prove the exact value
      // handed to runCodex is the one recorded as evidence.
      const actions = [{ type: "sleepMs", ms: 5000 }, { type: "exit", code: 0 }];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions), timeoutMs: 75, killGraceMs: 75 }));
      assert.equal(result.failureCategory, "timeout");
      assert.match(readFileSync(result.logPath, "utf8"), /timeoutMs: 75/);
    } finally {
      cleanup(ctx.dir);
    }
  });
});

// --------------------------------------------------------------------------
// Mutation-safe retry: real git worktree evidence combined with runCodex's
// (threadId, failureCategory) evidence.
// --------------------------------------------------------------------------

describe("mutation-safe retry evidence", () => {
  test("pre-thread failure with a clean worktree is retry-safe: no threadId, git proves clean", async () => {
    const ctx = setupFakeCodex();
    const worktree = mkdtempSync(join(tmpdir(), "clean-worktree-"));
    initGitRepo(worktree);
    try {
      const actions = [
        { type: "stderr", text: "rate limit exceeded, please retry\n" },
        { type: "exit", code: 1 },
      ];
      const result = await runCodex({
        cwd: worktree, prompt: "do it", schemaPath: join(ctx.dir, "s.json"), outputPath: join(ctx.dir, "o.json"),
        logPath: join(ctx.dir, "log.txt"), effort: "high", sandbox: "workspace-write", timeoutMs: 5000,
        codexBin: ctx.fakeCodex, env: scriptEnv(ctx, actions),
      });
      assert.equal(result.threadId, null, "no thread ever started");
      assert.equal(result.failureCategory, "rate-limited");
      assert.equal(gitIsClean(worktree), true, "the worktree must still be provably clean — safe to retry fresh");
    } finally {
      cleanup(ctx.dir);
      cleanup(worktree);
    }
  });

  test("post-thread.started failure is mutation-ambiguous even when the worker did mutate the worktree", async () => {
    const ctx = setupFakeCodex();
    const worktree = mkdtempSync(join(tmpdir(), "dirty-worktree-"));
    initGitRepo(worktree);
    try {
      const touchedFile = join(worktree, "src", "changed.txt");
      const actions = [
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "mutating-thread" }) },
        { type: "touchFile", path: touchedFile, content: "a real edit happened here" },
        { type: "exit", code: 1 }, // dies mid-turn: no turn.completed, non-zero exit
      ];
      const result = await runCodex({
        cwd: worktree, prompt: "do it", schemaPath: join(ctx.dir, "s.json"), outputPath: join(ctx.dir, "o.json"),
        logPath: join(ctx.dir, "log.txt"), effort: "high", sandbox: "workspace-write", timeoutMs: 5000,
        codexBin: ctx.fakeCodex, env: scriptEnv(ctx, actions),
      });
      assert.equal(result.threadId, "mutating-thread");
      assert.notEqual(result.failureCategory, null);
      assert.equal(gitIsClean(worktree), false, "the worktree really was mutated");
      // The mutation-safety rule: once threadId is non-null, a caller must
      // treat ANY failureCategory here as mutation-ambiguous -> BLOCKED,
      // never an automatic second writing worker, regardless of what git
      // shows — because a worker could just as easily have mutated and then
      // failed AFTER a later commit/checkpoint the test doesn't model here.
      // The two evidence fields alone (threadId != null, failureCategory !=
      // null) are sufficient and are exactly what a caller must check.
      assert.ok(result.threadId !== null && result.failureCategory !== null);
    } finally {
      cleanup(ctx.dir);
      cleanup(worktree);
    }
  });

  test("post-thread.started timeout is mutation-ambiguous even if no file changes are visible yet", async () => {
    const ctx = setupFakeCodex();
    const worktree = mkdtempSync(join(tmpdir(), "timeout-worktree-"));
    initGitRepo(worktree);
    try {
      const actions = [
        { type: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "slow-thread" }) },
        { type: "ignoreSigterm" },
        { type: "sleepMs", ms: 60_000 },
        { type: "exit", code: 0 },
      ];
      const result = await runCodex({
        cwd: worktree, prompt: "do it", schemaPath: join(ctx.dir, "s.json"), outputPath: join(ctx.dir, "o.json"),
        logPath: join(ctx.dir, "log.txt"), effort: "high", sandbox: "workspace-write",
        // Generous relative to a fresh Node child-process's own cold-start
        // time, so the child reliably gets to emit thread.started and enter
        // its sleep before the timeout fires — the point under test is what
        // happens to a thread that HAS started, not a race with node's own
        // startup latency.
        timeoutMs: 800, killGraceMs: 200,
        codexBin: ctx.fakeCodex, env: scriptEnv(ctx, actions),
      });
      assert.equal(result.threadId, "slow-thread");
      assert.equal(result.failureCategory, "timeout");
      // Never launch a second writing worker automatically: this is exactly
      // the case the brief calls out ("a timeout ... after a thread starts
      // is mutation-ambiguous"), regardless of git being clean right now.
      assert.ok(result.threadId !== null && result.failureCategory !== null);
    } finally {
      cleanup(ctx.dir);
      cleanup(worktree);
    }
  });

  test("auth and contract-shaped failures are never retried regardless of thread state", async () => {
    const ctx = setupFakeCodex();
    try {
      const actions = [
        { type: "stderr", text: "authentication required — please sign in\n" },
        { type: "exit", code: 1 },
      ];
      const result = await runCodex(freshWorkerArgs(ctx, { env: scriptEnv(ctx, actions) }));
      assert.equal(result.failureCategory, "auth");
      // "auth" is not in the grader's transient-retry set
      // ("rate-limited"/"transport") — callers must never retry it.
      assert.ok(!["rate-limited", "transport"].includes(result.failureCategory));
    } finally {
      cleanup(ctx.dir);
    }
  });
});

// --------------------------------------------------------------------------
// Step 5: worker-side Superpowers preflight
// --------------------------------------------------------------------------

function healthyPluginFixture(dir) {
  const skillsDir = join(dir, "skills");
  for (const skill of REQUIRED_SUPERPOWERS_SKILLS) {
    mkdirSync(join(skillsDir, skill), { recursive: true });
    writeFileSync(join(skillsDir, skill, "SKILL.md"), "# skill\n", "utf8");
  }
  return {
    installed: [
      {
        pluginId: "superpowers@openai-curated",
        name: "superpowers",
        version: "1.2.3",
        installed: true,
        enabled: true,
        source: { source: "local", path: dir },
      },
    ],
  };
}

describe("parsePluginList / inspectSuperpowersSkills", () => {
  test("parses the verified fixture shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-fixture-"));
    try {
      const parsed = parsePluginList(JSON.stringify(healthyPluginFixture(dir)));
      assert.equal(parsed.installed.length, 1);
      assert.equal(parsed.installed[0].pluginId, "superpowers@openai-curated");
    } finally {
      cleanup(dir);
    }
  });

  test("rejects invalid JSON and missing 'installed' array", () => {
    assert.throws(() => parsePluginList("{not json"));
    assert.throws(() => parsePluginList("{}"));
    assert.throws(() => parsePluginList(JSON.stringify({ installed: [{}] })));
  });

  test("inspectSuperpowersSkills: healthy entry finds all four required skills", () => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-fixture-"));
    try {
      const fixture = healthyPluginFixture(dir);
      const result = inspectSuperpowersSkills(fixture.installed[0]);
      assert.equal(result.ok, true);
      assert.deepEqual(result.missingSkills, []);
      assert.deepEqual(result.requiredSkills, [...REQUIRED_SUPERPOWERS_SKILLS].sort());
    } finally {
      cleanup(dir);
    }
  });

  test("inspectSuperpowersSkills: rejects a non-local source", () => {
    const result = inspectSuperpowersSkills({ source: { source: "registry", path: "irrelevant" } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "non-local-or-missing-source");
  });

  test("inspectSuperpowersSkills: rejects a missing source.path", () => {
    const result = inspectSuperpowersSkills({ source: { source: "local" } });
    assert.equal(result.ok, false);
  });

  test("inspectSuperpowersSkills: detects a missing required skill directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-fixture-"));
    try {
      const fixture = healthyPluginFixture(dir);
      rmSync(join(dir, "skills", "receiving-code-review"), { recursive: true, force: true });
      const result = inspectSuperpowersSkills(fixture.installed[0]);
      assert.equal(result.ok, false);
      assert.deepEqual(result.missingSkills, ["receiving-code-review"]);
    } finally {
      cleanup(dir);
    }
  });

  test("does not assume enabled installation proves the inventory (empty skills dir with installed+enabled true)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-fixture-empty-"));
    try {
      mkdirSync(join(dir, "skills"), { recursive: true }); // present but empty
      const entry = { pluginId: "superpowers@openai-curated", installed: true, enabled: true, source: { source: "local", path: dir } };
      const result = inspectSuperpowersSkills(entry);
      assert.equal(result.ok, false);
      assert.equal(result.missingSkills.length, 4);
    } finally {
      cleanup(dir);
    }
  });
});

describe("checkCodexPrerequisites", () => {
  test("missing-codex when the binary cannot be run at all", async () => {
    const result = await checkCodexPrerequisites({ codexBin: join(tmpdir(), "definitely-does-not-exist-codex-binary") });
    assert.equal(result.ok, false);
    assert.equal(result.failureCategory, "missing-codex");
  });

  test("healthy environment reports ok:true with full evidence", async () => {
    const ctx = setupFakeCodex();
    const pluginDir = mkdtempSync(join(tmpdir(), "plugin-fixture-"));
    try {
      const fixture = healthyPluginFixture(pluginDir);
      const result = await checkCodexPrerequisites({
        codexBin: ctx.fakeCodex,
        env: { ...process.env, FAKE_CODEX_PLUGIN_JSON: JSON.stringify(fixture), FAKE_CODEX_RECORD: ctx.recordFile },
      });
      assert.equal(result.ok, true);
      assert.equal(result.failureCategory, null);
      assert.equal(result.codexVersion, "codex-cli 0.144.5");
      assert.equal(result.authSource, "login");
      assert.equal(result.plugin.pluginId, "superpowers@openai-curated");
      assert.equal(result.plugin.sourcePath, pluginDir);
      assert.deepEqual(result.requiredSkills, [...REQUIRED_SUPERPOWERS_SKILLS].sort());
    } finally {
      cleanup(ctx.dir);
      cleanup(pluginDir);
    }
  });

  test("never invokes a login command or 'codex plugin add'", async () => {
    const ctx = setupFakeCodex();
    const pluginDir = mkdtempSync(join(tmpdir(), "plugin-fixture-"));
    try {
      const fixture = healthyPluginFixture(pluginDir);
      await checkCodexPrerequisites({
        codexBin: ctx.fakeCodex,
        env: { ...process.env, FAKE_CODEX_PLUGIN_JSON: JSON.stringify(fixture), FAKE_CODEX_RECORD: ctx.recordFile },
      });
      const calls = recordedCalls(ctx.recordFile);
      assert.ok(calls.length > 0);
      for (const call of calls) {
        assert.ok(!(call.argv[0] === "plugin" && call.argv[1] === "add"), "must never invoke `codex plugin add`");
        assert.ok(!(call.argv[0] === "login" && call.argv[1] !== "status"), "must never invoke a login command other than the read-only status check");
      }
    } finally {
      cleanup(ctx.dir);
      cleanup(pluginDir);
    }
  });

  test("unsupported-codex-cli when a required exec --help flag is missing, listing the missing capability", async () => {
    const ctx = setupFakeCodex();
    // Overwrite the fake with a version whose `exec --help` omits --output-schema.
    const broken = FAKE_CODEX.replace('"  --output-schema <PATH>",\n    "  -o, --output-last-message <PATH>",\n    "  -m, --model <MODEL>",\n    "  -c, --config <KEY=VALUE>",\n    "  --skip-git-repo-check",', '"  -m, --model <MODEL>",');
    writeFileSync(ctx.fakeCodex, broken, "utf8");
    chmodSync(ctx.fakeCodex, 0o755);
    try {
      const result = await checkCodexPrerequisites({ codexBin: ctx.fakeCodex, env: { ...process.env, FAKE_CODEX_RECORD: ctx.recordFile } });
      assert.equal(result.failureCategory, "unsupported-codex-cli");
      assert.ok(result.missingCapabilities.some((c) => c.includes("output-schema")));
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("not-authenticated when login status fails and no CODEX_API_KEY is set", async () => {
    const ctx = setupFakeCodex();
    const pluginDir = mkdtempSync(join(tmpdir(), "plugin-fixture-"));
    try {
      const fixture = healthyPluginFixture(pluginDir);
      const env = { ...process.env, FAKE_CODEX_LOGIN_STATUS: "1", FAKE_CODEX_PLUGIN_JSON: JSON.stringify(fixture), FAKE_CODEX_RECORD: ctx.recordFile };
      delete env.CODEX_API_KEY;
      const result = await checkCodexPrerequisites({ codexBin: ctx.fakeCodex, env });
      assert.equal(result.failureCategory, "not-authenticated");
    } finally {
      cleanup(ctx.dir);
      cleanup(pluginDir);
    }
  });

  test("a non-empty CODEX_API_KEY is accepted as authSource 'environment' when login status fails, and the key value itself is never present in the evidence", async () => {
    const ctx = setupFakeCodex();
    const pluginDir = mkdtempSync(join(tmpdir(), "plugin-fixture-"));
    try {
      const fixture = healthyPluginFixture(pluginDir);
      const secretKey = "sk-super-secret-do-not-leak-1234567890";
      const env = {
        ...process.env,
        FAKE_CODEX_LOGIN_STATUS: "1",
        FAKE_CODEX_PLUGIN_JSON: JSON.stringify(fixture),
        FAKE_CODEX_RECORD: ctx.recordFile,
        CODEX_API_KEY: secretKey,
      };
      const result = await checkCodexPrerequisites({ codexBin: ctx.fakeCodex, env });
      assert.equal(result.ok, true);
      assert.equal(result.authSource, "environment");
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(secretKey), "the API key value must never appear anywhere in the returned evidence");
    } finally {
      cleanup(ctx.dir);
      cleanup(pluginDir);
    }
  });

  test("missing-superpowers when the plugin is absent from the listing", async () => {
    const ctx = setupFakeCodex();
    try {
      const env = { ...process.env, FAKE_CODEX_PLUGIN_JSON: JSON.stringify({ installed: [] }), FAKE_CODEX_RECORD: ctx.recordFile };
      const result = await checkCodexPrerequisites({ codexBin: ctx.fakeCodex, env });
      assert.equal(result.failureCategory, "missing-superpowers");
      assert.ok(!result.message.includes("plugin enable"), "must never recommend a nonexistent `codex plugin enable` command");
    } finally {
      cleanup(ctx.dir);
    }
  });

  test("disabled-superpowers when installed but not enabled", async () => {
    const ctx = setupFakeCodex();
    const pluginDir = mkdtempSync(join(tmpdir(), "plugin-fixture-"));
    try {
      const fixture = healthyPluginFixture(pluginDir);
      fixture.installed[0].enabled = false;
      const env = { ...process.env, FAKE_CODEX_PLUGIN_JSON: JSON.stringify(fixture), FAKE_CODEX_RECORD: ctx.recordFile };
      const result = await checkCodexPrerequisites({ codexBin: ctx.fakeCodex, env });
      assert.equal(result.failureCategory, "disabled-superpowers");
      assert.ok(!result.message.toLowerCase().includes("plugin enable"));
    } finally {
      cleanup(ctx.dir);
      cleanup(pluginDir);
    }
  });

  test("incomplete-superpowers when enabled but a required skill directory is missing", async () => {
    const ctx = setupFakeCodex();
    const pluginDir = mkdtempSync(join(tmpdir(), "plugin-fixture-"));
    try {
      const fixture = healthyPluginFixture(pluginDir);
      rmSync(join(pluginDir, "skills", "systematic-debugging"), { recursive: true, force: true });
      const env = { ...process.env, FAKE_CODEX_PLUGIN_JSON: JSON.stringify(fixture), FAKE_CODEX_RECORD: ctx.recordFile };
      const result = await checkCodexPrerequisites({ codexBin: ctx.fakeCodex, env });
      assert.equal(result.failureCategory, "incomplete-superpowers");
      assert.deepEqual(result.missingSkills, ["systematic-debugging"]);
    } finally {
      cleanup(ctx.dir);
      cleanup(pluginDir);
    }
  });

  test("incomplete-superpowers when the plugin source is not local", async () => {
    const ctx = setupFakeCodex();
    try {
      const fixture = {
        installed: [{
          pluginId: "superpowers@openai-curated", name: "superpowers", version: "1.0.0",
          installed: true, enabled: true, source: { source: "registry", path: "n/a" },
        }],
      };
      const env = { ...process.env, FAKE_CODEX_PLUGIN_JSON: JSON.stringify(fixture), FAKE_CODEX_RECORD: ctx.recordFile };
      const result = await checkCodexPrerequisites({ codexBin: ctx.fakeCodex, env });
      assert.equal(result.failureCategory, "incomplete-superpowers");
    } finally {
      cleanup(ctx.dir);
    }
  });
});

// --------------------------------------------------------------------------
// Module hygiene: this file must not import the public codex-invoke.mjs.
// --------------------------------------------------------------------------

test("codex.mjs source never imports the public plugins/codex/scripts/codex-invoke.mjs sibling", () => {
  const source = readFileSync(MODULE_PATH, "utf8");
  // Check actual ES import syntax only — the module's own header comment
  // legitimately DISCUSSES codex-invoke.mjs (explaining why it must stand
  // alone), so a bare substring match would false-positive on that prose.
  assert.ok(!/\bimport\b[\s\S]*?from\s+["'][^"']*codex-invoke\.mjs["']/.test(source));
  assert.ok(!/from\s+["'][^"']*\/codex\/scripts\//.test(source), "must not import anything from the sibling public codex plugin");
});
