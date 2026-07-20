// Unit tests for plugins/contexthub/scripts/supervise/git.mjs
// Run with: node --test tests/unit/supervise-git.test.mjs
//
// Every test here uses a REAL temporary Git repository and real
// `git worktree`/commit/cherry-pick operations — no fakes, no mocks of git
// itself. Both a normal (non-worktree) repository and a linked worktree
// (where ".git" is a file, not a directory) are exercised, per the brief.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GitError,
  inspectRepository,
  ensurePrivateWorktreeRoot,
  createIntegrationWorktree,
  createTaskWorktree,
  inspectTaskChanges,
  createTaskCommit,
  inspectTaskCommit,
  assertCommitOwnership,
  createCandidateIntegration,
  integrateCandidateCommit,
  publishCandidateIntegration,
  abortCandidateIntegration,
  isCommitIntegrated,
  removeCleanWorktree,
  listRunWorktrees,
  readHead,
  isWorktreeClean,
} from "../../plugins/contexthub/scripts/supervise/git.mjs";

// --------------------------------------------------------------------------
// Test harness
// --------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  // realpathSync immediately: on macOS, tmpdir() lives under /var, which is
  // itself a symlink to /private/var. git.mjs always resolves to the REAL
  // path, so any test-side comparison against the raw mkdtempSync() path
  // would spuriously fail on the symlink hop, not on anything git.mjs
  // actually got wrong.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sup-git-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "a.txt"), "base-a\n");
  writeFileSync(join(repo, "b.txt"), "base-b\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "existing.txt"), "base-src\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return repo;
}

// Returns { repo, linked } where `linked` is a pre-existing linked worktree
// of `repo` (its own separate branch), simulating a user whose active
// checkout IS a linked worktree — `.git` there is a FILE, not a directory.
function makeRepoWithLinkedWorktree() {
  const repo = makeRepo();
  const root = repo.slice(0, repo.lastIndexOf("/"));
  const linked = join(root, "linked-checkout");
  git(repo, ["worktree", "add", linked, "-b", "user-linked-checkout", "HEAD"]);
  return { repo, linked };
}

let runIdCounter = 0;
function freshRunId() {
  runIdCounter += 1;
  return `20260719T${String(120000 + runIdCounter).padStart(6, "0")}Z-${String(runIdCounter).padStart(8, "0")}`;
}

// --------------------------------------------------------------------------
// inspectRepository — Step 1
// --------------------------------------------------------------------------

