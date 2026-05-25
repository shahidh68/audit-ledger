"""Local SHA-256 hashing — raw PII never leaves the tenant's environment."""

from __future__ import annotations

import hashlib


def hash_pii(raw: str | bytes, *, encoding: str = "utf-8") -> str:
    """
    Hash arbitrary text (e.g. resume body, candidate name) with SHA-256.
    Returns lowercase hex digest for use as input_data_hash in the API payload.
    """
    if isinstance(raw, str):
        data = raw.encode(encoding)
    else:
        data = raw
    return hashlib.sha256(data).hexdigest()


def hash_prompt(prompt: str, *, encoding: str = "utf-8") -> str:
    """Hash system prompt text for system_prompt_hash (never send raw prompt)."""
    return hash_pii(prompt, encoding=encoding)
