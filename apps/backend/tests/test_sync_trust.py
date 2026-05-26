from __future__ import annotations

import importlib
import json
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, is_dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy.orm import Session

from app.config import ensure_data_dirs, get_settings
from app.db import SessionLocal, reconfigure_engine, run_migrations
from app.errors import AppError

SyncTrustService = Callable[..., Any]

PAIRING_OFFER_FIELDS = {
    "protocol_version",
    "pairing_offer_id",
    "sync_group_id",
    "device_id",
    "display_name",
    "public_key",
    "endpoint_hints",
    "pairing_secret",
    "expires_at",
    "signature",
}

SIGNED_PAIRING_OFFER_FIELDS = (
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
class SyncTrustServices:
    get_or_create_local_identity: SyncTrustService
    create_pairing_offer: SyncTrustService
    answer_pairing_offer: SyncTrustService
    trust_peer: SyncTrustService
    list_trusted_peers: SyncTrustService
    revoke_trusted_peer: SyncTrustService
    require_trusted_peer: SyncTrustService
    update_trusted_peer_endpoint_hints: SyncTrustService
    derive_device_id: SyncTrustService


@pytest.fixture()
def db_session() -> Iterator[Session]:
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    run_migrations(settings)

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def sync_trust_services() -> SyncTrustServices:
    try:
        module = importlib.import_module("app.services.sync_trust")
    except ModuleNotFoundError as exc:
        if exc.name == "app.services.sync_trust":
            pytest.fail(
                "Expected app.services.sync_trust for sync trust issue #124 service behavior tests."
            )
        raise

    crypto = importlib.import_module("app.services.sync_crypto")

    def derive_device_id(public_key: str) -> str:
        return crypto.derive_device_id(crypto.decode_key(public_key))

    return SyncTrustServices(
        get_or_create_local_identity=_require_callable(
            module,
            "get_or_create_local_identity",
            "get_or_create_local_sync_identity",
        ),
        create_pairing_offer=_require_callable(module, "create_pairing_offer"),
        answer_pairing_offer=_require_callable(module, "answer_pairing_offer"),
        trust_peer=_require_callable(module, "trust_peer", "trust_peer_from_pairing_payload"),
        list_trusted_peers=_require_callable(module, "list_trusted_peers"),
        revoke_trusted_peer=_require_callable(module, "revoke_trusted_peer"),
        require_trusted_peer=_require_callable(module, "require_trusted_peer"),
        update_trusted_peer_endpoint_hints=_require_callable(module, "update_trusted_peer_endpoint_hints"),
        derive_device_id=derive_device_id,
    )


def test_local_identity_creation_is_idempotent_and_device_id_is_derived(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    first = _local_identity(sync_trust_services, db_session)
    db_session.commit()
    db_session.expire_all()

    second = _local_identity(sync_trust_services, db_session)

    assert first["device_id"] == second["device_id"]
    assert first["public_key"] == second["public_key"]
    assert first["sync_group_id"] == second["sync_group_id"]
    assert first["device_id"] == sync_trust_services.derive_device_id(first["public_key"])
    assert first["display_name"]


def test_pairing_offer_contains_identity_group_secret_and_expiration(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)

    offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))

    assert set(offer) >= PAIRING_OFFER_FIELDS
    assert offer["sync_group_id"] == identity["sync_group_id"]
    assert offer["device_id"] == identity["device_id"]
    assert offer["public_key"] == identity["public_key"]
    assert offer["display_name"] == identity["display_name"]
    assert isinstance(offer["endpoint_hints"], list)
    assert offer["pairing_secret"]
    assert _parse_datetime(offer["expires_at"]) > datetime.now(UTC)


