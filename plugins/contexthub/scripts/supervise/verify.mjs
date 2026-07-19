// verify.mjs — host-owned verification runner for /contexthub:supervise.
//
// THIS FILE IS A GENUINE SECOND DEFENSE LAYER, NOT A RESTATEMENT of
// contracts.mjs's `validateVerificationCommand`. That validator's argv
// denylist is a documented, ACCEPTED gap: it cannot close inline-code
// interpreters (`perl -e`, `python3 -c`, `ruby -e`, ...) because `node -e`
// must stay reachable for legitimate verification commands, and there is no
// general way to tell those apart from argv shape alone. So this file does
// not try to lengthen that denylist — it adds four DIFFERENT, STRUCTURAL
// controls:
//
//   1. A repo-contained cwd (validateExecutionCwd, realpath-verified — the
//      `cwd` ARGUMENT itself is confined to the worktree; see caveat below).
//   2. `shell: false` on every spawn (the argv WE hand to spawn() is never
//      re-interpreted by a shell of ours; see caveat below).
//   3. A bounded, capped timeout on every command.
//   4. `requires_approval_ids` enforced immediately before the spawn call —
//      not merely checked for existence against a known list (that is
//      contracts.mjs's job at graph-acceptance time) but checked for
//      DECISION STATE (`APPROVED`, not merely "present") at execution time,
//      using whatever the live approvals state is right now.
//
// WHAT THESE CONTROLS ARE NOT — READ BEFORE TRUSTING THIS FILE FOR ISOLATION:
//
// Controls #1-#4 reduce accidental foot-guns and block the most direct
// shell-injection argv shapes. They are NOT a containment boundary, and
// none of them stop an accepted verification command from executing
// arbitrary code that a Codex worker wrote into the worktree — running
// generated code is inherent to verification. `make test`, `npm run test`,
// `pytest`, `cargo test`, and `docker run` all pass
// `validateVerificationCommand`'s denylist (rejecting them would break
// ordinary verification), and each is free to run a worker-authored
// Makefile, package.json script, test file, or Dockerfile with the HOST's
// full environment, unsandboxed. Control #2's `shell: false` does not stop
// this: it only means WE do not re-interpret argv through a shell before
// exec — the shell `make` invokes internally for each recipe line, or that
// `npm run` invokes via `sh -c`, is not our shell, and is entirely outside
// this control's reach. Control #1's cwd confinement only fixes the
// STARTING directory of the spawned process; it confines nothing the
// process does once it is running.
//
// Verified end-to-end (final whole-branch review): a graph-declared
// `["make", "test"]` command passes `validateVerificationCommand`, and a
// worker-authored Makefile it then runs wrote a file OUTSIDE the worktree
// as the host user — no sandbox, no denial, `status: PASS`.
//
// The resulting asymmetry: the Codex WORKER that authored the code ran
// confined under `workspace-write` sandboxing; this file's verification of
// what it wrote does not run confined at all. A caller relying on
// controls #1-#4 for isolation from worker-authored code is relying on
// something this file does not provide. Under-claim this, always — do not
// extend the argv denylist to try to close this gap; it cannot be closed
// that way (see contracts.mjs's `assertSafeVerificationArgv` comment).
//
// A non-zero/timeout host result always overrides a model's self-reported
// `DONE` — this file has no concept of the model's report at all; a caller
// combines `runVerificationSet`'s result with the model's report and the
// host result always wins.
//
// Node 20+ standard library only.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { validateVerificationCommand } from "./contracts.mjs";

export class VerifyError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerifyError";
  }
}

// A generous but genuinely bounded ceiling. `runVerificationCommand` accepts
// a caller-supplied `timeoutMs` but NEVER above this cap — mirroring
// codex.mjs's "the timeout is derived, never raisable by input" rule so a
// verification command can never be handed an effectively-unbounded budget.
export const MAX_VERIFY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const KILL_GRACE_MS = 5000;
const DISPLAY_MAX_CHARS = 2000;

