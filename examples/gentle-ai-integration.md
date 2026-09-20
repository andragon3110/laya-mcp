# Optional integration with Gentle-AI

Gentle-AI orchestrates SDD/Odd/RDD workflows across many sub-agents
on top of OpenCode / Pi / Claude Code / Codex. laya-mcp is **not** part
of Gentle-AI -- it is an optional layer you can wire in.

This document shows two opt-in patterns. **Both are off by default.**
You wire them by editing your agent's skill files.

---

## Pattern 1: `sdd-apply` -> `laya_review`

Goal: before Gentle-AI's `sdd-apply` agent declares a task done, have
Laya score the diff against the original task. If the score is below
threshold, escalate instead of auto-archiving.

### Where to wire

Edit your project-local `sdd-apply` skill:

```
.opencode/agents/sdd-apply.md      (or .claude/skills/sdd-apply/SKILL.md)
```

Append this block:

```markdown
## Optional: pre-archive review with laya-mcp

If laya_review is available in your tool list, call it on the diff
before reporting the task done. Use the orchestrator's task statement
as `request`, the git diff as `diff`, and any test output as `tests`.

If the response `action` is `escalate`, do NOT report the task done.
Hand off to a human reviewer instead.
```

That's it. The skill prompt now opportunistically calls `laya_review`
when the tool is available, and ignores it otherwise.

---

## Pattern 2: GitHub issues -> `laya_classify`

Goal: when a new issue arrives, run `laya_classify` against your label
set and apply the auto-label only when confidence >= 0.85.

### Sample workflow

`.github/workflows/auto-label.yml`:

```yaml
name: Auto-label issues with laya
on:
  issues:
    types: [opened]

jobs:
  classify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: ./install.sh            # if your runner is fresh
      - run: ./start_laya.sh &        # background laya-server
      - name: Wait for laya-server
        run: |
          for i in {1..60}; do
            curl -fsS http://127.0.0.1:8765/health && break || sleep 1
          done
      - name: Classify issue
        uses: actions/github-script@v7
        with:
          script: |
            const issue = context.payload.issue;
            const body = `${issue.title}\n\n${issue.body}`;
            const labels = ["bug", "enhancement", "docs", "question"];
            const classes = labels.map((id) => ({ id, description: id }));
            const r = await fetch("http://127.0.0.1:8765/predict", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                state: { id: String(issue.number), text: body },
                questions: {
                  category: {
                    type: "choice",
                    instructions: "Assign this issue to a label.",
                    criteria: Object.fromEntries(
                      classes.map((c) => [c.id, c.description])
                    ),
                  },
                },
              }),
            });
            const body2 = await r.json();
            const ans = body2.answers.category;
            const top = Object.entries(ans.probabilities).sort(
              (a, b) => b[1] - a[1]
            )[0];
            if (top[1] >= 0.85) {
              await github.rest.issues.addLabels({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: issue.number,
                labels: [top[0]],
              });
            }
```

This is illustrative; adapt the labels catalog to your repo.

---

## Pattern 3 (bonus): PR guardrail with `laya_screen`

When fetching the body of an external issue or PR for context, run it
through `laya_screen` first. If the response `action` is `block`, refuse
to inline it.

This is the same pattern that
[`agentgateway`](https://github.com/agentgateway/agentgateway) uses for
its production guardrail (`llm-guardrail-jev`), but local and free.
