from __future__ import annotations

import base64
import binascii
import hashlib
import secrets

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

DEVICE_ID_PREFIX = "dev_ed25519_"
SYNC_GROUP_ID_PREFIX = "syncgrp_"
PAIRING_PREFIX = "pair_"
SECRET_HASH_PREFIX = "sha256_"
PAIRING_SECRET_HASH_CONTEXT = b"tuneforge.sync.pairing_secret.v1\x00"


def generate_private_key_bytes() -> bytes:
    return Ed25519PrivateKey.generate().private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )


def public_key_bytes_from_private_key(private_key_bytes: bytes) -> bytes:
    private_key = Ed25519PrivateKey.from_private_bytes(private_key_bytes)
    return private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


def sign_payload(private_key_bytes: bytes, payload_bytes: bytes) -> str:
    private_key = Ed25519PrivateKey.from_private_bytes(private_key_bytes)
    return encode_key(private_key.sign(payload_bytes))


def verify_payload_signature(public_key_bytes: bytes, payload_bytes: bytes, signature: str) -> None:
    public_key = Ed25519PublicKey.from_public_bytes(public_key_bytes)
    try:
        public_key.verify(decode_key(signature), payload_bytes)
    except InvalidSignature as exc:
        raise ValueError("payload signature is invalid.") from exc


def derive_device_id(public_key_bytes: bytes) -> str:
    return f"{DEVICE_ID_PREFIX}{encode_key(hashlib.sha256(public_key_bytes).digest())}"


def encode_key(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def decode_key(value: str) -> bytes:
    normalized = value.strip()
    padding = "=" * (-len(normalized) % 4)
    try:
        return base64.b64decode(f"{normalized}{padding}", altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("value must be URL-safe base64.") from exc


def new_sync_group_id() -> str:
    return _new_prefixed_token(SYNC_GROUP_ID_PREFIX, byte_count=16)


def new_pairing_offer_id() -> str:
    return _new_prefixed_token(PAIRING_PREFIX, byte_count=16)


def new_pairing_secret() -> str:
    return _new_prefixed_token(PAIRING_PREFIX, byte_count=32)


def hash_pairing_secret(secret: str) -> str:
    digest = hashlib.sha256(PAIRING_SECRET_HASH_CONTEXT + secret.encode("utf-8")).digest()
    return f"{SECRET_HASH_PREFIX}{encode_key(digest)}"


def _new_prefixed_token(prefix: str, *, byte_count: int) -> str:
    return f"{prefix}{encode_key(secrets.token_bytes(byte_count))}"
