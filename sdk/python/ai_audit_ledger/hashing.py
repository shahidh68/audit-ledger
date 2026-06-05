"""
Local hashing — raw PII never leaves the tenant's environment.

By default this module uses HMAC-SHA256 keyed off the AUDIT_HMAC_KEY
environment variable. Keyed hashing makes the output non-reversible by
anyone who does not hold the key, which is what regulators (ICO / EDPB)
expect when you describe a value as pseudonymised rather than identifiable.

Backwards-compatible fallback:
  If AUDIT_HMAC_KEY is not set, the functions fall back to plain SHA-256
  so existing deployments do not break. A one-time DeprecationWarning is
  emitted on first use to nudge callers to upgrade. The default will flip
  in a future major version.

Generate a key once per tenant and store it next to AUDIT_WRITE_KEY:
  python -c "import secrets; print(secrets.token_hex(32))"
The key never leaves your environment.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import warnings

_FALLBACK_WARNED = False


def _get_key() -> bytes | None:
    """Read AUDIT_HMAC_KEY from env. Returns bytes or None if unset/empty."""
    raw = os.environ.get("AUDIT_HMAC_KEY", "").strip()
    if not raw:
        return None
    return raw.encode("utf-8")


def _warn_fallback_once() -> None:
    global _FALLBACK_WARNED
    if _FALLBACK_WARNED:
        return
    _FALLBACK_WARNED = True
    warnings.warn(
        "AUDIT_HMAC_KEY is not set; falling back to plain SHA-256 for PII "
        "hashing. Plain SHA-256 of low-entropy values (names, emails) is "
        "brute-forceable and should not be treated as anonymisation under "
        "ICO/EDPB guidance. Set AUDIT_HMAC_KEY to a 32+ byte secret to "
        "switch to keyed HMAC-SHA256. This fallback will be removed in a "
        "future major version.",
        DeprecationWarning,
        stacklevel=3,
    )


def hash_pii(raw: str | bytes, *, encoding: str = "utf-8") -> str:
    """
    Hash arbitrary text (e.g. resume body, candidate name) for use as
    input_data_hash in the API payload.

    Returns a lowercase 64-char hex digest. The format is identical
    whether HMAC or plain SHA-256 is used, so the wire format does
    not change.
    """
    if isinstance(raw, str):
        data = raw.encode(encoding)
    else:
        data = raw

    key = _get_key()
    if key is None:
        _warn_fallback_once()
        return hashlib.sha256(data).hexdigest()
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def hash_prompt(prompt: str, *, encoding: str = "utf-8") -> str:
    """Hash system prompt text for system_prompt_hash (never send raw prompt)."""
    return hash_pii(prompt, encoding=encoding)
