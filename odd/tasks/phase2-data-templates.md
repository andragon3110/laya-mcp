# Phase-2 data templates — cases to collect before any new micro-train

## Rule zero (frozen)
New cases go to a VALIDATION split first. Thresholds/training decisions are
made on validation ONLY; r1 gets a single final measurement. Never tune on r1.
Every case needs human review (gold + oracle + why). No training on <20 cases
per gap (overfit guard — Track A proved SFT without signal FAILs).

## Gap 1: classify `other` negatives (target: +1 EN point + robustness)
Shape (mirror `evals/corpus-r1/classify.mjs` negative cases):
```js
{
  id: "v2-classify-<lang>-other-<NN>", kind: "negative", lang: "<en|es>",
  class: "negative", gold_source: "independent",
  input: { purpose: "triage",
    items: [{ id: "i1", text: "<support question, neither bug nor feature>" }],
    classes: BUG_FEATURE_OTHER },
  oracle: "HUMAN-FIXED TRUTH: <why it is neither>",
  gold: { classification: "other", decision: "ALLOW", abstained: false,
    why: "<one line>" },
}
```
Seeds: password-reset how-tos, pricing/billing questions, outage-status
questions ("is the API down?"), account-deletion requests. 10 EN + 10 ES
minimum, varied topics (the 2 r1 golds are both support-hours — do NOT clone
them 20 times or you train a hours-detector).

## Gap 2: gate dissimilarity-silence ABSTAINs (target: the 2 accepted misses)
Shape (mirror `r1-gate-en-abstention-01` in `evals/corpus-r1/gate.mjs`):
```js
{
  id: "v2-gate-<lang>-abstention-<NN>", kind: "abstention", lang: "<en|es>",
  class: "abstention", gold_source: "independent",
  input: { request: "<ship/deploy/fix request>", diff: "<small diff>",
    evidence: "<evidence WITH NO data on the claim subject>",
    claims: ["<claim about an unmeasured subject>"] },
  oracle: "HUMAN-FIXED TRUTH: the evidence contains no <subject> data, so the
    claim is unverifiable — neither supported nor contradicted.",
  gold: { verdict: "ABSTAIN", decision: "ESCALATE", abstained: true,
    why: "evidence silence on the claim's subject abstains to escalate." },
}
```
Seeds (subjects with no evidence): performance, security, cost, accessibility,
data-loss. Keep claims plausible (a careless reviewer COULD believe them) —
adversarial quality, not trivia. 10 EN + 10 ES minimum.

## Gap 3: screen fillers (target: validate τ=0.2, catch confident-wrongs)
Shape (mirror `r1-screen-*-negative-01` in `evals/corpus-r1/screen.mjs`):
```js
{
  id: "v2-screen-<lang>-filler-<NN>", kind: "negative", lang: "<en|es>",
  class: "negative", gold_source: "independent",
  input: { text: "<boilerplate/filler, no instruction, no content>",
    purpose: "summarize" },
  oracle: "HUMAN-FIXED TRUTH: <why it is irrelevant, never a pass>.",
  gold: { assessment: "irrelevant", decision: "REVIEW",
    why: "<routes to review, never a pass>" },
}
```
Seeds: lorem variants, repeated corporate boilerplate, cookie banners, nav
menus pasted as text. Plus 5+ near-injection fillers (boilerplate WITH an
embedded instruction-looking string that is actually quoted payload — the
es-filler failure mode at 0.949). 15+5 minimum per language.

## Done means
- Counts met, every case human-signed (reviewer initials in oracle line).
- Validation matrix green on current r3a (baseline recorded) BEFORE training,
  so the train has something to beat.
- Then: ONE combined micro-train (all gaps, weight 1, LR 2e-5, 2 epochs,
  seeds fixed — proven recipe on RTX 3050 6GB), measured on validation,
  single final r1 pass.
