"""Generation of the backend's shared-secret token (the "API key").

Why this exists: the backend binds 0.0.0.0 by default, and ``require_token`` is
a deliberate no-op when no token is configured. Every safeguard therefore ends
at "set SUBSMELT_WHISPER_TOKEN" — a step that asks the operator to invent a
secret, which in practice means a weak one or no token at all. So the backend
now hands one out: the control window has a Generate button and ``run_server``
has ``--generate-token``, both landing here.

Kept dependency-free (stdlib ``secrets`` only) so the tray GUI can import it
without dragging in the server stack, and so the frozen GUI exe stays small.
"""
from __future__ import annotations

import secrets

#: Bytes of entropy in a generated token. 32 bytes = 256 bits, well past any
#: brute-force concern for a secret compared with ``secrets.compare_digest``.
TOKEN_BYTES = 32

#: Floor for the ``nbytes`` argument. Callers do not get to ask for a token so
#: short it stops being a secret; a mistake here is silent and permanent.
MIN_TOKEN_BYTES = 16

#: Shortest base64url encoding of ``MIN_TOKEN_BYTES``, used to sanity-check a
#: value that claims to have come from here. 4 characters per 3 bytes, rounded
#: down to stay conservative.
MIN_TOKEN_CHARS = (MIN_TOKEN_BYTES * 4) // 3

#: Distinct characters a real generated token is overwhelmingly likely to
#: exceed. Guards against "aaaa..." passing a length-only check.
MIN_DISTINCT_CHARS = 8


def generate_token(nbytes: int = TOKEN_BYTES) -> str:
    """Return a fresh URL-safe token carrying ``nbytes`` of entropy.

    URL-safe base64 on purpose: the value is pasted into a web form, stored in
    ``config.json``, and sent as an ``Authorization: Bearer`` header, and none
    of those three want quoting or escaping.

    :raises ValueError: if ``nbytes`` is below :data:`MIN_TOKEN_BYTES`.
    """
    if nbytes < MIN_TOKEN_BYTES:
        raise ValueError(
            f"refusing to generate a token with only {nbytes} bytes of entropy; "
            f"the minimum is {MIN_TOKEN_BYTES}"
        )
    return secrets.token_urlsafe(nbytes)


def looks_generated(token: str) -> bool:
    """Cheap plausibility check that ``token`` came from :func:`generate_token`.

    Advisory only — it exists so the UI can tell "the operator pressed
    Generate" apart from "the operator typed a word", not to gate anything. A
    hand-picked passphrase that happens to pass is fine; it is genuinely strong
    enough.
    """
    value = (token or "").strip()
    return len(value) >= MIN_TOKEN_CHARS and len(set(value)) >= MIN_DISTINCT_CHARS