def test_trusting_valid_peer_persists_pairwise_trust(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)
    template_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))
    peer_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
    )

    trusted_peer = _plain_mapping(sync_trust_services.trust_peer(db_session, peer_offer))
    db_session.commit()
    db_session.expire_all()

    peers = _plain_list(sync_trust_services.list_trusted_peers(db_session))
    listed_peer = _peer_by_device_id(peers, peer_offer["device_id"])

    assert trusted_peer["device_id"] == peer_offer["device_id"]
    assert trusted_peer["sync_group_id"] == identity["sync_group_id"]
    assert trusted_peer["public_key"] == peer_offer["public_key"]
    assert trusted_peer.get("revoked_at") is None
    assert listed_peer["device_id"] == peer_offer["device_id"]
    assert listed_peer.get("revoked_at") is None


def test_answer_pairing_offer_trusts_remote_and_returns_local_response(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)
    template_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))
    remote_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
        pairing_offer_id="pair_remote_offer_1",
    )

    answer = _plain_mapping(
        sync_trust_services.answer_pairing_offer(
            db_session,
            remote_offer,
            endpoint_hints=["tuneforge-sync+tcp://192.168.1.42:48625?device_id=device_local&v=1"],
        )
    )
    response_payload = _unwrap_mapping(answer, "payload")
    trusted_peer = _unwrap_mapping(answer, "trusted_peer")

    assert trusted_peer["device_id"] == remote_offer["device_id"]
    assert trusted_peer["public_key"] == remote_offer["public_key"]
    assert response_payload["device_id"] == identity["device_id"]
    assert response_payload["public_key"] == identity["public_key"]
    assert response_payload["pairing_offer_id"] == remote_offer["pairing_offer_id"]
    assert response_payload["pairing_secret"] == remote_offer["pairing_secret"]
    assert response_payload["expires_at"] == remote_offer["expires_at"]
    assert response_payload["endpoint_hints"] == [
        "tuneforge-sync+tcp://192.168.1.42:48625?device_id=device_local&v=1"
    ]
    _verify_pairing_payload_signature(identity["public_key"], response_payload)

    listed_peer = _peer_by_device_id(
        _plain_list(sync_trust_services.list_trusted_peers(db_session)),
        remote_offer["device_id"],
    )
    assert listed_peer["device_id"] == remote_offer["device_id"]


def test_self_pairing_is_rejected(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    local_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))

    with pytest.raises(AppError):
        sync_trust_services.trust_peer(db_session, local_offer)


def test_mismatched_sync_group_requires_adoption_and_no_active_peers(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)
    template_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))
    foreign_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id="syncgrp_foreign_empty_library",
        public_key_like=identity["public_key"],
        template_offer=template_offer,
    )

    with pytest.raises(AppError):
        sync_trust_services.trust_peer(db_session, foreign_offer)

    adopted_peer = _plain_mapping(
        sync_trust_services.trust_peer(db_session, foreign_offer, adopt_sync_group=True)
    )
    assert adopted_peer["device_id"] == foreign_offer["device_id"]
    assert adopted_peer["sync_group_id"] == foreign_offer["sync_group_id"]

    second_foreign_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id="syncgrp_second_foreign_group",
        public_key_like=identity["public_key"],
        template_offer=template_offer,
    )
    with pytest.raises(AppError):
        sync_trust_services.trust_peer(db_session, second_foreign_offer, adopt_sync_group=True)


def test_device_id_public_key_mismatch_and_malformed_public_key_are_rejected(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)
    template_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))
    valid_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
    )

    mismatched_offer = {**valid_offer, "device_id": f"{valid_offer['device_id']}_mismatch"}
    with pytest.raises(AppError):
        sync_trust_services.trust_peer(db_session, mismatched_offer)

    malformed_offer = {**valid_offer, "public_key": "not-a-valid-public-key"}
    with pytest.raises(AppError):
        sync_trust_services.trust_peer(db_session, malformed_offer)


def test_pairing_payload_tampering_is_rejected(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)
    template_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))
    valid_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
    )

    tampered_secret = {**valid_offer, "pairing_secret": "manual-pairing-secret-tampered"}
    with pytest.raises(AppError):
        sync_trust_services.trust_peer(db_session, tampered_secret)

    tampered_expiry = {
        **valid_offer,
        "expires_at": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
    }
    with pytest.raises(AppError):
        sync_trust_services.trust_peer(db_session, tampered_expiry)


