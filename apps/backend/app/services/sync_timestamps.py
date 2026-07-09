from __future__ import annotations

import re
from datetime import UTC, datetime

_RFC3339_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$"
)
_LEGACY_SQLITE_UTC_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?: (?:UTC|utc)|[+-]\d{2}:\d{2})?$"
)
_LEGACY_MOBILE_NAIVE_ISO_T_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$"
)


def sync_datetime_as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def parse_sync_datetime(value: datetime | str) -> datetime:
    if isinstance(value, datetime):
        return sync_datetime_as_utc(value)

    raw_value = value.strip()
    if not raw_value:
        raise ValueError("Sync timestamp must not be blank.")

    if _RFC3339_DATETIME_RE.fullmatch(raw_value):
        parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    elif _LEGACY_MOBILE_NAIVE_ISO_T_DATETIME_RE.fullmatch(raw_value):
        parsed = datetime.fromisoformat(raw_value)
    elif _LEGACY_SQLITE_UTC_DATETIME_RE.fullmatch(raw_value):
        parsed = datetime.fromisoformat(
            raw_value.removesuffix(" UTC").removesuffix(" utc")
        )
    else:
        raise ValueError(
            "Sync timestamp must be an RFC3339 datetime with timezone, "
            "legacy SQLite UTC datetime, or legacy mobile naive UTC datetime."
        )
    return sync_datetime_as_utc(parsed)


def sync_datetime_to_rfc3339(value: datetime) -> str:
    return sync_datetime_as_utc(value).isoformat().replace("+00:00", "Z")
