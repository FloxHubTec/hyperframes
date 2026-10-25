#!/usr/bin/env node
// flake-gate.mjs --base <sha> [--list]: re-runs every package test file the PR adds or changes under CPU
// contention and fails on any failed run. --list only prints the files and sets the `any` step output.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";

const TEST_FILE = /^packages\/[^/]+\/.+\.(test|spec)\.(ts|tsx|mjs)$/;
const RETRY_ADDED = /^\+(?!\+\+).*(\bretry\s*:\s*(?:[1-9]|true)|\.retry\(\s*[1-9]|vi\.retryOnce|--retry\b)/m;

export function selectTestFiles(nameStatus) {
  const files = [];
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [status, ...paths] = line.split("\t");
    if (status.startsWith("D")) continue;
    const file = paths.at(-1);
    if (TEST_FILE.test(file) && !file.includes("/node_modules/")) files.push(file);
  }
  return files;
}

export function addsRetry(patch) {
  return RETRY_ADDED.test(patch);
}

export function runnerFor(source) {
  return /\bfrom\s+["']bun:test["']/.test(source) ? "bun" : "vitest";
}

// Fixed by file count, never by elapsed time, so the gate's verdict depends only on test results.
export function runsFor(fileCount) {
  return fileCount <= 20 ? 10 : 3;
}

function git(...args) {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function command(file) {
  const [, pkg, rel] = file.match(/^(packages\/[^/]+)\/(.+)$/);
  const source = readFileSync(file, "utf8");
  if (runnerFor(source) === "bun") return { cwd: pkg, cmd: "bun", args: ["test", rel], env: {} };
  return { cwd: pkg, cmd: "bun", args: ["x", "vitest", "run", "--maxWorkers=2", rel], env: {} };
}

function startBurners() {
  return Array.from({ length: cpus().length }, () =>
    spawn(process.execPath, ["-e", "for(;;);"], { stdio: "ignore" }),
  );
}

function runOnce({ cwd, cmd, args, env }) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
}

function main() {
  const base = process.argv[process.argv.indexOf("--base") + 1];
  const list = process.argv.includes("--list");
  const files = selectTestFiles(git("diff", "-M", "--name-status", base, "HEAD", "--", "packages"));
  const patch = git(
    "diff", "-M", "-U0", base, "HEAD", "--",
    "packages/**/*.test.*", "packages/**/*.spec.*", "packages/**/vitest.config.*", "vitest.config.*", "vitest.workspace.*",
  );
  if (addsRetry(patch)) {
    console.error("::error::This change adds a test retry. Retries hide flaky tests; fix the flake instead.");
    process.exit(1);
  }
  if (list) {
    console.log(files.join("\n"));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `any=${files.length > 0}\n`);
    return;
  }
  const runs = runsFor(files.length);
  console.log(`Re-running ${files.length} test file(s) ${runs} times each under CPU contention`);
  const burners = startBurners();
  const failures = [];
  try {
    for (const file of files) {
      const spec = command(file);
      let failed = 0;
      for (let i = 1; i <= runs; i++) {
        const { ok, output } = runOnce(spec);
        if (ok) continue;
        failed++;
        console.log(`::group::${file} run ${i}/${runs} failed\n${output}\n::endgroup::`);
      }
      const verdict = failed === 0 ? "ok" : failed === runs ? "fails in the gate" : "flaky";
      console.log(`${verdict}: ${file}: ${runs - failed}/${runs} passed`);
      if (failed > 0) failures.push(`${file} (${verdict}, ${failed}/${runs} failed)`);
    }
  } finally {
    for (const b of burners) b.kill();
  }
  if (failures.length > 0) {
    console.error(`::error::Failing tests: ${failures.join(", ")}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