def test_unknown_pairing_offer_is_rejected(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)
    template_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))
    unknown_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
        pairing_offer_id="pair_unknown_manual_offer",
    )

    with pytest.raises(AppError):
        sync_trust_services.trust_peer(db_session, unknown_offer)


def test_revoked_peer_is_not_trusted_and_stale_payload_cannot_repair_revocation(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)
    template_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))
    peer_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
    )
    sync_trust_services.trust_peer(db_session, peer_offer)

    revoked_peer = _plain_mapping(sync_trust_services.revoke_trusted_peer(db_session, peer_offer["device_id"]))

    assert revoked_peer["device_id"] == peer_offer["device_id"]
    assert revoked_peer["revoked_at"] is not None
    with pytest.raises(AppError):
        sync_trust_services.require_trusted_peer(db_session, peer_offer["device_id"])

    assert _plain_list(sync_trust_services.list_trusted_peers(db_session)) == []

    with pytest.raises(AppError):
        sync_trust_services.trust_peer(db_session, peer_offer)


def test_update_trusted_peer_endpoint_hints_normalizes_and_is_idempotent(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)
    template_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))
    peer_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
    )
    sync_trust_services.trust_peer(db_session, peer_offer)

    updated_peer = _plain_mapping(
        sync_trust_services.update_trusted_peer_endpoint_hints(
            db_session,
            device_id=peer_offer["device_id"],
            endpoint_hints=[
                " tuneforge-sync+tcp://192.168.1.42:48625?device_id=device_peer&v=1 ",
                "tuneforge-sync+iroh://peer.example?device_id=device_peer&v=1",
            ],
        )
    )
    unchanged_peer = _plain_mapping(
        sync_trust_services.update_trusted_peer_endpoint_hints(
            db_session,
            device_id=peer_offer["device_id"],
            endpoint_hints=[
                "tuneforge-sync+tcp://192.168.1.42:48625?device_id=device_peer&v=1",
                "tuneforge-sync+iroh://peer.example?device_id=device_peer&v=1",
            ],
        )
    )

    assert updated_peer["endpoint_hints"] == [
        "tuneforge-sync+tcp://192.168.1.42:48625?device_id=device_peer&v=1",
        "tuneforge-sync+iroh://peer.example?device_id=device_peer&v=1",
    ]
    assert unchanged_peer["endpoint_hints"] == updated_peer["endpoint_hints"]
    assert unchanged_peer["updated_at"] == updated_peer["updated_at"]


def test_update_trusted_peer_endpoint_hints_rejects_invalid_unknown_and_revoked(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)
    template_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))
    peer_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
    )
    sync_trust_services.trust_peer(db_session, peer_offer)

    with pytest.raises(AppError) as invalid_exc:
        sync_trust_services.update_trusted_peer_endpoint_hints(
            db_session,
            device_id=peer_offer["device_id"],
            endpoint_hints=[" "],
        )
    assert invalid_exc.value.code == "SYNC_PAIRING_INVALID"
    assert invalid_exc.value.status_code == 400

    with pytest.raises(AppError) as unknown_exc:
        sync_trust_services.update_trusted_peer_endpoint_hints(
            db_session,
            device_id="device_unknown",
            endpoint_hints=[],
        )
    assert unknown_exc.value.code == "SYNC_PEER_UNTRUSTED"
    assert unknown_exc.value.status_code == 404
    assert unknown_exc.value.details == {"device_id": "device_unknown"}

    sync_trust_services.revoke_trusted_peer(db_session, peer_offer["device_id"])

    with pytest.raises(AppError) as revoked_exc:
        sync_trust_services.update_trusted_peer_endpoint_hints(
            db_session,
            device_id=peer_offer["device_id"],
            endpoint_hints=[],
        )
    assert revoked_exc.value.code == "SYNC_PEER_UNTRUSTED"
    assert revoked_exc.value.status_code == 404
    assert revoked_exc.value.details == {"device_id": peer_offer["device_id"]}


