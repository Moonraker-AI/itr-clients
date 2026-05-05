# Prod deploy gate

Tag-triggered prod deploys (`git push origin v*`) now pause for manual
approval before any step runs. The gate is enforced by the GitHub
`prod` Environment configured to require a reviewer.

## One-time setup

Create the `prod` environment + add yourself as the required reviewer.
The GitHub API requires `wait_timer` as integer and `deployment_branch_policy`
as object/null, which `gh api`'s `-F`/`-f` flags can't express directly —
pipe a raw JSON body via `--input -` instead:

```bash
USER_ID=$(gh api user --jq '.id')

echo "{\"reviewers\":[{\"type\":\"User\",\"id\":$USER_ID}],\"wait_timer\":0,\"deployment_branch_policy\":null}" | \
  gh api -X PUT repos/Moonraker-AI/itr-clients/environments/prod --input -

# Verify
gh api repos/Moonraker-AI/itr-clients/environments/prod \
  --jq '.protection_rules[0].reviewers[0].reviewer.login'
```

The verify command should print your GitHub login (e.g. `Chris-Morin`).
That confirms the environment exists and you are the required reviewer.

## Approve a prod deploy

After pushing a tag:

```bash
git tag v0.9.x
git push origin v0.9.x
```

The deploy workflow runs and pauses immediately at "Awaiting approval".

Approve via UI: GitHub → Actions → the workflow run → click **Review
deployments** → check `prod` → **Approve and deploy**.

Approve via CLI:

```bash
RUN_ID=$(gh run list --workflow=deploy.yml --limit 1 --json databaseId -q '.[].databaseId')
gh run view "$RUN_ID" --json jobs --jq '.jobs[0].databaseId'
# Approve in UI is currently the only stable path for environment gates;
# `gh run` does not expose an approve subcommand. Open the link printed
# by `gh run view --web $RUN_ID`.
```

## Reject

If the dev deploy looks bad and you don't want prod, click **Reject** in
the same UI. The workflow run completes with status `failure` and no
prod deploy happens. The tag stays in git — re-push or re-trigger via
`workflow_dispatch` if you fix forward.

## Adjust the gate

- **Add a wait timer** (delay even after approval) — useful for "soak"
  windows on dev:

  ```bash
  gh api -X PUT repos/Moonraker-AI/itr-clients/environments/prod \
    -F wait_timer=30   # minutes
  ```

- **Restrict which branches can deploy to prod** (e.g., only tags from main):

  ```bash
  gh api -X PUT repos/Moonraker-AI/itr-clients/environments/prod \
    -F 'deployment_branch_policy[protected_branches]=true' \
    -F 'deployment_branch_policy[custom_branch_policies]=false'
  ```

- **Remove the gate** (revert to auto-deploy on tag):

  ```bash
  gh api -X DELETE repos/Moonraker-AI/itr-clients/environments/prod
  ```

  And drop the `environment:` line from `.github/workflows/deploy.yml`.

## What the gate doesn't cover

- Push to main still auto-deploys to dev with no gate. Intentional —
  dev is the smoke target.
- Cron-triggered Cloud Run jobs (state-transitions, retry-failed-charges)
  are not in this workflow's scope.
- Direct `gcloud run deploy` from a developer laptop bypasses everything.
  Don't do that.
