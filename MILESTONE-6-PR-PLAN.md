# Milestone 6 — PR Blueprint

Execution plan for building the AI agent chatbot as a sequence of reviewable PRs.

**Read this first, then [MILESTONE-6-PLAN.md](MILESTONE-6-PLAN.md) for the design
detail.** This document is the *order of operations*; that one is the *what and
why*. Where they disagree, MILESTONE-6-PLAN.md wins on design and this one wins
on sequencing.

Intended for whoever picks the work up next — human or agent. It assumes no
memory of the conversation that produced it.

---

## Ground rules

1. **One PR at a time.** Branch off `main`, squash-merge, `main` deploys on merge.
2. **`main` stays green and deployable after every PR.** No "temporarily broken,
   fixed in the next one."
3. **Do not bundle.** If a PR grows past its stated scope, split it rather than
   widening it. Mechanical refactors never ride along with behaviour changes.
4. **Every security control's test proves the negative** — the blocked case
   returns 429/503/400 — not merely that the happy path works.
5. **If a PR runs 2× over its size estimate, stop and report what you would cut.**
   Do not silently skip tests to stay on schedule.
6. **Local-first.** Build and prove each control locally before it deploys. Do
   not build mocks for CloudFront, WAF or ECS — those are validated by
   `terraform validate`/`plan` and then live, via the smoke suite (PR 6).

---

## Current state

| Item | Status |
|---|---|
| Milestones 1–5 | Shipped. App is live and deployed. |
| `shared/` workspace extraction | **Merged** (PR #1). Required a follow-up commit restoring 66 cross-platform optional bindings to the lockfile — see Traps below. |
| Test baseline | **126** — 103 `shared` + 15 `pipeline-radar` + 8 `pipeline-radar-api` |
| Agent code | None yet. `api/src/` is `app.ts`, `cache.ts`, `server.ts`. |

---

## Prerequisites (outside the PR flow)

Both are gates on **PR 7**, not on PRs 1–6.

1. **Anthropic Console** — two workspaces, one API key each, one spend cap each:

   | Workspace | Key | Cap | Consumed by |
   |---|---|---|---|
   | `pipeline-radar-prod` | `pipeline-radar-prod` | $60/mo | Fargate service |
   | `pipeline-radar-ci` | `pipeline-radar-ci` | $90/mo | CI evals + local dev |

   Separate workspaces so a runaway eval cannot starve the demo. Keys are
   workspace-scoped and **cannot be moved after creation** — a key created in
   Default is under no cap at all.

2. **Credential placement** — see MILESTONE-6-PLAN.md §6.3 and `.env.example`:
   - prod key → AWS Secrets Manager `pipeline-radar/anthropic-api-key` (us-east-1)
   - ci key → GitHub secret `ANTHROPIC_API_KEY_CI`, and local `.env`

---

## The PRs

### PR 1 — `shared/` workspace extraction ✅ merged
**Branch:** `milestone-6-phase-0` · **Size:** 48 files, mechanical · **Spend:** none

Moves the DOM-free logic both the web app and the agent need into a workspace
package. Nothing else may ride along.

- `shared/` package holding `types`, `mapStudy`, `summarize`, `report`,
  `watchlist`, `drugs/*` and the JSON fixtures, consumed as
  `@pipeline-radar/shared/*`
- Root npm workspaces; single root lockfile (the per-package lockfiles are deleted)
- Vite aliases the package to **source**; the api consumes the built **CJS dist**
- `api/Dockerfile` build context moves to the repo root
- `ci.yml` gains a `shared` job; all jobs `npm ci` at root then `-w <workspace>`

**Accept when:** 126 tests green, all three workspaces build, `oxlint` clean,
`terraform fmt -check` clean.

**Not verified locally:** the Docker image build (no daemon available on the
authoring machine). CI's `api` job covers it — watch that job on this PR.

---

### PR 2 — Infra unblock
**Branch:** `m6/infra-unblock` · **Size:** ~10 lines Terraform · **Spend:** none

Four settings that make an SSE chat endpoint possible at all. Without these the
feature fails in ways that look like application bugs.

- `terraform/web.tf` — add `POST`/`PUT`/`PATCH`/`DELETE` to the `/api/*`
  behaviour's `allowed_methods` (**currently GET/HEAD/OPTIONS only → a POST to
  the chat endpoint returns 403 from CloudFront before reaching the ALB**);
  set `origin_read_timeout = 60` on the ALB origin
