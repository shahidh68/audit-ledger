"""Pure scoring functions — no I/O, deterministic given inputs."""

from __future__ import annotations

import re

# Keyword library — matched case-insensitively as whole words/phrases.
SKILL_LEXICON: tuple[str, ...] = (
    "python", "java", "typescript", "javascript", "go", "rust", "c++",
    "react", "vue", "angular", "next.js", "node.js",
    "aws", "gcp", "azure", "kubernetes", "docker", "terraform", "cdk",
    "lambda", "ecs", "eks", "s3", "rds", "dynamodb", "kinesis", "sqs", "sns",
    "postgres", "postgresql", "mysql", "mongodb", "redis", "elasticsearch", "kafka",
    "pandas", "numpy", "pytorch", "tensorflow", "scikit-learn",
    "fastapi", "flask", "django", "express",
    "graphql", "rest", "grpc",
    "ci/cd", "github actions", "jenkins", "gitlab",
    "linux", "bash", "git",
    "agile", "scrum", "tdd",
    "machine learning", "data engineering", "etl", "airflow",
)

YEARS_RE = re.compile(r"(\d{1,2})\+?\s*(?:years?|yrs?)\b", re.IGNORECASE)

# Education keyword → numeric level (higher = more advanced)
EDU_KEYWORDS: dict[str, int] = {
    "phd": 3, "doctorate": 3, "ph.d": 3,
    "msc": 2, "master": 2, "m.sc": 2, "mba": 2,
    "bsc": 1, "bachelor": 1, "b.sc": 1,
}


def _whole_word(s: str) -> re.Pattern[str]:
    return re.compile(r"\b" + re.escape(s) + r"\b", re.IGNORECASE)


def extract_jd_required_skills(jd: str) -> list[str]:
    """Return skills mentioned in the JD, sorted by occurrence frequency."""
    counts: dict[str, int] = {}
    for skill in SKILL_LEXICON:
        n = len(_whole_word(skill).findall(jd))
        if n:
            counts[skill] = n
    # Stable order: highest count first, then lexicon order as tiebreaker.
    lex_order = {s: i for i, s in enumerate(SKILL_LEXICON)}
    return sorted(counts, key=lambda s: (-counts[s], lex_order[s]))


def score_skills(jd: str, resume: str) -> tuple[float, list[str]]:
    """
    Returns (score in [0,1], matched skills list, JD-priority order).
    Score = matched / required, capped at 1.0. Neutral 0.5 if JD declares no
    detectable skills (we don't want to punish well-written resumes against
    vague JDs).
    """
    required = extract_jd_required_skills(jd)
    if not required:
        return 0.5, []

    matched = [s for s in required if _whole_word(s).search(resume)]
    score = len(matched) / max(1, len(required))
    return min(1.0, score), matched


def extract_max_years(text: str) -> int:
    """Largest 'X years' figure mentioned in the text, or 0 if none."""
    matches = [int(m) for m in YEARS_RE.findall(text) if int(m) <= 50]
    return max(matches) if matches else 0


def score_experience(jd: str, resume: str) -> tuple[float, str]:
    """
    Score = resume_years / jd_required_years (capped at 1.0).
    If JD doesn't state required years, default to 3.
    """
    jd_required = extract_max_years(jd) or 3
    resume_years = extract_max_years(resume)

    if resume_years == 0:
        return 0.2, "Resume does not state years of experience"

    score = min(1.0, resume_years / jd_required)
    if resume_years >= jd_required:
        return score, f"{resume_years}+ years experience meets {jd_required}-year requirement"
    return score, f"{resume_years} years experience below {jd_required}-year requirement"


def _highest_edu_level(text: str) -> int:
    text_l = " " + text.lower() + " "
    levels = [v for k, v in EDU_KEYWORDS.items() if k in text_l]
    return max(levels) if levels else 0


def score_education(jd: str, resume: str) -> tuple[float, str]:
    jd_level = _highest_edu_level(jd) or 1  # default: Bachelor expected
    resume_level = _highest_edu_level(resume)

    if resume_level == 0:
        return 0.3, "No education credentials detected on resume"
    if resume_level >= jd_level:
        return 1.0, "Education level meets or exceeds requirement"
    return 0.5, "Education level below stated requirement"