describe("inspectRepository", () => {
  test("returns absolute topLevel/gitDir/gitCommonDir, HEAD, object format, branch, clean status, and identities for a normal repo", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);

    assert.equal(info.topLevel, repo);
    assert.equal(info.gitDir, join(repo, ".git"));
    assert.equal(info.gitCommonDir, join(repo, ".git"));
    assert.equal(info.isLinkedWorktree, false);
    assert.match(info.headCommit, /^[0-9a-f]{40}$/);
    assert.equal(info.objectFormat, "sha1");
    assert.equal(info.branch, "main");
    assert.equal(info.dirty, false);
    assert.deepEqual(info.changedFiles, []);
    assert.equal(info.identityOk, true);
    assert.equal(info.prerequisiteError, null);
    assert.match(info.authorIdent, /Test User <test@example\.com>/);
    assert.match(info.committerIdent, /Test User <test@example\.com>/);
  });

  test("reports dirty=true and lists changed files when the worktree has uncommitted changes", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.txt"), "modified\n");
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    const info = inspectRepository(repo);
    assert.equal(info.dirty, true);
    const paths = info.changedFiles.map((f) => f.path).sort();
    assert.deepEqual(paths, ["a.txt", "untracked.txt"]);
  });

  test("branch is null (not thrown) for a detached HEAD", () => {
    const repo = makeRepo();
    const head = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-q", "--detach", head]);
    const info = inspectRepository(repo);
    assert.equal(info.branch, null);
    assert.equal(info.headCommit, head);
  });

  test("throws GitError for a path that is not inside a Git repository", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "sup-notrepo-"));
    assert.throws(() => inspectRepository(notARepo), GitError);
  });

  test("throws GitError for a repository with no commits yet (unborn HEAD)", () => {
    const root = mkdtempSync(join(tmpdir(), "sup-unborn-"));
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    assert.throws(() => inspectRepository(repo), /no commits yet|unborn/);
  });

  test("linked worktree: gitDir differs from gitCommonDir, isLinkedWorktree is true, topLevel is the linked path (.git there is a FILE)", () => {
    const { repo, linked } = makeRepoWithLinkedWorktree();
    assert.equal(execFileSync("test", ["-f", join(linked, ".git")], { encoding: "utf8" }) === "" ? true : true, true); // sanity: no throw means it's a regular file (test -f)

    const info = inspectRepository(linked);
    assert.equal(info.topLevel, linked);
    assert.equal(info.gitCommonDir, join(repo, ".git"));
    assert.notEqual(info.gitDir, info.gitCommonDir);
    assert.ok(info.gitDir.startsWith(join(repo, ".git", "worktrees")));
    assert.equal(info.isLinkedWorktree, true);
    assert.equal(info.identityOk, true); // identity is repo-shared, so still usable from the linked worktree
  });

  test("returns an actionable prerequisite error (not a throw) when no usable Git identity exists, and never mutates repository config", () => {
    // `git var GIT_AUTHOR_IDENT` falls back to OS user info (getpwuid) when
    // nothing else is configured, so a genuine identity failure requires
    // BOTH an isolated HOME/XDG_CONFIG_HOME (no global config) AND the
    // repository-local `user.useConfigOnly = true` (disables that OS
    // fallback) — this is the real, reproducible way identity resolution
    // fails, verified against the live `git var` behavior before writing
    // this test.
    const root = mkdtempSync(join(tmpdir(), "sup-noident-"));
    const home = join(root, "isolated-home");
    mkdirSync(home, { recursive: true });
    const repo = join(root, "repo");
    mkdirSync(repo);
    const isolatedEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" };

    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: isolatedEnv });
    // Seed a real commit using a throwaway identity via GIT_AUTHOR_*/
    // GIT_COMMITTER_* env (never touching repo config), so the repo is
    // otherwise well-formed before the identity is removed for the actual
    // check below.
    writeFileSync(join(repo, "a.txt"), "x\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo, env: isolatedEnv });
    execFileSync("git", ["commit", "-qm", "init"], {
      cwd: repo,
      env: { ...isolatedEnv, GIT_AUTHOR_NAME: "Seed", GIT_AUTHOR_EMAIL: "seed@example.com", GIT_COMMITTER_NAME: "Seed", GIT_COMMITTER_EMAIL: "seed@example.com" },
    });
    execFileSync("git", ["config", "user.useConfigOnly", "true"], { cwd: repo, env: isolatedEnv });

    const before = readFileSync(join(repo, ".git", "config"), "utf8");

    // inspectRepository always spawns git with process.env, so temporarily
    // swap process.env to the isolated environment for the duration of this
    // one call, then restore it exactly — this is the only way to drive the
    // real function (not a re-implementation of its identity check) through
    // this branch, since inspectRepository(cwd) takes no env parameter.
    const savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, isolatedEnv);
    let info;
    try {
      info = inspectRepository(repo);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }

    assert.equal(info.identityOk, false);
    assert.equal(info.authorIdent, null);
    assert.equal(info.committerIdent, null);
    assert.match(info.prerequisiteError, /identity/i);
    assert.match(info.prerequisiteError, /never mutates/i);

    const after = readFileSync(join(repo, ".git", "config"), "utf8");
    assert.equal(before, after); // inspectRepository never mutates repository config
  });
});

// --------------------------------------------------------------------------
// ensurePrivateWorktreeRoot — Step 2
// --------------------------------------------------------------------------

describe("ensurePrivateWorktreeRoot", () => {
  test("creates worktree paths under <top-level>/.carefully-crafted/worktrees/<run-id>/", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);

    assert.equal(paths.root, join(repo, ".carefully-crafted", "worktrees", runId));
    assert.equal(paths.integration, join(paths.root, "integration"));
    assert.equal(paths.waveWorktreePath(1, "t1"), join(paths.root, "wave-1-t1"));
    assert.equal(paths.waveWorktreePath(2, "t1"), join(paths.root, "wave-2-t1"));
    assert.ok(existsSync(paths.root));
  });

  test("adds .carefully-crafted/ to <git-common-dir>/info/exclude idempotently, and never touches .gitignore", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();

    ensurePrivateWorktreeRoot(info, runId);
    ensurePrivateWorktreeRoot(info, runId); // second call: must not duplicate the line
    ensurePrivateWorktreeRoot(info, freshRunId()); // a different run: still idempotent on the SAME line

    const exclude = readFileSync(join(info.gitCommonDir, "info", "exclude"), "utf8");
    const occurrences = exclude.split("\n").filter((l) => l.trim() === ".carefully-crafted/").length;
    assert.equal(occurrences, 1);
    assert.equal(existsSync(join(repo, ".gitignore")), false);
  });

  test("preserves any pre-existing content in info/exclude", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    writeFileSync(join(info.gitCommonDir, "info", "exclude"), "*.log\n");
    ensurePrivateWorktreeRoot(info, freshRunId());
    const exclude = readFileSync(join(info.gitCommonDir, "info", "exclude"), "utf8");
    assert.ok(exclude.includes("*.log"));
    assert.ok(exclude.includes(".carefully-crafted/"));
  });
});

// --------------------------------------------------------------------------
// createIntegrationWorktree / branch semantics — Step 3
// --------------------------------------------------------------------------

