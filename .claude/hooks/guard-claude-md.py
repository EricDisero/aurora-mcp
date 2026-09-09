#!/usr/bin/env python
"""PostToolUse hook -- keep this repo's CLAUDE.md under its cap, automatically.

CANONICAL COPY: second-brain/tools/repo-checks/guard-claude-md.py. Installed per repo by
second-brain/tools/install_repo_checks.py, which stamps the cap block below; the vault
lint fails when a repo copy drifts from the canonical file. Edit it there, never here.

  CLAUDE.md    3,500 words, pay-to-add ramp at 3,000

Anthropic's memory documentation targets a CLAUDE.md under 200 lines; past that a
file "consumes more context and reduces adherence". This one loads in full, in every
session, before anyone types anything -- and a split alone does not hold it there,
because nothing in the repo objects when the file grows back. This is the objection.

Fires after any Edit/Write to CLAUDE.md and reports, in one pass:

  1. WORD CAP        -- the number above. Above the ramp, every addition is paid for
                        by an equal deletion in the SAME edit.
  2. FOSSILS         -- change-archaeology: "tightened from X", "was 8,000",
                        "previously", "used to be", "changed from", "note: this was".
                        Bare dates are NOT flagged -- invariant headings legitimately
                        carry "(locked YYYY-MM-DD)".
  3. HEDGE PADDING   -- "just to be safe", "it's worth noting", "for what it's worth"
                        and friends: filler that costs every session.

Exit 2 feeds stderr back to the model as actionable feedback WITHOUT blocking the
edit (PostToolUse runs after the write). The model fixes it in the same turn, so Eric
never sees it. Fails open on anything unexpected -- a broken guard must never wedge a
session.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

PAY_TO_ADD = 1000
CAPS = {"claude.md": 1200}

# Change-archaeology: a statement ABOUT an edit rather than the doctrine itself.
FOSSIL_PATTERNS = [
    (r"tightened from|loosened from|changed from\s+[\d,]+|raised from|lowered from",
     "states what the value USED to be"),
    (r"\b(previously|formerly|used to be|no longer says|was originally)\b",
     "narrates the file's own history"),
    (r"\bthis (was|is now) (wrong|corrected|fixed|updated)\b",
     "annotates a correction instead of just being correct"),
    (r"\(was [\d,]+\)|\bdown from [\d,]+\b|\bup from [\d,]+\b",
     "carries the superseded number alongside the live one"),
]

# Filler that survives because it reads as conscientious.
PADDING_PATTERNS = [
    r"\bjust to be safe\b", r"\bit('s| is) worth noting\b", r"\bfor what it('s| is) worth\b",
    r"\bplease note that\b", r"\bas mentioned (above|earlier)\b", r"\bin order to\b",
    r"\bjust (flagging|surfacing)\b", r"\bkeep in mind that\b", r"\bneedless to say\b",
]


# A rule that forbids a phrase has to be able to QUOTE the phrase. Blank out backtick
# spans and "..." quotes before matching, so the doctrine line stating the rule never
# trips the rule -- without that, the guard's loudest findings are the guard itself and
# the model learns to dismiss it.
QUOTED_RE = re.compile(r"`[^`]*`|\"[^\"]*\"|“[^”]*”")


def find(patterns, text):
    hits = []
    for line_no, raw in enumerate(text.splitlines(), 1):
        line = QUOTED_RE.sub(lambda m: " " * len(m.group(0)), raw)
        for pat in patterns:
            regex, why = pat if isinstance(pat, tuple) else (pat, "padding")
            m = re.search(regex, line, re.IGNORECASE)
            if m:
                hits.append((line_no, m.group(0), why))
    return hits


def _is_project_root_file(path: Path) -> bool:
    """True when `path` sits in THIS project's ROOT directory. Fails open when unknown.

    Two ways to get this wrong, both already paid for. Matching on basename alone fires
    one repo's cap at another repo's CLAUDE.md and demands thousands of words of that
    repo's invariants be deleted. Matching anywhere UNDER the root does the same thing
    one level down: the Slates workspace root holds five nested repos, each with its own
    CLAUDE.md and its own cap. Only the file beside this hook's own project answers to it.
    """
    root = os.environ.get("CLAUDE_PROJECT_DIR") or ""
    if not root:
        root = str(Path(__file__).resolve().parents[2])
    try:
        return Path(path).resolve().parent == Path(root).resolve()
    except Exception:
        return False


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    if payload.get("tool_name") not in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        return 0
    path_str = (payload.get("tool_input") or {}).get("file_path") or ""
    if not path_str:
        return 0
    path = Path(path_str)
    if path.name.lower() not in CAPS:
        return 0
    if not _is_project_root_file(path):
        return 0

    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return 0

    words = len(text.split())
    cap = CAPS[path.name.lower()]
    problems = []

    # Previous size, so the ramp fires on GROWTH only. Warning on every edit once the
    # file sits above the ramp would train the model to ignore it -- and an edit that
    # deleted words is the behaviour we want, not a finding.
    state = path.parent / ".claude" / "hooks" / ".claude-md-words"
    if not state.parent.exists():
        state = Path(__file__).with_name(".claude-md-words")
    try:
        before = int(state.read_text(encoding="utf-8").strip())
    except Exception:
        before = None
    try:
        state.write_text(str(words), encoding="utf-8")
    except Exception:
        pass

    if words > cap:
        problems.append(
            f"OVER THE CAP: {path.name} is {words} words, hard cap {cap}. Delete "
            f"{words - cap} words before doing anything else."
        )
    elif words > PAY_TO_ADD and before is not None and words > before:
        problems.append(
            f"UNPAID ADDITION: {before} -> {words} words (+{words - before}), "
            f"ramp {PAY_TO_ADD}, cap {cap}. Above the ramp every addition is "
            f"paid for by an equal deletion in the SAME edit. Cut "
            f"{words - before} words elsewhere or revert this."
        )

    for line_no, snippet, why in find(FOSSIL_PATTERNS, text):
        problems.append(f"FOSSIL line {line_no}: \"{snippet}\" -- {why}.")

    for line_no, snippet, _ in find(PADDING_PATTERNS, text):
        problems.append(f"PADDING line {line_no}: \"{snippet}\" -- cut it.")

    if not problems:
        return 0

    print(
        "CLAUDE.md guard -- fix these in this turn, do not report done first:\n\n"
        + "\n".join(f"  - {p}" for p in problems)
        + "\n\nThis file loads in every session. A rule that is finished and shipped "
          "belongs in a path-scoped file under .claude/rules/, not here. State the "
          "rule as it is now; never narrate what it used to be.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)  # fail open, always
