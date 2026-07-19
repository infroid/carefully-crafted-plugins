// git.mjs — Git isolation and truly atomic integration for /contexthub:supervise.
//
// The core safety property (shared with contracts.mjs/state.mjs/codex.mjs):
// THE HOST IS AUTHORITATIVE, THE MODEL IS NOT. Every ownership decision in
// this file is derived from an actual `git` invocation against the real
// repository — never from a worker's self-report. Codex workers run with
// `workspace-write`, which intentionally protects `.git` and resolved
// worktree Git metadata, so a worker can never stage, commit, or move HEAD;
// `inspectTaskChanges` is what turns "the worker exited" into "here is
// exactly what it touched," and nothing downstream ever trusts anything else.
//
// Node 20+ standard library only: child_process (spawnSync, no shell), fs,
// path, crypto. No shell interpolation anywhere in this file — every git
// invocation is an argv array passed with `shell: false` (the OS default for
// spawnSync without `shell: true`).
//
// ATOMIC INTEGRATION, PRECISELY WHAT "ATOMIC" MEANS HERE. A wave's verified
// task commits are cherry-picked, in task-ID order, into a disposable
// candidate branch/worktree created from the current integration HEAD.
// Nothing touches the real integration branch until EVERY cherry-pick in the
// candidate has succeeded. Publication is then a single `git merge --ff-only`
// from the clean integration worktree — a fast-forward can never conflict and
// never produces a merge commit, so it either fully succeeds or doesn't
// happen. A conflict at any point aborts the cherry-pick, deletes the
// candidate, and leaves the integration ref/worktree byte-for-byte where it
// was before the wave started. See the regression test in
// tests/unit/supervise-git.test.mjs that makes the SECOND of two candidate
// cherry-picks conflict and proves the first commit was never published.
//
// LEDGER-BASED IDEMPOTENCY. `git branch`/`git worktree add` are not
// idempotent by themselves — a repeat call after a crash must either safely
// no-op or safely fail, never silently reuse a DIFFERENT branch/worktree that
// happens to share a name. This file keeps a small on-disk ledger
// (`.ledger.json`, atomically written) inside the private worktree root
// recording exactly which {branch, path, baseCommit} this run created under
// each logical key ("integration", "w1-<taskId>", "candidate-w<wave>", ...).
// A repeat call is idempotent ONLY when the recorded entry matches the
// request exactly; any mismatch fails closed rather than reusing state that
// might belong to a different attempt.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync,
  openSync, closeSync, fsyncSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, isAbsolute } from "node:path";

import { validateIdentifier } from "./contracts.mjs";

export class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitError";
  }
}

// --------------------------------------------------------------------------
// Low-level git invocation — argv arrays only, never a shell string.
// --------------------------------------------------------------------------

function spawnGit(cwd, args, opts = {}) {
  const { env, encoding = "utf8" } = opts;
  const result = spawnSync("git", args, {
    cwd,
    shell: false,
    env: env ? { ...process.env, ...env } : process.env,
    encoding,
    maxBuffer: 1024 * 1024 * 256,
  });
  if (result.error) {
    throw new GitError(`git ${args.join(" ")} (cwd=${cwd}) failed to spawn: ${result.error.message}`);
  }
  return result;
}

// Throws on nonzero exit; returns trimmed utf8 stdout.
function gitOrThrow(cwd, args, opts) {
  const r = spawnGit(cwd, args, opts);
  if (r.status !== 0) {
    const stderr = typeof r.stderr === "string" ? r.stderr : (r.stderr ? r.stderr.toString("utf8") : "");
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    throw new GitError(`git ${args.join(" ")} (cwd=${cwd}) exited ${r.status}: ${(stderr || stdout).trim()}`);
  }
  return (typeof r.stdout === "string" ? r.stdout : "").trim();
}

// Like gitOrThrow, but strips only a single TRAILING newline rather than
// calling String.trim(). Plain trim() is wrong for `git status
// --porcelain=v1`: its first line begins with a semantically significant
// leading space (the "X" status-code column for an unstaged-only change),
// and trim() silently eats it, shifting every subsequent slice() by one
// character. Used anywhere a caller needs to parse porcelain output
// line-by-line rather than just check it for emptiness.
function gitOrThrowRawLines(cwd, args, opts) {
  const r = spawnGit(cwd, args, opts);
  if (r.status !== 0) {
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    throw new GitError(`git ${args.join(" ")} (cwd=${cwd}) exited ${r.status}: ${stderr.trim()}`);
  }
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}

