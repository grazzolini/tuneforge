## Summary

<!-- One or two sentences describing what this PR changes. -->

## Motivation

<!-- Why is this change needed? Link issues with "Fixes #123" or "Refs #123". -->

## Changes

<!-- Bullet list of notable changes. Skip the obvious. -->

-
-

## Test Plan

<!-- How did you verify this change? Commands run, scenarios exercised, audio files used. -->

-

## Screenshots / Recordings

<!-- For UI changes only. Drag and drop images or attach a short clip. Delete this section otherwise. -->

## Checklist

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat(backend): add chord smoothing window`) — it becomes the squash commit message on `main`
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (desktop + backend)
- [ ] If backend routes or schemas changed, ran `pnpm contracts:generate` and committed the result
- [ ] Updated relevant docs (README, backend README, THIRD_PARTY_NOTICES) if behavior changed
- [ ] No secrets, credentials, or copyrighted audio added to the repository
