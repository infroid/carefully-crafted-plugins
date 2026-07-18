// contracts.mjs — validation of every artifact that crosses a trust boundary
// in /contexthub:supervise.
//
// The core safety property: the host is authoritative, the model is not.
// Codex workers and Claude's own review passes report *claims*; the host
// derives *facts* from git and Codex event data (Task 9). Everything in this
// file is the gate a model's self-report must pass before the host will ever
// treat it as true.
//
// Node 20+ standard library ONLY — no JSON Schema package. The JSON schemas
// under plugins/contexthub/schemas/ constrain what a Codex model may emit via
// `--output-schema`; the validators here enforce both shape (again, since a
// model can still emit non-conforming JSON) and repository semantics no
// schema language can express (uniqueness, coverage, cycles, path overlap,
// cross-artifact consistency). These are two different layers on purpose —
// see the task brief.
//
// Every numeric limit and regex below is either lifted verbatim from the task
// brief or, where the brief left a limit unstated, chosen conservatively and
// called out in a comment as a judgment call.

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

// --------------------------------------------------------------------------
// Shared primitives
// --------------------------------------------------------------------------

const byteLen = (s) => Buffer.byteLength(s, "utf8");

function describe(v) {
  if (typeof v === "string") {
    return JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v);
  }
  if (v === undefined) return "undefined";
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return String(v);
  }
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertPlainObject(v, context) {
  if (!isPlainObject(v)) {
    throw new ContractError(`${context} must be a JSON object, got ${describe(v)}`);
  }
}

function assertNoUnknownFields(obj, allowedFields, context) {
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ContractError(`${context} has unknown field "${key}" (allowed: ${allowedFields.join(", ")})`);
    }
  }
}

function assertRequiredFields(obj, requiredFields, context) {
  for (const key of requiredFields) {
    if (!(key in obj)) {
      throw new ContractError(`${context} is missing required field "${key}"`);
    }
  }
}

// Convenience: unknown+required in one call against the exact same field list
// (every schema in this module is a closed, fully-required object).
function assertExactShape(obj, fields, context) {
  assertPlainObject(obj, context);
  assertNoUnknownFields(obj, fields, context);
  assertRequiredFields(obj, fields, context);
}

function assertBoundedString(v, { min = 1, max, context }) {
  if (typeof v !== "string") {
    throw new ContractError(`${context} must be a string, got ${describe(v)}`);
  }
  if (CONTROL_CHAR_RE.test(v)) {
    throw new ContractError(`${context} contains control characters`);
  }
  if (v.length < min || v.length > max) {
    throw new ContractError(`${context} must be ${min}-${max} characters, got ${v.length}`);
  }
  return v;
}

function assertInteger(v, { min, max, context }) {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new ContractError(`${context} must be an integer in [${min}, ${max}], got ${describe(v)}`);
  }
  return v;
}

function assertNumber(v, { min, max, context }) {
  if (typeof v !== "number" || Number.isNaN(v) || v < min || v > max) {
    throw new ContractError(`${context} must be a number in [${min}, ${max}], got ${describe(v)}`);
  }
  return v;
}

function assertArray(v, { max, context }) {
  if (!Array.isArray(v)) {
    throw new ContractError(`${context} must be an array, got ${describe(v)}`);
  }
  if (v.length > max) {
    throw new ContractError(`${context} has ${v.length} entries, max ${max}`);
  }
  return v;
}

function assertUniqueIds(items, keyFn, context) {
  const seen = new Set();
  for (const item of items) {
    const id = keyFn(item);
    if (seen.has(id)) {
      throw new ContractError(`${context} contains duplicate id "${id}"`);
    }
    seen.add(id);
  }
}

function assertSerializedByteCap(value, maxBytes, context) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new ContractError(`${context} could not be serialized: ${err.message}`);
  }
  const bytes = byteLen(text ?? "");
  if (bytes > maxBytes) {
    throw new ContractError(`${context} is ${bytes} UTF-8 bytes serialized, max ${maxBytes}`);
  }
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function assertIsoTimestamp(v, context) {
  if (typeof v !== "string" || !ISO_TIMESTAMP_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ContractError(`${context} must be an ISO 8601 UTC timestamp ("...Z"), got ${describe(v)}`);
  }
  return v;
}

// --------------------------------------------------------------------------
// Identifier patterns (verbatim from the brief)
// --------------------------------------------------------------------------

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

const IDENTIFIER_PATTERNS = {
  run: /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/,
  task: /^[a-z][a-z0-9-]{0,31}$/,
  acceptance: /^AC-[0-9]{2,3}$/,
  approval: /^approval-[0-9]{2,3}$/,
  // Verification IDs are task-local and share the task-id character class
  // (brief: "Each verification entry has a unique task-local ID matching
  // ^[a-z][a-z0-9-]{0,31}$").
  verification: /^[a-z][a-z0-9-]{0,31}$/,
};

export function validateIdentifier(kind, value) {
  const pattern = IDENTIFIER_PATTERNS[kind];
  if (!pattern) {
    throw new ContractError(`validateIdentifier: unknown identifier kind "${kind}" (expected one of ${Object.keys(IDENTIFIER_PATTERNS).join(", ")})`);
  }
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ContractError(`${kind} identifier must match ${pattern}, got ${describe(value)}`);
  }
  return value;
}

