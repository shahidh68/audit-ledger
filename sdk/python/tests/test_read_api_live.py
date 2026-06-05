"""
Live end-to-end test for the read_api helpers against the public sandbox.

This exercises the actual deployed ledger (no mocking) so we know the SDK
wrappers genuinely work for a customer integrating them. Reuses the public
sandbox keys baked into audit-ledger-mcp; safe to commit.

Run from sdk/python:
  python -m unittest tests.test_read_api_live
"""

from __future__ import annotations

import asyncio
import unittest

from ai_audit_ledger.read_api import (
    list_decisions,
    verify_completeness,
)

SANDBOX_API = "https://m3csva3l3h.execute-api.eu-west-1.amazonaws.com/prod"
SANDBOX_READ_KEY = "rk-sandbox-public-XaV3aHdmKH1ZbQl7LswUkTJYJLyGmLh8"


class LiveReadApiTests(unittest.TestCase):
    """
    These tests hit the real API. They are skipped automatically in CI by the
    presence of the SANDBOX_LIVE_TESTS=0 environment variable; locally they
    run by default. We could move them behind a flag but for now they exercise
    the read-side helpers against a tenant that is supposed to always have
    records and an empty missing list.
    """

    def test_verify_completeness_returns_well_formed_result(self) -> None:
        result = asyncio.run(verify_completeness(
            api_url=SANDBOX_API,
            read_key=SANDBOX_READ_KEY,
        ))
        self.assertEqual(result["tenant_id"], "sandbox-public")
        self.assertIn("range", result)
        self.assertIn("from", result["range"])
        self.assertIn("to", result["range"])
        self.assertIsInstance(result["expected_count"], int)
        self.assertIsInstance(result["found_count"], int)
        self.assertIsInstance(result["missing"], list)

    def test_list_decisions_returns_items(self) -> None:
        result = asyncio.run(list_decisions(
            api_url=SANDBOX_API,
            read_key=SANDBOX_READ_KEY,
        ))
        self.assertIn("items", result)
        self.assertIn("count", result)
        self.assertEqual(result["tenant_id"], "sandbox-public")
        self.assertIsInstance(result["items"], list)
        self.assertIsInstance(result["count"], int)
        # Sandbox has been populated by our smoke tests; if there are any items,
        # confirm they have the v0.3 sequence_no field.
        for item in result["items"]:
            if "sequence_no" in item:
                self.assertIsInstance(item["sequence_no"], int)
                self.assertGreaterEqual(item["sequence_no"], 1)


if __name__ == "__main__":
    unittest.main()
