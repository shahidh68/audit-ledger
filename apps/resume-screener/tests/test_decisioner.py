from resume_screener.decisioner import decide


STRONG_RESUME = """\
Senior Engineer with 8 years experience.
Skills: Python, AWS, Kubernetes, Terraform, Docker, CI/CD, PostgreSQL, Linux.
Education: MSc Computer Science, Stanford University.
"""

STRONG_JD = """\
Staff Platform Engineer
Requirements: 7+ years experience.
Required skills: Python, AWS, Kubernetes, Terraform, Docker, CI/CD.
Bachelor's degree in Computer Science.
"""

WEAK_RESUME = """\
Junior dev. 1 year experience.
Skills: HTML, CSS.
"""


def test_decision_is_deterministic_with_seed() -> None:
    a = decide(resume=STRONG_RESUME, jd=STRONG_JD, seed=42)
    b = decide(resume=STRONG_RESUME, jd=STRONG_JD, seed=42)
    assert a == b


def test_strong_match_shortlists() -> None:
    out = decide(resume=STRONG_RESUME, jd=STRONG_JD, seed=1)
    assert out["decision"] == "shortlist"
    assert out["confidence"] >= 0.70


def test_weak_match_rejects() -> None:
    out = decide(resume=WEAK_RESUME, jd=STRONG_JD, seed=1)
    assert out["decision"] == "reject"
    assert out["confidence"] < 0.40


def test_output_schema() -> None:
    out = decide(resume=STRONG_RESUME, jd=STRONG_JD, seed=1)
    assert {"decision", "confidence", "signals", "top_reasons", "model_version"} <= set(out)
    assert set(out["signals"]) == {"skills_match", "experience_match", "education_match"}
    assert isinstance(out["top_reasons"], list)
    assert len(out["top_reasons"]) == 2
    assert out["decision"] in {"shortlist", "refer", "reject"}
    assert 0.0 <= out["confidence"] <= 1.0


def test_model_version_passes_through() -> None:
    out = decide(
        resume=STRONG_RESUME,
        jd=STRONG_JD,
        model_version="screener-test-vX",
        seed=1,
    )
    assert out["model_version"] == "screener-test-vX"
