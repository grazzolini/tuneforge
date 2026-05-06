// @ts-check

/**
 * Commitlint configuration for PR titles.
 *
 * PR titles become the squash commit subject on `main`, so they should
 * follow the same Conventional Commit subject rules as normal commits.
 * They are intentionally single-line, so the commit-body requirement is
 * disabled here.
 */
module.exports = {
  extends: ["./commitlint.config.cjs"],
  rules: {
    "body-empty": [0, "never"],
  },
};
