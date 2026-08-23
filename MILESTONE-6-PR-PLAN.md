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
| Blueprint PRs 1-6 | **Merged and verified in production.** Request pipeline, rate limits, kill switch, smoke suite and WAF are all live. |
| Anthropic spend | **Zero.** The key is wired into the task; nothing reads it yet. |
| Agent code | `api/src/agent/` holds the gates and limiter. No model call exists. |

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

### PR 2 — Infra unblock ✅ merged
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

### PR 3 — Agent provisioning ✅ merged
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

### PR 4 — Request pipeline, no LLM ✅ merged
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

### PR 5 — Rate limits + kill switch ✅ merged
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

### PR 6 — Smoke suite + WAF ✅ merged
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

### PR 7 — Agent core ✅ merged
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
- **`npm install` cannot reliably complete on this Mac.** It dies mid-resolve
  with no error text — just "A complete log of this run can be found in…" and a
  log that stops partway. It is not heap (8GB makes no difference) and not
  network (packuments fetch in ~0.1s). `npm ci` works, because it reads the
  lockfile instead of resolving. Small additions sometimes succeed on retry;
  the AWS SDK's tree never did, in 10+ attempts.
  **Workaround that does work:** resolve in a Linux container —
  `docker run --rm -v "$PWD":/w -w /w node:22-alpine npm install -w <ws> --save
  --package-lock-only <pkg>` — then `npm ci` on the host to materialise it.
  Running the test suites in a container (with `node_modules` in docker volumes
  so the host tree is untouched) is also more reliable than the host, and
  matches how CI runs.
- **Never let a host `npm install` rewrite the lockfile.** It reconciles against
  the existing `node_modules` and drops other platforms' optional binaries —
  observed dropping linux bindings from 6 to 4. Copy the lockfile aside first
  and restore it if the count changes.
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
- **A PR that introduces a new AWS service will fail its first deploy on a
  missing bootstrap grant — check before merging, not after.** This happened
  three times in one milestone: Secrets Manager, then DynamoDB, then WAF. The
  deploy role is scoped per service, `terraform/bootstrap` holds **local state**
  and is applied by hand, so the grant must be applied *before* the PR merges or
  `main` goes red. Two further details learned the hard way: a narrowing that is
  correct today can be invalidated by a later PR (read-only on secrets broke the
  moment Terraform started generating one), and **an IAM denial names *a*
  failing resource, not all of them** — granting WAF on the web ACL's ARN still
  failed, because referencing a managed rule group evaluates against the managed
  rule set's ARN too.
- **A green deploy does not mean the deploy happened.** If a container fails to
  start, ECS's deployment circuit breaker rolls back to the previous task
  definition and the service settles into a genuinely healthy steady state on
  the *old* image. `terraform apply` returns 0, `aws ecs wait services-stable`
  passes, and the site keeps serving. A broken image shipped this way through
  three consecutive "successful" deploys. `deploy.yml` now asserts that the
  revision it applied is the revision actually running — **do not remove that
  step**, and do not treat stability as the signal.
- **`docker build` succeeding does not mean the image runs.** The same broken
  image built cleanly in CI; it only failed at container start
  (`Cannot find module 'express'` — npm workspaces had left it in
  `api/node_modules`, which the Dockerfile did not copy). CI now starts the
  container and curls `/healthz`.
- **Verification mechanisms need the same scrutiny as features.** Two separate
  reviews found bugs not in what was built but in what was built to *check* it:
  a CloudFront rule that rewrote every API denial to `200` so the guards only
  looked like they passed, and a smoke suite that deleted the kill-switch flag
  on exit — silently re-enabling an agent an operator had deliberately disabled.
  Asking "does this detect failure?" is not enough. Also ask **"what does this
  change about the system while it runs, and what does it leave behind?"**
- **The shape both of those share, and the one to internalise: verifying a
  proxy for the thing is not verifying the thing.** HTTP 200 on the live URL
  proves the site is up, not that the deploy landed. A 200 from a Vite module
  proves the file was read, not that the page renders. A successful build
  proves the image assembles, not that it boots. Every one of those was
  mistaken for the real check during Milestone 6. When verifying, ask what
  would still be true if the change had silently not applied.
- **JSON subpaths do not resolve through the shared package's `exports` map.**
  The map is `"./*" → "./dist/*.js"`, so
  `@pipeline-radar/shared/samples/lung-cancer.json` resolves to
  `dist/samples/lung-cancer.json.js`, and `tsc` does not emit the fixtures into
  `dist` anyway (they are only imported by excluded test files). Current
  consumers reach them via the Vite alias or Jest's `moduleNameMapper`, both
  pointing at source, so nothing is broken today. **PR 12 (evals) will hit this**
  if eval code under `api/` imports fixtures by package name. Fix then by adding
  an explicit `"./samples/*": "./src/samples/*"` export.

