from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import status
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import SyncLocalIdentity
from app.services import sync_crypto
from app.services.sync_trust import (
    LOCAL_IDENTITY_ID,
    SYNC_GROUP_MISMATCH,
    SYNC_PAIRING_PROTOCOL_VERSION,
    get_or_create_local_identity,
    require_trusted_peer,
)

TRANSPORT_HANDSHAKE_CHALLENGE_TYPE = "transport_handshake"
TRANSPORT_HANDSHAKE_MAX_TTL_SECONDS = 300
TRANSPORT_HANDSHAKE_CLOCK_SKEW_SECONDS = 30
SYNC_TRANSPORT_CHALLENGE_INVALID = "SYNC_TRANSPORT_CHALLENGE_INVALID"

_MISSING = object()


@dataclass(frozen=True)
class SyncTransportHandshakeSignature:
    protocol_version: str
    challenge_type: str
    local_device_id: str
    peer_device_id: str
    public_key: str
    challenge: dict[str, Any]
    canonical_challenge_json: str
    signature: str
    signed_at: datetime


def sign_transport_handshake_challenge(
    session: Session,
    request: object | Mapping[str, Any],
) -> SyncTransportHandshakeSignature:
    identity = _get_or_create_local_identity_orm(session)
    peer_device_id = _required_string(request, "peer_device_id")
    trusted_peer = require_trusted_peer(session, peer_device_id)
    if trusted_peer.sync_group_id != identity.sync_group_id:
        raise AppError(
            SYNC_GROUP_MISMATCH,
            "Trusted peer belongs to a different sync group.",
            status_code=status.HTTP_403_FORBIDDEN,
            details={
                "local_sync_group_id": identity.sync_group_id,
                "peer_sync_group_id": trusted_peer.sync_group_id,
            },
        )

    challenge = _field(request, "challenge")
    canonical_challenge = _canonical_transport_handshake_challenge(
        challenge,
        local_device_id=identity.device_id,
        peer_device_id=peer_device_id,
    )
    canonical_challenge_json = canonical_transport_handshake_challenge_json(canonical_challenge)
    signature = sync_crypto.sign_payload(
        sync_crypto.decode_key(identity.private_key),
        canonical_challenge_json.encode("utf-8"),
    )
    return SyncTransportHandshakeSignature(
        protocol_version=canonical_challenge["protocol_version"],
        challenge_type=canonical_challenge["challenge_type"],
        local_device_id=identity.device_id,
        peer_device_id=peer_device_id,
        public_key=identity.public_key,
        challenge=canonical_challenge,
        canonical_challenge_json=canonical_challenge_json,
        signature=signature,
        signed_at=_utcnow(),
    )


def canonical_transport_handshake_challenge_json(challenge: Mapping[str, Any]) -> str:
    return json.dumps(challenge, sort_keys=True, separators=(",", ":"))