const OBJECT_FORMAT_PATTERNS = {
  sha1: /^[0-9a-f]{40}$/,
  sha256: /^[0-9a-f]{64}$/,
};

// Not exported: commit-ID validation always needs the caller to state the
// repository's detected object format (Task 9's inspectRepository), so it is
// threaded through validateTaskGraph/validateCorrectionGraph's `options`
// rather than through the kind-only validateIdentifier(kind, value) shape.
function assertCommitId(value, objectFormat, context) {
  const pattern = OBJECT_FORMAT_PATTERNS[objectFormat];
  if (!pattern) {
    throw new ContractError(`${context}: options.objectFormat must be "sha1" or "sha256" (got ${describe(objectFormat)})`);
  }
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ContractError(`${context} must be a full lowercase ${objectFormat} object ID (${objectFormat === "sha1" ? 40 : 64} hex characters), got ${describe(value)}. Abbreviated revisions are never accepted in a ledger contract.`);
  }
  return value;
}

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

// Reject anything that could smuggle a shell string or a glob past a "path".
// v6 does not support glob expansion at all (brief), so glob metacharacters
// are simply illegal in a path.
const PATH_SHELL_META_RE = /[;&|$<>`"'*?[\]{}()!#\\]/;

export function normalizeRepoPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractError(`path must be a non-empty string, got ${describe(value)}`);
  }
  if (value.length > 1024) {
    throw new ContractError(`path exceeds 1024 characters: ${describe(value)}`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new ContractError(`path contains control characters: ${describe(value)}`);
  }
  if (PATH_SHELL_META_RE.test(value)) {
    throw new ContractError(`path contains shell/glob metacharacters: ${describe(value)}`);
  }
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new ContractError(`path must be repository-relative, not absolute: ${describe(value)}`);
  }

  if (value === ".") return ".";

  const isDir = value.endsWith("/");
  const segments = [];
  for (const seg of value.split("/")) {
    if (seg === "" || seg === ".") continue; // collapse //, trailing /, and ./
    if (seg === "..") {
      throw new ContractError(`path must not contain ".." segments: ${describe(value)}`);
    }
    if (seg === ".git") {
      throw new ContractError(`path must not reference ".git": ${describe(value)}`);
    }
    segments.push(seg);
  }
  if (segments.length === 0) {
    throw new ContractError(`path must not be empty after normalization: ${describe(value)}`);
  }
  return segments.join("/") + (isDir ? "/" : "");
}

// Two paths conflict when they are equal, or when either is (or is a prefix
// directory of) the other — exact file/directory roots only, no glob
// expansion (brief, Step 4).
export function pathsOverlap(a, b) {
  const na = normalizeRepoPath(a);
  const nb = normalizeRepoPath(b);
  const da = na === "." ? "." : na.endsWith("/") ? na.slice(0, -1) : na;
  const db = nb === "." ? "." : nb.endsWith("/") ? nb.slice(0, -1) : nb;
  if (da === "." || db === ".") return true; // the repo root overlaps everything
  if (da === db) return true;
  if (db.startsWith(`${da}/`)) return true;
  if (da.startsWith(`${db}/`)) return true;
  return false;
}

// --------------------------------------------------------------------------
// validateComplexity — Step 1
// --------------------------------------------------------------------------

const COMPLEXITY_FIELDS = [
  "score", "confidence", "dimensions", "reasons", "risk_flags", "unknowns",
  "suggested_parallelism", "relevant_paths", "verification_hints",
];
const COMPLEXITY_DIMENSION_FIELDS = ["scope", "uncertainty", "coupling", "risk", "verification"];
const COMPLEXITY_MAX_BYTES = 4096;
const COMPLEXITY_STRING_MAX = 240;

export function validateComplexity(value) {
  assertPlainObject(value, "complexity grade");
  // Byte limits are validated on the serialized form before accepting any
  // artifact (brief, Step 4) — check this first, cheaply, before the deeper
  // per-field walk.
  assertSerializedByteCap(value, COMPLEXITY_MAX_BYTES, "complexity grade");
  assertNoUnknownFields(value, COMPLEXITY_FIELDS, "complexity grade");
  assertRequiredFields(value, COMPLEXITY_FIELDS, "complexity grade");

  assertInteger(value.score, { min: 1, max: 5, context: "complexity.score" });
  assertNumber(value.confidence, { min: 0, max: 1, context: "complexity.confidence" });

  assertExactShape(value.dimensions, COMPLEXITY_DIMENSION_FIELDS, "complexity.dimensions");
  for (const dim of COMPLEXITY_DIMENSION_FIELDS) {
    assertInteger(value.dimensions[dim], { min: 1, max: 5, context: `complexity.dimensions.${dim}` });
  }

  assertArray(value.reasons, { max: 5, context: "complexity.reasons" });
  value.reasons.forEach((s, i) => assertBoundedString(s, { max: COMPLEXITY_STRING_MAX, context: `complexity.reasons[${i}]` }));

  assertArray(value.risk_flags, { max: 8, context: "complexity.risk_flags" });
  value.risk_flags.forEach((s, i) => assertBoundedString(s, { max: COMPLEXITY_STRING_MAX, context: `complexity.risk_flags[${i}]` }));

  assertArray(value.unknowns, { max: 8, context: "complexity.unknowns" });
  value.unknowns.forEach((s, i) => assertBoundedString(s, { max: COMPLEXITY_STRING_MAX, context: `complexity.unknowns[${i}]` }));

  assertInteger(value.suggested_parallelism, { min: 1, max: 3, context: "complexity.suggested_parallelism" });

  assertArray(value.relevant_paths, { max: 12, context: "complexity.relevant_paths" });
  value.relevant_paths.forEach((p, i) => {
    assertBoundedString(p, { max: COMPLEXITY_STRING_MAX, context: `complexity.relevant_paths[${i}]` });
    normalizeRepoPath(p);
  });

  assertArray(value.verification_hints, { max: 8, context: "complexity.verification_hints" });
  value.verification_hints.forEach((s, i) => assertBoundedString(s, { max: COMPLEXITY_STRING_MAX, context: `complexity.verification_hints[${i}]` }));

  return value;
}

// --------------------------------------------------------------------------
// validateWorkerReport — Step 2
// --------------------------------------------------------------------------

const WORKER_REPORT_FIELDS = ["status", "summary", "acceptance", "verification", "concerns", "blockers"];
const WORKER_REPORT_STATUSES = new Set(["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"]);
const ACCEPTANCE_ITEM_FIELDS = ["id", "status", "evidence"];
const ACCEPTANCE_ITEM_STATUSES = new Set(["PASS", "FAIL", "UNCERTAIN"]);
const VERIFICATION_ITEM_FIELDS = ["id", "status", "summary"];
const VERIFICATION_ITEM_STATUSES = new Set(["PASS", "FAIL", "NOT_RUN"]);
const WORKER_REPORT_MAX_BYTES = 4096;

// This is the boundary that stops a model's self-report from becoming truth:
// shape and internal coherence are checked here, in full, before anything
// else (including git inspection, per the brief) is allowed to trust it.
export function validateWorkerReport(value, acceptanceIds) {
  assertPlainObject(value, "worker report");
  assertSerializedByteCap(value, WORKER_REPORT_MAX_BYTES, "worker report");
  assertNoUnknownFields(value, WORKER_REPORT_FIELDS, "worker report");
  assertRequiredFields(value, WORKER_REPORT_FIELDS, "worker report");

  if (!Array.isArray(acceptanceIds)) {
    throw new ContractError(`validateWorkerReport: acceptanceIds must be an array, got ${describe(acceptanceIds)}`);
  }
  acceptanceIds.forEach((id) => validateIdentifier("acceptance", id));

  if (typeof value.status !== "string" || !WORKER_REPORT_STATUSES.has(value.status)) {
    throw new ContractError(`worker report status must be one of ${[...WORKER_REPORT_STATUSES].join("|")}, got ${describe(value.status)}`);
  }
  assertBoundedString(value.summary, { max: 480, context: "worker report.summary" });

  assertArray(value.acceptance, { max: 40, context: "worker report.acceptance" });
  value.acceptance.forEach((item, i) => {
    assertExactShape(item, ACCEPTANCE_ITEM_FIELDS, `worker report.acceptance[${i}]`);
    validateIdentifier("acceptance", item.id);
    if (!ACCEPTANCE_ITEM_STATUSES.has(item.status)) {
      throw new ContractError(`worker report.acceptance[${i}].status must be one of ${[...ACCEPTANCE_ITEM_STATUSES].join("|")}, got ${describe(item.status)}`);
    }
    assertBoundedString(item.evidence, { max: 240, context: `worker report.acceptance[${i}].evidence` });
  });
  assertUniqueIds(value.acceptance, (a) => a.id, "worker report.acceptance");

  assertArray(value.verification, { max: 24, context: "worker report.verification" });
  value.verification.forEach((item, i) => {
    assertExactShape(item, VERIFICATION_ITEM_FIELDS, `worker report.verification[${i}]`);
    validateIdentifier("verification", item.id);
    if (!VERIFICATION_ITEM_STATUSES.has(item.status)) {
      throw new ContractError(`worker report.verification[${i}].status must be one of ${[...VERIFICATION_ITEM_STATUSES].join("|")}, got ${describe(item.status)}`);
    }
    assertBoundedString(item.summary, { max: 240, context: `worker report.verification[${i}].summary` });
  });
  assertUniqueIds(value.verification, (v) => v.id, "worker report.verification");

  assertArray(value.concerns, { max: 8, context: "worker report.concerns" });
  value.concerns.forEach((s, i) => assertBoundedString(s, { max: 240, context: `worker report.concerns[${i}]` }));

  assertArray(value.blockers, { max: 8, context: "worker report.blockers" });
  value.blockers.forEach((s, i) => assertBoundedString(s, { max: 240, context: `worker report.blockers[${i}]` }));

  // --- Semantic coherence, checked before any git inspection ever happens ---
  const expected = new Set(acceptanceIds);
  const reported = new Set(value.acceptance.map((a) => a.id));

  if (value.status === "DONE" || value.status === "DONE_WITH_CONCERNS") {
    if (expected.size !== reported.size || ![...expected].every((id) => reported.has(id))) {
      throw new ContractError(`worker report status "${value.status}" requires every assigned acceptance ID to appear exactly once (assigned: ${[...expected].join(",")}; reported: ${[...reported].join(",")})`);
    }
    for (const item of value.acceptance) {
      if (item.status !== "PASS") {
        throw new ContractError(`worker report status "${value.status}" requires every assigned acceptance ID to be PASS; "${item.id}" is ${item.status}`);
      }
    }
    for (const item of value.verification) {
      if (item.status !== "PASS") {
        throw new ContractError(`worker report status "${value.status}" requires every declared verification to be PASS; "${item.id}" is ${item.status}`);
      }
    }
    if (value.blockers.length !== 0) {
      throw new ContractError(`worker report status "${value.status}" must not carry blockers`);
    }
    if (value.status === "DONE" && value.concerns.length !== 0) {
      throw new ContractError(`worker report status "DONE" must not carry concerns — use "DONE_WITH_CONCERNS" instead`);
    }
    if (value.status === "DONE_WITH_CONCERNS" && value.concerns.length === 0) {
      throw new ContractError(`worker report status "DONE_WITH_CONCERNS" requires at least one concern (otherwise the status should be "DONE")`);
    }
  } else {
    // NEEDS_CONTEXT | BLOCKED — never integrable, always require a blocker.
    if (value.blockers.length === 0) {
      throw new ContractError(`worker report status "${value.status}" requires at least one blocker`);
    }
  }

  return value;
}

// --------------------------------------------------------------------------
// validateApprovalFlag
// --------------------------------------------------------------------------

const APPROVAL_FLAG_FIELDS = ["id", "category", "description", "status", "prompt", "evidence_paths", "created_at", "decided_at"];
const APPROVAL_CATEGORIES = new Set([
  "destructive", "dependency", "network", "credential", "data-migration",
  "security-api-decision", "scope-expansion", "external-action", "product-decision",
]);
const APPROVAL_STATUSES = new Set(["PENDING", "APPROVED", "REJECTED"]);

export function validateApprovalFlag(value) {
  assertExactShape(value, APPROVAL_FLAG_FIELDS, "approval flag");
  validateIdentifier("approval", value.id);

  if (typeof value.category !== "string" || !APPROVAL_CATEGORIES.has(value.category)) {
    throw new ContractError(`approval flag category must be one of ${[...APPROVAL_CATEGORIES].join("|")}, got ${describe(value.category)}`);
  }
  assertBoundedString(value.description, { max: 480, context: "approval flag.description" });
  assertBoundedString(value.prompt, { max: 480, context: "approval flag.prompt" });

  if (typeof value.status !== "string" || !APPROVAL_STATUSES.has(value.status)) {
    throw new ContractError(`approval flag status must be one of ${[...APPROVAL_STATUSES].join("|")}, got ${describe(value.status)}`);
  }

  assertArray(value.evidence_paths, { max: 8, context: "approval flag.evidence_paths" });
  value.evidence_paths.forEach((p) => normalizeRepoPath(p));

  assertIsoTimestamp(value.created_at, "approval flag.created_at");

  if (value.status === "PENDING") {
    if (value.decided_at !== null) {
      throw new ContractError(`approval flag status "PENDING" requires decided_at to be null, got ${describe(value.decided_at)}`);
    }
  } else {
    // APPROVED | REJECTED — a decision. Immutable evidence/timestamps means a
    // decision is never legal without both.
    assertIsoTimestamp(value.decided_at, "approval flag.decided_at");
    if (Date.parse(value.decided_at) < Date.parse(value.created_at)) {
      throw new ContractError(`approval flag.decided_at (${value.decided_at}) must not precede created_at (${value.created_at})`);
    }
    if (value.evidence_paths.length === 0) {
      throw new ContractError(`approval flag status "${value.status}" requires at least one evidence path`);
    }
  }

  return value;
}

// --------------------------------------------------------------------------
// validateVerificationCommand
// --------------------------------------------------------------------------

const VERIFICATION_COMMAND_FIELDS = ["id", "argv", "cwd", "requires_approval_ids"];

// Shell interpreters are banned as argv[0] outright: a verification command
// is a direct process invocation, never a string a shell re-interprets.
const SHELL_INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "pip", "pip3", "gem", "cargo", "brew"]);
const PACKAGE_MUTATION_VERBS = new Set(["install", "uninstall", "add", "remove", "publish", "ci", "update"]);
const GIT_UNSAFE_SUBCOMMANDS = new Set(["push", "reset", "clean"]);
const DIRECT_UNSAFE_COMMANDS = new Set(["rm", "sudo", "curl", "wget"]);

function basenameOf(p) {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function assertSafeVerificationArgv(argv, context) {
  const program = basenameOf(argv[0]).toLowerCase();
  if (SHELL_INTERPRETERS.has(program)) {
    throw new ContractError(`${context}: shell interpreters are not permitted as a verification command ("${argv[0]}")`);
  }
  if (DIRECT_UNSAFE_COMMANDS.has(program)) {
    throw new ContractError(`${context}: "${program}" is not a permitted verification command`);
  }
  if (program === "git" && argv.some((a) => GIT_UNSAFE_SUBCOMMANDS.has(a))) {
    throw new ContractError(`${context}: unsafe git subcommand in verification command (push|reset|clean are not permitted)`);
  }
  if (PACKAGE_MANAGERS.has(program) && argv.some((a) => PACKAGE_MUTATION_VERBS.has(a))) {
    throw new ContractError(`${context}: package install/publish operations are not permitted as a verification command`);
  }
  if (argv.some((a) => a.toLowerCase() === "deploy")) {
    throw new ContractError(`${context}: deploy commands are not permitted as a verification command`);
  }
}

export function validateVerificationCommand(value, approvalFlags) {
  assertExactShape(value, VERIFICATION_COMMAND_FIELDS, "verification command");
  validateIdentifier("verification", value.id);

  assertArray(value.argv, { max: 32, context: "verification command.argv" });
  if (value.argv.length === 0) {
    throw new ContractError("verification command.argv must not be empty");
  }
  value.argv.forEach((a, i) => assertBoundedString(a, { max: 240, context: `verification command.argv[${i}]` }));
  assertSafeVerificationArgv(value.argv, `verification command "${value.id}"`);

  normalizeRepoPath(value.cwd);

  assertArray(value.requires_approval_ids, { max: 8, context: "verification command.requires_approval_ids" });
  value.requires_approval_ids.forEach((id) => validateIdentifier("approval", id));

  if (approvalFlags !== undefined) {
    if (!Array.isArray(approvalFlags)) {
      throw new ContractError(`validateVerificationCommand: approvalFlags must be an array, got ${describe(approvalFlags)}`);
    }
    const known = new Set(approvalFlags.map((f) => f.id));
    for (const id of value.requires_approval_ids) {
      if (!known.has(id)) {
        throw new ContractError(`verification command "${value.id}" requires_approval_ids references unknown approval "${id}"`);
      }
    }
  }

  return value;
}

// --------------------------------------------------------------------------
// Task graph dependency hygiene — shared between validateTaskGraph and
// validateCorrectionGraph.
// --------------------------------------------------------------------------

// v6 has exactly two waves, and every task in a wave starts from the same
// base commit, so a same-wave dependency is unsound by construction (brief,
// ambiguity resolution #1): depends_on is therefore always empty. This
// function still performs generic unknown-reference and cycle detection
// ahead of that business rule so each failure mode is independently provable
// (and so the same hygiene check can be reused for any future graph shape).
function assertTaskDependenciesWellFormed(tasks, waveLabel) {
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!ids.has(dep)) {
        throw new ContractError(`${waveLabel} task "${t.id}" depends_on unknown task "${dep}"`);
      }
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(tasks.map((t) => [t.id, WHITE]));
  const adjacency = new Map(tasks.map((t) => [t.id, t.depends_on]));

  function visit(id, stack) {
    color.set(id, GRAY);
    for (const dep of adjacency.get(id) ?? []) {
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        throw new ContractError(`${waveLabel} dependency cycle detected: ${[...stack, id, dep].join(" -> ")}`);
      }
      if (depColor === WHITE) visit(dep, [...stack, id]);
    }
    color.set(id, BLACK);
  }
  for (const t of tasks) {
    if (color.get(t.id) === WHITE) visit(t.id, []);
  }

  for (const t of tasks) {
    if (t.depends_on.length > 0) {
      throw new ContractError(`${waveLabel} task "${t.id}" must have an empty depends_on — every task in a wave starts from the same base commit, so a same-wave dependency is unsound. Combine dependent changes into one work order instead.`);
    }
  }
}

function assertNoOverlappingWrites(tasks, waveLabel) {
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      for (const wa of tasks[i].write_paths) {
        for (const wb of tasks[j].write_paths) {
          if (pathsOverlap(wa, wb)) {
            throw new ContractError(`${waveLabel} tasks "${tasks[i].id}" and "${tasks[j].id}" have overlapping write ownership at "${wa}" / "${wb}"`);
          }
        }
      }
    }
  }
}

function assertMaxEffortRules(tasks, claudeScore, waveLabel) {
  const maxTasks = tasks.filter((t) => t.effort === "max");
  if (maxTasks.length > 1) {
    throw new ContractError(`${waveLabel} contains ${maxTasks.length} tasks at effort "max"; at most one "max" task is permitted per wave`);
  }
  if (maxTasks.length === 1 && claudeScore !== undefined && claudeScore !== null && claudeScore !== 5) {
    throw new ContractError(`${waveLabel} task "${maxTasks[0].id}" requires effort "max", which requires Claude's complexity score to be 5 (got ${describe(claudeScore)})`);
  }
}

