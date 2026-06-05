"""
Unit tests for ai_audit_ledger.hashing.

Covers:
  - HMAC path when AUDIT_HMAC_KEY is set
  - Plain SHA-256 fallback when AUDIT_HMAC_KEY is absent
  - Backwards compatibility with pre-HMAC hash output
  - One-time DeprecationWarning on fallback
  - Output shape stability (64-char lowercase hex)

Run from the python SDK root:
  python -m unittest tests.test_hashing
"""

from __future__ import annotations

import hashlib
import hmac
import importlib
import os
import unittest
import warnings


def _fresh_module():
    """Reimport the module so the one-time-warned flag resets between tests."""
    from ai_audit_ledger import hashing  # noqa: WPS433
    return importlib.reload(hashing)


class HashingTests(unittest.TestCase):

    def setUp(self) -> None:
        # Snapshot env so tests do not leak state.
        self._prev_key = os.environ.pop("AUDIT_HMAC_KEY", None)

    def tearDown(self) -> None:
        if self._prev_key is not None:
            os.environ["AUDIT_HMAC_KEY"] = self._prev_key
        else:
            os.environ.pop("AUDIT_HMAC_KEY", None)

    # ── fallback path ────────────────────────────────────────────────────────

    def test_fallback_matches_plain_sha256_for_back_compat(self) -> None:
        """Without AUDIT_HMAC_KEY, output must equal the historical SHA-256.

        This guarantees existing deployments do not break — anything that
        already trusted the old digest still gets the same value.
        """
        hashing = _fresh_module()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            result = hashing.hash_pii("alice@example.com")
        expected = hashlib.sha256(b"alice@example.com").hexdigest()
        self.assertEqual(result, expected)

    def test_fallback_warns_once(self) -> None:
        hashing = _fresh_module()
        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always", DeprecationWarning)
            hashing.hash_pii("one")
            hashing.hash_pii("two")
            hashing.hash_prompt("three")
        dep = [w for w in captured if issubclass(w.category, DeprecationWarning)]
        self.assertEqual(len(dep), 1, "DeprecationWarning should fire only once per process")

    # ── HMAC path ────────────────────────────────────────────────────────────

    def test_hmac_path_used_when_key_set(self) -> None:
        os.environ["AUDIT_HMAC_KEY"] = "k" * 64
        hashing = _fresh_module()
        result = hashing.hash_pii("alice@example.com")
        expected = hmac.new(b"k" * 64, b"alice@example.com", hashlib.sha256).hexdigest()
        self.assertEqual(result, expected)

    def test_hmac_differs_from_plain_sha(self) -> None:
        os.environ["AUDIT_HMAC_KEY"] = "secret-key-value"
        hashing = _fresh_module()
        keyed = hashing.hash_pii("alice@example.com")
        plain = hashlib.sha256(b"alice@example.com").hexdigest()
        self.assertNotEqual(keyed, plain)

    def test_empty_key_treated_as_unset(self) -> None:
        os.environ["AUDIT_HMAC_KEY"] = "   "
        hashing = _fresh_module()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            result = hashing.hash_pii("x")
        self.assertEqual(result, hashlib.sha256(b"x").hexdigest())

    # ── shape ────────────────────────────────────────────────────────────────

    def test_output_shape_is_stable_across_paths(self) -> None:
        """Wire format does not change — 64-char lowercase hex either way."""
        for env_value in (None, "abc123"):
            os.environ.pop("AUDIT_HMAC_KEY", None)
            if env_value is not None:
                os.environ["AUDIT_HMAC_KEY"] = env_value
            hashing = _fresh_module()
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                out = hashing.hash_pii("payload")
            self.assertRegex(out, r"^[0-9a-f]{64}$")

    def test_bytes_input_supported(self) -> None:
        hashing = _fresh_module()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            from_str = hashing.hash_pii("hello")
            from_bytes = hashing.hash_pii(b"hello")
        self.assertEqual(from_str, from_bytes)


if __name__ == "__main__":
    unittest.main()
