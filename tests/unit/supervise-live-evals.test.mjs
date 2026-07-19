// Unit tests for tools/run-supervise-live-evals.mjs
// Run with: node --test tests/unit/supervise-live-evals.test.mjs
//
// NO TEST IN THIS FILE MAY EVER INCUR PROVIDER USAGE. Every case here either
// (a) exercises pure validation/argv-construction functions, (b) drives
// `runLiveEvals`/`main` with `dryRun: true` (which never calls `spawnImpl`
// at all — proven explicitly below by injecting a `spawnImpl` that throws if
// invoked), or (c) drives `runLiveEvals` with a hand-written FAKE
// `spawnImpl` that returns canned JSON strings and never touches a real
// `claude` binary, a network socket, or a credential. This is the same
// injection discipline plugins/contexthub/scripts/supervise/codex.mjs's own
// tests use for the Codex transport.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LiveEvalError, ALLOWED_TOOLS, ASSERTION_TYPES,
  validateCasesFixture, assertPositiveBudget, assertDisposableRoot, assertCredentialSource,
  resolveContexthubPluginDir, formatUsd, buildClaudeArgv, parseClaudeCostResult,
  createDisposableCaseRepo, writeCaseOutput, runLiveEvals, main,
} from "../../tools/run-supervise-live-evals.mjs";

function scratchDir() {
  return mkdtempSync(join(tmpdir(), "sup-live-evals-test-"));
}

function throwingSpawnImpl() {
  return async () => {
    throw new Error("spawnImpl must never be called in this code path — if this fires, dry-run or an early-exit guard has been broken");
  };
}

function makeCase(overrides = {}) {
  return {
    id: "sample-case",
    description: "a sample case",
    prompt: "do the planning-only thing and report JSON",
    assertion: { type: "single_work_order" },
    ...overrides,
  };
}

// ============================================================================
// validateCasesFixture
// ============================================================================

describe("validateCasesFixture", () => {
  test("accepts the real tests/evals/supervise-boundary-cases.json fixture used by Step 4", () => {
    const raw = JSON.parse(readFileSync(new URL("../evals/supervise-boundary-cases.json", import.meta.url), "utf8"));
    const fixture = validateCasesFixture(raw);
    assert.equal(fixture.cases.length, 3);
    const types = fixture.cases.map((c) => c.assertion.type).sort();
    assert.deepEqual(types, [...ASSERTION_TYPES].sort());
  });

  test("rejects a non-object fixture", () => {
    assert.throws(() => validateCasesFixture(null), LiveEvalError);
    assert.throws(() => validateCasesFixture([1, 2, 3]), LiveEvalError);
  });

  test("rejects an unknown assertion type", () => {
    const raw = { version: 1, cases: [makeCase({ assertion: { type: "launch_a_nuke" } })] };
    assert.throws(() => validateCasesFixture(raw), /unknown/);
  });

  test("rejects a duplicate case id", () => {
    const raw = { version: 1, cases: [makeCase({ id: "dup" }), makeCase({ id: "dup" })] };
    assert.throws(() => validateCasesFixture(raw), /duplicate/);
  });

  test("rejects a missing/empty prompt", () => {
    const raw = { version: 1, cases: [makeCase({ prompt: "" })] };
    assert.throws(() => validateCasesFixture(raw), LiveEvalError);
  });

  test("rejects an unsafe setup.files path", () => {
    const raw = { version: 1, cases: [makeCase({ setup: { files: { "../escape.txt": "x" } } })] };
    assert.throws(() => validateCasesFixture(raw), /unsafe path/);
  });

  test("rejects an empty cases array", () => {
    assert.throws(() => validateCasesFixture({ version: 1, cases: [] }), LiveEvalError);
  });
});

// ============================================================================
// assertPositiveBudget — missing/zero/negative budgets
// ============================================================================

describe("assertPositiveBudget", () => {
  test("rejects missing, zero, negative, non-numeric, and non-finite budgets", () => {
    for (const bad of [undefined, null, true, 0, -1, -0.01, "abc", NaN, Infinity, -Infinity]) {
      assert.throws(() => assertPositiveBudget(bad), LiveEvalError, `expected rejection for ${JSON.stringify(bad)}`);
    }
  });

  test("accepts a positive number or numeric string", () => {
    assert.equal(assertPositiveBudget(5), 5);
    assert.equal(assertPositiveBudget("2.50"), 2.5);
  });
});

