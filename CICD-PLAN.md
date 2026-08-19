# Pipeline Radar — AWS CI/CD Plan (Terraform + GitHub OIDC + S3/CloudFront + ECS Fargate)

> **Status (2026-08-19, branch `feature/aws-cicd`):** steps 1, 2, 4 and 5 are
> implemented — `api/` proxy (8 jest tests, verified end-to-end locally through
> the Vite dev proxy against the live registry), `terraform/` (two layers,
> `validate` clean with no AWS creds), `ci.yml` + `deploy.yml`. Remaining:
> step 3, the one-time manual bootstrap — `terraform -chdir=terraform/bootstrap
> apply`, set the output ARN as the `AWS_DEPLOY_ROLE_ARN` repo variable, first
> manual `terraform apply` — and merging the milestone branches into `main`.
>
> Migrated from AWS CDK to Terraform on 2026-08-19.

## Target architecture

```
GitHub (push to main)
  └─ GitHub Actions ──OIDC──> AWS deploy role ──> terraform apply
                                                    │
        ┌───────────────────────────────────────────┴──────────────┐
        ▼                                                          ▼
  web.tf                                                     alb.tf + ecs.tf
  S3 (private) ◄─OAC─ CloudFront ─── /api/* behavior ───► ALB ─► ECS Fargate
  (Vite dist/)        (default *)                              (Node proxy,
                                                                ECR image)
                                                                  │
                                              ClinicalTrials.gov, openFDA, RxNorm
```

- **Frontend**: Vite build output in a private S3 bucket, served through CloudFront
  with Origin Access Control. SPA routing: 403/404 → `/index.html` (200).
- **API proxy** (new `api/` service, Node + Express): routes
  `/api/ctgov/*`, `/api/openfda/*`, `/api/rxnorm/*` → upstream APIs, with an
  in-memory TTL cache. Solves CORS for good, hides openFDA's 1k req/day limit
  behind a shared cache, and gives one place for retries/backoff.
