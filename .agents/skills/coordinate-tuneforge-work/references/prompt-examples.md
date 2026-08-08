# TuneForge Coordinator Prompt Examples

Replace `#NNN`, the milestone name, or `ad hoc: <short label>` before sending. Select Plan mode first when
the preflight and execution plan should pause for approval.

## Full Issue Delivery

```text
Use $coordinate-tuneforge-work for #NNN.

Carry the issue through bounded implementation, applicable validation, review,
and publication. Decide whether this should use one normal PR or a small stacked
PR series using the skill's delivery-shape criteria.

I authorize branch creation and switching, signed commits, pushes, and draft
PR creation for whichever shape you select. Do not merge.
```

## Milestone Delivery

```text
Use $coordinate-tuneforge-work.

Continue the <milestone name> milestone. Select the first open issue from the
canonical release-plan tracker.

Carry it through bounded implementation, applicable validation, review, and
publication. Decide whether the work needs one normal PR or a small stacked PR
series.

I authorize branch creation and switching, signed commits, pushes, and draft
PR creation for whichever shape you select. Do not merge.
```

## Local-Only Implementation

```text
Use $coordinate-tuneforge-work for #NNN.

Implement and validate the issue locally. Decide the appropriate delivery shape.

If one normal PR is appropriate, complete local implementation and stop before
branch creation, commit, push, or PR.

If a stack is required, stop after presenting the layer plan because publication
authority is not granted.
```

## Short Full Delivery

```text
Use $coordinate-tuneforge-work for #NNN.

Decide normal versus stacked delivery. Implement, validate, review, and publish.
I authorize branches, signed commits, pushes, and draft PRs. Do not merge.
```

## Plan Only

```text
Use $coordinate-tuneforge-work for #NNN.

Prepare the preflight, delivery shape, worker ownership, validation lanes, and
review plan. Stop before implementation or publication.
```

## Evidence-Based Research

```text
Use $coordinate-tuneforge-work for #NNN.

Treat this as evidence-based research. Define the question, method, evidence
matrix, fixtures or datasets, licensing constraints, baseline, timebox, report
target, and recommendation criteria. Produce evidence and a recommendation.

Do not retain product code or publish GitHub state unless I separately authorize
it. A supported negative or defer recommendation is acceptable.
```

## Ad Hoc Small Change

```text
Use $coordinate-tuneforge-work for ad hoc: <short label>.

Outcome: <concrete change>. Acceptance: <observable result and validation>.
Search live issues and PRs for overlap, but do not require or create an issue.
Decide normal PR versus stack under the skill's criteria. Implement, validate,
review, and publish the retained change.
I authorize branch creation and switching, signed commits, pushes, and draft PR
creation. Do not merge.
```

## Ad Hoc Bug Exploration

```text
Use $coordinate-tuneforge-work for ad hoc: <short symptom label>.

Symptom and evidence: <observed behavior and supporting evidence>.
Attempt reproduction. Identify a likely cause only when evidence supports one;
an inconclusive result is acceptable. Report attempted methods, evidence,
remaining hypotheses, and a recommended next step. Search live issues and PRs
for overlap, but do not require or create an issue.
Treat this as research-only: report in this chat. Do not retain product code or
publish to GitHub. If a fix should follow, reclassify and re-plan before editing.
```

## Plan First, Then Start a Goal

Enter Plan mode and send the full-delivery or milestone prompt above. Review and
refine the resulting plan. Instead of choosing **Implement plan**, choose
**Tell Codex to do something different** and enter:

```text
/goal Use $coordinate-tuneforge-work to deliver #NNN according to the approved plan. Carry it through bounded implementation, applicable validation, review, and authorized draft PR publication. Do not merge or advance to another release-plan item.
```

The goal command starts execution; do not choose **Implement plan** afterward.
The same task retains the approved plan and the publication authority from the
original delivery prompt.
