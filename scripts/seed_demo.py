#!/usr/bin/env python3
"""
Seed the public demo tenant with ~30 varied synthetic audit records.

Run this once after provisioning the demo-public tenant in Secrets Manager.
The records cover four scenario categories so a visitor sees a representative
sample of the kinds of decisions the ledger is designed to capture:

    - Loan triage         (credit decisions)
    - CV screening        (hiring decisions)
    - Fraud flagging      (transaction decisions)
    - Customer churn      (engagement decisions)

Each record uses realistic-looking but synthetic data (no real names, no real
ID numbers). Hashes are stable across runs of this script so re-seeding does
not create duplicates as long as event_id stays distinct.

Usage:
    export AUDIT_API_URL=https://<your-api-id>.execute-api.<region>.amazonaws.com/prod
    export AUDIT_DEMO_WRITE_KEY=<the write key of the demo-public tenant>
    python scripts/seed_demo.py

Requires Python 3.10+ and the `requests` library (`pip install requests`).
"""

from __future__ import annotations

import hashlib
import os
import random
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

try:
    import requests
except ImportError:
    print("Missing dependency: pip install requests", file=sys.stderr)
    sys.exit(1)


# ── config ────────────────────────────────────────────────────────────────
API_URL = os.environ.get("AUDIT_API_URL", "").rstrip("/")
WRITE_KEY = os.environ.get("AUDIT_DEMO_WRITE_KEY", "")
if not API_URL or not WRITE_KEY:
    print(
        "Set both AUDIT_API_URL and AUDIT_DEMO_WRITE_KEY environment variables.\n"
        "AUDIT_DEMO_WRITE_KEY must be the write key for the demo-public tenant.",
        file=sys.stderr,
    )
    sys.exit(1)

ENDPOINT = f"{API_URL}/audit/events"

# Spread records across the last 30 days so the default 30-day view shows them.
NOW = datetime.now(timezone.utc)


# ── synthetic data ────────────────────────────────────────────────────────
def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def ts(days_ago: float) -> str:
    return (NOW - timedelta(days=days_ago)).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