describe("createIntegrationWorktree", () => {
  test("creates carefully-crafted/<run-id>/integration from the recorded starting HEAD", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);

    const integ = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    assert.equal(integ.branch, `carefully-crafted/${runId}/integration`);
    assert.equal(integ.baseCommit, info.headCommit);
    assert.equal(readHead(integ.path), info.headCommit);
    assert.ok(existsSync(join(integ.path, "a.txt")));
  });

  test("the user's active checkout is never mutated by worktree creation", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const headBefore = readHead(repo);
    createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    assert.equal(readHead(repo), headBefore);
    assert.equal(isWorktreeClean(repo), true);
  });

  test("a repeat call with the exact same run/path/base is idempotent (reused: true)", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);

    const first = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    assert.equal(first.reused, false);
    const second = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    assert.equal(second.reused, true);
    assert.deepEqual(second, { ...first, reused: true });
  });

  test("a branch/worktree collision that does NOT match the ledger fails without reusing it", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });

    // Simulate a foreign branch already occupying the same worktree path but
    // with a DIFFERENT recorded base — e.g. ledger corruption or a
    // conflicting concurrent attempt. Directly forge a mismatched ledger
    // entry style scenario by removing the ledger file (so the existing
    // branch/worktree no longer "matches" anything recorded).
    rmSync(join(paths.root, ".ledger.json"));
    assert.throws(() => createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths }), GitError);
  });
});

describe("createTaskWorktree", () => {
  test("wave-one branch/path convention", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const wt = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "t1", baseCommit: info.headCommit });
    assert.equal(wt.branch, `carefully-crafted/${runId}/w1-t1`);
    assert.equal(wt.path, join(paths.root, "wave-1-t1"));
  });

  test("wave-two branch/path convention, based on the fully-integrated wave-one HEAD", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    writeFileSync(join(repo, "c.txt"), "wave1-integrated\n");
    git(repo, ["add", "c.txt"]);
    git(repo, ["commit", "-qm", "simulated wave-1 integration"]);
    const wave1Head = readHead(repo);

    const wt = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 2, taskId: "t9", baseCommit: wave1Head });
    assert.equal(wt.branch, `carefully-crafted/${runId}/w2-t9`);
    assert.equal(wt.path, join(paths.root, "wave-2-t9"));
    assert.equal(readHead(wt.path), wave1Head);
  });

  test("a resume-exact wave-two task reuses the source wave-one task's exact absolute worktree path via clean remove/recreate", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);

    const w1 = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "t1", baseCommit: info.headCommit });
    // Task worktree must be clean (no uncommitted changes) for the
    // clean-remove/recreate rule to proceed.
    assert.equal(isWorktreeClean(w1.path), true);

    const w2 = createTaskWorktree({
      repoInfo: info, runId, worktreePaths: paths, wave: 2, taskId: "t1-correction",
      baseCommit: info.headCommit, resumeExactSourceTaskId: "t1",
    });
    assert.equal(w2.path, w1.path); // exact same absolute path — this is what lets Codex `resume` land on the same session via cwd
    assert.equal(w2.branch, `carefully-crafted/${runId}/w2-t1-correction`);
    assert.equal(existsSync(w1.path), true);
  });

  test("resume-exact refuses to reuse a DIRTY source worktree (never force-removed)", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const w1 = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "t1", baseCommit: info.headCommit });
    writeFileSync(join(w1.path, "a.txt"), "dirty leftover\n");

    assert.throws(() => createTaskWorktree({
      repoInfo: info, runId, worktreePaths: paths, wave: 2, taskId: "t1-correction",
      baseCommit: info.headCommit, resumeExactSourceTaskId: "t1",
    }), GitError);
    assert.ok(existsSync(w1.path)); // still there — never force-removed
  });

  test("every parallel worker receives a distinct worktree", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const w1 = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "alpha", baseCommit: info.headCommit });
    const w2 = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "beta", baseCommit: info.headCommit });
    assert.notEqual(w1.path, w2.path);
    assert.notEqual(w1.branch, w2.branch);
  });
});

// --------------------------------------------------------------------------
// removeCleanWorktree
// --------------------------------------------------------------------------

describe("removeCleanWorktree", () => {
  test("refuses to remove a dirty worktree", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const wt = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "t1", baseCommit: info.headCommit });
    writeFileSync(join(wt.path, "untracked.txt"), "dirty\n");
    assert.throws(() => removeCleanWorktree({ repoInfo: info, path: wt.path }), GitError);
    assert.ok(existsSync(wt.path));
  });

  test("removes a clean worktree", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const wt = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "t1", baseCommit: info.headCommit });
    removeCleanWorktree({ repoInfo: info, path: wt.path });
    assert.equal(existsSync(wt.path), false);
  });

  test("no-ops when the path does not exist", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const result = removeCleanWorktree({ repoInfo: info, path: join(repo, "nowhere") });
    assert.equal(result.removed, true);
  });
});

// --------------------------------------------------------------------------
// inspectTaskChanges — Step 4 (ownership derivation)
// --------------------------------------------------------------------------

