// Shared by tests/global-setup.mjs and tests/global-teardown.mjs: a stat
// snapshot of the repository, taken before and after the run, so a test that
// writes into the working tree (for example a logger built with the default
// `<cwd>/logs` directory) fails `npm test` instead of leaving files behind.
//
// Limits: a snapshot compares type, size, and nanosecond mtime, so it catches
// every create, delete, and byte written. It cannot see a file opened for
// append that receives no bytes (which is why a stale `logs/` holding today's
// zero-byte files would mask a regression; keep that directory absent).

import fs from "node:fs";
import path from "node:path";

/** Key under which globalSetup hands its baseline to globalTeardown. */
export const GUARD_STATE_KEY = "__REPOSITORY_WRITE_GUARD__";

/** Never walked, at any depth: version control and installed packages. */
const SKIPPED_NAMES = new Set([".git", "node_modules"]);

/**
 * The repository root Jest resolved (the directory holding jest.config.ts),
 * rather than `process.cwd()`: a run started from a subdirectory must still
 * scan the whole tree.
 */
export const resolveGuardRoot = (globalConfig, projectConfig) =>
  projectConfig?.rootDir ?? globalConfig.rootDir;

/**
 * Directories Jest itself writes during a run. Coverage is reported in
 * `onRunComplete`, before globalTeardown runs, so it must be excluded; the
 * transform cache lives in the OS temp directory by default but may be
 * configured inside the repository.
 */
export const resolveSkippedPaths = (rootDir, globalConfig, projectConfig) =>
  new Set(
    [globalConfig.coverageDirectory, projectConfig?.cacheDirectory]
      .filter((dir) => typeof dir === "string")
      .map((dir) => path.resolve(rootDir, dir)),
  );

/**
 * Maps each repository-relative path to `"<kind> <size> <mtimeNs>"`.
 * Top-level dot entries are skipped: they hold version-control, editor, and
 * external tooling state that can legitimately change while the suite runs.
 * Symlinks are recorded, never followed.
 */
export const snapshotRepository = (rootDir, skippedPaths) => {
  const entries = new Map();
  const walk = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, dirent.name);
      if (SKIPPED_NAMES.has(dirent.name) || skippedPaths.has(absolute)) {
        continue;
      }
      if (dir === rootDir && dirent.name.startsWith(".")) {
        continue;
      }
      const stats = fs.lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
      if (stats === undefined) {
        // Removed between readdir and lstat: absent from this snapshot, so the
        // diff still reports it if it existed in the other one.
        continue;
      }
      const kind = stats.isDirectory() ? "dir" : stats.isSymbolicLink() ? "link" : "file";
      entries.set(path.relative(rootDir, absolute), `${kind} ${stats.size} ${stats.mtimeNs}`);
      if (stats.isDirectory()) {
        walk(absolute);
      }
    }
  };
  walk(rootDir);
  return entries;
};

/**
 * One line per difference between two snapshots (`created: <path>`,
 * `changed: <path>`, `deleted: <path>`), grouped by kind in code-unit order.
 */
export const describeChanges = (before, after) => {
  const lines = [];
  for (const [entry, signature] of after) {
    if (!before.has(entry)) {
      lines.push(`created: ${entry}`);
    } else if (before.get(entry) !== signature) {
      lines.push(`changed: ${entry}`);
    }
  }
  for (const entry of before.keys()) {
    if (!after.has(entry)) {
      lines.push(`deleted: ${entry}`);
    }
  }
  return lines.sort();
};
