# Pipeline Radar

A clinical-trial landscape tool: search ClinicalTrials.gov by condition, see the
competitive drug/sponsor picture for an indication, and export or watch a slice
of it.

Built for the Blue Matter take-home. Milestones 1–5 are implemented, with an
AWS deployment path (Terraform + GitHub OIDC + S3/CloudFront + ECS Fargate).

## Quick start

One `npm ci` at the repo root installs all three workspaces.

```bash
npm ci

# API proxy (port 3001)
npm run dev -w pipeline-radar-api

# Frontend (port 5173, proxies /api -> 3001)
npm run dev -w pipeline-radar
```

Open http://localhost:5173.

## Tests

```bash
npm test                                # all three workspaces (126 tests)

npm test -w @pipeline-radar/shared      # 103 tests
npm test -w pipeline-radar              # 15 tests
npm test -w pipeline-radar-api          # 8 tests
```

## Layout

| Path | What |
|---|---|
| [shared/](shared/) | Pure trial/drug logic — imported by both the web app and the API. No DOM, no React |
| [pipeline-radar/](pipeline-radar/) | Vite + React + TypeScript frontend |
| [api/](api/) | Express proxy — CORS, shared TTL cache, retries |
| [terraform/](terraform/) | Infrastructure (app layer + one-time bootstrap layer) |
| [.github/workflows/](.github/workflows/) | CI on PRs, deploy on push to `main` |
| [research/](research/) | Data exploration notes and fixtures |
| [samples/](samples/) | Captured upstream API responses used in tests |

## Why an API proxy

The browser can't call ClinicalTrials.gov, openFDA, and RxNorm directly — CORS.
The proxy also gives one place to share an in-memory TTL cache (openFDA caps at
1k requests/day, so a shared cache matters), and one place for retries and
backoff.

## Architecture

One CloudFront distribution, two origins. Default behavior serves the Vite build
from a private S3 bucket via Origin Access Control; `/api/*` routes to an ALB in
front of a single 0.25 vCPU Fargate task. The frontend fetches relative
`/api/...`, so nothing environment-specific is baked into the bundle.

The ALB security group only admits CloudFront's managed origin-facing prefix
list, so the distribution is the only route in.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [CICD-PLAN.md](CICD-PLAN.md) for the
reasoning, trade-offs, and cost breakdown (~$26/mo).

## Deploying

The bootstrap layer is applied once by hand; everything after that runs through
GitHub Actions with OIDC — no AWS keys are stored anywhere.

```bash
cd terraform/bootstrap && terraform init && terraform apply
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(terraform output -raw deploy_role_arn)"
```

Then push to `main`. Full steps in [CICD-PLAN.md](CICD-PLAN.md).
