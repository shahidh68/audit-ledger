"""CLI entry point — `decide` (single + optional human review) and
`generate` (multi-tenant batch over a finite window)."""

from __future__ import annotations

import asyncio
import json
import random
import sys
from pathlib import Path
from typing import Any

import click
from faker import Faker
from tqdm import tqdm

from resume_screener.config import ConfigError, LedgerConfig, mask_key
from resume_screener.decisioner import decide as run_decision
from resume_screener.human import prompt_human_review, simulate_human_review
from resume_screener.ledger import log_event, make_client
from resume_screener.synth import synthesize


@click.group()
@click.version_option()
def main() -> None:
    """Resume-screening simulator — logs every AI decision to the audit ledger."""


# ── decide ────────────────────────────────────────────────────────────────────


@main.command()
@click.option("--resume", "resume_path", required=True, type=str,
              help="Path to a resume .txt file. Use '-' for stdin.")
@click.option("--jd", "jd_path", required=True, type=str,
              help="Path to a JD .txt file. Use '-' for stdin.")
@click.option("--model-version", default="screener-v0.3", show_default=True)
@click.option("--review/--no-review", default=False,
              help="Prompt for a human review after the AI decision.")
@click.option("--api-key", default=None, envvar="AUDIT_WRITE_KEY",
              help="Tenant write key (env: AUDIT_WRITE_KEY).")
@click.option("--ingest-url", default=None, envvar="AUDIT_INGEST_URL",
              help="Ingest endpoint URL (env: AUDIT_INGEST_URL).")
@click.option("--seed", default=None, type=int,
              help="Deterministic seed for the AI decision noise.")
@click.option("--dry-run", is_flag=True,
              help="Run the decision but skip ledger logging.")
def decide(
    resume_path: str,
    jd_path: str,
    model_version: str,
    review: bool,
    api_key: str | None,
    ingest_url: str | None,
    seed: int | None,
    dry_run: bool,
) -> None:
    """Run a single screening decision and log it."""
    resume_text = _read_text(resume_path)
    jd_text = _read_text(jd_path)

    ai_decision = run_decision(
        resume=resume_text,
        jd=jd_text,
        model_version=model_version,
        seed=seed,
    )

    human_in_loop = False
    if review:
        rev = prompt_human_review(ai_decision)
        if rev is not None:
            ai_decision["human_review"] = rev
            human_in_loop = True

    print(json.dumps(ai_decision, indent=2))

    if dry_run:
        click.echo("✓ dry-run — not logged to ledger", err=True)
        return

    try:
        cfg = LedgerConfig.from_args(ingest_url=ingest_url, api_key=api_key)
    except ConfigError as e:
        raise click.ClickException(str(e))

    asyncio.run(_log_one(
        cfg=cfg,
        resume=resume_text,
        jd=jd_text,
        model_version=model_version,
        ai_decision=ai_decision,
        human_in_loop=human_in_loop,
    ))


async def _log_one(
    *,
    cfg: LedgerConfig,
    resume: str,
    jd: str,
    model_version: str,
    ai_decision: dict[str, Any],
    human_in_loop: bool,
) -> None:
    client = make_client(cfg.ingest_url, cfg.write_keys[0])
    try:
        await log_event(
            client,
            resume=resume,
            jd=jd,
            model_version=model_version,
            ai_decision_output=ai_decision,
            human_in_loop=human_in_loop,
        )
        click.echo(
            f"✓ logged event to ledger ({mask_key(cfg.write_keys[0])})",
            err=True,
        )
    except Exception as e:
        click.echo(f"✗ ledger ingest failed: {e}", err=True)
        sys.exit(2)


# ── generate ──────────────────────────────────────────────────────────────────


@main.command()
@click.option("--count", default=50, show_default=True, type=int,
              help="Total events to generate.")
@click.option("--duration", default="5m", show_default=True,
              help="Window over which to spread events: 30s, 5m, 1h, or bare seconds.")
@click.option("--api-keys", default=None, envvar="AUDIT_WRITE_KEYS",
              help="Comma-separated write keys for multi-tenant (env: AUDIT_WRITE_KEYS).")
@click.option("--api-key", default=None, envvar="AUDIT_WRITE_KEY",
              help="Single write key (env: AUDIT_WRITE_KEY); used if --api-keys not set.")
@click.option("--ingest-url", default=None, envvar="AUDIT_INGEST_URL",
              help="Ingest endpoint URL (env: AUDIT_INGEST_URL).")
@click.option("--model-versions", default="screener-v0.2,screener-v0.3",
              show_default=True,
              help="Comma-separated list to randomize across.")
@click.option("--human-review-rate", default=0.20, show_default=True, type=float,
              help="Fraction of events that get a synthesized human review "
                   "(any 'refer' decision is auto-reviewed regardless).")
@click.option("--human-agreement-rate", default=0.85, show_default=True, type=float,
              help="Fraction of human reviews that agree with the AI.")
