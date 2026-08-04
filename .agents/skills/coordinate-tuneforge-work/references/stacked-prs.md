# Stacked Pull Requests

Use this reference only after the coordinator selects a two-to-four-layer stack
and the user authorizes branches, signed commits, pushes, and draft PRs.

GitHub stacked pull requests remain a public-preview feature. Require GitHub CLI
2.90 or newer, install the official `github/gh-stack` extension only with user
authority, and inspect live help before every stack operation:

```sh
gh --version
gh extension list
gh stack --help
gh stack link --help
gh stack rebase --help
gh stack push --help
```

References:

- [Public-preview announcement](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/)
- [Quickstart](https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart)
- [Stack behavior and repository rules](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)
- [CI behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/optimizing-ci-for-stacked-pull-requests)

## Design the Stack

Keep two to four independently reviewable layers. Prefer this order:

1. foundations, migrations, or generated contracts;
2. services, persistence, and orchestration;
3. UI and platform integration;
4. end-to-end wiring only when it is a distinct reviewable layer.

Every layer must keep the repository usable and have its own proportional tests.
Do not stack unrelated or merely parallel changes. Every PR receives applicable
base-branch rules and CI, so extra layers multiply review and runner cost.

Record for each layer: branch name, parent branch, owned files, interface change,
acceptance criteria, validation commands, and issue reference. Use repository
`type/brief-description` branch names and one signed commit per branch.

## Publish with Controlled PR Bodies

Create the dependency chain locally and register it with `gh stack`. Push the
tracked branches with `gh stack push`. Create every draft PR separately with a
Markdown body file so repository PR-body policy remains intact:

```sh
gh pr create --draft --base <parent> --head <layer> --title <title> --body-file <body.md>
```

The bottom PR targets `main`; each later PR targets the preceding branch. Every
body keeps concise `## Summary` and `## Testing` sections and references only the
issue actually addressed by that layer.

After all draft PRs exist, link their PR numbers or URLs in bottom-to-top order:

```sh
gh stack link <bottom-pr-url> <middle-pr-url> <top-pr-url>
```

Pass existing PR URLs or numbers so `gh stack link` does not create PRs. Do not
use `gh stack submit`: its generated or interactive bodies bypass the required
per-layer `--body-file` workflow.

## Amend and Cascade Review Fixes

Apply a review fix on the branch that owns the affected layer and amend that
branch's single signed commit. Then cascade it through dependent layers and
push the stack:

```sh
gh stack rebase --upstack
gh stack push
```

Re-run the owning layer's gates and every affected upper-layer integration gate.
Verify that each rebased branch still contains exactly one signed layer commit.
Use the original implementation worker for the single remediation pass and run
one focused re-review of changed areas.

Never merge automatically. `gh stack merge` requires a new explicit user
instruction after review and required checks are complete.
