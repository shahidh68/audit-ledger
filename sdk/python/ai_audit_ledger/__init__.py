"""AI Audit Ledger Python SDK (local hashing + async ingestion + completeness check)."""

from ai_audit_ledger.client import AiAuditLedgerClient, schedule_fire_and_forget_thread
from ai_audit_ledger.hashing import hash_pii, hash_prompt
from ai_audit_ledger.read_api import (
    verify_completeness,
    verify_completeness_sync,
    CompletenessResult,
)

__all__ = [
    "AiAuditLedgerClient",
    "hash_pii",
    "hash_prompt",
    "schedule_fire_and_forget_thread",
    "verify_completeness",
    "verify_completeness_sync",
    "CompletenessResult",
]
