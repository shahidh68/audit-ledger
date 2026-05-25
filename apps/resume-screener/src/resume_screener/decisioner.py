"""The 'AI' — pure rule-based decision function. Deterministic given a seed."""

from __future__ import annotations

import random
from typing import Any

from resume_screener.scoring import (
    score_education,
    score_experience,
    score_skills,
)

WEIGHT_SKILLS = 0.5
WEIGHT_EXP = 0.3
WEIGHT_EDU = 0.2

THRESHOLD_SHORTLIST = 0.70
THRESHOLD_REFER = 0.40


def decide(
    *,
    resume: str,
    jd: str,
    model_version: str = "screener-v0.3",
    seed: int | None = None,
) -> dict[str, Any]:
    """Run scoring, blend, classify. Returns the decision payload."""
    skills_score, matched = score_skills(jd, resume)
    exp_score, exp_reason = score_experience(jd, resume)
    edu_score, edu_reason = score_education(jd, resume)

    rng = random.Random(seed) if seed is not None else random.Random()
    noise = rng.uniform(-0.04, 0.04)

    score = (
        WEIGHT_SKILLS * skills_score
        + WEIGHT_EXP * exp_score
        + WEIGHT_EDU * edu_score
        + noise
    )
    score = max(0.0, min(1.0, score))

    if score >= THRESHOLD_SHORTLIST:
        decision = "shortlist"
    elif score >= THRESHOLD_REFER:
        decision = "refer"
    else:
        decision = "reject"

    top_reasons = _build_top_reasons(
        skills_score=skills_score, matched=matched,
        exp_score=exp_score, exp_reason=exp_reason,
        edu_score=edu_score, edu_reason=edu_reason,
    )

    return {
        "decision": decision,
        "confidence": round(score, 3),
        "signals": {
            "skills_match": round(skills_score, 3),
            "experience_match": round(exp_score, 3),
            "education_match": round(edu_score, 3),
        },
        "top_reasons": top_reasons,
        "model_version": model_version,
    }


def _build_top_reasons(
    *,
    skills_score: float, matched: list[str],
    exp_score: float, exp_reason: str,
    edu_score: float, edu_reason: str,
) -> list[str]:
    if matched:
        skills_reason = (
            f"Matches {len(matched)} JD skill"
            + ("s" if len(matched) != 1 else "")
            + f" ({', '.join(matched[:5])}"
            + ("…" if len(matched) > 5 else "")
            + ")"
        )
    else:
        skills_reason = "No JD skills detected on resume"

    weighted = [
        (skills_score * WEIGHT_SKILLS, skills_reason),
        (exp_score * WEIGHT_EXP, exp_reason),
        (edu_score * WEIGHT_EDU, edu_reason),
    ]
    weighted.sort(key=lambda x: x[0], reverse=True)
    return [reason for _, reason in weighted[:2]]