const TASK_EFFORTS = new Set(["high", "xhigh", "max"]);
const TASK_RISKS = new Set(["low", "medium", "high"]);
const MAX_READ_PATHS = 40;
const MAX_WRITE_PATHS = 40;
const MAX_ACCEPTANCE_IDS_PER_TASK = 40;
const MAX_VERIFY_PER_TASK = 8;

function validateTaskCore(task, fields, context) {
  assertExactShape(task, fields, context);
  validateIdentifier("task", task.id);
  assertBoundedString(task.objective, { max: 480, context: `${context}.objective` });

  assertArray(task.depends_on, { max: 11, context: `${context}.depends_on` });
  task.depends_on.forEach((d) => validateIdentifier("task", d));

  assertArray(task.read_paths, { max: MAX_READ_PATHS, context: `${context}.read_paths` });
  task.read_paths.forEach((p) => normalizeRepoPath(p));

  assertArray(task.write_paths, { max: MAX_WRITE_PATHS, context: `${context}.write_paths` });
  if (task.write_paths.length === 0) {
    throw new ContractError(`${context}.write_paths must not be empty — a task must own at least one write path`);
  }
  task.write_paths.forEach((p) => normalizeRepoPath(p));

  assertArray(task.acceptance_ids, { max: MAX_ACCEPTANCE_IDS_PER_TASK, context: `${context}.acceptance_ids` });
  if (task.acceptance_ids.length === 0) {
    throw new ContractError(`${context}.acceptance_ids must not be empty`);
  }
  task.acceptance_ids.forEach((id) => validateIdentifier("acceptance", id));
  assertUniqueIds(task.acceptance_ids.map((id) => ({ id })), (x) => x.id, `${context}.acceptance_ids`);

  assertArray(task.verify, { max: MAX_VERIFY_PER_TASK, context: `${context}.verify` });
  if (task.verify.length === 0) {
    throw new ContractError(`${context}.verify must not be empty`);
  }

  if (typeof task.effort !== "string" || !TASK_EFFORTS.has(task.effort)) {
    throw new ContractError(`${context}.effort must be one of ${[...TASK_EFFORTS].join("|")} (worker effort below "high" is rejected, as is any "ultra" value), got ${describe(task.effort)}`);
  }
  if (typeof task.risk !== "string" || !TASK_RISKS.has(task.risk)) {
    throw new ContractError(`${context}.risk must be one of ${[...TASK_RISKS].join("|")}, got ${describe(task.risk)}`);
  }
}

