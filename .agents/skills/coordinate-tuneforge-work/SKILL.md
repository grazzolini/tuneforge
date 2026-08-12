---
name: coordinate-tuneforge-work
description: Plan-first coordination for bounded TuneForge implementation or evidence-based research with local delivery by default. Use when selecting milestone work from a release-plan tracker, planning a known issue or ad hoc change, exploring a bug, or coordinating approved local execution, validation, and review; choose normal versus stacked delivery when relevant and publish only with later explicit authority.
---

# Coordinate TuneForge Work

Keep this chat coordinator-only and delegate work. Never alter installed-app
data or start, stop, restart, or wipe a user-owned desktop app.

## Lifecycle Contract

Use Plan-first as the core lifecycle:

1. Without an approved plan, perform read-only preflight and produce a
   decision-complete plan only.
2. After plan approval and explicit local execution authority, implement,
   validate, review, and remediate locally.
3. Stop before publication unless the user later explicitly authorizes it.

Collaboration mode selection and transitions are user-owned. Never invoke
`/plan` or `/goal`, change modes, or create or expand a Goal. A Goal is
optional and does not broaden execution or publication authority.

Read [prompt-examples.md](references/prompt-examples.md) for initial
Plan-first invocations and user-owned post-plan paths.

## Select Work Scope and Kind

Classify the **Work Scope** before preflight. Work Scope describes the source
of work; it is not a Codex collaboration mode.

- **Milestone:** Read the live milestone and its canonical `release-plan`
  tracker, then select the first open linked issue under `## Ordered work`.
- **Known issue:** Use the specified issue whether or not it has a milestone;
  never substitute another issue.
- **Ad hoc:** Build a brief with outcome, evidence, assumptions, acceptance
  criteria, and non-goals. Search live issues and PRs for overlap, but do not
  require or create an issue unless requested.

Identify the work as an issue number or `ad hoc: <short label>`, then classify
it as **implementation** or **research**. Implementation retains product code.
Research produces evidence and a recommendation; its product-code envelope is
zero. A research spike must be explicitly authorized, bounded, and disposable.
Reclassify and re-plan before retaining product code.

For a milestone, require exactly one open `release-plan` tracker. Parse links
under `## Ordered work` in order and select the first still-open linked issue,
excluding the tracker. If none remain, report refinement or release-handoff
readiness. If a legacy milestone lacks a tracker, use explicit issue-body order
and report that it has not adopted the canonical format.

## Read-Only Preflight and Plan

Before an approved plan, read applicable `AGENTS.md` files; inspect worktree
dirt, branch, and fresh `origin/main` relationship; run the scope's live issue
and PR checks; and classify affected surfaces and risks. Preserve user changes;
do not update or rebase without authority.

Produce a decision-complete plan containing:

- selected item, work kind, outcome, non-goals, and acceptance evidence;
- implementation envelope (modules, interfaces, line/file bounds) or research
  evidence envelope (question, sources, method, report target);
- normal-versus-stack decision, worker ownership/model/effort, validation lanes,
  review plan, and explicit stop boundary;
- assumptions, risks, and the exact authority still needed.

Read [validation-lanes.md](references/validation-lanes.md) before selecting
lanes or reporting evidence.

## Local Execution After Approval

Only after the user approves the plan and explicitly requests local execution,
delegate bounded implementation or research. Give workers the outcome,
non-goals, owned files or evidence, envelope, current evidence, validation
method, and stop-on-expansion instruction. Keep the coordinator out of edits.

Use one implementation or research worker by default. Use at most two only when
responsibilities and owned files or evidence streams are independent; assign
clear ownership. Use one implementation worker across dependent stack layers.

Select model and effort explicitly: Terra Medium for exploration; Terra High
for bounded implementation; Sol High for ambiguity, cross-layer architecture,
sync/concurrency, transactions, migrations, privacy/security/data-loss risk, or
ambiguous test failures. Use the contract guard only at an actual contract
boundary and Product Design only for UI work.

For implementation, treat production source as the scope tripwire, excluding
tests, generated files, and lockfiles. Stop and re-plan if work reaches an
unplanned module or interface, or production file count or changed lines exceed
twice the declared envelope. Do not expand into broad cleanup, speculative
hardening, or adjacent feature work. For research, define method, evidence
matrix, fixtures/datasets, licensing constraints, baseline, timebox, report
target, and recommendation criteria. A negative or defer conclusion can
complete research. Never retain research product code without reclassification
and a new approved plan. Research follows the same Plan-first contract and
remains unpublished by default.

## Delivery Shape and Publication Boundary

Use one normal PR by default. Choose a stack only for two to four genuinely
dependent, independently reviewable layers that keep the repository usable and
materially improve review. Independent changes are not a stack.

If a true stack is required, stop after the plan until explicit stack
publication authority covers branch creation or switching, signed commits,
pushes, and draft PRs. A stack needs its layer branches and signed commits;
never create a partial local stack. Read
[stacked-prs.md](references/stacked-prs.md) before stack publication.

For normal work, also stop before branch creation, commit, push, PR or issue
updates, or merge by default. A later explicit request such as “Commit and
publish the completed work as a draft PR. Do not merge.” authorizes the required
branch, signed-commit, push, and draft-PR actions. It never authorizes merge;
merge needs a separate instruction.

## Validate, Review, and Finish

Run only applicable validation lanes and report command, result, proof boundary,
and unverified behavior. Never treat a local validator, emulator, or mock as
proof of live transport, external-device, or release behavior.

Use one initial correctness review for implementation or one evidence review for
research. Evidence review must check methodology, reproducibility, unsupported
generalization, licensing, and evidence-to-conclusion fit. Add contract and
Product Design review only when applicable. Route reviews to Sol High normally,
Sol XHigh only for declared high risk, and Sol Max only for a focused unresolved
critical dispute. Send actionable findings to the original worker for one
remediation pass, then perform one focused re-review. Stop on unresolved
critical findings.

Finish with the selected scope, work kind, delivery/report target, envelope,
agents and lanes used, validation/evidence, unverified boundaries, remaining
risks, and local worktree or stack status. Stop at the exact authorized boundary;
never merge automatically.
