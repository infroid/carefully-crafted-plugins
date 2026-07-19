// checkpoint.mjs — compact, byte-capped checkpoints and final receipts for
// /contexthub:supervise.
//
// NEVER FAIL COMPLETED WORK AFTER WORKER COST WAS ALREADY INCURRED. A
// checkpoint is written AFTER a wave (or the final receipt after all
// verification) has already spent real worker time and real API cost.
// `buildCheckpoint`/`buildFinalReceipt` therefore never throw on overflow —
// they progressively drop detail (full task summaries -> id/status only ->
// counts only), always writing whatever was dropped to a deterministic
// on-disk detail artifact whose path is included in the bounded summary, so
// nothing is ever silently lost — only relocated. The ONLY thing that can
// still throw is a genuinely pathological scalar field (e.g. an absurdly
// long integration-head string) that overflows even the minimal, count-only
// shape; that is a caller bug, not a "too much data" situation, and callers
// should never see it in practice.
//
// Node 20+ standard library only.

import { mkdirSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";

import { ContractError } from "./contracts.mjs";

// Every Claude-facing checkpoint-*.json and final.json must stay at or below
// this many UTF-8 bytes (brief, Step 7, verbatim).
export const CHECKPOINT_MAX_BYTES = 8192;

function byteLen(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

// BEST-EFFORT BY CONSTRUCTION. Writing the detail artifact is the ONE step
// in the overflow ladder that touches the filesystem, so it is the one step
// that can fail for reasons entirely outside the caller's control (a missing
// detailDir, a read-only or full disk, a permissions problem). Because this
// runs only AFTER a wave's worker cost has already been paid, a failure here
// must never propagate: it degrades the result (detailPath becomes null and
// `detailUnavailable` records why) instead of destroying the checkpoint for
// completed work.
function tryWriteDetailArtifact(detailDir, name, value) {
  if (typeof detailDir !== "string" || detailDir.length === 0) {
    return { path: null, error: "no detailDir supplied" };
  }
  try {
    mkdirSync(detailDir, { recursive: true });
    const path = join(detailDir, `${name}.json`);
    writeFileSync(path, JSON.stringify(value, null, 2));
    return { path, error: null };
  } catch (err) {
    return { path: null, error: err.message };
  }
}

// Shared overflow ladder: try the full shape, then a slimmed shape (ids +
// statuses only, full detail moved to disk), then a minimal counts-only
// shape. Every rung is deterministic and every rung after the first
// includes a pointer to the detail artifact when one could be written.
//
// THE LADDER NEVER THROWS FOR A DATA-VOLUME REASON. Previously the detail
// write happened before the slim rung was attempted and threw outright when
// detailDir was missing or unwritable — which fires ONLY on overflow, so a
// run could work for months and then destroy a paid wave's checkpoint on its
// first large wave. That directly contradicted this module's own header
// promise. Now a failed detail write only makes `detailPath` null; the slim
// and minimal rungs are still produced and returned, and `detailUnavailable`
// tells the reader why the pointer is absent rather than silently implying
// there was nothing to point at.
function boundedArtifact({ full, buildSlim, buildMinimal, detailDir, detailName, cap = CHECKPOINT_MAX_BYTES }) {
  if (byteLen(full) <= cap) {
    return { ...full, overflow: null };
  }

  const detail = tryWriteDetailArtifact(detailDir, detailName, full);
  const overflow = { detailPath: detail.path, detailUnavailable: detail.error };

  const slim = { ...buildSlim(detail.path), overflow };
  if (byteLen(slim) <= cap) {
    return slim;
  }

  const minimal = { ...buildMinimal(detail.path), overflow };
  if (byteLen(minimal) > cap) {
    throw new ContractError(
      `checkpoint.mjs: even the minimal, counts-only summary for "${detailName}" exceeds ${cap} bytes — a required scalar field is pathologically large${detail.path ? `; full detail is preserved at ${detail.path}` : ""}`,
    );
  }
  return minimal;
}

// --------------------------------------------------------------------------
// buildCheckpoint — Step 7
// --------------------------------------------------------------------------

// Includes ONLY what the brief lists: wave number, integration HEAD, diff
// stat, acceptance matrix, task status/commit/summary/concerns, verification
// counts, usage totals, and ownership/integration violations. Full file
// lists, full command output, and full receipts always live elsewhere
// (receipts/reports/logs) and are only ever referenced by path here.
export function buildCheckpoint(input) {
  const {
    wave, integrationHead, diffStat, acceptanceMatrix = [], tasks = [],
    verificationCounts, usageTotals, violations = [], detailDir,
  } = input ?? {};

  if (wave !== 1 && wave !== 2) {
    throw new ContractError(`buildCheckpoint: input.wave must be 1 or 2, got ${JSON.stringify(wave)}`);
  }
  if (typeof integrationHead !== "string" || integrationHead.length === 0) {
    throw new ContractError("buildCheckpoint: input.integrationHead is required");
  }

  const full = {
    wave,
    integration_head: integrationHead,
    diff_stat: diffStat ?? null,
    acceptance: acceptanceMatrix.map((a) => ({ id: a.id, status: a.status, reason: a.reason ?? null })),
    // `.slice()`, not a bare reference: the enclosing `.map()` produces a
    // fresh OUTER object, but `t.concerns` would still be the caller's own
    // array, aliased into the returned checkpoint. A caller mutating its
    // task list afterward would retroactively change an already-built
    // checkpoint. Same by-reference escape class as the Task 8 review's
    // finding, one level deeper than the object the map creates.
    tasks: tasks.map((t) => ({
      id: t.id, status: t.status, commit: t.commit ?? null,
      summary: t.summary ?? "", concerns: (t.concerns ?? []).slice(),
    })),
    verification_counts: verificationCounts ?? null,
    usage_totals: usageTotals ?? null,
    violations: violations.slice(),
  };

  return boundedArtifact({
    full,
    detailDir,
    detailName: `checkpoint-${wave}-detail`,
    buildSlim: (detailPath) => ({
      wave,
      integration_head: integrationHead,
      diff_stat: diffStat ?? null,
      acceptance: acceptanceMatrix.map((a) => ({ id: a.id, status: a.status })),
      tasks: tasks.map((t) => ({ id: t.id, status: t.status, commit: t.commit ?? null })),
      verification_counts: verificationCounts ?? null,
      usage_totals: usageTotals ?? null,
      violations: { count: violations.length, detailPath },
    }),
    buildMinimal: (detailPath) => ({
      wave,
      integration_head: integrationHead,
      diff_stat: summarizeDiffStat(diffStat),
      verification_counts: verificationCounts ?? null,
      usage_totals: usageTotals ?? null,
      counts: {
        taskCount: tasks.length,
        acceptanceCount: acceptanceMatrix.length,
        violationCount: violations.length,
        detailPath,
      },
    }),
  });
}

function summarizeDiffStat(diffStat) {
  if (!diffStat || typeof diffStat !== "object") return null;
  return {
    filesChanged: diffStat.filesChanged ?? diffStat.files_changed ?? null,
    insertions: diffStat.insertions ?? null,
    deletions: diffStat.deletions ?? null,
  };
}

// --------------------------------------------------------------------------
// buildFinalReceipt — Step 7
// --------------------------------------------------------------------------

export function buildFinalReceipt(input) {
  const {
    integrationHead, finalVerification = [], acceptanceMatrix = [],
    usageTotals, waveSummaries = [], violations = [], detailDir,
  } = input ?? {};

  if (typeof integrationHead !== "string" || integrationHead.length === 0) {
    throw new ContractError("buildFinalReceipt: input.integrationHead is required");
  }

  const full = {
    integration_head: integrationHead,
    final_verification: finalVerification.map((v) => ({ id: v.id, status: v.status, exit_code: v.exitCode ?? null, log_path: v.logPath ?? null })),
    acceptance: acceptanceMatrix.map((a) => ({ id: a.id, status: a.status, reason: a.reason ?? null })),
    wave_summaries: waveSummaries.map((w) => ({ wave: w.wave, integration_head: w.integrationHead, task_count: w.taskCount ?? null })),
    usage_totals: usageTotals ?? null,
    violations: violations.slice(),
  };

  return boundedArtifact({
    full,
    detailDir,
    detailName: "final-detail",
    buildSlim: (detailPath) => ({
      integration_head: integrationHead,
      final_verification: finalVerification.map((v) => ({ id: v.id, status: v.status })),
      acceptance: acceptanceMatrix.map((a) => ({ id: a.id, status: a.status })),
      wave_summaries: waveSummaries.map((w) => ({ wave: w.wave, integration_head: w.integrationHead })),
      usage_totals: usageTotals ?? null,
      violations: { count: violations.length, detailPath },
    }),
    buildMinimal: (detailPath) => ({
      integration_head: integrationHead,
      usage_totals: usageTotals ?? null,
      counts: {
        finalVerificationCount: finalVerification.length,
        acceptanceCount: acceptanceMatrix.length,
        waveCount: waveSummaries.length,
        violationCount: violations.length,
        detailPath,
      },
    }),
  });
}

// --------------------------------------------------------------------------
// summarizeUsage
// --------------------------------------------------------------------------

// Sums Codex usage across an array of worker receipts (each carrying the
// receipt schema's `usage` block: input/cached-input/output/reasoning-output
// tokens). Never mutates its input.
export function summarizeUsage(receipts) {
  if (!Array.isArray(receipts)) {
    throw new ContractError("summarizeUsage: receipts must be an array");
  }
  const totals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, receipt_count: receipts.length };
  for (const r of receipts) {
    const u = r?.usage ?? {};
    totals.input_tokens += Number.isFinite(u.input_tokens) ? u.input_tokens : 0;
    totals.cached_input_tokens += Number.isFinite(u.cached_input_tokens) ? u.cached_input_tokens : 0;
    totals.output_tokens += Number.isFinite(u.output_tokens) ? u.output_tokens : 0;
    totals.reasoning_output_tokens += Number.isFinite(u.reasoning_output_tokens) ? u.reasoning_output_tokens : 0;
  }
  return totals;
}

// --------------------------------------------------------------------------
// writeCheckpoint
// --------------------------------------------------------------------------

// Atomic write (temp -> fsync -> rename -> fsync parent dir), the same
// pattern state.mjs uses for run.json — reimplemented locally since
// state.mjs does not export it and this file must not be modified to expose
// it. `paths` is the destination file path (a plain string, e.g.
// `getRunPaths(...).checkpoint1` / `.final` from state.mjs), or an object
// carrying one as `.path`, so a caller can pass either a bare path string or
// a richer paths object without this function caring which. This is also
// the LAST gate before anything reaches disk: even though
// buildCheckpoint/buildFinalReceipt already bound the value, a caller that
// constructs a checkpoint object by hand (bypassing the builders) cannot
// silently persist something over the byte cap.
export function writeCheckpoint(paths, value) {
  const targetPath = typeof paths === "string" ? paths : paths?.path;
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new ContractError("writeCheckpoint: paths must be a file path string, or an object with a .path field");
  }
  // Last gate before disk (contracts.mjs's own byte-cap helper is internal,
  // not exported, so this mirrors its exact rule locally rather than
  // reaching into contracts.mjs's private implementation). Deliberately
  // COMPACT (no pretty-print indentation): the cap is checked against
  // `JSON.stringify(value)` with no whitespace, matching contracts.mjs's own
  // convention, so the bytes actually written to disk must be that SAME
  // compact form — pretty-printing here would let a value that passes the
  // check still land on disk over the cap, purely from added indentation
  // whitespace.
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > CHECKPOINT_MAX_BYTES) {
    throw new ContractError(`writeCheckpoint: value is ${bytes} UTF-8 bytes serialized, max ${CHECKPOINT_MAX_BYTES} — checkpoint/final receipt must be built via buildCheckpoint/buildFinalReceipt, which always bound it`);
  }

  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(targetPath)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmpPath, text, { mode: 0o600 });
  const fd = openSync(tmpPath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return targetPath;
}