- `terraform/alb.tf` — `idle_timeout = 240`; deregistration delay 10 → 60
- `terraform/ecs.tf` — `cpu = 512`, `memory = 1024`, `desired_count = 2`

**Accept when:** `POST` to a temporary `/api/agent/ping` returns 200 *through
CloudFront*, and a 90-second SSE stream completes end to end.

---

### PR 3 — Agent provisioning
**Branch:** `m6/agent-provisioning` · **Size:** ~70 lines Terraform · **Spend:** none

- `terraform/bootstrap/main.tf` — widen the deploy policy with
  `secretsmanager:*` (create/put/describe/get/tag/update/delete) **and**
  `dynamodb:UpdateItem`/`CreateTable`/`DescribeTable`
- `terraform/ecs.tf` — `secrets = [{ name = "ANTHROPIC_API_KEY", valueFrom = <arn> }]`;
  grant `secretsmanager:GetSecretValue` to the **task execution role**, not the
  task role. Never `environment` — env vars appear in `describe-task-definition`.
- New DynamoDB table for rate-limit counters and the kill-switch flag, with TTL

> **Out-of-band step, do this first.** `terraform/bootstrap` has **local state**
> and is applied by hand. Apply the IAM widening manually *before* merging this
> PR, or the CI deploy fails with AccessDenied. Both widenings (Secrets Manager
> and DynamoDB) go in **one** manual pass.

**Accept when:** `terraform apply` runs clean in CI and the task starts with the
secret injected.

---

### PR 4 — Request pipeline, no LLM
**Branch:** `m6/request-pipeline` · **Size:** ~400 LOC · **Spend:** none

`POST /api/agent/chat` exists and streams a canned response. Every gate that
precedes the model is here.

- `app.set('trust proxy', 2)` — **currently unset, so `req.ip` is the ALB's
  address and any IP limit would throttle all users as one bucket**
- HMAC-signed, httpOnly, SameSite=Lax session cookie issued on app load
- **Requests to `/api/agent/*` without a valid cookie are rejected outright** —
  no IP-only fallback, because a fallback is a documented bypass
- `Origin`/`Referer` checked on the chat POST; cross-site rejected
- SSE plumbing with a `: ping` heartbeat every 10s (load-bearing: CloudFront's
  origin read timeout applies to the *gap between packets*)
- 4k character input cap; reject control characters and non-UTF8

**Accept when** (supertest, no AWS): forged cookie → 403, missing cookie → 403,
`X-Forwarded-For` resolves to the client not the ALB, a stream with a 40s gap
stays open (fake timers), 5k input → 400.

---

### PR 5 — Rate limits + kill switch
**Branch:** `m6/rate-limits` · **Size:** ~350 LOC · **Spend:** none

- Token buckets: per-session (5/min, 30/hr, 300k tokens/day), per-IP (20/min,
  200/hr), global daily ceiling ($10/day)
- Counters in DynamoDB so they are shared across tasks — in-memory counters
  silently double every limit once `desired_count = 2`
- Kill switch as a **DynamoDB runtime flag with a 10s TTL cache**, *not* an ECS
  env var: an env var needs a new task definition and a deployment to change,
  which is the opposite of a kill switch
- Global cap → 503 on the agent surface only; the rest of the app keeps serving

**Accept when** (DynamoDB Local in Docker at `localhost:8000`, injected clocks —
no `sleep` in tests): N requests pass and N+1 → 429 with `Retry-After`, cap
crossed → 503, flag on → 503 and off → 200, counters shared across two app
instances.

> The app-layer ceiling is **best-effort, not guaranteed** — cost is only known
> after a turn completes, so in-flight turns can overshoot. The Console cap is
> the only hard ceiling. Name it that way in code comments and docs.

---

### PR 6 — Smoke suite + WAF
**Branch:** `m6/smoke-and-waf` · **Size:** ~200 LOC + Terraform · **Spend:** none

Proves PRs 2–5 are live in production, before anything can cost money.

- New job in `deploy.yml` after `aws ecs wait services-stable`, ~15 assertions
  against the live CloudFront URL: `POST /api/agent/chat` → 200 (regression test
  for PR 2), 90s SSE completes, burst → 429, kill-switch flip → 503 → flip back,
  cookie issued on load, global-cap 503 leaves the rest of the app at 200
- WAF web ACL: rate-based rules on `/api/agent/*` keyed on IP **and** on the
  session cookie, plus the managed common rule set
