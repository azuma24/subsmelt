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
    ("en", "en-US"), ("es", "es-US"), ("fr", "fr-FR"), ("it", "it-IT"),
    ("pt", "pt-BR"), ("pt-BR", "pt-BR"), ("pt-PT", "pt-PT"), ("nl", "nl-NL"),
    ("de", "de-DE"), ("tr", "tr-TR"), ("ru", "ru-RU"), ("ar", "ar-AR"),
    ("hi", "hi-IN"), ("ja", "ja-JP"), ("ko", "ko-KR"), ("vi", "vi-VN"),
    ("uk", "uk-UA"), ("pl", "pl-PL"), ("sv", "sv-SE"), ("cs", "cs-CZ"),
    ("nb", "nb-NO"), ("no", "nb-NO"), ("da", "da-DK"), ("bg", "bg-BG"),
    ("fi", "fi-FI"), ("hr", "hr-HR"), ("sk", "sk-SK"), ("zh", "zh-CN"),
    ("zh-CN", "zh-CN"), ("hu", "hu-HU"), ("ro", "ro-RO"), ("et", "et-EE"),
)

NEMOTRON_SHORT_CODES: tuple[str, ...] = tuple(short for short, _ in _LOCALES)

_BY_SHORT: dict[str, str] = {short.lower(): locale for short, locale in _LOCALES}
_BY_LOCALE: dict[str, str] = {}
for _short, _locale in _LOCALES:
    _BY_LOCALE.setdefault(_locale, _short)


def map_language(short: str) -> str:
    """Nemotron locale for a short code; ``auto`` (or empty) stays ``auto``."""
    key = (short or "auto").strip().lower()
    if key == "auto":
        return "auto"
    locale = _BY_SHORT.get(key)
    if locale is None:
        raise LanguageNotSupportedError(
            NEMOTRON_MODEL_ID,
            short,
            f"Model {NEMOTRON_MODEL_ID!r} does not support language {short!r}. "
            f"Use large-v3 or large-v3-turbo.",
        )
    return locale


def short_code_for(locale: str) -> str | None:
    return _BY_LOCALE.get(locale)
