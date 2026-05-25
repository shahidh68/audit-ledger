import random

from resume_screener.human import DECISIONS, simulate_human_review


def _ai(decision: str = "shortlist") -> dict:
    return {
        "decision": decision,
        "confidence": 0.75,
        "signals": {"skills_match": 0.8, "experience_match": 0.8, "education_match": 0.6},
        "top_reasons": [],
        "model_version": "screener-vTest",
    }


def test_simulated_review_structure_when_agreed() -> None:
    rev = simulate_human_review(_ai("shortlist"), rng=random.Random(0), agreement_rate=1.0)
    assert rev["agreed"] is True
    assert rev["final_decision"] == "shortlist"
    assert rev["reviewer"]
    assert rev["reason"]
    assert rev["reviewed_at"].endswith("Z")


def test_disagreement_picks_different_decision() -> None:
    rev = simulate_human_review(_ai("refer"), rng=random.Random(1), agreement_rate=0.0)
    assert rev["agreed"] is False
    assert rev["final_decision"] != "refer"
    assert rev["final_decision"] in DECISIONS


def test_agreement_rate_distribution() -> None:
    rng = random.Random(2)
    n = 1000
    agreed = sum(
        1 for _ in range(n)
        if simulate_human_review(_ai("shortlist"), rng=rng, agreement_rate=0.7)["agreed"]
    )
    # roughly 70% — wide tolerance for randomness
    assert 600 <= agreed <= 800