def test_expired_pairing_payload_is_rejected(
    db_session: Session,
    sync_trust_services: SyncTrustServices,
) -> None:
    identity = _local_identity(sync_trust_services, db_session)
    template_offer = _pairing_payload(_pairing_offer(sync_trust_services, db_session))
    expired_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )

    with pytest.raises(AppError):
        sync_trust_services.trust_peer(db_session, expired_offer)


def test_sync_identity_and_pairing_routes_smoke(client, sync_trust_services: SyncTrustServices) -> None:
    identity_response = client.get("/api/v1/sync/identity")
    assert identity_response.status_code == 200
    identity = _unwrap_mapping(identity_response.json(), "identity")
    assert {"sync_group_id", "device_id", "display_name", "public_key"} <= set(identity)
    assert identity["device_id"] == sync_trust_services.derive_device_id(identity["public_key"])

    offer_response = client.post("/api/v1/sync/pairing/offers", json={})
    assert offer_response.status_code in {200, 201}
    offer = _pairing_payload(_unwrap_mapping(offer_response.json(), "pairing_offer"))
    assert set(offer) >= PAIRING_OFFER_FIELDS
    assert offer["device_id"] == identity["device_id"]
    assert offer["sync_group_id"] == identity["sync_group_id"]


def test_trusted_peer_routes_create_list_and_revoke(client, sync_trust_services: SyncTrustServices) -> None:
    identity = _unwrap_mapping(client.get("/api/v1/sync/identity").json(), "identity")
    template_offer = _pairing_payload(
        _unwrap_mapping(client.post("/api/v1/sync/pairing/offers", json={}).json(), "pairing_offer")
    )
    peer_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
    )

    trust_response = client.post("/api/v1/sync/trusted-peers", json={"payload": peer_offer})
    assert trust_response.status_code in {200, 201}
    trusted_peer = _unwrap_mapping(trust_response.json(), "trusted_peer")
    assert trusted_peer["device_id"] == peer_offer["device_id"]
    assert trusted_peer.get("revoked_at") is None

    list_response = client.get("/api/v1/sync/trusted-peers")
    assert list_response.status_code == 200
    listed_peers = _unwrap_list(list_response.json(), "trusted_peers")
    assert _peer_by_device_id(listed_peers, peer_offer["device_id"])["public_key"] == peer_offer["public_key"]

    patch_response = client.patch(
        f"/api/v1/sync/trusted-peers/{peer_offer['device_id']}/endpoint-hints",
        json={
            "endpoint_hints": [
                " tuneforge-sync+tcp://192.168.1.42:48625?device_id=device_peer&v=1 ",
                "tuneforge-sync+iroh://peer.example?device_id=device_peer&v=1",
            ]
        },
    )
    assert patch_response.status_code == 200
    patched_peer = _unwrap_mapping(patch_response.json(), "trusted_peer")
    assert patched_peer["endpoint_hints"] == [
        "tuneforge-sync+tcp://192.168.1.42:48625?device_id=device_peer&v=1",
        "tuneforge-sync+iroh://peer.example?device_id=device_peer&v=1",
    ]

    unchanged_response = client.patch(
        f"/api/v1/sync/trusted-peers/{peer_offer['device_id']}/endpoint-hints",
        json={"endpoint_hints": patched_peer["endpoint_hints"]},
    )
    assert unchanged_response.status_code == 200
    unchanged_peer = _unwrap_mapping(unchanged_response.json(), "trusted_peer")
    assert unchanged_peer["endpoint_hints"] == patched_peer["endpoint_hints"]
    assert unchanged_peer["updated_at"] == patched_peer["updated_at"]

    invalid_patch_response = client.patch(
        f"/api/v1/sync/trusted-peers/{peer_offer['device_id']}/endpoint-hints",
        json={"endpoint_hints": [" "]},
    )
    assert invalid_patch_response.status_code == 422

    revoke_response = client.request(
        "DELETE",
        f"/api/v1/sync/trusted-peers/{peer_offer['device_id']}",
    )
    assert revoke_response.status_code == 200
    revoked_peer = _unwrap_mapping(revoke_response.json(), "trusted_peer")
    assert revoked_peer["device_id"] == peer_offer["device_id"]
    assert revoked_peer["revoked_at"] is not None

    revoked_patch_response = client.patch(
        f"/api/v1/sync/trusted-peers/{peer_offer['device_id']}/endpoint-hints",
        json={"endpoint_hints": []},
    )
    assert revoked_patch_response.status_code == 404
    assert revoked_patch_response.json()["error"]["code"] == "SYNC_PEER_UNTRUSTED"

    unknown_patch_response = client.patch(
        "/api/v1/sync/trusted-peers/device_unknown/endpoint-hints",
        json={"endpoint_hints": []},
    )
    assert unknown_patch_response.status_code == 404
    assert unknown_patch_response.json()["error"]["code"] == "SYNC_PEER_UNTRUSTED"


