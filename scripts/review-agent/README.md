# Code review agent

A risk-gated auto-merge reviewer. After the `CI` workflow passes on a PR, a Claude
Code agent running on our **self-hosted Mac mini** judges the change's regression
risk and either **auto-squash-merges** it (low risk, not a new feature) or posts a
**"request changes"** review with a `needs-human-review` label.

## Pieces

| File | Role |
|------|------|
| `.github/workflows/code-review-agent.yml` | Trigger (`workflow_run` after CI success), guards, policy enforcement, merge/review actions. |
| `scripts/review-agent/prompt.md` | The reviewer's instructions + risk rubric + output schema. |
| `scripts/review-agent/run.sh` | Runs `claude -p` headless against the PR diff, emits a validated `verdict.json`. |

The agent only **reads** (diff + repo context) and writes `verdict.json`. The
workflow — always from the trusted default-branch checkout — enforces the gate and
performs the merge/review. PR-authored code is never executed.

## Auto-merge gate

Auto-merge happens only when **all** hold:

- `risk == "low"` **and** `is_new_feature == false` **and** `recommendation == "auto_merge"`
- CI is green (guaranteed by the `workflow_run` success trigger)
- PR is not a draft, base is `main`, and it has no `no-auto-merge` label

Add the **`no-auto-merge`** label to any PR to opt it out of automation.

## Self-hosted runner (Mac mini)

The workflow targets `runs-on: [self-hosted, macos, review-agent]`. The runner is
installed as a launchd service on the Mac mini under user `clivetrigify`, so it
auto-starts on boot and polls GitHub outbound (no inbound access needed).

Prerequisites on the Mac (already present): `claude`, `gh` (authenticated),
`node`, `git`, `jq`. The runner's minimal launchd PATH is extended inside the
scripts to reach `~/.local/bin` and `/opt/homebrew/bin`.

### Claude auth (required repo secret)

The agent authenticates from the **environment**, not the Mac's local login (that
expires and cannot refresh unattended). Set **one** repo secret:

- **`CLAUDE_CODE_OAUTH_TOKEN`** (preferred) — subscription-backed, no API billing.
  Generate once on a machine logged into your Claude subscription:
  ```bash
  claude setup-token          # prints a long-lived token
  gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo badapplesdotdev/gtm-grid
  ```
- **`ANTHROPIC_API_KEY`** — pay-per-token API billing. Simpler, but each PR review
  costs API credits.

The workflow injects whichever is set into the reviewer step; `claude` picks it up.

### Manage the runner

```bash
# status / logs
cd ~/actions-runner && ./svc.sh status

# stop / start / uninstall the service
./svc.sh stop
./svc.sh start
sudo ./svc.sh uninstall           # remove the launchd service

# fully deregister the runner from GitHub
./config.sh remove --token <removal-token>   # token from repo Settings → Actions → Runners
```

### Re-register from scratch

```bash
TOKEN=$(gh api -X POST repos/badapplesdotdev/gtm-grid/actions/runners/registration-token --jq .token)
cd ~/actions-runner
./config.sh --url https://github.com/badapplesdotdev/gtm-grid \
  --token "$TOKEN" --name macmini-review --labels self-hosted,macos,review-agent --unattended --replace
./svc.sh install && ./svc.sh start
```

## Tuning

- **Model:** `REVIEW_MODEL` env in the workflow (default `claude-opus-4-8`).
- **Diff cap:** `MAX_DIFF_BYTES` in `run.sh` (default 400 KB; oversized diffs lean
  toward human review).
- **Risk rubric:** edit `prompt.md`.