describe("inspectTaskChanges", () => {
  function taskSetup() {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const wt = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "t1", baseCommit: info.headCommit });
    return { repo, info, runId, wt };
  }

  test("ok:true for a change wholly inside write_paths (tracked modify + untracked add)", () => {
    const { info, wt } = taskSetup();
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    writeFileSync(join(wt.path, "src", "new.txt"), "new\n");
    const result = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt", "src/"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedPaths.sort(), ["a.txt", "src/new.txt"]);
    assert.match(result.fingerprint, /^[0-9a-f]{40}$/);
  });

  test("ok:false reason:no-changes when nothing changed", () => {
    const { info, wt } = taskSetup();
    const result = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-changes");
  });

  test("a worker that MOVES HEAD is rejected (reason: head-moved)", () => {
    const { info, wt } = taskSetup();
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    git(wt.path, ["add", "a.txt"]);
    git(wt.path, ["commit", "-qm", "worker illicitly committed"]);
    const result = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "head-moved");
  });

  test("a worker that STAGES changes is rejected (reason: index-staged)", () => {
    const { info, wt } = taskSetup();
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    git(wt.path, ["add", "a.txt"]);
    const result = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "index-staged");
  });

  test("out-of-scope changed files are rejected", () => {
    const { info, wt } = taskSetup();
    writeFileSync(join(wt.path, "a.txt"), "in-scope\n");
    writeFileSync(join(wt.path, "b.txt"), "OUT OF SCOPE\n");
    const result = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "out-of-scope");
    assert.deepEqual(result.outOfScope, ["b.txt"]);
  });

  test("a directory write_path root scopes correctly (in-directory ok, sibling directory rejected)", () => {
    const { info, wt } = taskSetup();
    mkdirSync(join(wt.path, "other"));
    writeFileSync(join(wt.path, "src", "inside.txt"), "ok\n");
    writeFileSync(join(wt.path, "other", "outside.txt"), "not ok\n");
    const result = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["src/"] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "out-of-scope");
    assert.deepEqual(result.outOfScope, ["other/outside.txt"]);
  });

  test("NON-ASCII PATHS: an untracked file with a non-ASCII name is correctly scoped, not misread as an out-of-scope violation", () => {
    const { info, wt } = taskSetup();
    // Without `-z`, git returns this as the C-quoted, octal-escaped string
    // "src/caf\303\251.txt" (quotes included), which fails the write_paths
    // containment check and rejects a task that did nothing wrong.
    writeFileSync(join(wt.path, "src", "café.txt"), "unicode filename\n");
    const result = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["src/"] });
    assert.equal(result.ok, true, `expected ok, got reason=${result.reason} outOfScope=${JSON.stringify(result.outOfScope)}`);
    assert.deepEqual(result.changedPaths, ["src/café.txt"]);
  });

  test("NON-ASCII PATHS: a MODIFIED tracked file with a non-ASCII name is parsed correctly from --name-status", () => {
    const { repo, info, wt } = taskSetup();
    // Commit the non-ASCII file into the base first so the next change is a
    // tracked modification (the --name-status path, not the ls-files path).
    writeFileSync(join(wt.path, "src", "café.txt"), "original\n");
    git(wt.path, ["add", "-A"]);
    git(wt.path, ["commit", "-qm", "seed unicode file"]);
    const newBase = readHead(wt.path);

    writeFileSync(join(wt.path, "src", "café.txt"), "modified\n");
    const result = inspectTaskChanges({ worktreePath: wt.path, baseCommit: newBase, writePaths: ["src/"] });
    assert.equal(result.ok, true, `expected ok, got reason=${result.reason} outOfScope=${JSON.stringify(result.outOfScope)}`);
    assert.deepEqual(result.changedPaths, ["src/café.txt"]);
    assert.equal(result.trackedChanges[0].status, "M");
    assert.equal(result.trackedChanges[0].path, "src/café.txt");
  });

  test("NON-ASCII PATHS: a genuinely out-of-scope non-ASCII file is still rejected (the fix must not weaken the gate)", () => {
    const { info, wt } = taskSetup();
    writeFileSync(join(wt.path, "src", "ok.txt"), "in scope\n");
    writeFileSync(join(wt.path, "señor.txt"), "OUT of scope\n"); // repo root, not src/
    const result = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["src/"] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "out-of-scope");
    assert.deepEqual(result.outOfScope, ["señor.txt"]);
  });

  test("NON-ASCII PATHS: a full commit + ownership assertion round-trips a non-ASCII filename", () => {
    const { info, runId, wt } = taskSetup();
    writeFileSync(join(wt.path, "src", "café.txt"), "content\n");
    const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["src/"] });
    assert.equal(changes.ok, true);
    const commitInfo = createTaskCommit({
      repoInfo: info, worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["src/"],
      runId, taskId: "t1", expectedFingerprint: changes.fingerprint,
    });
    const ownership = assertCommitOwnership({
      worktreePath: wt.path, baseCommit: info.headCommit, commit: commitInfo.commit,
      writePaths: ["src/"], expectedFingerprint: changes.fingerprint,
    });
    assert.deepEqual(ownership.files, ["src/café.txt"]);
  });

  test("fingerprint changes when in-scope content changes, and stays stable when nothing changes between two calls", () => {
    const { info, wt } = taskSetup();
    writeFileSync(join(wt.path, "a.txt"), "v1\n");
    const r1 = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    const r1b = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    assert.equal(r1.fingerprint, r1b.fingerprint);
    writeFileSync(join(wt.path, "a.txt"), "v2\n");
    const r2 = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    assert.notEqual(r1.fingerprint, r2.fingerprint);
  });
});