def test_pairing_response_route_answers_remote_offer(client, sync_trust_services: SyncTrustServices) -> None:
    identity = _unwrap_mapping(client.get("/api/v1/sync/identity").json(), "identity")
    template_offer = _pairing_payload(
        _unwrap_mapping(client.post("/api/v1/sync/pairing/offers", json={}).json(), "pairing_offer")
    )
    remote_offer = _remote_pairing_offer(
        sync_trust_services,
        sync_group_id=identity["sync_group_id"],
        public_key_like=identity["public_key"],
        template_offer=template_offer,
        pairing_offer_id="pair_remote_route_offer",
    )

    response = client.post(
        "/api/v1/sync/pairing/responses",
        json={
            "offer": remote_offer,
            "endpoint_hints": ["tuneforge-sync+tcp://192.168.1.42:48625?device_id=device_local&v=1"],
            "adopt_sync_group": False,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    pairing_response = _unwrap_mapping(payload, "pairing_response")
    trusted_peer = _unwrap_mapping(payload, "trusted_peer")
    assert trusted_peer["device_id"] == remote_offer["device_id"]
    assert pairing_response["device_id"] == identity["device_id"]
    assert pairing_response["pairing_offer_id"] == remote_offer["pairing_offer_id"]
    assert pairing_response["pairing_secret"] == remote_offer["pairing_secret"]
    assert pairing_response["endpoint_hints"] == [
        "tuneforge-sync+tcp://192.168.1.42:48625?device_id=device_local&v=1"
    ]
    _verify_pairing_payload_signature(
        identity["public_key"],
        {**pairing_response, "expires_at": _parse_datetime(pairing_response["expires_at"]).isoformat()},
    )

    list_response = client.get("/api/v1/sync/trusted-peers")
    assert list_response.status_code == 200
    peers = _unwrap_list(list_response.json(), "trusted_peers")
    assert _peer_by_device_id(peers, remote_offer["device_id"])["public_key"] == remote_offer["public_key"]


def _require_callable(module: Any, *names: str) -> SyncTrustService:
    for name in names:
        value = getattr(module, name, None)
        if callable(value):
            return value
    expected = ", ".join(names)
    pytest.fail(f"Expected callable sync trust service named one of: {expected}.")


def _to_plain(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return _to_plain(value.model_dump(mode="json"))
    if is_dataclass(value):
        return _to_plain(asdict(value))
    if isinstance(value, dict):
        return {key: _to_plain(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_plain(child) for child in value]
    return value


def _plain_mapping(value: Any) -> dict[str, Any]:
    plain = _to_plain(value)
    assert isinstance(plain, dict)
    return plain


def _plain_list(value: Any) -> list[dict[str, Any]]:
    plain = _to_plain(value)
    if isinstance(plain, dict) and "trusted_peers" in plain:
        plain = plain["trusted_peers"]
    assert isinstance(plain, list)
    for item in plain:
        assert isinstance(item, dict)
    return plain


def _unwrap_mapping(payload: dict[str, Any], key: str) -> dict[str, Any]:
    if key in payload:
        nested = payload[key]
        assert isinstance(nested, dict)
        return nested
    return _plain_mapping(payload)


def _unwrap_list(payload: dict[str, Any], key: str) -> list[dict[str, Any]]:
    if key in payload:
        nested = payload[key]
    else:
        nested = payload
    return _plain_list(nested)


def _pairing_offer(services: SyncTrustServices, session: Session) -> dict[str, Any]:
    _local_identity(services, session)
    return _plain_mapping(services.create_pairing_offer(session))


def _local_identity(services: SyncTrustServices, session: Session) -> dict[str, Any]:
    return _plain_mapping(services.get_or_create_local_identity(session, display_name="Studio MacBook"))


def _pairing_payload(offer: dict[str, Any]) -> dict[str, Any]:
    if "payload" in offer:
        payload = offer["payload"]
        assert isinstance(payload, dict)
        return payload
    return offer


def _remote_pairing_offer(
    services: SyncTrustServices,
    *,
    sync_group_id: str,
    public_key_like: str,
    template_offer: dict[str, Any],
    display_name: str = "MacBook Practice Rig",
    expires_at: datetime | None = None,
    pairing_offer_id: str | None = None,
) -> dict[str, Any]:
    public_key, private_key_bytes = _new_keypair_like(public_key_like)
    expiration = expires_at or _parse_datetime(template_offer["expires_at"])
    payload = {
        "protocol_version": template_offer["protocol_version"],
        "pairing_offer_id": pairing_offer_id or template_offer["pairing_offer_id"],
        "sync_group_id": sync_group_id,
        "device_id": services.derive_device_id(public_key),
        "display_name": display_name,
        "public_key": public_key,
        "endpoint_hints": list(template_offer.get("endpoint_hints") or []),
        "pairing_secret": template_offer.get("pairing_secret", "manual-pairing-secret-123456"),
        "expires_at": expiration.isoformat(),
    }
    payload["signature"] = _sign_pairing_payload(private_key_bytes, payload)
    return payload


def _new_keypair_like(reference_key: str) -> tuple[str, bytes]:
    private_key = Ed25519PrivateKey.generate()
    private_key_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_key = private_key.public_key()
    if reference_key.startswith("-----BEGIN"):
        return (
            public_key.public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            ).decode("ascii"),
            private_key_bytes,
        )

    raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    encoded = _b64encode(raw)
    if reference_key.startswith("ed25519:"):
        return f"ed25519:{encoded}", private_key_bytes
    return encoded, private_key_bytes


def _sign_pairing_payload(private_key_bytes: bytes, payload: dict[str, Any]) -> str:
    crypto = importlib.import_module("app.services.sync_crypto")
    signed_payload = {field_name: payload[field_name] for field_name in SIGNED_PAIRING_OFFER_FIELDS}
    message = json.dumps(signed_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return crypto.sign_payload(private_key_bytes, message)


def _verify_pairing_payload_signature(public_key: str, payload: dict[str, Any]) -> None:
    crypto = importlib.import_module("app.services.sync_crypto")
    signed_payload = {field_name: payload[field_name] for field_name in SIGNED_PAIRING_OFFER_FIELDS}
    message = json.dumps(signed_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    crypto.verify_payload_signature(crypto.decode_key(public_key), message, payload["signature"])


def _b64encode(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _peer_by_device_id(peers: list[dict[str, Any]], device_id: str) -> dict[str, Any]:
    for peer in peers:
        if peer.get("device_id") == device_id:
            return peer
    raise AssertionError(f"Expected trusted peer {device_id} in {peers!r}.")
