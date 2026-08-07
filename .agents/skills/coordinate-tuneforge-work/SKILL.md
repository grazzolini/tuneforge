---
name: coordinate-tuneforge-work
description: Coordinate bounded TuneForge implementation or evidence-based research without editing in the coordinator. Use for selecting the next issue from a canonical release-plan tracker, delivering a known issue, or carrying an ad hoc change or research question through scoped delegation, proportionate validation and review, single-versus-stacked PR planning when code changes are authorized, and one bounded remediation cycle; never create or update GitHub planning state unless requested, and require separate publication authority.
---

# Coordinate TuneForge Work

Keep this chat coordinator-only and delegate work. Never alter
installed-app data or start, stop, restart, or wipe a user-owned desktop app.
Do not create a branch, commit, push, open a PR, or merge unless the user grants
the corresponding authority.

Read [prompt-examples.md](references/prompt-examples.md) when the user asks for
a copyable invocation or a Plan-to-Goal workflow.

## Select Entry Mode and Work Kind

Classify the request before preflight:

- **Milestone:** Read the live milestone and its canonical `release-plan`
  tracker, then select the first open linked issue under `## Ordered work`.
- **Known issue:** Deliver the specified issue whether or not it has a
  milestone. Do not substitute a different issue.
- **Ad hoc:** Build a local brief with outcome, evidence, assumptions,
  acceptance criteria, and non-goals. Search live issues and PRs for overlap,
  but do not require or create an issue unless requested.

Identify the work item as an issue number or `ad hoc: <short label>`.

After selecting it, classify **implementation** or **research**. Implementation
delivers or retains product code. Research produces evidence and a
recommendation; its product-code envelope is zero. Research may use only an
explicitly authorized bounded, disposable spike or report artifact; never
retain or publish spike output as product code. If it should remain product
code, reclassify as implementation and re-plan before editing.

### Read Canonical Milestone Order

1. Fetch the milestone, open issues, and relevant PRs live.
2. Find the open issue labeled `release-plan` assigned to that milestone.
3. Require exactly one tracker. If more than one exists, stop for refinement.
4. Parse issue links under the tracker's `## Ordered work` heading in document
   order. Select the first linked issue that is still open; do not select the
   tracker itself.
5. If no linked issue remains open, report that the milestone is ready for
   refinement or release handoff. Do not invent work or publish a release.

If a legacy milestone has no `release-plan` tracker, use its explicit issue-body
ordering and report that the milestone has not adopted the canonical tracker
format. A tracker always overrides legacy ordering.

## Preflight

Before confirming a work item or spawning an agent:

1. Read every applicable `AGENTS.md` and scoped instruction file.
2. Verify worktree dirt, branch, and relationship to freshly fetched
   `origin/main`. Preserve user changes. Update or rebase only with authority
   and a safe worktree.
3. Run the selected entry mode's live issue and PR checks.
4. Classify affected surfaces and risk: UI, contracts, Android runtime,
   sync/transport, manual or hardware validation, privacy/security/data loss,
   migration/transaction/concurrency, and cross-layer architecture.
5. State either an implementation envelope (owned modules, production file and
   line bounds, allowed interfaces, non-goals, lanes, delivery shape) or a
   research evidence envelope (question, sources or datasets, non-goals,
   lanes, report target), plus worker model and effort.

Skill preflight is independent of Codex mode. In Plan mode, stop after
preflight and plan. In Goal mode, bind work to exactly one selected item and
the authorized publication boundary; never auto-advance a release-plan item or
create or expand a goal implicitly.

Read [validation-lanes.md](references/validation-lanes.md) before selecting
lanes or reporting evidence.

## Research Workflow

For research, define question, method and evidence matrix, fixtures or
datasets, legal/licensing constraints, environment or hardware baseline,
timebox, report target, and recommendation criteria before delegation. A
negative or defer conclusion completes the work when evidence supports it.
Do not require a PR or stack when no repository change is authorized. GitHub
publication or issue closure still requires explicit authority.

