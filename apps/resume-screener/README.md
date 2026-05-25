# Resume-Screener Simulator

A small Python CLI that simulates an AI making resume-screening decisions, with the AI Audit Ledger Python SDK bolted in. Every decision — and the human review of it, when present — is logged to the ledger.

This app lives entirely under `apps/resume-screener/`. It does not modify any existing infrastructure or SDK code.

## Install

From the repo root (`ai-audit-ledger/`):

```bash
# 1. Install the SDK in editable mode
pip install -e ./sdk/python

# 2. Install this app in editable mode
pip install -e ./apps/resume-screener
```

Requires Python 3.11+.

## Configure

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `AUDIT_INGEST_URL` | API Gateway ingest endpoint (`.../prod/audit/events`) |
| `AUDIT_WRITE_KEY` | A single tenant write key — used by `decide` |
| `AUDIT_WRITE_KEYS` | Comma-separated write keys — used by `generate` for multi-tenant |

Write keys come from `TenantKeyMapSecret` in AWS Secrets Manager (different secret from the dashboard's read keys).

## Use

### `decide` — single decision, optional human review

```bash
python -m resume_screener decide \
  --resume samples/resume.txt \
  --jd samples/jd.txt \
  --review
```

`--review` prompts you interactively after the AI decides. The captured review (reviewer, final decision, agreement, reason, timestamp) is attached to the event payload at `ai_decision_output.human_review`, and `human_in_loop` is set to `true`.

Useful flags:

| Flag | Default | Notes |
|---|---|---|
| `--model-version` | `screener-v0.3` | label written to the event |
| `--review / --no-review` | `--no-review` | trigger the interactive prompt |
| `--seed` | random | deterministic decision |
| `--dry-run` | off | run the decision but skip ledger logging |

### `generate` — synthetic batch over a finite window

Spreads `--count` events evenly over a `--duration` window (default 5 minutes), so the dashboard's KPI strip and sparkline animate live. Never indefinite.

```bash
python -m resume_screener generate \
  --count 100 \
  --duration 5m \
  --human-review-rate 0.25
```

For multi-tenant (round-robins through the keys, populating the dashboard's Tenants KPI):

```bash
python -m resume_screener generate \
  --count 120 \
  --duration 5m \
  --api-keys "key-acme,key-globex,key-initech"
```

Useful flags:

| Flag | Default | Notes |
|---|---|---|
| `--count` | 50 | total events |
| `--duration` | `5m` | total window; `30s`, `5m`, `1h`, or bare seconds |
| `--concurrency` | 8 | simultaneous in-flight HTTP calls |
| `--model-versions` | `screener-v0.2,screener-v0.3` | randomized per event |
| `--human-review-rate` | 0.20 | any `refer` decision is auto-reviewed regardless |
| `--human-agreement-rate` | 0.85 | of reviews, fraction that agree with the AI |
| `--seed` | random | for reproducibility |

## Architecture

| File | Role |
|---|---|
| `decisioner.py` | The "AI" — pure, deterministic decision function |
| `scoring.py` | Skill / experience / education scorers |
| `synth.py` | Synthetic JDs and resume archetypes for batch mode |
| `human.py` | Interactive review prompt + simulated review for batch |
| `ledger.py` | Thin async wrapper over the existing `AiAuditLedgerClient` |
| `cli.py` | Click commands: `decide`, `generate` |
| `config.py` | `.env` + flag resolution |

The integration with the audit ledger is intentionally six lines (see `ledger.py`). The SDK already hashes locally — raw resume and JD text never leave the process.

## Test

```bash
pip install -e "./apps/resume-screener[dev]"
pytest apps/resume-screener
```

The unit tests cover scoring determinism, decision-boundary cases, and synthesized data validity. They do not hit the network.