// Does not throw on nonzero exit — callers that need to branch on
// success/failure without an exception (cherry-pick, branch existence
// probes, ...) use this directly.
function gitResult(cwd, args, opts) {
  const r = spawnGit(cwd, args, opts);
  return {
    status: r.status,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

// --------------------------------------------------------------------------
// Small path helpers
// --------------------------------------------------------------------------

function pathIsWithin(path, root) {
  if (root === ".") return true;
  const r = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === r || path.startsWith(`${r}/`);
}

// Filters write_paths down to the subset that currently exist (on disk or as
// a tracked path) in the worktree. `git add -A -- <pathspec>` throws "did
// not match any files" for any pathspec that matches nothing at all (neither
// a tracked path to remove nor a worktree path to add), so untouched
// write_paths must be excluded before they are ever handed to git, or a task
// that only touched SOME of its declared write_paths would fail to commit
// anything at all.
function existingPathspecs(worktreePath, writePaths) {
  return writePaths.filter((p) => {
    const root = p.endsWith("/") ? p.slice(0, -1) : p;
    if (existsSync(join(worktreePath, root))) return true;
    const tracked = gitResult(worktreePath, ["ls-files", "--", p]);
    return tracked.status === 0 && tracked.stdout.trim().length > 0;
  });
}

// PATHS ARE PARSED FROM NUL-DELIMITED OUTPUT, NEVER NEWLINE-DELIMITED.
//
// Without `-z`, git applies `core.quotePath` (default true) and returns a
// path containing any non-ASCII byte as a C-quoted, octal-escaped string:
// a real `src/café.txt` comes back literally as `"src/caf\303\251.txt"`,
// surrounding quotes included. `pathIsWithin("\"src/caf\\303\\251.txt\"",
// "src/")` is then false, so a task that legitimately touched such a file
// was rejected as an out-of-scope violation that never happened. It failed
// CLOSED (no security hole), but it made any task touching a non-ASCII
// filename impossible to complete while pointing the operator at a
// nonexistent scope violation.
//
// `-z` bypasses quoting entirely and emits raw bytes with NUL separators,
// so this is the only correct way to read a path out of git. Every path
// this module parses goes through a -z form.

// `git diff --name-status -z` emits: <status>NUL<path>NUL for ordinary
// changes, and <status>NUL<oldPath>NUL<newPath>NUL for renames/copies —
// i.e. the record length itself depends on the status code, which is why
// this is a sequential walk rather than a simple pairwise chunk.
function parseNameStatusZ(text) {
  const fields = text.split("\0").filter((f) => f.length > 0);
  const out = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i];
    if (status.startsWith("R") || status.startsWith("C")) {
      out.push({ status, path: fields[i + 1], path2: fields[i + 2] });
      i += 3;
    } else {
      out.push({ status, path: fields[i + 1] });
      i += 2;
    }
  }
  return out;
}

function parseZPaths(text) {
  return text.split("\0").filter((f) => f.length > 0);
}

// Resolves a per-worktree git metadata path (e.g. CHERRY_PICK_HEAD) to an
// absolute path. `--git-path` returns a RELATIVE path in a normal
// repository and an absolute one under a linked worktree, so the result is
// resolved against the invoking cwd rather than assumed to be either.
function gitMetaPath(worktreePath, name) {
  const withFormat = gitResult(worktreePath, ["rev-parse", "--path-format=absolute", "--git-path", name]);
  if (withFormat.status === 0) {
    const v = withFormat.stdout.trim();
    if (v) return v;
  }
  const bare = gitOrThrow(worktreePath, ["rev-parse", "--git-path", name]);
  return isAbsolute(bare) ? bare : resolve(worktreePath, bare);
}

function randomSuffix() {
  return randomBytes(4).toString("hex");
}

