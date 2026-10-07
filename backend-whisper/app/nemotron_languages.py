"""Short language codes the rest of SubSmelt uses, mapped to Nemotron locales.

Only the 32 locales the model card marks transcription-ready or broad-coverage
are listed. The first short code for a locale is the one reported back as the
detected language. ``nemo-speech`` accepts any locale string without complaint,
so this table is the only place an unsupported language is refused.
"""

from __future__ import annotations

from .engine import LanguageNotSupportedError

NEMOTRON_MODEL_ID = "nemotron-3.5-asr"

_LOCALES: tuple[tuple[str, str], ...] = (
    ("en", "en-US"),
    ("es", "es-US"),
    ("fr", "fr-FR"),
    ("it", "it-IT"),
    ("pt", "pt-BR"),
    ("pt-BR", "pt-BR"),
    ("pt-PT", "pt-PT"),
    ("nl", "nl-NL"),
    ("de", "de-DE"),
    ("tr", "tr-TR"),
    ("ru", "ru-RU"),
    ("ar", "ar-AR"),
    ("hi", "hi-IN"),
    ("ja", "ja-JP"),
    ("ko", "ko-KR"),
    ("vi", "vi-VN"),
    ("uk", "uk-UA"),
    ("pl", "pl-PL"),
    ("sv", "sv-SE"),
    ("cs", "cs-CZ"),
    ("nb", "nb-NO"),
    ("no", "nb-NO"),
    ("da", "da-DK"),
    ("bg", "bg-BG"),
    ("fi", "fi-FI"),
    ("hr", "hr-HR"),
    ("sk", "sk-SK"),
    ("zh", "zh-CN"),
    ("zh-CN", "zh-CN"),
    ("hu", "hu-HU"),
    ("ro", "ro-RO"),
    ("et", "et-EE"),
)

NEMOTRON_SHORT_CODES: tuple[str, ...] = tuple(short for short, _ in _LOCALES)

# ISO-639-2/B and -2/T codes the rest of the app still carries in saved
# settings (translation tasks use them, and older exports may too), normalized
# to the short codes above. A bare "kor" reaching the catalog otherwise fails
# every gate even though Korean is supported.
_ISO3_TO_SHORT: dict[str, str] = {
    "eng": "en",
    "chi": "zh",
    "zho": "zh",
    "jpn": "ja",
    "kor": "ko",
    "spa": "es",
    "fra": "fr",
    "fre": "fr",
    "deu": "de",
    "ger": "de",
    "por": "pt",
    "ita": "it",
    "rus": "ru",
    "ara": "ar",
    "tha": "th",
    "vie": "vi",
    "ind": "id",
    "nld": "nl",
    "dut": "nl",
    "pol": "pl",
    "tur": "tr",
    "hin": "hi",
    "ukr": "uk",
    "swe": "sv",
    "ces": "cs",
    "dan": "da",
    "bul": "bg",
    "fin": "fi",
    "hrv": "hr",
    "slk": "sk",
    "ron": "ro",
    "hun": "hu",
    "nob": "nb",
    "nor": "no",
}


def normalize_language(short: str) -> str:
    """Lower-cased short code, with 3-letter ISO codes folded to their short form."""
    key = (short or "").strip().lower()
    return _ISO3_TO_SHORT.get(key, key)


def fold_iso3(code: str) -> str:
    """``code`` with a 3-letter ISO code folded to its short form, otherwise
    unchanged (case kept): what file names and reported languages carry."""
    stripped = (code or "").strip()
    return _ISO3_TO_SHORT.get(stripped.lower(), stripped)


_BY_SHORT: dict[str, str] = {short.lower(): locale for short, locale in _LOCALES}
_BY_LOCALE: dict[str, str] = {}
for _short, _locale in _LOCALES:
    _BY_LOCALE.setdefault(_locale, _short)


def map_language(short: str) -> str:
    """Nemotron locale for a short code; ``auto`` (or empty) stays ``auto``.
    Accepts 3-letter ISO codes too (``kor`` -> ``ko-KR``)."""
    key = normalize_language(short or "auto")
    if key == "auto":
        return "auto"
    locale = _BY_SHORT.get(key)
    if locale is None:
        raise LanguageNotSupportedError(
            NEMOTRON_MODEL_ID,
            short,
            f"Model {NEMOTRON_MODEL_ID!r} does not support language {short!r}. Use large-v3 or large-v3-turbo.",
        )
    return locale


def short_code_for(locale: str) -> str | None:
    return _BY_LOCALE.get(locale)