- Smoke failure → fail the job + Slack alert + **documented manual rollback**
  (re-run the previous commit's deploy). No blue/green, no auto-rollback: an
  automated rollback driven by a suite that can itself be flaky causes more
  incidents than it prevents at this size.

> The existing ECS deployment circuit breaker rolls back on *container health*
> only. It cannot see "rate limiting is broken." That is what this suite is for.

> **No test-bypass header, no secret-gated mock hook.** That is an auth bypass
> waiting to leak, and it would stop the smoke test exercising the real path.
> Once PR 7 lands, the smoke turn becomes a real request with tiny `max_tokens`
> and no tools (~$0.002).

**Accept when:** the suite runs green against production and each assertion has
been seen to fail when its control is deliberately disabled.

---

### PR 7 — Agent core
**Branch:** `m6/agent-core` · **Size:** ~600 LOC · **Spend:** first real spend
**Gated on:** both API keys in place

- `client.beta.messages.toolRunner`, `claude-opus-5`, streaming
- Four read tools wrapping `shared/`: `search_trials`, `summarize_trials`,
  `build_drug_landscape`, `check_fda_approval`. All `strict: true`,
  `additionalProperties: false`, Zod-validated, results truncated to a size budget
- Per-turn bounds: `max_iterations: 8`, `task_budget` 40k tokens, 120s wall
  clock, `max_tokens` 64000
- `thinking: {type:"adaptive", display:"summarized"}` — the default is
  `"omitted"`, which streams empty thinking blocks and reads as a dead pause
- `stop_reason` checked every iteration; `fallbacks: "default"` for refusals
- Frozen system prompt with `cache_control`; deterministic tool ordering

**Accept when:** golden questions return answers citing real NCT IDs; a repeat
turn shows `cache_read_input_tokens > 0`; tool-result payloads stay inside budget.

> **The agent orchestrates but never computes.** Every number in an answer comes
> from a tool result produced by tested code. This is what makes the PR 12
> assertions exact rather than fuzzy.

---

### PR 8 — Chat UI
**Branch:** `m6/chat-ui` · **Size:** ~350 LOC

assistant-ui panel (`ExternalStoreRuntime`, custom SSE backend — no Next.js, no
AI SDK), streaming, tool status chips, citation chips deep-linking into existing
routes, persistent "AI-generated — verify against source records" label.

Never render model-composed external links; allowlist own routes and canonical
ClinicalTrials.gov URLs.

---

### PR 9 — Copilot + brief
**Branch:** `m6/copilot-brief` · **Size:** ~400 LOC

- `set_view` — result forwarded to the browser and applied to React state
- Remaining tools: `get_trial_detail`, `get_adverse_events`, `pubmed_count`,
  `diff_watchlist`
- Two-phase `prepare_brief` / `commit_brief`: prepare returns a preview plus a
  short-lived HMAC token; commit requires it, and only a user click supplies it

**Accept when:** `set_view` cases assert the resulting **view-state object**, not
the reply text — an agent that *says* it filtered but did not must fail.

---

### PR 10 — Grounding
**Branch:** `m6/grounding` · **Size:** ~200 LOC

Post-response citation checker: every NCT ID in the reply must resolve to *this
session's* tool results. Unresolvable IDs are flagged inline as "unverified
claim" and logged as an eval signal.

**Accept when:** a fabricated NCT ID is flagged, and the unverified rate is
emitted as a metric.

---

### PR 11 — Observability
**Branch:** `m6/observability` · **Size:** ~300 LOC

- OpenTelemetry span tree → Langfuse Cloud (write to OTel GenAI semantic
  conventions, not a vendor SDK, so the backend stays swappable)
- Spans: gate.budget, llm.call#N, tool.*, gate.citation_check
- EMF metrics to CloudWatch; structured per-turn JSON log
- **Never log raw user text to CloudWatch** — hash and length only. Full text
  lives in Langfuse where access is controlled.
- Alerting is **one Slack webhook**, critical only: budget 80%/100%, error rate
  >10% for 5 min, Anthropic 401/403, smoke failure, cost/turn >5× median,
  sessions/IP >20/hr. Everything else is dashboard-only. No SNS tiers, no daily
  digest, no weekly review.

---

### PR 12 — Evals
**Branch:** `m6/evals` · **Size:** ~500 LOC

- Golden set (~30 cases from `shared/src/samples/` and `research/fixtures/`)
- Trajectory assertions (rollup questions must call `build_drug_landscape` first)
- End-state verification, not last-message matching
- **pass^4** — each case runs 4×, gate is passing all four
- `promptfoo` adversarial suite, including the case that matters: an injection
  planted in a **fixture trial title/sponsor field**, asserting the trajectory is
  unchanged and no unexpected tool fired
- CI trigger: on pushes touching `api/src/agent/**`, plus one deliberate pre-demo
  run. **No nightly schedule** — over a one-week window the on-change trigger
  covers every meaningful diff.
- PR gate stays deterministic-only: fast, free, no LLM calls

---

## Facts already established — do not re-derive

| Fact | Consequence |
|---|---|
| GitHub issues this repo an **ID-qualified OIDC subject claim** — `repo:dsl2022@11345415/pipeline-radar@1339087067:ref:refs/heads/main`, not `repo:owner/repo:...` | The deploy role's trust policy pins both forms. Any future OIDC/WIF rule must too, or it fails with an opaque 401. |
| The account-level **GitHub OIDC provider is shared** with another project (`eop-dev`) and is now in this project's Terraform state | **Never `terraform destroy` `terraform/bootstrap`.** It would break the other project's deploys. |
| openFDA is capped at **1,000 requests/day per IP**, shared by the whole app | A looping agent degrades *the product*, not just the bill. Per-tool per-turn cap + circuit breaker at 80%. |
| CloudFront's `origin_read_timeout` defaults to **30s** and applies between packets | SSE needs a heartbeat more frequent than that. The heartbeat is the fix; the timeout bump is headroom. |
| `terraform/bootstrap` uses **local state** | It is applied by hand, never by CI. |
| Business logic was DOM-free and already SSR-safe (localStorage calls guarded) | The extraction was a file move, not a redesign. |

## Environment quirks (not bugs — do not "fix")

- **`npm run <script>` can exit 1 on this Mac even when the script fully
  succeeds.** Confirmed by running the tool directly: `cd shared && node
  ../node_modules/.bin/jest` exits 0 with 103 passing, while `npm run test -w
  @pipeline-radar/shared` exits 1 on the same tree. It is npm's wrapper, not
  jest and not watchman (watchman was reset and it made no difference). CI on
  Linux is unaffected. **Verify locally by invoking the tool directly or by
  checking the artifacts it produced — do not trust `$?` from `npm run`.**
- **`npm install` / `npm ci` fail intermittently here**, with no error text at
  all — just "A complete log of this run can be found in…" and a log that stops
  mid-resolve. Retrying usually works. Do not conclude the lockfile is broken
  from a single failure; that mistake cost this project a wiped `node_modules`
  and a dead dev server (see below).
- **Docker daemon may not be running locally**, so the image build is unverified
  until CI's `api` job runs it.

## Traps this project has already hit

- **Never regenerate `package-lock.json` by reconciling an existing
  `node_modules`.** Doing so records only the *current platform's* optional
  binaries and silently drops the rest — the lockfile then passes locally and
  fails on CI with `Cannot find native binding` (npm/cli#4828). It affected four
  families here: `@oxlint`, `@rolldown`, `lightningcss`, `@esbuild`. If the
  lockfile must be rebuilt, delete `node_modules` **and** the lockfile first, and
  afterwards assert that `binding-linux-x64-gnu` entries exist before pushing.
- **Deleting `node_modules` kills a running Vite dev server in a way that looks
  like it is still working.** Vite keeps serving *source* files from disk (so
  `curl` of a module returns 200 and the edits look live) while the browser gets
  504 `Outdated Optimize Dep` for React and renders nothing. **Verify UI work by
  loading the page, not by HTTP status codes.** Playwright is installed on this
  machine — drive the real page and assert on rendered geometry.
- **JSON subpaths do not resolve through the shared package's `exports` map.**
  The map is `"./*" → "./dist/*.js"`, so
  `@pipeline-radar/shared/samples/lung-cancer.json` resolves to
  `dist/samples/lung-cancer.json.js`, and `tsc` does not emit the fixtures into
  `dist` anyway (they are only imported by excluded test files). Current
  consumers reach them via the Vite alias or Jest's `moduleNameMapper`, both
  pointing at source, so nothing is broken today. **PR 12 (evals) will hit this**
  if eval code under `api/` imports fixtures by package name. Fix then by adding
  an explicit `"./samples/*": "./src/samples/*"` export.

## Repo conventions to follow

- Tests: Jest + `ts-jest`; integration via `supertest` against `createApp()`
  (see `api/src/app.test.ts`)
- Install is always a single `npm ci` at the repo root; per-package work uses
  `-w <workspace>`
- Terraform: `terraform fmt -check -recursive terraform` gates CI
- Comments explain *why*, not *what* — match the density of the existing files
