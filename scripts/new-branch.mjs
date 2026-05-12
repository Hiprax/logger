#!/usr/bin/env node
// Create and switch to a properly-named feature branch.
//
// Usage:
//   npm run branch -- feat add-cool-thing
//   npm run branch -- fix middleware-leak
//   node scripts/new-branch.mjs feat add-cool-thing
//
// The first arg is the prefix (feat / fix / chore / ci / docs / deps /
// refactor / perf / test). The rest are joined with hyphens for the
// branch name. The branch is created from a fresh `origin/main`.

import { run, git, log, c, usage, main } from "./_lib.mjs";

const PREFIXES = ["feat", "fix", "chore", "ci", "docs", "deps", "refactor", "perf", "test"];

const HELP = `
new-branch - Create a feature branch with a conventional name.

Usage:
  node scripts/new-branch.mjs <prefix> <description-words...>

Prefixes:
  ${PREFIXES.join(" / ")}

Examples:
  node scripts/new-branch.mjs feat add-cause-support
  node scripts/new-branch.mjs fix headers-sent-leak
  node scripts/new-branch.mjs ci bump-action-versions

Options:
  -h, --help    Show this help
`;

main(async () => {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) usage(HELP);

  const [prefix, ...rest] = args;
  if (!PREFIXES.includes(prefix)) {
    log.fail(`Unknown prefix '${prefix}'. Use one of: ${PREFIXES.join(", ")}`);
    process.exit(1);
  }
  if (rest.length === 0) {
    log.fail("Please provide a description after the prefix.");
    process.exit(1);
  }

  const slug = rest
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const branch = `${prefix}/${slug}`;

  log.step(`Creating branch ${c.bold(branch)}`);

  if (!(await git.isClean())) {
    log.fail("Working tree has uncommitted changes. Commit or stash first.");
    process.exit(1);
  }

  log.info("Fetching origin...");
  await git.fetch();

  log.info("Switching to main and pulling latest...");
  await run("git", ["checkout", "main"]);
  await run("git", ["pull", "origin", "main", "--ff-only"]);

  log.info(`Creating ${branch}...`);
  await run("git", ["checkout", "-b", branch]);

  log.ok(`On branch ${c.bold(branch)} based on latest origin/main.`);
  console.log(`\nMake your changes, then:\n  ${c.cyan("git add .")}\n  ${c.cyan("git commit -m \"" + prefix + ": your message\"")}\n  ${c.cyan("git push -u origin " + branch)}`);
});
