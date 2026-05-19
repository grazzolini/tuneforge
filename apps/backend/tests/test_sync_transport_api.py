from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.models import SyncTrustedPeer
from app.services import sync_crypto


def test_transport_handshake_signs_canonical_challenge(client: TestClient) -> None:
    identity = client.get("/api/v1/sync/identity").json()["identity"]
    _add_trusted_peer(identity["sync_group_id"], device_id="peer-transport-a")

    challenge = _challenge(
        peer_device_id="peer-transport-a",
        local_device_id=identity["device_id"],
    )
    response = client.post(
        "/api/v1/sync/transport/handshake/sign",
        json={"peer_device_id": "peer-transport-a", "challenge": challenge},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["local_device_id"] == identity["device_id"]
    assert payload["peer_device_id"] == "peer-transport-a"
    assert payload["public_key"] == identity["public_key"]
    assert payload["challenge"]["challenge_type"] == "transport_handshake"
    assert "private" not in json.dumps(payload)

    sync_crypto.verify_payload_signature(
        sync_crypto.decode_key(identity["public_key"]),
        payload["canonical_challenge_json"].encode("utf-8"),
        payload["signature"],
    )


def test_transport_handshake_rejects_noncanonical_responder(client: TestClient) -> None:
    identity = client.get("/api/v1/sync/identity").json()["identity"]
    _add_trusted_peer(identity["sync_group_id"], device_id="peer-transport-b")

    challenge = _challenge(
        peer_device_id="peer-transport-b",
        local_device_id="dev_wrong_responder",
    )
    response = client.post(
        "/api/v1/sync/transport/handshake/sign",
        json={"peer_device_id": "peer-transport-b", "challenge": challenge},
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "SYNC_TRANSPORT_CHALLENGE_INVALID"


def test_transport_handshake_rejects_unknown_peer(client: TestClient) -> None:
    identity = client.get("/api/v1/sync/identity").json()["identity"]
    response = client.post(
        "/api/v1/sync/transport/handshake/sign",
        json={
            "peer_device_id": "peer-transport-unknown",
            "challenge": _challenge(
                peer_device_id="peer-transport-unknown",
                local_device_id=identity["device_id"],
            ),
        },
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "SYNC_PEER_UNTRUSTED"


def _add_trusted_peer(sync_group_id: str, *, device_id: str) -> None:
    now = datetime.now(UTC)
    with SessionLocal() as session:
        session.add(
            SyncTrustedPeer(
                device_id=device_id,
                sync_group_id=sync_group_id,
                display_name=device_id,
                public_key=f"pub-{device_id}",
                endpoint_hints_json=[],
                trusted_at=now,
                revoked_at=None,
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()


def _challenge(*, peer_device_id: str, local_device_id: str) -> dict[str, Any]:
    issued_at = datetime.now(UTC)
    expires_at = issued_at + timedelta(seconds=60)
    return {
        "protocol_version": "tuneforge-sync-v1",
        "challenge_type": "transport_handshake",
        "session_id": "session-transport-0001",
        "challenge_nonce": "nonce-transport-0000000000000001",
        "requester_device_id": peer_device_id,
        "responder_device_id": local_device_id,
        "issued_at": issued_at.isoformat(),
        "expires_at": expires_at.isoformat(),
    }