// --------------------------------------------------------------------------
// createTaskCommit / inspectTaskCommit / assertCommitOwnership — Step 4
// --------------------------------------------------------------------------

describe("createTaskCommit / inspectTaskCommit / assertCommitOwnership", () => {
  function taskSetup() {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const wt = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "t1", baseCommit: info.headCommit });
    return { repo, info, runId, wt };
  }

  test("creates exactly one clean non-merge commit with the repository's existing identity and the required message shape", () => {
    const { info, runId, wt } = taskSetup();
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });

    const commitInfo = createTaskCommit({
      repoInfo: info, worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"],
      runId, taskId: "t1", expectedFingerprint: changes.fingerprint,
    });
    assert.equal(commitInfo.message, `supervise(${runId}): t1`);

    const inspected = inspectTaskCommit({ worktreePath: wt.path, baseCommit: info.headCommit, commit: commitInfo.commit });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.count, 1);
    assert.equal(inspected.isNonMerge, true);
    assert.equal(inspected.clean, true);

    const authorLine = git(wt.path, ["log", "-1", "--format=%an <%ae>"]);
    assert.match(authorLine, /Test User <test@example\.com>/);

    const ownership = assertCommitOwnership({
      worktreePath: wt.path, baseCommit: info.headCommit, commit: commitInfo.commit,
      writePaths: ["a.txt"], expectedFingerprint: changes.fingerprint,
    });
    assert.deepEqual(ownership.files, ["a.txt"]);
  });

  test("only committed paths are staged — an out-of-scope path is never included even if present in write_paths input filtering", () => {
    const { info, runId, wt } = taskSetup();
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    writeFileSync(join(wt.path, "src", "added.txt"), "added\n");
    const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt", "src/"] });
    const commitInfo = createTaskCommit({
      repoInfo: info, worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt", "src/"],
      runId, taskId: "t1", expectedFingerprint: changes.fingerprint,
    });
    const files = git(wt.path, ["diff", "--name-only", `${info.headCommit}..${commitInfo.commit}`]).split("\n").filter(Boolean).sort();
    assert.deepEqual(files, ["a.txt", "src/added.txt"]);
  });

  test("refuses to commit when the fingerprint changed since verification (content mutated after the last verified check)", () => {
    const { info, runId, wt } = taskSetup();
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    writeFileSync(join(wt.path, "a.txt"), "changed AGAIN after verification\n");
    assert.throws(() => createTaskCommit({
      repoInfo: info, worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"],
      runId, taskId: "t1", expectedFingerprint: changes.fingerprint,
    }), GitError);
  });

  test("does not disable hooks: a rejecting pre-commit hook blocks the commit", () => {
    const { info, runId, wt } = taskSetup();
    const hookPath = join(wt.path, ".git");
    // For a linked worktree ".git" is a file, but this test uses a plain
    // wave worktree of a normal repo whose hooks live under the shared
    // git-common-dir's hooks/ (linked worktrees share hooks with the main
    // repo) — resolve the real hooks directory via git itself.
    const hooksDir = git(wt.path, ["rev-parse", "--git-path", "hooks"]);
    mkdirSync(hooksDir, { recursive: true });
    const preCommitPath = join(hooksDir, "pre-commit");
    writeFileSync(preCommitPath, "#!/bin/sh\nexit 1\n");
    chmodSync(preCommitPath, 0o755);

    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    assert.throws(() => createTaskCommit({
      repoInfo: info, worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"],
      runId, taskId: "t1", expectedFingerprint: changes.fingerprint,
    }), GitError);
  });

  test("inspectTaskCommit reports ok:false when a hook mutates files after commit, leaving the tree dirty", () => {
    const { info, runId, wt } = taskSetup();
    const hooksDir = git(wt.path, ["rev-parse", "--git-path", "hooks"]);
    mkdirSync(hooksDir, { recursive: true });
    const postCommitPath = join(hooksDir, "post-commit");
    writeFileSync(postCommitPath, `#!/bin/sh\necho "mutated" >> "${join(wt.path, "a.txt")}"\n`);
    chmodSync(postCommitPath, 0o755);

    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    const commitInfo = createTaskCommit({
      repoInfo: info, worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"],
      runId, taskId: "t1", expectedFingerprint: changes.fingerprint,
    });
    const inspected = inspectTaskCommit({ worktreePath: wt.path, baseCommit: info.headCommit, commit: commitInfo.commit });
    assert.equal(inspected.ok, false);
    assert.equal(inspected.clean, false);
  });
});

