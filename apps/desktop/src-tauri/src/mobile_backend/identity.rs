use super::*;

pub(super) fn ensure_local_identity(connection: &Connection) -> Result<(), String> {
    let existing = connection
        .query_row(
            "SELECT 1 FROM sync_local_identities WHERE id = ?1",
            params![LOCAL_IDENTITY_ID],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing.is_some() {
        return Ok(());
    }

    let mut private_key_bytes = [0_u8; 32];
    fill_os_random(&mut private_key_bytes, "sync identity private key")?;
    let signing_key = SigningKey::from_bytes(&private_key_bytes);
    let public_key_bytes = signing_key.verifying_key().to_bytes();
    let timestamp = now_iso();
    connection
            .execute(
                "INSERT INTO sync_local_identities (id, sync_group_id, device_id, display_name, public_key, private_key, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    LOCAL_IDENTITY_ID,
                    new_sync_group_id()?,
                    derive_device_id(&public_key_bytes),
                    DEFAULT_LOCAL_DISPLAY_NAME,
                    encode_key(&public_key_bytes),
                    encode_key(&private_key_bytes),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn new_sync_group_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    fill_os_random(&mut bytes, "sync group id")?;
    Ok(format!("{SYNC_GROUP_ID_PREFIX}{}", encode_key(&bytes)))
}

pub(super) fn derive_device_id(public_key_bytes: &[u8; 32]) -> String {
    let digest = Sha256::digest(public_key_bytes);
    format!("{DEVICE_ID_PREFIX}{}", encode_key(&digest))
}

pub(super) fn encode_key(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(super) fn decode_key(value: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(value.trim())
        .map_err(|_| "Value must be URL-safe base64.".to_string())
}

fn fill_os_random(bytes: &mut [u8], label: &str) -> Result<(), String> {
    SysRng
        .try_fill_bytes(bytes)
        .map_err(|error| format!("Could not generate {label}: {error}"))
}

pub(super) fn new_prefixed_token(
    prefix: &str,
    byte_count: usize,
    label: &str,
) -> Result<String, String> {
    let mut bytes = vec![0_u8; byte_count];
    fill_os_random(&mut bytes, label)?;
    Ok(format!("{prefix}{}", encode_key(&bytes)))
}

pub(super) fn new_pairing_offer_id() -> Result<String, String> {
    new_prefixed_token(PAIRING_PREFIX, 16, "pairing offer id")
}

pub(super) fn new_pairing_secret() -> Result<String, String> {
    new_prefixed_token(PAIRING_PREFIX, 32, "pairing secret")
}

pub(super) fn hash_pairing_secret(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PAIRING_SECRET_HASH_CONTEXT);
    hasher.update(secret.as_bytes());
    format!("{SECRET_HASH_PREFIX}{}", encode_key(&hasher.finalize()))
}

pub(super) fn local_identity(connection: &Connection) -> Result<SyncLocalIdentitySchema, String> {
    ensure_local_identity(connection)?;
    connection
            .query_row(
                "SELECT device_id, sync_group_id, display_name, public_key, created_at, updated_at FROM sync_local_identities WHERE id = ?1",
                params![LOCAL_IDENTITY_ID],
                |row| {
                    Ok(SyncLocalIdentitySchema {
                        device_id: row.get(0)?,
                        sync_group_id: row.get(1)?,
                        display_name: Some(row.get::<_, String>(2)?),
                        public_key: row.get(3)?,
                        created_at: Some(row.get(4)?),
                        updated_at: Some(row.get(5)?),
                    })
                },
            )
            .map_err(|error| error.to_string())
}

pub(super) fn active_trusted_device_ids(
    connection: &Connection,
) -> Result<HashSet<String>, String> {
    let identity = local_identity(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT device_id FROM sync_trusted_peers WHERE revoked_at IS NULL AND sync_group_id = ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![identity.sync_group_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?;
    let mut device_ids = HashSet::new();
    for row in rows {
        device_ids.insert(row.map_err(|error| error.to_string())?);
    }
    Ok(device_ids)
}

pub(super) fn normalize_endpoint_hints(endpoint_hints: Vec<String>) -> Result<Vec<String>, String> {
    let mut normalized = Vec::with_capacity(endpoint_hints.len());
    for hint in endpoint_hints {
        let trimmed = hint.trim();
        if trimmed.is_empty() {
            return Err("Pairing endpoint_hints cannot contain empty values.".to_string());
        }
        normalized.push(trimmed.to_string());
    }
    Ok(normalized)
}

pub(super) fn trim_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|inner| {
        let trimmed = inner.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

pub(super) fn parse_utc(value: &str, field_name: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&Utc))
        .map_err(|_| format!("{field_name} must be an ISO-8601 timestamp."))
}

pub(super) fn pairing_iso(value: DateTime<Utc>) -> String {
    let micros = value.timestamp_subsec_micros();
    if micros == 0 {
        value.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
    }
}

pub(super) fn signed_pairing_payload_json(
    payload: &SyncPairingPayloadSchema,
) -> Result<String, String> {
    let expires_at = pairing_iso(parse_utc(&payload.expires_at, "expires_at")?);
    let mut signed = BTreeMap::new();
    signed.insert(
        "device_id",
        Value::String(payload.device_id.trim().to_string()),
    );
    signed.insert(
        "display_name",
        payload
            .display_name
            .as_ref()
            .map(|value| Value::String(value.trim().to_string()))
            .unwrap_or(Value::Null),
    );
    signed.insert("endpoint_hints", json!(payload.endpoint_hints));
    signed.insert("expires_at", Value::String(expires_at));
    signed.insert(
        "pairing_offer_id",
        Value::String(payload.pairing_offer_id.trim().to_string()),
    );
    signed.insert(
        "pairing_secret",
        Value::String(payload.pairing_secret.trim().to_string()),
    );
    signed.insert(
        "protocol_version",
        Value::String(payload.protocol_version.trim().to_string()),
    );
    signed.insert(
        "public_key",
        Value::String(payload.public_key.trim().to_string()),
    );
    signed.insert(
        "sync_group_id",
        Value::String(payload.sync_group_id.trim().to_string()),
    );
    serde_json::to_string(&signed).map_err(|error| error.to_string())
}

pub(super) fn sign_pairing_payload(
    private_key: &str,
    payload: &SyncPairingPayloadSchema,
) -> Result<String, String> {
    let message = signed_pairing_payload_json(payload)?;
    sign_canonical_payload(private_key, &message)
}

pub(super) fn sign_canonical_payload(private_key: &str, message: &str) -> Result<String, String> {
    let private_key_bytes: [u8; 32] = decode_key(private_key)?
        .try_into()
        .map_err(|_| "Local private key is invalid.".to_string())?;
    let signing_key = SigningKey::from_bytes(&private_key_bytes);
    let signature = signing_key.sign(message.as_bytes());
    Ok(encode_key(&signature.to_bytes()))
}

pub(super) fn validate_pairing_payload(
    payload: SyncPairingPayloadSchema,
) -> Result<SyncPairingPayloadSchema, String> {
    if payload.protocol_version.trim() != SYNC_PAIRING_PROTOCOL_VERSION {
        return Err("Pairing payload uses an unsupported protocol version.".to_string());
    }
    let endpoint_hints = normalize_endpoint_hints(payload.endpoint_hints)?;
    let display_name =
        trim_optional_string(payload.display_name).or_else(|| Some("Trusted Device".to_string()));
    let expires_at = parse_utc(&payload.expires_at, "expires_at")?;
    if expires_at <= Utc::now() {
        return Err("Pairing payload has expired.".to_string());
    }

    let public_key_bytes: [u8; 32] = decode_key(&payload.public_key)?
        .try_into()
        .map_err(|_| "Pairing payload public_key is invalid.".to_string())?;
    let expected_device_id = derive_device_id(&public_key_bytes);
    if expected_device_id != payload.device_id.trim() {
        return Err("Pairing payload device_id does not match its public_key.".to_string());
    }
    let signature_bytes = decode_key(&payload.signature)?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "Pairing payload signature is invalid.".to_string())?;
    let normalized = SyncPairingPayloadSchema {
        sync_group_id: payload.sync_group_id.trim().to_string(),
        device_id: payload.device_id.trim().to_string(),
        display_name,
        public_key: payload.public_key.trim().to_string(),
        endpoint_hints,
        protocol_version: payload.protocol_version.trim().to_string(),
        pairing_offer_id: payload.pairing_offer_id.trim().to_string(),
        pairing_secret: payload.pairing_secret.trim().to_string(),
        expires_at: pairing_iso(expires_at),
        signature: payload.signature.trim().to_string(),
    };
    if normalized.sync_group_id.is_empty()
        || normalized.pairing_offer_id.is_empty()
        || normalized.pairing_secret.is_empty()
    {
        return Err("Pairing payload contains empty required fields.".to_string());
    }
    let verifying_key = VerifyingKey::from_bytes(&public_key_bytes)
        .map_err(|_| "Pairing payload public_key is invalid.".to_string())?;
    let message = signed_pairing_payload_json(&normalized)?;
    verifying_key
        .verify(message.as_bytes(), &signature)
        .map_err(|_| "Pairing payload signature is invalid.".to_string())?;
    Ok(normalized)
}

pub(super) fn validate_pairing_peer_identity(
    connection: &Connection,
    payload: &SyncPairingPayloadSchema,
    adopt_sync_group: bool,
) -> Result<(), String> {
    let identity = local_identity(connection)?;
    if payload.device_id == identity.device_id {
        return Err("Cannot trust this device's own pairing payload.".to_string());
    }
    if payload.sync_group_id != identity.sync_group_id {
        let active_peer_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_trusted_peers WHERE revoked_at IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !adopt_sync_group || active_peer_count > 0 {
            return Err("Pairing payload belongs to a different sync group.".to_string());
        }
        connection
                .execute(
                    "UPDATE sync_local_identities SET sync_group_id = ?1, updated_at = ?2 WHERE id = ?3",
                    params![payload.sync_group_id, now_iso(), LOCAL_IDENTITY_ID],
                )
                .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn upsert_trusted_peer(
    connection: &Connection,
    payload: &SyncPairingPayloadSchema,
) -> Result<SyncTrustedPeerSchema, String> {
    let now = now_iso();
    let existing_public_key_peer: Option<String> = connection
        .query_row(
            "SELECT device_id FROM sync_trusted_peers WHERE public_key = ?1",
            params![payload.public_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing_public_key_peer
        .as_deref()
        .is_some_and(|device_id| device_id != payload.device_id)
    {
        return Err(
            "Pairing payload public_key is already trusted for a different device.".to_string(),
        );
    }

    connection
            .execute(
                "INSERT INTO sync_trusted_peers (device_id, sync_group_id, display_name, public_key, endpoint_hints_json, trusted_at, revoked_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?6, ?6)
                 ON CONFLICT(device_id) DO UPDATE SET sync_group_id = excluded.sync_group_id, display_name = excluded.display_name, public_key = excluded.public_key, endpoint_hints_json = excluded.endpoint_hints_json, trusted_at = excluded.trusted_at, revoked_at = NULL, updated_at = excluded.updated_at",
                params![
                    payload.device_id,
                    payload.sync_group_id,
                    payload.display_name,
                    payload.public_key,
                    serde_json::to_string(&payload.endpoint_hints).map_err(|error| error.to_string())?,
                    now,
                ],
            )
            .map_err(|error| error.to_string())?;
    get_trusted_peer(connection, &payload.device_id)
}

pub(super) fn find_trusted_peer(
    connection: &Connection,
    device_id: &str,
) -> Result<Option<SyncTrustedPeerSchema>, String> {
    connection
            .query_row(
                "SELECT device_id, sync_group_id, display_name, public_key, endpoint_hints_json, trusted_at, revoked_at, updated_at FROM sync_trusted_peers WHERE device_id = ?1",
                params![device_id],
                row_trusted_peer,
            )
            .optional()
            .map_err(|error| error.to_string())
}

pub(super) fn get_trusted_peer(
    connection: &Connection,
    device_id: &str,
) -> Result<SyncTrustedPeerSchema, String> {
    find_trusted_peer(connection, device_id)?.ok_or_else(|| "Trusted peer is unknown.".to_string())
}

pub fn mobile_get_sync_identity(app: AppHandle) -> Result<SyncLocalIdentityResponse, String> {
    let connection = db(&app)?;
    Ok(SyncLocalIdentityResponse {
        identity: local_identity(&connection)?,
    })
}

pub fn mobile_sign_transport_handshake(
    app: AppHandle,
    peer_device_id: String,
    challenge: Value,
) -> Result<Value, String> {
    if peer_device_id != peer_device_id.trim() || peer_device_id.is_empty() {
        return Err("peer_device_id must be canonical.".to_string());
    }
    if peer_device_id.len() > 128 {
        return Err("peer_device_id is too long.".to_string());
    }
    let connection = db(&app)?;
    let identity = local_identity(&connection)?;
    let trusted_peer = find_trusted_peer(&connection, &peer_device_id)?;
    validate_transport_trusted_peer(trusted_peer.as_ref(), &identity.sync_group_id)?;
    let canonical_challenge = canonical_transport_handshake_challenge(
        &challenge,
        &identity.device_id,
        &peer_device_id,
        Utc::now(),
    )?;
    let canonical_challenge_json = transport_handshake_challenge_json(&canonical_challenge)?;
    let private_key: String = connection
        .query_row(
            "SELECT private_key FROM sync_local_identities WHERE id = ?1",
            params![LOCAL_IDENTITY_ID],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let signature = sign_canonical_payload(&private_key, &canonical_challenge_json)?;
    Ok(transport_handshake_proof_value(
        &identity.device_id,
        &peer_device_id,
        &identity.public_key,
        canonical_challenge,
        canonical_challenge_json,
        signature,
        Utc::now(),
    ))
}

pub fn mobile_create_sync_pairing_offer(
    app: AppHandle,
    payload: Option<SyncPairingOfferRequest>,
) -> Result<SyncPairingOfferResponse, String> {
    let payload = payload.unwrap_or(SyncPairingOfferRequest {
        endpoint_hints: Vec::new(),
        ttl_seconds: None,
    });
    let ttl_seconds = payload.ttl_seconds.unwrap_or(DEFAULT_PAIRING_TTL_SECONDS);
    if ttl_seconds <= 0 || ttl_seconds > MAX_PAIRING_TTL_SECONDS {
        return Err(format!(
            "Pairing offer ttl_seconds must be between 1 and {MAX_PAIRING_TTL_SECONDS}."
        ));
    }
    let endpoint_hints = normalize_endpoint_hints(payload.endpoint_hints)?;
    let connection = db(&app)?;
    let identity = local_identity(&connection)?;
    let expires_at = Utc::now() + Duration::seconds(ttl_seconds);
    let expires_at_payload = pairing_iso(expires_at);
    let pairing_offer_id = new_pairing_offer_id()?;
    let pairing_secret = new_pairing_secret()?;
    let mut pairing_payload = SyncPairingPayloadSchema {
        sync_group_id: identity.sync_group_id.clone(),
        device_id: identity.device_id.clone(),
        display_name: identity.display_name.clone(),
        public_key: identity.public_key.clone(),
        endpoint_hints,
        protocol_version: SYNC_PAIRING_PROTOCOL_VERSION.to_string(),
        pairing_offer_id: pairing_offer_id.clone(),
        pairing_secret: pairing_secret.clone(),
        expires_at: expires_at_payload.clone(),
        signature: String::new(),
    };
    let private_key: String = connection
        .query_row(
            "SELECT private_key FROM sync_local_identities WHERE id = ?1",
            params![LOCAL_IDENTITY_ID],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    pairing_payload.signature = sign_pairing_payload(&private_key, &pairing_payload)?;
    connection
            .execute(
                "INSERT INTO sync_pairing_offers (id, secret_hash, endpoint_hints_json, expires_at, used_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
                params![
                    pairing_offer_id,
                    hash_pairing_secret(&pairing_secret),
                    serde_json::to_string(&pairing_payload.endpoint_hints).map_err(|error| error.to_string())?,
                    expires_at_payload,
                    now_iso(),
                ],
            )
            .map_err(|error| error.to_string())?;
    Ok(SyncPairingOfferResponse {
        pairing_offer: SyncPairingOfferSchema {
            payload: pairing_payload,
            expires_at: expires_at_payload,
            ttl_seconds: Some(ttl_seconds),
        },
    })
}

pub fn mobile_answer_sync_pairing_offer(
    app: AppHandle,
    payload: SyncPairingAnswerRequest,
) -> Result<SyncPairingAnswerResponse, String> {
    let connection = db(&app)?;
    let offer = validate_pairing_payload(payload.offer)?;
    validate_pairing_peer_identity(&connection, &offer, payload.adopt_sync_group)?;
    let trusted_peer = upsert_trusted_peer(&connection, &offer)?;
    let identity = local_identity(&connection)?;
    let private_key: String = connection
        .query_row(
            "SELECT private_key FROM sync_local_identities WHERE id = ?1",
            params![LOCAL_IDENTITY_ID],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut response = SyncPairingPayloadSchema {
        sync_group_id: identity.sync_group_id,
        device_id: identity.device_id,
        display_name: identity.display_name,
        public_key: identity.public_key,
        endpoint_hints: normalize_endpoint_hints(payload.endpoint_hints)?,
        protocol_version: SYNC_PAIRING_PROTOCOL_VERSION.to_string(),
        pairing_offer_id: offer.pairing_offer_id,
        pairing_secret: offer.pairing_secret,
        expires_at: offer.expires_at,
        signature: String::new(),
    };
    response.signature = sign_pairing_payload(&private_key, &response)?;
    Ok(SyncPairingAnswerResponse {
        pairing_response: response,
        trusted_peer,
    })
}

pub fn mobile_list_sync_trusted_peers(app: AppHandle) -> Result<SyncTrustedPeersResponse, String> {
    let connection = db(&app)?;
    let mut statement = connection
            .prepare(
                "SELECT device_id, sync_group_id, display_name, public_key, endpoint_hints_json, trusted_at, revoked_at, updated_at FROM sync_trusted_peers WHERE revoked_at IS NULL ORDER BY display_name ASC, device_id ASC",
            )
            .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_trusted_peer)
        .map_err(|error| error.to_string())?;
    let mut trusted_peers = Vec::new();
    for row in rows {
        trusted_peers.push(row.map_err(|error| error.to_string())?);
    }
    Ok(SyncTrustedPeersResponse { trusted_peers })
}

pub fn mobile_trust_sync_peer(
    app: AppHandle,
    payload: SyncTrustedPeerCreateRequest,
) -> Result<SyncTrustedPeerResponse, String> {
    let connection = db(&app)?;
    let pairing_payload = validate_pairing_payload(payload.payload)?;
    validate_pairing_peer_identity(&connection, &pairing_payload, payload.adopt_sync_group)?;
    let local_offer = connection
        .query_row(
            "SELECT secret_hash, expires_at, used_at FROM sync_pairing_offers WHERE id = ?1",
            params![pairing_payload.pairing_offer_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Pairing offer is unknown.".to_string())?;
    if local_offer.2.is_some() {
        return Err("Pairing offer has already been used.".to_string());
    }
    if parse_utc(&local_offer.1, "expires_at")? <= Utc::now() {
        return Err("Pairing offer has expired.".to_string());
    }
    if local_offer.0 != hash_pairing_secret(&pairing_payload.pairing_secret) {
        return Err("Pairing payload secret does not match the local offer.".to_string());
    }
    let trusted_peer = upsert_trusted_peer(&connection, &pairing_payload)?;
    connection
        .execute(
            "UPDATE sync_pairing_offers SET used_at = ?1 WHERE id = ?2",
            params![now_iso(), pairing_payload.pairing_offer_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(SyncTrustedPeerResponse { trusted_peer })
}

pub fn mobile_revoke_sync_trusted_peer(
    app: AppHandle,
    device_id: String,
) -> Result<SyncTrustedPeerResponse, String> {
    let connection = db(&app)?;
    let normalized = device_id.trim().to_string();
    if normalized.is_empty() {
        return Err("device_id must not be empty.".to_string());
    }
    let timestamp = now_iso();
    let updated = connection
        .execute(
            "UPDATE sync_trusted_peers SET revoked_at = ?1, updated_at = ?1 WHERE device_id = ?2",
            params![timestamp, normalized],
        )
        .map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("Trusted peer is unknown.".to_string());
    }
    Ok(SyncTrustedPeerResponse {
        trusted_peer: get_trusted_peer(&connection, &normalized)?,
    })
}

pub fn mobile_update_sync_trusted_peer_endpoint_hints(
    app: AppHandle,
    device_id: String,
    payload: SyncTrustedPeerEndpointHintsRequest,
) -> Result<SyncTrustedPeerResponse, String> {
    let connection = db(&app)?;
    let normalized_device_id = device_id.trim().to_string();
    if normalized_device_id.is_empty() {
        return Err("device_id must not be empty.".to_string());
    }
    let endpoint_hints = normalize_endpoint_hints(payload.endpoint_hints)?;
    let trusted_peer = find_trusted_peer(&connection, &normalized_device_id)?
        .filter(|peer| peer.revoked_at.is_none())
        .ok_or_else(|| "Trusted peer is unknown.".to_string())?;
    if trusted_peer.endpoint_hints == endpoint_hints {
        return Ok(SyncTrustedPeerResponse { trusted_peer });
    }

    let timestamp = now_iso();
    connection
        .execute(
            "UPDATE sync_trusted_peers SET endpoint_hints_json = ?1, updated_at = ?2 WHERE device_id = ?3 AND revoked_at IS NULL",
            params![
                serde_json::to_string(&endpoint_hints).map_err(|error| error.to_string())?,
                timestamp,
                normalized_device_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(SyncTrustedPeerResponse {
        trusted_peer: get_trusted_peer(&connection, &normalized_device_id)?,
    })
}
