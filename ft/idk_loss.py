"""Regulus WS-C F2 spike: abstention-aware IDK loss (CHOSEN objective).

Chosen design: Controlled Abstention Network (CAN)-style IDK loss over the
existing GLiClass multi-label base loss.

Per-row loss (B = batch, K = labels, K varies per row so everything below
is K-agnostic)::

    base_b   = mean over labels of BCE-with-logits (or focal) on row b
    q_b      = sigmoid(AbstentionHead(uncertainty_features(logits_b)))
    L_b      = (1 - q_b) * base_b + C * q_b            (C = abstention cost)
    loss     = mean_b L_b

Why this fits GLiClass multi-label scoring best
- No scorer surgery: GLiClass emits per-label logits for a *variable*
  label set per row (``all_labels`` conditioning); the head consumes only
  K-agnostic uncertainty summaries (max prob, mean binary entropy,
  top-1/top-2 margin), so zero-shot variable-K rows keep working.
- Maps directly onto the lineage ABSTAIN convention (empty ``true_labels``
  = all-zero targets): those rows teach low scores through ``base_b``
  while uncertain rows are down-weighted by ``(1 - q_b)``.
- The gradient direction is exactly the desired policy: dL/dq = C - base,
  so rows with base > C learn to abstain (q -> 1) and rows with base < C
  learn to commit (q -> 0). No degenerate always-abstain optimum as long
  as C sits above confident-correct base (~0.05) and below ambiguous base
  (~0.64 on the BCE scale) -- see ``--demo``.

Deferred alternatives (documented, not implemented here)
- Deep Abstaining Classifier (extra abstention logit in the scorer):
  needs scorer-architecture surgery and a fixed (K+1) output, which breaks
  the variable-``all_labels`` zero-shot conditioning. See recipe note in
  ``odd/tasks/objective-spike.md``.
- Selective prediction + error regularization: reference implementation
  kept in ``ft/selective_loss.py`` (DEFERRED header). Needs a coverage
  target plus extra penalty weights and has no direct mapping to the
  empty-``true_labels`` ABSTAIN convention; heavier machinery for a weaker
  fit. Used only as the validation-comparison baseline.

Abstention cost C
- NEVER hardcoded silently: resolved by ``resolve_abstention_cost()``
  with precedence CLI ``--abstain-cost`` > env ``REGULUS_ABSTAIN_COST`` >
  ``DEFAULT_ABSTENTION_COST``.
- Default C = 0.3 comes from THIS spike's synthetic comparison (BCE
  scale: above confident-correct ~0.049, below ambiguous ~0.644, far below
  confident-wrong ~4.02). WS-E re-selects C on the batch-4 validation
  split (never on r1); the user may override at run time.

GLiClass Trainer hook (importable, no weights needed at import time)
- ``build_idk_trainer()`` lazily imports ``gliclass.training.Trainer``
  and returns an ``IdkTrainer`` subclass overriding ``compute_loss``.
  WS-E wiring note lives in ``odd/tasks/objective-spike.md``; this module
  never touches ``ft/train_regulus_v1.py``.
- CPU-only: ``torch`` at top level is the only hard dependency;
  ``gliclass`` imports stay inside functions so ``--demo`` and unit use
  run without model weights.

Validation-only comparison (no training here): ``compare_objectives()``
takes validation logits + targets and reports base vs force vs abstain
per row. WS-E runs it on the batch-4 validation split.
"""

from __future__ import annotations

import argparse
import json
import math
import os

import torch
import torch.nn as nn
import torch.nn.functional as F

#: Default abstention cost C. Provenance: this spike's synthetic BCE-scale
#: comparison (confident-correct ~0.049 < 0.3 < ambiguous ~0.644 <<
#: confident-wrong ~4.02). User-overridable via CLI/env; WS-E re-selects
#: on the batch-4 validation split.
DEFAULT_ABSTENTION_COST = 0.3

#: Env var override for C (lower precedence than the CLI flag).
COST_ENV_VAR = "REGULUS_ABSTAIN_COST"

