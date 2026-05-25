"""Synthetic resume + JD generator for batch mode."""

from __future__ import annotations

import random
from dataclasses import dataclass

from faker import Faker


JD_TEMPLATES: tuple[dict, ...] = (
    {
        "title": "Staff Platform Engineer",
        "required_years": 7,
        "required_skills": ("python", "aws", "kubernetes", "terraform", "ci/cd", "docker"),
        "required_education": "bachelor",
    },
    {
        "title": "Senior Backend Engineer (Payments)",
        "required_years": 5,
        "required_skills": ("go", "postgres", "kafka", "grpc", "docker"),
        "required_education": "bachelor",
    },
    {
        "title": "Data Engineer",
        "required_years": 4,
        "required_skills": ("python", "airflow", "etl", "aws", "s3"),
        "required_education": "bachelor",
    },
    {
        "title": "ML Engineer",
        "required_years": 4,
        "required_skills": ("python", "pytorch", "machine learning", "aws"),
        "required_education": "msc",
    },
    {
        "title": "Frontend Engineer",
        "required_years": 3,
        "required_skills": ("typescript", "react", "next.js", "graphql"),
        "required_education": "bachelor",
    },
)

RESUME_ARCHETYPES: tuple[dict, ...] = (
    # Strong fits
    {"years": 9, "skills": ("python", "aws", "kubernetes", "terraform", "docker", "ci/cd", "linux", "postgres"), "edu": "msc"},
    {"years": 7, "skills": ("python", "aws", "docker", "ci/cd", "linux", "postgres", "sqs"), "edu": "bachelor"},
    {"years": 6, "skills": ("go", "postgres", "kafka", "grpc", "docker", "linux"), "edu": "bachelor"},
    {"years": 5, "skills": ("python", "airflow", "etl", "aws", "s3"), "edu": "bachelor"},
    {"years": 8, "skills": ("python", "pytorch", "machine learning", "tensorflow", "aws"), "edu": "phd"},
    {"years": 5, "skills": ("typescript", "react", "next.js", "graphql", "node.js"), "edu": "bachelor"},
    # Moderate fits
    {"years": 4, "skills": ("python", "aws", "docker"), "edu": "bachelor"},
    {"years": 3, "skills": ("typescript", "react"), "edu": "bachelor"},
    {"years": 5, "skills": ("java", "aws", "kubernetes"), "edu": "bachelor"},
    {"years": 6, "skills": ("python", "pandas", "numpy"), "edu": "msc"},
    # Weak fits
    {"years": 1, "skills": ("python",), "edu": "bachelor"},
    {"years": 2, "skills": ("javascript",), "edu": "bachelor"},
    {"years": 0, "skills": (), "edu": "bachelor"},
)


@dataclass(frozen=True)
class SyntheticPair:
    resume_text: str
    jd_text: str
    jd_title: str


def synthesize(rng: random.Random, faker: Faker) -> SyntheticPair:
    """Build a (resume, JD) pair with realistic-feeling text."""
    jd = rng.choice(JD_TEMPLATES)
    arch = rng.choice(RESUME_ARCHETYPES)

    name = faker.name()
    location = faker.city()
    company_recent = faker.company()
    company_prev = faker.company()
    university = faker.last_name()

    jd_text = (
        f"{jd['title']}\n\n"
        "We are looking for a "
        f"{jd['title']} to join our team. You will own platform reliability,\n"
        "design and ship high-leverage tooling, and partner with senior engineers\n"
        "across the org.\n\n"
        "Requirements:\n"
        f"- {jd['required_years']}+ years of professional software engineering experience\n"
        f"- Strong hands-on experience with: {', '.join(jd['required_skills'])}\n"
        f"- {jd['required_education'].title()} degree in Computer Science or equivalent\n"
        "- Excellent written and verbal communication\n"
    )

    skills_line = ", ".join(arch["skills"]) if arch["skills"] else "general software engineering"
    primary_skill = (
        rng.choice(arch["skills"]) if arch["skills"] else "internal tooling"
    )

    resume_text = (
        f"{name}\n"
        f"{location}\n\n"
        "Summary\n"
        f"{arch['years']} years of professional software engineering experience.\n"
        f"Most recent role: senior engineer at {company_recent}.\n\n"
        "Skills\n"
        f"{skills_line}\n\n"
        "Experience\n"
        f"{company_recent} — Senior Software Engineer ({arch['years']} years)\n"
        f"- Built and operated production services using {primary_skill}.\n"
        "- Led on-call rotation and mentored junior engineers.\n\n"
        f"{company_prev} — Software Engineer (2 years)\n"
        "- Shipped reliability and performance improvements.\n\n"
        "Education\n"
        f"{arch['edu'].upper()} in Computer Science, {university} University\n"
    )

    return SyntheticPair(
        resume_text=resume_text,
        jd_text=jd_text,
        jd_title=jd["title"],
    )