def _get_or_create_local_identity_orm(session: Session) -> SyncLocalIdentity:
    get_or_create_local_identity(session)
    identity = session.get(SyncLocalIdentity, LOCAL_IDENTITY_ID)
    if identity is None:
        raise AppError(
            "SYNC_IDENTITY_MISSING",
            "Local sync identity could not be loaded.",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
    return identity


def _canonical_transport_handshake_challenge(
    challenge: object,
    *,
    local_device_id: str,
    peer_device_id: str,
) -> dict[str, Any]:
    protocol_version = _required_string(challenge, "protocol_version")
    if protocol_version != SYNC_PAIRING_PROTOCOL_VERSION:
        raise _invalid_challenge(
            "Transport handshake challenge uses an unsupported protocol version.",
            {"protocol_version": protocol_version},
        )

    challenge_type = _required_string(challenge, "challenge_type")
    if challenge_type != TRANSPORT_HANDSHAKE_CHALLENGE_TYPE:
        raise _invalid_challenge(
            "Transport handshake challenge_type is not supported.",
            {"challenge_type": challenge_type},
        )

    requester_device_id = _required_string(challenge, "requester_device_id")
    if requester_device_id != peer_device_id:
        raise _invalid_challenge(
            "Transport handshake requester_device_id must match the trusted peer.",
            {
                "peer_device_id": peer_device_id,
                "requester_device_id": requester_device_id,
            },
        )

    responder_device_id = _required_string(challenge, "responder_device_id")
    if responder_device_id != local_device_id:
        raise _invalid_challenge(
            "Transport handshake responder_device_id must match the local device.",
            {
                "local_device_id": local_device_id,
                "responder_device_id": responder_device_id,
            },
        )

    session_id = _required_string(challenge, "session_id")
    challenge_nonce = _required_string(challenge, "challenge_nonce")
    issued_at = _required_datetime(challenge, "issued_at")
    expires_at = _required_datetime(challenge, "expires_at")
    _validate_challenge_window(issued_at=issued_at, expires_at=expires_at)

    return {
        "challenge_nonce": challenge_nonce,
        "challenge_type": TRANSPORT_HANDSHAKE_CHALLENGE_TYPE,
        "expires_at": expires_at.isoformat(),
        "issued_at": issued_at.isoformat(),
        "protocol_version": SYNC_PAIRING_PROTOCOL_VERSION,
        "requester_device_id": requester_device_id,
        "responder_device_id": responder_device_id,
        "session_id": session_id,
    }


def _validate_challenge_window(*, issued_at: datetime, expires_at: datetime) -> None:
    now = _utcnow()
    if issued_at >= expires_at:
        raise _invalid_challenge("Transport handshake issued_at must be before expires_at.")
    if expires_at <= now:
        raise _invalid_challenge("Transport handshake challenge has expired.")
    if issued_at > now + timedelta(seconds=TRANSPORT_HANDSHAKE_CLOCK_SKEW_SECONDS):
        raise _invalid_challenge("Transport handshake issued_at is too far in the future.")
    if expires_at - issued_at > timedelta(seconds=TRANSPORT_HANDSHAKE_MAX_TTL_SECONDS):
        raise _invalid_challenge(
            "Transport handshake challenge lifetime is too long.",
            {"max_ttl_seconds": TRANSPORT_HANDSHAKE_MAX_TTL_SECONDS},
        )


def _field(source: object, name: str, *, default: object = _MISSING) -> Any:
    if isinstance(source, Mapping):
        value = source.get(name, default)
    else:
        model_dump = getattr(source, "model_dump", None)
        if callable(model_dump):
            dumped = model_dump(mode="python")
            value = dumped.get(name, default) if isinstance(dumped, Mapping) else default
        else:
            value = getattr(source, name, default)
    if value is _MISSING:
        raise _invalid_challenge(f"Transport handshake challenge is missing {name}.")
    return value


def _required_string(source: object, name: str) -> str:
    value = _field(source, name)
    if not isinstance(value, str):
        raise _invalid_challenge(f"Transport handshake {name} must be a string.")
    if value != value.strip() or not value:
        raise _invalid_challenge(f"Transport handshake {name} must be canonical.")
    return value


def _required_datetime(source: object, name: str) -> datetime:
    value = _field(source, name)
    if not isinstance(value, datetime):
        raise _invalid_challenge(f"Transport handshake {name} must be an ISO-8601 timestamp.")
    if value.tzinfo is None:
        raise _invalid_challenge(f"Transport handshake {name} must include a timezone.")
    return value.astimezone(UTC)


def _invalid_challenge(message: str, details: dict[str, Any] | None = None) -> AppError:
    return AppError(
        SYNC_TRANSPORT_CHALLENGE_INVALID,
        message,
        status_code=status.HTTP_400_BAD_REQUEST,
        details=details,
    )


def _utcnow() -> datetime:
    return datetime.now(UTC)
