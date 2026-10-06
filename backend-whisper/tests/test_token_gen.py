"""Tests for backend API-key generation.

The token is the only thing standing between a 0.0.0.0-bound backend and the
rest of the network, so these tests pin the properties that matter: enough
entropy to be unguessable, a charset that survives copy/paste into a web form
and a JSON config file, and a fresh value on every call.
"""
import re
import unittest

from app.token_gen import MIN_TOKEN_CHARS, TOKEN_BYTES, generate_token, looks_generated

# secrets.token_urlsafe emits base64url without padding.
_URLSAFE = re.compile(r"^[A-Za-z0-9_-]+$")


class GenerateTokenTests(unittest.TestCase):
    def test_uses_url_and_json_safe_characters(self):
        # The token is pasted into a web form, stored in JSON, and sent in an
        # HTTP header — anything needing escaping in one of those would make it
        # a support problem rather than a secret.
        self.assertRegex(generate_token(), _URLSAFE)

    def test_every_call_returns_a_fresh_value(self):
        tokens = {generate_token() for _ in range(50)}
        self.assertEqual(len(tokens), 50)

    def test_default_carries_at_least_256_bits(self):
        self.assertGreaterEqual(TOKEN_BYTES, 32)
        self.assertGreaterEqual(len(generate_token()), MIN_TOKEN_CHARS)

    def test_byte_count_is_configurable(self):
        # base64url is 4 characters per 3 bytes, so more bytes must mean a
        # longer token; the exact length is an encoding detail.
        self.assertGreater(len(generate_token(64)), len(generate_token(16)))

    def test_rejects_a_byte_count_below_the_floor(self):
        # Silently honouring nbytes=1 would hand back a "token" worth nothing.
        with self.assertRaises(ValueError):
            generate_token(8)


class LooksGeneratedTests(unittest.TestCase):
    def test_accepts_a_generated_token(self):
        self.assertTrue(looks_generated(generate_token()))

    def test_rejects_short_or_empty_values(self):
        self.assertFalse(looks_generated(""))
        self.assertFalse(looks_generated("   "))
        self.assertFalse(looks_generated("hunter2"))

    def test_rejects_a_long_but_low_entropy_value(self):
        # Long is not the same as strong: a repeated character passes a length
        # check while being trivially guessable.
        self.assertFalse(looks_generated("a" * 60))


if __name__ == "__main__":
    unittest.main()
