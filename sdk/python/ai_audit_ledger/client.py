"""
Async HTTP client — POSTs to API Gateway without blocking the caller's thread
long-term: uses asyncio + aiohttp background task.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import aiohttp

from ai_audit_ledger.hashing import hash_pii, hash_prompt


def _utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class AiAuditLedgerClient:
    """
    B2B client for AI Audit Ledger ingestion.
    Always hash PII locally before building the payload.
    """

    def __init__(
        self,
        *,
        ingest_url: str,
        tenant_api_key: str,
        timeout_s: float = 15.0,
    ) -> None:
        self._ingest_url = ingest_url.rstrip("/")
        self._tenant_api_key = tenant_api_key
        self._timeout = aiohttp.ClientTimeout(total=timeout_s)

    async def log_decision_async(
        self,
        *,
        raw_system_prompt: str,
        raw_user_input: str,
        model_version: str,
        ai_decision_output: Dict[str, Any],
        human_in_loop: bool,
        event_id: Optional[str] = None,
    ) -> None:
        """
        Fire-and-forget style async POST: await only for the HTTP round-trip in your coroutine;
        schedule with asyncio.create_task() to avoid blocking synchronous code.
        """
        payload = {
            "event_id": event_id or str(uuid.uuid4()),
            "timestamp": _utc_iso(),
            "tenant_api_key": self._tenant_api_key,
            "model_version": model_version,
            "system_prompt_hash": hash_prompt(raw_system_prompt),
            "input_data_hash": hash_pii(raw_user_input),
            "ai_decision_output": ai_decision_output,
            "human_in_loop": human_in_loop,
        }
        async with aiohttp.ClientSession(timeout=self._timeout) as session:
            async with session.post(
                self._ingest_url,
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    # Must match body tenant_api_key — API Gateway + Lambda validate together.
                    "x-api-key": self._tenant_api_key,
                },
            ) as resp:
                text = await resp.text()
                if resp.status not in (202, 200):
                    raise RuntimeError(f"Ingest failed: HTTP {resp.status} {text}")

    def schedule_log_decision(
        self,
        *,
        raw_system_prompt: str,
        raw_user_input: str,
        model_version: str,
        ai_decision_output: Dict[str, Any],
        human_in_loop: bool,
        event_id: Optional[str] = None,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> asyncio.Task[None]:
        """
        Schedule ingestion on the event loop so the main thread is not blocked.
        (Caller must run an asyncio loop.)
        """
        coro = self.log_decision_async(
            raw_system_prompt=raw_system_prompt,
            raw_user_input=raw_user_input,
            model_version=model_version,
            ai_decision_output=ai_decision_output,
            human_in_loop=human_in_loop,
            event_id=event_id,
        )
        loop = loop or asyncio.get_event_loop()
        return loop.create_task(coro)


def schedule_fire_and_forget_thread(
    loop: asyncio.AbstractEventLoop,
    client: AiAuditLedgerClient,
    **kwargs: Any,
) -> None:
    """
    From sync code: submit coroutine to a background loop running in another thread.
    """
    asyncio.run_coroutine_threadsafe(client.log_decision_async(**kwargs), loop)
