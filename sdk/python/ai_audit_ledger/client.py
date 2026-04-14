"""
Async HTTP client — POSTs to API Gateway without blocking the caller's thread.
Uses asyncio + aiohttp with per-attempt timeouts, exponential backoff, and a
typed error class.
"""

from __future__ import annotations

import asyncio
import random
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import aiohttp

from ai_audit_ledger.hashing import hash_pii, hash_prompt


# ── internal helpers ──────────────────────────────────────────────────────────

def _utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


async def _with_retry(
    fn: Any,
    attempts: int = 3,
    base_ms: float = 200,
) -> aiohttp.ClientResponse:
    """
    Exponential backoff with full jitter.
    Retries on network errors and 5xx responses only.
    4xx responses (including 429) are returned immediately — retrying them
    would just consume rate-limit quota.

    Args:
        fn:        async callable that returns an aiohttp.ClientResponse
        attempts:  total attempts (1 = no retry)
        base_ms:   initial backoff in milliseconds
    """
    last_err: BaseException = RuntimeError("No attempts made")
    for i in range(attempts):
        try:
            resp = await fn()
            if resp.status < 500:           # success or non-retryable (4xx)
                return resp
            last_err = AuditLedgerError(f"HTTP {resp.status}", status=resp.status)
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            last_err = exc                  # network or timeout error

        if i < attempts - 1:
            jitter = random.random() * base_ms
            delay_s = (base_ms * (2 ** i) + jitter) / 1000
            await asyncio.sleep(delay_s)

    raise last_err


# ── public error type ─────────────────────────────────────────────────────────

class AuditLedgerError(Exception):
    """
    Raised when the audit ledger ingest endpoint returns an error or is unreachable.

    Attributes:
        status: HTTP status code, or None for network / timeout errors.
    """

    def __init__(self, message: str, *, status: Optional[int] = None) -> None:
        super().__init__(f"[ai-audit-ledger] {message}")
        self.status = status


# ── public API ────────────────────────────────────────────────────────────────

class AiAuditLedgerClient:
    """
    B2B client for AI Audit Ledger ingestion.
    Always hashes PII locally before building the payload — raw values never
    leave the caller's environment.

    Args:
        ingest_url:     API Gateway ingest endpoint URL.
        tenant_api_key: Tenant write key; sent as the x-api-key header.
        timeout_s:      Per-attempt HTTP timeout in seconds (default 5).
        retries:        Total attempts per call (default 3; set to 1 to disable retry).
    """

    def __init__(
        self,
        *,
        ingest_url: str,
        tenant_api_key: str,
        timeout_s: float = 5.0,
        retries: int = 3,
    ) -> None:
        self._ingest_url = ingest_url.rstrip("/")
        self._tenant_api_key = tenant_api_key
        self._timeout_s = timeout_s
        self._retries = retries

    async def log_decision_async(
        self,
        *,
        raw_system_prompt: str,
        raw_user_input: str,
        model_version: str,
        ai_decision_output: dict[str, Any],
        human_in_loop: bool,
        event_id: Optional[str] = None,
    ) -> None:
        """
        POST one AI decision event to the audit ledger and await confirmation.
        Raises AuditLedgerError on permanent failure (after all retry attempts).

        Awaiting this coroutine blocks only for the HTTP round-trip.
        For fire-and-forget behaviour use schedule_log_decision() instead.
        """
        payload = {
            "event_id":           event_id or str(uuid.uuid4()),
            "timestamp":          _utc_iso(),
            "tenant_api_key":     self._tenant_api_key,
            "model_version":      model_version,
            "system_prompt_hash": hash_prompt(raw_system_prompt),
            "input_data_hash":    hash_pii(raw_user_input),
            "ai_decision_output": ai_decision_output,
            "human_in_loop":      human_in_loop,
        }
        headers = {
            "Content-Type": "application/json",
            "Accept":        "application/json",
            "x-api-key":     self._tenant_api_key,
        }

        # A new ClientSession per call keeps connection state out of the client
        # object and avoids cross-task sharing. The per-attempt timeout is set
        # here so each retry gets a fresh clock rather than sharing one budget.
        async def attempt() -> aiohttp.ClientResponse:
            timeout = aiohttp.ClientTimeout(total=self._timeout_s)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                resp = await session.post(
                    self._ingest_url,
                    json=payload,
                    headers=headers,
                )
                # Read body here so the connection is released before we return.
                await resp.read()
                return resp

        resp = await _with_retry(attempt, attempts=self._retries)

        if resp.status not in (200, 202):
            body = (await resp.text()) if not resp.content.is_eof() else ""
            raise AuditLedgerError(
                f"ingest failed: HTTP {resp.status} {body}",
                status=resp.status,
            )

    def schedule_log_decision(
        self,
        *,
        raw_system_prompt: str,
        raw_user_input: str,
        model_version: str,
        ai_decision_output: dict[str, Any],
        human_in_loop: bool,
        event_id: Optional[str] = None,
    ) -> asyncio.Task[None]:
        """
        Schedule ingestion as a background asyncio Task.
        Returns immediately; the HTTP call runs concurrently on the running loop.
        Errors are logged to stderr and never re-raised.

        Must be called from within a running asyncio event loop
        (e.g. inside an async function or FastAPI handler).
        """
        async def _run() -> None:
            try:
                await self.log_decision_async(
                    raw_system_prompt=raw_system_prompt,
                    raw_user_input=raw_user_input,
                    model_version=model_version,
                    ai_decision_output=ai_decision_output,
                    human_in_loop=human_in_loop,
                    event_id=event_id,
                )
            except AuditLedgerError as exc:
                import sys
                print(f"[ai-audit-ledger] {exc}", file=sys.stderr)

        return asyncio.get_running_loop().create_task(_run())


def schedule_fire_and_forget_thread(
    loop: asyncio.AbstractEventLoop,
    client: AiAuditLedgerClient,
    **kwargs: Any,
) -> asyncio.Future[None]:
    """
    Submit ingestion from synchronous code to a background asyncio event loop
    running in another thread (e.g. created with asyncio.new_event_loop()).

    Returns the concurrent.futures.Future wrapping the coroutine — callers
    can ignore it for true fire-and-forget, or await it if they need to know
    the outcome.

    Example:
        bg_loop = asyncio.new_event_loop()
        threading.Thread(target=bg_loop.run_forever, daemon=True).start()
        schedule_fire_and_forget_thread(bg_loop, client, raw_system_prompt=..., ...)
    """
    return asyncio.run_coroutine_threadsafe(
        client.log_decision_async(**kwargs),
        loop,
    )
