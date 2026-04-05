"""
AI Audit Ledger — ingestion payload (EU AI Act Article 12).
PII is never stored; only cryptographic hashes and decision metadata.
"""

from __future__ import annotations

from typing import Any, Dict

from pydantic import BaseModel, Field, field_validator
import re

_UUID4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)


class AiAuditIngestionPayload(BaseModel):
    """Validated JSON body for POST /audit ingestion."""

    event_id: str = Field(..., description="UUID v4 for this decision event")
    timestamp: str = Field(..., description="ISO 8601 UTC datetime")
    tenant_api_key: str = Field(..., min_length=1, description="B2B tenant API key")
    model_version: str = Field(..., min_length=1)
    system_prompt_hash: str = Field(..., description="SHA-256 hex of system prompt")
    input_data_hash: str = Field(..., description="SHA-256 hex of hashed user input")
    ai_decision_output: Dict[str, Any] = Field(..., description="Structured AI output JSON")
    human_in_loop: bool

    @field_validator("event_id")
    @classmethod
    def validate_uuid_v4(cls, v: str) -> str:
        if not _UUID4.match(v.strip()):
            raise ValueError("event_id must be a UUID v4 string")
        return v.lower()

    @field_validator("system_prompt_hash", "input_data_hash")
    @classmethod
    def validate_sha256(cls, v: str) -> str:
        s = v.strip().lower()
        if not _SHA256.match(s):
            raise ValueError("must be 64-character lowercase hex SHA-256")
        return s

    model_config = {"extra": "forbid"}
