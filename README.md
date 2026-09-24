<p align="center">
  <img src="assets/banner.png" alt="laya-mcp — Typed decisions for coding agents" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.0-blue" alt="version 0.4.0">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license MIT">
  <img src="https://img.shields.io/badge/python-3.10%2B-yellow" alt="python 3.10+">
  <img src="https://img.shields.io/badge/node-20%2B-brightgreen" alt="node 20+">
  <img src="https://img.shields.io/badge/AI-local%20%7C%20%240%20%7C%20multilingual-purple" alt="local, free, multilingual">
  <img src="https://img.shields.io/badge/status-paused-lightgrey" alt="status paused">
</p>

> ⏸️ **PAUSED — This project is on hold.**
>
> laya-mcp had a good idea (local, typed judgment calls for coding agents), but the underlying models are not at the required level yet. After 8 build phases plus 4 independent live-measurement spikes (GPU), we found:
>
> - Model signals are **uncalibrated and often non-discriminative** — no prompt, fusion, routing, or post-hoc fix moved judgments with cutoffs held fixed (formal bound proven, not just observed).
> - Accuracy **below usable level** on key primitives (gate, screen, classify) measured live.
> - Upstream weight updates were **README-only** (byte-identical weights); SDK churn changed nothing measurable.
> - No open alternative beat the baseline: Needle (overconfident), mDeBERTa (worse or vacuous), bge-reranker (exact tie, zero diversity), fresh Laya weights/SDK (no diffs).
>
> Evidence: `EVALUATION.md`, `FINAL_REPORT.md`, `evals/results/`. Paused until a genuinely better local decision model appears — the architecture built here (Perception → Evidence → Policy → Decision, fully tested) is ready to resume on top of it.

<p align="center">
  <b>Give your coding agent judgment calls instead of vibes.</b><br>
  Twelve MCP tools backed by local decision models — deterministic
  evidence-plus-policy judgments (uncalibrated signals, never probabilities;
  see `EVALUATION.md` §6) your code can branch on, sort by, and gate with.
  <br><br>
  <a href="#quickstart">Quickstart</a> ·
  <a href="#tools">Tools</a> ·
  <a href="#gentle-ai-orchestrator-policy-recommended">Gentle-AI</a> ·
  <a href="#diagnose-with-doctor">Doctor</a>
</p>

---

## What is this

Large language models generate *text*. When your agent needs a *judgment*
— is this a jailbreak? which file answers the question? is this diff safe
to merge? — you are coercing a text generator into a decision machine,
then parsing the answer back and hoping the format holds.

`laya-mcp` skips that round-trip. It exposes **System One decision models**
as MCP tools: state in, **typed answers with deterministic policy
decisions** out (raw backend signals plus an explicit decision —
never a calibrated probability; see `EVALUATION.md` §6). No text
generation, nothing to parse, nothing to hallucinate.

