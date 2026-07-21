---
name: coordinate-tuneforge-work
description: Coordinate bounded TuneForge work without implementing in the coordinator. Use for selecting the next milestone issue from issue-body order, delivering any known TuneForge issue whether or not it has a milestone, or carrying an ad hoc idea, bug, investigation, or change with no GitHub issue through scoped delegation, conditional product/contract/mobile/sync validation, and one bounded remediation cycle; never create or update a GitHub issue unless requested, and stop before commit, push, or PR unless later explicitly authorized.
---

# Coordinate TuneForge Work

Keep this chat coordinator-only. Delegate code changes to workers. Never alter
installed-app data or start, stop, restart, or wipe a user-owned desktop app.
Do not commit, push, or open a PR unless separately authorized.

## Select Entry Mode

Classify the request before preflight:

- **Milestone:** Select the next issue from live issue-body ordering and verify
  prior issue and PR coverage.
- **Known issue:** Deliver the specified issue whether or not GitHub assigns it
  to a milestone. Do not substitute a different issue.
- **Ad hoc:** Turn the request into a local work brief with outcome, current
  evidence and assumptions, acceptance criteria, and non-goals. Search live
  issues and PRs only for overlap. Do not require, create, or update a GitHub
  issue unless the user requests it; lack of an issue does not block otherwise
  concrete work.

Identify the work item as an issue number or `ad hoc: <short label>`.

## Preflight

Before confirming a work item or spawning an agent:

1. Read every applicable `AGENTS.md` and scoped instruction file.
2. Verify the current worktree, its dirt, branch, and relationship to freshly
   fetched `origin/main`. Do not overwrite user changes. Rebase, merge, or
   otherwise update only when the request authorizes it and the worktree is safe.
3. Perform the selected mode's live issue and PR checks. For milestone mode,
   treat issue-body order as authoritative. For known-issue mode, read the issue
   body and current state. For ad hoc mode, report material overlap without
   silently changing the requested outcome.
4. Classify affected surfaces and risk before delegation: UI, contracts,
   Android runtime, sync/transport, manual or hardware validation,
   privacy/security/data-loss, migration/transaction/concurrency, and
   cross-layer architecture.
5. State a short work plan and change envelope: owned modules, expected
   production file count, upper-bound production changed lines, allowed
   interface changes, non-goals, validation lanes, and worker model/effort.

Read [validation-lanes.md](references/validation-lanes.md) before selecting
lanes or reporting validation evidence.

## Delegate Deliberately

Select a model and effort explicitly before every spawn. Use one implementation
worker by default. Use at most two only when responsibilities and files are
independent; assign each worker clear ownership. Keep coordinator out of edits.

- Use `gpt-5.6-terra` at Medium for exploration and read-heavy investigation.
- Use `gpt-5.6-terra` at High for bounded implementation.
- Use `gpt-5.6-sol` at High for ambiguity, cross-cutting architecture,
  sync/concurrency, transactions, migrations, privacy/security/data-loss risk,
  or ambiguous test failures.
- Use Product Design on Sol High only for UI or user-facing work: first produce
  a concise brief, then final UX/product QA. Product Design does not review
  code correctness, music-theory math, or backend contracts.
- Use `tuneforge_contract_guard` on Terra High only when a contract boundary may
  change. Ask only for actual schema, OpenAPI, generated-type, or caller drift.

For UI work, incorporate the brief into the plan and worker prompt: user goals,
mode boundaries, truthfulness rules, core screens/states, interaction model,
and UX acceptance criteria. For non-UI work, reference relevant guidance but do
not block delivery on a design lane.

Give every worker: work outcome and non-goals; owned files/modules; the change
envelope; current evidence; explicit validation commands; and an instruction to
stop and report scope expansion instead of silently broadening work.

## Control Growth

Treat production source as the tripwire. Exclude tests, generated files, and
lockfiles from the estimate. Stop implementation and re-plan before more edits
when either condition occurs:

- A change reaches an unplanned module or interface surface.
- Production file count exceeds twice the declared count.
- Production changed lines exceed twice the declared upper bound.

Do not convert validation findings into broad cleanup, refactors, speculative
hardening, or adjacent feature work.

## Validate and Review

Run only applicable validation lanes. Report commands, results, and exact proof
boundaries. Never represent a local validator, emulator result, or mocked path
as proof of live transport, external-device behavior, or user-visible release
behavior.

Use one initial correctness review. Add contract and Product Design reviews only
when their lanes apply. Reviewer routing:

- Sol High normally.
- Sol XHigh only for declared high risk.
- Sol Max only for focused adjudication of an unresolved critical finding.

Require actionable findings: correctness, regression, security, data loss,
contract drift, or missing necessary tests. Exclude style-only findings and
speculative hardening from remediation.

If a valid finding remains, send it to the original implementation worker for
one remediation pass. Then run one focused re-review of changed areas. If a
critical finding remains disputed or unresolved, request one read-only Sol Max
adjudication; make no further automatic edits. Stop and present the evidence,
decision, and any required user choice.

## Finish

Summarize the issue number or ad hoc label, change envelope, agents and lanes
used, validation results, unverified boundaries, remaining risks, and worktree
status. Stop before commit, push, or PR unless a later user request explicitly
authorizes it.
