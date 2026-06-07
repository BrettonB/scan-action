# BrettonB/scan-action — CanaryUsers UX check

> **Official CanaryUsers GitHub Action** — send the flock through every PR's preview deploy and get a UX score + top issues right in your CI.

## Usage

```yaml
# .github/workflows/ux-check.yml
name: UX Check

on:
  push:
    branches: [main]
  pull_request:

jobs:
  canary-ux:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy preview
        id: deploy
        # ... your existing deploy step ...
        # outputs: preview-url

      - name: CanaryUsers UX scan
        uses: BrettonB/scan-action@v1
        with:
          url: ${{ steps.deploy.outputs.preview-url }}
          token: ${{ secrets.CANARYUSERS_TOKEN }}
          fail-on: off          # or 'regression' to fail on critical issues
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | ✅ | — | The URL to scan (preview deploy URL) |
| `token` | ✅ | — | Your CanaryUsers API token ([get it here](https://www.canaryusers.ai/dashboard)) |
| `repo` | — | `${{ github.repository }}` | `owner/name` for first-run-free tracking |
| `fail-on` | — | `off` | `off` / `regression` / `score<NN` |
| `timeout-minutes` | — | `5` | Poll timeout |

## Outputs

| Output | Description |
|--------|-------------|
| `scan-id` | The scan job ID |
| `score` | CanaryScore 0–100 |
| `grade` | Letter grade A–F |
| `report-url` | Full interactive report URL |
| `free-run` | `true` if this was the free first-run for this repo |

## First run is free

The first CI scan per repo is free — no credits needed. After that, scans debit from your monthly allotment. When you're out, the check stays green with a "upgrade to keep the flock on your PRs" note (never a red failure).

## Getting your token

1. Sign in at [canaryusers.ai](https://www.canaryusers.ai)
2. Open your **Dashboard** → the **CI & API** section
3. Click **Generate token** and copy it (shown once)
4. Add it as `CANARYUSERS_TOKEN` in your repo's **Settings → Secrets and variables → Actions**
