from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import SyncLocalIdentity, SyncPairingOffer, SyncTrustedPeer
from app.services import sync_crypto

SYNC_PAIRING_PROTOCOL_VERSION = "tuneforge-sync-v1"
LOCAL_IDENTITY_ID = "local"
DEFAULT_LOCAL_DISPLAY_NAME = "TuneForge Device"
DEFAULT_PEER_DISPLAY_NAME = "Trusted Device"
ED25519_PUBLIC_KEY_BYTES = 32
MAX_PAIRING_TTL_SECONDS = 3600

SYNC_PAIRING_INVALID = "SYNC_PAIRING_INVALID"
SYNC_PAIRING_SELF = "SYNC_PAIRING_SELF"
SYNC_GROUP_MISMATCH = "SYNC_GROUP_MISMATCH"
SYNC_PEER_UNTRUSTED = "SYNC_PEER_UNTRUSTED"
SYNC_PEER_REVOKED = "SYNC_PEER_REVOKED"

_MISSING = object()
_SIGNED_PAIRING_PAYLOAD_FIELDS = (
    "protocol_version",
    "pairing_offer_id",
    "sync_group_id",
    "device_id",
    "display_name",
    "public_key",
    "endpoint_hints",
    "pairing_secret",
    "expires_at",
)


@dataclass(frozen=True)
class LocalSyncIdentity:
    device_id: str
    sync_group_id: str
    display_name: str
    public_key: str
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class SyncPairingOfferRecord:
    payload: dict[str, Any]
    expires_at: datetime
    ttl_seconds: int


@dataclass(frozen=True)
class SyncPairingAnswerRecord:
    payload: dict[str, Any]
    trusted_peer: TrustedSyncPeer


@dataclass(frozen=True)
class TrustedSyncPeer:
    device_id: str
    sync_group_id: str
    display_name: str
    public_key: str
    endpoint_hints: list[str]
    trusted_at: datetime
    revoked_at: datetime | None
    updated_at: datetime | None

    @property
    def is_revoked(self) -> bool:
        return self.revoked_at is not None


@dataclass(frozen=True)
class _PairingPayloadValues:
    pairing_offer_id: str
    sync_group_id: str
    device_id: str
    display_name: str
    public_key: str
    endpoint_hints: list[str]
    signature: str
    pairing_secret: str = field(repr=False)
    expires_at: datetime


def get_or_create_local_identity(session: Session, display_name: str | None = None) -> LocalSyncIdentity:
    identity = _get_or_create_local_identity_orm(session, display_name=display_name)
    return _local_identity_from_orm(identity)


def update_local_identity_display_name(session: Session, display_name: str) -> LocalSyncIdentity:
    identity = _get_or_create_local_identity_orm(session)
    identity.display_name = _normalize_local_display_name(display_name)
    identity.updated_at = _utcnow()
    session.flush()
    return _local_identity_from_orm(identity)


def create_pairing_offer(
    session: Session,
    endpoint_hints: list[str] | None = None,
    ttl_seconds: int = 600,
) -> SyncPairingOfferRecord:
    if ttl_seconds <= 0:
        raise _pairing_invalid("Pairing offer ttl_seconds must be positive.")
    if ttl_seconds > MAX_PAIRING_TTL_SECONDS:
        raise _pairing_invalid(
            f"Pairing offer ttl_seconds must be no greater than {MAX_PAIRING_TTL_SECONDS}."
        )

    identity_orm = _get_or_create_local_identity_orm(session)
    identity = _local_identity_from_orm(identity_orm)
    normalized_endpoint_hints = _normalize_endpoint_hints(endpoint_hints)
    now = _utcnow()
    expires_at = now + timedelta(seconds=ttl_seconds)
    expires_at_payload = expires_at.isoformat()
    pairing_offer_id = sync_crypto.new_pairing_offer_id()
    pairing_secret = sync_crypto.new_pairing_secret()
    pairing_secret_hash = sync_crypto.hash_pairing_secret(pairing_secret)
    payload: dict[str, Any] = {
        "protocol_version": SYNC_PAIRING_PROTOCOL_VERSION,
        "pairing_offer_id": pairing_offer_id,
        "sync_group_id": identity.sync_group_id,
        "device_id": identity.device_id,
        "display_name": identity.display_name,
        "public_key": identity.public_key,
        "endpoint_hints": normalized_endpoint_hints,
        "pairing_secret": pairing_secret,
        "expires_at": expires_at_payload,
    }
    payload["signature"] = sync_crypto.sign_payload(
        sync_crypto.decode_key(identity_orm.private_key),
        _pairing_payload_signature_message(payload),
    )

    session.add(
        SyncPairingOffer(
            id=pairing_offer_id,
            secret_hash=pairing_secret_hash,
            endpoint_hints_json=normalized_endpoint_hints,
            expires_at=expires_at,
            created_at=now,
        )
    )
    session.flush()

    return SyncPairingOfferRecord(
        payload=payload,
        expires_at=expires_at,
        ttl_seconds=ttl_seconds,
    )