SCENARIOS: list[dict] = [
    # ── Loan triage (10 records) ──────────────────────────────────────────
    *[
        {
            "category": "loan",
            "system_prompt": "You are a loan triage assistant for a UK retail bank...",
            "user_input": f"Application LN-{20000+i}: amount £{amount:,}, "
                          f"DTI {dti:.2f}, defaults_12m {defaults}",
            "model": model,
            "decision": decision,
            "hitl": hitl,
            "days_ago": days_ago,
        }
        for i, (amount, dti, defaults, model, decision, hitl, days_ago) in enumerate([
            (8000, 0.18, 0, "claude-sonnet-4-6", {"outcome": "approve", "confidence": 0.93}, False, 1.2),
            (25000, 0.62, 2, "claude-sonnet-4-6", {"outcome": "decline", "confidence": 0.97}, False, 3.4),
            (14000, 0.42, 0, "claude-sonnet-4-6", {"outcome": "refer_to_human", "confidence": 0.78}, True, 5.1),
            (5500, 0.21, 0, "claude-sonnet-4-6", {"outcome": "approve", "confidence": 0.89}, False, 6.7),
            (32000, 0.55, 1, "claude-sonnet-4-6", {"outcome": "decline", "confidence": 0.95}, False, 8.3),
            (12000, 0.41, 0, "claude-sonnet-4-6", {"outcome": "refer_to_human", "confidence": 0.74}, True, 10.5),
            (18000, 0.38, 0, "claude-opus-4-6",    {"outcome": "approve", "confidence": 0.91}, False, 12.2),
            (6000, 0.16, 0, "claude-sonnet-4-6", {"outcome": "approve", "confidence": 0.96}, False, 14.8),
            (22000, 0.48, 0, "claude-sonnet-4-6", {"outcome": "refer_to_human", "confidence": 0.81}, True, 17.0),
            (9500, 0.25, 0, "claude-sonnet-4-6", {"outcome": "approve", "confidence": 0.92}, False, 19.5),
        ])
    ],

    # ── CV screening (8 records) ──────────────────────────────────────────
    *[
        {
            "category": "hiring",
            "system_prompt": "You are a CV screening assistant for a software engineering role...",
            "user_input": f"Candidate CV-{1000+i}: {years_exp} years experience, "
                          f"{skill_match} of 5 required skills matched",
            "model": model,
            "decision": decision,
            "hitl": hitl,
            "days_ago": days_ago,
        }
        for i, (years_exp, skill_match, model, decision, hitl, days_ago) in enumerate([
            (8, 5, "claude-sonnet-4-6", {"outcome": "shortlist", "confidence": 0.94, "tier": "strong"}, False, 2.1),
            (3, 4, "claude-sonnet-4-6", {"outcome": "shortlist", "confidence": 0.82, "tier": "promising"}, False, 4.2),
            (1, 2, "claude-sonnet-4-6", {"outcome": "reject", "confidence": 0.88}, False, 7.5),
            (12, 3, "claude-sonnet-4-6", {"outcome": "review", "confidence": 0.71}, True, 9.8),
            (5, 5, "claude-opus-4-6",    {"outcome": "shortlist", "confidence": 0.95, "tier": "strong"}, False, 11.4),
            (0, 5, "claude-sonnet-4-6", {"outcome": "review", "confidence": 0.69}, True, 13.7),
            (7, 4, "claude-sonnet-4-6", {"outcome": "shortlist", "confidence": 0.86, "tier": "promising"}, False, 16.2),
            (2, 1, "claude-sonnet-4-6", {"outcome": "reject", "confidence": 0.91}, False, 21.0),
        ])
    ],

    # ── Fraud flagging (7 records) ────────────────────────────────────────
    *[
        {
            "category": "fraud",
            "system_prompt": "You are a transaction fraud detection assistant...",
            "user_input": f"Transaction TXN-{50000+i}: £{amount:,} to merchant '{merchant}', "
                          f"location {location}",
            "model": model,
            "decision": decision,
            "hitl": hitl,
            "days_ago": days_ago,
        }
        for i, (amount, merchant, location, model, decision, hitl, days_ago) in enumerate([
            (450, "Acme Office Supplies", "London, UK", "claude-haiku-4-5-20251001",
             {"outcome": "allow", "risk_score": 0.08}, False, 0.3),
            (3200, "Crypto Exchange XYZ", "Lagos, NG", "claude-sonnet-4-6",
             {"outcome": "flag", "risk_score": 0.84, "reasons": ["high_amount", "unusual_geography"]}, True, 1.7),
            (89, "Local Coffee Shop", "Manchester, UK", "claude-haiku-4-5-20251001",
             {"outcome": "allow", "risk_score": 0.04}, False, 2.9),
            (1500, "Online Electronics", "Various", "claude-sonnet-4-6",
             {"outcome": "review", "risk_score": 0.62, "reasons": ["card_not_present", "new_merchant"]}, True, 5.5),
            (12000, "Property Holdings Ltd", "Birmingham, UK", "claude-sonnet-4-6",
             {"outcome": "review", "risk_score": 0.58, "reasons": ["high_amount", "first_payment_to_recipient"]}, True, 8.1),
            (28, "Sandwich Shop", "London, UK", "claude-haiku-4-5-20251001",
             {"outcome": "allow", "risk_score": 0.02}, False, 11.3),
            (4500, "International Wire", "Cayman Islands", "claude-opus-4-6",
             {"outcome": "block", "risk_score": 0.93, "reasons": ["high_risk_jurisdiction", "amount_threshold", "no_prior_pattern"]}, True, 15.6),
        ])
    ],

    # ── Customer churn (5 records) ────────────────────────────────────────
    *[
        {
            "category": "churn",
            "system_prompt": "You are a customer retention analyst...",
            "user_input": f"Customer CUST-{3000+i}: tenure {tenure} months, "
                          f"recent activity score {activity:.2f}, support tickets last 30d: {tickets}",
            "model": model,
            "decision": decision,
            "hitl": hitl,
            "days_ago": days_ago,
        }
        for i, (tenure, activity, tickets, model, decision, hitl, days_ago) in enumerate([
            (36, 0.82, 0, "claude-sonnet-4-6", {"churn_risk": 0.12, "action": "none"}, False, 4.4),
            (8, 0.21, 4, "claude-sonnet-4-6", {"churn_risk": 0.81, "action": "retention_call"}, True, 6.9),
            (24, 0.55, 1, "claude-sonnet-4-6", {"churn_risk": 0.38, "action": "monitor"}, False, 13.2),
            (3, 0.18, 2, "claude-sonnet-4-6", {"churn_risk": 0.74, "action": "discount_offer"}, True, 18.7),
            (60, 0.91, 0, "claude-sonnet-4-6", {"churn_risk": 0.07, "action": "loyalty_reward"}, False, 23.5),
        ])
    ],
]


# ── seed ──────────────────────────────────────────────────────────────────
def main() -> None:
    print(f"Seeding {len(SCENARIOS)} synthetic records into {ENDPOINT}")
    print(f"Spanning {min(s['days_ago'] for s in SCENARIOS):.1f} – "
          f"{max(s['days_ago'] for s in SCENARIOS):.1f} days ago\n")

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-api-key": WRITE_KEY,
    }

    success = 0
    failed = 0

    for i, s in enumerate(SCENARIOS, 1):
        payload = {
            "event_id": str(uuid.uuid4()),
            "timestamp": ts(s["days_ago"]),
            "model_version": s["model"],
            "system_prompt_hash": sha256(s["system_prompt"]),
            "input_data_hash": sha256(s["user_input"]),
            "ai_decision_output": s["decision"],
            "human_in_loop": s["hitl"],
        }

        try:
            r = requests.post(ENDPOINT, headers=headers, json=payload, timeout=10)
            if r.status_code in (200, 202):
                success += 1
                mark = "PASS"
                detail = payload["event_id"][:8]
            else:
                failed += 1
                mark = "FAIL"
                detail = f"HTTP {r.status_code}: {r.text[:80]}"
        except requests.RequestException as e:
            failed += 1
            mark = "FAIL"
            detail = str(e)[:80]

        print(f"  [{i:2}/{len(SCENARIOS)}] {mark}  {s['category']:6}  {detail}")
        time.sleep(0.05)  # gentle pacing — well below rate limits

    print()
    print(f"Seed complete: {success} written, {failed} failed.")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
