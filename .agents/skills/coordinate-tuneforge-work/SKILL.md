---
name: coordinate-tuneforge-work
description: Plan-first coordination for bounded TuneForge implementation, evidence-based research, or release preparation with local delivery by default. Use when selecting milestone work from a release-plan tracker, planning a known issue or ad hoc change, exploring a bug, preparing a versioned release and its approval-gated artifacts, or coordinating approved execution, validation, and review; choose normal versus stacked delivery when relevant and publish only with later explicit authority.
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

Release preparation adds four narrower stop boundaries. Read
[release-prep.md](references/release-prep.md) before planning or continuing any
release-preparation work. Authority for one checkpoint never carries into the
next checkpoint or authorizes final publication.

Run generated artifact or evidence gates only after the checkpoint that creates
the tagged artifacts they inspect. Never require build-generated evidence
before the tag and build identity exist. Those gates still fail closed before
signing, upload, or publication.

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
- **Release preparation:** Use the specified version and release tracker. Plan
  the metadata-preparation PR and the later approval-gated tag, draft release,
  artifact build, signing, upload, verification, and closure workflow. Follow
  [release-prep.md](references/release-prep.md).

For milestone, known-issue, and ad-hoc work, identify the work as an issue
number or `ad hoc: <short label>`, then classify it as **implementation** or
**research**. Implementation retains product code. Research produces evidence
and a recommendation; its product-code envelope is zero. A research spike must
be explicitly authorized, bounded, and disposable. Reclassify and re-plan
before retaining product code. Identify release preparation by version and
tracker; do not substitute another release.

For a milestone, require exactly one open `release-plan` tracker. Parse links
under `## Ordered work` in order and select the first still-open linked issue,
excluding the tracker. If none remain, report refinement or release-handoff
readiness. If a legacy milestone lacks a tracker, use explicit issue-body order
and report that it has not adopted the canonical format.

## Agent Role Routing

Use the exact callable names in [`.codex/agents`](../../../.codex/agents).

- `source_lookup` for bounded lookup, extraction, and summarization from explicit
  sources.
- `researcher` for broader exploration, comparisons, and bounded research.
- `technical_investigator` for ambiguous failures or findings, complex probes,
  and benchmark attribution.
- `implementer` for approved changes, applicable Product Design briefs,
  implementation, release metadata, and bounded remediation.
- `document_drafter` for reports and written artifacts.
- `interaction_verifier` for bounded browser, computer, or visual flows.
- `visual_qa` for detailed screenshot, video, and release-media verification.
- `routine_reviewer` for routine correctness, evidence, or release-safety review.
- `risk_reviewer` for security, data loss, migrations, concurrency, or complex
  cross-layer correctness, evidence, or release-safety review.
- `design_reviewer` for independent design and UX judgment.
- `tuneforge_contract_guard` for actual API, schema, OpenAPI, generated-type, or
  caller boundaries.
- `critical_dispute_reviewer` for a focused, unresolved critical finding after
  ordinary review.

Use a fresh fork (`fork_turns="none"`) and a self-contained brief covering
duties, authority limits, independence, and evidence criteria. Include the
current release checkpoint when applicable. Invoke a registered role by its
exact name and use its TOML settings without overrides.

Use fallbacks only before work starts.

- If the role is missing from the session, use a fresh built-in `default` fork
  and explicitly request the role's TOML model and reasoning effort when supported.
- If either the named role or its `default` fallback cannot use the pinned
  settings or start the pinned model, the coordinator selects a suitable
  available model and reasoning effort for a fresh `default` fork.

Carry the original brief into each fallback and report why it was needed and
the model and effort actually used. Once work starts, recover the original
assignment and avoid duplicate work.
Change agent configuration only when explicitly requested.

## Read-Only Preflight and Plan

Before an approved plan, read applicable `AGENTS.md` files; inspect worktree
dirt, branch, and fresh `origin/main` relationship; run the scope's live issue
and PR checks; and classify affected surfaces and risks. Preserve user changes;
do not update or rebase without authority.

Consult relevant [TODO.md](../../../TODO.md) notes when planning; update or remove
them when resolved. GitHub owns status, priority, scheduling, and release ordering.
Notes do not authorize more work or external updates. Keep new GitHub issue numbers
and URLs out of code comments, identifiers, and test names; use behavior-based names
and repository documentation references. Issues may link to code and docs may link
to issues. Apply this prospectively; do not clean up old references.

Produce a decision-complete plan containing:

- selected item, work kind, outcome, non-goals, and acceptance evidence;
- implementation envelope (modules, interfaces, line/file bounds) or research
  evidence envelope (question, sources, method, report target);
- normal-versus-stack decision, agent roles, worker ownership, resolved model and
  reasoning effort, validation lanes, review plan, and explicit stop boundary;
- assumptions, risks, and the exact authority still needed.

Use [agent role routing](#agent-role-routing) to plan assignments. Read each
selected role's TOML for the model and reasoning effort to record in the plan.
Read [validation-lanes.md](references/validation-lanes.md) before selecting lanes
or reporting evidence.

Before implementation assignments, run `pnpm ci:image:impact --paths <planned paths...>`
and include affected components, causal chain, and delivery order in the plan.
Use the canonical [CI image inventory](../../../.github/ci/image-inputs.json) and
[delivery guidance](../../../.github/ci/README.md#mandatory-image-impact-preflight);
do not maintain a second dependency graph in this skill. Recheck expanded scope
before edits. Before publication, rerun the assessment against fresh main with
`pnpm ci:image:impact --working-tree <fresh-main>` (includes staged/untracked paths).
Producer changes require merged-main publication and verified digest promotion
before dependent consumers; assessment never grants publication authority.

## Local Execution After Approval

Only after the user approves the plan and explicitly requests local execution,
delegate bounded implementation, research, or release-preparation work. Give
workers the outcome, non-goals, owned files or evidence, envelope, current
evidence, validation method, and stop-on-expansion instruction. Keep the
coordinator out of edits.

Use one implementation, research, or release-preparation worker by default.
Use at most two only when responsibilities and owned files or evidence streams
are independent; assign clear ownership. Use one implementation worker across
dependent stack layers.

For UI design work, follow the [UI validation lane](references/validation-lanes.md#ui-and-user-facing-behavior)
for design, implementation, verification, and independent review responsibilities.

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

Select one initial reviewer by risk using [agent role routing](#agent-role-routing).
Use a correctness review for implementation, an evidence review for research, or
a release-safety review for release preparation. Evidence review must check
methodology, reproducibility, unsupported generalization, licensing, and
evidence-to-conclusion fit. Release-safety review
must check the exact platform payload/checksum/signature matrix, provenance,
checkpoint authority, manual-only operations, and fail-closed gates. Add
contract review and independent design review only when applicable. Send
actionable findings to the original worker for one remediation pass, then
perform one focused re-review. Stop on unresolved critical findings.

Finish with the selected scope, work kind, delivery/report target, envelope,
agents and lanes used, validation/evidence, unverified boundaries, remaining
risks, and local worktree or stack status. Stop at the exact authorized boundary;
never merge automatically.
