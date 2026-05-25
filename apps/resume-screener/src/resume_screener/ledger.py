"""Thin async wrapper around AiAuditLedgerClient — the SDK 'bolt-in' point."""

from __future__ import annotations

from typing import Any

from ai_audit_ledger import AiAuditLedgerClient
from ai_audit_ledger.client import AuditLedgerError


def make_client(
    ingest_url: str,
    write_key: str,
    *,
    timeout_s: float = 5.0,
    retries: int = 3,
) -> AiAuditLedgerClient:
    return AiAuditLedgerClient(
        ingest_url=ingest_url,
        tenant_api_key=write_key,
        timeout_s=timeout_s,
        retries=retries,
    )


async def log_event(
    client: AiAuditLedgerClient,
    *,
    resume: str,
    jd: str,
    model_version: str,
    ai_decision_output: dict[str, Any],
    human_in_loop: bool,
) -> None:
    """POST one decision to the audit ledger via the SDK."""
    await client.log_decision_async(
        raw_system_prompt=jd,
        raw_user_input=resume,
        model_version=model_version,
        ai_decision_output=ai_decision_output,
        human_in_loop=human_in_loop,
    )


__all__ = ["make_client", "log_event", "AuditLedgerError"]