// write temp -> fsync -> atomic rename -> fsync parent, same pattern as
// state.mjs's persistRunAtomic (not imported — state.mjs does not export it
// — but the safety property it embodies is reused verbatim here for every
// atomic write this file performs).
function writeFileAtomic(targetPath, text) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = join(dirname(targetPath), `.tmp-${process.pid}-${randomSuffix()}-${Date.now()}`);
  writeFileSync(tmpPath, text, { mode: 0o600 });
  const fd = openSync(tmpPath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
  const dirFd = openSync(dirname(targetPath), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

// --------------------------------------------------------------------------
// inspectRepository — Step 1
// --------------------------------------------------------------------------

// `git rev-parse --path-format=absolute <flag>` requires Git 2.31+. Older
// Git rejects the unknown option outright; this falls back to the bare
// invocation and resolves a relative result against `cwd` itself — never
// against any presumed ".git" location, since a linked worktree's real
// git-dir lives under the MAIN repository's .git/worktrees/<name>, not
// under anything derivable by string-appending to the worktree path.
function revParsePathAbsolute(cwd, flag) {
  const withFormat = gitResult(cwd, ["rev-parse", "--path-format=absolute", flag]);
  if (withFormat.status === 0) {
    const v = withFormat.stdout.trim();
    if (v) return v;
  }
  const bare = gitOrThrow(cwd, ["rev-parse", flag]);
  return isAbsolute(bare) ? bare : resolve(cwd, bare);
}

// `--show-object-format` was added in Git 2.42. When it's unsupported, the
// object format is inferred ONLY from the full, already-validated HEAD
// length (40 hex = sha1, 64 hex = sha256) — never guessed from version
// strings or config.
function detectObjectFormat(cwd, headFull) {
  const r = gitResult(cwd, ["rev-parse", "--show-object-format"]);
  if (r.status === 0) {
    const v = r.stdout.trim();
    if (v === "sha1" || v === "sha256") return v;
  }
  if (/^[0-9a-f]{40}$/.test(headFull)) return "sha1";
  if (/^[0-9a-f]{64}$/.test(headFull)) return "sha256";
  throw new GitError(`inspectRepository: could not determine object format — HEAD "${headFull}" is neither a 40-hex sha1 nor a 64-hex sha256 value`);
}

export function inspectRepository(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new GitError("inspectRepository: cwd must be a non-empty string");
  }
  const check = gitResult(cwd, ["rev-parse", "--git-dir"]);
  if (check.status !== 0) {
    throw new GitError(`inspectRepository: "${cwd}" is not inside a Git repository: ${check.stderr.trim()}`);
  }

  const topLevel = revParsePathAbsolute(cwd, "--show-toplevel");
  const gitDir = revParsePathAbsolute(cwd, "--git-dir");
  const gitCommonDir = revParsePathAbsolute(cwd, "--git-common-dir");

  const headResult = gitResult(cwd, ["rev-parse", "HEAD"]);
  if (headResult.status !== 0) {
    throw new GitError(`inspectRepository: repository at "${topLevel}" has no commits yet (unborn HEAD) — supervise requires at least one existing commit to establish a base`);
  }
  const headCommit = headResult.stdout.trim();
  const objectFormat = detectObjectFormat(cwd, headCommit);

  const branchResult = gitResult(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;

  const statusText = gitOrThrowRawLines(cwd, ["status", "--porcelain=v1"]);
  const changedFiles = statusText.split("\n").filter(Boolean).map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
  const dirty = changedFiles.length > 0;

  // Require USABLE, EXISTING identities. This never invokes `git config
  // --global`/`--local` to set anything — it only reads. A missing or
  // unusable identity is reported as an actionable prerequisite error, not a
  // thrown exception, so a caller can surface it to the operator before ever
  // attempting to dispatch a worker or create a host commit.
  const authorResult = gitResult(cwd, ["var", "GIT_AUTHOR_IDENT"]);
  const committerResult = gitResult(cwd, ["var", "GIT_COMMITTER_IDENT"]);
  const authorIdent = authorResult.status === 0 ? authorResult.stdout.trim() : null;
  const committerIdent = committerResult.status === 0 ? committerResult.stdout.trim() : null;
  const identityOk = authorIdent !== null && committerIdent !== null;

  return {
    topLevel,
    gitDir,
    gitCommonDir,
    isLinkedWorktree: gitDir !== gitCommonDir,
    headCommit,
    objectFormat,
    branch,
    dirty,
    changedFiles,
    authorIdent,
    committerIdent,
    identityOk,
    prerequisiteError: identityOk
      ? null
      : "Git author/committer identity is not usable (git config user.name/user.email, or GIT_AUTHOR_*/GIT_COMMITTER_* env, must already be set) — supervise never mutates Git configuration, so this must be fixed before any worker is dispatched",
  };
}

// --------------------------------------------------------------------------
// ensurePrivateWorktreeRoot — Step 2
// --------------------------------------------------------------------------

const EXCLUDE_LINE = ".carefully-crafted/";

function ensureExcludeLine(excludePath, line) {
  mkdirSync(dirname(excludePath), { recursive: true });
  let content = "";
  try {
    content = readFileSync(excludePath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (content.split("\n").some((l) => l.trim() === line)) return; // already present — idempotent
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  writeFileSync(excludePath, content + (needsNewline ? "\n" : "") + line + "\n");
}

// Worktree contents live under <top-level>/.carefully-crafted/worktrees/<run-id>/,
// never inside the shared Git directory (which holds only ledger STATE — the
// run.json tree from state.mjs — never worktree file contents). Excluded
// idempotently via <git-common-dir>/info/exclude; the project's own
// .gitignore is never touched.
export function ensurePrivateWorktreeRoot(repoInfo, runId) {
  if (!repoInfo || typeof repoInfo.topLevel !== "string" || typeof repoInfo.gitCommonDir !== "string") {
    throw new GitError("ensurePrivateWorktreeRoot: repoInfo.topLevel and repoInfo.gitCommonDir are required");
  }
  validateIdentifier("run", runId);

  const root = join(repoInfo.topLevel, ".carefully-crafted", "worktrees", runId);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  ensureExcludeLine(join(repoInfo.gitCommonDir, "info", "exclude"), EXCLUDE_LINE);

  return {
    root,
    integration: join(root, "integration"),
    waveWorktreePath: (wave, taskId) => join(root, `wave-${wave}-${taskId}`),
    candidatePath: (wave) => join(root, `candidate-w${wave}`),
  };
}

// --------------------------------------------------------------------------
// Ledger — idempotency for branch/worktree creation
// --------------------------------------------------------------------------

function ledgerPath(worktreesRoot) {
  return join(worktreesRoot, ".ledger.json");
}

function readLedger(worktreesRoot) {
  try {
    return JSON.parse(readFileSync(ledgerPath(worktreesRoot), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new GitError(`readLedger: ${ledgerPath(worktreesRoot)} is corrupt: ${err.message}`);
  }
}

function writeLedgerEntry(worktreesRoot, key, entry) {
  const ledger = readLedger(worktreesRoot);
  ledger[key] = entry;
  writeFileAtomic(ledgerPath(worktreesRoot), JSON.stringify(ledger, null, 2));
}

function removeLedgerEntry(worktreesRoot, key) {
  const ledger = readLedger(worktreesRoot);
  if (key in ledger) {
    delete ledger[key];
    writeFileAtomic(ledgerPath(worktreesRoot), JSON.stringify(ledger, null, 2));
  }
}

function assertValidBranchName(topLevel, branch) {
  const r = gitResult(topLevel, ["check-ref-format", "--branch", branch]);
  if (r.status !== 0) {
    throw new GitError(`invalid branch name "${branch}": ${(r.stderr || r.stdout).trim()}`);
  }
}

function branchRefExists(topLevel, branch) {
  return gitResult(topLevel, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

// The single shared idempotency gate for every branch+worktree pair this
// file creates (integration, per-task, candidate). A collision is reused
// ONLY when the ledger's recorded {branch, path, baseCommit} for this exact
// logical key matches the request byte-for-byte AND both the branch ref and
// the worktree directory already exist; any other combination — a different
// base commit, a different path, a half-created state — fails closed rather
// than silently adopting state that might belong to a different attempt.
function ensureBranchAndWorktree({ repoInfo, worktreesRoot, key, branch, path, baseCommit, extraArgs = [] }) {
  assertValidBranchName(repoInfo.topLevel, branch);
  const ledger = readLedger(worktreesRoot);
  const existing = ledger[key];
  const branchExists = branchRefExists(repoInfo.topLevel, branch);
  const worktreeExists = existsSync(path);

  if (branchExists || worktreeExists) {
    const matches = existing && existing.branch === branch && existing.path === path && existing.baseCommit === baseCommit;
    if (matches && branchExists && worktreeExists) {
      return { branch, path, baseCommit, reused: true };
    }
    throw new GitError(
      `ensureBranchAndWorktree: collision for "${key}" (branch exists=${branchExists}, worktree exists=${worktreeExists}) does not cleanly match the ledger `
      + `(recorded ${JSON.stringify(existing ?? null)}; requested branch=${branch} path=${path} baseCommit=${baseCommit}) — refusing to reuse`,
    );
  }

  gitOrThrow(repoInfo.topLevel, ["branch", branch, baseCommit]);
  const add = gitResult(repoInfo.topLevel, ["worktree", "add", ...extraArgs, path, branch]);
  if (add.status !== 0) {
    // Roll back the branch we just created so a retry starts clean.
    gitResult(repoInfo.topLevel, ["branch", "-D", branch]);
    throw new GitError(`git worktree add ${path} ${branch} failed: ${add.stderr.trim()}`);
  }
  writeLedgerEntry(worktreesRoot, key, { branch, path, baseCommit });
  return { branch, path, baseCommit, reused: false };
}

// --------------------------------------------------------------------------
// Branch naming — Step 3
// --------------------------------------------------------------------------

export function integrationBranchName(runId) {
  return `carefully-crafted/${runId}/integration`;
}
export function taskBranchName(runId, wave, taskId) {
  return `carefully-crafted/${runId}/w${wave}-${taskId}`;
}
export function candidateBranchName(runId, wave) {
  return `carefully-crafted/${runId}/candidate-w${wave}`;
}

// --------------------------------------------------------------------------
// createIntegrationWorktree — Step 3
// --------------------------------------------------------------------------

// Creates `carefully-crafted/<run-id>/integration` from the recorded
// starting HEAD and checks it out at worktreePaths.integration. This is the
// ONE worktree Superpowers planning writes into and the ONE worktree every
// later branch-finishing operation runs from — the user's active checkout is
// never mutated by any function in this file.
export function createIntegrationWorktree(options) {
  const { repoInfo, runId, worktreePaths } = options ?? {};
  if (!repoInfo || !worktreePaths) throw new GitError("createIntegrationWorktree: options.repoInfo and options.worktreePaths are required");
  const branch = integrationBranchName(runId);
  const result = ensureBranchAndWorktree({
    repoInfo,
    worktreesRoot: worktreePaths.root,
    key: "integration",
    branch,
    path: worktreePaths.integration,
    baseCommit: repoInfo.headCommit,
  });
  return result;
}

// --------------------------------------------------------------------------
// createTaskWorktree — Step 3
// --------------------------------------------------------------------------

// Every wave-one worker branch is created from the recorded wave-one base
// (the integration HEAD right after planning was committed); every wave-two
// branch is created from the fully-integrated wave-one HEAD. Both are simply
// `options.baseCommit` — the caller (the scheduler) is the one that knows
// which HEAD that is for a given wave; this function only enforces branch
// naming, ledger idempotency, and (for a resume-exact correction) the
// clean-remove/recreate rule that lets a wave-two task reuse the EXACT
// absolute worktree path its wave-one source used, which is what makes a
// Codex `resume` (confined to that path via cwd, never via an argv flag)
// land on the same session.
export function createTaskWorktree(options) {
  const { repoInfo, runId, worktreePaths, wave, taskId, baseCommit, resumeExactSourceTaskId } = options ?? {};
  if (!repoInfo || !worktreePaths) throw new GitError("createTaskWorktree: options.repoInfo and options.worktreePaths are required");
  validateIdentifier("task", taskId);
  if (wave !== 1 && wave !== 2) throw new GitError(`createTaskWorktree: options.wave must be 1 or 2, got ${JSON.stringify(wave)}`);
  if (typeof baseCommit !== "string" || baseCommit.length === 0) throw new GitError("createTaskWorktree: options.baseCommit is required");

  const branch = taskBranchName(runId, wave, taskId);
  let path;
  if (resumeExactSourceTaskId) {
    if (wave !== 2) throw new GitError("createTaskWorktree: resumeExactSourceTaskId is only valid for wave 2");
    validateIdentifier("task", resumeExactSourceTaskId);
    const sourceKey = `w1-${resumeExactSourceTaskId}`;
    const source = readLedger(worktreePaths.root)[sourceKey];
    if (!source) throw new GitError(`createTaskWorktree: resume-exact source task "${resumeExactSourceTaskId}" has no recorded wave-1 worktree`);
    path = source.path;
    // Clean remove/recreate: the source worktree must already be clean
    // (verified inside removeCleanWorktree, which never force-removes).
    removeCleanWorktree({ repoInfo, path });
  } else {
    path = worktreePaths.waveWorktreePath(wave, taskId);
  }

  return ensureBranchAndWorktree({
    repoInfo,
    worktreesRoot: worktreePaths.root,
    key: `w${wave}-${taskId}`,
    branch,
    path,
    baseCommit,
  });
}

// --------------------------------------------------------------------------
// removeCleanWorktree
// --------------------------------------------------------------------------

// Dirty or unintegrated worktrees are NEVER force-removed: this function
// checks `git status --porcelain=v1` inside the worktree first and throws
// rather than removing anything if it is not empty. `git worktree remove`
// (no --force) additionally refuses on its own if the worktree contains
// modified/untracked files, so this is defense in depth, not the only gate.
export function removeCleanWorktree(options) {
  const { repoInfo, path, branch, branchCheckCwd } = options ?? {};
  if (!repoInfo) throw new GitError("removeCleanWorktree: options.repoInfo is required");

  if (existsSync(path)) {
    const statusCheck = gitResult(path, ["status", "--porcelain=v1"]);
    if (statusCheck.status !== 0) {
      throw new GitError(`removeCleanWorktree: could not read status of ${path}: ${statusCheck.stderr.trim()}`);
    }
    if (statusCheck.stdout.trim().length > 0) {
      throw new GitError(`removeCleanWorktree: refusing to remove a dirty worktree at ${path} (uncommitted changes present)`);
    }
    gitOrThrow(repoInfo.topLevel, ["worktree", "remove", path]);
  }
  if (branch) {
    // Safe delete only (-d, not -D): a branch that is not fully merged into
    // its upstream is, by definition, "unintegrated" and must not be
    // force-deleted by this general-purpose helper. "Fully merged" is judged
    // against the CURRENT branch of whichever worktree invokes the delete,
    // so a caller deleting a branch merged into some worktree OTHER than
    // repoInfo.topLevel's own checkout must say so explicitly via
    // branchCheckCwd (e.g. the integration worktree path).
    gitOrThrow(branchCheckCwd ?? repoInfo.topLevel, ["branch", "-d", branch]);
  }
  return { removed: true };
}

// --------------------------------------------------------------------------
// inspectTaskChanges — Step 4 (the ownership-derivation core)
// --------------------------------------------------------------------------

// Computes the OID of the tree that would result from staging exactly
// `writePaths` on top of the CURRENT worktree HEAD, using a scratch index
// (GIT_INDEX_FILE pointed outside .git — critical for a linked worktree,
// whose ".git" is a FILE, not a directory) so the real index is never
// touched. This is git's own content-addressed fingerprint: recomputing it
// after a real `git add -A -- <writePaths>` + `git commit` on the SAME base
// yields the identical tree OID for the identical content, which is what
// makes this fingerprint directly comparable pre-commit and post-commit
// (assertCommitOwnership / inspectTaskCommit re-derive it from the finished
// commit and compare) — see the "MATCH" proof in the scratch-repo
// experiment referenced in the Task 9 report.
function stageTreeFingerprint(worktreePath, scopedPaths) {
  const tmpIndexPath = join(tmpdir(), `supervise-idx-${process.pid}-${randomSuffix()}`);
  try {
    const env = { GIT_INDEX_FILE: tmpIndexPath };
    gitOrThrow(worktreePath, ["read-tree", "HEAD"], { env });
    gitOrThrow(worktreePath, ["add", "-A", "--", ...scopedPaths], { env });
    return gitOrThrow(worktreePath, ["write-tree"], { env });
  } finally {
    rmSync(tmpIndexPath, { force: true });
  }
}

// Immediately after a worker exits, this is the ENTIRE ownership derivation:
// HEAD must still equal the assigned base, the index must be unchanged
// (nothing staged — Codex workers never stage), and there must be a
// non-empty tracked+untracked change set wholly inside write_paths. A worker
// that stages anything, moves HEAD, or touches a path outside its
// write_paths is rejected here, in full, before host verification or a host
// commit is ever considered.
export function inspectTaskChanges(options) {
  const { worktreePath, baseCommit, writePaths } = options ?? {};
  if (!Array.isArray(writePaths) || writePaths.length === 0) {
    throw new GitError("inspectTaskChanges: options.writePaths must be a non-empty array");
  }

  const headNow = gitOrThrow(worktreePath, ["rev-parse", "HEAD"]);
  if (headNow !== baseCommit) {
    return { ok: false, reason: "head-moved", headNow, baseCommit };
  }

  const staged = parseZPaths(gitOrThrowRawLines(worktreePath, ["diff", "--cached", "--name-only", "-z"]));
  if (staged.length > 0) {
    return { ok: false, reason: "index-staged", stagedFiles: staged };
  }

  const trackedChanges = parseNameStatusZ(gitOrThrowRawLines(worktreePath, ["diff", "--name-status", "-z", "HEAD"]));
  const untracked = parseZPaths(gitOrThrowRawLines(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]));

  if (trackedChanges.length === 0 && untracked.length === 0) {
    return { ok: false, reason: "no-changes" };
  }

  const changedPaths = new Set();
  for (const c of trackedChanges) {
    changedPaths.add(c.path);
    if (c.path2) changedPaths.add(c.path2);
  }
  for (const p of untracked) changedPaths.add(p);

  const outOfScope = [...changedPaths].filter((p) => !writePaths.some((root) => pathIsWithin(p, root)));
  if (outOfScope.length > 0) {
    return { ok: false, reason: "out-of-scope", outOfScope, changedPaths: [...changedPaths] };
  }

  const scoped = existingPathspecs(worktreePath, writePaths);
  const fingerprint = stageTreeFingerprint(worktreePath, scoped);

  return { ok: true, changedPaths: [...changedPaths], trackedChanges, untracked, fingerprint };
}

// --------------------------------------------------------------------------
// createTaskCommit — Step 4
// --------------------------------------------------------------------------

// Stages exactly the validated write_paths and creates ONE host-owned commit
// using the repository's EXISTING identity (never mutated, never overridden
// with GIT_AUTHOR_*/-c user.*) and message `supervise(<run-id>): <task-id>`.
// Hooks are never disabled (no --no-verify). Re-verifies HEAD and the
// content fingerprint immediately before staging — the last possible moment
// — so a change that slipped in between host verification and this call
// (however unlikely) is caught rather than silently committed.
export function createTaskCommit(options) {
  const { repoInfo, worktreePath, baseCommit, writePaths, runId, taskId, expectedFingerprint } = options ?? {};
  if (!repoInfo) throw new GitError("createTaskCommit: options.repoInfo is required");

  const authorCheck = gitResult(worktreePath, ["var", "GIT_AUTHOR_IDENT"]);
  const committerCheck = gitResult(worktreePath, ["var", "GIT_COMMITTER_IDENT"]);
  if (authorCheck.status !== 0 || committerCheck.status !== 0) {
    throw new GitError("createTaskCommit: Git author/committer identity is not usable — refusing to create a host commit without a real identity");
  }

  const headNow = gitOrThrow(worktreePath, ["rev-parse", "HEAD"]);
  if (headNow !== baseCommit) {
    throw new GitError(`createTaskCommit: HEAD moved since verification (expected ${baseCommit}, got ${headNow}) — refusing to commit`);
  }

  const scoped = existingPathspecs(worktreePath, writePaths);
  if (scoped.length === 0) {
    throw new GitError("createTaskCommit: no changes exist within write_paths to commit");
  }

  const fingerprintNow = stageTreeFingerprint(worktreePath, scoped);
  if (expectedFingerprint !== undefined && fingerprintNow !== expectedFingerprint) {
    throw new GitError("createTaskCommit: content fingerprint changed since it was last verified — refusing to commit unverified content");
  }

  gitOrThrow(worktreePath, ["add", "-A", "--", ...scoped]);
  const message = `supervise(${runId}): ${taskId}`;
  const commitAttempt = gitResult(worktreePath, ["commit", "-m", message]);
  if (commitAttempt.status !== 0) {
    throw new GitError(`createTaskCommit: git commit failed (hook rejection or other failure) for task "${taskId}": ${(commitAttempt.stderr || commitAttempt.stdout).trim()}`);
  }

  const commit = gitOrThrow(worktreePath, ["rev-parse", "HEAD"]);
  return { commit, message, fingerprint: fingerprintNow };
}

// --------------------------------------------------------------------------
// inspectTaskCommit — Step 4
// --------------------------------------------------------------------------

// Requires EXACTLY one new non-merge descendant commit in base..HEAD and a
// completely clean tracked/untracked worktree afterward. This is what
// catches a pre-commit hook that mutated files (leaving the tree dirty) or
// silently added an extra commit — either failure means "block on the
// private task branch," never "trust the model's report."
export function inspectTaskCommit(options) {
  const { worktreePath, baseCommit, commit } = options ?? {};
  const headNow = gitOrThrow(worktreePath, ["rev-parse", "HEAD"]);
  const count = Number.parseInt(gitOrThrow(worktreePath, ["rev-list", "--count", `${baseCommit}..${commit}`]), 10);
  const parentsLine = gitOrThrow(worktreePath, ["rev-list", "--parents", "-n", "1", commit]);
  const parents = parentsLine.split(" ").filter(Boolean);
  const isNonMerge = parents.length === 2 && parents[1] === baseCommit;
  const statusText = gitOrThrow(worktreePath, ["status", "--porcelain=v1"]);
  const clean = statusText.trim().length === 0;
  const ok = headNow === commit && count === 1 && isNonMerge && clean;
  return { ok, headNow, count, isNonMerge, clean, commit, baseCommit };
}

// --------------------------------------------------------------------------
// assertCommitOwnership
// --------------------------------------------------------------------------

// Re-derives ownership from the FINISHED commit (never the worker's report):
// exactly one parent equal to baseCommit, every changed file inside
// write_paths, and — when a pre-commit fingerprint is supplied — the
// commit's own tree OID matches it exactly, proving nothing changed between
// the last verified fingerprint and the commit that was actually created.
export function assertCommitOwnership(options) {
  const { worktreePath, baseCommit, commit, writePaths, expectedFingerprint } = options ?? {};
  const parentsLine = gitOrThrow(worktreePath, ["rev-list", "--parents", "-n", "1", commit]);
  const parents = parentsLine.split(" ").filter(Boolean);
  if (parents.length !== 2) {
    throw new GitError(`assertCommitOwnership: commit ${commit} must have exactly one parent (non-merge), found ${parents.length - 1}`);
  }
  if (parents[1] !== baseCommit) {
    throw new GitError(`assertCommitOwnership: commit ${commit} parent ${parents[1]} does not equal the assigned base ${baseCommit}`);
  }
  const diffFiles = parseZPaths(gitOrThrowRawLines(worktreePath, ["diff", "--name-only", "-z", `${baseCommit}..${commit}`]));
  const outOfScope = diffFiles.filter((p) => !writePaths.some((root) => pathIsWithin(p, root)));
  if (outOfScope.length > 0) {
    throw new GitError(`assertCommitOwnership: commit ${commit} touches out-of-scope paths: ${outOfScope.join(", ")}`);
  }
  if (expectedFingerprint !== undefined) {
    const actualTree = gitOrThrow(worktreePath, ["rev-parse", `${commit}^{tree}`]);
    if (actualTree !== expectedFingerprint) {
      throw new GitError(`assertCommitOwnership: commit ${commit}'s tree does not match the last-verified content fingerprint (expected ${expectedFingerprint}, got ${actualTree})`);
    }
  }
  return { ok: true, files: diffFiles };
}

// --------------------------------------------------------------------------
// Candidate integration — Step 4 (truly atomic)
// --------------------------------------------------------------------------

export function createCandidateIntegration(options) {
  const { repoInfo, runId, worktreePaths, wave, integrationHead } = options ?? {};
  if (wave !== 1 && wave !== 2) throw new GitError(`createCandidateIntegration: options.wave must be 1 or 2, got ${JSON.stringify(wave)}`);
  const branch = candidateBranchName(runId, wave);
  const path = worktreePaths.candidatePath(wave);
  return ensureBranchAndWorktree({
    repoInfo,
    worktreesRoot: worktreePaths.root,
    key: `candidate-w${wave}`,
    branch,
    path,
    baseCommit: integrationHead,
  });
}

// Cherry-picks exactly one verified task commit into the candidate worktree.
// On a genuine conflict the attempt is aborted immediately (leaving the
// candidate at its pre-attempt HEAD) and `{ ok: false }` is returned — the
// caller decides whether to stop the wave there; this function never touches
// the real integration branch/worktree at all.
//
// A NON-ZERO EXIT IS NOT NECESSARILY A CONFLICT. Cherry-picking a change
// whose content is ALREADY present exits 1 with "The previous cherry-pick is
// now empty", leaving CHERRY_PICK_HEAD set and the worktree CLEAN. Treating
// that as a conflict aborted the entire candidate with a misleading
// `candidate-cherry-pick-conflict` on any recovery re-entry into a wave
// whose commits had partly landed — the exact opposite of "successful
// commits survive for recovery and are not rerun unnecessarily".
//
// The two cases are distinguished structurally, not by parsing git's prose:
// an empty pick leaves a CLEAN worktree with a cherry-pick in progress; a
// real conflict leaves unmerged entries (`UU`, `AA`, ...) so the worktree is
// NOT clean. Both were verified against the live CLI.
//
// Both an ALREADY-INTEGRATED commit (same SHA, found by isCommitIntegrated)
// and a CONTENT-EQUIVALENT one (different SHA — an independent commit that
// happened to make the same change, which no SHA-based pre-check can detect)
// land in the empty case, which is why the structural empty-detection below
// is the load-bearing mechanism rather than a SHA pre-check.
export function integrateCandidateCommit(options) {
  const { candidate, commit } = options ?? {};
  const result = gitResult(candidate.path, ["cherry-pick", "-x", "--no-edit", commit]);

  if (result.status !== 0) {
    const worktreeClean = gitResult(candidate.path, ["status", "--porcelain=v1"]).stdout.trim().length === 0;
    const pickInProgress = existsSync(gitMetaPath(candidate.path, "CHERRY_PICK_HEAD"));

    if (worktreeClean && pickInProgress) {
      // Empty pick: the content is already present. `--skip` (not
      // `--allow-empty`, which git itself does not accept here — verified)
      // resolves the in-progress state without fabricating an empty commit.
      const skip = gitResult(candidate.path, ["cherry-pick", "--skip"]);
      if (skip.status === 0) {
        return {
          ok: true,
          commit,
          empty: true,
          newHead: gitOrThrow(candidate.path, ["rev-parse", "HEAD"]),
        };
      }
      // --skip itself failed: fall through and treat this as a real failure
      // rather than leaving the candidate in a half-resolved state.
    }

    gitResult(candidate.path, ["cherry-pick", "--abort"]);
    return { ok: false, commit, stderr: result.stderr, stdout: result.stdout };
  }

  const newHead = gitOrThrow(candidate.path, ["rev-parse", "HEAD"]);
  return { ok: true, commit, empty: false, newHead };
}

// On failure: preserve the candidate's conflict state to a log, ensure any
// in-progress cherry-pick is fully aborted (idempotent — a no-op if
// integrateCandidateCommit already aborted it), confirm the worktree is
// clean, then remove the candidate worktree/branch. The candidate branch
// itself is force-deleted (-D) — it is a disposable scratch ref that was
// never meant to survive a failed wave, which is exactly what makes wholesale
// discard safe; this is NOT the same "never force-remove" rule that applies
// to task/integration worktrees with real, surviving work. The candidate
// WORKTREE is still only ever removed once `git status` proves it clean.
export function abortCandidateIntegration(options) {
  const { repoInfo, candidate, logPath, reason } = options ?? {};
  const statusBefore = gitResult(candidate.path, ["status"]).stdout;
  const logText = `abort reason: ${reason ?? "unspecified"}\ncandidate branch: ${candidate.branch}\ncandidate path: ${candidate.path}\n\n=== git status (before final abort) ===\n${statusBefore}\n`;
  if (logPath) {
    writeFileAtomic(logPath, logText);
  }

  gitResult(candidate.path, ["cherry-pick", "--abort"]); // idempotent no-op if nothing in progress

  const statusCheck = gitResult(candidate.path, ["status", "--porcelain=v1"]);
  if (statusCheck.status !== 0 || statusCheck.stdout.trim().length > 0) {
    throw new GitError(`abortCandidateIntegration: candidate worktree at ${candidate.path} is not clean after abort — refusing to remove it`);
  }

  gitOrThrow(repoInfo.topLevel, ["worktree", "remove", candidate.path]);
  gitOrThrow(repoInfo.topLevel, ["branch", "-D", candidate.branch]);
  removeLedgerEntry(dirname(candidate.path), `candidate-w${candidateWaveFromBranch(candidate.branch)}`);

  return { aborted: true, logPath: logPath ?? null };
}

function candidateWaveFromBranch(branch) {
  const m = /\/candidate-w(\d+)$/.exec(branch);
  return m ? m[1] : "?";
}

// The single publication step: verifies the integration worktree is exactly
// at the recorded pre-wave HEAD and clean, runs `git merge --ff-only`
// (which can only succeed by fast-forwarding — it can never conflict and
// never fabricates a merge commit), verifies the resulting HEAD, then
// removes the now-fully-merged candidate worktree/branch with a SAFE delete
// (-d), since it is provably an ancestor of the new integration HEAD.
export function publishCandidateIntegration(options) {
  const { repoInfo, integrationWorktreePath, candidate, expectedPreHead } = options ?? {};

  const preHead = gitOrThrow(integrationWorktreePath, ["rev-parse", "HEAD"]);
  if (preHead !== expectedPreHead) {
    throw new GitError(`publishCandidateIntegration: integration HEAD drifted before publish (expected ${expectedPreHead}, got ${preHead}) — refusing to merge`);
  }
  const preStatus = gitOrThrow(integrationWorktreePath, ["status", "--porcelain=v1"]);
  if (preStatus.trim().length > 0) {
    throw new GitError("publishCandidateIntegration: integration worktree is not clean — refusing to merge");
  }

  gitOrThrow(integrationWorktreePath, ["merge", "--ff-only", candidate.branch]);
  const newHead = gitOrThrow(integrationWorktreePath, ["rev-parse", "HEAD"]);

  gitOrThrow(repoInfo.topLevel, ["worktree", "remove", candidate.path]);
  // `git branch -d` judges "fully merged" against the CURRENT branch of the
  // worktree it is invoked from. The candidate is merged into the
  // integration branch specifically, which is checked out in
  // integrationWorktreePath, not necessarily in repoInfo.topLevel (whose own
  // checkout the user still controls and this file never touches) — so the
  // safe delete must run from there.
  gitOrThrow(integrationWorktreePath, ["branch", "-d", candidate.branch]);
  removeLedgerEntry(dirname(candidate.path), `candidate-w${candidateWaveFromBranch(candidate.branch)}`);

  return { published: true, head: newHead, preHead };
}

// --------------------------------------------------------------------------
// isCommitIntegrated
// --------------------------------------------------------------------------

// Cherry-picking (the only mechanism `integrateCandidateCommit` ever uses)
// always produces a NEW commit object with a different OID — a plain
// ancestry check of the ORIGINAL task commit against the integration ref is
// therefore always false once that commit has been through candidate
// integration, even though its content is fully present. `-x` (used by
// integrateCandidateCommit) records the origin in a durable
// "(cherry picked from commit <sha>)" trailer; this is the link recovery
// follows to answer "was this task's work already integrated," so a crash
// between a successful publish and the next phase transition never causes a
// re-run of work that is already safely on the integration branch.
export function isCommitIntegrated(options) {
  const { repoInfo, ref, commit } = options ?? {};
  if (gitResult(repoInfo.topLevel, ["merge-base", "--is-ancestor", commit, ref]).status === 0) {
    return true; // direct ancestor (e.g. the commit itself was fast-forwarded, not cherry-picked)
  }
  const found = gitResult(repoInfo.topLevel, ["log", "--format=%H", `--grep=cherry picked from commit ${commit}`, ref]);
  return found.status === 0 && found.stdout.trim().length > 0;
}

// --------------------------------------------------------------------------
// listRunWorktrees
// --------------------------------------------------------------------------

function parseWorktreeListPorcelain(text) {
  const blocks = text.split("\n\n").map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const entry = { path: null, head: null, branch: null, detached: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) entry.branch = line.slice("branch refs/heads/".length);
      else if (line === "detached") entry.detached = true;
    }
    return entry;
  });
}

export function listRunWorktrees(options) {
  const { repoInfo, runId } = options ?? {};
  const out = gitOrThrow(repoInfo.topLevel, ["worktree", "list", "--porcelain"]);
  const worktrees = parseWorktreeListPorcelain(out);
  const prefix = `carefully-crafted/${runId}/`;
  return worktrees.filter((w) => typeof w.branch === "string" && w.branch.startsWith(prefix));
}

// --------------------------------------------------------------------------
// Small read-only helpers reused by scheduler.mjs
// --------------------------------------------------------------------------

export function readHead(worktreePath) {
  return gitOrThrow(worktreePath, ["rev-parse", "HEAD"]);
}

export function isWorktreeClean(worktreePath) {
  return gitOrThrow(worktreePath, ["status", "--porcelain=v1"]).trim().length === 0;
}
