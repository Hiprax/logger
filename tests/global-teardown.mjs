// Fails the run when any test wrote into the repository. Tests must write
// only under the OS temp directory (see `createTempDir` in tests/_helpers.ts);
// a logger created without an explicit `logDirectory` writes to `<cwd>/logs`.

import console from "node:console";
import { GUARD_STATE_KEY, describeChanges, snapshotRepository } from "./repo-write-guard.mjs";

const globalTeardown = (globalConfig) => {
  // Not deleted after use: globalSetup overwrites it on every run, and Jest can
  // invoke globalTeardown a second time on a `--bail` exit.
  const state = globalThis[GUARD_STATE_KEY];
  if (state === undefined) {
    throw new Error(
      "Repository write guard: no baseline was recorded (is tests/global-setup.mjs wired as globalSetup?).",
    );
  }

  const changes = describeChanges(
    state.snapshot,
    snapshotRepository(state.rootDir, state.skippedPaths),
  );
  if (changes.length === 0) {
    return;
  }
  const report = [
    `Repository write guard: ${state.rootDir} changed while the test run was in progress.`,
    "Tests must write only under the OS temp directory (pass an explicit logDirectory).",
    ...changes.map((line) => `  ${line}`),
  ].join("\n");
  // In watch mode a throw from globalTeardown leaves Jest's watcher marked as
  // still running, so no later run would start; report instead. Every gate
  // (`npm test`, `npm run verify`) runs without --watch and fails on the throw.
  if (globalConfig.watch || globalConfig.watchAll) {
    console.error(report);
    return;
  }
  throw new Error(report);
};

export default globalTeardown;
