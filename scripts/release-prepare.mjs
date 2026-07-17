#!/usr/bin/env node
// Prepare a release: bump version, promote CHANGELOG [Unreleased] heading,
// commit, push as a release branch. Stops there - you open the PR and merge
// via GitHub. After the PR merges, run release:tag to create and push the
// tag (which triggers the release workflow on CI).
//
// Usage:
//   npm run release:prepare -- patch        # 1.2.3 -> 1.2.4
//   npm run release:prepare -- minor        # 1.2.3 -> 1.3.0
//   npm run release:prepare -- major        # 1.2.3 -> 2.0.0
//   npm run release:prepare -- 1.2.3-beta.1 # explicit version (no bump)
//
// Pre-flight checks (any failure aborts before any change is made):
//   - On main branch
//   - Working tree clean
//   - origin/main is up-to-date with local
//   - All five npm gates pass (build, test, lint, type-check, format:check)

import {
  run, git, log, c, confirm, usage, main,
  readPkg, writePkg, readChangelog, writeChangelog,
  bumpVersion, today,
} from "./_lib.mjs";

const HELP = `
release:prepare - Bump version + CHANGELOG, commit on a release branch, push.

Usage:
  node scripts/release-prepare.mjs <patch|minor|major|x.y.z> [options]

Options:
  -y, --yes       Skip all confirmation prompts (for CI / scripts)
  --skip-checks   Skip the five npm gates (NOT recommended)
  -h, --help      Show this help

After this script finishes:
  1. Open the PR in your browser using the URL it prints.
  2. Wait for CI green, squash-and-merge, delete the branch.
  3. Run: npm run release:tag
`;

main(async () => {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) usage(HELP);

  const arg = args.find((a) => !a.startsWith("-"));
  if (!arg) {
    log.fail("Specify a bump type: patch | minor | major, or an explicit X.Y.Z version.");
    usage(HELP);
  }

  const skipChecks = args.includes("--skip-checks");

  log.step("Pre-flight checks");

  const branch = await git.branch();
  if (branch !== "main") {
    log.fail(`You're on '${branch}'. Switch to main first.`);
    process.exit(1);
  }
  log.ok("On main branch.");

  if (!(await git.isClean())) {
    log.fail("Working tree has uncommitted changes. Commit or stash first.");
    process.exit(1);
  }
  log.ok("Working tree clean.");

  log.info("Fetching origin...");
  await git.fetch();
  const ahead = await git.ahead("main", "origin/main");
  const behind = await git.behind("main", "origin/main");
  if (ahead > 0 || behind > 0) {
    log.fail(`local main vs origin/main: ${ahead} ahead, ${behind} behind. Sync first.`);
    process.exit(1);
  }
  log.ok("Local main matches origin/main.");

  if (!skipChecks) {
    log.step("Running quality gates");
    await run("node", ["scripts/verify.mjs"]);
    log.ok("All checks passed.");
  } else {
    log.warn("Skipping quality gates (--skip-checks).");
  }

  const { json: pkg } = await readPkg();
  const currentVersion = pkg.version;
  let newVersion;
  if (["patch", "minor", "major"].includes(arg)) {
    newVersion = bumpVersion(currentVersion, arg);
  } else if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg)) {
    newVersion = arg;
  } else {
    log.fail(`Unrecognized version arg: '${arg}'. Use patch / minor / major / X.Y.Z.`);
    process.exit(1);
  }

  log.step(`Releasing ${c.bold(`${currentVersion} -> ${newVersion}`)}`);

  pkg.version = newVersion;
  await writePkg(pkg);
  log.ok(`package.json bumped to ${newVersion}`);

  // Keep package-lock.json's version in lockstep with package.json. Without
  // this the lockfile's root version silently drifts, and the `git add
  // package-lock.json` below stages nothing. --package-lock-only touches only
  // the lockfile (no node_modules write); --ignore-scripts avoids running any
  // install lifecycle script during a release prep.
  await run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
  log.ok("package-lock.json synced to the new version");

  const changelog = await readChangelog();
  if (changelog) {
    const date = today();
    const unreleasedRe = /^## \[Unreleased\][^\n]*$/m;
    const match = unreleasedRe.exec(changelog);
    if (!match) {
      log.warn("CHANGELOG.md has no [Unreleased] section. Leaving CHANGELOG untouched.");
    } else {
      const replaced = changelog.replace(
        unreleasedRe,
        `## [Unreleased]\n\n## [${newVersion}] - ${date}`,
      );
      await writeChangelog(replaced);
      log.ok(`CHANGELOG promoted: [Unreleased] -> [${newVersion}] - ${date}`);
    }
  } else {
    log.warn("No CHANGELOG.md found. Skipping CHANGELOG promotion.");
  }

  const releaseBranch = `release/v${newVersion}`;
  log.step(`Committing on ${c.bold(releaseBranch)}`);

  await run("git", ["checkout", "-b", releaseBranch]);
  await run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md"], { allowFail: true });
  await run("git", ["commit", "-m", `release v${newVersion}`]);

  const ok = await confirm(`Push ${releaseBranch} to origin?`, true);
  if (!ok) {
    log.warn(`Branch ready locally. Push when you're ready: git push -u origin ${releaseBranch}`);
    return;
  }

  await git.push("-u", "origin", releaseBranch);

  const remote = await git.remote();
  const repoMatch = /[:/]([^:/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  const repoSlug = repoMatch ? repoMatch[1] : null;

  log.hr();
  console.log(c.green(c.bold(`Release v${newVersion} prepared.`)));
  if (repoSlug) {
    console.log(`\nOpen the PR:`);
    console.log(`  ${c.cyan(`https://github.com/${repoSlug}/pull/new/${releaseBranch}`)}`);
  }
  console.log(`\nAfter the PR is merged on GitHub, run:`);
  console.log(`  ${c.cyan("npm run release:tag")}`);
  console.log(`\nThe tag push triggers the release workflow which publishes to npm.\n`);
});