@click.option("--concurrency", default=8, show_default=True, type=int)
@click.option("--seed", default=None, type=int,
              help="Seed for reproducible runs.")
def generate(
    count: int,
    duration: str,
    api_keys: str | None,
    api_key: str | None,
    ingest_url: str | None,
    model_versions: str,
    human_review_rate: float,
    human_agreement_rate: float,
    concurrency: int,
    seed: int | None,
) -> None:
    """Generate N synthetic decisions, spread over a finite time window."""
    duration_s = _parse_duration(duration)
    if duration_s <= 0:
        raise click.ClickException("Duration must be > 0.")
    if count <= 0:
        raise click.ClickException("Count must be > 0.")

    try:
        cfg = LedgerConfig.from_args(
            ingest_url=ingest_url,
            api_key=api_key,
            api_keys=api_keys,
        )
    except ConfigError as e:
        raise click.ClickException(str(e))

    versions = [v.strip() for v in model_versions.split(",") if v.strip()]
    if not versions:
        raise click.ClickException("--model-versions must list at least one value.")

    rng = random.Random(seed)

    click.echo(
        f"→ generating {count} events over {duration_s:.0f}s "
        f"across {len(cfg.write_keys)} tenant key(s) "
        f"({', '.join(mask_key(k) for k in cfg.write_keys)}); "
        f"concurrency={concurrency}",
        err=True,
    )

    asyncio.run(_run_generate(
        cfg=cfg,
        count=count,
        duration_s=duration_s,
        versions=versions,
        human_review_rate=human_review_rate,
        human_agreement_rate=human_agreement_rate,
        concurrency=concurrency,
        rng=rng,
    ))


async def _run_generate(
    *,
    cfg: LedgerConfig,
    count: int,
    duration_s: float,
    versions: list[str],
    human_review_rate: float,
    human_agreement_rate: float,
    concurrency: int,
    rng: random.Random,
) -> None:
    faker = Faker()
    Faker.seed(rng.randint(0, 2**31 - 1))

    clients = [make_client(cfg.ingest_url, k) for k in cfg.write_keys]
    sem = asyncio.Semaphore(concurrency)

    base_step = duration_s / count
    fire_offsets = [
        max(0.0, i * base_step + rng.uniform(-base_step * 0.3, base_step * 0.3))
        for i in range(count)
    ]

    progress = tqdm(total=count, unit="ev", file=sys.stderr,
                    desc="ingest", smoothing=0.1)
    successes = 0
    failures = 0

    loop = asyncio.get_running_loop()
    start = loop.time()

    async def one(i: int) -> None:
        nonlocal successes, failures
        delay = fire_offsets[i] - (loop.time() - start)
        if delay > 0:
            await asyncio.sleep(delay)

        async with sem:
            pair = synthesize(rng, faker)
            ai_decision = run_decision(
                resume=pair.resume_text,
                jd=pair.jd_text,
                model_version=rng.choice(versions),
                seed=rng.randint(0, 2**31 - 1),
            )

            human_in_loop = False
            should_review = (
                ai_decision["decision"] == "refer"
                or rng.random() < human_review_rate
            )
            if should_review:
                ai_decision["human_review"] = simulate_human_review(
                    ai_decision,
                    rng=rng,
                    agreement_rate=human_agreement_rate,
                )
                human_in_loop = True

            client = clients[i % len(clients)]
            try:
                await log_event(
                    client,
                    resume=pair.resume_text,
                    jd=pair.jd_text,
                    model_version=ai_decision["model_version"],
                    ai_decision_output=ai_decision,
                    human_in_loop=human_in_loop,
                )
                successes += 1
            except Exception as e:
                failures += 1
                tqdm.write(f"  ! event {i + 1} failed: {e}", file=sys.stderr)
            finally:
                progress.update(1)

    await asyncio.gather(*(one(i) for i in range(count)))
    progress.close()

    elapsed = loop.time() - start
    click.echo(
        f"\n✓ done in {elapsed:.1f}s — {successes} ok, {failures} failed",
        err=True,
    )


# ── helpers ───────────────────────────────────────────────────────────────────


def _read_text(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    p = Path(path)
    if not p.exists():
        raise click.ClickException(f"File not found: {path}")
    return p.read_text(encoding="utf-8")


def _parse_duration(s: str) -> float:
    """Parse '30s', '5m', '1h', or bare seconds. Returns total seconds."""
    s = s.strip().lower()
    if not s:
        raise click.ClickException("Empty duration string.")
    units = {"s": 1.0, "m": 60.0, "h": 3600.0}
    if s[-1] in units:
        try:
            return float(s[:-1]) * units[s[-1]]
        except ValueError:
            pass
    try:
        return float(s)
    except ValueError:
        raise click.ClickException(
            f"Bad duration: '{s}'. Use 30s, 5m, 1h, or a bare number of seconds."
        )


if __name__ == "__main__":
    main()
