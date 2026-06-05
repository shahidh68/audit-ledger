"""AI Audit Ledger Python SDK (local hashing + async ingestion + read-side helpers)."""

from ai_audit_ledger.client import AiAuditLedgerClient, schedule_fire_and_forget_thread
from ai_audit_ledger.hashing import hash_pii, hash_prompt
from ai_audit_ledger.read_api import (
    verify_decision,
    verify_decision_sync,
    verify_completeness,
    verify_completeness_sync,
    list_decisions,
    list_decisions_sync,
    DecisionRecord,
    TamperCheckResult,
    CompletenessResult,
    ListDecisionsResult,
)

__all__ = [
    "AiAuditLedgerClient",
    "schedule_fire_and_forget_thread",
    "hash_pii",
    "hash_prompt",
    "verify_decision",
    "verify_decision_sync",
    "verify_completeness",
    "verify_completeness_sync",
    "list_decisions",
    "list_decisions_sync",
    "DecisionRecord",
    "TamperCheckResult",
    "CompletenessResult",
    "ListDecisionsResult",
]
