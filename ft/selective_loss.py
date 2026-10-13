"""Regulus WS-C F2 spike: selective prediction + error regularization (DEFERRED).

STATUS: DEFERRED reference implementation. Importable and CPU-testable so
WS-E can run it as the validation-comparison baseline against the CHOSEN
``ft/idk_loss.py`` (CAN-style IDK loss), but it is NOT the recommended F3
objective. Reasons (also in ``odd/tasks/objective-spike.md``):

1. Needs a coverage target plus penalty weights (``coverage_target``,
   ``coverage_weight``, ``error_reg_weight``) where the chosen IDK loss
   needs exactly one user-chosen price C. More knobs, same validation
   budget, higher mis-set risk.
2. No direct mapping to the lineage ABSTAIN convention: GLiClass teaches
   ABSTAIN with empty ``true_labels`` (all-zero targets -> low scores ->
   handler abstains). A separate selection head ``g(x)`` learns a parallel
   abstain policy the handler cannot read (the handler only sees label
   scores), so the learned selection would need a second plumbing step.
3. Error regularization improves confidence quality without harming
   accuracy, but our gap is not confidence quality -- it is the missing
   abstention decision itself (gate/screen task 0/22, 0/32 after 4 SFT
   rounds). The IDK loss prices that decision directly.

Form (Geifman-style selective prediction, per row)::

    s_b      = sigmoid(selection_logit_b)          # select (1) vs abstain (0)
    risk     = sum(s*base) / sum(s)                # selective risk on covered rows
    cov      = mean(s)                             # empirical coverage
    cov_pen  = max(0, target - cov)^2              # coverage shortfall penalty
    err_reg  = mean(|s - (1 - err_norm)|)          # select iff likely-correct
    L        = risk + w_cov * cov_pen + w_err * err_reg

CPU-only, no weights needed (same contract as ``ft/idk_loss.py``).
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F


class SelectionHead(nn.Module):
    """Reference selection head over the same K-agnostic features as IDK.

    Kept architecturally parallel to ``AbstentionHead`` so the validation
    comparison is head-capacity-matched (both Linear(3, 1), zero-init).
    """

    def __init__(self) -> None:
        super().__init__()
        self.fc = nn.Linear(3, 1)
        nn.init.zeros_(self.fc.weight)
        nn.init.zeros_(self.fc.bias)

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        if features.dim() != 2 or features.shape[-1] != 3:
            raise ValueError(f"features must be (B, 3), got {tuple(features.shape)}")
        return self.fc(features).squeeze(-1)


def selective_loss(
    logits: torch.Tensor,
    targets: torch.Tensor,
    select_logit: torch.Tensor,
    coverage_target: float = 0.9,
    coverage_weight: float = 1.0,
    error_reg_weight: float = 0.1,
) -> tuple[torch.Tensor, dict]:
    """Selective risk + coverage penalty + error regularization.

    Returns (scalar loss, info dict). ``select_logit=None`` is rejected
    (unlike IDK there is no meaningful forced-verdict default: selection
    IS the mechanism here).
    """
    if logits.shape != targets.shape:
        raise ValueError(
            f"logits/targets shape mismatch: {tuple(logits.shape)} vs {tuple(targets.shape)}"
        )
    if select_logit is None:
        raise ValueError("selective_loss needs select_logit (selection is the mechanism)")
    if not 0 < coverage_target <= 1:
        raise ValueError(f"coverage_target must be in (0, 1], got {coverage_target!r}")
    base_rows = F.binary_cross_entropy_with_logits(
        logits, targets.float(), reduction="none"
    ).mean(dim=-1)
    s = torch.sigmoid(select_logit.reshape_as(base_rows))
    covered = s.sum().clamp(min=1e-8)
    risk = (s * base_rows).sum() / covered
    coverage = s.mean()
    cov_pen = torch.clamp(coverage_target - coverage, min=0.0) ** 2
    # Error signal: per-row error normalised to [0, 1] by the batch max so
    # the regularizer is scale-free; select (s->1) iff likely-correct.
    err = base_rows.detach()
    err_norm = err / err.max().clamp(min=1e-8)
    err_reg = (s - (1 - err_norm)).abs().mean()
    loss = risk + coverage_weight * cov_pen + error_reg_weight * err_reg
    info = {
        "loss": float(loss.detach()),
        "selective_risk": float(risk.detach()),
        "coverage": float(coverage.detach()),
        "coverage_penalty": float(cov_pen.detach()),
        "error_reg": float(err_reg.detach()),
        "coverage_target": float(coverage_target),
    }
    return loss, info
