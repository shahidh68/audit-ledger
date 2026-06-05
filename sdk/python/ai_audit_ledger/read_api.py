"""
Read-side helpers for the AI Audit Ledger API.

The ingest client is intentionally write-only: fire-and-forget logging
should not need any read setup. This module provides the read-side calls
that complement it:

  - verify_decision     tamper-evidence check for one specific record
  - verify_completeness proof that no records have been deleted
  - list_decisions      browse recent records for the calling tenant

Each function has both an async form (for use inside an asyncio loop) and
a sync wrapper (for scripts and notebooks).

Auth uses a read key (separate namespace from the write key). Read keys
cannot write; write keys cannot read.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional, TypedDict
from urllib.parse import quote

import aiohttp

from ai_audit_ledger.client import AuditLedgerError, _with_retry


# ── response shapes ──────────────────────────────────────────────────────────

class DecisionRecord(TypedDict, total=False):
    """Shape of a single audit record as returned by the read API."""
    event_id:           str
    timestamp:          str
    tenant_id:          str
    model_version:      str
    system_prompt_hash: str
    input_data_hash:    str
    ai_decision_output: dict[str, Any]
    human_in_loop:      bool
    sequence_no:        int  # present from v0.3 onward


class TamperCheckResult(TypedDict, total=False):
    """Response from GET /audit/events/{event_id}/history."""
    event_id:           str
    integrity_verified: bool
    integrity_note:     str
    current_record:     DecisionRecord  # the DynamoDB copy
    archived_record:    DecisionRecord  # the S3 Object Lock copy


class CompletenessResult(TypedDict, total=False):
    """Response from GET /audit/verify-completeness."""
    tenant_id:      str
    range:          dict[str, int]
    expected_count: int
    found_count:    int
    missing:        list[int]
    note:           str


class ListDecisionsResult(TypedDict, total=False):
    """Response from GET /audit/logs."""
    items:     list[DecisionRecord]
    count:     int
    tenant_id: str  # omitted for admin callers (cross-tenant)


# ── internal: GET with retry, shared by all three read helpers ───────────────

async def _get_json_with_retry(
    *,
    url: str,
    read_key: str,
    endpoint_name: str,
    params: Optional[dict[str, Any]] = None,
    timeout_s: float = 10.0,
    retries: int = 3,
) -> Any:
    async def attempt() -> aiohttp.ClientResponse:
        timeout = aiohttp.ClientTimeout(total=timeout_s)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            resp = await session.get(
                url,
                params=params,
                headers={"Accept": "application/json", "x-api-key": read_key},
            )
            await resp.read()
            return resp

    resp = await _with_retry(attempt, attempts=retries)
    if resp.status != 200:
        body = (await resp.text()) if not resp.content.is_eof() else ""
        raise AuditLedgerError(
            f"{endpoint_name} failed: HTTP {resp.status} {body}",
            status=resp.status,
        )
    return await resp.json()


# ── verify_decision ──────────────────────────────────────────────────────────

async def verify_decision(
    *,
    api_url: str,
    read_key: str,
    event_id: str,
    timeout_s: float = 10.0,
    retries: int = 3,
) -> TamperCheckResult:
    """
    Tamper-evidence check for one specific recorded decision.

    The ledger fetches both the DynamoDB copy (queryable index) and the S3
    Object Lock copy (immutable archive) of the requested event and compares
    them with stable JSON serialisation. integrity_verified is True when they
    match exactly. A mismatch flips it to False with a warning in integrity_note.

    Args:
        api_url:   Base API URL (no trailing /audit segment).
        read_key:  Tenant read key, sent as x-api-key.
        event_id:  UUID v4 of the event to verify.
        timeout_s: Per-attempt HTTP timeout in seconds.
        retries:   Total attempts (1 = no retry).

    Returns:
        TamperCheckResult dict.

    Raises:
        AuditLedgerError: if the API returns a non-200 status or is unreachable
            after all retry attempts.
        ValueError: if event_id is empty.
    """
    if not event_id:
        raise ValueError("event_id is required for verify_decision")
    base = api_url.rstrip("/")
    url = f"{base}/audit/events/{quote(event_id, safe='')}/history"
    return await _get_json_with_retry(
        url=url,
        read_key=read_key,
        endpoint_name="verify_decision",
        timeout_s=timeout_s,
        retries=retries,
    )


def verify_decision_sync(
    *,
    api_url: str,
    read_key: str,
    event_id: str,
    timeout_s: float = 10.0,
    retries: int = 3,
) -> TamperCheckResult:
    """
    Synchronous wrapper around verify_decision for scripts and notebooks.
    Do not call from inside an async context: use the async version directly.
    """
    return asyncio.run(verify_decision(
        api_url=api_url,
        read_key=read_key,
        event_id=event_id,
        timeout_s=timeout_s,
        retries=retries,
    ))


# ── verify_completeness ──────────────────────────────────────────────────────

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
    return await _get_json_with_retry(
        url=f"{base}/audit/verify-completeness",
        read_key=read_key,
        endpoint_name="verify_completeness",
        params=params,
        timeout_s=timeout_s,
        retries=retries,
    )


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
    Do not call from inside an async context: use the async version directly.
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


# ── list_decisions ───────────────────────────────────────────────────────────

async def list_decisions(
    *,
    api_url: str,
    read_key: str,
    from_ts: Optional[str] = None,
    to_ts: Optional[str] = None,
    timeout_s: float = 10.0,
    retries: int = 3,
) -> ListDecisionsResult:
    """
    Browse recent audit records for the caller's tenant.

    Optional from_ts and to_ts filter to a date range (ISO 8601 strings,
    compared lexicographically against the sort key which encodes timestamp).
    Tenant-scoped automatically by the read key; an admin key returns records
    across all tenants.

    Args:
        api_url:   Base API URL (no trailing /audit segment).
        read_key:  Tenant read key, sent as x-api-key.
        from_ts:   Optional inclusive lower bound on timestamp (ISO 8601).
        to_ts:     Optional inclusive upper bound on timestamp (ISO 8601).
        timeout_s: Per-attempt HTTP timeout in seconds.
        retries:   Total attempts (1 = no retry).

    Returns:
        ListDecisionsResult dict with items, count, and (for tenant callers)
        tenant_id.

    Raises:
        AuditLedgerError: if the API returns a non-200 status or is unreachable
            after all retry attempts.
    """
    base = api_url.rstrip("/")
    params: dict[str, Any] = {}
    if from_ts: params["from"] = from_ts
    if to_ts:   params["to"]   = to_ts
    return await _get_json_with_retry(
        url=f"{base}/audit/logs",
        read_key=read_key,
        endpoint_name="list_decisions",
        params=params,
        timeout_s=timeout_s,
        retries=retries,
    )


def list_decisions_sync(
    *,
    api_url: str,
    read_key: str,
    from_ts: Optional[str] = None,
    to_ts: Optional[str] = None,
    timeout_s: float = 10.0,
    retries: int = 3,
) -> ListDecisionsResult:
    """
    Synchronous wrapper around list_decisions for scripts and notebooks.
    Do not call from inside an async context: use the async version directly.
    """
    return asyncio.run(list_decisions(
        api_url=api_url,
        read_key=read_key,
        from_ts=from_ts,
        to_ts=to_ts,
        timeout_s=timeout_s,
        retries=retries,
    ))