#: BCE of a uniform logit (ln 2). Guidance only: C above this means even a
#: maximally-uncertain row never abstains, which is almost surely a mis-set.
UNIFORM_BCE = math.log(2)


def resolve_abstention_cost(cli_value: float | str | None = None) -> float:
    """Resolve C with precedence CLI > env > spike default.

    Raises ``ValueError`` on non-finite or non-positive values (an
    abstention cost must be a positive price; zero would mean "abstain
    everywhere for free" and negative is incoherent).
    """
    raw = cli_value
    if raw is None:
        raw = os.environ.get(COST_ENV_VAR, None)
    if raw is None:
        return DEFAULT_ABSTENTION_COST
    try:
        cost = float(raw)
    except (TypeError, ValueError) as e:
        raise ValueError(f"abstention cost {raw!r} is not a number") from e
    if not math.isfinite(cost) or cost <= 0:
        raise ValueError(f"abstention cost must be finite and > 0, got {raw!r}")
    return cost


def uncertainty_features(logits: torch.Tensor) -> torch.Tensor:
    """K-agnostic uncertainty summaries per row: (B, K) -> (B, 3).

    Columns: [max_prob, mean_binary_entropy, top1_top2_margin]. All lie in
    [0, 1]-ish ranges, so a zero-initialised head starts neutral (q = 0.5).
    """
    if logits.dim() != 2:
        raise ValueError(f"logits must be (B, K), got {tuple(logits.shape)}")
    probs = torch.sigmoid(logits)
    max_prob = probs.max(dim=-1).values
    ent = -(probs * (probs + 1e-8).log() + (1 - probs) * (1 - probs + 1e-8).log())
    entropy_mean = ent.mean(dim=-1)
    if logits.shape[-1] > 1:
        top2 = probs.topk(2, dim=-1).values
        margin = top2[..., 0] - top2[..., 1]
    else:
        margin = torch.zeros_like(max_prob)
    return torch.stack([max_prob, entropy_mean, margin], dim=-1)


class AbstentionHead(nn.Module):
    """Tiny learnable head: uncertainty features (B, 3) -> abstain logit (B,).

    Zero-initialised (weights + bias = 0) so training starts abstention-
    neutral at q = 0.5 and moves only on the dL/dq = C - base gradient.
    ``bias_init`` warm-starts the bias instead: regulus-v2 passes -2.2
    (q = sigmoid(-2.2) ~= 0.1) so early steps carry the full (1-q) ~= 0.9
    base gradient and abstention is learned afterwards. Default 0.0 keeps
    the WS-C spike behavior byte-identical.
    """

    def __init__(self, bias_init: float = 0.0) -> None:
        super().__init__()
        self.fc = nn.Linear(3, 1)
        nn.init.zeros_(self.fc.weight)
        if bias_init == 0.0:
            nn.init.zeros_(self.fc.bias)
        else:
            nn.init.constant_(self.fc.bias, float(bias_init))

    def forward(self, logits: torch.Tensor) -> torch.Tensor:
        return self.fc(uncertainty_features(logits)).squeeze(-1)


