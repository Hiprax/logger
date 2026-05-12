#!/usr/bin/env node
// Sync local main with origin and clean up branches whose remote tracking
// branch was deleted (i.e. branches whose PRs were merged & deleted on GitHub).
//
// Usage:
//   npm run sync
//
// Safe by default - never force-resets, never deletes unmerged branches.

import { run, git, log, c, confirm, main } from "./_lib.mjs";

main(async () => {
  log.step("Syncing local main with origin");

  if (!(await git.isClean())) {
    log.fail("Working tree has uncommitted changes. Commit or stash first.");
    process.exit(1);
  }

  log.info("Fetching with --prune (drops remote branches deleted on GitHub)...");
  await git.fetch();

  const currentBranch = await git.branch();
  if (currentBranch !== "main") {
    log.info(`Switching from ${c.bold(currentBranch)} to main...`);
    await run("git", ["checkout", "main"]);
  }

  log.info("Pulling latest main (fast-forward only)...");
  await run("git", ["pull", "origin", "main", "--ff-only"]);
  log.ok("main is up to date.");

  const goneBranchesRaw = await git.capture("for-each-ref", "--format=%(refname:short) %(upstream:track)", "refs/heads/");
  const goneBranches = goneBranchesRaw
    .split("\n")
    .map((line) => {
      const [name, ...rest] = line.split(/\s+/);
      return { name, track: rest.join(" ") };
    })
    .filter((b) => b.name && b.name !== "main" && b.track.includes("[gone]"))
    .map((b) => b.name);

  if (goneBranches.length === 0) {
    log.ok("No stale local branches to clean up.");
    return;
  }

  console.log("");
  log.warn(`${goneBranches.length} local branch(es) have a deleted remote:`);
  for (const b of goneBranches) console.log(`  ${c.dim("-")} ${b}`);

  const ok = await confirm(`Delete these local branches?`, true);
  if (!ok) {
    log.info("Skipped cleanup. (Run again any time.)");
    return;
  }

  let deleted = 0;
  for (const b of goneBranches) {
    try {
      await run("git", ["branch", "-d", b], { silent: true });
      log.ok(`Deleted ${b}`);
      deleted++;
    } catch {
      const force = await confirm(`  ${b} not detected as merged into main. Force delete (-D)?`, true);
      if (force) {
        await run("git", ["branch", "-D", b]);
        log.ok(`Force-deleted ${b}`);
        deleted++;
      } else {
        log.warn(`Skipped ${b}`);
      }
    }
  }

  console.log(`\n${c.green(c.bold(`Cleaned up ${deleted} branch(es).`))}`);
});
