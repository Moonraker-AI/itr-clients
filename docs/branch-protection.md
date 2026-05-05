# Branch protection — main

## Current state (snapshot)

```
required_status_checks:        ["deploy"], strict
required_pull_request_reviews: count 0, dismiss stale = yes
required_linear_history:       on
required_conversation_resolution: on
allow_force_pushes:            off
allow_deletions:               off
enforce_admins:                OFF  ← bypass mechanism
```

`enforce_admins=false` is why every direct push to main shows
**"Bypassed rule violations"** in the gh CLI output. Admins (you) skip the
required checks + PR rule. The protection is theatre for non-admins only.

## Fix

Enable admin enforcement so the rules apply to everyone, including the
account that owns the repo:

```bash
# One-liner to enforce admins
gh api -X POST repos/Moonraker-AI/itr-clients/branches/main/protection/enforce_admins

# Verify
gh api repos/Moonraker-AI/itr-clients/branches/main/protection \
  --jq '.enforce_admins.enabled'
# → true
```

To turn it back off (for an emergency hotfix):

```bash
gh api -X DELETE repos/Moonraker-AI/itr-clients/branches/main/protection/enforce_admins
```

## After enabling

- Every change to main must go through a PR — including agent-generated
  commits. The Claude Code workflow becomes:
  1. `git checkout -b feat/foo`
  2. commit + `git push -u origin feat/foo`
  3. `gh pr create --fill` (or `--title/--body`)
  4. Wait for `deploy` check to go green
  5. Self-approve the PR if `required_approving_review_count > 0`
  6. `gh pr merge --squash --auto` (auto-merges once checks pass)
- Tagging for prod deploy still works the same way — `git tag v* && git push origin v*` from main after the PR merges.
- Hotfix path: delete the `enforce_admins` rule (one curl), push the fix, re-enable.

## Optional: require a reviewer

You're solo right now. When the team grows, raise the review threshold:

```bash
gh api -X PATCH repos/Moonraker-AI/itr-clients/branches/main/protection \
  -F required_pull_request_reviews[required_approving_review_count]=1
```

## Why this matters

- Tests gate deploys (added in v0.9.6) but only if the deploy workflow
  actually runs. Direct pushes from admins bypass the required-check
  enforcement and can ship even if tests would fail.
- Audit trail: PRs leave a richer record (description, review comments,
  linked issues) than a string of direct commits to main.
- Forces a `npm test` + `npm run typecheck` to pass before any deploy
  rather than discovering a regression in the prod build log.

## Trade-off

- Slower iteration loop. Every change now requires push-branch + open-PR
  + wait-for-checks instead of one `git push origin main`.
- For a single-developer codebase, the value is mostly the **test gate**
  + audit trail. The review protocol can be left at 0 reviewers until a
  second engineer joins.
