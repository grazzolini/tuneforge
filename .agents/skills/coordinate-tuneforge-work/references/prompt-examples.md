# TuneForge Coordinator Prompt Examples

Start in Plan mode when you want the preflight and decision-complete plan to
pause for approval. Replace placeholders before sending. These initial prompts
intentionally authorize neither implementation nor publication.

## Known Issue

```text
Use $coordinate-tuneforge-work to plan #NNN.
```

## Milestone

```text
Use $coordinate-tuneforge-work to plan the next item in <milestone name>.
```

The skill selects the first open issue in the canonical `release-plan` tracker.

## Ad Hoc Implementation

```text
Use $coordinate-tuneforge-work to plan ad hoc: <short label>.

Outcome: <concrete change>. Acceptance: <observable result and validation>.
```

## Evidence-Based Research

```text
Use $coordinate-tuneforge-work to plan research for #NNN.

Question: <decision to support>. Report target: <where the evidence belongs>.
```

## Bug Exploration

```text
Use $coordinate-tuneforge-work to plan bug exploration for ad hoc: <symptom label>.

Symptom and evidence: <observed behavior and supporting evidence>.
```

## Release Preparation

```text
Use $coordinate-tuneforge-work to plan release prep for v1.1.0.
```

## User-Owned Post-Plan Paths

After reviewing and approving the plan, choose one path. Collaboration-mode
selection and transitions remain yours; the skill does not invoke commands or
change modes.

### Implement Locally

Tell Codex to implement the approved plan locally. It may implement, validate,
review, and remediate, but stops before branch creation, commit, push, PR or
issue updates, and merge.

### Continue Release Preparation

After the release-preparation PR is merged, continue the approved release plan
without granting signing or final-publication authority:

```text
Continue v1.1.0 release preparation with $coordinate-tuneforge-work. Pause
before the signed tag, draft release, Android release APK, and artifact signing
and upload. Do not sign artifacts or publish the final release.
```

### Optional Goal

Instead of choosing **Implement plan**, choose **Tell Codex to do something
different** and enter:

```text
/goal Implement the approved plan with $coordinate-tuneforge-work.
```

This has the same local-only boundary. Do not choose **Implement plan** after
starting the Goal.

### Later Publication

After local work is complete, authorize normal publication explicitly:

```text
Commit and publish the completed work as a draft PR. Do not merge.
```

This authorizes the required branch creation or switching, signed commit, push,
and draft PR. Merge still requires a separate instruction.

### Rare Stacked Publication

If the approved plan requires a true stack, grant stack publication authority
only after the plan is approved:

```text
Create the approved stack: create or switch branches, make signed commits,
push them, and open draft PRs. Do not merge.
```

Without that authority, the skill stops after the stack plan and never creates
a partial local stack.
