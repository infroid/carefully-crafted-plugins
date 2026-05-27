#!/usr/bin/env node
// Writes a triage routing plan to
// docs/carefully-crafted-plugins/triage/<YYYY-MM-DD-HHMMSS>-<slug>.json
//
// Two call styles:
//
//   1) Flag-based (single or repeated --task-id blocks):
//      node triage-write.mjs --decomposition single \
//        --task-id t1 --summary "audit auth.ts" \
//        --difficulty hard --specialist codex --effort xhigh \
//        [--model gpt-5.5]
//
//   2) JSON on stdin:
//      echo '{"decomposition":"single","tasks":[...]}' | \
//        node triage-write.mjs --stdin
//
// Required per task: id, summary, difficulty, specialist, effort.
// Optional per task: model.
//
// Exits 0 on success and prints the artifact path on stdout.
// Exits 2 on invalid args.

import fs from "node:fs";
import path from "node:path";

const DIFFICULTIES = new Set(["low", "medium", "hard"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const SPECIALISTS = new Set(["claude", "codex", "agy", "contexthub"]);
const DECOMPOSITIONS = new Set(["single", "subtasks"]);

function die(msg) {
  console.error(`triage-write: ${msg}`);
  process.exit(2);
}

function parseFlagArgs(argv) {
  const plan = { decomposition: null, tasks: [] };
  let cur = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) die(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--stdin":
        return null;
      case "--decomposition":
        plan.decomposition = next();
        break;
      case "--task-id":
        if (cur) plan.tasks.push(cur);
        cur = { id: next() };
        break;
      case "--summary":
        if (!cur) die("--summary requires a preceding --task-id");
        cur.summary = next();
        break;
      case "--difficulty":
        if (!cur) die("--difficulty requires a preceding --task-id");
        cur.difficulty = next();
        break;
      case "--specialist":
        if (!cur) die("--specialist requires a preceding --task-id");
        cur.suggested_specialist = next();
        break;
      case "--effort":
        if (!cur) die("--effort requires a preceding --task-id");
        cur.suggested_effort = next();
        break;
      case "--model":
        if (!cur) die("--model requires a preceding --task-id");
        cur.suggested_model = next();
        break;
      case "--cwd":
        plan._cwd = next();
        break;
      default:
        die(`unknown arg: ${a}`);
    }
  }
  if (cur) plan.tasks.push(cur);
  return plan;
}

function readStdin() {
  const data = fs.readFileSync(0, "utf8");
  try {
    return JSON.parse(data);
  } catch (e) {
    die(`invalid JSON on stdin: ${e.message}`);
  }
}

function validate(plan) {
  if (!DECOMPOSITIONS.has(plan.decomposition)) {
    die(`decomposition must be one of: ${[...DECOMPOSITIONS].join(", ")}`);
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    die("plan must contain at least one task");
  }
  if (plan.decomposition === "single" && plan.tasks.length !== 1) {
    die(`decomposition is "single" but ${plan.tasks.length} tasks given`);
  }
  const ids = new Set();
  for (const t of plan.tasks) {
    if (!t.id) die("each task needs an id");
    if (ids.has(t.id)) die(`duplicate task id: ${t.id}`);
    ids.add(t.id);
    if (!t.summary) die(`task ${t.id} missing summary`);
    if (!DIFFICULTIES.has(t.difficulty)) {
      die(`task ${t.id} difficulty must be one of: ${[...DIFFICULTIES].join(", ")}`);
    }
    if (!SPECIALISTS.has(t.suggested_specialist)) {
      die(`task ${t.id} specialist must be one of: ${[...SPECIALISTS].join(", ")}`);
    }
    if (!EFFORTS.has(t.suggested_effort)) {
      die(`task ${t.id} effort must be one of: ${[...EFFORTS].join(", ")}`);
    }
  }
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function main() {
  const argv = process.argv.slice(2);
  const useStdin = argv.includes("--stdin");

  // --cwd is honored in both modes. Pull it out of argv first so the
  // stdin path can still see it.
  let cwdOverride = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd") {
      cwdOverride = argv[i + 1];
      argv.splice(i, 2);
      i--;
    }
  }

  let plan = useStdin ? readStdin() : parseFlagArgs(argv);
  if (!plan) plan = readStdin();
  const cwd = cwdOverride || plan._cwd || process.cwd();
  delete plan._cwd;

  // Add a created_at timestamp + format version
  const finalPlan = {
    version: 1,
    created_at: new Date().toISOString(),
    decomposition: plan.decomposition,
    tasks: plan.tasks,
  };

  validate(finalPlan);

  const dir = path.join(cwd, "docs", "carefully-crafted-plugins", "triage");
  fs.mkdirSync(dir, { recursive: true });
  const slug = slugify(finalPlan.tasks[0].summary);
  const file = path.join(dir, `${timestamp()}-${slug}.json`);
  fs.writeFileSync(file, JSON.stringify(finalPlan, null, 2) + "\n");
  console.log(file);
}

main();