def trust_peer_from_pairing_payload(
    session: Session,
    payload: Mapping[str, Any] | object,
    adopt_sync_group: bool = False,
) -> TrustedSyncPeer:
    payload_values = _validate_pairing_payload(payload)
    local_identity = _get_or_create_local_identity_orm(session)

    _validate_pairing_peer_identity(
        session,
        local_identity=local_identity,
        payload_values=payload_values,
        adopt_sync_group=adopt_sync_group,
    )

    local_offer = session.get(SyncPairingOffer, payload_values.pairing_offer_id)
    if local_offer is None:
        raise _pairing_invalid("Pairing offer is unknown.")
    _validate_local_pairing_offer(local_offer, payload_values)

    now = _utcnow()
    peer = _upsert_trusted_peer_from_pairing_values(session, payload_values=payload_values, now=now)

    local_offer.used_at = now
    session.flush()
    return _trusted_peer_from_orm(peer)


def answer_pairing_offer(
    session: Session,
    offer: Mapping[str, Any] | object,
    endpoint_hints: list[str] | None = None,
    adopt_sync_group: bool = False,
) -> SyncPairingAnswerRecord:
    offer_values = _validate_pairing_payload(offer)
    local_identity = _get_or_create_local_identity_orm(session)

    _validate_pairing_peer_identity(
        session,
        local_identity=local_identity,
        payload_values=offer_values,
        adopt_sync_group=adopt_sync_group,
    )

    now = _utcnow()
    peer = _upsert_trusted_peer_from_pairing_values(session, payload_values=offer_values, now=now)
    response_payload = _local_pairing_response_payload(
        local_identity,
        offer_values=offer_values,
        endpoint_hints=endpoint_hints,
    )
    session.flush()

    return SyncPairingAnswerRecord(
        payload=response_payload,
        trusted_peer=_trusted_peer_from_orm(peer),
    )


def revoke_trusted_peer(session: Session, device_id: str) -> TrustedSyncPeer:
    normalized_device_id = _normalize_required_string(device_id, "device_id")
    peer = session.get(SyncTrustedPeer, normalized_device_id)
    if peer is None:
        raise AppError(
            SYNC_PEER_UNTRUSTED,
            "Trusted peer is unknown.",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"device_id": normalized_device_id},
        )
    now = _utcnow()
    peer.revoked_at = now
    peer.updated_at = now
    session.flush()
    return _trusted_peer_from_orm(peer)


def list_trusted_peers(session: Session) -> list[TrustedSyncPeer]:
    peers = [
        _trusted_peer_from_orm(peer)
        for peer in session.scalars(select(SyncTrustedPeer).where(SyncTrustedPeer.revoked_at.is_(None)))
    ]
    return sorted(
        peers,
        key=lambda peer: (
            peer.revoked_at is not None,
            peer.display_name.casefold(),
            peer.device_id,
        ),
    )


def require_trusted_peer(session: Session, device_id: str) -> TrustedSyncPeer:
    normalized_device_id = _normalize_required_string(device_id, "device_id")
    peer = session.get(SyncTrustedPeer, normalized_device_id)
    if peer is None:
        raise AppError(
            SYNC_PEER_UNTRUSTED,
            "Trusted peer is unknown.",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"device_id": normalized_device_id},
        )
    trusted_peer = _trusted_peer_from_orm(peer)
    if trusted_peer.revoked_at is not None:
        raise AppError(
            SYNC_PEER_REVOKED,
            "Trusted peer has been revoked.",
            status_code=status.HTTP_403_FORBIDDEN,
            details={"device_id": normalized_device_id},
        )
    return trusted_peer