// --------------------------------------------------------------------------
// validateTaskGraph — Step 3
// --------------------------------------------------------------------------

const TASK_GRAPH_FIELDS = ["version", "run_id", "base_commit", "complexity_review", "acceptance", "approval_flags", "final_verification", "tasks"];
const COMPLEXITY_REVIEW_FIELDS = ["grader_score", "claude_score", "override_reason"];
const ACCEPTANCE_CRITERION_FIELDS = ["id", "text"];
const TASK_FIELDS = ["id", "wave", "objective", "depends_on", "read_paths", "write_paths", "acceptance_ids", "verify", "effort", "risk"];
const GRAPH_MAX_BYTES = 65536;
const MAX_ACCEPTANCE = 40;
const MAX_TASKS_PER_WAVE = 12;
const MAX_APPROVALS = 20; // brief leaves this uncapped explicitly; chosen conservatively
const MAX_FINAL_VERIFICATION = 20;

function validateComplexityReview(value, context) {
  assertExactShape(value, COMPLEXITY_REVIEW_FIELDS, context);
  assertInteger(value.grader_score, { min: 1, max: 5, context: `${context}.grader_score` });
  assertInteger(value.claude_score, { min: 1, max: 5, context: `${context}.claude_score` });
  if (value.grader_score === value.claude_score) {
    if (value.override_reason !== null) {
      throw new ContractError(`${context}.override_reason must be null when claude_score equals grader_score`);
    }
  } else {
    assertBoundedString(value.override_reason, { max: 480, context: `${context}.override_reason` });
  }
  return value.claude_score;
}