// ============================================================================
// assertDisposableRoot — non-disposable target paths
// ============================================================================

describe("assertDisposableRoot", () => {
  test("rejects a real, non-temp-directory target path without creating anything there", () => {
    const outsideTarget = join(process.cwd(), "definitely-not-a-real-dir-from-this-test");
    assert.throws(() => assertDisposableRoot(outsideTarget), LiveEvalError);
    assert.equal(existsSync(outsideTarget), false, "a rejected non-disposable target must never be created");
  });

  test("rejects an empty path", () => {
    assert.throws(() => assertDisposableRoot(""), LiveEvalError);
  });

  test("accepts a path that resolves inside the OS temp directory", () => {
    const root = join(tmpdir(), `sup-live-evals-disposable-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const result = assertDisposableRoot(root);
    assert.equal(existsSync(root), true);
    assert.equal(result, realpathSync(root));
  });
});

// ============================================================================
// assertCredentialSource
// ============================================================================

describe("assertCredentialSource", () => {
  test("rejects a missing or empty ANTHROPIC_API_KEY", () => {
    assert.throws(() => assertCredentialSource({}), LiveEvalError);
    assert.throws(() => assertCredentialSource({ ANTHROPIC_API_KEY: "" }), LiveEvalError);
    assert.throws(() => assertCredentialSource({ ANTHROPIC_API_KEY: "   " }), LiveEvalError);
  });

  test("accepts a present, non-empty ANTHROPIC_API_KEY", () => {
    assert.doesNotThrow(() => assertCredentialSource({ ANTHROPIC_API_KEY: "sk-ant-fake-for-shape-only" }));
  });
});

// ============================================================================
// buildClaudeArgv — the exact isolated/bounded argv contract
// ============================================================================

describe("buildClaudeArgv", () => {
  const contexthubPluginDir = resolveContexthubPluginDir();
  const superpowersPluginDir = "/tmp/fake-superpowers-plugin-dir";

  test("builds --bare --print --output-format json --no-session-persistence, in that exact order, first", () => {
    const argv = buildClaudeArgv({ prompt: "hello", contexthubPluginDir, superpowersPluginDir, remainingBudgetUsd: 5 });
    assert.deepEqual(argv.slice(0, 5), ["--bare", "--print", "--output-format", "json", "--no-session-persistence"]);
  });

  test("repeats --plugin-dir for exactly local Contexthub and the supplied Superpowers path, and no others", () => {
    const argv = buildClaudeArgv({ prompt: "hello", contexthubPluginDir, superpowersPluginDir, remainingBudgetUsd: 5 });
    const pluginDirIndices = argv.map((v, i) => (v === "--plugin-dir" ? i : -1)).filter((i) => i >= 0);
    assert.equal(pluginDirIndices.length, 2, "exactly two --plugin-dir flags");
    assert.equal(argv[pluginDirIndices[0] + 1], contexthubPluginDir);
    assert.equal(argv[pluginDirIndices[1] + 1], superpowersPluginDir);
    assert.ok(contexthubPluginDir.endsWith(join("plugins", "contexthub")));
  });

  test("passes the REMAINING --max-budget-usd, not the original total", () => {
    const argv = buildClaudeArgv({ prompt: "hello", contexthubPluginDir, superpowersPluginDir, remainingBudgetUsd: 1.5 });
    const idx = argv.indexOf("--max-budget-usd");
    assert.ok(idx >= 0);
    assert.equal(argv[idx + 1], "1.5");
  });

  test("uses --permission-mode dontAsk", () => {
    const argv = buildClaudeArgv({ prompt: "hello", contexthubPluginDir, superpowersPluginDir, remainingBudgetUsd: 5 });
    const idx = argv.indexOf("--permission-mode");
    assert.ok(idx >= 0);
    assert.equal(argv[idx + 1], "dontAsk");
  });

  test("allowlists exactly the file/search tools plus bounded local node/git status|add|commit Bash forms — nothing broader", () => {
    const argv = buildClaudeArgv({ prompt: "hello", contexthubPluginDir, superpowersPluginDir, remainingBudgetUsd: 5 });
    const idx = argv.indexOf("--allowedTools");
    assert.ok(idx >= 0);
    const tools = argv[idx + 1].split(",");
    assert.deepEqual(tools.sort(), [
      "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(node:*)",
      "Glob", "Grep", "Read",
    ].sort());
    // Explicitly never any of these — the negative half of "bounded."
    for (const forbidden of ["Bash(git push:*)", "Bash(git reset:*)", "Bash(git clean:*)", "Bash(*)", "WebFetch", "WebSearch", "Write", "Edit"]) {
      assert.ok(!tools.includes(forbidden), `must not allowlist ${forbidden}`);
    }
    assert.deepEqual([...ALLOWED_TOOLS].sort(), tools.slice().sort());
  });

  test("the prompt is the final positional argument", () => {
    const argv = buildClaudeArgv({ prompt: "the exact prompt text", contexthubPluginDir, superpowersPluginDir, remainingBudgetUsd: 5 });
    assert.equal(argv[argv.length - 1], "the exact prompt text");
  });

  test("rejects a non-positive remaining budget even at argv-build time", () => {
    assert.throws(() => buildClaudeArgv({ prompt: "hello", contexthubPluginDir, superpowersPluginDir, remainingBudgetUsd: 0 }), LiveEvalError);
  });
});

// ============================================================================
// formatUsd
// ============================================================================

describe("formatUsd", () => {
  test("rounds sub-cent floating point residue to a stable value without flooring a genuine tiny remainder to zero", () => {
    assert.equal(formatUsd(6.999999999999999), "7");
    assert.equal(formatUsd(0.0000001), "0"); // rounds below the six-decimal floor
    assert.equal(formatUsd(0.000002), "0.000002"); // but a real six-decimal remainder survives
    assert.equal(formatUsd(4.5), "4.5");
  });
});

// ============================================================================
// parseClaudeCostResult — fail-closed cost parsing
// ============================================================================

describe("parseClaudeCostResult", () => {
  test("accepts a well-formed result", () => {
    const r = parseClaudeCostResult(JSON.stringify({ total_cost_usd: 1.23, result: "ok" }));
    assert.equal(r.ok, true);
    assert.equal(r.costUsd, 1.23);
  });

  test("fails closed on malformed JSON", () => {
    const r = parseClaudeCostResult("not json at all {{{");
    assert.equal(r.ok, false);
  });

  test("fails closed on a JSON array instead of an object", () => {
    assert.equal(parseClaudeCostResult("[1,2,3]").ok, false);
  });

  test("fails closed on a missing total_cost_usd field", () => {
    assert.equal(parseClaudeCostResult(JSON.stringify({ result: "ok" })).ok, false);
  });

  test("fails closed on a non-numeric total_cost_usd", () => {
    assert.equal(parseClaudeCostResult(JSON.stringify({ total_cost_usd: "1.23" })).ok, false);
  });

  test("fails closed on a negative total_cost_usd", () => {
    assert.equal(parseClaudeCostResult(JSON.stringify({ total_cost_usd: -0.01 })).ok, false);
  });

  test("fails closed on a non-finite total_cost_usd (an overflowing numeric literal parses to Infinity)", () => {
    assert.equal(parseClaudeCostResult('{"total_cost_usd": 1e400}').ok, false);
  });
});

// ============================================================================
// runLiveEvals — dry-run mode: never spawns Claude
// ============================================================================

describe("runLiveEvals dry-run mode", () => {
  test("dry-run builds argv for every case and NEVER calls spawnImpl", async () => {
    const cases = [makeCase({ id: "a" }), makeCase({ id: "b" })];
    const result = await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 5, dryRun: true, spawnImpl: throwingSpawnImpl(),
    });
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((r) => r.dryRun === true && Array.isArray(r.argv)));
    assert.equal(result.cumulativeSpendUsd, 0, "dry-run must never report any spend");
    assert.equal(result.stoppedEarly, false);
  });

  test("dry-run still rejects a non-positive total budget before building any argv", async () => {
    await assert.rejects(runLiveEvals({
      cases: [makeCase()], contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/x",
      maxBudgetUsd: 0, dryRun: true,
    }), LiveEvalError);
  });

  test("the CLI's own --dry-run path never spawns Claude either", async () => {
    const scratch = scratchDir();
    const casesPath = join(scratch, "cases.json");
    writeFileSync(casesPath, JSON.stringify({ version: 1, cases: [makeCase()] }));
    const outBuf = [];
    const errBuf = [];
    const io = { stdout: { write: (s) => outBuf.push(s) }, stderr: { write: (s) => errBuf.push(s) }, env: {} };
    const code = await main(["--cases", casesPath, "--superpowers-plugin-dir", scratch, "--max-budget-usd", "3", "--dry-run"], io);
    assert.equal(code, 0, errBuf.join(""));
    const parsed = JSON.parse(outBuf.join(""));
    assert.equal(parsed.results[0].dryRun, true);
    assert.equal(parsed.cumulativeSpendUsd, 0);
  });
});

// ============================================================================
// runLiveEvals — fake-JSON-driven real path: budget depletion, early stop,
// cumulative spend, and fail-closed handling. spawnImpl below is 100% fake
// and never touches a real `claude` binary — this is the "no deterministic
// test may incur provider usage" boundary for the non-dry-run code path.
// ============================================================================

describe("runLiveEvals with a fake spawnImpl (budget tracking)", () => {
  function fakeSpawnImplReturning(costsById) {
    const calls = [];
    const impl = async (bin, argv, opts) => {
      calls.push({ bin, argv, cwd: opts.cwd });
      const promptArg = argv[argv.length - 1];
      const caseId = Object.keys(costsById).find((id) => promptArg.includes(id));
      const cost = costsById[caseId];
      return { stdout: typeof cost === "string" ? cost : JSON.stringify({ total_cost_usd: cost, result: "ok" }) };
    };
    impl.calls = calls;
    return impl;
  }

  test("budget depletes across three sequential argv builds, then stops early before a fourth case", async () => {
    const cases = ["c1", "c2", "c3", "c4"].map((id) => makeCase({ id, prompt: `case ${id}: do the thing` }));
    const spawnImpl = fakeSpawnImplReturning({ "case c1": 4, "case c2": 5, "case c3": 1 });
    const root = scratchDir();
    const result = await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 10, dryRun: false, disposableRoot: root, spawnImpl,
    });

    assert.equal(spawnImpl.calls.length, 3, "exactly three cases must have actually been attempted");
    // THE DEPLETION ITSELF, PROVEN AT THE ARGV LEVEL: each successive call's
    // --max-budget-usd reflects the REMAINING amount, not the original 10.
    const budgetsPassed = spawnImpl.calls.map((c) => c.argv[c.argv.indexOf("--max-budget-usd") + 1]);
    assert.deepEqual(budgetsPassed, ["10", "6", "1"]);

    assert.equal(result.stoppedEarly, true, "the fourth case must never be attempted once the budget hits zero");
    assert.equal(result.results.length, 3);
    assert.equal(result.results.every((r) => r.dryRun === false), true);
    assert.equal(result.cumulativeSpendUsd, 10, "cumulative actual spend must equal the sum of the three reported costs");
    assert.equal(result.remainingBudgetUsd, 0);
    assert.equal(result.failedClosed, null);
  });

  test("a case that spends less than its cap leaves a genuine positive remainder for the next case", async () => {
    const cases = ["c1", "c2"].map((id) => makeCase({ id, prompt: `case ${id}: do the thing` }));
    const spawnImpl = fakeSpawnImplReturning({ "case c1": 2, "case c2": 1.5 });
    const root = scratchDir();
    const result = await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 10, dryRun: false, disposableRoot: root, spawnImpl,
    });
    assert.equal(spawnImpl.calls.length, 2);
    const budgetsPassed = spawnImpl.calls.map((c) => c.argv[c.argv.indexOf("--max-budget-usd") + 1]);
    assert.deepEqual(budgetsPassed, ["10", "8"]);
    assert.equal(result.stoppedEarly, false);
    assert.equal(result.cumulativeSpendUsd, 3.5);
    assert.equal(result.remainingBudgetUsd, 6.5);
  });

  test("fail-closed: malformed cost JSON stops the run immediately and preserves prior outputs", async () => {
    const cases = ["c1", "c2", "c3"].map((id) => makeCase({ id, prompt: `case ${id}: do the thing` }));
    const spawnImpl = fakeSpawnImplReturning({ "case c1": 2, "case c2": "not json {{{" });
    const root = scratchDir();
    const outputsDir = join(root, "outputs");
    const result = await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 10, dryRun: false, disposableRoot: root, outputsDir, spawnImpl,
    });
    assert.equal(spawnImpl.calls.length, 2, "the run must stop at the malformed case and never attempt the third");
    assert.ok(result.failedClosed);
    assert.equal(result.failedClosed.caseId, "c2");
    assert.equal(result.results.length, 1, "only c1's successful result is recorded");

    // OUTPUTS ARE PRESERVED FOR AUDIT: c1's full output exists on disk even
    // though the run as a whole failed closed.
    assert.equal(existsSync(join(outputsDir, "c1.json")), true);
    const c1Output = JSON.parse(readFileSync(join(outputsDir, "c1.json"), "utf8"));
    assert.equal(c1Output.parsedCost.costUsd, 2);
    assert.equal(existsSync(join(outputsDir, "c2.json")), true, "the failing case's own raw output must also be preserved for audit");
    assert.equal(existsSync(join(outputsDir, "c3.json")), false, "a case never attempted must never have an output file");
  });

  test("fail-closed: a missing total_cost_usd field stops the run", async () => {
    const cases = [makeCase({ id: "c1", prompt: "case c1: do the thing" })];
    const spawnImpl = fakeSpawnImplReturning({ "case c1": JSON.stringify({ result: "ok" }) });
    const result = await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 10, dryRun: false, disposableRoot: scratchDir(), spawnImpl,
    });
    assert.ok(result.failedClosed);
    assert.match(result.failedClosed.reason, /missing or non-numeric/);
  });

  test("fail-closed: a negative reported cost stops the run", async () => {
    const cases = [makeCase({ id: "c1", prompt: "case c1: do the thing" })];
    const spawnImpl = fakeSpawnImplReturning({ "case c1": JSON.stringify({ total_cost_usd: -3 }) });
    const result = await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 10, dryRun: false, disposableRoot: scratchDir(), spawnImpl,
    });
    assert.ok(result.failedClosed);
    assert.match(result.failedClosed.reason, /negative/);
  });

  test("fail-closed: a reported cost that EXCEEDS the remaining cap it was granted stops the run rather than clamping silently", async () => {
    const cases = ["c1", "c2"].map((id) => makeCase({ id, prompt: `case ${id}: do the thing` }));
    // c1 is granted the full $10 remaining but claims to have spent $11 —
    // more than it could possibly have been authorized to spend.
    const spawnImpl = fakeSpawnImplReturning({ "case c1": 11 });
    const result = await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 10, dryRun: false, disposableRoot: scratchDir(), spawnImpl,
    });
    assert.equal(spawnImpl.calls.length, 1, "the second case must never be attempted after an over-cap report");
    assert.ok(result.failedClosed);
    assert.match(result.failedClosed.reason, /over-cap/);
    assert.equal(result.results.length, 0);
  });

  test("runLiveEvals refuses a non-dry-run call without spawnImpl or disposableRoot", async () => {
    await assert.rejects(runLiveEvals({
      cases: [makeCase()], contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/x",
      maxBudgetUsd: 5, dryRun: false,
    }), LiveEvalError);
  });
});

// ============================================================================
// createDisposableCaseRepo / writeCaseOutput — local git only, no provider
// usage, needed by the fake-spawnImpl tests above and by the (separately
// authorized) Step 4 real run.
// ============================================================================

describe("createDisposableCaseRepo", () => {
  test("creates one fresh, seeded git repository per case and refuses to reuse an existing case directory", () => {
    const root = scratchDir();
    const c = makeCase({ id: "seeded", setup: { files: { "a.txt": "hello\n", "nested/b.txt": "world\n" } } });
    const caseRoot = createDisposableCaseRepo(root, c);
    assert.equal(existsSync(join(caseRoot, ".git")), true);
    assert.equal(readFileSync(join(caseRoot, "a.txt"), "utf8"), "hello\n");
    assert.equal(readFileSync(join(caseRoot, "nested", "b.txt"), "utf8"), "world\n");
    assert.throws(() => createDisposableCaseRepo(root, c), LiveEvalError);
  });
});

describe("writeCaseOutput", () => {
  test("writes a per-case JSON audit file", () => {
    const root = scratchDir();
    const dest = writeCaseOutput(root, "some-case", { hello: "world" });
    assert.equal(JSON.parse(readFileSync(dest, "utf8")).hello, "world");
  });
});

// ============================================================================
// main() — CLI-level rejections, all deterministic and provider-free
// ============================================================================

describe("main() CLI-level rejections", () => {
  function io() {
    const outBuf = [];
    const errBuf = [];
    return { stdout: { write: (s) => outBuf.push(s) }, stderr: { write: (s) => errBuf.push(s) }, env: {}, out: () => outBuf.join(""), err: () => errBuf.join("") };
  }

  test("rejects a missing --cases", async () => {
    const i = io();
    const code = await main(["--superpowers-plugin-dir", "/tmp/x", "--max-budget-usd", "5", "--dry-run"], i);
    assert.equal(code, 2);
    assert.match(i.err(), /--cases/);
  });

  test("rejects a missing --superpowers-plugin-dir", async () => {
    const scratch = scratchDir();
    const casesPath = join(scratch, "cases.json");
    writeFileSync(casesPath, JSON.stringify({ version: 1, cases: [makeCase()] }));
    const i = io();
    const code = await main(["--cases", casesPath, "--max-budget-usd", "5", "--dry-run"], i);
    assert.equal(code, 2);
    assert.match(i.err(), /--superpowers-plugin-dir/);
  });

  test("rejects a non-existent --superpowers-plugin-dir", async () => {
    const scratch = scratchDir();
    const casesPath = join(scratch, "cases.json");
    writeFileSync(casesPath, JSON.stringify({ version: 1, cases: [makeCase()] }));
    const i = io();
    const code = await main(["--cases", casesPath, "--superpowers-plugin-dir", join(scratch, "nope"), "--max-budget-usd", "5", "--dry-run"], i);
    assert.equal(code, 2);
  });

  test("rejects a missing/zero/negative --max-budget-usd", async () => {
    const scratch = scratchDir();
    const casesPath = join(scratch, "cases.json");
    writeFileSync(casesPath, JSON.stringify({ version: 1, cases: [makeCase()] }));
    for (const budget of [undefined, "0", "-5"]) {
      const i = io();
      const argv = ["--cases", casesPath, "--superpowers-plugin-dir", scratch, "--dry-run"];
      if (budget !== undefined) argv.push("--max-budget-usd", budget);
      const code = await main(argv, i);
      assert.equal(code, 2, `budget ${budget} must be rejected`);
    }
  });

  test("rejects a cases fixture with an unknown assertion type", async () => {
    const scratch = scratchDir();
    const casesPath = join(scratch, "cases.json");
    writeFileSync(casesPath, JSON.stringify({ version: 1, cases: [makeCase({ assertion: { type: "not_a_real_assertion" } })] }));
    const i = io();
    const code = await main(["--cases", casesPath, "--superpowers-plugin-dir", scratch, "--max-budget-usd", "5", "--dry-run"], i);
    assert.equal(code, 2);
    assert.match(i.err(), /unknown/);
  });

  test("a real (non-dry-run) invocation refuses without a credential source, before touching the filesystem for a disposable root", async () => {
    const scratch = scratchDir();
    const casesPath = join(scratch, "cases.json");
    writeFileSync(casesPath, JSON.stringify({ version: 1, cases: [makeCase()] }));
    const i = io(); // env: {} — no ANTHROPIC_API_KEY
    const code = await main(["--cases", casesPath, "--superpowers-plugin-dir", scratch, "--max-budget-usd", "5"], i);
    assert.equal(code, 2);
    assert.match(i.err(), /credential/);
  });

  test("a real invocation with a credential but a non-disposable --target-root is refused before any spawn", async () => {
    const scratch = scratchDir();
    const casesPath = join(scratch, "cases.json");
    writeFileSync(casesPath, JSON.stringify({ version: 1, cases: [makeCase()] }));
    const i = io();
    i.env = { ANTHROPIC_API_KEY: "sk-ant-fake-for-shape-only" };
    const nonDisposable = join(process.cwd(), "should-never-exist-from-live-evals-test");
    const code = await main(["--cases", casesPath, "--superpowers-plugin-dir", scratch, "--max-budget-usd", "5", "--target-root", nonDisposable], i);
    assert.equal(code, 2);
    assert.equal(existsSync(nonDisposable), false);
  });
});
