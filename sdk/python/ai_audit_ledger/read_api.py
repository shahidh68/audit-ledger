"""
Read-side helpers for the AI Audit Ledger API.

The ingest client is intentionally write-only — fire-and-forget logging
should not need any read setup. This module provides the small read-side
calls that complement it: today verify_completeness; future verify_decision
and list_decisions when needed.

Auth uses a read key (separate namespace from the write key). Read keys
cannot write; write keys cannot read.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional, TypedDict

import aiohttp

from ai_audit_ledger.client import AuditLedgerError, _with_retry


class CompletenessRange(TypedDict):
    from_: int  # `from` is reserved in Python; alias on access
    to: int


class CompletenessResult(TypedDict, total=False):
    """Response from GET /audit/verify-completeness."""
    tenant_id:      str
    range:          dict[str, int]
    expected_count: int
    found_count:    int
    missing:        list[int]
    note:           str


async def verify_completeness(
    *,
    api_url: str,
    read_key: str,
    from_seq: Optional[int] = None,
    to_seq: Optional[int] = None,
    tenant_id: Optional[str] = None,
    timeout_s: float = 10.0,
    retries: int = 3,
) -> CompletenessResult:
    """
    Detect deleted or omitted audit records for the caller's tenant.

    The ledger compares its per-tenant monotonic sequence counter against
    the records actually present in storage and returns any sequence
    numbers that are missing. Each gap is a record that was either deleted,
    lost during SQS redelivery, or never stored. The processor logs
    burned_sequence entries for the redelivery case so operators can
    distinguish deliberate deletion from observable infrastructure noise.

    Args:
        api_url:    Base API URL (no trailing /audit segment).
        read_key:   Tenant read key, sent as x-api-key.
        from_seq:   Optional inclusive lower bound. Defaults to 1.
        to_seq:     Optional inclusive upper bound. Defaults to current counter.
        tenant_id:  Required only when calling with the admin read key.
        timeout_s:  Per-attempt HTTP timeout in seconds.
        retries:    Total attempts (1 = no retry).

    Returns:
        CompletenessResult dict.

    Raises:
        AuditLedgerError: if the API returns a non-200 status or is unreachable
            after all retry attempts.
    """
    base = api_url.rstrip("/")
    params: dict[str, Any] = {}
    if from_seq is not None: params["from"]      = from_seq
    if to_seq   is not None: params["to"]        = to_seq
    if tenant_id:            params["tenant_id"] = tenant_id

    async def attempt() -> aiohttp.ClientResponse:
        timeout = aiohttp.ClientTimeout(total=timeout_s)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            resp = await session.get(
                f"{base}/audit/verify-completeness",
                params=params,
                headers={"Accept": "application/json", "x-api-key": read_key},
            )
            # Read body before the session context exits so the connection
            # is released cleanly.
            await resp.read()
            return resp

    resp = await _with_retry(attempt, attempts=retries)
    if resp.status != 200:
        body = (await resp.text()) if not resp.content.is_eof() else ""
        raise AuditLedgerError(
            f"verify_completeness failed: HTTP {resp.status} {body}",
            status=resp.status,
        )
    return await resp.json()  # type: ignore[no-any-return]


def verify_completeness_sync(
    *,
    api_url: str,
    read_key: str,
    from_seq: Optional[int] = None,
    to_seq: Optional[int] = None,
    tenant_id: Optional[str] = None,
    timeout_s: float = 10.0,
    retries: int = 3,
) -> CompletenessResult:
    """
    Synchronous wrapper around verify_completeness for scripts and notebooks.
    Do not call from inside an async context — use the async version directly.
    """
    return asyncio.run(verify_completeness(
        api_url=api_url,
        read_key=read_key,
        from_seq=from_seq,
        to_seq=to_seq,
        tenant_id=tenant_id,
        timeout_s=timeout_s,
        retries=retries,
    ))