export function validateTaskGraph(value, options = {}) {
  assertPlainObject(value, "task graph");
  assertSerializedByteCap(value, GRAPH_MAX_BYTES, "task graph");
  assertExactShape(value, TASK_GRAPH_FIELDS, "task graph");

  if (value.version !== 1) {
    throw new ContractError(`task graph.version must be exactly 1, got ${describe(value.version)}`);
  }
  validateIdentifier("run", value.run_id);
  if (options.runId !== undefined && value.run_id !== options.runId) {
    throw new ContractError(`task graph.run_id "${value.run_id}" does not match the expected run "${options.runId}"`);
  }
  assertCommitId(value.base_commit, options.objectFormat, "task graph.base_commit");

  const claudeScore = validateComplexityReview(value.complexity_review, "task graph.complexity_review");

  assertArray(value.acceptance, { max: MAX_ACCEPTANCE, context: "task graph.acceptance" });
  if (value.acceptance.length === 0) {
    throw new ContractError("task graph.acceptance must not be empty");
  }
  value.acceptance.forEach((a, i) => {
    assertExactShape(a, ACCEPTANCE_CRITERION_FIELDS, `task graph.acceptance[${i}]`);
    validateIdentifier("acceptance", a.id);
    assertBoundedString(a.text, { max: 480, context: `task graph.acceptance[${i}].text` });
  });
  assertUniqueIds(value.acceptance, (a) => a.id, "task graph.acceptance");
  const planAcceptanceIds = new Set(value.acceptance.map((a) => a.id));

  assertArray(value.approval_flags, { max: MAX_APPROVALS, context: "task graph.approval_flags" });
  value.approval_flags.forEach((f) => {
    validateApprovalFlag(f);
    if (f.status !== "PENDING") {
      throw new ContractError(`task graph.approval_flags "${f.id}" must be status "PENDING" at plan-acceptance time, got "${f.status}"`);
    }
  });
  assertUniqueIds(value.approval_flags, (f) => f.id, "task graph.approval_flags");

  assertArray(value.final_verification, { max: MAX_FINAL_VERIFICATION, context: "task graph.final_verification" });
  if (value.final_verification.length === 0) {
    throw new ContractError("task graph.final_verification must not be empty");
  }
  value.final_verification.forEach((v) => validateVerificationCommand(v, value.approval_flags));
  assertUniqueIds(value.final_verification, (v) => v.id, "task graph.final_verification");

  assertArray(value.tasks, { max: MAX_TASKS_PER_WAVE, context: "task graph.tasks" });
  if (value.tasks.length === 0) {
    throw new ContractError("task graph.tasks must not be empty");
  }
  value.tasks.forEach((t, i) => {
    validateTaskCore(t, TASK_FIELDS, `task graph.tasks[${i}]`);
    if (t.wave !== 1) {
      throw new ContractError(`task graph.tasks[${i}].wave must be exactly 1 (this file is the wave-one plan), got ${describe(t.wave)}`);
    }
    t.acceptance_ids.forEach((id) => {
      if (!planAcceptanceIds.has(id)) {
        throw new ContractError(`task graph.tasks[${i}] (${t.id}) acceptance_ids references unknown acceptance criterion "${id}"`);
      }
    });
    t.verify.forEach((v) => validateVerificationCommand(v, value.approval_flags));
    assertUniqueIds(t.verify, (v) => v.id, `task graph.tasks[${i}].verify`);
  });
  assertUniqueIds(value.tasks, (t) => t.id, "task graph.tasks");

  assertTaskDependenciesWellFormed(value.tasks, "wave-one");
  assertNoOverlappingWrites(value.tasks, "wave-one");
  assertMaxEffortRules(value.tasks, claudeScore, "wave-one");

  const covered = new Set(value.tasks.flatMap((t) => t.acceptance_ids));
  for (const id of planAcceptanceIds) {
    if (!covered.has(id)) {
      throw new ContractError(`task graph acceptance criterion "${id}" is not covered by any task`);
    }
  }

  return value;
}

