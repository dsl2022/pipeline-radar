# Pipeline Radar — AI Agent Plan (Milestones 5 & 6)

## Reading of the milestones

| Milestone | Brief says | What it becomes in the agent design |
|---|---|---|
| 5 — Consultant deliverable | One-click export (Markdown/HTML), watchlist save + diff on re-run | The agent's **outputs**: exports and diffs are exactly the artifacts a consultant asks an assistant for. M5's deterministic features (export renderer, watchlist store, diff engine) get built as plain code — then exposed to the agent as tools. |
| 6 — Stretch | PubMed counts / caching / **LLM narrative** | The agent's **charter**: M6 already names the LLM narrative. The agent generalizes it from "one canned summary" to a Rovo/Cortex-style copilot that can drive every feature the app has (M1–M5) through tools. |

Key insight: **M5 and M6 are one feature seen from two sides.** The watchlist diff (M5) is only useful with an explanation of *why* the changes matter (M6's narrative). Build the deterministic layer first, put the agent on top.

## Use cases (ranked by demo value ÷ effort)

1. **Ask the landscape** — "Which phase-3 EGFR drugs in NSCLC aren't FDA-approved yet?" The agent drives search → filters → drug rollup → FDA badges via tools and answers with NCT-ID citations. This is the "agent that can handle all the functionality" ask: same capabilities as the UI, conversational surface.
2. **UI copilot** — the agent doesn't just answer, it *steers the app*: a `set_view` tool whose result the frontend applies (set condition, filters, toggle drug view, highlight rows). The user watches the UI respond to "show me only recruiting phase 3 trials" — the Rovo moment.
3. **Consultant brief generator (M5 export + M6 narrative)** — one click on a landscape → structured Markdown brief: therapeutic-area overview, drugs by phase, approved-vs-investigational split, top sponsors, notable trials — every claim cited to NCT IDs, exportable.
4. **Watchlist diff analyst (M5 diff + narrative)** — on re-run: "Since 3 weeks ago: 4 new trials; dato-DXd advanced Phase 2 → Phase 3 (NCT0…); AstraZeneca now leads sponsor count. Implication: …". The diff itself is computed in code; the agent explains it.
5. **Drug deep-dive** — one drug → its trials, approval history (openFDA), top adverse events, PubMed activity (M6), synthesized into a one-pager.
6. **Rollup auditor (human-in-the-loop)** — the agent reviews the "unverified" drug bucket from M3 and *proposes* merges/splits with rationale; the user confirms each. The agent never mutates the rollup itself.
7. **Scheduled monitor (later)** — nightly EventBridge-triggered run: re-execute saved watchlists, diff, generate the narrative, notify. Same tools, no new agent code.

## Architecture

The agent loop runs **server-side in the `api/` Fargate service** from [CICD-PLAN.md](CICD-PLAN.md) — never in the browser (API key protection, tracing, rate limiting all live server-side). Frontend talks to `/api/agent/chat` over SSE.

```
Browser ── SSE ──> /api/agent/chat  (Express, Fargate)
                        │
                 Anthropic TS SDK — beta tool runner (claude-opus-5)
                        │ tool calls
        ┌───────────────┼──────────────────┬───────────────┐
        ▼               ▼                  ▼               ▼
  search_trials   build_drug_landscape  check_fda_*   set_view (client-applied)
  (CT.gov proxy)  (canon→cluster→RxNorm) get_adverse   export_brief
                                         pubmed_count  diff_watchlist
```

- **Surface choice:** Claude API + tool use with the SDK **tool runner** (`client.beta.messages.toolRunner`, `betaZodTool`) — we own hosting; the runner supplies the loop with per-turn hooks for gating, logging, and interception. Not Managed Agents (our tools are in-process functions, not a sandbox workload); not a manual loop (the runner's hooks cover every control point we need).
- **Model:** `claude-opus-5`, adaptive thinking (default), `output_config: {effort: "medium"}` for chat, `"high"` for brief generation. Streaming always.
- **Tools are the app's existing pure functions.** `summarize.ts`, `drugs/*` already run on plain data — they get reused verbatim server-side. The agent **orchestrates but never computes**: trial counts, phase ranks, and diffs come from code; the model's job is routing, synthesis, and prose.

### Tool surface (all read-only; strict schemas)

| Tool | Wraps | Notes |
|---|---|---|
| `search_trials` | CT.gov proxy + `mapStudy` | condition, statuses, phases, page cap |
| `summarize_trials` | `summarize.ts` | counts by phase, top sponsors — numbers come from here, never the model |
| `build_drug_landscape` | `drugs/canon→cluster→rxnorm` | returns DrugRows incl. source NCT IDs |
| `check_fda_approval` / `get_adverse_events` | openFDA (server-cached) | shared 24h cache guards the 1k/day limit |
| `pubmed_count` | PubMed esearch (M6) | 3 req/s throttle server-side |
| `diff_watchlist` | M5 diff engine | deterministic diff object in, narrative out |
| `get_trial_detail` | CT.gov single-study fetch | just-in-time retrieval: list tools return IDs + one-line summaries; the agent pulls full detail only for trials it actually needs — keeps context lean |
| `set_view` | nothing server-side | result is forwarded to the browser, which applies it to React state — the UI-copilot tool |
| `export_brief` | M5 renderer | takes the agent's Markdown, returns a download link; **requires user confirmation click** |

Every tool: `strict: true`, `additionalProperties: false`, Zod-validated inputs, response payloads truncated to a size budget before entering context (top-N rows + total count, never raw 100-study JSON).

## Guardrails (the "hardness")

**Threat model in one line — the "lethal trifecta" test.** Prompt injection becomes *exploitable* when a system combines (1) private-data access, (2) untrusted content in context, (3) an outbound channel. Pipeline Radar's agent has leg 2 (trial titles, sponsor names, openFDA text are all third-party strings) but is architecturally denied legs 1 and 3: it touches only public registry data, and its only outbound surfaces are the user's own screen and a user-confirmed download. A successful injection can produce wrong words, never a wrong action or a data leak. That's a structural property, not a prompt instruction — which is the defensible claim.

1. **Capability guardrail** — the tool surface is read-only; there is no bash, no fetch-arbitrary-URL, no state mutation. Side-effectful actions are **two-phase**: `export_brief` and rollup-audit merges are `prepare_*` calls that return a preview + confirmation token; the commit requires the token, which only the user's click supplies. The model can propose, only the human can dispose.
2. **Grounding contract** — system prompt: answers only from tool results returned this session; every quantitative claim carries its NCT IDs or names the tool it came from; if the tools can't answer, say so. Enforced, not just prompted: a **post-response citation check** verifies every NCT ID in the reply exists in this session's tool results — failures are flagged in the UI ("unverified claim") and logged.
3. **Domain boundary** — this is competitive-intelligence tooling, not medical advice. The system prompt scopes the agent to landscape analysis; treatment questions get redirected to the data ("here's what's in trials") with a no-clinical-guidance disclaimer.
4. **Prompt-injection posture** — trial titles, sponsor names, and openFDA text are untrusted third-party strings that flow into context via tool results. System prompt marks tool results as data, never instructions; the read-only tool surface bounds the blast radius of a successful injection to "wrong words," never "wrong actions."
5. **The loop is bounded three ways** — max steps (`max_iterations: 8`), max spend (`max_tokens` per turn + per-user daily token budget that **hard-blocks** in the proxy, not just alerts), and max wall-clock (120s per turn; the SSE connection is killed and the turn reported as timed out). Unbounded loops are how an agent becomes an incident — or an invoice.
6. **Injection-safe operator channel** — mode switches and mid-session state (e.g. "user enabled expert mode") go in as `{"role": "system"}` messages appended to `messages[]`, not as user-text — non-spoofable and cache-preserving.
7. **Kill switch** — one env flag (`AGENT_ENABLED=false`) checked per-request in the proxy disables the agent surface without a redeploy; the chat panel degrades to "assistant unavailable" while the rest of the app keeps working. Tested, not just written.
8. **`stop_reason` handled on every response** — `refusal` surfaced honestly to the user, `max_tokens` retried with headroom, never read `content[0]` unconditionally.

## Tracing & observability

**Two layers, two tools.** Infra metrics (CPU, latency, ALB errors) stay in CloudWatch per the CI/CD plan. LLM observability goes to **Langfuse** — open source, self-hostable (free cloud tier for the demo; a container next to the api service later), framework-agnostic, no LangChain required. It replaces the hand-rolled trace store with sessions/traces/spans UI, token-cost rollups per session and per user, prompt versioning, and dataset-based eval runs.

- **Trace tree, not just input/output.** Each chat turn is a Langfuse trace; each model call and each tool execution is a span with inputs, outputs (truncated), duration, and token usage. The reference failure mode — "can't tell whether a bad answer was bad retrieval, a bad tool result, or bad reasoning" — is exactly what the span tree answers. The SDK's `_request_id` is attached for Anthropic-side correlation.
- **Cost per successful task** is the tracked metric, not cost per token — a session that needed three retries isn't cheaper. Langfuse user/session cost rollups + a CloudWatch alarm on the daily hard budget.
- **Cache health** — `cache_read_input_tokens` ≈ 0 across turns means a silent prompt-cache invalidator; alarmed.
- **Bad traces become eval cases** — a one-click path from a flagged Langfuse trace into the golden set (below). The regression suite grows from real failures; that's the loop.
- **Prompt caching discipline** — frozen system prompt and deterministic tool list first, `cache_control` breakpoint on the last system block, volatile content only in messages. Repeat turns then pay ~0.1× on the prefix.
- **Prompts are code** — the system prompt and model pin live in the repo, reviewed in PRs, deployed through the same pipeline; a model upgrade is a release with an eval run attached, never a silent swap.

## Evals (the correctness story, same philosophy as M1–M4)

- **Golden-set evals in CI** — the `samples/` fixtures already double as test data. A dozen question → expected-facts pairs run against the agent with tools stubbed to fixtures: "how many unique drugs in lung cancer?" must contain the number `summarize.ts` computes. Deterministic tools make these assertions exact, not fuzzy.
- **Trajectory assertions** — rollup questions must call `build_drug_landscape` before answering; approval questions must call `check_fda_approval`. Wrong-trajectory = failed eval, catches "answered from memory."
- **End-state verification, not last-message matching** — for `set_view` cases the eval asserts the resulting view state object (condition, filters, mode), the way tau-bench checks the database rather than the reply text. An agent that *says* it filtered but didn't fails.
- **pass^k, not pass@1** — golden-set cases run k=4 times; the gate is passing *all* runs. Agents have high run-to-run variance and pass^4 routinely lands 15–25 points below pass^1; deterministic tools keep our variance low, and this proves it.
- **Citation checker doubles as an eval metric** — % of claims with resolvable NCT IDs, tracked over time.
- **Narrative quality** — small rubric-scored LLM-judge pass over generated briefs (structure present, no uncited numbers), run on PRs that touch the prompt. Judge caveats applied: calibrated rubric, both orders on pairwise comparisons, and the known verbosity bias means the judge never scores length.
- **Deterministic scorers gate; the judge advises.** CI merges block only on code-checkable properties (end state, trajectory, citations, no-loop, cost ceiling); the judge score is reported, not gating.

## Stack decisions — what's in, what's out, and why

| Layer | Decision | Rationale |
|---|---|---|
| Orchestration | **Anthropic SDK tool runner — no LangChain/LangGraph** | One provider, one agent, ~8 tools: the SDK's loop + per-turn hooks cover gating, interception, and streaming. LangGraph earns its keep when control flow is a real state machine with checkpoints and interrupts; this is a bounded ReAct loop. A framework here is abstraction tax — extra dependency surface, lagging support for new API features, debugging through wrappers. The interesting guardrails (citation checker, trajectory asserts, two-phase commits) are application logic no framework ships. |
| LLM observability & evals | **Langfuse** (self-hostable) + CloudWatch for infra | Replaces hand-rolled trace/eval plumbing; no LangChain dependency. LangSmith is excellent but pulls toward the LangChain ecosystem and is closed/hosted — weaker fit. |
| Gateway (LiteLLM/Portkey) | **Not now — the proxy already does the two jobs we need** | Budget caps and rate limits live in ~50 lines of our Express middleware. A gateway earns its keep at multi-provider/multi-team scale; adding one for a single-provider, single-app agent is infra for its own sake. Named as the growth path if a second provider or per-team virtual keys ever appear. |
| Semantic caching | **Rejected outright** | Embedding similarity can't distinguish "trials for lung cancer" from "trials for lung cancer *in children*" — a wrong cache hit here is a wrong medical-landscape answer. Exact-match caching of upstream API calls (already built in M2/M4) gives the real savings safely. |
| RAG / vector DB | **None — deliberately** | There is no private corpus. The live registries *are* the knowledge base and the rollup is deterministic code; retrieval here is tool calls, not embeddings. Adding a vector store would be résumé-driven architecture. |
| Multi-agent / A2A | **Rejected** | No genuine parallelism or context-isolation need; a supervisor would add latency, tokens, and error surface for nothing. |
| Model routing / cascade | **Single model (`claude-opus-5`) for now** | A cheap-model router for classification is a real cost lever at volume, but it's a cost/quality tradeoff to make with usage data, not upfront — flagged as a post-launch decision once Langfuse shows the traffic mix. |
| Durable execution | **Step Functions Standard for the scheduled monitor only** | The nightly watchlist run is a long-running, partially-failing, auditable workflow — exactly Step Functions' shape, and it sits naturally alongside the existing Terraform-managed ECS stack. Interactive chat needs no checkpointer; a turn is seconds, and transcripts make sessions reconstructable. |
| MCP | **Stretch: expose the tool surface as an MCP server** | The tools are already typed, read-only functions — wrapping them in an MCP server (Streamable HTTP) is cheap and makes Pipeline Radar's landscape data usable from Claude Desktop or any MCP client. Strong demo differentiator; same guardrails apply because the tools stay read-only. |

## Implementation phases (each independently demoable)

| Phase | Deliverable | Cut line |
|---|---|---|
| A | M5 deterministic layer: export renderer, watchlist store (localStorage → API), diff engine — pure functions + Jest, no AI yet | This is M5 shipped even if the agent slips |
| B | `/api/agent/chat`: tool runner + 4 data tools, SSE streaming, chat panel in the UI, trace logging from day one | Use case 1 demoable |
| C | `set_view` UI-copilot tool + brief generation/export + watchlist-diff narrative | Use cases 2–4; M5+M6 complete |
| D | Hardening: citation checker, golden-set evals in CI (pass^4, end-state asserts), Langfuse wired end-to-end, budget hard-block + kill switch | The "strong harness" story |
| E (stretch) | Rollup auditor (two-phase, human-in-the-loop), scheduled monitor via EventBridge → Step Functions → Fargate task, MCP server exposing the tool surface | Reuses everything above |

## Code sketch (Phase B core)

```ts
// api/src/agent/tools.ts
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const searchTrials = betaZodTool({
  name: "search_trials",
  description:
    "Search ClinicalTrials.gov for active trials of a condition. Call this before " +
    "answering any question about trials, counts, sponsors, or phases — never answer " +
    "from prior knowledge. Returns normalized trial rows plus totalCount.",
  inputSchema: z.object({
    condition: z.string().describe("Disease, e.g. 'lung cancer'"),
    phases: z.array(z.enum(["EARLY_PHASE1","PHASE1","PHASE2","PHASE3","PHASE4","NA"])).optional(),
    statuses: z.array(z.enum(["RECRUITING","ACTIVE_NOT_RECRUITING","NOT_YET_RECRUITING","ENROLLING_BY_INVITATION"])).optional(),
  }),
  run: async (input) => JSON.stringify(await ctgovSearch(input)), // cached, truncated
});

// api/src/agent/chat.ts — SSE endpoint
const runner = client.beta.messages.toolRunner({
  model: "claude-opus-5",
  max_tokens: 64000,
  stream: true,
  max_iterations: 8,
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  output_config: { effort: "medium" },
  tools: [searchTrials, summarizeTrials, buildDrugLandscape, checkFdaApproval, setView],
  messages: history,
});

for await (const stream of runner) {
  for await (const event of stream) forwardToSSE(res, event);   // text deltas to browser
  const msg = await stream.finalMessage();
  logTurn(traceId, msg);                                        // tracing hook
  if (msg.stop_reason === "refusal") return sseError(res, "declined");
}
```

Secrets: `ANTHROPIC_API_KEY` lands in the Fargate task via Secrets Manager, wired into the container definition in [CICD-PLAN.md](CICD-PLAN.md)'s `terraform/ecs.tf`; never shipped to the browser.

## Explicit non-goals (say them out loud)

- No agent-side writes to any external system; no computer use; no code execution.
- No fine-tuning or RAG store — the live APIs *are* the knowledge base, and the rollup logic is deterministic code.
- Chat history is per-session; **no long-term memory by design** — a persisted memory store would reopen the memory-poisoning attack surface (an injected "fact" steering future sessions) for a feature the product doesn't need yet.
- No LangChain, no vector DB, no semantic cache, no multi-agent — each rejected for a stated reason in the stack-decisions table, not by omission.
