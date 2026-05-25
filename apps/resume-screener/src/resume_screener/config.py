"""Environment + CLI flag configuration loader."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


def _load_env_once() -> None:
    cwd_env = Path.cwd() / ".env"
    if cwd_env.exists():
        load_dotenv(cwd_env, override=False)


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class LedgerConfig:
    ingest_url: str
    write_keys: tuple[str, ...]

    @classmethod
    def from_args(
        cls,
        *,
        ingest_url: str | None,
        api_key: str | None = None,
        api_keys: str | None = None,
    ) -> "LedgerConfig":
        _load_env_once()

        url = (ingest_url or os.getenv("AUDIT_INGEST_URL", "")).strip()
        if not url:
            raise ConfigError(
                "Missing ingest URL. Set --ingest-url or AUDIT_INGEST_URL."
            )

        if api_keys is not None and api_keys.strip():
            keys = _split_keys(api_keys)
        elif api_key is not None and api_key.strip():
            keys = (api_key.strip(),)
        else:
            multi = os.getenv("AUDIT_WRITE_KEYS", "").strip()
            single = os.getenv("AUDIT_WRITE_KEY", "").strip()
            if multi:
                keys = _split_keys(multi)
            elif single:
                keys = (single,)
            else:
                raise ConfigError(
                    "Missing write key. Set --api-key, --api-keys, "
                    "AUDIT_WRITE_KEY, or AUDIT_WRITE_KEYS."
                )

        if not keys:
            raise ConfigError("At least one non-empty write key is required.")

        return cls(ingest_url=url.rstrip("/"), write_keys=keys)


def _split_keys(raw: str) -> tuple[str, ...]:
    return tuple(k.strip() for k in raw.split(",") if k.strip())


def mask_key(key: str) -> str:
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:4]}…{key[-4:]}"