def _base_bce_rows(logits: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
    return F.binary_cross_entropy_with_logits(logits, targets, reduction="none").mean(dim=-1)


def _base_focal_rows(
    logits: torch.Tensor,
    targets: torch.Tensor,
    alpha: float = 0.25,
    gamma: float = 2.0,
) -> torch.Tensor:
    try:
        from gliclass.loss_functions import focal_loss_with_logits
    except ImportError:
        focal_loss_with_logits = None  # type: ignore[assignment]
    if focal_loss_with_logits is not None:
        per_elem = focal_loss_with_logits(
            logits, targets, alpha=alpha, gamma=gamma, reduction="none"
        )
    else:  # pure-torch fallback (same RetinaNet form), no weights needed
        bce = F.binary_cross_entropy_with_logits(logits, targets, reduction="none")
        p = torch.sigmoid(logits)
        p_t = p * targets + (1 - p) * (1 - targets)
        mod = (1 - p_t) ** gamma if gamma > 0 else torch.ones_like(bce)
        a_t = alpha * targets + (1 - alpha) * (1 - targets) if alpha >= 0 else torch.ones_like(bce)
        per_elem = a_t * mod * bce
    return per_elem.mean(dim=-1)


def idk_loss(
    logits: torch.Tensor,
    targets: torch.Tensor,
    abstain_logit: torch.Tensor | None = None,
    abstention_cost: float = DEFAULT_ABSTENTION_COST,
    base: str = "bce",
    focal_alpha: float = 0.25,
    focal_gamma: float = 2.0,
) -> tuple[torch.Tensor, dict]:
    """CAN-style IDK loss. Returns (scalar loss, info dict).

    ``abstain_logit=None`` = forced verdict (q = 0); pass a large positive
    logit to price the full-abstention policy (loss -> C per row).
    """
    if logits.shape != targets.shape:
        raise ValueError(
            f"logits/targets shape mismatch: {tuple(logits.shape)} vs {tuple(targets.shape)}"
        )
    if base == "bce":
        base_rows = _base_bce_rows(logits, targets.float())
    elif base == "focal":
        base_rows = _base_focal_rows(logits, targets.float(), focal_alpha, focal_gamma)
    else:
        raise ValueError(f"unknown base {base!r} (want 'bce' or 'focal')")
    if abstain_logit is None:
        q = torch.zeros_like(base_rows)
    else:
        q = torch.sigmoid(abstain_logit.reshape_as(base_rows))
    rows = (1 - q) * base_rows + float(abstention_cost) * q
    info = {
        "loss": float(rows.mean().detach()),
        "base_mean": float(base_rows.mean().detach()),
        "q_mean": float(q.mean().detach()),
        "per_row": [float(v) for v in rows.detach()],
        "base_rows": [float(v) for v in base_rows.detach()],
        "abstention_cost": float(abstention_cost),
        "base": base,
    }
    return rows.mean(), info


def compare_objectives(
    logits: torch.Tensor,
    targets: torch.Tensor,
    abstention_cost: float = DEFAULT_ABSTENTION_COST,
    base: str = "bce",
) -> dict:
    """Validation-only comparison: force vs abstain pricing per row.

    No training, no gradients, no weights. WS-E feeds batch-4 validation
    logits through this to pick C before the single F3 run.
    """
    with torch.no_grad():
        _, force = idk_loss(logits, targets, None, abstention_cost, base)
        big = torch.full((logits.shape[0],), 50.0)
        _, abstain = idk_loss(logits, targets, big, abstention_cost, base)
    rows = []
    for i, (f, a) in enumerate(zip(force["base_rows"], abstain["per_row"])):
        rows.append(
            {
                "row": i,
                "force": f,  # == base loss (q = 0)
                "abstain": a,  # == C (q -> 1)
                "cheaper": "abstain" if a < f else "force",
                "delta": f - a,  # > 0 means abstaining wins
            }
        )
    return {
        "abstention_cost": float(abstention_cost),
        "base": base,
        "force_mean": float(sum(r["force"] for r in rows) / len(rows)),
        "abstain_mean": float(sum(r["abstain"] for r in rows) / len(rows)),
        "rows": rows,
    }


def build_idk_trainer(
    abstention_cost: float | str | None = None,
    base: str = "focal",
):
    """Return an ``IdkTrainer`` class (``gliclass.training.Trainer`` subclass).

    The import of ``gliclass.training`` happens HERE (lazy) so this module
    stays importable and unit-testable on CPU without model weights.
    WS-E wiring: see ``odd/tasks/objective-spike.md`` (exact snippet); this
    function is the only new import the train script needs.

    Override sketch (``compute_loss``): forward the model for logits, run
    the module-level ``AbstentionHead`` over *detached* uncertainty
    features (stable head, no scorer<->head feedback loop; the scorer still
    gets the ``(1 - q)``-weighted base gradient, which is the mechanism
    that teaches abstention), then ``idk_loss``. EWC passthrough mirrors
    the parent ``Trainer.compute_loss``. Rows whose inputs carry no
    ``labels`` fall back to ``super().compute_loss`` (never silently zero).
    """
    from gliclass.training import Trainer  # lazy: weights/API only on train path

    cost = resolve_abstention_cost(abstention_cost)
    head = AbstentionHead()

    class IdkTrainer(Trainer):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.idk_head = head
            self.idk_cost = cost
            self.idk_base = base

        def compute_loss(self, model, inputs, return_outputs=False, **kwargs):
            if not isinstance(inputs, dict) or inputs.get("labels") is None:
                return super().compute_loss(
                    model, inputs, return_outputs=return_outputs, **kwargs
                )
            labels = inputs["labels"]
            outputs = model(**inputs, return_dict=True)
            logits = outputs.logits
            self.idk_head.to(logits.device)
            # Detached features: head learns q, scorer learns (1-q)*base.
            a_logit = self.idk_head(logits.detach())
            targets = labels.float().reshape(logits.shape)
            loss, _ = idk_loss(
                logits, targets, a_logit, self.idk_cost, self.idk_base
            )
            if self.ewc is not None and self.args.use_ewc:
                bs = inputs.get("input_ids", labels).shape[0]
                loss = loss + self.ewc.ewc_loss(batch_size=bs)
            if return_outputs:
                return loss, outputs
            return loss

    IdkTrainer.__name__ = "IdkTrainer"
    return IdkTrainer


def synthetic_demo(cost: float = DEFAULT_ABSTENTION_COST, base: str = "bce") -> dict:
    """Hand-checkable 3-row demo (CPU, no weights).

    - correct: logit +3.0, target 1 (confident-correct, BCE ~0.0486)
    - ambiguous: logits [+0.1, -0.1], targets [1, 0] (BCE ~0.6444/row-mean)
    - wrong: logit -4.0, target 1 (confident-wrong, BCE ~4.0182)
    """
    rows = {
        "correct": (torch.tensor([[3.0]]), torch.tensor([[1.0]])),
        "ambiguous": (torch.tensor([[0.1, -0.1]]), torch.tensor([[1.0, 0.0]])),
        "wrong": (torch.tensor([[-4.0]]), torch.tensor([[1.0]])),
    }
    out: dict = {"abstention_cost": cost, "base": base, "rows": {}}
    for name, (lg, tg) in rows.items():
        cmp_ = compare_objectives(lg, tg, cost, base)
        r = cmp_["rows"][0]
        out["rows"][name] = r
    out["checks"] = {
        # Abstaining on the ambiguous row must beat forcing a verdict.
        "abstain_wins_on_ambiguous": out["rows"]["ambiguous"]["abstain"]
        < out["rows"]["ambiguous"]["force"],
        # A forced confident-wrong verdict must cost MORE than abstaining.
        "wrong_costs_more_than_abstain": out["rows"]["wrong"]["force"]
        > out["rows"]["wrong"]["abstain"],
        # A confident-correct row must NOT want to abstain (no collapse).
        "correct_prefers_force": out["rows"]["correct"]["force"]
        < out["rows"]["correct"]["abstain"],
    }
    out["all_pass"] = all(out["checks"].values())
    return out


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="IDK-loss spike demo (synthetic, CPU-only).")
    p.add_argument("--abstain-cost", default=None,
                   help=f"C override (default: env {COST_ENV_VAR} or {DEFAULT_ABSTENTION_COST})")
    p.add_argument("--base", default="bce", choices=["bce", "focal"])
    p.add_argument("--demo", action="store_true",
                   help="run the synthetic abstain-vs-force demo (the only mode)")
    p.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = p.parse_args(argv)
    cost = resolve_abstention_cost(args.abstain_cost)
    demo = synthetic_demo(cost, args.base)
    if args.json:
        print(json.dumps(demo, indent=2))
    else:
        print(f"IDK-loss synthetic demo (base={demo['base']}, C={demo['abstention_cost']})")
        for name, r in demo["rows"].items():
            print(f"  {name:9s} force={r['force']:.4f} abstain={r['abstain']:.4f} "
                  f"cheaper={r['cheaper']} delta={r['delta']:+.4f}")
        for name, ok in demo["checks"].items():
            print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    return 0 if demo["all_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