// --------------------------------------------------------------------------
// validateCorrectionGraph — Step 3
// --------------------------------------------------------------------------

const CORRECTION_GRAPH_FIELDS = ["version", "run_id", "wave", "base_commit", "source_review", "tasks"];
const CORRECTION_TASK_FIELDS = [
  "id", "objective", "depends_on", "read_paths", "write_paths", "acceptance_ids",
  "verify", "effort", "risk", "source_task_id", "session_policy",
];
const SESSION_POLICIES = new Set(["fresh", "resume-exact"]);

export function validateCorrectionGraph(value, options = {}) {
  assertPlainObject(value, "correction graph");
  assertSerializedByteCap(value, GRAPH_MAX_BYTES, "correction graph");
  assertExactShape(value, CORRECTION_GRAPH_FIELDS, "correction graph");

  if (value.version !== 1) {
    throw new ContractError(`correction graph.version must be exactly 1, got ${describe(value.version)}`);
  }
  validateIdentifier("run", value.run_id);
  if (options.runId !== undefined && value.run_id !== options.runId) {
    throw new ContractError(`correction graph.run_id "${value.run_id}" does not match the expected run "${options.runId}"`);
  }
  // The Phase enum has no WAVE_3_* state and no field anywhere accepts an
  // arbitrary wave number: this literal-2 check is what makes a third wave
  // structurally unrepresentable in data, not merely policy-rejected.
  if (value.wave !== 2) {
    throw new ContractError(`correction graph.wave must be exactly 2 — v6 supports at most one correction wave, got ${describe(value.wave)}`);
  }
  assertCommitId(value.base_commit, options.objectFormat, "correction graph.base_commit");
  if (options.expectedBaseCommit !== undefined && value.base_commit !== options.expectedBaseCommit) {
    throw new ContractError(`correction graph.base_commit "${value.base_commit}" must exactly equal checkpoint one's integration HEAD "${options.expectedBaseCommit}"`);
  }
  if (value.source_review !== "review.json") {
    throw new ContractError(`correction graph.source_review must be exactly "review.json", got ${describe(value.source_review)}`);
  }

  assertArray(value.tasks, { max: MAX_TASKS_PER_WAVE, context: "correction graph.tasks" });
  if (value.tasks.length === 0) {
    throw new ContractError("correction graph.tasks must not be empty");
  }

  const waveOneTasksById = options.waveOneTasksById;
  const nonSatisfiedIds = options.nonSatisfiedAcceptanceIds ? new Set(options.nonSatisfiedAcceptanceIds) : null;
  const planAcceptanceIds = options.acceptanceIds ? new Set(options.acceptanceIds) : null;

  value.tasks.forEach((t, i) => {
    const context = `correction graph.tasks[${i}]`;
    validateTaskCore(t, CORRECTION_TASK_FIELDS, context);

    if (t.source_task_id !== null) {
      validateIdentifier("task", t.source_task_id);
      if (waveOneTasksById && !(t.source_task_id in waveOneTasksById)) {
        throw new ContractError(`${context} (${t.id}) source_task_id "${t.source_task_id}" is not a wave-one task`);
      }
    }
    if (typeof t.session_policy !== "string" || !SESSION_POLICIES.has(t.session_policy)) {
      throw new ContractError(`${context}.session_policy must be one of ${[...SESSION_POLICIES].join("|")}, got ${describe(t.session_policy)}`);
    }
    if (t.session_policy === "resume-exact") {
      if (t.source_task_id === null) {
        throw new ContractError(`${context} (${t.id}) session_policy "resume-exact" requires a non-null source_task_id`);
      }
      if (waveOneTasksById) {
        const source = waveOneTasksById[t.source_task_id];
        if (!source) {
          throw new ContractError(`${context} (${t.id}) resume-exact source_task_id "${t.source_task_id}" was not found among wave-one tasks`);
        }
        if (source.effort !== t.effort) {
          throw new ContractError(`${context} (${t.id}) resume-exact requires unchanged effort (source "${source.effort}" vs correction "${t.effort}")`);
        }
        const sourceWrites = new Set(source.write_paths ?? []);
        for (const w of t.write_paths) {
          if (!sourceWrites.has(w)) {
            throw new ContractError(`${context} (${t.id}) resume-exact write_paths must be a subset of the source task's ownership; "${w}" was not owned by "${t.source_task_id}"`);
          }
        }
      }
    }

    if (planAcceptanceIds) {
      t.acceptance_ids.forEach((id) => {
        if (!planAcceptanceIds.has(id)) {
          throw new ContractError(`${context} (${t.id}) acceptance_ids references unknown acceptance criterion "${id}" — unrelated scope is rejected`);
        }
      });
    }
    if (nonSatisfiedIds) {
      if (!t.acceptance_ids.some((id) => nonSatisfiedIds.has(id))) {
        throw new ContractError(`${context} (${t.id}) must target at least one non-satisfied acceptance ID`);
      }
    }

    // Corrections carry no approval_flags of their own (v6's correction-graph
    // shape has no such field — see CORRECTION_GRAPH_FIELDS), so a
    // correction's verification can only reference an approval that already
    // exists on the original plan. The caller threads that list through
    // options.approvalFlags; it defaults closed (no references permitted at
    // all) rather than open, so a correction cannot invent new gated
    // operations by omission.
    t.verify.forEach((v) => validateVerificationCommand(v, options.approvalFlags ?? []));
    assertUniqueIds(t.verify, (v) => v.id, `${context}.verify`);
  });
  assertUniqueIds(value.tasks, (t) => t.id, "correction graph.tasks");

  assertTaskDependenciesWellFormed(value.tasks, "wave-two");
  assertNoOverlappingWrites(value.tasks, "wave-two");
  assertMaxEffortRules(value.tasks, options.claudeScore, "wave-two");

  if (nonSatisfiedIds) {
    const covered = new Set(value.tasks.flatMap((t) => t.acceptance_ids));
    for (const id of nonSatisfiedIds) {
      if (!covered.has(id)) {
        throw new ContractError(`correction graph does not cover non-satisfied acceptance criterion "${id}" with any task`);
      }
    }
  }

  return value;
}