function truncateForDisplay(text) {
  if (text.length <= DISPLAY_MAX_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, DISPLAY_MAX_CHARS)}\n… [truncated — see log for full output]`, truncated: true };
}

// --------------------------------------------------------------------------
// validateExecutionCwd — Step 5, control #1
// --------------------------------------------------------------------------

// Resolves `cwd` (a repo-relative path already shaped by
// contracts.mjs:normalizeRepoPath at graph-acceptance time, but re-checked
// here independently) against `worktreePath` and requires the REAL,
// symlink-resolved result to stay inside the REAL, symlink-resolved
// worktree. realpathSync on both sides closes the symlink-escape hole that a
// plain string-prefix check would miss (a relative path that looks
// contained can still resolve, via a symlink inside the worktree, to a
// location entirely outside it).
export function validateExecutionCwd(options) {
  const { worktreePath, cwd } = options ?? {};
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    throw new VerifyError("validateExecutionCwd: options.worktreePath must be a non-empty string");
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new VerifyError("validateExecutionCwd: options.cwd must be a non-empty string");
  }
  if (cwd.includes("..")) {
    throw new VerifyError(`validateExecutionCwd: cwd "${cwd}" must not contain ".." segments`);
  }
  const target = cwd === "." ? worktreePath : resolve(worktreePath, cwd);
  if (!existsSync(worktreePath)) {
    throw new VerifyError(`validateExecutionCwd: worktreePath does not exist: ${worktreePath}`);
  }
  if (!existsSync(target)) {
    throw new VerifyError(`validateExecutionCwd: cwd "${cwd}" does not exist under the worktree`);
  }
  const realWorktree = realpathSync(worktreePath);
  const realTarget = realpathSync(target);
  if (realTarget !== realWorktree && !realTarget.startsWith(realWorktree + sep)) {
    throw new VerifyError(`validateExecutionCwd: cwd "${cwd}" escapes the worktree (resolves to ${realTarget}, outside ${realWorktree})`);
  }
  return realTarget;
}

// --------------------------------------------------------------------------
// runVerificationCommand — Step 5, controls #2-#4
// --------------------------------------------------------------------------

// Runs exactly one accepted-graph verification command: `{id, argv, cwd,
// requires_approval_ids}`. Never shell-interpreted, never given an
// unbounded timeout, never run without every required approval already in
// `APPROVED` state, never run outside the worktree it was validated
// against. Always writes a full stdout/stderr/exit-metadata log to disk and
// returns a short, explicitly-marked-truncated display string alongside it
// — nothing is ever silently dropped, only summarized.
export async function runVerificationCommand(options) {
  const {
    command, worktreePath, approvals = {}, logDir, logNamePrefix,
    timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS, env, spawnImpl = spawn, killGraceMs = KILL_GRACE_MS,
  } = options ?? {};

  // Shape + static-denylist re-check (belt and suspenders — cheap, and this
  // file must never assume a caller already ran contracts.mjs).
  validateVerificationCommand(command, undefined);

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_VERIFY_TIMEOUT_MS) {
    throw new VerifyError(`runVerificationCommand: timeoutMs must be a positive integer <= ${MAX_VERIFY_TIMEOUT_MS} (got ${JSON.stringify(timeoutMs)})`);
  }
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    throw new VerifyError("runVerificationCommand: options.worktreePath is required");
  }
  if (typeof logDir !== "string" || logDir.length === 0 || typeof logNamePrefix !== "string" || logNamePrefix.length === 0) {
    throw new VerifyError("runVerificationCommand: options.logDir and options.logNamePrefix are required");
  }

  const execCwd = validateExecutionCwd({ worktreePath, cwd: command.cwd });

  // Control #4 — the approval GATE, checked for live decision state,
  // immediately before the spawn call below (nothing executes between this
  // check and the child process starting).
  for (const approvalId of command.requires_approval_ids) {
    const status = approvals[approvalId];
    if (status !== "APPROVED") {
      throw new VerifyError(`runVerificationCommand: verification "${command.id}" requires approval "${approvalId}", which is not APPROVED (current status: ${status ?? "unknown"})`);
    }
  }

  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${logNamePrefix}.log`);
  const startedAt = Date.now();

  return await new Promise((resolvePromise) => {
    const finish = (result, logText) => {
      try {
        writeFileSync(logPath, logText);
      } catch {
        // logging is best-effort; never fail verification bookkeeping over it
      }
      resolvePromise({ ...result, logPath, durationMs: Date.now() - startedAt });
    };

    let child;
    try {
      // Control #2 — never a shell. spawnImpl is process.spawn by default,
      // which without `shell: true` never invokes a shell to interpret argv.
      child = spawnImpl(command.argv[0], command.argv.slice(1), {
        cwd: execCwd,
        shell: false,
        env: env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish(
        { id: command.id, status: "FAIL", exitCode: null, timedOut: false, display: `spawn failed: ${err.message}`, truncated: false },
        `$ ${command.argv.join(" ")}\ncwd: ${execCwd}\n\nspawn error: ${err.message}\n`,
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;

    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });

    // Control #3 — bounded timeout, always present, always <= the cap
    // asserted above.
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, killGraceMs);
    }, timeoutMs);

    const settle = (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      const status = !spawnError && !timedOut && exitCode === 0 ? "PASS" : "FAIL";
      const combined = `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`;
      const { text: display, truncated } = truncateForDisplay(combined);
      const logText = [
        `$ ${command.argv.join(" ")}`,
        `cwd: ${execCwd}`,
        `exitCode: ${exitCode}`,
        `timedOut: ${timedOut}`,
        "",
        "=== stdout ===",
        stdout,
        "",
        "=== stderr ===",
        stderr,
        "",
      ].join("\n");
      finish({ id: command.id, status, exitCode, timedOut, display, truncated }, logText);
    };

    child.on("close", (code) => settle(code, false));
    child.on("error", () => settle(null, true));
  });
}

// --------------------------------------------------------------------------
// runVerificationSet — Step 5
// --------------------------------------------------------------------------

// Runs every command in `commands` sequentially (build-then-test ordering
// matters and this stays deterministic), always to completion regardless of
// an earlier failure — every command's evidence is collected, not just the
// first failure. `snapshotAfterFn`, compared against the caller-supplied
// `snapshotBefore`, is the SAME generic mechanism used for two different
// brief requirements: (a) per-task worker verification, where the snapshot
// is the pre-verification content fingerprint and a mismatch means
// verification itself mutated the worktree; and (b) final aggregate
// verification in the integration worktree, where the snapshot is
// {head, status} and a mismatch means a verification command left residue
// or moved HEAD. Either way, a residue/mutation is treated as a hard
// failure of the whole set, and the model's report is never consulted here.
export async function runVerificationSet(options) {
  const {
    commands, worktreePath, approvals, logDir, logPrefix = "verify",
    timeoutMs, env, snapshotBefore, snapshotAfterFn,
  } = options ?? {};

  if (!Array.isArray(commands)) {
    throw new VerifyError("runVerificationSet: options.commands must be an array");
  }

  const results = [];
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const namePrefix = `${logPrefix}-${String(i + 1).padStart(2, "0")}-${command.id}`;
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential
    const result = await runVerificationCommand({ command, worktreePath, approvals, logDir, logNamePrefix: namePrefix, timeoutMs, env });
    results.push(result);
  }

  const commandsPassed = results.every((r) => r.status === "PASS");

  let residue = false;
  let snapshotAfter = null;
  if (typeof snapshotAfterFn === "function") {
    snapshotAfter = snapshotAfterFn();
    if (snapshotBefore !== undefined && JSON.stringify(snapshotAfter) !== JSON.stringify(snapshotBefore)) {
      residue = true;
    }
  }

  return { results, commandsPassed, residue, snapshotBefore: snapshotBefore ?? null, snapshotAfter, allPass: commandsPassed && !residue };
}