def trust_peer(
    session: Session,
    payload: Mapping[str, Any] | object,
    adopt_sync_group: bool = False,
) -> TrustedSyncPeer:
    return trust_peer_from_pairing_payload(session, payload=payload, adopt_sync_group=adopt_sync_group)


def derive_device_id(public_key: str) -> str:
    try:
        return sync_crypto.derive_device_id(_decode_public_key_bytes(public_key))
    except Exception as exc:
        raise _pairing_invalid("Public key is invalid.") from exc


def _get_or_create_local_identity_orm(
    session: Session,
    *,
    display_name: str | None = None,
) -> SyncLocalIdentity:
    existing = session.get(SyncLocalIdentity, LOCAL_IDENTITY_ID)
    if existing is not None:
        return existing

    private_key_bytes = sync_crypto.generate_private_key_bytes()
    public_key_bytes = sync_crypto.public_key_bytes_from_private_key(private_key_bytes)
    now = _utcnow()
    identity = SyncLocalIdentity(
        id=LOCAL_IDENTITY_ID,
        sync_group_id=sync_crypto.new_sync_group_id(),
        device_id=sync_crypto.derive_device_id(public_key_bytes),
        display_name=_normalize_local_display_name(display_name),
        public_key=sync_crypto.encode_key(public_key_bytes),
        private_key=sync_crypto.encode_key(private_key_bytes),
        created_at=now,
        updated_at=now,
    )
    session.add(identity)
    session.flush()
    return identity


def _active_trusted_peer_count(session: Session) -> int:
    statement = select(func.count()).select_from(SyncTrustedPeer).where(SyncTrustedPeer.revoked_at.is_(None))
    return int(session.scalar(statement) or 0)


def _validate_pairing_peer_identity(
    session: Session,
    *,
    local_identity: SyncLocalIdentity,
    payload_values: _PairingPayloadValues,
    adopt_sync_group: bool,
) -> None:
    if payload_values.device_id == local_identity.device_id:
        raise AppError(
            SYNC_PAIRING_SELF,
            "Cannot trust this device's own pairing payload.",
            status_code=status.HTTP_409_CONFLICT,
        )

    if payload_values.sync_group_id != local_identity.sync_group_id:
        if not adopt_sync_group or _active_trusted_peer_count(session) > 0:
            raise AppError(
                SYNC_GROUP_MISMATCH,
                "Pairing payload belongs to a different sync group.",
                status_code=status.HTTP_409_CONFLICT,
                details={
                    "local_sync_group_id": local_identity.sync_group_id,
                    "payload_sync_group_id": payload_values.sync_group_id,
                },
            )
        local_identity.sync_group_id = payload_values.sync_group_id
        local_identity.updated_at = _utcnow()
        session.flush()


def _upsert_trusted_peer_from_pairing_values(
    session: Session,
    *,
    payload_values: _PairingPayloadValues,
    now: datetime,
) -> SyncTrustedPeer:
    existing_public_key_peer = session.scalars(
        select(SyncTrustedPeer).where(SyncTrustedPeer.public_key == payload_values.public_key)
    ).first()
    if (
        existing_public_key_peer is not None
        and existing_public_key_peer.device_id != payload_values.device_id
    ):
        raise _pairing_invalid("Pairing payload public_key is already trusted for a different device.")

    peer = session.get(SyncTrustedPeer, payload_values.device_id)
    if peer is None:
        peer = SyncTrustedPeer(
            device_id=payload_values.device_id,
            sync_group_id=payload_values.sync_group_id,
            display_name=payload_values.display_name,
            public_key=payload_values.public_key,
            endpoint_hints_json=payload_values.endpoint_hints,
            trusted_at=now,
            revoked_at=None,
            created_at=now,
            updated_at=now,
        )
        session.add(peer)
        return peer

    peer.sync_group_id = payload_values.sync_group_id
    peer.display_name = payload_values.display_name
    peer.public_key = payload_values.public_key
    peer.endpoint_hints_json = payload_values.endpoint_hints
    peer.trusted_at = now
    peer.revoked_at = None
    peer.updated_at = now
    return peer