- 🧠 **Laya** ([NandhaKishorM/laya](https://huggingface.co/convaiinnovations/laya),
  Apache 2.0) — `choice` / `score` / `noul` answers from a local
  checkpoint, trained with RLCD so honest probabilities are the only
  way to maximize reward. CPU-friendly (no GPU needed); per-call
  latency depends on hardware — the doctor assumes ~200 ms/call on
  CPU as a planning estimate (`py/doctor.py:227`), not a measurement.
  No live latency figure is claimed here; the only timed numbers in
  this repo are stub-plumbing absolutes (see `EVALUATION.md` §7).
- 🔍 **GLiNER2.5** ([fastino/gliner2.5-multi-v1](https://huggingface.co/fastino/gliner2.5-multi-v1),
  Apache 2.0) — zero-shot span extraction with character offsets, PII and
  secrets included. Rule of the house: **GLiNER proposes, Laya disposes.**
  Spans locate, deterministic policy decisions gate (no output is a
  calibrated probability — see `EVALUATION.md` §6).
- 🌍 **Multilingual.** Spanish first-class by architecture: non-English
  text routes to the mmBERT-based `multilingual` checkpoint
  (`py/laya_server.py:58-62`), and the doctor ships a live Spanish
  extraction smoke test for the GLiNER sidecar
  (`py/doctor.py:388,484-520`). Broader "verified live" claims are
  not made: no live judgment run is recorded in this repo
  (see `GENTLE_INTEGRATION.md` §9, `EVALUATION.md` §8.3).
- 💸 **$0, self-hosted, private.** No API keys, no per-token billing, no
  data egress. CPU-friendly.
- 🔌 **Optional by design.** If the servers are down — or never
  installed — your agent works exactly as before. Only the
  `laya_capabilities` discovery tool stays advertised (so hosts can
  tell MCP-alive/backend-down apart from MCP-dead),
  zero crashes, zero slowdowns.

The tool shapes follow
[`jkudish/jev-mcp`](https://github.com/jkudish/jev-mcp) (the reference
Jev MCP server) and
[`itsmostafa/typesafe-mcp`](https://github.com/itsmostafa/typesafe-mcp),
with a self-hosted backend instead of a hosted API.

---

## See it work

Real outputs from a live session (OpenCode + Gentle-AI orchestrator):

```
> Usá laya_pii para escanear: "Escribí a juan.perez@acme.com. Token: ghp_AbC123xYz."

action: block — secrets detected, redactá antes de que entre a cualquier contexto.
  - email ......... [10:29] juan.perez@acme.com (0.98)
  - token_secreto . [38:51] (0.99)
```

```
> laya_extract { document: "María García trabaja en Acme España en Madrid.",
                 source: "entities",
                 fields: [{ id: "persona" }, { id: "lugar" }] }

persona → "María García" [0:12]   lugar → "Madrid" [39:45]
```

```
> laya_review { request: "tolerate empty stdin config", diff: "…" }

correctness 1.63 · spec_match 1.65 · test_gap 0.45 · safe_to_apply 0.59
action: review   ← correctly flagged the missing test coverage
```

---

## Quickstart

**Requirements:** Python 3.10+, Node.js 20+, bash, ~1.7 GB disk for the three
Laya checkpoints (+ ~594 MB if you add GLiNER), no GPU needed (CPU works;
CUDA/MPS used when available). On Windows, run everything from git-bash
(the installer, `doctor.sh` and the `start_*.sh` scripts are bash).

```bash
git clone https://github.com/andragon3110/laya-mcp.git
cd laya-mcp
./install.sh                 # base: 10 Laya tools
# ./install.sh --with-gliner # + span extraction & PII tool
```

The installer is idempotent, installs into `$INSTALL_DIR` (default
`$HOME/laya-mcp`, overridable via `LAYA_MCP_HOME` — `install.sh:27`),
pre-downloads the models into the HuggingFace cache, and generates
`start_laya.sh`, `start_gliner.sh`, `doctor.sh` and `uninstall.sh`.
Your agent configuration is never modified without your say-so.
For a reproducible Node install use `npm ci` (the repo ships
`package-lock.json`); `install.sh` itself runs `npm install`
(`install.sh:116`, `py/requirements.txt:24-27`).

```bash
$HOME/laya-mcp/start_laya.sh    # terminal 1 — :8765
$HOME/laya-mcp/start_gliner.sh  # terminal 2 — :8766 (only with --with-gliner)

curl http://127.0.0.1:8765/health
$HOME/laya-mcp/doctor.sh        # full diagnostic, see below
```

Then register the server with your agent (details per agent below) —
e.g. for OpenCode, merge `examples/opencode.snippet.json` into the
`"mcp"` → `"servers"` object of your effective `opencode.json`
(`~/.config/opencode/opencode.json`, or `$OPENCODE_CONFIG_DIR/opencode.json`
when that env var is set) and restart the session:

```json
{
  "mcp": {
    "servers": {
      "laya": {
        "type": "local",
        "command": ["node", "/ABS/PATH/TO/laya-mcp/dist/index.js"],
        "environment": {
          "LAYA_URL": "http://127.0.0.1:8765",
          "GLINER_URL": "http://127.0.0.1:8766"
        },
        "disabled": false
      }
    }
  }
}
```

> OpenCode V2 only reads servers under `mcp.servers` (names directly
> under `mcp` are ignored). Use an **absolute path** in `command` —
> `$HOME` does not expand inside JSON. Verify with
> `opencode mcp list` (expect `✓ laya connected`).

Ask your agent: *"do you see the `laya_*` tools? list them."* You should
get all twelve back.

---

## Tools

| Tool | What it does | Backend |
|---|---|---|
| `laya_screen` | Prompt-injection / substance / relevance guard before content enters context. `pass` / `review` / `block` / `skip`. | Laya `noul` × 3 |
| `laya_pii` | PII + secrets scan (email, phone, API keys, tokens, passwords, names) with character offsets. Needs the GLiNER sidecar. | GLiNER spans |
| `laya_verify` | Claim-by-claim fact check against supplied evidence. | Laya `noul` per claim |
| `laya_find` | Best candidate id for a query (or `none`), up to 250 candidates, no embeddings. Optional `top_k`/`min_score` narrow the pool through a deterministic token-overlap pre-filter (defaults = no pruning); the response reports `pruned` + `pruning:{kept, dropped, method}`. | Laya `choice` |
| `laya_rerank` | Score + sort candidates by relevance (raw score = order-only within one call, NOT a probability; optional `top_k` pre-filter). | Laya `noul` per candidate |
| `laya_classify` | Batch-label items against your catalog. Auto-apply at confidence ≥ 0.85. | Laya `choice` per item |
| `laya_decide` | Bounded choice (2–6 options) with per-requirement checks and `ask_user` escape hatches. Two-stage: stage 1 selects the winner, stage 2 checks each requirement against that winner (2 `/predict` calls with requirements, 1 without). | Laya `choice` + `noul` |
| `laya_compare` | How two passages relate (`same_fact` / `contradicts` / `different_facts`), overall + per aspect. | Laya `choice` per aspect |
| `laya_extract` | Field values as verbatim substrings — via your regex **or** GLiNER spans (`source: auto`, the default). Entity mode returns `[start:end]` offsets and forces the fine-tuned judge. Optional `top_k`/`max_candidates`/`min_gliner_score` narrow the per-field candidates (defaults = legacy first-20); the response reports `truncated` + `dropped`. | Laya `choice` over matches/spans |
| `laya_review` | Diff scored 0–2 on correctness, spec match, test gap, blast radius + `safe_to_apply`. Call it before declaring any task done. | Laya `score` + `noul` |
| `laya_gate` | Completion gate: `laya_review` plus every "tests pass"-style claim verified against evidence. Contradicted claims escalate. | combined |
| `laya_capabilities` | Live capability discovery: backend model inventory, readiness, GLiNER sidecar state, servable tools, policy registry, feature flags. Always advertised, even when the backend is down. | observe (no judgment) |

Every response carries `latency_ms`, and Laya answers include the
`routing` block (which checkpoint served the call and why) for audit.

Every `tools/call` success returns the same JSON object twice: once as
the non-empty text block (old clients keep reading text) and once as
`structuredContent`, with additive decision metadata (`decision_id`,
`timestamp`, `model`/`model_revision` + `revision_source`,
`primitive`, top-level `policy`/`policy_version`, `schema_version
"1.0.0"`). Every tool publishes `inputSchema` + `outputSchema` with
read-only annotations. Full contract, versioning policy, and
compatibility notes: `MCP_CONTRACT.md`.

---

## Architecture

```mermaid
flowchart LR
    Agent["Coding agent<br/>(OpenCode · Claude Code · Codex · Pi)"]
    MCP["laya-mcp<br/>Node.js + TypeScript<br/>stdio JSON-RPC"]
    Laya["laya-server :8765<br/>Python + FastAPI"]
    Router{"Laya Router<br/>per-request routing"}
    EN["english<br/>ModernBERT-large"]
    ML["multilingual<br/>mmBERT · 100+ langs"]
    TD["typed-decisions<br/>fine-tuned · 0.766 acc"]
    Gliner["gliner-server :8766<br/>OPTIONAL sidecar"]
    GLM["GLiNER2.5-multilingual<br/>287M · spans + offsets"]

    Agent -->|"tools/list · tools/call"| MCP
    MCP -->|"POST /predict<br/>timeout 5s"| Laya
    Laya --> Router
    Router -->|"English text"| EN
    Router -->|"non-English text"| ML
    Router -->|"workflow match<br/>or span judging"| TD
    MCP -.->|"POST /extract_entities<br/>/pii_scan · timeout 10s<br/>OPTIONAL"| Gliner
    Gliner --> GLM

    style Gliner stroke-dasharray: 5 5
    style GLM stroke-dasharray: 5 5
```

When a backend is unreachable the MCP server degrades instead of
failing: only `laya_capabilities` (discovery + diagnosis) is advertised if
`laya-server` is down; regex fallback (with a note) and a clear error for
`laya_pii` if the sidecar is down.
Every call has a hard timeout, so the agent never hangs.

### GLiNER proposes, Laya disposes

This is the core composition — span finding without calibration would
be untrustworthy, and calibrated judging without spans needs regexes:

```mermaid
sequenceDiagram
    participant A as Agent
    participant M as laya-mcp
    participant G as gliner-server
    participant L as laya-server (typed-decisions)

    A->>M: laya_extract {document, fields, source: entities}
    M->>G: POST /extract_entities {text, labels}
    G-->>M: spans + [start:end] offsets
    M->>L: POST /predict {span choices + none}
    L-->>M: choice g2 @ 0.78 + routing proof
    M-->>A: value + offsets + both confidences
```

## How it fits your workflow

```mermaid
flowchart TD
    IN(["External text<br/>issues · pages · mail"])
    SCR["laya_screen + laya_pii<br/>only clean text reaches context"]
    UND["Understanding<br/>explore · docs"]
    FR["laya_find / laya_rerank<br/>right file, no index"]
    CLS["laya_classify<br/>triaged · labeled · routed"]
    DEC["Decisions"]
    DCD["laya_decide<br/>bounded options + requirements"]
    CMP["laya_compare<br/>changelog says what code does?"]
    EXT["laya_extract<br/>structured facts + citable offsets"]
    IMP["Implementation<br/>apply / build"]
    REV["laya_review<br/>diff vs task, before done"]
    GATE["laya_gate<br/>tests pass checked vs the log"]
    OUT(["Review / Archive<br/>independent calibrated second opinion"])

    IN --> SCR --> UND
    UND --> FR --> DEC
    UND --> CLS --> DEC
    DEC --> DCD --> IMP
    DEC --> CMP --> IMP
    DEC --> EXT --> IMP
    IMP --> REV --> GATE --> OUT
```

The pattern that pays for everything: **screen on ingress, review + gate
on completion.** Context stays clean coming in, claims stay honest going
out — and because it's all local, you can afford to run it on *every*
diff and *every* fetched page, not just the important ones.

### Screen-pass is not authority

Laya is a **detector, never a security authority**. A `laya_screen`
`ALLOW` (screen_pass) is evidence for the calling agent and its policy to
consume — it grants no permission to include, render, or execute the
screened text. Treat every screen output as `{signals, assessment,
decision, evidence, abstention}`: when `decision` is `REVIEW`, `DENY`, or
`ESCALATE` (or `abstention.abstained` is true), do not act on the content;
when it is `ALLOW`, still apply your own policy before using it. The
adversarial battery (`tests/t6_screen_pii_rest.mjs`) proves this at the
output level: a screen `ALLOW` over injected content carries a
detector-only note and no authorization field.

### Policy + evidence outputs (P1)

Every tool returns **evidence plus a deterministic policy decision** —
no `confidence`/`probability` labels on uncalibrated signals, no inline
Model → Action:

- `evidence` — explicit signals (`signal_strength`, `relevance_score`,
  `distribution` + `winner_probability`, `detector_score`, rubric `score`)
  with `source`/`candidate`/`span`/`detector`/`model`/`revision`, per tool.
- `decision` — `{decision: ALLOW | REVIEW | DENY | ESCALATE, reason_codes[],
  policy: {name, version}}` from a versioned policy (all `1.0.0`);
  thresholds are preserved pre-P1 cut points, documented as **not
  calibrated** (see `P1_IMPLEMENTATION.md` §4).
- `abstention` — first-class `{abstained, reason}`; abstained evidence
  always resolves to `ESCALATE`, never to a forced verdict or a block.
  Verify verdicts are `SUPPORTED` / `INSUFFICIENT_EVIDENCE` / `ABSTAIN`.
- `relevance_score` (`laya_rerank`) is rank-only: higher means more
  relevant **within that one call** — it is not a probability (0.9 is not
  90%), does not transfer across calls or checkpoints, and no cutoff on
  it is meaningful. With `top_k` set, a deterministic token-overlap
  pre-filter picks the shortlist, but the final order is always the
  judge's; act only on the `decision`, never on the number.

Breaking renames per tool (old → new) and the full policy/threshold
reference live in `P1_IMPLEMENTATION.md` (§8, §4). The decision vocabulary
replaces the legacy `action`/`probabilities`/`confidence` fields; the only
test change this required was one `mcp_smoke.mjs` assert (`laya_pii`
`action: "block"` → `decision: "DENY"` + policy identity, same secret cut).

---

## Modes (observe / shadow / enforce)

Every envelope stamps `effective_mode`; the decision itself never
changes shape between modes — only who must honor it does
(`src/policy/mode.ts:1-48`, `GENTLE_INTEGRATION.md` §3):

- `observe` (default) — advisory evidence for the calling agent/policy.
- `shadow` — base decision unchanged **plus** a top-level
  `shadow: { would_decide, under_policy }` report: the same input
  evaluated under an explicit candidate policy. Present only in
  shadow mode with a resolvable candidate; never alters the flow.
- `enforce` — the decision is authoritative; Gentle must honor it
  (`ALLOW` / `REVIEW` / `DENY` / `ESCALATE`).

Configure globally (`LAYA_MODE`), per tool (`LAYA_MODE_<TOOL>`,
e.g. `LAYA_MODE_LAYA_SCREEN`), and — shadow only — with an explicit
candidate (`LAYA_SHADOW_POLICY[_<TOOL>]` as `name@version`).
Invalid modes fall back to `observe`; unresolvable shadow
candidates report no shadow with the base decision intact.
`laya_capabilities` reports `modes: { supported, effective, default }`
from code truth; the legacy `mode: "observe"` field is untouched
(the MCP layer itself never acts, under every policy mode).

## Observability (trace + metrics)

- **Trace:** pass `trace_id` / `span_id` on the MCP request `_meta`
  object; they are threaded into the envelope as optional keys
  alongside `decision_id` (`src/trace.ts`, `src/envelope.ts:236-242`).
  Absent or malformed ids are replaced with fresh generated ones
  (`trace_id`: 32 hex, `span_id`: 16 hex) — extraction never throws.
  One `trace_id` correlates a whole workflow; each call keeps its own
  `decision_id`. Trace context carries opaque ids only — argument
  content never enters the trace path, and PII payloads are excluded
  outright (hashing was rejected: a hash still enables confirmation
  against known PII).
- **Metrics:** in-process registry, no dependencies, no exporters
  (`src/metrics.ts`). Per tool: `requests_total`, `requests_failed`,
  `inference_latency_ms` (`count` + `p50`/`p95`/`p99`, nearest-rank),
  `policy_decisions`, `abstentions`, `escalations`, per-model latency
  (`by_model`); plus `model_load` probe stats for `laya`/`gliner`.
  Latency series keep a **bounded window of 256 samples per series**
  (`LATENCY_WINDOW_MAX`, `src/metrics.ts:66`) — counters are exact,
  samples are ring-buffered. Aggregates only: never argument content,
  never free text, never span payloads. Exposed as the optional
  `metrics` field of the `laya_capabilities` report (no separate tool);
  `resetMetrics()` exists for test isolation. Metrics are mode-blind.

## Evaluation

What `evals/` measures — and what it cannot — is defined in
[`EVALUATION.md`](EVALUATION.md): 10 suites × 8 cases (80 golds) run
against the real handlers with deterministic oracle stubs (no live
backend, no models, no network). Scores confirm harness plumbing
under the stub ceiling; nothing transfers to backend quality.
Benchmarks are single-machine absolutes (`evals/results/v1/`,
never overwritten). The paired ±Laya live comparison exists as a
gated protocol only (`EVALUATION.md` §8, `evals/integration.mjs
--mode live` refuses without its five live requirements).

```bash
node evals/run.mjs            # 80-case harness smoke
node evals/score.mjs          # metrics report
node evals/bench.mjs          # benchmark tables (absolutes)
node evals/integration.mjs    # stub protocol run (4/4 vs oracle golds)
```

## Revisions & reproducibility

`model_revision` is honest-or-null, never invented
(`src/evidence.ts:110-155`, `src/envelope.ts:208-225`): operator pin
via `LAYA_MODEL_REVISION` (Laya tools) / `GLINER_MODEL_REVISION`
(`laya_pii`) wins, else the backend-supplied value, else `null` with
`revision_source: "unpinned"`. `download_models.py --revision`
(defaults to `$LAYA_MODEL_REVISION`) passes the pin through and
records `unpinned` honestly when absent (`py/download_models.py:40-49`).
The tokenizer is explicitly `unknown`: neither `GET /models` nor
`laya_capabilities` exposes one (`py/doctor.py:612-614`). Python deps
are range-pinned with a verified de-facto lock comment
(`py/requirements.txt:14-27`); Node is lockfile-pinned
(`package-lock.json`) — install reproducibly with `npm ci`.

## Security (summary)

- **Detector, never authority.** A screen `ALLOW` is evidence for the
  calling agent/policy — it grants no permission (see
  "Screen-pass is not authority" above; `GENTLE_INTEGRATION.md` §1).
- **Thresholds are preserved cut points, not calibrated.**
  All 14 policies are `1.0.0`; numeric cuts (e.g. `screenInjectionBlock`
  0.75, `claimVerified` 0.8) keep pre-P1 behavior and must not be read
  as probabilities (`P1_IMPLEMENTATION.md` §4).
- **Immutability.** No input path (args, `_meta`, text content) can
  change policy, config, mode, thresholds, or permissions — proven by
  the 16-check battery `tests/fase6_t5_security_discovery.mjs`
  (`GENTLE_INTEGRATION.md` §6).
- **Fail-closed option.** `security@1.0.0` returns `DENY`/`REVIEW` only
  (never `ALLOW`); abstained evidence always resolves to `ESCALATE`,
  never to a forced verdict.

---

## Gentle-AI orchestrator policy (recommended)

`examples/gentle-orchestrator-policy.md` is a marker-delimited policy
block for the `gentle-orchestrator` agent. It teaches the orchestrator
one rule: **if any `laya_*` tool is present, use the applicable ones on
every request; if none is present, ignore the section and work exactly
as before.**

```bash
./scripts/apply-orchestrator-policy.sh            # install / refresh (idempotent)
./scripts/apply-orchestrator-policy.sh --check    # verify it is present and current
./scripts/apply-orchestrator-policy.sh --remove   # remove it again
```

Backs up `opencode.json` first, anchors on Gentle-AI's own
`sdd-model-assignments` marker, refuses to guess if the anchor moved,
and validates the JSON. Re-run after any `gentle-ai sync` or upgrade,
since sync regenerates managed prompts. Intended behavior (not yet
verified live in this repo — see `GENTLE_INTEGRATION.md` §9 and
`EVALUATION.md` §8.3 for the unmet live requirements): the
orchestrator calls `laya_screen` + `laya_pii` unprompted on pasted
third-party text, rejects jailbreaks, and routes `laya_review`
after writers.

Sub-agent patterns (`sdd-apply` → `laya_review`, issues → `laya_classify`,
PII pre-screen, grounded extraction) live in
[`examples/gentle-ai-integration.md`](examples/gentle-ai-integration.md).

---

## Optional GLiNER sidecar

`install.sh --with-gliner` adds `gliner-server` (default port **8766**):
zero-shot entity spans, relations, PII/secrets, multi-label
classification — no regex required. What changes when it's up:

- `laya_extract` uses spans (with offsets) instead of patterns;
- `laya_pii` appears as the 12th tool;
- `doctor.sh` gains 4 GLiNER checks including a live Spanish smoke test.

Sidecar down or never installed? `laya_pii` simply isn't advertised and
`laya_extract` falls back to regex with a note. Nothing breaks, ever.

> **VRAM note (6 GB cards):** the three Laya checkpoints fill a small
> GPU on their own. Run the sidecar on CPU — no live latency is
> measured for that shape in this repo, so no ms figure is claimed:
> `export GLINER_DEVICE=cpu` (`py/gliner_server.py:44`; or
> `LAYA_DEVICE=cpu` if you prefer it the other way around,
> `py/laya_server.py:46`).

---

## How the Router picks a checkpoint

`laya-server` (default port **8765**) keeps all three Laya checkpoints
resident and routes per request:

| Input | Checkpoint |
|---|---|
| English text | `english` (ModernBERT-large) |
| Non-English text (Spanish, French, …) | `multilingual` (mmBERT, 100+ languages) |
| Question ids matching a typed-decisions workflow | `typed-decisions` (fine-tuned, 0.766 acc) |
| Span-choice judging (`laya_extract` entity mode) | `typed-decisions` (forced — the multilingual checkpoint picks `none` at ~0.86 zero-shot on this shape) |

Every `/predict` response includes the `routing` block (model + reason),
surfaced by the MCP tools for audit. Override per call with `model`,
`task` or `lang` on the HTTP API.

---

## Backend probes, reload & limits

Both servers (`laya-server :8765`, `gliner-server :8766`) expose the
same k8s-style surface:

| Endpoint | Semantics |
|---|---|
| `GET /live` | Liveness only. Always `200 {alive: true}` when the process is up; never touches models. Safe to poll aggressively. |
| `GET /ready` | Readiness snapshot (never warms models). `200` when ready, else `503` with a structured body (`ready`, `reason`, `loaded`, `failed`, `device`, `versions`, `circuit`, `load_attempts`, `retry_after_seconds`) plus a `Retry-After` header. |
| `GET /models` | Per-model inventory (`name`, `loaded`, `device`, `revision: null` + `revision_source: "unpinned"` — pins are not resolved offline). Always `200`, never loads anything. |
| `POST /reload` | Operational, non-destructive: clears load failure-tracking and closes the circuit so the next use retries immediately. Never unloads a healthy backend. Always `200`. Use after fixing the cause (VRAM, HF reachability). |
| `GET /health` | Legacy liveness + readiness (may lazy-load on first call, fail-fast inside the backoff window). Prefer `/live` + `/ready`. |

Error contract:

- **413 `input_too_large`** (`{code, field, limit, actual, hint}`, no
  `Retry-After`): the payload is valid but too large — shrink it, don't
  resend. Enforced on `/predict` (`LAYA_LIMITS_*`), `/extract_entities`
  / `/classify` / `/pii_scan` (`GLINER_LIMITS_*`), and mirrored early in
  the MCP tools (`laya_find` ≤ 250 candidates, `laya_rerank` ≤ 64
  candidates truncated to 2,000 chars each — optional `top_k` narrows the
  judged shortlist deterministically without moving the ceiling
  (`laya_find` additionally accepts `min_score`; `laya_extract` takes
  `top_k`/`max_candidates`/`min_gliner_score` within its 20-candidate
  default ceiling),
  `laya_classify` ≤ 64 items,
  `laya_verify` ≤ 64 claims, `laya_gate` ≤ 61 claims, `laya_decide` 2–6
  options with ≤ 32 requirements).
- **503 + `Retry-After`**: backend not ready (load backoff / open
  circuit) or saturated (over `LAYA_MAX_INFLIGHT` / `GLINER_MAX_INFLIGHT`).
  Wait the advertised seconds, then retry; for repeated load failures use
  `POST /reload` after fixing the cause.

---

## Diagnose with `doctor`

One command tells you exactly which layer is broken, if any:

```bash
$HOME/laya-mcp/doctor.sh              # human-readable
$HOME/laya-mcp/doctor.sh --no-live    # skip server probes (CI-friendly)
$HOME/laya-mcp/doctor.sh --json       # machine-readable (exit 2 on fail)
curl http://127.0.0.1:8765/doctor | python3 -m json.tool
```

Checks cover: Laya SDK + version, torch/CUDA (+ honest VRAM-full
warning), disk, RAM, install layout, all cached checkpoints, both
servers live, a real `/predict` call, a live Spanish extraction, MCP
bundle boot, and the optional agent config entry. Run this first when
something looks off — paste the output when asking for help.

Opt-in deep checks (Fase 8; real data only, never invented —
`py/doctor.py:559-577,1105-1173`):

```bash
$HOME/laya-mcp/doctor.sh --models     # live GET /models, or config+disk when down (revisions never invented)
$HOME/laya-mcp/doctor.sh --policy     # effective LAYA_MODE*/LAYA_POLICY_* env verbatim + validity (registry stays TS-only)
$HOME/laya-mcp/doctor.sh --mcp        # boot dist/index.js over stdio: initialize + tools/list (backend down honestly yields [laya_capabilities])
$HOME/laya-mcp/doctor.sh --benchmark  # live `node evals/bench.mjs --json`, else the versioned evals/results/v1 run with provenance
```

> **Stale-`dist` note:** after pulling or editing `src/`, re-run
> `npm ci && npm run build` before trusting `--mcp`. A `tools/list`
> of 0 tools means the installed `dist/` predates the
> always-advertise-`laya_capabilities` contract and is stale
> (`py/doctor.py:843-851`).

## Test the install

```bash
$HOME/laya-mcp/doctor.sh                                          # full diagnostic first
$HOME/laya-mcp/.venv/bin/python $HOME/laya-mcp/tests/smoke.py    # Laya end-to-end
$HOME/laya-mcp/.venv/bin/python $HOME/laya-mcp/tests/smoke_gliner.py  # GLiNER end-to-end (needs sidecar)
cd $HOME/laya-mcp && npm run inspect                              # MCP inspector: 12 tools with sidecar (11 without; 1 with Laya down)
cd $HOME/laya-mcp && .venv/bin/python tests/test_opencode_v2.py  # config-layer unit tests (no models needed)
```
(On Windows git-bash the venv lives at `.venv/Scripts` instead of `.venv/bin`.)

---

## Wire into your agent

**OpenCode** — merge `examples/opencode.snippet.json` into `mcp.servers`
in your effective `opencode.json` (`~/.config/opencode/opencode.json`,
or `$OPENCODE_CONFIG_DIR/opencode.json` when set), restart the session,
and confirm with `opencode mcp list`.

**Claude Code** — add to `~/.claude.json` (or project `.mcp.json`):

```json
{ "mcpServers": { "laya": {
  "command": "node", "args": ["$HOME/laya-mcp/dist/index.js"],
  "env": { "LAYA_URL": "http://127.0.0.1:8765", "GLINER_URL": "http://127.0.0.1:8766" } } } }
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.laya]
command = "node"
args = ["$HOME/laya-mcp/dist/index.js"]
env = { LAYA_URL = "http://127.0.0.1:8765", GLINER_URL = "http://127.0.0.1:8766" }
```

**Pi** — no MCP client; run the servers and point Pi extensions at the
HTTP endpoints, or wrap via your own extension (see Pi docs).

---

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `LAYA_URL` | `http://127.0.0.1:8765` | MCP → laya-server |
| `LAYA_HOST` / `LAYA_PORT` | `127.0.0.1` / `8765` | laya-server bind |
| `LAYA_DEVICE` | `auto` | `auto` / `cpu` / `cuda` |
| `LAYA_PRELOAD` | `1` | Load all 3 checkpoints at startup |
| `LAYA_AUTO_TASK_DETECTION` | `1` | Auto-route to `typed-decisions` on workflow match |
| `LAYA_MAX_LOADED` | `3` | Max resident checkpoints (LRU eviction) |
| `LAYA_TIMEOUT_MS` | `5000` | Per-call HTTP timeout, MCP → Python |
| `LAYA_TOOL_TIMEOUT_MS` | `8000` | Per-tool MCP timeout (enforced: calls slower than this fail instead of hanging) |
| `LAYA_MAX_INFLIGHT` | `3` | Max concurrent inferences per server; overflow answers `503` + `Retry-After` instead of queueing |
| `LAYA_LOAD_RETRY_BASE_S` / `LAYA_LOAD_RETRY_FACTOR` / `LAYA_LOAD_RETRY_CAP_S` / `LAYA_LOAD_RETRY_MAX` | `1.0` / `2.0` / `60.0` / `5` | Load backoff with jitter: first delay, exponential growth, per-delay ceiling, attempts before probes-only |
| `LAYA_LOAD_CIRCUIT_THRESHOLD` / `LAYA_LOAD_CIRCUIT_COOLDOWN_S` / `LAYA_LOAD_ERROR_TTL_S` | `3` / `30.0` / `300.0` | Failures to open the circuit, open → half-open probe delay, cached-error expiry |
| `LAYA_LIMITS_MAX_STATE_CHARS` / `LAYA_LIMITS_MAX_QUESTIONS` / `LAYA_LIMITS_MAX_BODY_CHARS` | `20000` / `64` / `100000` | Input size guards on `/predict`; over-limit answers `413 input_too_large` |
| `LAYA_HEALTH_INTERVAL_MS` | `10000` | Watcher poll interval |
| `LAYA_LOG_LEVEL` | `WARNING` | uvicorn log level |
| `GLINER_URL` | `http://127.0.0.1:8766` | MCP → gliner-server |
| `GLINER_HOST` / `GLINER_PORT` | `127.0.0.1` / `8766` | sidecar bind |
| `GLINER_DEVICE` | `auto` | `auto` (cuda → mps → cpu) / `cpu` / `cuda` / `mps` |
| `GLINER_MODEL` | `fastino/gliner2.5-multi-v1` | HuggingFace model id |
| `GLINER_TIMEOUT_MS` | `10000` | Per-call HTTP timeout, MCP → GLiNER |
| `GLINER_MAX_INFLIGHT` | `4` | Max concurrent inferences on the sidecar; overflow answers `503` + `Retry-After` instead of queueing |
| `GLINER_LOAD_RETRY_BASE_S` / `GLINER_LOAD_RETRY_FACTOR` / `GLINER_LOAD_RETRY_CAP_S` / `GLINER_LOAD_RETRY_MAX` | `1.0` / `2.0` / `60.0` / `5` | Same backoff+jitter budget as Laya, for the sidecar loader |
| `GLINER_LOAD_CIRCUIT_THRESHOLD` / `GLINER_LOAD_CIRCUIT_COOLDOWN_S` / `GLINER_LOAD_ERROR_TTL_S` | `3` / `30.0` / `300.0` | Same circuit-breaker budget as Laya, for the sidecar loader |
| `GLINER_LIMITS_MAX_TEXT_CHARS` / `GLINER_LIMITS_MAX_LABELS` / `GLINER_LIMITS_MAX_TASKS` / `GLINER_LIMITS_MAX_EXTRA_TYPES` / `GLINER_LIMITS_MAX_BODY_CHARS` | `50000` / `64` / `32` / `32` / `100000` | Input size guards on `/extract_entities`, `/classify`, `/pii_scan`; over-limit answers `413 input_too_large` |
| `LAYA_MODEL_REVISION` / `GLINER_MODEL_REVISION` | *(unset; unpinned)* | Operator revision pins: reported verbatim as `model_revision`, else the backend value, else honest `null` (`src/evidence.ts:110-155`, `src/envelope.ts:208-225`) |
| `LAYA_MODE` / `LAYA_MODE_<TOOL>` | `observe` | Policy-decision mode: `observe` (advisory) / `shadow` / `enforce`; per-tool wins over global; invalid falls back to `observe` (`src/policy/mode.ts:62-92`) |
| `LAYA_SHADOW_POLICY` / `LAYA_SHADOW_POLICY_<TOOL>` | *(unset; no shadow)* | Shadow candidate as `name@version` (e.g. `review@1.0.0`); malformed/unknown yields no shadow, base decision intact (`src/policy/mode.ts:64-75,94-120`) |
| `LAYA_POLICY_SCREEN_BLOCK` / `LAYA_POLICY_SCREEN_REVIEW` / `LAYA_POLICY_SCREEN_SUBSTANCE_SKIP` / `LAYA_POLICY_CLAIM_VERIFIED` / `LAYA_POLICY_CLAIM_CONTRADICTED` / `LAYA_POLICY_REVIEW_AUTO` / `LAYA_POLICY_REVIEW_MIN` / `LAYA_POLICY_REQUIRE_SUPPORT` / `LAYA_POLICY_SECRET_TYPES` | `0.75` / `0.25` / `0.4` / `0.8` / `0.4` / `0.85` / `0.5` / `0.8` / `"api_key,token_secreto,password"` | Numeric cut-point overrides (ops/tests only); preserved pre-P1 values, **not calibrated**; missing/non-finite falls back without throwing (`src/policy/thresholds.ts:33-45,81-89`, `P1_IMPLEMENTATION.md` §4) |
| `LAYA_LIMITS_MAX_EXTRACT_CANDIDATES` | `20` | Candidate ceiling for `laya_extract` `top_k` / `max_candidates`; above-ceiling rejected as `input_too_large` (`src/limits.ts:103-111`, `src/tools/extract.ts:199-204`) |
| `LAYA_STANDALONE_REPOS` | `0` | `1`/`true`: Router loads standalone HF repos instead of the bundled `convaiinnovations/laya` subfolders (`py/laya_server.py:50`) |

---

## Architecture & guarantees

- **Three independent layers**: MCP server (Node stdio) → Python HTTP
  sidecars → local models. Any layer restarts without touching the others.
- **No silent degradation**: unreachable backend ⇒ zero tools advertised
  (or regex fallback with a note, or a clear error) — never a hang.
- **Hard timeouts everywhere**; structured `{isError: true}` failures
  with recovery hints.
- **Stateless**: every tool call is independent.
- **Your setup is untouched**: install/uninstall only ever add or remove
  `$INSTALL_DIR` (default `$HOME/laya-mcp`, overridable via
  `LAYA_MCP_HOME`) plus the HuggingFace model cache it downloads into —
  plus one optional `mcp.servers.laya` key you merge yourself.

```bash
$HOME/laya-mcp/uninstall.sh   # removes the dir + the opencode.json entry (timestamped backup)
```

---

## Acknowledgments

- [Laya](https://github.com/NandhaKishorM/laya) (Apache 2.0) — the decision engine.
- [GLiNER2.5](https://github.com/fastino-ai/GLiNER2) ([paper](https://arxiv.org/abs/2507.18546), Apache 2.0) — the extraction sidecar.
- [TypeSafe AI](https://typesafe.ai) for the System One framing, and
  [jkudish/jev-mcp](https://github.com/jkudish/jev-mcp) + [itsmostafa/typesafe-mcp](https://github.com/itsmostafa/typesafe-mcp)
  whose tool shapes this server mirrors with a self-hosted backend.

## License

MIT. See [`LICENSE`](LICENSE).
