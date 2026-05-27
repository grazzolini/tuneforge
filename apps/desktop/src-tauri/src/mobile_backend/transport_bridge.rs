use super::*;

fn sync_transport_value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

pub fn mobile_sync_transport_local_identity_value(app: AppHandle) -> Result<Value, String> {
    sync_transport_value(mobile_get_sync_identity(app)?)
}

pub fn mobile_sync_transport_trusted_peers_value(app: AppHandle) -> Result<Value, String> {
    sync_transport_value(mobile_list_sync_trusted_peers(app)?)
}

pub fn mobile_sync_transport_update_trusted_peer_endpoint_hints_value(
    app: AppHandle,
    peer_device_id: String,
    endpoint_hints: Vec<String>,
) -> Result<Value, String> {
    sync_transport_value(mobile_update_sync_trusted_peer_endpoint_hints(
        app,
        peer_device_id,
        SyncTrustedPeerEndpointHintsRequest { endpoint_hints },
    )?)
}

pub fn mobile_sync_transport_refresh_peer_endpoint_hints_value(
    app: AppHandle,
    peer_device_id: String,
    endpoint_hints: Vec<String>,
) -> Result<Value, String> {
    mobile_sync_transport_update_trusted_peer_endpoint_hints_value(
        app,
        peer_device_id,
        endpoint_hints,
    )
}

pub fn mobile_sync_transport_create_pairing_offer_value(
    app: AppHandle,
    endpoint_hints: Vec<String>,
    ttl_seconds: i64,
) -> Result<Value, String> {
    sync_transport_value(mobile_create_sync_pairing_offer(
        app,
        Some(SyncPairingOfferRequest {
            endpoint_hints,
            ttl_seconds: Some(ttl_seconds),
        }),
    )?)
}

pub fn mobile_sync_transport_metadata_value(app: AppHandle) -> Result<Value, String> {
    sync_transport_value(mobile_get_sync_metadata(app)?)
}

pub fn mobile_sync_transport_project_manifest_value(
    app: AppHandle,
    project_id: String,
) -> Result<Value, String> {
    sync_transport_value(mobile_get_sync_project_manifest(app, project_id)?)
}

pub fn mobile_sync_transport_staged_artifact_value(
    app: AppHandle,
    content_sha256: String,
) -> Result<Value, String> {
    sync_transport_value(mobile_get_sync_staged_artifact(app, content_sha256)?)
}

pub fn mobile_sync_transport_stage_artifact_value(
    app: AppHandle,
    body: Value,
) -> Result<Value, String> {
    let payload = serde_json::from_value::<SyncArtifactStagingRequest>(body)
        .map_err(|error| error.to_string())?;
    sync_transport_value(mobile_stage_sync_artifact(app, payload)?)
}

pub fn mobile_sync_transport_reconciliation_plan_value(
    app: AppHandle,
    body: Value,
) -> Result<Value, String> {
    let payload = serde_json::from_value::<SyncReconciliationPlanRequest>(body)
        .map_err(|error| error.to_string())?;
    sync_transport_value(mobile_plan_sync_reconciliation(app, payload)?)
}

pub fn mobile_sync_transport_reconciliation_apply_value(
    app: AppHandle,
    body: Value,
) -> Result<Value, String> {
    let payload = serde_json::from_value::<SyncReconciliationApplyRequest>(body)
        .map_err(|error| error.to_string())?;
    sync_transport_value(mobile_apply_sync_reconciliation(app, payload)?)
}