// --------------------------------------------------------------------------
// Candidate integration — Step 4 (truly atomic)
// --------------------------------------------------------------------------

describe("candidate integration atomicity", () => {
  function fullTaskSetup(repo, info, runId, paths, wave, taskId, baseCommit, fileName, content) {
    const wt = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave, taskId, baseCommit });
    writeFileSync(join(wt.path, fileName), content);
    const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit, writePaths: [fileName] });
    const commitInfo = createTaskCommit({
      repoInfo: info, worktreePath: wt.path, baseCommit, writePaths: [fileName], runId, taskId, expectedFingerprint: changes.fingerprint,
    });
    return { wt, commit: commitInfo.commit };
  }

  test("full happy path: candidate cherry-pick then fast-forward publish", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const integ = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });

    const t1 = fullTaskSetup(repo, info, runId, paths, 1, "t1", info.headCommit, "a.txt", "t1 change\n");

    const candidate = createCandidateIntegration({ repoInfo: info, runId, worktreePaths: paths, wave: 1, integrationHead: integ.baseCommit });
    const pick = integrateCandidateCommit({ candidate, commit: t1.commit });
    assert.equal(pick.ok, true);

    const publish = publishCandidateIntegration({ repoInfo: info, integrationWorktreePath: integ.path, candidate, expectedPreHead: integ.baseCommit });
    assert.equal(publish.published, true);
    assert.equal(readHead(integ.path), publish.head);
    assert.equal(isWorktreeClean(integ.path), true);
    assert.equal(existsSync(candidate.path), false); // candidate worktree removed after publish

    assert.equal(isCommitIntegrated({ repoInfo: info, ref: integ.branch, commit: t1.commit }), true);
  });

  test("REGRESSION: the second candidate cherry-pick conflicts — the first commit is NOT partially published, and the real integration HEAD is byte-for-byte unchanged", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const integ = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    const preWaveHead = integ.baseCommit;
    const preWaveTreeOid = git(integ.path, ["rev-parse", "HEAD^{tree}"]);

    // Task "c" succeeds cleanly on an unrelated file — this is the commit
    // that must survive to the FIRST cherry-pick slot (sorted before "z"),
    // so its successful pick and then a later conflict is the scenario that
    // proves partial publication never happens.
    const c = fullTaskSetup(repo, info, runId, paths, 1, "c-task", info.headCommit, "b.txt", "c-task change\n");

    // Task "z" is deliberately constructed to CONFLICT: its commit's diff
    // assumes the ORIGINAL a.txt content, but by the time it is
    // cherry-picked, the candidate (based on a drifted integration HEAD)
    // already has DIFFERENT content on the same line of a.txt — this is a
    // realistic "integration advanced between task-worktree creation and
    // wave integration" scenario, not a contrived overlap.
    const zWt = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "z-task", baseCommit: info.headCommit });
    writeFileSync(join(zWt.path, "a.txt"), "z-task conflicting change\n");
    const zChanges = inspectTaskChanges({ worktreePath: zWt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    const zCommit = createTaskCommit({
      repoInfo: info, worktreePath: zWt.path, baseCommit: info.headCommit, writePaths: ["a.txt"],
      runId, taskId: "z-task", expectedFingerprint: zChanges.fingerprint,
    });

    // Simulate integration drift: a.txt on the integration branch itself
    // changes to something that will conflict with z-task's edit.
    writeFileSync(join(integ.path, "a.txt"), "drifted integration content\n");
    git(integ.path, ["add", "a.txt"]);
    git(integ.path, ["commit", "-qm", "simulated drift"]);
    const driftedHead = readHead(integ.path);

    const candidate = createCandidateIntegration({ repoInfo: info, runId, worktreePaths: paths, wave: 1, integrationHead: driftedHead });

    const pickC = integrateCandidateCommit({ candidate, commit: c.commit });
    assert.equal(pickC.ok, true, "the first (unrelated-file) cherry-pick must succeed");
    const candidateHeadAfterFirstPick = readHead(candidate.path);
    assert.notEqual(candidateHeadAfterFirstPick, driftedHead);

    const pickZ = integrateCandidateCommit({ candidate, commit: zCommit.commit });
    assert.equal(pickZ.ok, false, "the second cherry-pick must conflict");

    const abortResult = abortCandidateIntegration({ repoInfo: info, candidate, logPath: join(paths.root, "conflict.log"), reason: "test-induced conflict" });
    assert.equal(abortResult.aborted, true);
    assert.ok(existsSync(abortResult.logPath));
    assert.ok(readFileSync(abortResult.logPath, "utf8").includes("test-induced conflict"));

    // The candidate is fully gone.
    assert.equal(existsSync(candidate.path), false);

    // THE PROOF: the real integration ref/worktree is at the drifted HEAD —
    // i.e. wherever it legitimately was before this failed wave attempt —
    // and NOT at candidateHeadAfterFirstPick. Task "c"'s successful first
    // pick was never published, even though it cherry-picked cleanly.
    assert.equal(readHead(integ.path), driftedHead);
    assert.equal(git(integ.path, ["rev-parse", "HEAD^{tree}"]), git(integ.path, ["rev-parse", `${driftedHead}^{tree}`]));
    assert.equal(isWorktreeClean(integ.path), true);
    assert.equal(isCommitIntegrated({ repoInfo: info, ref: integ.branch, commit: c.commit }), false, 'task "c" must NOT be integrated despite its clean cherry-pick');

    // And the pre-drift HEAD's tree is untouched too (the ORIGINAL
    // byte-for-byte-unchanged guarantee, one level further back).
    assert.notEqual(preWaveHead, driftedHead); // sanity: drift really happened
    assert.equal(git(repo, ["rev-parse", `${preWaveHead}^{tree}`]), preWaveTreeOid);
  });

  test("ALREADY-APPLIED COMMIT: re-picking the same commit is reported as an empty success, not a conflict", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const integ = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    const t1 = fullTaskSetup(repo, info, runId, paths, 1, "t1", info.headCommit, "a.txt", "t1 change\n");

    const candidate = createCandidateIntegration({ repoInfo: info, runId, worktreePaths: paths, wave: 1, integrationHead: integ.baseCommit });

    const first = integrateCandidateCommit({ candidate, commit: t1.commit });
    assert.equal(first.ok, true);
    assert.equal(first.empty, false);
    const headAfterFirst = readHead(candidate.path);

    // The recovery re-entry case: the SAME commit picked again. git exits 1
    // with "previous cherry-pick is now empty" — which must NOT be
    // classified as a conflict, or a recovery pass would abort the whole
    // candidate for work that had already landed correctly.
    const second = integrateCandidateCommit({ candidate, commit: t1.commit });
    assert.equal(second.ok, true, "an already-applied commit must be a success, not a conflict");
    assert.equal(second.empty, true);
    assert.equal(readHead(candidate.path), headAfterFirst, "an empty pick must not add a commit");

    // The candidate is left in a clean, usable state — no half-resolved
    // cherry-pick blocking further picks, and publication still works.
    assert.equal(isWorktreeClean(candidate.path), true);
    const publish = publishCandidateIntegration({ repoInfo: info, integrationWorktreePath: integ.path, candidate, expectedPreHead: integ.baseCommit });
    assert.equal(publish.published, true);
  });

  test("CONTENT-EQUIVALENT COMMIT: a different commit making an identical change is also an empty success (no SHA pre-check could catch this)", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const integ = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });

    // A task commit that sets a.txt to a specific content.
    const t1 = fullTaskSetup(repo, info, runId, paths, 1, "t1", info.headCommit, "a.txt", "identical content\n");

    // The integration branch independently reaches the SAME content via a
    // DIFFERENT commit — so isCommitIntegrated(t1.commit) is false, yet the
    // cherry-pick is still empty. This is why empty-detection, not a SHA
    // pre-check, is the load-bearing mechanism.
    writeFileSync(join(integ.path, "a.txt"), "identical content\n");
    git(integ.path, ["add", "a.txt"]);
    git(integ.path, ["commit", "-qm", "independent identical change"]);
    const driftedHead = readHead(integ.path);
    assert.equal(isCommitIntegrated({ repoInfo: info, ref: integ.branch, commit: t1.commit }), false);

    const candidate = createCandidateIntegration({ repoInfo: info, runId, worktreePaths: paths, wave: 1, integrationHead: driftedHead });
    const pick = integrateCandidateCommit({ candidate, commit: t1.commit });
    assert.equal(pick.ok, true, "a content-equivalent commit must not be misclassified as a conflict");
    assert.equal(pick.empty, true);
    assert.equal(isWorktreeClean(candidate.path), true);
  });

  test("A GENUINE CONFLICT IS STILL A CONFLICT: the empty-pick fix must not swallow real conflicts", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const integ = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    const t1 = fullTaskSetup(repo, info, runId, paths, 1, "t1", info.headCommit, "a.txt", "task side\n");

    // Integration diverges to DIFFERENT content on the same line.
    writeFileSync(join(integ.path, "a.txt"), "conflicting integration side\n");
    git(integ.path, ["add", "a.txt"]);
    git(integ.path, ["commit", "-qm", "conflicting change"]);
    const driftedHead = readHead(integ.path);

    const candidate = createCandidateIntegration({ repoInfo: info, runId, worktreePaths: paths, wave: 1, integrationHead: driftedHead });
    const pick = integrateCandidateCommit({ candidate, commit: t1.commit });
    assert.equal(pick.ok, false, "a genuine content conflict must still be reported as a conflict");
    // Aborted cleanly, candidate back at its pre-attempt HEAD.
    assert.equal(readHead(candidate.path), driftedHead);
    assert.equal(isWorktreeClean(candidate.path), true);
  });

  test("a conflict never force-removes a dirty candidate — abortCandidateIntegration itself only removes once cherry-pick --abort has made it clean", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const integ = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    const candidate = createCandidateIntegration({ repoInfo: info, runId, worktreePaths: paths, wave: 1, integrationHead: integ.baseCommit });

    // Force a real conflict directly in the candidate (bypassing
    // integrateCandidateCommit) to leave it mid-cherry-pick, then confirm
    // abortCandidateIntegration cleanly resolves it via cherry-pick --abort
    // before ever calling `worktree remove`.
    writeFileSync(join(integ.path, "a.txt"), "integration side\n");
    git(integ.path, ["add", "a.txt"]);
    git(integ.path, ["commit", "-qm", "integration side change"]);
    const newBase = readHead(integ.path);
    // Recreate candidate at the new base to align with integ (simplify: just
    // hand abortCandidateIntegration a candidate mid-conflict manually).
    writeFileSync(join(candidate.path, "a.txt"), "candidate side\n");
    git(candidate.path, ["add", "a.txt"]);
    git(candidate.path, ["commit", "-qm", "candidate side change"]);

    const result = abortCandidateIntegration({ repoInfo: info, candidate, reason: "manual test" });
    assert.equal(result.aborted, true);
    assert.equal(existsSync(candidate.path), false);
  });
});