## Choose One PR or a Stack

Apply this section when work includes repository changes; publication authority
still governs branches, commits, pushes, and PRs.

Use a normal single PR by default.

Choose a stack only when a large feature or rewrite has all of these traits:

- two to four dependency-ordered layers;
- each layer is independently reviewable and keeps the repository usable;
- later layers genuinely depend on earlier layers;
- separating layers materially improves review.

Order stack layers foundations or contracts first, services and orchestration
next, and UI or end-to-end integration last. Independent changes are not a
stack; use one PR or separately deliverable PRs instead. Keep stacks small
because repository rules and CI apply to every layer.

Before starting stacked implementation, obtain explicit authority for all four
actions: create or switch branches, create signed commits, push branches, and
open draft PRs. If any authority is missing, stop after presenting the proposed
layers and validation plan. Do not create a partial local stack.

Use one implementation worker across dependent stack layers so ownership and
rebases stay coherent. Use repository branch names and one signed commit per
branch. Read [stacked-prs.md](references/stacked-prs.md) before creating or
updating any stack. Never merge automatically.

## Delegate Deliberately

Select model and effort explicitly before every spawn. Use one implementation
or research worker by default. Use at most two only when responsibilities and
files or evidence streams are independent; assign clear ownership. Keep the
coordinator out of edits.

- Use `gpt-5.6-terra` at Medium for exploration and read-heavy investigation.
- Use `gpt-5.6-terra` at High for bounded implementation.
- Use `gpt-5.6-sol` at High for ambiguity, cross-layer architecture,
  sync/concurrency, transactions, migrations, privacy/security/data-loss risk,
  or ambiguous test failures.
- Use Product Design on Sol High only for UI or user-facing work: produce a
  concise brief before implementation and final UX QA afterward.
- Use `tuneforge_contract_guard` on Terra High only when a contract boundary
  may change. Ask only for actual schema, OpenAPI, generated-type, or caller
  drift.

For UI work, put user goals, mode boundaries, truthfulness rules, screens,
states, interaction model, and UX acceptance criteria in the worker prompt.
Give every worker the outcome, non-goals, owned files or evidence sources,
change envelope, current evidence, validation commands or method, delivery
target, and an instruction to stop on scope expansion. For research, include
the question, evidence matrix, reproducibility baseline, licensing limits,
timebox, and recommendation criteria.

## Control Growth

For implementation, treat production source as the tripwire. Exclude tests,
generated files, and lockfiles from the estimate. Stop and re-plan when either
condition occurs:

- work reaches an unplanned module or interface;
- production file count or changed lines exceed twice the declared envelope.

Do not turn findings into broad cleanup, speculative hardening, or adjacent
feature work.

For research, stop and re-plan before any product-code change. Keep an
authorized spike bounded and disposable; reclassify and re-plan before editing
anything intended to remain as product code.

## Validate and Review

Run only applicable validation lanes. Report command, result, proof boundary,
and unverified behavior. Never present a local validator, emulator, or mock as
proof of live transport, external-device behavior, or release behavior.

Use one initial correctness review for implementation, or one evidence review
for research covering methodology, reproducibility, unsupported generalization,
licensing, and evidence-to-conclusion fit. Add contract and Product Design
reviews only when their lanes apply. Route normal reviews to Sol High, declared
high risk to Sol XHigh, and a focused unresolved critical dispute only to Sol
Max.

Require actionable correctness, evidence-quality, regression, security,
data-loss, contract, or necessary-test findings. Send valid findings to the
original worker for one remediation pass, then run one focused re-review of
changed areas or evidence. For a stack, amend the owning layer and cascade the
update through every dependent layer. Stop if a critical finding remains
unresolved.

## Finish

Summarize the issue or ad hoc label, work kind, delivery or report target,
change envelope, agents and lanes used, validation or evidence results,
unverified boundaries, remaining risks, and worktree or stack status when
applicable. Stop at the exact publication boundary authorized by the user.
Never merge automatically.
