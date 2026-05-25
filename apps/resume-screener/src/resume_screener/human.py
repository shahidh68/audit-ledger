"""Human review — interactive prompt + simulated review for batch mode."""

from __future__ import annotations

import random
import sys
from datetime import datetime, timezone
from typing import Any


DECISIONS: tuple[str, ...] = ("shortlist", "refer", "reject")

SAMPLE_REVIEWERS: tuple[str, ...] = (
    "alex.chen", "morgan.lee", "priya.patel", "jordan.kim",
    "sam.rivera", "robin.zhao", "casey.brown", "drew.nguyen",
)

SIMULATED_REASONS: dict[str, tuple[str, ...]] = {
    "agree_shortlist": (
        "Strong skill match and trajectory; moving to phone screen.",
        "Confident match — scheduling interview.",
        "Clear technical depth in required areas.",
    ),
    "agree_refer": (
        "Borderline case; needs hiring manager input.",
        "Mixed signals on seniority — flagging for review.",
        "Skills present but experience light — referring up.",
    ),
    "agree_reject": (
        "Mismatch on core requirements.",
        "Insufficient experience for this level.",
        "Skill profile not aligned with role.",
    ),
    "override_up": (
        "Resume undersells; portfolio compensates for keyword gaps.",
        "Communication signals strong despite weaker keyword match.",
        "Domain expertise outweighs the missing skill keywords.",
    ),
    "override_down": (
        "Keywords match but depth appears shallow on closer read.",
        "Tenure pattern raises concern; pulling back to refer.",
        "Recent gaps and role mismatch warrant a downgrade.",
    ),
}


def _utc_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def prompt_human_review(ai_decision: dict[str, Any]) -> dict[str, Any] | None:
    """
    Interactive prompt for `decide` mode. Returns a `human_review` dict, or
    None if the reviewer chose not to review.
    """
    print("\n— AI decision —", file=sys.stderr)
    print(f"  decision:   {ai_decision['decision']}", file=sys.stderr)
    print(f"  confidence: {ai_decision['confidence']}", file=sys.stderr)
    print(f"  signals:    {ai_decision['signals']}", file=sys.stderr)
    print(f"  reasons:", file=sys.stderr)
    for r in ai_decision["top_reasons"]:
        print(f"    - {r}", file=sys.stderr)

    answer = input("\nReview this decision? [y/N]: ").strip().lower()
    if answer not in ("y", "yes"):
        return None

    final = ""
    while final not in DECISIONS:
        final = input(f"Final decision ({'/'.join(DECISIONS)}): ").strip().lower()

    reason = input("Reason (one line): ").strip() or "(no reason given)"
    reviewer = input("Reviewer handle [anonymous]: ").strip() or "anonymous"

    return {
        "reviewer": reviewer,
        "final_decision": final,
        "agreed": final == ai_decision["decision"],
        "reason": reason,
        "reviewed_at": _utc_iso(),
    }


def simulate_human_review(
    ai_decision: dict[str, Any],
    *,
    rng: random.Random,
    agreement_rate: float = 0.85,
) -> dict[str, Any]:
    """Synthesize a plausible human review for batch mode."""
    agreed = rng.random() < agreement_rate
    ai_choice = ai_decision["decision"]

    if agreed:
        final = ai_choice
        reason_pool = SIMULATED_REASONS[f"agree_{ai_choice}"]
    else:
        choices = [d for d in DECISIONS if d != ai_choice]
        final = rng.choice(choices)
        # 'up' = a more favourable outcome for the candidate (shortlist > refer > reject)
        reason_pool = (
            SIMULATED_REASONS["override_up"]
            if DECISIONS.index(final) < DECISIONS.index(ai_choice)
            else SIMULATED_REASONS["override_down"]
        )

    return {
        "reviewer": rng.choice(SAMPLE_REVIEWERS),
        "final_decision": final,
        "agreed": agreed,
        "reason": rng.choice(reason_pool),
        "reviewed_at": _utc_iso(),
    }