def _local_pairing_response_payload(
    local_identity: SyncLocalIdentity,
    *,
    offer_values: _PairingPayloadValues,
    endpoint_hints: list[str] | None,
) -> dict[str, Any]:
    response_payload: dict[str, Any] = {
        "protocol_version": SYNC_PAIRING_PROTOCOL_VERSION,
        "pairing_offer_id": offer_values.pairing_offer_id,
        "sync_group_id": local_identity.sync_group_id,
        "device_id": local_identity.device_id,
        "display_name": local_identity.display_name,
        "public_key": local_identity.public_key,
        "endpoint_hints": _normalize_endpoint_hints(endpoint_hints),
        "pairing_secret": offer_values.pairing_secret,
        "expires_at": offer_values.expires_at.isoformat(),
    }
    response_payload["signature"] = sync_crypto.sign_payload(
        sync_crypto.decode_key(local_identity.private_key),
        _pairing_payload_signature_message(response_payload),
    )
    return response_payload


def _local_identity_from_orm(identity: SyncLocalIdentity) -> LocalSyncIdentity:
    return LocalSyncIdentity(
        device_id=identity.device_id,
        sync_group_id=identity.sync_group_id,
        display_name=identity.display_name,
        public_key=identity.public_key,
        created_at=_as_utc(identity.created_at),
        updated_at=_as_utc(identity.updated_at),
    )


def _trusted_peer_from_orm(peer: SyncTrustedPeer) -> TrustedSyncPeer:
    return TrustedSyncPeer(
        device_id=peer.device_id,
        sync_group_id=peer.sync_group_id,
        display_name=peer.display_name,
        public_key=peer.public_key,
        endpoint_hints=_normalize_endpoint_hints(peer.endpoint_hints_json),
        trusted_at=_as_utc(peer.trusted_at),
        revoked_at=_as_utc(peer.revoked_at) if peer.revoked_at is not None else None,
        updated_at=_as_utc(peer.updated_at) if peer.updated_at is not None else None,
    )


def _validate_pairing_payload(payload: Mapping[str, Any] | object) -> _PairingPayloadValues:
    protocol_version = _payload_required_string(payload, "protocol_version")
    if protocol_version != SYNC_PAIRING_PROTOCOL_VERSION:
        raise _pairing_invalid("Pairing payload uses an unsupported protocol version.")

    pairing_offer_id = _payload_required_string(payload, "pairing_offer_id")
    sync_group_id = _payload_required_string(payload, "sync_group_id")
    device_id = _payload_required_string(payload, "device_id")
    display_name = _payload_optional_string(payload, "display_name") or DEFAULT_PEER_DISPLAY_NAME
    public_key = _payload_required_string(payload, "public_key")
    endpoint_hints = _normalize_endpoint_hints(_payload_value(payload, "endpoint_hints", default=[]))
    pairing_secret = _payload_required_string(payload, "pairing_secret")
    expires_at = _parse_payload_expires_at(_payload_value(payload, "expires_at"))
    if expires_at <= _utcnow():
        raise _pairing_invalid("Pairing payload has expired.")
    signature = _payload_required_string(payload, "signature")

    try:
        public_key_bytes = _decode_public_key_bytes(public_key)
        derived_device_id = sync_crypto.derive_device_id(public_key_bytes)
        sync_crypto.hash_pairing_secret(pairing_secret)
        sync_crypto.verify_payload_signature(
            public_key_bytes,
            _pairing_payload_signature_message(
                {
                    "protocol_version": protocol_version,
                    "pairing_offer_id": pairing_offer_id,
                    "sync_group_id": sync_group_id,
                    "device_id": device_id,
                    "display_name": display_name,
                    "public_key": public_key,
                    "endpoint_hints": endpoint_hints,
                    "pairing_secret": pairing_secret,
                    "expires_at": expires_at.isoformat(),
                }
            ),
            signature,
        )
    except Exception as exc:
        raise _pairing_invalid("Pairing payload contains invalid key material or secret.") from exc

    if derived_device_id != device_id:
        raise _pairing_invalid("Pairing payload device_id does not match its public_key.")

    return _PairingPayloadValues(
        pairing_offer_id=pairing_offer_id,
        sync_group_id=sync_group_id,
        device_id=device_id,
        display_name=display_name,
        public_key=public_key,
        endpoint_hints=endpoint_hints,
        signature=signature,
        pairing_secret=pairing_secret,
        expires_at=expires_at,
    )


