// Records the repository baseline that tests/global-teardown.mjs compares
// against. Jest runs both hooks in its parent process, so the baseline is
// handed over on `globalThis` (the pattern Jest documents for sharing state
// from globalSetup to globalTeardown).

import {
  GUARD_STATE_KEY,
  resolveGuardRoot,
  resolveSkippedPaths,
  snapshotRepository,
} from "./repo-write-guard.mjs";

const globalSetup = (globalConfig, projectConfig) => {
  const rootDir = resolveGuardRoot(globalConfig, projectConfig);
  const skippedPaths = resolveSkippedPaths(rootDir, globalConfig, projectConfig);
  globalThis[GUARD_STATE_KEY] = {
    rootDir,
    skippedPaths,
    snapshot: snapshotRepository(rootDir, skippedPaths),
  };
};

export default globalSetup;