- **A cache populated *after* `await` does not protect a single turn.** The
  tool runner executes every `tool_use` block in one assistant message
  concurrently (`BetaToolRunner` -> `Promise.all`), and parallel tool use is
  the default. So the common case — one question, three tools, same disease —
  has all three miss an empty cache in the same tick and each start its own
  registry request. It *looks* cached, because a sequential repeat test passes.
  `data.ts` now stores the in-flight Promise and joins it, deleting the entry
  on rejection so a failure is still never cached. **Any read-through cache
  behind a tool needs single-flight, and its test needs `Promise.all`, not
  sequential awaits.**
- **Jest's `moduleNameMapper` redirects the runtime require, not TypeScript's
  type resolution.** The api workspace maps `@pipeline-radar/shared/*` to
  `shared/src/*`, so tests *run* against source — but `tsc` still resolves the
  types through the package's `exports` map into `shared/dist`. The moment the
  api began importing shared, every suite that touched it failed in CI with
  `Cannot find module '@pipeline-radar/shared/net'` while passing locally,
  because the local tree had a `dist` left over from an earlier build. The api
  CI job now runs `npm run build -w @pipeline-radar/shared` first.
  **To reproduce a CI-only failure of this shape, `rm -rf shared/dist` before
  running** — a stale build artifact is invisible local state.
- **An OOM-killed Jest worker reads as a flaky test, not as a resource limit.**
  Adding the Anthropic SDK and zod raised per-worker memory enough that the
  default `cpus - 1` workers exhausted a 3.8 GB Docker VM. The output is
  `A jest worker process ... was terminated by another process: signal=SIGKILL`
  and — the dangerous part — **a whole suite vanishes from the totals**
  (`Tests: 157 passed` where 185 were expected) while the run still reports
  "passed" for everything it did manage to run. A total that shrinks is a
  failure even when nothing says "failed". `api/jest.config.js` now pins
  `maxWorkers: 3`; ubuntu-latest has 4 cores, so CI's behaviour is unchanged.
- **`betaZodTool` does not strip unsupported JSON Schema keywords, and
  `strict: true` makes that fatal.** The SDK runs `transformJSONSchema` over
  structured *output* schemas but not over tool *input* schemas, so a Zod
  `.min()/.max()` reaches the API verbatim and the request dies with
  `400 ... For 'integer' type, properties maximum, minimum are not supported`
  — before a single token is generated, so it reads as "the agent is broken",
  not "one field is wrong". `stripUnsupported()` in `api/src/agent/tools.ts`
  removes them from the wire schema while Zod keeps enforcing them in-process.
  The stripped list covers **every** unsupported constraint (numeric, string
  length, array bounds), not just the one the error named — same shape as the
  IAM lesson above.
- **A JavaScript default parameter fires on an explicitly-passed `undefined`.**
  A test written as `app({}, undefined, undefined)` to mean "no runner
  configured" silently received the stub runner instead and asserted nothing.
  It only surfaced because the assertion was specific (`503`) rather than
  loose. Use `null` as the "deliberately absent" sentinel in test helpers.
- **The shared data modules are browser-shaped: their `/api` base is
  relative.** Node's `fetch` rejects a relative URL outright, so running them
  server-side needs `setApiBase()` (`shared/src/net.ts`) before first use. The
  API service points it at **its own proxy** rather than at openFDA directly,
  so the agent's lookups still go through the TTL cache that pools openFDA's
  1,000/day per-IP quota — both tasks share one NAT address.

## Measured, so the next PR need not re-derive it

| Measurement | Value (2026-08-23, NSCLC) |
|---|---|
| Registry match vs. one page fetched | 2,460 active trials / 500 fetched |
| Raw JSON of a 500-trial page | ~237,000 chars |
| Largest tool result at max limits (`search_trials`, limit 50) | ~18,100 chars — inside the 24k budget |
| First turn, 2 iterations, 2 tool calls | 4,800 in / 948 out / 2,454 cache-read / 28.5s |
| Second turn (frozen prefix reused) | 449 in / 244 out / **4,908 cache-read, 0 cache-creation** |
| Smoke turn ("reply with one word") | 107 in / 4 out / ~1.4s |

The cache numbers are the ones to protect: the second turn read the entire
prefix from cache and created none. Anything that varies per turn in the system
prompt or the tool block — a date, a session id, a reordered tool array —
turns that 4,908 back into full-price input on every request.

## Repo conventions to follow

- Tests: Jest + `ts-jest`; integration via `supertest` against `createApp()`
  (see `api/src/app.test.ts`)
- Install is always a single `npm ci` at the repo root; per-package work uses
  `-w <workspace>`
- Terraform: `terraform fmt -check -recursive terraform` gates CI
- Comments explain *why*, not *what* — match the density of the existing files