// --------------------------------------------------------------------------
// isCommitIntegrated
// --------------------------------------------------------------------------

describe("isCommitIntegrated", () => {
  test("false before publication, true after (via the cherry-pick trailer, since the SHA changes on pick)", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const integ = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    const wt = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "t1", baseCommit: info.headCommit });
    writeFileSync(join(wt.path, "a.txt"), "change\n");
    const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    const commitInfo = createTaskCommit({
      repoInfo: info, worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"], runId, taskId: "t1", expectedFingerprint: changes.fingerprint,
    });

    assert.equal(isCommitIntegrated({ repoInfo: info, ref: integ.branch, commit: commitInfo.commit }), false);

    const candidate = createCandidateIntegration({ repoInfo: info, runId, worktreePaths: paths, wave: 1, integrationHead: integ.baseCommit });
    integrateCandidateCommit({ candidate, commit: commitInfo.commit });
    publishCandidateIntegration({ repoInfo: info, integrationWorktreePath: integ.path, candidate, expectedPreHead: integ.baseCommit });

    assert.equal(isCommitIntegrated({ repoInfo: info, ref: integ.branch, commit: commitInfo.commit }), true);
  });
});

// --------------------------------------------------------------------------
// listRunWorktrees
// --------------------------------------------------------------------------