- **Routing**: one CloudFront distribution, two origins. Default behavior → S3;
  `/api/*` → ALB origin (HTTPS to ALB is skipped — CloudFront→ALB over HTTP,
  ALB security group locked to CloudFront's managed prefix list). Frontend
  fetches relative `/api/...`, so no cross-origin config and no env-specific URLs
  baked into the bundle.
- **Fargate sizing**: 1 task, 0.25 vCPU / 512 MB, public-subnet with public IP
  (no NAT gateway — saves ~$32/mo), CloudWatch logs, `/healthz` for ALB checks.
- **Single environment (prod)**, default CloudFront URL. Everything keys off an
  `env_name` variable, so a dev environment later is one more `.tfvars` file
  plus a second state key.

## Repo layout changes

```
api/                    ← new: Express proxy + Dockerfile + jest tests
terraform/              ← new: Terraform (app layer, S3 remote state)
  versions.tf                ← provider + S3 backend
  variables.tf               ← region, project, env_name, image_tag
  network.tf                 ← VPC (public-only, no NAT), IGW, subnets, routes
  alb.tf                     ← ALB, security groups, target group, listener
  ecs.tf                     ← cluster, task definition, Fargate service, logs
  web.tf                     ← S3 + OAC, dist/ upload, CloudFront (both origins)
  outputs.tf                 ← app_url, distribution_id
  bootstrap/                 ← applied ONCE by hand, local state
    main.tf                  ← tfstate bucket + lock table, ECR repo, OIDC role
pipeline-radar/         ← existing frontend (unchanged except /api base path)
.github/workflows/
  ci.yml                ← PRs: lint, typecheck, jest (frontend + api), build
  deploy.yml            ← push to main: CI jobs → build/push image → terraform apply
```

Two layers, not one: the bootstrap layer holds the things that must exist before
CI can run at all (state backend, ECR repo, deploy role) and is applied by hand
with admin credentials. The app layer is the only thing CI touches. Within the
app layer, a web-only change re-uploads `dist/` and invalidates without replacing
the ECS task — Terraform's plan skips unchanged resources.

## Auth: GitHub OIDC, no stored keys

`terraform/bootstrap` (one-time manual apply from a laptop with admin creds):

1. `aws_iam_openid_connect_provider` for `token.actions.githubusercontent.com`.
2. `pipeline-radar-github-deploy` role with a trust policy scoped to
   `repo:dsl2022/pipeline-radar:ref:refs/heads/main` (exact branch — PRs
   from forks can never assume it).
3. Permissions: unlike CDK, Terraform has no bootstrap-role indirection — the
   role talks to AWS APIs directly, so it carries real permissions scoped to the
   services this stack uses (ec2, ecs, ecr, elb, cloudfront, s3, logs) plus
   `iam:PassRole` limited to `pipeline-radar-*`. This is the one genuine
   security regression versus the CDK design, where the GitHub role could only
   assume `cdk-*` roles and nothing else.

The role ARN goes in a GitHub **repo variable** (`AWS_DEPLOY_ROLE_ARN`). No
secrets anywhere in the pipeline.

## Workflows

**ci.yml** — `pull_request` + `push: main`:
- frontend job: `npm ci`, `oxlint`, `tsc -b`, `jest`, `vite build`
- api job: `npm ci`, `jest`, `docker build` (build only, no push)
- terraform job: `fmt -check`, `init -backend=false`, `validate` on both layers
  (catches infra errors pre-merge, and needs no AWS credentials so it runs on
  fork PRs too)

**deploy.yml** — `push: main`, `concurrency: deploy-prod` (queued, not parallel):
```yaml
permissions: { id-token: write, contents: read }
jobs:
  test:    # same three CI jobs, as a gate
  deploy:
    needs: test
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}, aws-region: us-east-1 }
      - uses: aws-actions/amazon-ecr-login@v2
      - run: docker build --platform linux/amd64 -t $IMAGE . && docker push $IMAGE
      - run: npm ci && npm run build          # pipeline-radar → dist/
      - run: terraform apply -auto-approve -var=image_tag=$GITHUB_SHA
      - run: aws cloudfront create-invalidation --paths '/*'
```
Ordering matters more than it did under CDK. The task definition references an
image tag, so the image must be pushed *before* apply; `web.tf` uploads `dist/`
via `aws_s3_object`, so the frontend must be built before apply; and the
CloudFront invalidation is now an explicit step rather than something
`BucketDeployment` did implicitly. ECS still does a rolling replacement gated on
ALB health checks, with a deployment circuit breaker for auto-rollback.

## Delivery order (each step demoable on its own)

| Step | Deliverable | Verify |
|---|---|---|
| 1 | `api/` proxy + Dockerfile, frontend pointed at `/api` (Vite dev proxy locally) | app works locally through the proxy |
| 2 | `terraform/` app layer + bootstrap layer; `terraform validate` clean | plan output reviewed |
| 3 | One-time: apply `terraform/bootstrap`; set `AWS_DEPLOY_ROLE_ARN`; first manual `terraform apply` | app live on CloudFront URL |
| 4 | `ci.yml` on a PR | green checks on PR |
| 5 | `deploy.yml`; push a visible change to main | change live, no human AWS access used |

## Rollback & safety

- **API**: ECS rolling deploy only shifts traffic on healthy checks; a bad image
  fails to stabilize and the deployment circuit breaker rolls back the task
  definition.
- **Frontend**: hashed asset filenames mean old HTML keeps working during sync;
  bad deploy → revert commit, pipeline redeploys the old build (~2 min).
- **Infra**: everything is in git; `terraform plan` runs in the deploy log and
  the saved plan file is what gets applied, so apply cannot drift from what was
  reviewed. State is versioned in S3 and locked in DynamoDB, so a bad apply can
  be rolled back to a prior state version.

## Cost (single prod env, us-east-1)

~**$26/mo**: ALB ~$16, Fargate task ~$9, S3/CloudFront/ECR/logs ~$1 at demo
traffic. The ALB is the biggest line item — accepted because the brief pins ECS
Fargate; the cheap alternative (Lambda + API Gateway for the proxy) is worth
naming in the interview as the cost-conscious variant.

## Prerequisites / open items

- Merge `recovered/milestones-2-4` into `main` first — the pipeline deploys
  `main`, which today only has Milestone 1.
- AWS account ID + region confirmation (plan assumes `us-east-1`).
- `terraform/bootstrap` must be applied once in the account before step 3, and
  its `deploy_role_arn` output set as the `AWS_DEPLOY_ROLE_ARN` repo variable.
  Nothing in CI works until that exists.