// --------------------------------------------------------------------------
// validateClaudeReview
// --------------------------------------------------------------------------

const CLAUDE_REVIEW_FIELDS = ["acceptance", "summary"];
const CLAUDE_REVIEW_ITEM_FIELDS = ["id", "status", "evidence_paths", "reason"];
const CLAUDE_REVIEW_STAGE_STATUSES = {
  "wave-one": new Set(["SATISFIED", "GAP", "UNCERTAIN"]),
  "post-correction": new Set(["SATISFIED", "BLOCKED"]),
};

// Note what is *not* here: source_task_id, session_policy, wave, or any
// other correction-task field. Because this shape is closed
// (assertExactShape rejects unknown fields) and the two stage enums above
// are the only statuses ever accepted, there is no field a review can carry
// that would let a third wave of work ride along inside review.json or
// final-review.json.
export function validateClaudeReview(value, { acceptanceIds, stage } = {}) {
  const statuses = CLAUDE_REVIEW_STAGE_STATUSES[stage];
  if (!statuses) {
    throw new ContractError(`validateClaudeReview: stage must be one of ${Object.keys(CLAUDE_REVIEW_STAGE_STATUSES).join("|")}, got ${describe(stage)}`);
  }
  if (!Array.isArray(acceptanceIds)) {
    throw new ContractError(`validateClaudeReview: acceptanceIds must be an array, got ${describe(acceptanceIds)}`);
  }
  acceptanceIds.forEach((id) => validateIdentifier("acceptance", id));

  assertExactShape(value, CLAUDE_REVIEW_FIELDS, "claude review");
  assertBoundedString(value.summary, { max: 480, context: "claude review.summary" });

  assertArray(value.acceptance, { max: MAX_ACCEPTANCE, context: "claude review.acceptance" });
  value.acceptance.forEach((item, i) => {
    assertExactShape(item, CLAUDE_REVIEW_ITEM_FIELDS, `claude review.acceptance[${i}]`);
    validateIdentifier("acceptance", item.id);
    if (!statuses.has(item.status)) {
      throw new ContractError(`claude review.acceptance[${i}].status must be one of ${[...statuses].join("|")} for stage "${stage}", got ${describe(item.status)}`);
    }
    assertArray(item.evidence_paths, { max: 8, context: `claude review.acceptance[${i}].evidence_paths` });
    item.evidence_paths.forEach((p) => normalizeRepoPath(p));
    assertBoundedString(item.reason, { max: 480, context: `claude review.acceptance[${i}].reason` });
  });

  const expected = new Set(acceptanceIds);
  const reportedIds = value.acceptance.map((a) => a.id);
  const reported = new Set(reportedIds);
  if (reportedIds.length !== reported.size) {
    throw new ContractError("claude review.acceptance contains a duplicate acceptance ID");
  }
  if (expected.size !== reported.size || ![...expected].every((id) => reported.has(id))) {
    throw new ContractError(`claude review must cover every plan acceptance ID exactly once (expected: ${[...expected].join(",")}; got: ${[...reported].join(",")})`);
  }

  return value;
}