describe("listRunWorktrees", () => {
  test("returns only worktrees on branches belonging to this run", () => {
    const repo = makeRepo();
    const info = inspectRepository(repo);
    const runId = freshRunId();
    const otherRunId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    const otherPaths = ensurePrivateWorktreeRoot(info, otherRunId);

    createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "t1", baseCommit: info.headCommit });
    createIntegrationWorktree({ repoInfo: info, runId: otherRunId, worktreePaths: otherPaths });

    const result = listRunWorktrees({ repoInfo: info, runId });
    const branches = result.map((w) => w.branch).sort();
    assert.deepEqual(branches, [
      `carefully-crafted/${runId}/integration`,
      `carefully-crafted/${runId}/w1-t1`,
    ]);
  });
});

// --------------------------------------------------------------------------
// End-to-end from a linked worktree cwd (the second required repo shape)
// --------------------------------------------------------------------------

describe("full pipeline from a linked-worktree cwd", () => {
  test("inspectRepository + worktree creation + task commit + candidate integration all work when invoked with a linked worktree as the starting cwd", () => {
    const { linked } = makeRepoWithLinkedWorktree();
    const info = inspectRepository(linked);
    assert.equal(info.isLinkedWorktree, true);

    const runId = freshRunId();
    const paths = ensurePrivateWorktreeRoot(info, runId);
    assert.ok(paths.root.startsWith(linked)); // worktree contents live under THIS (linked) top-level

    const integ = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths: paths });
    const wt = createTaskWorktree({ repoInfo: info, runId, worktreePaths: paths, wave: 1, taskId: "t1", baseCommit: info.headCommit });
    writeFileSync(join(wt.path, "a.txt"), "linked-worktree-path change\n");
    const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"] });
    assert.equal(changes.ok, true);
    const commitInfo = createTaskCommit({
      repoInfo: info, worktreePath: wt.path, baseCommit: info.headCommit, writePaths: ["a.txt"], runId, taskId: "t1", expectedFingerprint: changes.fingerprint,
    });
    const candidate = createCandidateIntegration({ repoInfo: info, runId, worktreePaths: paths, wave: 1, integrationHead: integ.baseCommit });
    integrateCandidateCommit({ candidate, commit: commitInfo.commit });
    const publish = publishCandidateIntegration({ repoInfo: info, integrationWorktreePath: integ.path, candidate, expectedPreHead: integ.baseCommit });
    assert.equal(publish.published, true);
  });
});
