// @ts-check

/**
 * Commitlint configuration.
 *
 * Enforces Conventional Commits on every commit and on PR titles
 * (since `main` uses squash merges, the PR title becomes the squash
 * commit message). Keep types in sync with what auto-labelling and
 * any future semantic-release config expect.
 *
 * Allowed types:
 *   feat      new user-facing feature
 *   fix       bug fix
 *   perf      performance improvement
 *   refactor  internal change, no behavior change
 *   docs      documentation only
 *   test      tests only
 *   build     build system, packaging, dependencies
 *   ci        CI/CD config
 *   chore     other maintenance (no production code change)
 *   revert    revert of a previous commit
 *
 * Optional scope examples: backend, desktop, shared-types, ci, docs,
 * deps, alembic, demucs, ffmpeg.
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "perf",
        "refactor",
        "docs",
        "test",
        "build",
        "ci",
        "chore",
        "revert",
      ],
    ],
    "subject-case": [
      2,
      "never",
      ["start-case", "pascal-case", "upper-case"],
    ],
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [1, "always", 100],
  },
};