def _validate_local_pairing_offer(
    offer: SyncPairingOffer,
    payload_values: _PairingPayloadValues,
) -> None:
    if offer.used_at is not None:
        raise _pairing_invalid("Pairing offer has already been used.")
    offer_expires_at = _as_utc(offer.expires_at)
    if offer_expires_at <= _utcnow():
        raise _pairing_invalid("Pairing offer has expired.")
    if offer_expires_at != payload_values.expires_at:
        raise _pairing_invalid("Pairing payload expiration does not match the local offer.")
    if offer.secret_hash != sync_crypto.hash_pairing_secret(payload_values.pairing_secret):
        raise _pairing_invalid("Pairing payload secret does not match the local offer.")


def _decode_public_key_bytes(public_key: str) -> bytes:
    public_key_bytes = sync_crypto.decode_key(public_key)
    if len(public_key_bytes) != ED25519_PUBLIC_KEY_BYTES:
        raise ValueError("public_key must be a raw Ed25519 public key.")
    return public_key_bytes


def _pairing_payload_signature_message(payload: Mapping[str, Any]) -> bytes:
    signed_payload = {field_name: payload[field_name] for field_name in _SIGNED_PAIRING_PAYLOAD_FIELDS}
    return json.dumps(signed_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _payload_value(payload: Mapping[str, Any] | object, field_name: str, *, default: Any = _MISSING) -> Any:
    if isinstance(payload, Mapping):
        value = payload.get(field_name, default)
    else:
        model_dump = getattr(payload, "model_dump", None)
        if callable(model_dump):
            dumped = model_dump(mode="python")
            value = dumped.get(field_name, default) if isinstance(dumped, Mapping) else default
        else:
            value = getattr(payload, field_name, default)
    if value is _MISSING:
        raise _pairing_invalid(f"Pairing payload is missing {field_name}.")
    return value


def _payload_required_string(payload: Mapping[str, Any] | object, field_name: str) -> str:
    value = _payload_value(payload, field_name)
    if not isinstance(value, str):
        raise _pairing_invalid(f"Pairing payload {field_name} must be a string.")
    return _normalize_required_string(value, field_name)


def _payload_optional_string(payload: Mapping[str, Any] | object, field_name: str) -> str | None:
    value = _payload_value(payload, field_name, default=None)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _pairing_invalid(f"Pairing payload {field_name} must be a string when present.")
    normalized = value.strip()
    return normalized or None


def _parse_payload_expires_at(value: Any) -> datetime:
    if isinstance(value, datetime):
        expires_at = value
    elif isinstance(value, str):
        try:
            expires_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise _pairing_invalid("Pairing payload expires_at must be an ISO-8601 timestamp.") from exc
    else:
        raise _pairing_invalid("Pairing payload expires_at must be an ISO-8601 timestamp.")
    return _as_utc(expires_at)


def _normalize_endpoint_hints(endpoint_hints: Sequence[Any] | None) -> list[str]:
    if endpoint_hints is None:
        return []
    if isinstance(endpoint_hints, str) or not isinstance(endpoint_hints, Sequence):
        raise _pairing_invalid("Pairing endpoint_hints must be a list of strings.")

    normalized: list[str] = []
    for hint in endpoint_hints:
        if not isinstance(hint, str):
            raise _pairing_invalid("Pairing endpoint_hints must be a list of strings.")
        stripped = hint.strip()
        if not stripped:
            raise _pairing_invalid("Pairing endpoint_hints cannot contain empty values.")
        normalized.append(stripped)
    return normalized


def _normalize_local_display_name(display_name: str | None) -> str:
    if display_name is None:
        return DEFAULT_LOCAL_DISPLAY_NAME
    normalized = display_name.strip()
    return normalized or DEFAULT_LOCAL_DISPLAY_NAME


def _normalize_required_string(value: str, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise _pairing_invalid(f"Pairing payload {field_name} must not be empty.")
    return normalized


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _pairing_invalid(message: str) -> AppError:
    return AppError(SYNC_PAIRING_INVALID, message, status_code=status.HTTP_400_BAD_REQUEST)
