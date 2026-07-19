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
  createDisposableCaseRepo, writeCaseOutput, runLiveEvals, main, evaluateCaseAssertion,
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
    // Every assertion type now carries REQUIRED parameters (enforced by
    // validateCasesFixture), so the default here must be a fully-formed one.
    assertion: { type: "single_work_order", max_task_count: 1 },
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

  // The assertion PARAMETERS are load-bearing inputs to grading, not
  // decoration — a case that declares an assertion the evaluator could not
  // then evaluate must be rejected up front rather than silently becoming an
  // INCONCLUSIVE verdict after the paid call has already been made.
  test("rejects an assertion whose required parameters are missing or malformed", () => {
    const badAssertions = [
      { type: "single_work_order" },
      { type: "single_work_order", max_task_count: 0 },
      { type: "single_work_order", max_task_count: "1" },
      { type: "override_requires_reason" },
      { type: "override_requires_reason", grader_score: 9 },
      { type: "converge_evidence_constrains_planning_without_launch" },
      { type: "converge_evidence_constrains_planning_without_launch", expected_strategy_pattern: "" },
      { type: "converge_evidence_constrains_planning_without_launch", expected_strategy_pattern: "([unclosed" },
    ];
    for (const assertion of badAssertions) {
      assert.throws(
        () => validateCasesFixture({ version: 1, cases: [makeCase({ assertion })] }),
        LiveEvalError,
        `expected rejection for ${JSON.stringify(assertion)}`,
      );
    }
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

  test("allowlists exactly the read-only file/search tools plus two read-only git queries — and nothing that can execute code", () => {
    const argv = buildClaudeArgv({ prompt: "hello", contexthubPluginDir, superpowersPluginDir, remainingBudgetUsd: 5 });
    const idx = argv.indexOf("--allowedTools");
    assert.ok(idx >= 0);
    const tools = argv[idx + 1].split(",");
    assert.deepEqual(tools.slice().sort(), [
      "Bash(git log:*)", "Bash(git status:*)", "Glob", "Grep", "Read",
    ].sort());
    assert.deepEqual([...ALLOWED_TOOLS].sort(), tools.slice().sort());
  });

  // THE BOUND ITSELF, AS A PROPERTY — not merely "Bash(*) is absent".
  //
  // The previous version of this test asserted only that a handful of NAMED
  // bad grants were missing, which gave false comfort: `Bash(node:*)` was in
  // the allowlist and, under `--permission-mode dontAsk`, `node -e '<any
  // code>'` is exactly as powerful as `Bash(*)` — arbitrary filesystem writes
  // outside the disposable repo and outright network access. Enumerating
  // forbidden spellings could never have caught that, because the dangerous
  // grant was not one of the spellings enumerated.
  //
  // So this asserts the closed property instead: EVERY allowlisted entry must
  // be either a read-only file/search tool or a read-only `git` query. There
  // is no fallthrough for a new entry to slip through, and adding any
  // interpreter grant fails here regardless of how it is spelled.
  test("BOUND: every allowlisted entry is either a read-only file/search tool or a read-only git query — no entry can execute code, write files, or reach the network", () => {
    const READ_ONLY_FILE_TOOLS = new Set(["Read", "Glob", "Grep"]);
    const READ_ONLY_GIT_GRANT_RE = /^Bash\(git (status|log):\*\)$/;

    for (const tool of ALLOWED_TOOLS) {
      const ok = READ_ONLY_FILE_TOOLS.has(tool) || READ_ONLY_GIT_GRANT_RE.test(tool);
      assert.ok(ok, `allowlist entry "${tool}" is neither a read-only file/search tool nor a read-only git query — it may permit code execution, file writes, or network access`);
    }

    // Regression guard naming the exact finding this bound closes: a bare
    // interpreter grant, in ANY spelling, is unrepresentable in this list.
    const INTERPRETER_RE = /^Bash\(\s*(node|nodejs|deno|bun|python|python3|ruby|perl|php|sh|bash|zsh|dash|osascript|env|npx|pnpm|yarn)\b/i;
    for (const tool of ALLOWED_TOOLS) {
      assert.ok(!INTERPRETER_RE.test(tool), `allowlist entry "${tool}" grants an interpreter, which is arbitrary code execution under --permission-mode dontAsk`);
    }

    // And no entry may carry an inline-code flag, which is the specific
    // mechanism that made `Bash(node:*)` equivalent to `Bash(*)`.
    for (const tool of ALLOWED_TOOLS) {
      assert.ok(!/(^|[\s(])-(e|p)\b|--eval|--print\b/.test(tool), `allowlist entry "${tool}" carries an inline-code flag`);
    }

    // Mutating/networked tools remain absent (kept from the original test —
    // still true, just no longer the whole argument).
    for (const forbidden of ["Bash(node:*)", "Bash(git push:*)", "Bash(git reset:*)", "Bash(git clean:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(*)", "WebFetch", "WebSearch", "Write", "Edit", "NotebookEdit", "Task"]) {
      assert.ok(!ALLOWED_TOOLS.includes(forbidden), `must not allowlist ${forbidden}`);
    }
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
// evaluateCaseAssertion — the per-case VERDICT.
//
// Without this, the runner collected stdout and cost but emitted no pass/fail
// judgement at all, so a case's declared assertion parameters
// (`max_task_count`, `grader_score`, `expected_strategy_pattern`) were inert
// data and Step 4's "Cases assert: …" would have required hand-grading.
//
// THE FALLTHROUGH RULE, APPLIED HERE TOO: every path that cannot actually
// evaluate the property returns INCONCLUSIVE. Nothing returns PASS by
// default, and "I could not tell" is never reported as success.
// ============================================================================

describe("evaluateCaseAssertion", () => {
  function envelopeWith(resultText) {
    return { total_cost_usd: 0.5, result: resultText };
  }

  describe("single_work_order", () => {
    const c = makeCase({ assertion: { type: "single_work_order", max_task_count: 1 } });

    test("PASS when the reported task_count is within the declared maximum", () => {
      const v = evaluateCaseAssertion(c, envelopeWith('{"task_count": 1, "reasoning": "coupled"}'));
      assert.equal(v.verdict, "PASS");
      assert.equal(v.observed.task_count, 1);
    });

    test("FAIL when the model splits coupled work into artificial parallelism", () => {
      const v = evaluateCaseAssertion(c, envelopeWith('{"task_count": 3, "reasoning": "one per file"}'));
      assert.equal(v.verdict, "FAIL");
    });

    test("reads JSON out of a fenced code block, which is how models usually emit it", () => {
      const v = evaluateCaseAssertion(c, envelopeWith('Here is my answer:\n```json\n{"task_count": 1, "reasoning": "coupled"}\n```\n'));
      assert.equal(v.verdict, "PASS");
    });

    test("INCONCLUSIVE (never PASS) when task_count is missing, non-integer, or below 1", () => {
      for (const body of ['{"reasoning": "x"}', '{"task_count": "one"}', '{"task_count": 1.5}', '{"task_count": 0}']) {
        assert.equal(evaluateCaseAssertion(c, envelopeWith(body)).verdict, "INCONCLUSIVE", `body ${body}`);
      }
    });
  });

  describe("override_requires_reason", () => {
    const c = makeCase({ assertion: { type: "override_requires_reason", grader_score: 1 } });

    test("PASS when an overriding score carries a non-empty reason", () => {
      const v = evaluateCaseAssertion(c, envelopeWith('{"claude_score": 5, "override_reason": "irreversible 40M-row migration"}'));
      assert.equal(v.verdict, "PASS");
    });

    test("FAIL when the score is overridden with a null or empty reason", () => {
      for (const body of ['{"claude_score": 5, "override_reason": null}', '{"claude_score": 5, "override_reason": "   "}']) {
        assert.equal(evaluateCaseAssertion(c, envelopeWith(body)).verdict, "FAIL", `body ${body}`);
      }
    });

    test("PASS when the score agrees with the grader and the reason is correctly null", () => {
      const v = evaluateCaseAssertion(c, envelopeWith('{"claude_score": 1, "override_reason": null}'));
      assert.equal(v.verdict, "PASS");
    });

    test("FAIL when the score agrees with the grader but a reason is supplied anyway", () => {
      const v = evaluateCaseAssertion(c, envelopeWith('{"claude_score": 1, "override_reason": "agreed"}'));
      assert.equal(v.verdict, "FAIL");
    });

    test("INCONCLUSIVE when claude_score is missing or out of the 1-5 range", () => {
      for (const body of ['{"override_reason": "x"}', '{"claude_score": 9, "override_reason": "x"}']) {
        assert.equal(evaluateCaseAssertion(c, envelopeWith(body)).verdict, "INCONCLUSIVE", `body ${body}`);
      }
    });
  });

  describe("converge_evidence_constrains_planning_without_launch", () => {
    const c = makeCase({
      assertion: {
        type: "converge_evidence_constrains_planning_without_launch",
        expected_strategy_pattern: "event",
      },
    });

    test("PASS when the recorded strategy constrains planning and Converge was not launched", () => {
      const v = evaluateCaseAssertion(c, envelopeWith('{"invalidation_strategy": "event-based on updated_at", "converge_launched": false}'));
      assert.equal(v.verdict, "PASS");
    });

    test("FAIL when planning ignored the recorded evidence", () => {
      const v = evaluateCaseAssertion(c, envelopeWith('{"invalidation_strategy": "fixed 60s TTL", "converge_launched": false}'));
      assert.equal(v.verdict, "FAIL");
    });

    test("FAIL when Converge was launched during a planning-only step", () => {
      const v = evaluateCaseAssertion(c, envelopeWith('{"invalidation_strategy": "event-based on updated_at", "converge_launched": true}'));
      assert.equal(v.verdict, "FAIL");
    });

    test("INCONCLUSIVE when converge_launched is missing or not a boolean", () => {
      for (const body of ['{"invalidation_strategy": "event-based"}', '{"invalidation_strategy": "event-based", "converge_launched": "no"}']) {
        assert.equal(evaluateCaseAssertion(c, envelopeWith(body)).verdict, "INCONCLUSIVE", `body ${body}`);
      }
    });
  });

  describe("fail-closed fallthroughs", () => {
    test("INCONCLUSIVE when the result text contains no JSON object at all", () => {
      const c = makeCase({ assertion: { type: "single_work_order", max_task_count: 1 } });
      assert.equal(evaluateCaseAssertion(c, envelopeWith("I could not determine the task count.")).verdict, "INCONCLUSIVE");
    });

    test("INCONCLUSIVE when the envelope has no usable result field", () => {
      const c = makeCase({ assertion: { type: "single_work_order", max_task_count: 1 } });
      for (const env of [{}, { result: null }, { result: 42 }, null]) {
        assert.equal(evaluateCaseAssertion(c, env).verdict, "INCONCLUSIVE", `envelope ${JSON.stringify(env)}`);
      }
    });

    // The fallthrough test applied to the evaluator itself: an assertion type
    // the evaluator does not implement must be INCONCLUSIVE, never PASS —
    // even though validateCasesFixture already rejects unknown types, this
    // function must fail closed on its own rather than delegating its safety
    // to a check that lives somewhere else.
    test("INCONCLUSIVE for an assertion type the evaluator does not implement", () => {
      const c = makeCase({ assertion: { type: "some_future_unimplemented_assertion" } });
      const v = evaluateCaseAssertion(c, envelopeWith('{"task_count": 1}'));
      assert.equal(v.verdict, "INCONCLUSIVE");
    });

    test("every verdict this function can return is one of PASS/FAIL/INCONCLUSIVE", () => {
      const samples = [
        [makeCase({ assertion: { type: "single_work_order", max_task_count: 1 } }), envelopeWith('{"task_count": 1}')],
        [makeCase({ assertion: { type: "single_work_order", max_task_count: 1 } }), envelopeWith("nope")],
        [makeCase({ assertion: { type: "unknown_type" } }), envelopeWith("{}")],
      ];
      for (const [c, env] of samples) {
        assert.ok(["PASS", "FAIL", "INCONCLUSIVE"].includes(evaluateCaseAssertion(c, env).verdict));
      }
    });
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

  test("each attempted case carries a graded verdict, and the run summary reports counts plus an all-passed flag", async () => {
    const cases = [
      makeCase({ id: "pass-case", prompt: "case pass-case: report json", assertion: { type: "single_work_order", max_task_count: 1 } }),
      makeCase({ id: "fail-case", prompt: "case fail-case: report json", assertion: { type: "single_work_order", max_task_count: 1 } }),
      makeCase({ id: "incon-case", prompt: "case incon-case: report json", assertion: { type: "single_work_order", max_task_count: 1 } }),
    ];
    const spawnImpl = async (bin, argv) => {
      const prompt = argv[argv.length - 1];
      const body = prompt.includes("pass-case") ? '{"task_count": 1}'
        : prompt.includes("fail-case") ? '{"task_count": 4}'
          : "no json here at all";
      return { stdout: JSON.stringify({ total_cost_usd: 1, result: body }) };
    };
    const result = await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 10, dryRun: false, disposableRoot: scratchDir(), spawnImpl,
    });
    assert.deepEqual(result.results.map((r) => r.verdict), ["PASS", "FAIL", "INCONCLUSIVE"]);
    assert.deepEqual(result.verdictCounts, { PASS: 1, FAIL: 1, INCONCLUSIVE: 1 });
    assert.equal(result.allAssertionsPassed, false, "a run containing a FAIL or INCONCLUSIVE must never report all-passed");
  });

  test("allAssertionsPassed is true only when every case was attempted AND graded PASS", async () => {
    const cases = ["a", "b"].map((id) => makeCase({ id, prompt: `case ${id}: report json`, assertion: { type: "single_work_order", max_task_count: 1 } }));
    const spawnImpl = async () => ({ stdout: JSON.stringify({ total_cost_usd: 1, result: '{"task_count": 1}' }) });
    const result = await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 10, dryRun: false, disposableRoot: scratchDir(), spawnImpl,
    });
    assert.equal(result.allAssertionsPassed, true);
    assert.deepEqual(result.verdictCounts, { PASS: 2, FAIL: 0, INCONCLUSIVE: 0 });
  });

  test("a run that stopped early or failed closed can never report allAssertionsPassed, even if every ATTEMPTED case passed", async () => {
    const cases = ["a", "b"].map((id) => makeCase({ id, prompt: `case ${id}: report json`, assertion: { type: "single_work_order", max_task_count: 1 } }));
    // Case "a" passes its assertion but consumes the entire budget, so "b" is
    // never attempted — an unattempted case is not a passing case.
    const spawnImpl = async () => ({ stdout: JSON.stringify({ total_cost_usd: 10, result: '{"task_count": 1}' }) });
    const result = await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 10, dryRun: false, disposableRoot: scratchDir(), spawnImpl,
    });
    assert.equal(result.stoppedEarly, true);
    assert.deepEqual(result.results.map((r) => r.verdict), ["PASS"]);
    assert.equal(result.allAssertionsPassed, false, "an incomplete run must not claim every case passed");
  });

  test("the per-case audit file records the verdict alongside the raw output", async () => {
    const cases = [makeCase({ id: "audited", prompt: "case audited: report json", assertion: { type: "single_work_order", max_task_count: 1 } })];
    const spawnImpl = async () => ({ stdout: JSON.stringify({ total_cost_usd: 1, result: '{"task_count": 1}' }) });
    const root = scratchDir();
    const outputsDir = join(root, "outputs");
    await runLiveEvals({
      cases, contexthubPluginDir: resolveContexthubPluginDir(), superpowersPluginDir: "/tmp/fake-superpowers",
      maxBudgetUsd: 10, dryRun: false, disposableRoot: root, outputsDir, spawnImpl,
    });
    const audit = JSON.parse(readFileSync(join(outputsDir, "audited.json"), "utf8"));
    assert.equal(audit.verdict.verdict, "PASS");
    assert.ok(audit.stdout, "the raw output must still be preserved alongside the verdict");
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
