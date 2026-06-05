use serde::{Deserialize, Serialize};
use serde_json::Value;

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportStartListenerRequest {
    pub bind_host: Option<String>,
    pub port: Option<u16>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportSyncNowRequest {
    pub peer_device_id: String,
    pub endpoint_hint: Option<String>,
    pub endpoint_hints: Option<Vec<String>>,
    pub preferred_transport: Option<String>,
    pub project_ids: Option<Vec<String>>,
    #[serde(default = "default_true")]
    pub export_local: bool,
    #[serde(default = "default_true")]
    pub import_remote: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportPairingOfferRequest {
    pub ttl_seconds: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportLifecycleEventRequest {
    pub kind: String,
    pub occurred_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportLifecycleEvent {
    pub kind: String,
    pub occurred_at: String,
    pub message: Option<String>,
    pub retryable: bool,
    pub interruption_code: Option<String>,
    pub retry_guidance: Option<String>,
    pub peer_device_id: Option<String>,
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportNearbyPeer {
    pub device_id: String,
    pub sync_group_id: String,
    pub display_name: Option<String>,
    pub public_key: String,
    pub endpoint_hints: Vec<String>,
    pub protocol_version: String,
    pub timestamp: String,
    pub observed_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportStatus {
    pub supported: bool,
    pub running: bool,
    pub bind_host: Option<String>,
    pub port: Option<u16>,
    pub endpoint_hints: Vec<String>,
    pub nearby_peers: Vec<SyncTransportNearbyPeer>,
    pub active_sessions: usize,
    pub accepted_sessions: u64,
    pub failed_sessions: u64,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_sync: Option<SyncTransportSyncResult>,
    pub active_progress: Option<SyncTransportActiveProgress>,
    pub last_lifecycle_event: Option<SyncTransportLifecycleEvent>,
    pub lifecycle_events: Vec<SyncTransportLifecycleEvent>,
    pub retryable_interruption_code: Option<String>,
    pub retryable_interruption_peer_device_id: Option<String>,
    pub retry_guidance: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportActiveProgress {
    pub run_id: String,
    pub phase: String,
    pub message: String,
    pub progress_at: String,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportPairingOffer {
    pub endpoint_hints: Vec<String>,
    pub pairing_offer: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportTransferResult {
    pub artifact_id: String,
    pub content_sha256: String,
    pub size_bytes: u64,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    pub throughput_bytes_per_second: f64,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportTransferCounts {
    pub requested: usize,
    pub received: usize,
    pub already_staged: usize,
    pub failed: usize,
    pub received_bytes: u64,
    pub already_staged_bytes: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SyncTransportDiagnostics {
    pub credit_wait_ms_total: u64,
    pub credit_wait_ms_max: u64,
    pub credit_wait_events: u64,
    pub credit_hold_ms_total: u64,
    pub credit_hold_ms_max: u64,
    pub stage_queue_wait_ms_total: u64,
    pub stage_queue_wait_ms_max: u64,
    pub stage_queue_wait_events: u64,
    pub stream_open_ms_total: u64,
    pub stream_open_ms_max: u64,
    pub stream_open_events: u64,
    pub sender_write_ms_total: u64,
    pub sender_write_ms_max: u64,
    pub sender_write_events: u64,
    pub receiver_read_ms_total: u64,
    pub receiver_read_ms_max: u64,
    pub receiver_read_events: u64,
    pub receiver_hash_ms_total: u64,
    pub receiver_hash_ms_max: u64,
    pub receiver_hash_events: u64,
    pub receiver_temp_write_ms_total: u64,
    pub receiver_temp_write_ms_max: u64,
    pub receiver_temp_write_events: u64,
    pub staging_post_ms_total: u64,
    pub staging_post_ms_max: u64,
    pub staging_post_events: u64,
}

impl SyncTransportDiagnostics {
    fn duration_ms(duration: std::time::Duration) -> u64 {
        u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
    }

    fn record_timed_event(
        total_ms: &mut u64,
        max_ms: &mut u64,
        events: &mut u64,
        duration: std::time::Duration,
    ) {
        let duration_ms = Self::duration_ms(duration);
        *total_ms = total_ms.saturating_add(duration_ms);
        *max_ms = (*max_ms).max(duration_ms);
        *events = events.saturating_add(1);
    }

    fn record_timed_total(total_ms: &mut u64, max_ms: &mut u64, duration: std::time::Duration) {
        let duration_ms = Self::duration_ms(duration);
        *total_ms = total_ms.saturating_add(duration_ms);
        *max_ms = (*max_ms).max(duration_ms);
    }

    fn record_credit_wait(&mut self, duration: std::time::Duration) {
        Self::record_timed_event(
            &mut self.credit_wait_ms_total,
            &mut self.credit_wait_ms_max,
            &mut self.credit_wait_events,
            duration,
        );
    }

    fn record_credit_hold(&mut self, duration: std::time::Duration) {
        Self::record_timed_total(
            &mut self.credit_hold_ms_total,
            &mut self.credit_hold_ms_max,
            duration,
        );
    }

    fn record_stage_queue_wait(&mut self, duration: std::time::Duration) {
        Self::record_timed_event(
            &mut self.stage_queue_wait_ms_total,
            &mut self.stage_queue_wait_ms_max,
            &mut self.stage_queue_wait_events,
            duration,
        );
    }

    fn record_stream_open(&mut self, duration: std::time::Duration) {
        Self::record_timed_event(
            &mut self.stream_open_ms_total,
            &mut self.stream_open_ms_max,
            &mut self.stream_open_events,
            duration,
        );
    }

    fn record_sender_write(&mut self, duration: std::time::Duration) {
        Self::record_timed_event(
            &mut self.sender_write_ms_total,
            &mut self.sender_write_ms_max,
            &mut self.sender_write_events,
            duration,
        );
    }

    fn record_receiver_read(&mut self, duration: std::time::Duration) {
        Self::record_timed_event(
            &mut self.receiver_read_ms_total,
            &mut self.receiver_read_ms_max,
            &mut self.receiver_read_events,
            duration,
        );
    }

    fn record_receiver_hash(&mut self, duration: std::time::Duration) {
        Self::record_timed_event(
            &mut self.receiver_hash_ms_total,
            &mut self.receiver_hash_ms_max,
            &mut self.receiver_hash_events,
            duration,
        );
    }

    fn record_receiver_temp_write(&mut self, duration: std::time::Duration) {
        Self::record_timed_event(
            &mut self.receiver_temp_write_ms_total,
            &mut self.receiver_temp_write_ms_max,
            &mut self.receiver_temp_write_events,
            duration,
        );
    }

    fn record_staging_post(&mut self, duration: std::time::Duration) {
        Self::record_timed_event(
            &mut self.staging_post_ms_total,
            &mut self.staging_post_ms_max,
            &mut self.staging_post_events,
            duration,
        );
    }

    fn merge_from(&mut self, other: &Self) {
        self.credit_wait_ms_total = self
            .credit_wait_ms_total
            .saturating_add(other.credit_wait_ms_total);
        self.credit_wait_ms_max = self.credit_wait_ms_max.max(other.credit_wait_ms_max);
        self.credit_wait_events = self
            .credit_wait_events
            .saturating_add(other.credit_wait_events);
        self.credit_hold_ms_total = self
            .credit_hold_ms_total
            .saturating_add(other.credit_hold_ms_total);
        self.credit_hold_ms_max = self.credit_hold_ms_max.max(other.credit_hold_ms_max);
        self.stage_queue_wait_ms_total = self
            .stage_queue_wait_ms_total
            .saturating_add(other.stage_queue_wait_ms_total);
        self.stage_queue_wait_ms_max = self
            .stage_queue_wait_ms_max
            .max(other.stage_queue_wait_ms_max);
        self.stage_queue_wait_events = self
            .stage_queue_wait_events
            .saturating_add(other.stage_queue_wait_events);
        self.stream_open_ms_total = self
            .stream_open_ms_total
            .saturating_add(other.stream_open_ms_total);
        self.stream_open_ms_max = self.stream_open_ms_max.max(other.stream_open_ms_max);
        self.stream_open_events = self
            .stream_open_events
            .saturating_add(other.stream_open_events);
        self.sender_write_ms_total = self
            .sender_write_ms_total
            .saturating_add(other.sender_write_ms_total);
        self.sender_write_ms_max = self.sender_write_ms_max.max(other.sender_write_ms_max);
        self.sender_write_events = self
            .sender_write_events
            .saturating_add(other.sender_write_events);
        self.receiver_read_ms_total = self
            .receiver_read_ms_total
            .saturating_add(other.receiver_read_ms_total);
        self.receiver_read_ms_max = self.receiver_read_ms_max.max(other.receiver_read_ms_max);
        self.receiver_read_events = self
            .receiver_read_events
            .saturating_add(other.receiver_read_events);
        self.receiver_hash_ms_total = self
            .receiver_hash_ms_total
            .saturating_add(other.receiver_hash_ms_total);
        self.receiver_hash_ms_max = self.receiver_hash_ms_max.max(other.receiver_hash_ms_max);
        self.receiver_hash_events = self
            .receiver_hash_events
            .saturating_add(other.receiver_hash_events);
        self.receiver_temp_write_ms_total = self
            .receiver_temp_write_ms_total
            .saturating_add(other.receiver_temp_write_ms_total);
        self.receiver_temp_write_ms_max = self
            .receiver_temp_write_ms_max
            .max(other.receiver_temp_write_ms_max);
        self.receiver_temp_write_events = self
            .receiver_temp_write_events
            .saturating_add(other.receiver_temp_write_events);
        self.staging_post_ms_total = self
            .staging_post_ms_total
            .saturating_add(other.staging_post_ms_total);
        self.staging_post_ms_max = self.staging_post_ms_max.max(other.staging_post_ms_max);
        self.staging_post_events = self
            .staging_post_events
            .saturating_add(other.staging_post_events);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportTimingEvidence {
    pub phase: String,
    pub project_id: Option<String>,
    pub artifact_id: Option<String>,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportProjectResult {
    pub project_id: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportSyncResult {
    pub run_id: String,
    pub peer_device_id: String,
    pub remote_device_id: String,
    pub status: String,
    pub message: String,
    pub selected_transport: String,
    pub fallback_reason: Option<String>,
    pub fallback_code: Option<String>,
    pub attempted_transports: Vec<String>,
    pub started_at: String,
    pub completed_at: String,
    pub duration_ms: u64,
    pub project_results: Vec<SyncTransportProjectResult>,
    pub imported_projects: Vec<SyncTransportProjectResult>,
    pub imported_project_count: usize,
    pub skipped_project_count: usize,
    pub failed_project_count: usize,
    pub received_artifacts: Vec<SyncTransportTransferResult>,
    pub transfer_counts: SyncTransportTransferCounts,
    pub served_artifact_requests: u64,
    pub total_received_bytes: u64,
    pub total_served_bytes: u64,
    pub time_to_first_artifact_ms: Option<u64>,
    pub throughput_bytes_per_second: f64,
    pub scratch_peak_bytes: u64,
    pub staging_peak_bytes: u64,
    pub max_active_streams: u64,
    pub credit_grants: u64,
    pub credit_revokes: u64,
    pub remote_manifest_count: usize,
    pub local_manifest_count: usize,
    pub manifest_errors: Vec<SyncTransportManifestError>,
    pub lifecycle_events: Vec<SyncTransportLifecycleEvent>,
    pub retryable_interruption_code: Option<String>,
    pub retry_guidance: Option<String>,
    pub phase_timings: Vec<SyncTransportTimingEvidence>,
    #[serde(flatten)]
    pub diagnostics: SyncTransportDiagnostics,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportManifestError {
    pub project_id: String,
    pub message: String,
}

mod sync_core {
    use super::SyncTransportManifestError;
    use base64::{
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
        Engine as _,
    };
    use chrono::{DateTime, Utc};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use rand::{rng, Rng};
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::{io, net::TcpStream, sync::Arc, time::Duration};

    pub(crate) const TCP_TRANSPORT_ID: &str = "tuneforge-sync+tcp";
    pub(crate) const IROH_TRANSPORT_ID: &str = "tuneforge-sync+iroh";
    pub(crate) const ENDPOINT_SCHEME: &str = "tuneforge-sync+tcp://";
    pub(crate) const IROH_ENDPOINT_SCHEME: &str = "tuneforge-sync+iroh://";
    pub(crate) const PAIRING_PROTOCOL_VERSION: &str = "tuneforge-sync-v1";
    pub(crate) const TRANSPORT_PROTOCOL_VERSION: &str = "tuneforge-sync-transport-v5";
    pub(crate) const TRANSPORT_HANDSHAKE_CHALLENGE_TYPE: &str = "transport_handshake";
    pub(crate) const MAX_RAW_FRAME: usize = 65_535;
    pub(crate) const NOISE_FRAME_SAFETY_MARGIN: usize = 1024;
    pub(crate) const ENCRYPTED_PAYLOAD_CHUNK: usize = 32 * 1024;
    pub(crate) const ARTIFACT_CHUNK_SIZE: usize = MAX_RAW_FRAME - NOISE_FRAME_SAFETY_MARGIN - 1;
    pub(crate) const PAIRING_OFFER_TTL_SECONDS: u32 = 600;
    const TRANSPORT_HANDSHAKE_TTL_SECONDS: i64 = 60;
    pub(crate) const ENCRYPTED_FRAME_MESSAGE_CHUNK: u8 = 1;
    pub(crate) const ENCRYPTED_FRAME_ARTIFACT_CHUNK: u8 = 2;

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub(crate) enum TransportKind {
        Tcp,
        Iroh,
        Other(String),
    }

    impl TransportKind {
        pub(crate) fn from_id(transport_id: &str) -> Self {
            match transport_id.trim().to_ascii_lowercase().as_str() {
                TCP_TRANSPORT_ID | "tcp" => Self::Tcp,
                IROH_TRANSPORT_ID | "iroh" => Self::Iroh,
                _ => Self::Other(transport_id.to_string()),
            }
        }

        pub(crate) fn id(&self) -> &str {
            match self {
                Self::Tcp => TCP_TRANSPORT_ID,
                Self::Iroh => IROH_TRANSPORT_ID,
                Self::Other(transport_id) => transport_id,
            }
        }

        fn endpoint_scheme(&self) -> Option<&'static str> {
            match self {
                Self::Tcp => Some(ENDPOINT_SCHEME),
                Self::Iroh => Some(IROH_ENDPOINT_SCHEME),
                Self::Other(_) => None,
            }
        }
    }

    #[derive(Clone, Debug)]
    pub(crate) struct TransportSelection {
        pub(crate) selected: TransportKind,
        endpoint_hint: Option<String>,
        pub(crate) tcp_fallback_endpoint_hint: Option<String>,
        fallback_reason: Option<String>,
        fallback_code: Option<TransportFallbackCode>,
        attempted_transports: Vec<TransportKind>,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum TransportFallbackCode {
        MissingIrohHint,
        IrohUnavailable,
        IrohConnectFailed,
        StaleIrohHint,
    }

    impl TransportFallbackCode {
        fn as_str(self) -> &'static str {
            match self {
                Self::MissingIrohHint => "missing_iroh_hint",
                Self::IrohUnavailable => "iroh_unavailable",
                Self::IrohConnectFailed => "iroh_connect_failed",
                Self::StaleIrohHint => "stale_iroh_hint",
            }
        }
    }

    impl TransportSelection {
        pub(crate) fn single(selected: TransportKind) -> Self {
            Self {
                selected: selected.clone(),
                endpoint_hint: None,
                tcp_fallback_endpoint_hint: None,
                fallback_reason: None,
                fallback_code: None,
                attempted_transports: vec![selected],
            }
        }

        fn tcp(
            endpoint_hint: Option<String>,
            fallback_reason: Option<String>,
            fallback_code: Option<TransportFallbackCode>,
        ) -> Self {
            Self {
                selected: TransportKind::Tcp,
                endpoint_hint,
                tcp_fallback_endpoint_hint: None,
                fallback_reason,
                fallback_code,
                attempted_transports: vec![TransportKind::Tcp],
            }
        }

        fn iroh(endpoint_hint: String, tcp_fallback_endpoint_hint: Option<String>) -> Self {
            Self {
                selected: TransportKind::Iroh,
                endpoint_hint: Some(endpoint_hint),
                tcp_fallback_endpoint_hint,
                fallback_reason: None,
                fallback_code: None,
                attempted_transports: vec![TransportKind::Iroh],
            }
        }

        fn tcp_fallback(
            endpoint_hint: String,
            preferred_transport: TransportKind,
            fallback_reason: String,
            fallback_code: Option<TransportFallbackCode>,
        ) -> Self {
            Self {
                selected: TransportKind::Tcp,
                endpoint_hint: Some(endpoint_hint),
                tcp_fallback_endpoint_hint: None,
                fallback_reason: Some(fallback_reason),
                fallback_code,
                attempted_transports: vec![preferred_transport, TransportKind::Tcp],
            }
        }

        pub(crate) fn record_iroh_connect_fallback(
            &mut self,
            reason: String,
        ) -> Result<(), String> {
            let Some(endpoint_hint) = self.tcp_fallback_endpoint_hint.clone() else {
                return Err(reason);
            };
            self.selected = TransportKind::Tcp;
            self.endpoint_hint = Some(endpoint_hint);
            self.tcp_fallback_endpoint_hint = None;
            self.fallback_reason = Some(reason);
            self.fallback_code = Some(TransportFallbackCode::IrohConnectFailed);
            self.attempted_transports = vec![TransportKind::Iroh, TransportKind::Tcp];
            Ok(())
        }

        pub(crate) fn mark_stale_iroh_hint(&mut self) {
            if self.fallback_code == Some(TransportFallbackCode::IrohConnectFailed) {
                self.fallback_code = Some(TransportFallbackCode::StaleIrohHint);
            }
        }

        pub(crate) fn endpoint_hint(&self) -> Option<&str> {
            self.endpoint_hint.as_deref()
        }

        pub(crate) fn evidence(&self) -> TransportEvidence {
            TransportEvidence {
                selected_transport: self.selected.id().to_string(),
                fallback_reason: self.fallback_reason.clone(),
                fallback_code: self.fallback_code.map(|code| code.as_str().to_string()),
                attempted_transports: self
                    .attempted_transports
                    .iter()
                    .map(|transport| transport.id().to_string())
                    .collect(),
            }
        }
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub(crate) struct TransportEvidence {
        pub(crate) selected_transport: String,
        pub(crate) fallback_reason: Option<String>,
        pub(crate) fallback_code: Option<String>,
        pub(crate) attempted_transports: Vec<String>,
    }

    pub(crate) fn select_sync_transport(
        preferred_transport: Option<&str>,
        endpoint_hint: Option<&str>,
        peer_endpoint_hints: &[String],
        peer_device_id: &str,
        local_iroh_available: bool,
    ) -> Result<TransportSelection, String> {
        let tcp_endpoint_hint =
            first_transport_endpoint_hint(&TransportKind::Tcp, endpoint_hint, peer_endpoint_hints);
        let iroh_endpoint_hint =
            first_transport_endpoint_hint(&TransportKind::Iroh, endpoint_hint, peer_endpoint_hints);

        match preferred_transport.map(TransportKind::from_id) {
            Some(TransportKind::Tcp) => tcp_endpoint_hint
                .map(|hint| TransportSelection::tcp(Some(hint), None, None))
                .ok_or_else(|| {
                    format!(
                        "Trusted sync peer {peer_device_id} does not have a TuneForge TCP endpoint hint."
                    )
                }),
            Some(TransportKind::Iroh) => select_iroh_transport(
                iroh_endpoint_hint,
                tcp_endpoint_hint,
                peer_device_id,
                local_iroh_available,
                true,
            ),
            None => {
                if local_iroh_available {
                    if let Some(iroh_endpoint_hint) = iroh_endpoint_hint {
                        return Ok(TransportSelection::iroh(
                            iroh_endpoint_hint,
                            tcp_endpoint_hint,
                        ));
                    }
                    let fallback_reason = format!(
                        "Trusted sync peer {peer_device_id} does not have a TuneForge Iroh endpoint hint; using {TCP_TRANSPORT_ID}."
                    );
                    tcp_endpoint_hint
                        .map(|hint| {
                            let mut selection = TransportSelection::tcp(
                                Some(hint),
                                Some(fallback_reason),
                                Some(TransportFallbackCode::MissingIrohHint),
                            );
                            selection.attempted_transports =
                                vec![TransportKind::Iroh, TransportKind::Tcp];
                            selection
                        })
                        .ok_or_else(|| {
                            format!(
                                "Trusted sync peer {peer_device_id} does not have a TuneForge Iroh or TCP endpoint hint."
                            )
                        })
                } else {
                    let fallback_reason = format!(
                        "Iroh sync transport is not available locally; using {TCP_TRANSPORT_ID}."
                    );
                    tcp_endpoint_hint
                        .map(|hint| {
                            let mut selection = TransportSelection::tcp(
                                Some(hint),
                                Some(fallback_reason),
                                Some(TransportFallbackCode::IrohUnavailable),
                            );
                            selection.attempted_transports =
                                vec![TransportKind::Iroh, TransportKind::Tcp];
                            selection
                        })
                        .ok_or_else(|| {
                            format!(
                                "Trusted sync peer {peer_device_id} does not have a TuneForge TCP endpoint hint."
                            )
                        })
                }
            }
            Some(preferred_transport) => {
                let fallback_reason = format!(
                    "Preferred sync transport {} is not available in this build; using {}.",
                    preferred_transport.id(),
                    TCP_TRANSPORT_ID
                );
                tcp_endpoint_hint
                    .map(|hint| {
                        TransportSelection::tcp_fallback(
                            hint,
                            preferred_transport,
                            fallback_reason,
                            None,
                        )
                    })
                    .ok_or_else(|| {
                        format!(
                            "Trusted sync peer {peer_device_id} does not have a TuneForge TCP endpoint hint."
                        )
                    })
            }
        }
    }

    pub(crate) fn sync_now_selection_endpoint_hints(
        endpoint_hint: Option<&str>,
        endpoint_hints: Option<&[String]>,
        peer_endpoint_hints: &[String],
    ) -> Vec<String> {
        let mut merged = Vec::new();
        if let Some(endpoint_hint) = endpoint_hint {
            push_selection_endpoint_hint(&mut merged, endpoint_hint);
        }
        if let Some(endpoint_hints) = endpoint_hints {
            for endpoint_hint in endpoint_hints {
                push_selection_endpoint_hint(&mut merged, endpoint_hint);
            }
        }
        for endpoint_hint in peer_endpoint_hints {
            push_selection_endpoint_hint(&mut merged, endpoint_hint);
        }
        merged
    }

    fn push_selection_endpoint_hint(endpoint_hints: &mut Vec<String>, endpoint_hint: &str) {
        let endpoint_hint = endpoint_hint.trim();
        if endpoint_hint.is_empty()
            || endpoint_hints
                .iter()
                .any(|existing| existing == endpoint_hint)
        {
            return;
        }
        endpoint_hints.push(endpoint_hint.to_string());
    }

    fn select_iroh_transport(
        iroh_endpoint_hint: Option<String>,
        tcp_endpoint_hint: Option<String>,
        peer_device_id: &str,
        local_iroh_available: bool,
        explicit_preference: bool,
    ) -> Result<TransportSelection, String> {
        if local_iroh_available {
            if let Some(iroh_endpoint_hint) = iroh_endpoint_hint {
                return Ok(TransportSelection::iroh(
                    iroh_endpoint_hint,
                    tcp_endpoint_hint,
                ));
            }
            let fallback_reason = if explicit_preference {
                format!(
                    "Preferred sync transport {IROH_TRANSPORT_ID} has no trusted endpoint hint; using {TCP_TRANSPORT_ID}."
                )
            } else {
                format!(
                    "Trusted sync peer {peer_device_id} does not have a TuneForge Iroh endpoint hint; using {TCP_TRANSPORT_ID}."
                )
            };
            return tcp_endpoint_hint
                .map(|hint| {
                    TransportSelection::tcp_fallback(
                        hint,
                        TransportKind::Iroh,
                        fallback_reason,
                        Some(TransportFallbackCode::MissingIrohHint),
                    )
                })
                .ok_or_else(|| {
                    format!(
                        "Trusted sync peer {peer_device_id} does not have a TuneForge Iroh or TCP endpoint hint."
                    )
                });
        }

        let fallback_reason = if explicit_preference {
            format!(
                "Preferred sync transport {IROH_TRANSPORT_ID} is not available locally; using {TCP_TRANSPORT_ID}."
            )
        } else {
            format!("Iroh sync transport is not available locally; using {TCP_TRANSPORT_ID}.")
        };
        tcp_endpoint_hint
            .map(|hint| {
                TransportSelection::tcp_fallback(
                    hint,
                    TransportKind::Iroh,
                    fallback_reason,
                    Some(TransportFallbackCode::IrohUnavailable),
                )
            })
            .ok_or_else(|| {
                format!(
                    "Trusted sync peer {peer_device_id} does not have a TuneForge TCP endpoint hint."
                )
            })
    }

    pub(crate) fn normalized_transport_id(value: &str) -> Option<&str> {
        let value = value.trim();
        if value.is_empty() || value.eq_ignore_ascii_case("auto") {
            None
        } else {
            Some(value)
        }
    }

    fn first_transport_endpoint_hint(
        transport: &TransportKind,
        endpoint_hint: Option<&str>,
        peer_endpoint_hints: &[String],
    ) -> Option<String> {
        endpoint_hint
            .filter(|hint| {
                transport
                    .endpoint_scheme()
                    .is_some_and(|scheme| hint.starts_with(scheme))
            })
            .map(str::to_string)
            .or_else(|| first_endpoint_hint_for_transport(transport, peer_endpoint_hints))
    }

    fn first_endpoint_hint_for_transport(
        transport: &TransportKind,
        endpoint_hints: &[String],
    ) -> Option<String> {
        let endpoint_scheme = transport.endpoint_scheme()?;
        endpoint_hints
            .iter()
            .find(|hint| hint.starts_with(endpoint_scheme))
            .cloned()
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct ManifestOffer {
        pub(crate) metadata: Value,
        pub(crate) project_manifests: Vec<Value>,
        pub(crate) manifest_errors: Vec<SyncTransportManifestError>,
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct ArtifactRequest {
        pub(crate) artifact_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub(crate) project_id: Option<String>,
        pub(crate) content_sha256: String,
        pub(crate) size_bytes: u64,
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct ArtifactBatchRequest {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub(crate) batch_token: Option<String>,
        pub(crate) artifacts: Vec<ArtifactRequest>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub(crate) enum ProtocolMessage {
        AuthChallenge {
            protocol_version: String,
            device_id: String,
            session_nonce: String,
        },
        AuthProof {
            handshake_signature: Value,
        },
        EndpointHints {
            protocol_version: String,
            endpoint_hints: Vec<String>,
            observed_at: String,
        },
        ManifestOffer(ManifestOffer),
        ArtifactRequest(ArtifactRequest),
        ArtifactBatchRequest(ArtifactBatchRequest),
        ArtifactStart {
            artifact_id: String,
            content_sha256: String,
            size_bytes: u64,
        },
        ArtifactBatchStart {
            batch_token: String,
            artifact_count: u64,
        },
        ArtifactBatchCredit {
            batch_token: String,
            artifact_ids: Vec<String>,
        },
        ArtifactBatchAbort {
            batch_token: String,
            message: String,
        },
        ArtifactBatchEnd {
            batch_token: String,
        },
        ArtifactEnd {
            content_sha256: String,
            size_bytes: u64,
        },
        Status {
            run_id: String,
            phase: String,
            message: String,
            progress_at: String,
            elapsed_ms: u64,
        },
        PhaseDone {
            phase: String,
        },
        Error(ProtocolError),
    }

    impl ProtocolMessage {
        pub(crate) fn kind(&self) -> &'static str {
            match self {
                Self::AuthChallenge { .. } => "auth_challenge",
                Self::AuthProof { .. } => "auth_proof",
                Self::EndpointHints { .. } => "endpoint_hints",
                Self::ManifestOffer(_) => "manifest_offer",
                Self::ArtifactRequest(_) => "artifact_request",
                Self::ArtifactBatchRequest(_) => "artifact_batch_request",
                Self::ArtifactStart { .. } => "artifact_start",
                Self::ArtifactBatchStart { .. } => "artifact_batch_start",
                Self::ArtifactBatchCredit { .. } => "artifact_batch_credit",
                Self::ArtifactBatchAbort { .. } => "artifact_batch_abort",
                Self::ArtifactBatchEnd { .. } => "artifact_batch_end",
                Self::ArtifactEnd { .. } => "artifact_end",
                Self::Status { .. } => "status",
                Self::PhaseDone { .. } => "phase_done",
                Self::Error(_) => "error",
            }
        }
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub(crate) struct ProtocolStatusPayload {
        pub(crate) run_id: String,
        pub(crate) phase: String,
        pub(crate) message: String,
        pub(crate) progress_at: String,
        pub(crate) elapsed_ms: u64,
    }

    pub(crate) fn protocol_status_message(status: ProtocolStatusPayload) -> ProtocolMessage {
        ProtocolMessage::Status {
            run_id: status.run_id,
            phase: status.phase,
            message: status.message,
            progress_at: status.progress_at,
            elapsed_ms: status.elapsed_ms,
        }
    }

    pub(crate) fn protocol_status_payload(
        run_id: impl Into<String>,
        phase: impl Into<String>,
        message: impl Into<String>,
        progress_at: impl Into<String>,
        elapsed_ms: u64,
    ) -> ProtocolStatusPayload {
        ProtocolStatusPayload {
            run_id: run_id.into(),
            phase: phase.into(),
            message: message.into(),
            progress_at: progress_at.into(),
            elapsed_ms,
        }
    }

    pub(crate) fn split_protocol_status(
        message: ProtocolMessage,
    ) -> Result<ProtocolStatusPayload, ProtocolMessage> {
        match message {
            ProtocolMessage::Status {
                run_id,
                phase,
                message,
                progress_at,
                elapsed_ms,
            } => Ok(ProtocolStatusPayload {
                run_id,
                phase,
                message,
                progress_at,
                elapsed_ms,
            }),
            other => Err(other),
        }
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct ProtocolError {
        pub(crate) code: String,
        pub(crate) message: String,
    }

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct EncryptedChunk {
        pub(crate) message_id: u64,
        pub(crate) chunk_index: u32,
        pub(crate) chunk_count: u32,
        pub(crate) data: String,
    }

    pub(crate) enum EncryptedFrame {
        MessageChunk(EncryptedChunk),
        ArtifactChunk(Vec<u8>),
    }

    pub(crate) enum ArtifactTransferFrame {
        Chunk(Vec<u8>),
        Message(ProtocolMessage),
    }

    pub(crate) trait PeerStream: Send {
        fn read_exact(&mut self, buffer: &mut [u8]) -> io::Result<()>;
        fn write_all(&mut self, buffer: &[u8]) -> io::Result<()>;
        fn set_read_timeout(&mut self, timeout: Duration) -> io::Result<()>;
        fn tcp_abort_stream(&self) -> Option<Arc<TcpStream>> {
            None
        }
    }

    pub(crate) trait ProtocolConnection {
        fn send_message(&mut self, message: &ProtocolMessage) -> Result<(), String>;
        fn read_message(&mut self) -> Result<ProtocolMessage, String>;
        fn handshake_hash(&self) -> &str;
    }

    pub(crate) fn encode_message_chunk_frame(chunk: &EncryptedChunk) -> Result<Vec<u8>, String> {
        let payload = serde_json::to_vec(chunk)
            .map_err(|error| format!("Could not encode encrypted chunk: {error}"))?;
        let mut plaintext = Vec::with_capacity(payload.len() + 1);
        plaintext.push(ENCRYPTED_FRAME_MESSAGE_CHUNK);
        plaintext.extend_from_slice(&payload);
        Ok(plaintext)
    }

    pub(crate) fn encode_artifact_chunk_frame(chunk: &[u8]) -> Vec<u8> {
        let mut plaintext = Vec::with_capacity(chunk.len() + 1);
        plaintext.push(ENCRYPTED_FRAME_ARTIFACT_CHUNK);
        plaintext.extend_from_slice(chunk);
        plaintext
    }

    pub(crate) fn decode_encrypted_frame_plaintext(
        plaintext: &[u8],
    ) -> Result<EncryptedFrame, String> {
        let Some((&frame_type, payload)) = plaintext.split_first() else {
            return Err("Encrypted sync transport frame is empty.".to_string());
        };
        match frame_type {
            ENCRYPTED_FRAME_MESSAGE_CHUNK => {
                let chunk = serde_json::from_slice(payload)
                    .map_err(|error| format!("Could not decode encrypted chunk: {error}"))?;
                Ok(EncryptedFrame::MessageChunk(chunk))
            }
            ENCRYPTED_FRAME_ARTIFACT_CHUNK => Ok(EncryptedFrame::ArtifactChunk(payload.to_vec())),
            // v2 peers reject v1 during auth, but this keeps the error path readable.
            b'{' => {
                let chunk = serde_json::from_slice(plaintext)
                    .map_err(|error| format!("Could not decode encrypted chunk: {error}"))?;
                Ok(EncryptedFrame::MessageChunk(chunk))
            }
            _ => Err("Encrypted sync transport frame has an unsupported type.".to_string()),
        }
    }

    pub(crate) fn write_raw_frame(
        stream: &mut dyn PeerStream,
        payload: &[u8],
    ) -> Result<(), String> {
        if payload.len() > MAX_RAW_FRAME {
            return Err("Sync transport frame is too large.".to_string());
        }
        let length = (payload.len() as u32).to_be_bytes();
        stream
            .write_all(&length)
            .and_then(|_| stream.write_all(payload))
            .map_err(|error| format!("Could not write sync transport frame: {error}"))
    }

    pub(crate) fn read_raw_frame(stream: &mut dyn PeerStream) -> Result<Vec<u8>, String> {
        let mut length = [0_u8; 4];
        stream
            .read_exact(&mut length)
            .map_err(|error| read_frame_error("length", error))?;
        let length = u32::from_be_bytes(length) as usize;
        if length > MAX_RAW_FRAME {
            return Err("Sync transport frame exceeds the maximum frame size.".to_string());
        }
        let mut payload = vec![0_u8; length];
        stream
            .read_exact(&mut payload)
            .map_err(|error| read_frame_error("payload", error))?;
        Ok(payload)
    }

    fn read_frame_error(part: &str, error: io::Error) -> String {
        if matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ) {
            return "Timed out waiting for sync transport protocol progress.".to_string();
        }
        format!("Could not read sync transport frame {part}: {error}")
    }

    pub(crate) fn sync_transport_read_timed_out(error: &str) -> bool {
        error.contains("Timed out waiting for sync transport protocol progress.")
            || error.contains("Timed out reading from Iroh sync stream.")
            || error.contains("Timed out reading test peer stream.")
    }

    pub(crate) fn decode_standard_base64(value: &str) -> Result<Vec<u8>, String> {
        STANDARD
            .decode(value)
            .map_err(|error| format!("Value must be base64: {error}"))
    }

    pub(crate) fn encode_standard_base64(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    #[derive(Debug)]
    pub(crate) struct AuthenticatedSession {
        pub(crate) remote_device_id: String,
        pub(crate) remote_endpoint_hints: Vec<String>,
    }

    #[derive(Clone, Debug, Deserialize)]
    pub(crate) struct SyncLocalIdentity {
        pub(crate) device_id: String,
        pub(crate) sync_group_id: String,
        pub(crate) display_name: Option<String>,
        pub(crate) public_key: String,
    }

    #[derive(Clone, Debug, Deserialize)]
    pub(crate) struct SyncTrustedPeer {
        pub(crate) device_id: String,
        pub(crate) public_key: String,
        pub(crate) endpoint_hints: Vec<String>,
        pub(crate) revoked_at: Option<String>,
    }

    pub(crate) trait SyncTransportAuthBackend {
        fn local_identity(&self) -> Result<SyncLocalIdentity, String>;
        fn trusted_peer(&self, device_id: &str) -> Result<Option<SyncTrustedPeer>, String>;
        fn sign_transport_handshake(
            &self,
            peer_device_id: &str,
            challenge: &Value,
        ) -> Result<Value, String>;
    }

    pub(crate) fn authenticate_session(
        connection: &mut impl ProtocolConnection,
        client: &impl SyncTransportAuthBackend,
        expected_peer_device_id: Option<String>,
        local_endpoint_hints: &[String],
    ) -> Result<AuthenticatedSession, String> {
        let identity = client
            .local_identity()
            .map_err(|error| format!("Could not load local sync identity: {error}"))?;
        let local_nonce = random_nonce();
        connection.send_message(&ProtocolMessage::AuthChallenge {
            protocol_version: TRANSPORT_PROTOCOL_VERSION.to_string(),
            device_id: identity.device_id.clone(),
            session_nonce: local_nonce.clone(),
        })?;
        let (remote_device_id, remote_nonce) = match connection.read_message()? {
            ProtocolMessage::AuthChallenge {
                protocol_version,
                device_id,
                session_nonce,
            } => {
                if protocol_version != TRANSPORT_PROTOCOL_VERSION {
                    return Err(format!(
                        "Sync peer uses unsupported transport protocol version {protocol_version}."
                    ));
                }
                (device_id, session_nonce)
            }
            ProtocolMessage::Error(error) => {
                return Err(format!(
                    "Sync peer returned an auth error: {}",
                    error.message
                ));
            }
            other => {
                return Err(format!(
                    "Sync peer sent unexpected auth message: {}",
                    other.kind()
                ));
            }
        };
        if let Some(expected_peer_device_id) = expected_peer_device_id.as_deref() {
            if remote_device_id != expected_peer_device_id {
                return Err(format!(
                    "Sync peer identity mismatch: expected {expected_peer_device_id}, got {remote_device_id}."
                ));
            }
        }
        let trusted_peer = client
            .trusted_peer(&remote_device_id)
            .map_err(|error| format!("Could not verify trusted sync peer: {error}"))?
            .ok_or_else(|| format!("Sync peer {remote_device_id} is not trusted."))?;

        let local_challenge = transport_handshake_challenge(
            &remote_device_id,
            &identity.device_id,
            &remote_nonce,
            &local_nonce,
            connection.handshake_hash(),
        );
        let local_signature = client
            .sign_transport_handshake(&remote_device_id, &local_challenge)
            .map_err(|error| format!("Could not sign sync transport handshake: {error}"))?;
        connection.send_message(&ProtocolMessage::AuthProof {
            handshake_signature: local_signature,
        })?;

        let remote_signature = match connection.read_message()? {
            ProtocolMessage::AuthProof {
                handshake_signature,
            } => handshake_signature,
            ProtocolMessage::Error(error) => {
                return Err(format!(
                    "Sync peer returned an auth error: {}",
                    error.message
                ));
            }
            other => {
                return Err(format!(
                    "Sync peer sent unexpected auth proof message: {}",
                    other.kind()
                ));
            }
        };
        verify_transport_handshake_signature(
            &remote_signature,
            &trusted_peer,
            &identity.device_id,
            &remote_device_id,
            &local_nonce,
            &remote_nonce,
            connection.handshake_hash(),
        )?;

        let endpoint_hints = normalize_advisory_endpoint_hints(local_endpoint_hints.to_vec())?;
        connection.send_message(&ProtocolMessage::EndpointHints {
            protocol_version: TRANSPORT_PROTOCOL_VERSION.to_string(),
            endpoint_hints,
            observed_at: Utc::now().to_rfc3339(),
        })?;
        let remote_endpoint_hints = match connection.read_message()? {
            ProtocolMessage::EndpointHints {
                protocol_version,
                endpoint_hints,
                ..
            } => {
                if protocol_version != TRANSPORT_PROTOCOL_VERSION {
                    return Err(format!(
                        "Sync peer endpoint hints use unsupported transport protocol version {protocol_version}."
                    ));
                }
                normalize_advisory_endpoint_hints(endpoint_hints)?
            }
            ProtocolMessage::Error(error) => {
                return Err(format!(
                    "Sync peer returned an endpoint hint error: {}",
                    error.message
                ));
            }
            other => {
                return Err(format!(
                    "Sync peer sent unexpected endpoint hint message: {}",
                    other.kind()
                ));
            }
        };

        Ok(AuthenticatedSession {
            remote_device_id,
            remote_endpoint_hints,
        })
    }

    pub(crate) fn normalize_advisory_endpoint_hints(
        endpoint_hints: Vec<String>,
    ) -> Result<Vec<String>, String> {
        let mut normalized = Vec::with_capacity(endpoint_hints.len());
        for hint in endpoint_hints {
            let trimmed = hint.trim();
            if trimmed.is_empty() {
                return Err("Sync endpoint hints cannot contain empty values.".to_string());
            }
            if !normalized.iter().any(|existing| existing == trimmed) {
                normalized.push(trimmed.to_string());
            }
        }
        Ok(normalized)
    }

    pub(crate) fn transport_handshake_challenge(
        requester_device_id: &str,
        responder_device_id: &str,
        session_id: &str,
        challenge_nonce: &str,
        handshake_hash: &str,
    ) -> Value {
        let issued_at = Utc::now();
        let expires_at = issued_at + chrono::Duration::seconds(TRANSPORT_HANDSHAKE_TTL_SECONDS);
        json!({
            "protocol_version": PAIRING_PROTOCOL_VERSION,
            "challenge_type": TRANSPORT_HANDSHAKE_CHALLENGE_TYPE,
            "session_id": session_id,
            "challenge_nonce": bound_noise_nonce(challenge_nonce, handshake_hash),
            "requester_device_id": requester_device_id,
            "responder_device_id": responder_device_id,
            "issued_at": issued_at.to_rfc3339(),
            "expires_at": expires_at.to_rfc3339(),
        })
    }

    fn verify_transport_handshake_signature(
        signature_value: &Value,
        trusted_peer: &SyncTrustedPeer,
        local_device_id: &str,
        remote_device_id: &str,
        local_nonce: &str,
        remote_nonce: &str,
        handshake_hash: &str,
    ) -> Result<(), String> {
        let proof: TransportHandshakeSignature = serde_json::from_value(signature_value.clone())
            .map_err(|error| {
                format!("Sync peer transport handshake proof is malformed: {error}")
            })?;
        if proof.protocol_version != PAIRING_PROTOCOL_VERSION {
            return Err(format!(
                "Sync peer transport proof uses unsupported pairing protocol version {}.",
                proof.protocol_version
            ));
        }
        if proof.challenge_type != TRANSPORT_HANDSHAKE_CHALLENGE_TYPE {
            return Err("Sync peer transport proof has an unsupported challenge type.".to_string());
        }
        if proof.local_device_id != trusted_peer.device_id
            || proof.local_device_id != remote_device_id
            || proof.peer_device_id != local_device_id
        {
            return Err(
                "Sync peer transport proof device IDs do not match this session.".to_string(),
            );
        }
        if proof.public_key != trusted_peer.public_key {
            return Err(
                "Sync peer transport proof public key does not match trusted peer.".to_string(),
            );
        }
        let expected_device_id = derive_device_id(&proof.public_key)?;
        if expected_device_id != proof.local_device_id {
            return Err(
                "Sync peer transport proof device_id does not match its public key.".to_string(),
            );
        }
        let signed_challenge: Value = serde_json::from_str(&proof.canonical_challenge_json)
            .map_err(|error| format!("Sync peer transport proof challenge is invalid: {error}"))?;
        validate_transport_challenge(
            &signed_challenge,
            local_device_id,
            remote_device_id,
            local_nonce,
            remote_nonce,
            handshake_hash,
        )?;

        let public_key_bytes = decode_public_key(&proof.public_key)?;
        let verifying_key = VerifyingKey::from_bytes(&public_key_bytes)
            .map_err(|error| format!("Sync peer public key is invalid: {error}"))?;
        let signature_bytes = decode_urlsafe_key(&proof.signature)?;
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|error| format!("Sync peer transport proof signature is invalid: {error}"))?;
        verifying_key
            .verify(proof.canonical_challenge_json.as_bytes(), &signature)
            .map_err(|_| "Sync peer transport proof signature verification failed.".to_string())
    }

    #[derive(Clone, Debug, Deserialize)]
    struct TransportHandshakeSignature {
        protocol_version: String,
        challenge_type: String,
        local_device_id: String,
        peer_device_id: String,
        public_key: String,
        #[allow(dead_code)]
        challenge: Value,
        canonical_challenge_json: String,
        signature: String,
        #[allow(dead_code)]
        signed_at: String,
    }

    fn validate_transport_challenge(
        challenge: &Value,
        local_device_id: &str,
        remote_device_id: &str,
        local_nonce: &str,
        remote_nonce: &str,
        handshake_hash: &str,
    ) -> Result<(), String> {
        expect_json_string(challenge, "protocol_version", PAIRING_PROTOCOL_VERSION)?;
        expect_json_string(
            challenge,
            "challenge_type",
            TRANSPORT_HANDSHAKE_CHALLENGE_TYPE,
        )?;
        expect_json_string(challenge, "requester_device_id", local_device_id)?;
        expect_json_string(challenge, "responder_device_id", remote_device_id)?;
        expect_json_string(challenge, "session_id", local_nonce)?;
        expect_json_string(
            challenge,
            "challenge_nonce",
            &bound_noise_nonce(remote_nonce, handshake_hash),
        )?;
        let expires_at = json_string(challenge, "expires_at")
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc))
            .ok_or_else(|| "Sync peer transport proof expiration is invalid.".to_string())?;
        if expires_at <= Utc::now() {
            return Err("Sync peer transport proof has expired.".to_string());
        }
        Ok(())
    }

    fn bound_noise_nonce(nonce: &str, handshake_hash: &str) -> String {
        format!("{nonce}.{handshake_hash}")
    }

    fn expect_json_string(value: &Value, field: &str, expected: &str) -> Result<(), String> {
        match json_string(value, field) {
            Some(actual) if actual == expected => Ok(()),
            _ => Err(format!(
                "Sync transport challenge {field} did not match this session."
            )),
        }
    }

    fn json_string<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
        value.get(field).and_then(Value::as_str)
    }

    pub(crate) fn random_nonce() -> String {
        let mut bytes = [0_u8; 24];
        rng().fill_bytes(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    }

    pub(crate) fn sync_run_id() -> String {
        format!("sync_{}", random_nonce())
    }

    pub(crate) fn parse_endpoint_hint(
        endpoint_hint: &str,
        expected_device_id: Option<&str>,
    ) -> Result<std::net::SocketAddr, String> {
        let rest = endpoint_hint
            .strip_prefix(ENDPOINT_SCHEME)
            .ok_or_else(|| "Endpoint hint is not a TuneForge TCP URI.".to_string())?;
        let (authority, query) = rest.split_once('?').unwrap_or((rest, ""));
        if let Some(expected_device_id) = expected_device_id {
            if let Some(device_id) = query_parameter(query, "device_id") {
                if device_id != expected_device_id {
                    return Err(
                        "Endpoint hint device_id does not match the trusted peer.".to_string()
                    );
                }
            }
        }
        let socket_text = if authority.starts_with('[') {
            authority.to_string()
        } else {
            authority.to_string()
        };
        let mut addresses = std::net::ToSocketAddrs::to_socket_addrs(&socket_text)
            .map_err(|error| format!("Could not resolve sync endpoint hint: {error}"))?;
        addresses
            .next()
            .ok_or_else(|| "Sync endpoint hint did not resolve to a socket address.".to_string())
    }

    pub(crate) fn query_parameter(query: &str, key: &str) -> Option<String> {
        query_parameters(query, key).into_iter().next()
    }

    pub(crate) fn query_parameters(query: &str, key: &str) -> Vec<String> {
        query
            .split('&')
            .filter_map(|part| {
                let (part_key, value) = part.split_once('=')?;
                (part_key == key).then(|| percent_decode(value))
            })
            .collect()
    }

    pub(crate) fn decode_public_key(public_key: &str) -> Result<[u8; 32], String> {
        let decoded =
            decode_urlsafe_key(public_key.strip_prefix("ed25519:").unwrap_or(public_key))?;
        decoded
            .try_into()
            .map_err(|_| "Ed25519 public key must be 32 bytes.".to_string())
    }

    pub(crate) fn derive_device_id(public_key: &str) -> Result<String, String> {
        let public_key = decode_public_key(public_key)?;
        let digest = Sha256::digest(public_key);
        Ok(format!("dev_ed25519_{}", URL_SAFE_NO_PAD.encode(digest)))
    }

    pub(crate) fn decode_urlsafe_key(value: &str) -> Result<Vec<u8>, String> {
        URL_SAFE_NO_PAD
            .decode(value.trim().trim_end_matches('='))
            .map_err(|error| format!("Value must be URL-safe base64: {error}"))
    }

    pub(crate) fn encode_urlsafe_key(bytes: impl AsRef<[u8]>) -> String {
        URL_SAFE_NO_PAD.encode(bytes)
    }

    pub(crate) fn hex_digest(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
        output
    }

    pub(crate) fn percent_encode_path_segment(value: &str) -> String {
        percent_encode(value)
    }

    pub(crate) fn percent_encode_query_value(value: &str) -> String {
        percent_encode(value)
    }

    fn percent_encode(value: &str) -> String {
        let mut encoded = String::new();
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        encoded
    }

    pub(crate) fn percent_decode(value: &str) -> String {
        let mut bytes = Vec::with_capacity(value.len());
        let raw = value.as_bytes();
        let mut index = 0;
        while index < raw.len() {
            if raw[index] == b'%' && index + 2 < raw.len() {
                if let Ok(hex) = std::str::from_utf8(&raw[index + 1..index + 3]) {
                    if let Ok(byte) = u8::from_str_radix(hex, 16) {
                        bytes.push(byte);
                        index += 3;
                        continue;
                    }
                }
            }
            bytes.push(raw[index]);
            index += 1;
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

mod desktop {
    use super::{
        sync_core::*, SyncTransportActiveProgress, SyncTransportDiagnostics,
        SyncTransportLifecycleEvent, SyncTransportLifecycleEventRequest,
        SyncTransportManifestError, SyncTransportNearbyPeer, SyncTransportPairingOffer,
        SyncTransportPairingOfferRequest, SyncTransportProjectResult,
        SyncTransportStartListenerRequest, SyncTransportStatus, SyncTransportSyncNowRequest,
        SyncTransportSyncResult, SyncTransportTimingEvidence, SyncTransportTransferCounts,
        SyncTransportTransferResult,
    };
    use chrono::{DateTime, Utc};
    use iroh::{
        endpoint::{
            presets, BindOpts, Connection, QuicTransportConfig, RecvStream, SendStream, VarInt,
        },
        Endpoint, EndpointAddr, EndpointId, SecretKey,
    };
    use iroh_blobs::store::fs::FsStore;
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use snow::{params::NoiseParams, Builder};
    #[cfg(not(target_os = "android"))]
    use std::io::{BufRead, BufReader};
    use std::{
        collections::{BTreeMap, HashMap, HashSet, VecDeque},
        env,
        fs::{self, File},
        io::{self, Read, Write},
        net::{
            IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream,
            ToSocketAddrs, UdpSocket,
        },
        path::{Path, PathBuf},
        process,
        str::FromStr,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc, Mutex,
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    #[cfg(target_os = "android")]
    use tauri::Manager;
    use tauri::{AppHandle, State};

    const DEFAULT_BIND_HOST: &str = "0.0.0.0";
    const DEFAULT_LISTENER_PORT: u16 = 47619;
    const IROH_LISTENER_PORT_OFFSET: u16 = 1;
    const DISCOVERY_PROTOCOL_VERSION: &str = "tuneforge-sync-discovery-v1";
    const DISCOVERY_PORT: u16 = 47621;
    const DISCOVERY_BEACON_INTERVAL: Duration = Duration::from_secs(5);
    const DISCOVERY_PEER_TTL: Duration = Duration::from_secs(60);
    const DISCOVERY_SOCKET_TIMEOUT: Duration = Duration::from_millis(250);
    const DISCOVERY_MAX_PACKET_BYTES: usize = 8192;
    const IROH_ALPN: &[u8] = b"tuneforge-sync/iroh/v1";
    const IROH_ARTIFACT_PARALLELISM: usize = 4;
    const IROH_ARTIFACT_RECEIVE_BYTE_BUDGET: u64 = 4 * 1024 * 1024 * 1024;
    const IROH_ARTIFACT_STAGING_QUEUE_CAPACITY: usize = IROH_ARTIFACT_PARALLELISM * 2;
    const IROH_BATCH_CONTROL_POLL_INTERVAL: Duration = Duration::from_millis(100);
    const IROH_MISSING_STREAM_AFTER_CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
    const IROH_DATA_HEADER_MAX_BYTES: usize = 16 * 1024;
    const IROH_ARTIFACT_RECEIVE_CANCELLED: &str =
        "Iroh artifact stream receive was cancelled after batch control stopped the transfer.";
    const UNAVAILABLE_ARTIFACT_TRANSFER_MESSAGE: &str =
        "Requested artifact content is unavailable from the peer.";
    const IROH_ARTIFACT_UNAVAILABLE_CONTENT_SHA256: &str = "artifact_unavailable";
    const IROH_STREAM_RECEIVE_WINDOW_BYTES: u32 = 32 * 1024 * 1024;
    const IROH_CONNECTION_RECEIVE_WINDOW_BYTES: u32 = 128 * 1024 * 1024;
    const IROH_SEND_WINDOW_BYTES: u64 = 64 * 1024 * 1024;
    const IROH_INITIAL_RTT: Duration = Duration::from_millis(20);
    const NOISE_PATTERN: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
    const RECONCILIATION_PLAN_MANIFEST_CHUNK_SIZE: usize = 24;
    const RECONCILIATION_PLAN_DELETE_CHUNK_SIZE: usize = 24;
    const LOCAL_MANIFEST_EXPORT_BATCH_SIZE: usize = 24;
    const RECONCILIATION_APPLY_BATCH_SIZE: usize = 24;
    const RECONCILIATION_APPLY_BATCH_COALESCE_TIMEOUT: Duration = Duration::from_millis(10);
    const READ_TIMEOUT: Duration = Duration::from_secs(45);
    const PROTOCOL_WATCHDOG_TIMEOUT: Duration = Duration::from_secs(75);
    const STATUS_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
    const WRITE_TIMEOUT: Duration = Duration::from_secs(45);
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    const ACCEPT_SLEEP: Duration = Duration::from_millis(100);
    const NOT_STARTED_TRANSPORT_ID: &str = "not_started";
    const BACKEND_PREFLIGHT_UNRESPONSIVE_CODE: &str = "backend_preflight_unresponsive";
    const BACKEND_BUSY_CODE: &str = "backend_busy";
    const LIBRARY_PREFLIGHT_FAILED_CODE: &str = "library_preflight_failed";
    const BACKEND_PREFLIGHT_UNRESPONSIVE_MESSAGE: &str = "Local backend is unresponsive during sync preflight. Wait for backend work to finish or restart TuneForge, then retry sync.";
    const BACKEND_BUSY_RETRY_GUIDANCE: &str =
        "Wait for those jobs to finish or cancel them, then retry sync.";
    const LIFECYCLE_EVENT_HISTORY_LIMIT: usize = 20;
    const LIFECYCLE_INTERRUPTION_DEFAULT_GUIDANCE: &str =
        "Restore the device state, then retry sync.";
    const LIFECYCLE_INTERRUPTION_NETWORK_GUIDANCE: &str =
        "Restore network connectivity, then retry sync.";
    const LIFECYCLE_INTERRUPTION_FOREGROUND_GUIDANCE: &str =
        "Bring TuneForge back to the foreground, then retry sync.";
    #[cfg(not(target_os = "android"))]
    const HTTP_TIMEOUT: Duration = Duration::from_secs(45);
    #[cfg(not(target_os = "android"))]
    const MANIFEST_EXPORT_HTTP_TIMEOUT: Duration = Duration::from_secs(300);
    #[cfg(not(target_os = "android"))]
    const BACKEND_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(3);

    #[derive(Clone)]
    pub struct SyncTransportState {
        backend: BackendAccess,
        listener: Arc<Mutex<Option<ListenerHandle>>>,
        shared_status: Arc<Mutex<SharedStatus>>,
    }

    impl SyncTransportState {
        pub fn new(base_url: String, app: AppHandle) -> Self {
            Self {
                backend: BackendAccess { base_url, app },
                listener: Arc::new(Mutex::new(None)),
                shared_status: Arc::new(Mutex::new(SharedStatus::default())),
            }
        }

        fn start_listener(
            &self,
            payload: SyncTransportStartListenerRequest,
        ) -> Result<SyncTransportStatus, String> {
            {
                let guard = self
                    .listener
                    .lock()
                    .map_err(|_| "Sync transport listener state is unavailable.".to_string())?;
                if guard.is_some() {
                    return Ok(self.status());
                }
            }

            let client = BackendClient::new(&self.backend)?;
            let identity = client
                .local_identity()
                .map_err(|error| format!("Could not load local sync identity: {error}"))?;
            let bind_host = payload
                .bind_host
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(DEFAULT_BIND_HOST)
                .to_string();
            let port = payload.port.unwrap_or(DEFAULT_LISTENER_PORT);
            let listener = TcpListener::bind((bind_host.as_str(), port)).map_err(|error| {
                format!("Could not bind sync transport listener on {bind_host}:{port}: {error}")
            })?;
            listener
                .set_nonblocking(true)
                .map_err(|error| format!("Could not configure sync transport listener: {error}"))?;
            let bind_addr = listener
                .local_addr()
                .map_err(|error| format!("Could not inspect sync transport listener: {error}"))?;
            let tcp_endpoint_hints = endpoint_hints_for_port(bind_addr.port(), &identity.device_id);
            let iroh_transport =
                match create_iroh_transport(&self.backend, &identity.device_id, bind_addr.port()) {
                    Ok(transport) => Some(transport),
                    Err(error) => {
                        update_status(&self.shared_status, |status| {
                            status.last_status = Some(format!(
                            "Iroh sync transport unavailable; starting TCP listener only: {error}"
                        ));
                        });
                        None
                    }
                };
            let mut endpoint_hints = iroh_transport
                .as_ref()
                .map(|transport| iroh_endpoint_hints(transport, &identity.device_id))
                .unwrap_or_default();
            endpoint_hints.extend(tcp_endpoint_hints);
            let stop = Arc::new(AtomicBool::new(false));
            let tcp_stop = Arc::clone(&stop);
            let backend = self.backend.clone();
            let shared_status = Arc::clone(&self.shared_status);
            let tcp_endpoint_hints_for_sessions = endpoint_hints.clone();
            let tcp_thread = thread::spawn(move || {
                accept_loop(
                    listener,
                    backend,
                    tcp_stop,
                    shared_status,
                    tcp_endpoint_hints_for_sessions,
                );
            });
            let iroh_thread = iroh_transport.as_ref().map(|transport| {
                let transport = transport.clone();
                let backend = self.backend.clone();
                let shared_status = Arc::clone(&self.shared_status);
                let iroh_stop = Arc::clone(&stop);
                let endpoint_hints = endpoint_hints.clone();
                thread::spawn(move || {
                    iroh_accept_loop(transport, backend, iroh_stop, shared_status, endpoint_hints);
                })
            });
            let mut discovery_error = None;
            let discovery_thread = match start_discovery(
                identity,
                endpoint_hints.clone(),
                Arc::clone(&self.shared_status),
                Arc::clone(&stop),
            ) {
                Ok(thread) => Some(thread),
                Err(error) => {
                    discovery_error = Some(error);
                    None
                }
            };

            let handle = ListenerHandle {
                bind_addr,
                endpoint_hints,
                iroh_transport,
                stop,
                tcp_thread: Some(tcp_thread),
                iroh_thread,
                discovery_thread,
            };
            {
                let mut guard = self
                    .listener
                    .lock()
                    .map_err(|_| "Sync transport listener state is unavailable.".to_string())?;
                *guard = Some(handle);
            }
            update_status(&self.shared_status, |status| {
                status.last_status = Some(match discovery_error {
                    Some(error) => {
                        format!(
                            "Sync transport listener started; sync discovery unavailable: {error}"
                        )
                    }
                    None => "Sync transport listener started.".to_string(),
                });
                status.last_error = None;
                status.last_sync = None;
                status.active_progress = None;
                status.active_progress_owner_run_id = None;
                clear_retryable_interruption(status);
            });

            Ok(self.status())
        }

        fn stop_listener(&self) -> Result<SyncTransportStatus, String> {
            let listener = {
                let mut guard = self
                    .listener
                    .lock()
                    .map_err(|_| "Sync transport listener state is unavailable.".to_string())?;
                guard.take()
            };

            if let Some(mut listener) = listener {
                listener.stop.store(true, Ordering::SeqCst);
                if let Some(iroh_transport) = listener.iroh_transport.take() {
                    iroh_transport.close();
                }
                if let Some(thread) = listener.tcp_thread.take() {
                    thread
                        .join()
                        .map_err(|_| "Sync transport listener thread panicked.".to_string())?;
                }
                if let Some(thread) = listener.iroh_thread.take() {
                    thread
                        .join()
                        .map_err(|_| "Iroh sync transport listener thread panicked.".to_string())?;
                }
                if let Some(thread) = listener.discovery_thread.take() {
                    thread
                        .join()
                        .map_err(|_| "Sync discovery listener thread panicked.".to_string())?;
                }
                update_status(&self.shared_status, |status| {
                    status.last_status = Some("Sync transport listener stopped.".to_string());
                    status.nearby_peers.clear();
                    status.active_progress = None;
                    status.active_progress_owner_run_id = None;
                });
            }

            Ok(self.status())
        }

        pub fn shutdown(&self) {
            let _ = self.stop_listener();
        }

        fn status(&self) -> SyncTransportStatus {
            let shared = self
                .shared_status
                .lock()
                .map(|mut status| {
                    prune_nearby_peers(&mut status, Instant::now());
                    status.clone()
                })
                .unwrap_or_default();
            let listener = self.listener.lock().ok();
            let listener = listener.as_ref().and_then(|guard| guard.as_ref());

            SyncTransportStatus {
                supported: true,
                running: listener.is_some(),
                bind_host: listener.map(|handle| handle.bind_addr.ip().to_string()),
                port: listener.map(|handle| handle.bind_addr.port()),
                endpoint_hints: listener
                    .map(|handle| handle.endpoint_hints.clone())
                    .unwrap_or_default(),
                nearby_peers: nearby_peers_from_status(shared.nearby_peers.clone()),
                active_sessions: shared.active_sessions,
                accepted_sessions: shared.accepted_sessions,
                failed_sessions: shared.failed_sessions,
                last_status: shared.last_status,
                last_error: shared.last_error,
                last_sync: shared.last_sync,
                active_progress: shared.active_progress,
                last_lifecycle_event: shared.last_lifecycle_event,
                lifecycle_events: shared.lifecycle_events,
                retryable_interruption_code: shared.retryable_interruption_code,
                retryable_interruption_peer_device_id: shared.retryable_interruption_peer_device_id,
                retry_guidance: shared.retry_guidance,
            }
        }

        fn record_lifecycle_event(
            &self,
            payload: SyncTransportLifecycleEventRequest,
        ) -> SyncTransportStatus {
            let outcome = self
                .shared_status
                .lock()
                .map(|mut status| record_lifecycle_event_in_status(&mut status, payload))
                .unwrap_or_else(|_| LifecycleRecordOutcome::default());

            if outcome.refresh_endpoint_hints {
                self.refresh_listener_endpoint_hints();
            }

            interrupt_active_runs_for_lifecycle(&outcome.event, outcome.interrupted_runs);

            self.status()
        }

        fn create_pairing_offer(
            &self,
            payload: SyncTransportPairingOfferRequest,
        ) -> Result<SyncTransportPairingOffer, String> {
            let status = self.status();
            if !status.running || status.endpoint_hints.is_empty() {
                return Err(
                    "Start the sync transport listener before creating a LAN pairing offer."
                        .to_string(),
                );
            }
            let ttl_seconds = payload.ttl_seconds.unwrap_or(PAIRING_OFFER_TTL_SECONDS);
            let client = BackendClient::new(&self.backend)?;
            let pairing_offer = client
                .create_pairing_offer(status.endpoint_hints.clone(), ttl_seconds)
                .map_err(|error| format!("Could not create sync pairing offer: {error}"))?;
            Ok(SyncTransportPairingOffer {
                endpoint_hints: status.endpoint_hints,
                pairing_offer,
            })
        }

        fn sync_now(
            &self,
            payload: SyncTransportSyncNowRequest,
        ) -> Result<SyncTransportSyncResult, String> {
            let run_id = sync_run_id();
            let run_cancel = register_active_run(
                &self.shared_status,
                &run_id,
                Some(payload.peer_device_id.clone()),
            );
            let result = self.run_sync_now(payload, run_id.clone(), run_cancel);
            update_status(&self.shared_status, |status| {
                apply_sync_now_status_result(status, &result, &run_id);
            });
            result.map_err(|failure| failure.sync_result.message)
        }

        fn run_sync_now(
            &self,
            payload: SyncTransportSyncNowRequest,
            run_id: String,
            run_cancel: RunCancellationToken,
        ) -> Result<SyncTransportSyncResult, SyncNowHardFailure> {
            let run_started_at = Utc::now();
            let run_started_instant = Instant::now();
            let requested_peer_device_id = payload.peer_device_id.clone();
            record_active_progress(
                &self.shared_status,
                &run_id,
                active_progress(protocol_status_payload(
                    run_id.clone(),
                    "backend_preflight",
                    "Checking local backend readiness before sync.",
                    Utc::now().to_rfc3339(),
                    0,
                )),
            );
            let mut timings = Vec::new();
            let mut metrics = SyncRunMetrics::start(run_started_instant);
            if let Some(interruption) = run_cancel.interruption() {
                let lifecycle_events =
                    lifecycle_events_for_interruption(&self.shared_status, &run_id, &interruption);
                return Ok(lifecycle_interrupted_sync_result(
                    run_id.clone(),
                    requested_peer_device_id.clone(),
                    requested_peer_device_id,
                    NOT_STARTED_TRANSPORT_ID.to_string(),
                    Vec::new(),
                    interruption,
                    lifecycle_events,
                    run_started_at,
                    run_started_instant,
                    Vec::new(),
                    0,
                    metrics,
                    timings,
                ));
            }
            let client = BackendClient::new(&self.backend).map_err(|error| {
                sync_now_hard_failure(
                    error,
                    &run_id,
                    &requested_peer_device_id,
                    &requested_peer_device_id,
                    not_started_transport_evidence(),
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &timings,
                    0,
                    0,
                    Vec::new(),
                )
            })?;
            let preflight = match client.sync_preflight() {
                Ok(preflight) => preflight,
                Err(_) => {
                    if let Some(result) = lifecycle_interrupted_sync_result_for_run(
                        &self.shared_status,
                        &run_cancel,
                        &run_id,
                        &requested_peer_device_id,
                        &requested_peer_device_id,
                        NOT_STARTED_TRANSPORT_ID,
                        Vec::new(),
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &timings,
                    ) {
                        return Ok(result);
                    }
                    return Ok(failed_preflight_sync_result(
                        run_id,
                        payload.peer_device_id,
                        BACKEND_PREFLIGHT_UNRESPONSIVE_CODE,
                        BACKEND_PREFLIGHT_UNRESPONSIVE_MESSAGE.to_string(),
                        run_started_at,
                        run_started_instant,
                    ));
                }
            };
            if let Some(failure) = sync_preflight_failure(&preflight) {
                if let Some(result) = lifecycle_interrupted_sync_result_for_run(
                    &self.shared_status,
                    &run_cancel,
                    &run_id,
                    &requested_peer_device_id,
                    &requested_peer_device_id,
                    NOT_STARTED_TRANSPORT_ID,
                    Vec::new(),
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &timings,
                ) {
                    return Ok(result);
                }
                return Ok(failed_preflight_sync_result(
                    run_id,
                    payload.peer_device_id,
                    failure.fallback_code,
                    failure.message,
                    run_started_at,
                    run_started_instant,
                ));
            }
            if client.sync_metadata_preflight_probe().is_err() {
                let failure = sync_endpoint_unresponsive_failure(&preflight);
                if let Some(result) = lifecycle_interrupted_sync_result_for_run(
                    &self.shared_status,
                    &run_cancel,
                    &run_id,
                    &requested_peer_device_id,
                    &requested_peer_device_id,
                    NOT_STARTED_TRANSPORT_ID,
                    Vec::new(),
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &timings,
                ) {
                    return Ok(result);
                }
                return Ok(failed_preflight_sync_result(
                    run_id,
                    payload.peer_device_id,
                    failure.fallback_code,
                    failure.message,
                    run_started_at,
                    run_started_instant,
                ));
            }
            record_active_progress(
                &self.shared_status,
                &run_id,
                active_progress(protocol_status_payload(
                    run_id.clone(),
                    "peer_connect",
                    "Connecting to sync peer.",
                    Utc::now().to_rfc3339(),
                    duration_millis(run_started_instant.elapsed()),
                )),
            );
            let peer = client
                .trusted_peer(&payload.peer_device_id)
                .map_err(|error| format!("Could not load trusted sync peer: {error}"))
                .and_then(|peer| {
                    peer.ok_or_else(|| {
                        format!(
                            "Trusted sync peer {} is not known or has been revoked.",
                            payload.peer_device_id
                        )
                    })
                })
                .map_err(|error| {
                    sync_now_hard_failure(
                        error,
                        &run_id,
                        &requested_peer_device_id,
                        &requested_peer_device_id,
                        not_started_transport_evidence(),
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &timings,
                        0,
                        0,
                        Vec::new(),
                    )
                })?;
            let preferred_transport = payload
                .preferred_transport
                .as_deref()
                .and_then(normalized_transport_id);
            let local_iroh = self.local_iroh_transport();
            let selection_endpoint_hints = sync_now_selection_endpoint_hints(
                payload.endpoint_hint.as_deref(),
                payload.endpoint_hints.as_deref(),
                &peer.endpoint_hints,
            );
            let transport_selection = select_sync_transport(
                preferred_transport,
                None,
                &selection_endpoint_hints,
                &payload.peer_device_id,
                local_iroh.is_some(),
            )
            .map_err(|error| {
                sync_now_hard_failure(
                    error,
                    &run_id,
                    &requested_peer_device_id,
                    &requested_peer_device_id,
                    not_started_transport_evidence(),
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &timings,
                    0,
                    0,
                    Vec::new(),
                )
            })?;
            let mut transport_selection = transport_selection;
            let timer = SyncPhaseTimer::start("peer_connect");
            let mut connection = match connect_selected_transport(
                &mut transport_selection,
                local_iroh,
                &payload.peer_device_id,
            ) {
                Ok(connection) => connection,
                Err(error) => {
                    let transport_evidence = transport_selection.evidence();
                    if let Some(result) = lifecycle_interrupted_sync_result_for_run(
                        &self.shared_status,
                        &run_cancel,
                        &run_id,
                        &requested_peer_device_id,
                        &requested_peer_device_id,
                        &transport_evidence.selected_transport,
                        transport_evidence.attempted_transports.clone(),
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &timings,
                    ) {
                        return Ok(result);
                    }
                    let mut failure_timings = timings.clone();
                    failure_timings.push(timer.finish());
                    return Err(sync_now_hard_failure(
                        error,
                        &run_id,
                        &requested_peer_device_id,
                        &requested_peer_device_id,
                        transport_evidence,
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &failure_timings,
                        0,
                        0,
                        Vec::new(),
                    ));
                }
            };
            timings.push(timer.finish());

            let timer = SyncPhaseTimer::start("peer_authentication");
            let local_endpoint_hints = self.current_endpoint_hints();
            let session = match authenticate_session(
                &mut connection,
                &client,
                Some(payload.peer_device_id.clone()),
                &local_endpoint_hints,
            )
            .map_err(|error| phase_context_error("peer authentication", error))
            {
                Ok(session) => session,
                Err(error) => {
                    let transport_evidence = transport_selection.evidence();
                    if let Some(result) = lifecycle_interrupted_sync_result_for_run(
                        &self.shared_status,
                        &run_cancel,
                        &run_id,
                        &requested_peer_device_id,
                        &requested_peer_device_id,
                        &transport_evidence.selected_transport,
                        transport_evidence.attempted_transports.clone(),
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &timings,
                    ) {
                        return Ok(result);
                    }
                    let mut failure_timings = timings.clone();
                    failure_timings.push(timer.finish());
                    return Err(sync_now_hard_failure(
                        error,
                        &run_id,
                        &requested_peer_device_id,
                        &requested_peer_device_id,
                        transport_evidence,
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &failure_timings,
                        0,
                        0,
                        Vec::new(),
                    ));
                }
            };
            if let Err(error) = connection.set_established_read_timeout() {
                let transport_evidence = transport_selection.evidence();
                let failure_timings = sync_now_failure_timings_with_finished_timer(&timings, timer);
                return Err(sync_now_hard_failure(
                    error,
                    &run_id,
                    &requested_peer_device_id,
                    &session.remote_device_id,
                    transport_evidence,
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &failure_timings,
                    0,
                    0,
                    Vec::new(),
                ));
            }
            timings.push(timer.finish());
            let connection = SharedPeerConnection::new(connection);
            attach_active_run_connection(&self.shared_status, &run_id, connection.clone());
            let progress = ProgressReporter::new(
                run_id.clone(),
                run_started_instant,
                Arc::clone(&self.shared_status),
                connection.clone(),
                run_cancel.clone(),
            );
            let TransportEvidence {
                selected_transport: current_transport,
                attempted_transports: current_attempted_transports,
                ..
            } = transport_selection.evidence();
            if let Some(result) = lifecycle_interrupted_sync_result_for_run(
                &self.shared_status,
                &run_cancel,
                &run_id,
                &requested_peer_device_id,
                &session.remote_device_id,
                &current_transport,
                current_attempted_transports,
                &run_started_at,
                run_started_instant,
                &[],
                0,
                &metrics,
                &timings,
            ) {
                return Ok(result);
            }
            let mut refreshed_endpoint_hints_after_auth = false;
            if authenticated_hints_make_trusted_iroh_hint_stale(
                &peer.endpoint_hints,
                &session.remote_endpoint_hints,
            ) {
                transport_selection.mark_stale_iroh_hint();
                refresh_authenticated_endpoint_hints(
                    &client,
                    &session.remote_device_id,
                    &session.remote_endpoint_hints,
                );
                refreshed_endpoint_hints_after_auth = true;
            }

            let timer = SyncPhaseTimer::start("local_manifest_export");
            let local_offer = {
                let _progress = progress
                    .start_phase("local_manifest_export", "Exporting local sync manifests.");
                load_local_manifest_offer(
                    &client,
                    payload.project_ids.as_deref(),
                    payload.export_local,
                )
            };
            timings.push(timer.finish());
            let local_manifest_count = local_offer.project_manifests.len();
            let timer = SyncPhaseTimer::start("manifest_exchange");
            if let Err(error) = connection.send_message_for_phase(
                "manifest exchange",
                &ProtocolMessage::ManifestOffer(local_offer.clone()),
            ) {
                let transport_evidence = transport_selection.evidence();
                if let Some(result) = lifecycle_interrupted_sync_result_for_run(
                    &self.shared_status,
                    &run_cancel,
                    &run_id,
                    &requested_peer_device_id,
                    &session.remote_device_id,
                    &transport_evidence.selected_transport,
                    transport_evidence.attempted_transports.clone(),
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &timings,
                ) {
                    return Ok(result);
                }
                let mut failure_timings = timings.clone();
                failure_timings.push(timer.finish());
                return Err(sync_now_hard_failure(
                    error,
                    &run_id,
                    &requested_peer_device_id,
                    &session.remote_device_id,
                    transport_evidence,
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &failure_timings,
                    local_manifest_count,
                    0,
                    Vec::new(),
                ));
            }
            let remote_message = match connection
                .read_message_accepting_status_for_phase("manifest exchange", &progress)
            {
                Ok(message) => message,
                Err(error) => {
                    let transport_evidence = transport_selection.evidence();
                    if let Some(result) = lifecycle_interrupted_sync_result_for_run(
                        &self.shared_status,
                        &run_cancel,
                        &run_id,
                        &requested_peer_device_id,
                        &session.remote_device_id,
                        &transport_evidence.selected_transport,
                        transport_evidence.attempted_transports.clone(),
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &timings,
                    ) {
                        return Ok(result);
                    }
                    let mut failure_timings = timings.clone();
                    failure_timings.push(timer.finish());
                    return Err(sync_now_hard_failure(
                        error,
                        &run_id,
                        &requested_peer_device_id,
                        &session.remote_device_id,
                        transport_evidence,
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &failure_timings,
                        local_manifest_count,
                        0,
                        Vec::new(),
                    ));
                }
            };
            let remote_offer = match remote_message {
                ProtocolMessage::ManifestOffer(offer) => offer,
                ProtocolMessage::Error(error) => {
                    let error = phase_context_error(
                        "manifest exchange",
                        format!("Sync peer returned an error: {}", error.message),
                    );
                    let transport_evidence = transport_selection.evidence();
                    let mut failure_timings = timings.clone();
                    failure_timings.push(timer.finish());
                    return Err(sync_now_hard_failure(
                        error,
                        &run_id,
                        &requested_peer_device_id,
                        &session.remote_device_id,
                        transport_evidence,
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &failure_timings,
                        local_manifest_count,
                        0,
                        Vec::new(),
                    ));
                }
                other => {
                    let error = format!(
                        "Sync peer sent unexpected message during manifest exchange: {}",
                        other.kind()
                    );
                    let transport_evidence = transport_selection.evidence();
                    let mut failure_timings = timings.clone();
                    failure_timings.push(timer.finish());
                    return Err(sync_now_hard_failure(
                        error,
                        &run_id,
                        &requested_peer_device_id,
                        &session.remote_device_id,
                        transport_evidence,
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &failure_timings,
                        local_manifest_count,
                        0,
                        Vec::new(),
                    ));
                }
            };
            timings.push(timer.finish());

            let mut prepared_remote_import = None;
            let mut received_artifacts = Vec::new();
            if payload.import_remote {
                let transport_id = connection.transport_id();
                let prepared = stage_remote_manifest_artifacts(
                    &client,
                    &connection,
                    &session.remote_device_id,
                    &remote_offer.metadata,
                    &remote_offer.project_manifests,
                    transport_id,
                    &mut metrics,
                    &mut timings,
                    &progress,
                );
                received_artifacts = prepared.received_artifacts.clone();
                prepared_remote_import = Some(prepared);
            }
            if let Some(interruption) = run_cancel.interruption() {
                finish_staged_remote_import_for_failure(prepared_remote_import);
                let TransportEvidence {
                    selected_transport,
                    attempted_transports,
                    ..
                } = transport_selection.evidence();
                let lifecycle_events =
                    lifecycle_events_for_interruption(&self.shared_status, &run_id, &interruption);
                return Ok(lifecycle_interrupted_sync_result(
                    run_id.clone(),
                    requested_peer_device_id,
                    session.remote_device_id,
                    selected_transport,
                    attempted_transports,
                    interruption,
                    lifecycle_events,
                    run_started_at,
                    run_started_instant,
                    received_artifacts,
                    0,
                    metrics,
                    timings,
                ));
            }
            if let Err(error) = connection.send_message_for_phase(
                "reconciliation staging",
                &ProtocolMessage::PhaseDone {
                    phase: "initiator_import".to_string(),
                },
            ) {
                finish_staged_remote_import_for_failure(prepared_remote_import);
                let transport_evidence = transport_selection.evidence();
                if let Some(result) = lifecycle_interrupted_sync_result_for_run(
                    &self.shared_status,
                    &run_cancel,
                    &run_id,
                    &requested_peer_device_id,
                    &session.remote_device_id,
                    &transport_evidence.selected_transport,
                    transport_evidence.attempted_transports.clone(),
                    &run_started_at,
                    run_started_instant,
                    &received_artifacts,
                    0,
                    &metrics,
                    &timings,
                ) {
                    return Ok(result);
                }
                return Err(sync_now_hard_failure(
                    error,
                    &run_id,
                    &requested_peer_device_id,
                    &session.remote_device_id,
                    transport_evidence,
                    &run_started_at,
                    run_started_instant,
                    &received_artifacts,
                    0,
                    &metrics,
                    &timings,
                    local_manifest_count,
                    remote_offer.project_manifests.len(),
                    sync_manifest_errors(
                        &local_offer.manifest_errors,
                        &remote_offer.manifest_errors,
                    ),
                ));
            }
            let timer = SyncPhaseTimer::start("serve_artifact_requests");
            let served_artifact_requests = match serve_artifact_requests_until_done(
                &client,
                &connection,
                &local_offer.project_manifests,
                &mut metrics,
                &progress,
            ) {
                Ok(served_artifact_requests) => served_artifact_requests,
                Err(error) => {
                    finish_staged_remote_import_for_failure(prepared_remote_import);
                    let transport_evidence = transport_selection.evidence();
                    if let Some(result) = lifecycle_interrupted_sync_result_for_run(
                        &self.shared_status,
                        &run_cancel,
                        &run_id,
                        &requested_peer_device_id,
                        &session.remote_device_id,
                        &transport_evidence.selected_transport,
                        transport_evidence.attempted_transports.clone(),
                        &run_started_at,
                        run_started_instant,
                        &received_artifacts,
                        0,
                        &metrics,
                        &timings,
                    ) {
                        return Ok(result);
                    }
                    let mut failure_timings = timings.clone();
                    failure_timings.push(timer.finish());
                    return Err(sync_now_hard_failure(
                        error,
                        &run_id,
                        &requested_peer_device_id,
                        &session.remote_device_id,
                        transport_evidence,
                        &run_started_at,
                        run_started_instant,
                        &received_artifacts,
                        0,
                        &metrics,
                        &failure_timings,
                        local_manifest_count,
                        remote_offer.project_manifests.len(),
                        sync_manifest_errors(
                            &local_offer.manifest_errors,
                            &remote_offer.manifest_errors,
                        ),
                    ));
                }
            };
            timings.push(timer.finish());
            if let Some(interruption) = run_cancel.interruption() {
                finish_staged_remote_import_for_failure(prepared_remote_import);
                let TransportEvidence {
                    selected_transport,
                    attempted_transports,
                    ..
                } = transport_selection.evidence();
                let lifecycle_events =
                    lifecycle_events_for_interruption(&self.shared_status, &run_id, &interruption);
                return Ok(lifecycle_interrupted_sync_result(
                    run_id.clone(),
                    requested_peer_device_id,
                    session.remote_device_id,
                    selected_transport,
                    attempted_transports,
                    interruption,
                    lifecycle_events,
                    run_started_at,
                    run_started_instant,
                    received_artifacts,
                    served_artifact_requests,
                    metrics,
                    timings,
                ));
            }
            let imported_projects = prepared_remote_import
                .map(|prepared| finish_staged_remote_import(prepared, &mut timings))
                .unwrap_or_default();
            let import_counts = import_outcome_counts(&imported_projects);
            let manifest_errors =
                sync_manifest_errors(&local_offer.manifest_errors, &remote_offer.manifest_errors);
            let completed_at = Utc::now();
            let duration_ms = duration_millis(run_started_instant.elapsed());
            let transfer_counts = transfer_counts(&received_artifacts);
            let project_results = imported_projects.clone();
            let TransportEvidence {
                selected_transport,
                fallback_reason,
                fallback_code,
                attempted_transports,
            } = transport_selection.evidence();
            if !refreshed_endpoint_hints_after_auth {
                refresh_authenticated_endpoint_hints(
                    &client,
                    &session.remote_device_id,
                    &session.remote_endpoint_hints,
                );
            }

            Ok(SyncTransportSyncResult {
                run_id,
                peer_device_id: payload.peer_device_id,
                remote_device_id: session.remote_device_id,
                status: sync_result_status(&manifest_errors, import_counts.failed),
                message: sync_result_message(
                    local_manifest_count,
                    remote_offer.project_manifests.len(),
                    &transfer_counts,
                    import_counts,
                ),
                selected_transport,
                fallback_reason,
                fallback_code,
                attempted_transports,
                started_at: run_started_at.to_rfc3339(),
                completed_at: completed_at.to_rfc3339(),
                duration_ms,
                project_results,
                imported_projects,
                imported_project_count: import_counts.imported,
                skipped_project_count: import_counts.skipped,
                failed_project_count: import_counts.failed,
                received_artifacts,
                transfer_counts,
                served_artifact_requests,
                total_received_bytes: metrics.total_received_bytes,
                total_served_bytes: metrics.total_served_bytes,
                time_to_first_artifact_ms: metrics.time_to_first_artifact_ms(),
                throughput_bytes_per_second: metrics
                    .throughput_bytes_per_second(run_started_instant.elapsed()),
                scratch_peak_bytes: metrics.scratch_peak_bytes,
                staging_peak_bytes: metrics.staging_peak_bytes,
                max_active_streams: metrics.max_active_streams,
                credit_grants: metrics.credit_grants,
                credit_revokes: metrics.credit_revokes,
                remote_manifest_count: remote_offer.project_manifests.len(),
                local_manifest_count,
                manifest_errors,
                lifecycle_events: Vec::new(),
                retryable_interruption_code: None,
                retry_guidance: None,
                phase_timings: timings,
                diagnostics: metrics.diagnostics,
            })
        }

        fn local_iroh_transport(&self) -> Option<IrohTransport> {
            self.listener.lock().ok().and_then(|guard| {
                guard
                    .as_ref()
                    .and_then(|handle| handle.iroh_transport.clone())
            })
        }

        fn current_endpoint_hints(&self) -> Vec<String> {
            self.listener
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().map(|handle| handle.endpoint_hints.clone()))
                .unwrap_or_default()
        }

        fn refresh_listener_endpoint_hints(&self) {
            let client = match BackendClient::new(&self.backend) {
                Ok(client) => client,
                Err(error) => {
                    update_status(&self.shared_status, |status| {
                        status.last_error =
                            Some(format!("Could not refresh sync endpoint hints: {error}"));
                    });
                    return;
                }
            };
            let identity = match client.local_identity() {
                Ok(identity) => identity,
                Err(error) => {
                    update_status(&self.shared_status, |status| {
                        status.last_error =
                            Some(format!("Could not refresh sync endpoint hints: {error}"));
                    });
                    return;
                }
            };
            let refreshed = self
                .listener
                .lock()
                .ok()
                .and_then(|mut guard| {
                    let handle = guard.as_mut()?;
                    let mut endpoint_hints = handle
                        .iroh_transport
                        .as_ref()
                        .map(|transport| iroh_endpoint_hints(transport, &identity.device_id))
                        .unwrap_or_default();
                    endpoint_hints.extend(endpoint_hints_for_port(
                        handle.bind_addr.port(),
                        &identity.device_id,
                    ));
                    handle.endpoint_hints = endpoint_hints;
                    Some(())
                })
                .is_some();

            if refreshed {
                update_status(&self.shared_status, |status| {
                    status.last_status =
                        Some("Sync transport endpoint hints refreshed.".to_string());
                    status.last_error = None;
                });
            }
        }
    }

    #[derive(Clone)]
    struct BackendAccess {
        base_url: String,
        #[cfg_attr(not(target_os = "android"), allow(dead_code))]
        app: AppHandle,
    }

    #[derive(Debug, Deserialize)]
    struct SyncBackendPreflight {
        #[serde(default = "sync_backend_preflight_default_ok")]
        ok: bool,
        #[serde(default = "sync_backend_preflight_default_library_ok")]
        library_ok: bool,
        #[serde(default)]
        total_projects: usize,
        #[serde(default)]
        ready_projects: usize,
        #[serde(default)]
        missing_source_hash_projects: usize,
        #[serde(default)]
        invalid_source_hash_projects: usize,
        #[serde(default)]
        duplicate_source_hash_projects: usize,
        #[serde(default)]
        noncanonical_project_id_projects: usize,
        #[serde(default)]
        manual_cleanup_required: bool,
        #[serde(default)]
        manual_cleanup_guidance: Vec<String>,
        #[serde(default)]
        job_state: Option<Value>,
    }

    impl SyncBackendPreflight {
        #[cfg(target_os = "android")]
        fn ready() -> Self {
            Self {
                ok: true,
                library_ok: true,
                total_projects: 0,
                ready_projects: 0,
                missing_source_hash_projects: 0,
                invalid_source_hash_projects: 0,
                duplicate_source_hash_projects: 0,
                noncanonical_project_id_projects: 0,
                manual_cleanup_required: false,
                manual_cleanup_guidance: Vec::new(),
                job_state: None,
            }
        }
    }

    fn sync_backend_preflight_default_ok() -> bool {
        true
    }

    fn sync_backend_preflight_default_library_ok() -> bool {
        true
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct BackendPreflightFailure {
        fallback_code: &'static str,
        message: String,
    }

    #[derive(Clone, Debug, Default, Eq, PartialEq)]
    struct BackendJobStateSummary {
        running_count: usize,
        pending_count: usize,
        running_type_counts: BTreeMap<String, usize>,
        pending_type_counts: BTreeMap<String, usize>,
    }

    fn sync_preflight_failure(preflight: &SyncBackendPreflight) -> Option<BackendPreflightFailure> {
        if library_preflight_failed(preflight) {
            return Some(BackendPreflightFailure {
                fallback_code: LIBRARY_PREFLIGHT_FAILED_CODE,
                message: library_preflight_failed_message(preflight),
            });
        }

        if !preflight.ok {
            return Some(BackendPreflightFailure {
                fallback_code: LIBRARY_PREFLIGHT_FAILED_CODE,
                message: library_preflight_failed_message(preflight),
            });
        }

        None
    }

    fn sync_endpoint_unresponsive_failure(
        preflight: &SyncBackendPreflight,
    ) -> BackendPreflightFailure {
        if let Some(summary) = preflight
            .job_state
            .as_ref()
            .and_then(blocking_job_state_summary)
        {
            return BackendPreflightFailure {
                fallback_code: BACKEND_BUSY_CODE,
                message: backend_busy_message(&summary),
            };
        }
        BackendPreflightFailure {
            fallback_code: BACKEND_PREFLIGHT_UNRESPONSIVE_CODE,
            message: BACKEND_PREFLIGHT_UNRESPONSIVE_MESSAGE.to_string(),
        }
    }

    fn library_preflight_failed(preflight: &SyncBackendPreflight) -> bool {
        !preflight.library_ok
            || preflight.manual_cleanup_required
            || preflight.missing_source_hash_projects > 0
            || preflight.invalid_source_hash_projects > 0
            || preflight.duplicate_source_hash_projects > 0
            || preflight.noncanonical_project_id_projects > 0
    }

    fn failed_preflight_sync_result(
        run_id: String,
        peer_device_id: String,
        fallback_code: &'static str,
        message: String,
        run_started_at: DateTime<Utc>,
        run_started_instant: Instant,
    ) -> SyncTransportSyncResult {
        let completed_at = Utc::now();
        SyncTransportSyncResult {
            run_id,
            peer_device_id: peer_device_id.clone(),
            remote_device_id: peer_device_id,
            status: "failed".to_string(),
            message,
            selected_transport: NOT_STARTED_TRANSPORT_ID.to_string(),
            fallback_reason: None,
            fallback_code: Some(fallback_code.to_string()),
            attempted_transports: Vec::new(),
            started_at: run_started_at.to_rfc3339(),
            completed_at: completed_at.to_rfc3339(),
            duration_ms: duration_millis(run_started_instant.elapsed()),
            project_results: Vec::new(),
            imported_projects: Vec::new(),
            imported_project_count: 0,
            skipped_project_count: 0,
            failed_project_count: 0,
            received_artifacts: Vec::new(),
            transfer_counts: SyncTransportTransferCounts::default(),
            served_artifact_requests: 0,
            total_received_bytes: 0,
            total_served_bytes: 0,
            time_to_first_artifact_ms: None,
            throughput_bytes_per_second: 0.0,
            scratch_peak_bytes: 0,
            staging_peak_bytes: 0,
            max_active_streams: 0,
            credit_grants: 0,
            credit_revokes: 0,
            remote_manifest_count: 0,
            local_manifest_count: 0,
            manifest_errors: Vec::new(),
            lifecycle_events: Vec::new(),
            retryable_interruption_code: None,
            retry_guidance: None,
            phase_timings: Vec::new(),
            diagnostics: SyncTransportDiagnostics::default(),
        }
    }

    fn sync_failed_status_message(error: &str, failure_prefix: &str) -> String {
        let mut message = error.trim();
        let failure_sentence = format!("{failure_prefix}.");
        if message == failure_sentence {
            return failure_sentence;
        }
        let failure_detail_prefix = format!("{failure_prefix}:");
        if let Some(stripped) = message.strip_prefix(&failure_detail_prefix) {
            message = stripped.trim();
        }
        if message.is_empty() {
            return failure_sentence;
        }
        let safe_message = if sync_now_failure_detail_is_sensitive(message) {
            sync_now_failure_redacted_summary(message)
        } else {
            message.to_string()
        };
        format!("{failure_prefix}: {safe_message}")
    }

    fn sync_now_failed_status_message(error: &str) -> String {
        sync_failed_status_message(error, "Sync now failed")
    }

    fn incoming_session_failed_status_message(error: &str) -> String {
        sync_failed_status_message(error, "Sync session failed")
    }

    fn sync_transport_failure_prefix(message: &str) -> Option<&str> {
        let (prefix, _) = message.split_once(':')?;
        let prefix = prefix.trim();
        if prefix.starts_with("Sync transport ")
            && (prefix.ends_with(" failed") || prefix.ends_with(" stalled"))
        {
            return Some(prefix);
        }
        None
    }

    fn sync_now_failure_redacted_summary(message: &str) -> String {
        if let Some(prefix) = sync_transport_failure_prefix(message) {
            return format!("{prefix}: details redacted.");
        }
        "Sync transport failed: details redacted.".to_string()
    }

    fn sync_now_failure_detail_is_sensitive(message: &str) -> bool {
        let detail = sync_transport_failure_prefix(message)
            .and_then(|prefix| message.get(prefix.len() + 1..))
            .map(str::trim)
            .unwrap_or(message);
        let lower = detail.to_ascii_lowercase();
        if lower.contains("://")
            || lower.contains("tuneforge-sync+")
            || lower.contains("content_sha256")
            || lower.contains("source_path")
            || lower.contains("imported_path")
            || lower.contains("endpoint_hint")
            || lower.contains("endpoint_hints")
            || lower.contains("endpointhint")
            || lower.contains("endpointhints")
            || lower.contains("project_id")
            || lower.contains("projectid")
            || lower.contains("artifact_id")
            || lower.contains("artifactid")
            || lower.contains("device_id")
            || lower.contains("deviceid")
        {
            return true;
        }
        detail
            .split_whitespace()
            .map(|token| {
                token
                    .trim_matches(|ch: char| {
                        matches!(
                            ch,
                            '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';'
                        )
                    })
                    .trim_end_matches(|ch| matches!(ch, '.' | ':'))
            })
            .filter(|token| !token.is_empty())
            .any(sync_now_failure_token_is_sensitive)
    }

    fn sync_now_failure_token_is_sensitive(token: &str) -> bool {
        let lower = token.to_ascii_lowercase();
        token.contains('/')
            || token.contains('\\')
            || token.parse::<SocketAddr>().is_ok()
            || lower.starts_with("dev_")
            || lower.starts_with("device_")
            || lower.starts_with("proj_")
            || lower.starts_with("art_")
            || lower.starts_with("sync_")
            || lower.starts_with("sha256")
            || sync_now_failure_token_looks_like_hash(token)
    }

    fn sync_now_failure_token_looks_like_hash(token: &str) -> bool {
        let value = token
            .strip_prefix("sha256:")
            .or_else(|| token.strip_prefix("sha256-"))
            .unwrap_or(token);
        value.len() >= 32 && value.chars().all(|ch| ch.is_ascii_hexdigit())
    }

    fn sync_now_failure_timings_with_finished_timer(
        timings: &[SyncTransportTimingEvidence],
        timer: SyncPhaseTimer,
    ) -> Vec<SyncTransportTimingEvidence> {
        let mut failure_timings = timings.to_vec();
        failure_timings.push(timer.finish());
        failure_timings
    }

    fn not_started_transport_evidence() -> TransportEvidence {
        TransportEvidence {
            selected_transport: NOT_STARTED_TRANSPORT_ID.to_string(),
            fallback_reason: None,
            fallback_code: None,
            attempted_transports: Vec::new(),
        }
    }

    fn sync_now_hard_failure(
        error: String,
        run_id: &str,
        peer_device_id: &str,
        remote_device_id: &str,
        transport: TransportEvidence,
        run_started_at: &DateTime<Utc>,
        run_started_instant: Instant,
        received_artifacts: &[SyncTransportTransferResult],
        served_artifact_requests: u64,
        metrics: &SyncRunMetrics,
        phase_timings: &[SyncTransportTimingEvidence],
        local_manifest_count: usize,
        remote_manifest_count: usize,
        manifest_errors: Vec<SyncTransportManifestError>,
    ) -> SyncNowHardFailure {
        let completed_at = Utc::now();
        let received_artifacts = privacy_safe_hard_failure_transfers(received_artifacts);
        let transfer_counts = transfer_counts(&received_artifacts);
        let sync_result = SyncTransportSyncResult {
            run_id: run_id.to_string(),
            peer_device_id: peer_device_id.to_string(),
            remote_device_id: remote_device_id.to_string(),
            status: "failed".to_string(),
            message: sync_now_failed_status_message(&error),
            selected_transport: transport.selected_transport,
            fallback_reason: transport.fallback_reason,
            fallback_code: transport.fallback_code,
            attempted_transports: transport.attempted_transports,
            started_at: run_started_at.to_rfc3339(),
            completed_at: completed_at.to_rfc3339(),
            duration_ms: duration_millis(run_started_instant.elapsed()),
            project_results: Vec::new(),
            imported_projects: Vec::new(),
            imported_project_count: 0,
            skipped_project_count: 0,
            failed_project_count: 0,
            received_artifacts,
            transfer_counts,
            served_artifact_requests,
            total_received_bytes: metrics.total_received_bytes,
            total_served_bytes: metrics.total_served_bytes,
            time_to_first_artifact_ms: metrics.time_to_first_artifact_ms(),
            throughput_bytes_per_second: metrics
                .throughput_bytes_per_second(run_started_instant.elapsed()),
            scratch_peak_bytes: metrics.scratch_peak_bytes,
            staging_peak_bytes: metrics.staging_peak_bytes,
            max_active_streams: metrics.max_active_streams,
            credit_grants: metrics.credit_grants,
            credit_revokes: metrics.credit_revokes,
            remote_manifest_count,
            local_manifest_count,
            manifest_errors: privacy_safe_hard_failure_manifest_errors(manifest_errors),
            lifecycle_events: Vec::new(),
            retryable_interruption_code: None,
            retry_guidance: None,
            phase_timings: privacy_safe_hard_failure_phase_timings(phase_timings),
            diagnostics: metrics.diagnostics.clone(),
        };
        SyncNowHardFailure { error, sync_result }
    }

    fn incoming_session_hard_failure(
        error: String,
        run_id: &str,
        peer_device_id: &str,
        remote_device_id: &str,
        transport: TransportEvidence,
        run_started_at: &DateTime<Utc>,
        run_started_instant: Instant,
        received_artifacts: &[SyncTransportTransferResult],
        served_artifact_requests: u64,
        metrics: &SyncRunMetrics,
        phase_timings: &[SyncTransportTimingEvidence],
        local_manifest_count: usize,
        remote_manifest_count: usize,
        manifest_errors: Vec<SyncTransportManifestError>,
    ) -> IncomingSessionHardFailure {
        let completed_at = Utc::now();
        let received_artifacts = privacy_safe_hard_failure_transfers(received_artifacts);
        let transfer_counts = transfer_counts(&received_artifacts);
        let sync_result = SyncTransportSyncResult {
            run_id: run_id.to_string(),
            peer_device_id: peer_device_id.to_string(),
            remote_device_id: remote_device_id.to_string(),
            status: "failed".to_string(),
            message: incoming_session_failed_status_message(&error),
            selected_transport: transport.selected_transport,
            fallback_reason: transport.fallback_reason,
            fallback_code: transport.fallback_code,
            attempted_transports: transport.attempted_transports,
            started_at: run_started_at.to_rfc3339(),
            completed_at: completed_at.to_rfc3339(),
            duration_ms: duration_millis(run_started_instant.elapsed()),
            project_results: Vec::new(),
            imported_projects: Vec::new(),
            imported_project_count: 0,
            skipped_project_count: 0,
            failed_project_count: 0,
            received_artifacts,
            transfer_counts,
            served_artifact_requests,
            total_received_bytes: metrics.total_received_bytes,
            total_served_bytes: metrics.total_served_bytes,
            time_to_first_artifact_ms: metrics.time_to_first_artifact_ms(),
            throughput_bytes_per_second: metrics
                .throughput_bytes_per_second(run_started_instant.elapsed()),
            scratch_peak_bytes: metrics.scratch_peak_bytes,
            staging_peak_bytes: metrics.staging_peak_bytes,
            max_active_streams: metrics.max_active_streams,
            credit_grants: metrics.credit_grants,
            credit_revokes: metrics.credit_revokes,
            remote_manifest_count,
            local_manifest_count,
            manifest_errors: privacy_safe_hard_failure_manifest_errors(manifest_errors),
            lifecycle_events: Vec::new(),
            retryable_interruption_code: None,
            retry_guidance: None,
            phase_timings: privacy_safe_hard_failure_phase_timings(phase_timings),
            diagnostics: metrics.diagnostics.clone(),
        };
        IncomingSessionHardFailure { error, sync_result }
    }

    fn privacy_safe_hard_failure_text(message: Option<&str>, redacted: &str) -> Option<String> {
        message.map(|message| {
            if sync_now_failure_detail_is_sensitive(message)
                || message.to_ascii_lowercase().contains("backend http")
            {
                redacted.to_string()
            } else {
                message.to_string()
            }
        })
    }

    fn privacy_safe_hard_failure_transfers(
        transfers: &[SyncTransportTransferResult],
    ) -> Vec<SyncTransportTransferResult> {
        transfers
            .iter()
            .enumerate()
            .map(|(index, transfer)| SyncTransportTransferResult {
                artifact_id: format!("artifact_{}", index + 1),
                content_sha256: "[redacted_hash]".to_string(),
                message: privacy_safe_hard_failure_text(
                    transfer.message.as_deref(),
                    "Transfer details redacted.",
                ),
                ..transfer.clone()
            })
            .collect()
    }

    fn privacy_safe_hard_failure_manifest_errors(
        errors: Vec<SyncTransportManifestError>,
    ) -> Vec<SyncTransportManifestError> {
        errors
            .into_iter()
            .enumerate()
            .map(|(index, error)| SyncTransportManifestError {
                project_id: format!("project_{}", index + 1),
                message: privacy_safe_hard_failure_text(
                    Some(&error.message),
                    "Manifest error details redacted.",
                )
                .unwrap_or_else(|| "Manifest error details redacted.".to_string()),
            })
            .collect()
    }

    fn privacy_safe_hard_failure_phase_timings(
        timings: &[SyncTransportTimingEvidence],
    ) -> Vec<SyncTransportTimingEvidence> {
        timings
            .iter()
            .enumerate()
            .map(|(index, timing)| SyncTransportTimingEvidence {
                project_id: timing
                    .project_id
                    .as_ref()
                    .map(|_| format!("project_{}", index + 1)),
                artifact_id: timing
                    .artifact_id
                    .as_ref()
                    .map(|_| format!("artifact_{}", index + 1)),
                ..timing.clone()
            })
            .collect()
    }

    fn lifecycle_interrupted_sync_result(
        run_id: String,
        peer_device_id: String,
        remote_device_id: String,
        selected_transport: String,
        attempted_transports: Vec<String>,
        interruption: LifecycleInterruptionEvidence,
        lifecycle_events: Vec<SyncTransportLifecycleEvent>,
        run_started_at: DateTime<Utc>,
        run_started_instant: Instant,
        received_artifacts: Vec<SyncTransportTransferResult>,
        served_artifact_requests: u64,
        metrics: SyncRunMetrics,
        phase_timings: Vec<SyncTransportTimingEvidence>,
    ) -> SyncTransportSyncResult {
        let completed_at = Utc::now();
        let transfer_counts = transfer_counts(&received_artifacts);
        SyncTransportSyncResult {
            run_id,
            peer_device_id,
            remote_device_id,
            status: "failed".to_string(),
            message: format!(
                "Sync interrupted by lifecycle event {}. {}",
                interruption.event.kind, interruption.guidance
            ),
            selected_transport,
            fallback_reason: None,
            fallback_code: None,
            attempted_transports,
            started_at: run_started_at.to_rfc3339(),
            completed_at: completed_at.to_rfc3339(),
            duration_ms: duration_millis(run_started_instant.elapsed()),
            project_results: Vec::new(),
            imported_projects: Vec::new(),
            imported_project_count: 0,
            skipped_project_count: 0,
            failed_project_count: 0,
            received_artifacts,
            transfer_counts,
            served_artifact_requests,
            total_received_bytes: metrics.total_received_bytes,
            total_served_bytes: metrics.total_served_bytes,
            time_to_first_artifact_ms: metrics.time_to_first_artifact_ms(),
            throughput_bytes_per_second: metrics
                .throughput_bytes_per_second(run_started_instant.elapsed()),
            scratch_peak_bytes: metrics.scratch_peak_bytes,
            staging_peak_bytes: metrics.staging_peak_bytes,
            max_active_streams: metrics.max_active_streams,
            credit_grants: metrics.credit_grants,
            credit_revokes: metrics.credit_revokes,
            remote_manifest_count: 0,
            local_manifest_count: 0,
            manifest_errors: Vec::new(),
            lifecycle_events,
            retryable_interruption_code: Some(interruption.code),
            retry_guidance: Some(interruption.guidance),
            phase_timings,
            diagnostics: metrics.diagnostics,
        }
    }

    fn lifecycle_interrupted_sync_result_for_run(
        shared_status: &Arc<Mutex<SharedStatus>>,
        run_cancel: &RunCancellationToken,
        run_id: &str,
        peer_device_id: &str,
        remote_device_id: &str,
        selected_transport: &str,
        attempted_transports: Vec<String>,
        run_started_at: &DateTime<Utc>,
        run_started_instant: Instant,
        received_artifacts: &[SyncTransportTransferResult],
        served_artifact_requests: u64,
        metrics: &SyncRunMetrics,
        phase_timings: &[SyncTransportTimingEvidence],
    ) -> Option<SyncTransportSyncResult> {
        let interruption = run_cancel.interruption()?;
        let lifecycle_events =
            lifecycle_events_for_interruption(shared_status, run_id, &interruption);
        Some(lifecycle_interrupted_sync_result(
            run_id.to_string(),
            peer_device_id.to_string(),
            remote_device_id.to_string(),
            selected_transport.to_string(),
            attempted_transports,
            interruption,
            lifecycle_events,
            run_started_at.clone(),
            run_started_instant,
            received_artifacts.to_vec(),
            served_artifact_requests,
            metrics.clone(),
            phase_timings.to_vec(),
        ))
    }

    fn blocking_job_state_summary(job_state: &Value) -> Option<BackendJobStateSummary> {
        let mut summary = BackendJobStateSummary {
            running_count: job_state_count(
                job_state,
                &[
                    "running_job_count",
                    "running_count",
                    "running_jobs_count",
                    "active_count",
                    "running",
                ],
            )
            .unwrap_or(0),
            pending_count: job_state_count(
                job_state,
                &[
                    "pending_job_count",
                    "pending_count",
                    "pending_jobs_count",
                    "queued_count",
                    "pending",
                    "queued",
                ],
            )
            .unwrap_or(0),
            running_type_counts: BTreeMap::new(),
            pending_type_counts: BTreeMap::new(),
        };
        let blocking_job_count = job_state_count(job_state, &["blocking_job_count"]).unwrap_or(0);

        if let Some(status_counts) = job_state.get("blocking_job_counts") {
            if summary.running_count == 0 {
                summary.running_count = status_count(status_counts, "running").unwrap_or(0);
            }
            if summary.pending_count == 0 {
                summary.pending_count = status_count(status_counts, "pending").unwrap_or(0);
            }
        }

        merge_type_counts(
            &mut summary.running_type_counts,
            job_state_type_counts(job_state.get("running_types")),
        );
        merge_type_counts(
            &mut summary.running_type_counts,
            job_state_type_counts(job_state.get("running_job_types")),
        );
        merge_type_counts(
            &mut summary.running_type_counts,
            job_state_type_counts(job_state.get("running_jobs")),
        );
        merge_type_counts(
            &mut summary.running_type_counts,
            job_state_type_counts(job_state.get("running")),
        );
        merge_type_counts(
            &mut summary.pending_type_counts,
            job_state_type_counts(job_state.get("pending_types")),
        );
        merge_type_counts(
            &mut summary.pending_type_counts,
            job_state_type_counts(job_state.get("pending_job_types")),
        );
        merge_type_counts(
            &mut summary.pending_type_counts,
            job_state_type_counts(job_state.get("pending_jobs")),
        );
        merge_type_counts(
            &mut summary.pending_type_counts,
            job_state_type_counts(job_state.get("pending")),
        );
        merge_type_counts(
            &mut summary.running_type_counts,
            job_state_status_type_counts(job_state, "running"),
        );
        merge_type_counts(
            &mut summary.pending_type_counts,
            job_state_status_type_counts(job_state, "pending"),
        );

        if summary.running_count == 0 {
            summary.running_count = job_state_array_len(job_state, &["running_jobs", "running"])
                .unwrap_or_else(|| summary.running_type_counts.values().sum());
        }
        if summary.pending_count == 0 {
            summary.pending_count = job_state_array_len(job_state, &["pending_jobs", "pending"])
                .unwrap_or_else(|| summary.pending_type_counts.values().sum());
        }

        let state_busy = job_state
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|state| state == "busy");
        let legacy_blocks_sync = job_state_bool(job_state, &["blocks_sync", "blocked", "busy"])
            .or_else(|| job_state_bool(job_state, &["can_sync"]).map(|can_sync| !can_sync))
            .or_else(|| job_state_bool(job_state, &["ready"]).map(|ready| !ready));
        let blocks_sync = state_busy
            || blocking_job_count > 0
            || legacy_blocks_sync
                .unwrap_or_else(|| summary.running_count + summary.pending_count > 0);
        if blocks_sync {
            Some(summary)
        } else {
            None
        }
    }

    fn job_state_count(job_state: &Value, keys: &[&str]) -> Option<usize> {
        keys.iter()
            .find_map(|key| job_state.get(*key).and_then(value_as_usize))
    }

    fn job_state_array_len(job_state: &Value, keys: &[&str]) -> Option<usize> {
        keys.iter().find_map(|key| {
            job_state
                .get(*key)
                .and_then(Value::as_array)
                .map(std::vec::Vec::len)
        })
    }

    fn job_state_bool(job_state: &Value, keys: &[&str]) -> Option<bool> {
        keys.iter()
            .find_map(|key| job_state.get(*key).and_then(Value::as_bool))
    }

    fn value_as_usize(value: &Value) -> Option<usize> {
        value.as_u64().and_then(|count| usize::try_from(count).ok())
    }

    fn status_count(value: &Value, status: &str) -> Option<usize> {
        value.get(status).and_then(value_as_usize)
    }

    fn job_state_status_type_counts(job_state: &Value, status: &str) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        let jobs = ["blocking_jobs", "jobs"]
            .into_iter()
            .filter_map(|key| job_state.get(key).and_then(Value::as_array))
            .flatten();
        for job in jobs {
            if job.get("status").and_then(Value::as_str) == Some(status) {
                if let Some(job_type) = job.get("type").and_then(Value::as_str) {
                    *counts.entry(job_type.to_string()).or_insert(0) += 1;
                }
            }
        }
        counts
    }

    fn job_state_type_counts(value: Option<&Value>) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        match value {
            Some(Value::Object(object)) => {
                for (job_type, count) in object {
                    if let Some(count) = value_as_usize(count) {
                        counts.insert(job_type.clone(), count);
                    }
                }
            }
            Some(Value::Array(values)) => {
                for value in values {
                    let job_type = value
                        .as_str()
                        .or_else(|| value.get("type").and_then(Value::as_str));
                    if let Some(job_type) = job_type {
                        *counts.entry(job_type.to_string()).or_insert(0) += 1;
                    }
                }
            }
            _ => {}
        }
        counts
    }

    fn merge_type_counts(target: &mut BTreeMap<String, usize>, source: BTreeMap<String, usize>) {
        for (job_type, count) in source {
            *target.entry(job_type).or_insert(0) += count;
        }
    }

    fn backend_busy_message(summary: &BackendJobStateSummary) -> String {
        let mut parts = Vec::new();
        if summary.running_count > 0 {
            parts.push(format!(
                "{}{}",
                plural_count(summary.running_count, "running job", "running jobs"),
                job_type_count_suffix(&summary.running_type_counts)
            ));
        }
        if summary.pending_count > 0 {
            parts.push(format!(
                "{}{}",
                plural_count(summary.pending_count, "pending job", "pending jobs"),
                job_type_count_suffix(&summary.pending_type_counts)
            ));
        }
        let job_summary = if parts.is_empty() {
            "active backend job work".to_string()
        } else {
            parts.join(" and ")
        };
        format!("Local backend is busy with {job_summary}. {BACKEND_BUSY_RETRY_GUIDANCE}")
    }

    fn job_type_count_suffix(type_counts: &BTreeMap<String, usize>) -> String {
        if type_counts.is_empty() {
            return String::new();
        }
        let parts: Vec<String> = type_counts
            .iter()
            .map(|(job_type, count)| format!("{job_type}: {count}"))
            .collect();
        format!(" ({})", parts.join(", "))
    }

    fn library_preflight_failed_message(preflight: &SyncBackendPreflight) -> String {
        let mut count_parts = Vec::new();
        push_preflight_count(
            &mut count_parts,
            preflight.missing_source_hash_projects,
            "missing source hash project",
        );
        push_preflight_count(
            &mut count_parts,
            preflight.invalid_source_hash_projects,
            "invalid source hash project",
        );
        push_preflight_count(
            &mut count_parts,
            preflight.duplicate_source_hash_projects,
            "duplicate source hash project",
        );
        push_preflight_count(
            &mut count_parts,
            preflight.noncanonical_project_id_projects,
            "noncanonical project ID project",
        );
        if count_parts.is_empty() && preflight.total_projects > preflight.ready_projects {
            push_preflight_count(
                &mut count_parts,
                preflight.total_projects - preflight.ready_projects,
                "not-ready project",
            );
        }
        let count_summary = if count_parts.is_empty() {
            "local library is not ready for sync".to_string()
        } else {
            count_parts.join(", ")
        };
        let guidance = preflight
            .manual_cleanup_guidance
            .iter()
            .map(|guidance| guidance.trim())
            .filter(|guidance| !guidance.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let guidance = if guidance.is_empty() {
            "Review local library cleanup requirements, then retry sync.".to_string()
        } else {
            guidance
        };
        format!("Library sync preflight failed: {count_summary}. Manual cleanup: {guidance}")
    }

    fn push_preflight_count(parts: &mut Vec<String>, count: usize, singular: &str) {
        if count > 0 {
            parts.push(plural_count(count, singular, &format!("{singular}s")));
        }
    }

    fn plural_count(count: usize, singular: &str, plural: &str) -> String {
        if count == 1 {
            format!("{count} {singular}")
        } else {
            format!("{count} {plural}")
        }
    }

    pub fn sync_transport_start_listener(
        state: State<'_, SyncTransportState>,
        payload: SyncTransportStartListenerRequest,
    ) -> Result<SyncTransportStatus, String> {
        state.start_listener(payload)
    }

    pub fn sync_transport_stop_listener(
        state: State<'_, SyncTransportState>,
    ) -> Result<SyncTransportStatus, String> {
        state.stop_listener()
    }

    pub fn sync_transport_status(state: State<'_, SyncTransportState>) -> SyncTransportStatus {
        state.status()
    }

    pub fn sync_transport_record_lifecycle_event(
        state: State<'_, SyncTransportState>,
        payload: SyncTransportLifecycleEventRequest,
    ) -> SyncTransportStatus {
        state.record_lifecycle_event(payload)
    }

    pub async fn sync_transport_create_pairing_offer(
        state: State<'_, SyncTransportState>,
        payload: SyncTransportPairingOfferRequest,
    ) -> Result<SyncTransportPairingOffer, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || state.create_pairing_offer(payload))
            .await
            .map_err(|error| format!("Sync transport pairing task failed: {error}"))?
    }

    pub async fn sync_transport_sync_now(
        state: State<'_, SyncTransportState>,
        payload: SyncTransportSyncNowRequest,
    ) -> Result<SyncTransportSyncResult, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || state.sync_now(payload))
            .await
            .map_err(|error| format!("Sync transport task failed: {error}"))?
    }

    struct ListenerHandle {
        bind_addr: SocketAddr,
        endpoint_hints: Vec<String>,
        iroh_transport: Option<IrohTransport>,
        stop: Arc<AtomicBool>,
        tcp_thread: Option<JoinHandle<()>>,
        iroh_thread: Option<JoinHandle<()>>,
        discovery_thread: Option<JoinHandle<()>>,
    }

    struct IncomingSessionResult {
        message: String,
        sync_result: SyncTransportSyncResult,
    }

    #[derive(Clone, Default)]
    struct SharedStatus {
        active_sessions: usize,
        accepted_sessions: u64,
        failed_sessions: u64,
        last_status: Option<String>,
        last_error: Option<String>,
        last_sync: Option<SyncTransportSyncResult>,
        active_progress: Option<SyncTransportActiveProgress>,
        active_progress_owner_run_id: Option<String>,
        nearby_peers: HashMap<String, DiscoveryPeerEntry>,
        lifecycle_events: Vec<SyncTransportLifecycleEvent>,
        last_lifecycle_event: Option<SyncTransportLifecycleEvent>,
        retryable_interruption_code: Option<String>,
        retryable_interruption_peer_device_id: Option<String>,
        retry_guidance: Option<String>,
        active_runs: HashMap<String, ActiveSyncRun>,
    }

    #[derive(Clone, Debug)]
    struct SyncNowHardFailure {
        error: String,
        sync_result: SyncTransportSyncResult,
    }

    #[derive(Clone, Debug)]
    struct IncomingSessionHardFailure {
        error: String,
        sync_result: SyncTransportSyncResult,
    }

    #[derive(Clone)]
    struct DiscoveryPeerEntry {
        peer: SyncTransportNearbyPeer,
        expires_at_instant: Instant,
    }

    #[derive(Clone)]
    struct ActiveSyncRun {
        peer_device_id: Option<String>,
        cancel: RunCancellationToken,
        connection: Option<SharedPeerConnection>,
    }

    #[derive(Clone)]
    struct ActiveRunSnapshot {
        run_id: String,
        peer_device_id: Option<String>,
        cancel: RunCancellationToken,
        connection: Option<SharedPeerConnection>,
    }

    #[derive(Clone, Debug)]
    struct LifecycleInterruptionEvidence {
        code: String,
        guidance: String,
        event: SyncTransportLifecycleEvent,
    }

    #[derive(Clone, Default)]
    struct RunCancellationToken {
        cancelled: Arc<AtomicBool>,
        interruption: Arc<Mutex<Option<LifecycleInterruptionEvidence>>>,
    }

    impl RunCancellationToken {
        fn interrupt(&self, evidence: LifecycleInterruptionEvidence) {
            self.cancelled.store(true, Ordering::SeqCst);
            if let Ok(mut interruption) = self.interruption.lock() {
                if interruption.is_none() {
                    *interruption = Some(evidence);
                }
            }
        }

        fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::SeqCst)
        }

        fn interruption(&self) -> Option<LifecycleInterruptionEvidence> {
            self.interruption
                .lock()
                .ok()
                .and_then(|interruption| interruption.clone())
        }
    }

    #[derive(Default)]
    struct LifecycleRecordOutcome {
        event: SyncTransportLifecycleEvent,
        interrupted_runs: Vec<ActiveRunSnapshot>,
        refresh_endpoint_hints: bool,
    }

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(rename_all = "snake_case")]
    struct DiscoveryBeaconPayload {
        protocol_version: String,
        device_id: String,
        sync_group_id: String,
        display_name: Option<String>,
        public_key: String,
        endpoint_hints: Vec<String>,
        timestamp: String,
    }

    fn start_discovery(
        identity: SyncLocalIdentity,
        endpoint_hints: Vec<String>,
        shared_status: Arc<Mutex<SharedStatus>>,
        stop: Arc<AtomicBool>,
    ) -> Result<JoinHandle<()>, String> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)).map_err(|error| {
            format!("Could not bind sync discovery UDP port {DISCOVERY_PORT}: {error}")
        })?;
        socket
            .set_broadcast(true)
            .map_err(|error| format!("Could not enable sync discovery broadcast: {error}"))?;
        socket
            .set_read_timeout(Some(DISCOVERY_SOCKET_TIMEOUT))
            .map_err(|error| {
                format!("Could not configure sync discovery receive timeout: {error}")
            })?;
        Ok(thread::spawn(move || {
            discovery_loop(socket, identity, endpoint_hints, shared_status, stop);
        }))
    }

    fn discovery_loop(
        socket: UdpSocket,
        identity: SyncLocalIdentity,
        endpoint_hints: Vec<String>,
        shared_status: Arc<Mutex<SharedStatus>>,
        stop: Arc<AtomicBool>,
    ) {
        let mut last_broadcast = Instant::now()
            .checked_sub(DISCOVERY_BEACON_INTERVAL)
            .unwrap_or_else(Instant::now);
        let broadcast_targets = discovery_broadcast_targets();
        let mut buffer = [0_u8; DISCOVERY_MAX_PACKET_BYTES];

        while !stop.load(Ordering::SeqCst) {
            if last_broadcast.elapsed() >= DISCOVERY_BEACON_INTERVAL {
                let timestamp = Utc::now();
                for target in &broadcast_targets {
                    let _ = send_discovery_beacon(
                        &socket,
                        *target,
                        &identity,
                        &endpoint_hints,
                        timestamp,
                    );
                }
                last_broadcast = Instant::now();
            }

            match socket.recv_from(&mut buffer) {
                Ok((size, _)) => {
                    record_discovery_beacon(
                        &shared_status,
                        &buffer[..size],
                        &identity.device_id,
                        Utc::now(),
                        Instant::now() + DISCOVERY_PEER_TTL,
                    );
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => thread::sleep(ACCEPT_SLEEP),
            }
        }
    }

    fn send_discovery_beacon(
        socket: &UdpSocket,
        target: SocketAddr,
        identity: &SyncLocalIdentity,
        endpoint_hints: &[String],
        timestamp: DateTime<Utc>,
    ) -> Result<(), String> {
        let payload = discovery_beacon_payload(identity, endpoint_hints, timestamp)?;
        let bytes = serde_json::to_vec(&payload)
            .map_err(|error| format!("Could not encode sync discovery beacon: {error}"))?;
        if bytes.len() > DISCOVERY_MAX_PACKET_BYTES {
            return Err("Sync discovery beacon exceeded the maximum packet size.".to_string());
        }
        socket
            .send_to(&bytes, target)
            .map(|_| ())
            .map_err(|error| format!("Could not send sync discovery beacon: {error}"))
    }

    fn discovery_broadcast_targets() -> Vec<SocketAddr> {
        let addresses = if_addrs::get_if_addrs()
            .map(|interfaces| {
                interfaces
                    .into_iter()
                    .filter_map(|interface| match interface.addr {
                        if_addrs::IfAddr::V4(addr) => Some((addr.ip, addr.broadcast)),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        discovery_broadcast_targets_from_ipv4(addresses)
    }

    fn discovery_broadcast_targets_from_ipv4(
        addresses: impl IntoIterator<Item = (Ipv4Addr, Option<Ipv4Addr>)>,
    ) -> Vec<SocketAddr> {
        let mut targets = Vec::new();
        for (ip, broadcast) in addresses {
            if ip.is_loopback() || ip.is_link_local() {
                continue;
            }
            if let Some(broadcast) = broadcast {
                if broadcast.is_unspecified()
                    || broadcast.is_loopback()
                    || broadcast.is_link_local()
                {
                    continue;
                }
                push_discovery_broadcast_target(&mut targets, broadcast);
            }
        }
        push_discovery_broadcast_target(&mut targets, Ipv4Addr::BROADCAST);
        targets
    }

    fn push_discovery_broadcast_target(targets: &mut Vec<SocketAddr>, broadcast: Ipv4Addr) {
        let target = SocketAddr::from((broadcast, DISCOVERY_PORT));
        if !targets.contains(&target) {
            targets.push(target);
        }
    }

    fn discovery_beacon_payload(
        identity: &SyncLocalIdentity,
        endpoint_hints: &[String],
        timestamp: DateTime<Utc>,
    ) -> Result<DiscoveryBeaconPayload, String> {
        Ok(DiscoveryBeaconPayload {
            protocol_version: DISCOVERY_PROTOCOL_VERSION.to_string(),
            device_id: required_discovery_string(&identity.device_id, "device_id")?,
            sync_group_id: required_discovery_string(&identity.sync_group_id, "sync_group_id")?,
            display_name: optional_discovery_string(identity.display_name.as_deref()),
            public_key: required_discovery_string(&identity.public_key, "public_key")?,
            endpoint_hints: normalize_advisory_endpoint_hints(endpoint_hints.to_vec())?,
            timestamp: timestamp.to_rfc3339(),
        })
    }

    fn record_discovery_beacon(
        shared_status: &Arc<Mutex<SharedStatus>>,
        bytes: &[u8],
        local_device_id: &str,
        observed_at: DateTime<Utc>,
        expires_at_instant: Instant,
    ) {
        if let Ok(Some(entry)) =
            parse_discovery_beacon(bytes, local_device_id, observed_at, expires_at_instant)
        {
            update_status(shared_status, |status| {
                status
                    .nearby_peers
                    .insert(entry.peer.device_id.clone(), entry);
            });
        }
    }

    fn parse_discovery_beacon(
        bytes: &[u8],
        local_device_id: &str,
        observed_at: DateTime<Utc>,
        expires_at_instant: Instant,
    ) -> Result<Option<DiscoveryPeerEntry>, String> {
        if bytes.len() > DISCOVERY_MAX_PACKET_BYTES {
            return Err("Sync discovery beacon exceeded the maximum packet size.".to_string());
        }
        let payload: DiscoveryBeaconPayload = serde_json::from_slice(bytes)
            .map_err(|error| format!("Could not decode sync discovery beacon: {error}"))?;
        if payload.protocol_version != DISCOVERY_PROTOCOL_VERSION {
            return Ok(None);
        }
        let device_id = required_discovery_string(&payload.device_id, "device_id")?;
        if device_id == local_device_id {
            return Ok(None);
        }
        let observed_at_text = observed_at.to_rfc3339();
        let expires_at =
            observed_at + chrono::Duration::seconds(DISCOVERY_PEER_TTL.as_secs() as i64);
        let peer = SyncTransportNearbyPeer {
            device_id,
            sync_group_id: required_discovery_string(&payload.sync_group_id, "sync_group_id")?,
            display_name: optional_discovery_string(payload.display_name.as_deref()),
            public_key: required_discovery_string(&payload.public_key, "public_key")?,
            endpoint_hints: normalize_advisory_endpoint_hints(payload.endpoint_hints)?,
            protocol_version: payload.protocol_version,
            timestamp: required_discovery_string(&payload.timestamp, "timestamp")?,
            observed_at: observed_at_text,
            expires_at: expires_at.to_rfc3339(),
        };
        Ok(Some(DiscoveryPeerEntry {
            peer,
            expires_at_instant,
        }))
    }

    fn required_discovery_string(value: &str, field: &str) -> Result<String, String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(format!("Sync discovery beacon {field} cannot be empty."));
        }
        if trimmed.len() > 512 {
            return Err(format!("Sync discovery beacon {field} is too long."));
        }
        Ok(trimmed.to_string())
    }

    fn optional_discovery_string(value: Option<&str>) -> Option<String> {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(128).collect())
    }

    fn prune_nearby_peers(status: &mut SharedStatus, now: Instant) {
        status
            .nearby_peers
            .retain(|_, entry| entry.expires_at_instant > now);
    }

    fn nearby_peers_from_status(
        nearby_peers: HashMap<String, DiscoveryPeerEntry>,
    ) -> Vec<SyncTransportNearbyPeer> {
        let mut peers: Vec<SyncTransportNearbyPeer> =
            nearby_peers.into_values().map(|entry| entry.peer).collect();
        peers.sort_by(|left, right| {
            left.display_name
                .as_deref()
                .unwrap_or("")
                .cmp(right.display_name.as_deref().unwrap_or(""))
                .then_with(|| left.device_id.cmp(&right.device_id))
        });
        peers
    }

    fn register_active_run(
        shared_status: &Arc<Mutex<SharedStatus>>,
        run_id: &str,
        peer_device_id: Option<String>,
    ) -> RunCancellationToken {
        let cancel = RunCancellationToken::default();
        update_status(shared_status, |status| {
            status.active_runs.insert(
                run_id.to_string(),
                ActiveSyncRun {
                    peer_device_id,
                    cancel: cancel.clone(),
                    connection: None,
                },
            );
        });
        cancel
    }

    fn attach_active_run_connection(
        shared_status: &Arc<Mutex<SharedStatus>>,
        run_id: &str,
        connection: SharedPeerConnection,
    ) {
        update_status(shared_status, |status| {
            if let Some(active_run) = status.active_runs.get_mut(run_id) {
                active_run.connection = Some(connection);
            }
        });
    }

    fn update_active_run_peer(
        shared_status: &Arc<Mutex<SharedStatus>>,
        run_id: &str,
        peer_device_id: String,
    ) {
        update_status(shared_status, |status| {
            if let Some(active_run) = status.active_runs.get_mut(run_id) {
                active_run.peer_device_id = Some(peer_device_id);
            }
        });
    }

    fn remove_active_run(status: &mut SharedStatus, run_id: &str) {
        status.active_runs.remove(run_id);
    }

    fn active_run_snapshots(status: &SharedStatus) -> Vec<ActiveRunSnapshot> {
        let mut runs = status
            .active_runs
            .iter()
            .map(|(run_id, active_run)| ActiveRunSnapshot {
                run_id: run_id.clone(),
                peer_device_id: active_run.peer_device_id.clone(),
                cancel: active_run.cancel.clone(),
                connection: active_run.connection.clone(),
            })
            .collect::<Vec<_>>();
        runs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        runs
    }

    fn record_lifecycle_event_in_status(
        status: &mut SharedStatus,
        payload: SyncTransportLifecycleEventRequest,
    ) -> LifecycleRecordOutcome {
        let kind = normalize_lifecycle_kind(&payload.kind);
        let active_runs = active_run_snapshots(status);
        let first_run = active_runs.first();
        let interruption_code = lifecycle_interruption_code(&kind).map(str::to_string);
        let retry_guidance = interruption_code
            .as_deref()
            .map(|_| lifecycle_retry_guidance(&kind).to_string());
        let event = SyncTransportLifecycleEvent {
            kind: kind.clone(),
            occurred_at: lifecycle_event_occurred_at(payload.occurred_at),
            message: sanitize_lifecycle_message(payload.message),
            retryable: interruption_code.is_some(),
            interruption_code: interruption_code.clone(),
            retry_guidance: retry_guidance.clone(),
            peer_device_id: first_run.and_then(|run| run.peer_device_id.clone()),
            run_id: first_run.map(|run| run.run_id.clone()),
        };
        push_lifecycle_event(status, event.clone());

        if let Some(code) = interruption_code.as_ref() {
            status.retryable_interruption_code = Some(code.clone());
            status.retryable_interruption_peer_device_id = event.peer_device_id.clone();
            status.retry_guidance = retry_guidance;
        }

        let refresh_endpoint_hints = lifecycle_refreshes_endpoint_hints(&kind);
        if interruption_code.is_none() && refresh_endpoint_hints {
            clear_retryable_interruption(status);
        }
        if refresh_endpoint_hints {
            status.nearby_peers.clear();
        }

        LifecycleRecordOutcome {
            event,
            interrupted_runs: if lifecycle_interruption_code(&kind).is_some() {
                active_runs
            } else {
                Vec::new()
            },
            refresh_endpoint_hints,
        }
    }

    fn lifecycle_event_for_active_run(
        event: &SyncTransportLifecycleEvent,
        active_run: &ActiveRunSnapshot,
    ) -> SyncTransportLifecycleEvent {
        let mut event = event.clone();
        event.peer_device_id = active_run.peer_device_id.clone();
        event.run_id = Some(active_run.run_id.clone());
        event
    }

    fn interrupt_active_runs_for_lifecycle(
        event: &SyncTransportLifecycleEvent,
        active_runs: Vec<ActiveRunSnapshot>,
    ) {
        for active_run in active_runs {
            let event = lifecycle_event_for_active_run(event, &active_run);
            active_run.cancel.interrupt(LifecycleInterruptionEvidence {
                code: event
                    .interruption_code
                    .clone()
                    .unwrap_or_else(|| "lifecycle_interrupted".to_string()),
                guidance: event
                    .retry_guidance
                    .clone()
                    .unwrap_or_else(|| LIFECYCLE_INTERRUPTION_DEFAULT_GUIDANCE.to_string()),
                event,
            });
            if let Some(connection) = active_run.connection {
                connection.abort_for_lifecycle_interruption();
            }
        }
    }

    fn push_lifecycle_event(status: &mut SharedStatus, event: SyncTransportLifecycleEvent) {
        status.lifecycle_events.push(event.clone());
        let overflow = status
            .lifecycle_events
            .len()
            .saturating_sub(LIFECYCLE_EVENT_HISTORY_LIMIT);
        if overflow > 0 {
            status.lifecycle_events.drain(0..overflow);
        }
        status.last_lifecycle_event = Some(event);
    }

    fn normalize_lifecycle_kind(kind: &str) -> String {
        kind.trim()
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect::<String>()
            .split('_')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("_")
    }

    fn lifecycle_event_occurred_at(occurred_at: Option<String>) -> String {
        occurred_at
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| Utc::now().to_rfc3339())
    }

    fn sanitize_lifecycle_message(message: Option<String>) -> Option<String> {
        let message = message?.trim().to_string();
        if message.is_empty()
            || message.len() > 240
            || message.contains('/')
            || message.contains('\\')
            || message.contains("://")
            || message.contains("tuneforge-sync+")
        {
            return None;
        }
        Some(message)
    }

    fn lifecycle_interruption_code(kind: &str) -> Option<&'static str> {
        match kind {
            "sleep" => Some("lifecycle_interrupted_sleep"),
            "network_offline" | "networkoffline" => Some("lifecycle_interrupted_network_offline"),
            "android_background" | "androidbackground" => {
                Some("lifecycle_interrupted_android_background")
            }
            "android_screen_lock" | "androidscreenlock" => {
                Some("lifecycle_interrupted_android_screen_lock")
            }
            _ => None,
        }
    }

    fn lifecycle_retry_guidance(kind: &str) -> &'static str {
        match kind {
            "network_offline" | "networkoffline" => LIFECYCLE_INTERRUPTION_NETWORK_GUIDANCE,
            "android_background"
            | "androidbackground"
            | "android_screen_lock"
            | "androidscreenlock" => LIFECYCLE_INTERRUPTION_FOREGROUND_GUIDANCE,
            _ => LIFECYCLE_INTERRUPTION_DEFAULT_GUIDANCE,
        }
    }

    fn lifecycle_refreshes_endpoint_hints(kind: &str) -> bool {
        matches!(
            kind,
            "wake"
                | "network_online"
                | "networkonline"
                | "foreground"
                | "android_foreground"
                | "androidforeground"
        )
    }

    fn lifecycle_events_for_run(
        shared_status: &Arc<Mutex<SharedStatus>>,
        run_id: &str,
    ) -> Vec<SyncTransportLifecycleEvent> {
        shared_status
            .lock()
            .map(|status| {
                status
                    .lifecycle_events
                    .iter()
                    .filter(|event| event.run_id.as_deref().is_none_or(|id| id == run_id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    fn lifecycle_events_for_interruption(
        shared_status: &Arc<Mutex<SharedStatus>>,
        run_id: &str,
        interruption: &LifecycleInterruptionEvidence,
    ) -> Vec<SyncTransportLifecycleEvent> {
        let mut events = lifecycle_events_for_run(shared_status, run_id);
        let has_interruption = events.iter().any(|event| {
            event.run_id == interruption.event.run_id
                && event.kind == interruption.event.kind
                && event.occurred_at == interruption.event.occurred_at
        });
        if !has_interruption {
            events.push(interruption.event.clone());
        }
        events
    }

    #[derive(Clone)]
    struct IrohTransport {
        endpoint: Endpoint,
        blob_store: IrohBlobStore,
    }

    #[derive(Clone)]
    struct IrohDataConnection {
        connection: Connection,
        runtime_handle: tokio::runtime::Handle,
    }

    enum IrohDataReadPoll {
        Data(usize),
        EndOfStream,
        TimedOut,
    }

    impl IrohTransport {
        fn close(&self) {
            let endpoint = self.endpoint.clone();
            let blob_store = self.blob_store.clone();
            tauri::async_runtime::block_on(async move {
                endpoint.close().await;
                let _ = blob_store.store.shutdown().await;
            });
        }
    }

    #[derive(Clone)]
    struct IrohBlobStore {
        store: FsStore,
    }

    fn create_iroh_transport(
        backend: &BackendAccess,
        device_id: &str,
        tcp_listener_port: u16,
    ) -> Result<IrohTransport, String> {
        let iroh_port = iroh_listener_port(tcp_listener_port)?;
        let data_dir = sync_transport_data_dir(backend)?;
        let iroh_dir = data_dir.join("iroh");
        fs::create_dir_all(&iroh_dir)
            .map_err(|error| format!("Could not create Iroh transport data directory: {error}"))?;
        let secret_key = load_or_create_iroh_secret_key(&iroh_dir)?;
        let blobs_dir = iroh_dir.join("blobs");
        let blob_store = tauri::async_runtime::block_on(FsStore::load(&blobs_dir))
            .map_err(|error| format!("Could not open disk-backed iroh-blobs store: {error}"))?;
        let endpoint = tauri::async_runtime::block_on(async move {
            // Minimal only installs the crypto provider; explicit IP binds keep relay
            // disabled and make direct endpoint hints stable across listener restarts.
            Endpoint::builder(presets::Minimal)
                .clear_ip_transports()
                .clear_relay_transports()
                .bind_addr((Ipv4Addr::UNSPECIFIED, iroh_port))
                .map_err(|error| format!("Could not configure Iroh IPv4 bind: {error}"))?
                .bind_addr_with_opts(
                    (Ipv6Addr::UNSPECIFIED, iroh_port),
                    BindOpts::default().set_is_required(false),
                )
                .map_err(|error| format!("Could not configure Iroh IPv6 bind: {error}"))?
                .transport_config(iroh_lan_transport_config())
                .secret_key(secret_key)
                .alpns(vec![IROH_ALPN.to_vec()])
                .bind()
                .await
                .map_err(|error| {
                    format!(
                        "Could not start local-direct Iroh endpoint on UDP port {iroh_port}: {error}"
                    )
                })
        })?;

        let transport = IrohTransport {
            endpoint,
            blob_store: IrohBlobStore { store: blob_store },
        };
        if iroh_endpoint_hints(&transport, device_id).is_empty() {
            return Err("Local Iroh endpoint did not expose a direct address.".to_string());
        }
        Ok(transport)
    }

    fn iroh_lan_transport_config() -> QuicTransportConfig {
        QuicTransportConfig::builder()
            .stream_receive_window(VarInt::from_u32(IROH_STREAM_RECEIVE_WINDOW_BYTES))
            .receive_window(VarInt::from_u32(IROH_CONNECTION_RECEIVE_WINDOW_BYTES))
            .send_window(IROH_SEND_WINDOW_BYTES)
            .initial_rtt(IROH_INITIAL_RTT)
            .build()
    }

    fn iroh_listener_port(tcp_listener_port: u16) -> Result<u16, String> {
        tcp_listener_port
            .checked_add(IROH_LISTENER_PORT_OFFSET)
            .ok_or_else(|| {
                format!(
                    "Cannot derive stable Iroh UDP port from TCP sync port {tcp_listener_port}."
                )
            })
    }

    fn sync_transport_data_dir(_backend: &BackendAccess) -> Result<PathBuf, String> {
        if let Ok(path) = env::var("TUNEFORGE_SYNC_TRANSPORT_DATA_DIR") {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                return Ok(PathBuf::from(trimmed));
            }
        }
        #[cfg(target_os = "android")]
        {
            return _backend
                .app
                .path()
                .app_data_dir()
                .map(|path| path.join("sync-transport"))
                .map_err(|error| {
                    format!("Could not resolve Android sync transport data directory: {error}")
                });
        }
        #[cfg(not(target_os = "android"))]
        platform_app_data_dir().map(|path| path.join("sync-transport"))
    }

    #[cfg(all(not(target_os = "android"), target_os = "macos"))]
    fn platform_app_data_dir() -> Result<PathBuf, String> {
        home_dir()
            .map(|home| {
                home.join("Library")
                    .join("Application Support")
                    .join("com.tuneforge.desktop")
            })
            .ok_or_else(|| {
                "Could not resolve the home directory for Iroh transport state.".to_string()
            })
    }

    #[cfg(all(not(target_os = "android"), target_os = "windows"))]
    fn platform_app_data_dir() -> Result<PathBuf, String> {
        env::var("APPDATA")
            .map(|path| PathBuf::from(path).join("com.tuneforge.desktop"))
            .map_err(|_| "Could not resolve APPDATA for Iroh transport state.".to_string())
    }

    #[cfg(all(
        not(target_os = "android"),
        not(target_os = "macos"),
        not(target_os = "windows")
    ))]
    fn platform_app_data_dir() -> Result<PathBuf, String> {
        if let Ok(path) = env::var("XDG_DATA_HOME") {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                return Ok(PathBuf::from(trimmed).join("com.tuneforge.desktop"));
            }
        }
        home_dir()
            .map(|home| {
                home.join(".local")
                    .join("share")
                    .join("com.tuneforge.desktop")
            })
            .ok_or_else(|| {
                "Could not resolve the home directory for Iroh transport state.".to_string()
            })
    }

    #[cfg(not(target_os = "android"))]
    fn home_dir() -> Option<PathBuf> {
        env::var("HOME")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    }

    fn load_or_create_iroh_secret_key(iroh_dir: &Path) -> Result<SecretKey, String> {
        let key_path = iroh_dir.join("endpoint.key");
        match fs::read_to_string(&key_path) {
            Ok(value) => {
                let bytes = decode_urlsafe_key(value.trim())?;
                let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
                    "Persisted Iroh endpoint key must decode to 32 bytes.".to_string()
                })?;
                Ok(SecretKey::from_bytes(&bytes))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let secret_key = SecretKey::generate();
                let encoded = encode_urlsafe_key(secret_key.to_bytes());
                fs::write(&key_path, encoded)
                    .map_err(|error| format!("Could not persist Iroh endpoint key: {error}"))?;
                set_owner_only_file_permissions(&key_path);
                Ok(secret_key)
            }
            Err(error) => Err(format!(
                "Could not read persisted Iroh endpoint key: {error}"
            )),
        }
    }

    #[cfg(unix)]
    fn set_owner_only_file_permissions(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }

    #[cfg(not(unix))]
    fn set_owner_only_file_permissions(_path: &Path) {}

    fn accept_loop(
        listener: TcpListener,
        backend: BackendAccess,
        stop: Arc<AtomicBool>,
        shared_status: Arc<Mutex<SharedStatus>>,
        endpoint_hints: Vec<String>,
    ) {
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, address)) => {
                    let backend = backend.clone();
                    let shared_status = Arc::clone(&shared_status);
                    let endpoint_hints = endpoint_hints.clone();
                    update_status(&shared_status, |status| {
                        status.accepted_sessions += 1;
                        status.last_status =
                            Some(format!("Accepted sync peer session from {address}."));
                        status.last_error = None;
                        status.last_sync = None;
                    });
                    thread::spawn(move || match TcpPeerStream::new(stream) {
                        Ok(stream) => handle_incoming_session(
                            backend,
                            TransportKind::Tcp,
                            Box::new(stream),
                            None,
                            shared_status,
                            endpoint_hints,
                        ),
                        Err(error) => {
                            update_status(&shared_status, |status| {
                                status.failed_sessions += 1;
                                status.last_error = Some(error);
                            });
                        }
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(ACCEPT_SLEEP);
                }
                Err(error) => {
                    update_status(&shared_status, |status| {
                        status.failed_sessions += 1;
                        status.last_error =
                            Some(format!("Sync transport listener accept failed: {error}"));
                    });
                    thread::sleep(ACCEPT_SLEEP);
                }
            }
        }
    }

    fn iroh_accept_loop(
        transport: IrohTransport,
        backend: BackendAccess,
        stop: Arc<AtomicBool>,
        shared_status: Arc<Mutex<SharedStatus>>,
        endpoint_hints: Vec<String>,
    ) {
        tauri::async_runtime::block_on(async move {
            while !stop.load(Ordering::SeqCst) {
                match tokio::time::timeout(ACCEPT_SLEEP, transport.endpoint.accept()).await {
                    Ok(Some(incoming)) => {
                        let backend = backend.clone();
                        let shared_status = Arc::clone(&shared_status);
                        let endpoint_hints = endpoint_hints.clone();
                        update_status(&shared_status, |status| {
                            status.accepted_sessions += 1;
                            status.last_status =
                                Some("Accepted Iroh sync peer session.".to_string());
                            status.last_error = None;
                            status.last_sync = None;
                        });
                        tauri::async_runtime::spawn(async move {
                            let stream = match incoming.await {
                                Ok(connection) => {
                                    let runtime_handle = tokio::runtime::Handle::current();
                                    let iroh_data = IrohDataConnection {
                                        connection: connection.clone(),
                                        runtime_handle: runtime_handle.clone(),
                                    };
                                    match connection.accept_bi().await {
                                        Ok((send, recv)) => Ok((
                                            Box::new(IrohPeerStream::new(
                                                send,
                                                recv,
                                                runtime_handle,
                                            ))
                                                as Box<dyn PeerStream>,
                                            iroh_data,
                                        )),
                                        Err(error) => Err(format!(
                                            "Could not accept Iroh sync stream: {error}"
                                        )),
                                    }
                                }
                                Err(error) => {
                                    Err(format!("Could not accept Iroh sync connection: {error}"))
                                }
                            };
                            match stream {
                                Ok((stream, iroh_data)) => {
                                    let session_status = Arc::clone(&shared_status);
                                    let error_status = Arc::clone(&shared_status);
                                    let join = tauri::async_runtime::spawn_blocking(move || {
                                        handle_incoming_session(
                                            backend,
                                            TransportKind::Iroh,
                                            stream,
                                            Some(iroh_data),
                                            session_status,
                                            endpoint_hints,
                                        );
                                    });
                                    if let Err(error) = join.await {
                                        update_status(&error_status, |status| {
                                            status.failed_sessions += 1;
                                            status.last_error = Some(format!(
                                                "Iroh sync session task failed: {error}"
                                            ));
                                        });
                                    }
                                }
                                Err(error) => {
                                    update_status(&shared_status, |status| {
                                        status.failed_sessions += 1;
                                        status.last_error = Some(error);
                                    });
                                }
                            }
                        });
                    }
                    Ok(None) => break,
                    Err(_) => {}
                }
            }
        });
    }

    fn connect_selected_transport(
        selection: &mut TransportSelection,
        local_iroh: Option<IrohTransport>,
        peer_device_id: &str,
    ) -> Result<SecurePeerConnection, String> {
        match selection.selected {
            TransportKind::Tcp => connect_tcp_peer_connection(
                selection.endpoint_hint().ok_or_else(|| {
                    "Selected sync transport did not include a TCP endpoint hint.".to_string()
                })?,
                peer_device_id,
            ),
            TransportKind::Iroh => {
                let Some(transport) = local_iroh else {
                    return Err("Selected Iroh sync transport is not running locally.".to_string());
                };
                connect_iroh_selection_with_fallback(selection, peer_device_id, |endpoint_addr| {
                    connect_iroh_peer_connection(&transport, endpoint_addr)
                })
            }
            TransportKind::Other(_) => Err("Selected sync transport is unsupported.".to_string()),
        }
    }

    fn connect_iroh_selection_with_fallback(
        selection: &mut TransportSelection,
        peer_device_id: &str,
        connect_iroh_endpoint: impl FnOnce(EndpointAddr) -> Result<SecurePeerConnection, String>,
    ) -> Result<SecurePeerConnection, String> {
        let hint = selection.endpoint_hint().ok_or_else(|| {
            "Selected sync transport did not include an Iroh endpoint hint.".to_string()
        })?;
        let endpoint_addr = parse_iroh_endpoint_hint(hint, Some(peer_device_id))?;
        match connect_iroh_endpoint(endpoint_addr) {
            Ok(connection) => Ok(connection),
            Err(error) => {
                selection.record_iroh_connect_fallback(format!(
                    "Iroh sync transport was unavailable ({error}); using {TCP_TRANSPORT_ID}."
                ))?;
                connect_tcp_peer_connection(
                    selection.endpoint_hint().ok_or_else(|| {
                        "Iroh fallback did not include a TCP endpoint hint.".to_string()
                    })?,
                    peer_device_id,
                )
            }
        }
    }

    fn connect_tcp_peer_connection(
        endpoint_hint: &str,
        peer_device_id: &str,
    ) -> Result<SecurePeerConnection, String> {
        let endpoint = parse_endpoint_hint(endpoint_hint, Some(peer_device_id))?;
        let stream = TcpStream::connect_timeout(&endpoint, CONNECT_TIMEOUT)
            .map_err(|error| format!("Could not connect to sync peer at {endpoint}: {error}"))?;
        let stream = TcpPeerStream::new(stream)?;
        SecurePeerConnection::connect_initiator(Box::new(stream), TransportKind::Tcp, None)
    }

    fn authenticated_hints_make_trusted_iroh_hint_stale(
        trusted_endpoint_hints: &[String],
        authenticated_endpoint_hints: &[String],
    ) -> bool {
        let Some(authenticated_iroh_hint) = first_iroh_hint(authenticated_endpoint_hints) else {
            return false;
        };
        first_iroh_hint(trusted_endpoint_hints) != Some(authenticated_iroh_hint)
    }

    fn first_iroh_hint(endpoint_hints: &[String]) -> Option<&str> {
        endpoint_hints
            .iter()
            .find(|hint| hint.starts_with(IROH_ENDPOINT_SCHEME))
            .map(String::as_str)
    }

    fn refresh_authenticated_endpoint_hints(
        client: &BackendClient,
        peer_device_id: &str,
        endpoint_hints: &[String],
    ) {
        if endpoint_hints.is_empty() {
            return;
        }
        let _ = client.refresh_trusted_peer_endpoint_hints(peer_device_id, endpoint_hints);
    }

    fn connect_iroh_peer_connection(
        transport: &IrohTransport,
        endpoint_addr: EndpointAddr,
    ) -> Result<SecurePeerConnection, String> {
        let endpoint = transport.endpoint.clone();
        let (connection, send, recv, runtime_handle) =
            tauri::async_runtime::block_on(async move {
                let runtime_handle = tokio::runtime::Handle::current();
                let connection = tokio::time::timeout(
                    CONNECT_TIMEOUT,
                    endpoint.connect(endpoint_addr, IROH_ALPN),
                )
                .await
                .map_err(|_| "Timed out connecting to Iroh sync peer.".to_string())?
                .map_err(|error| format!("Could not connect to Iroh sync peer: {error}"))?;
                let (send, recv) = tokio::time::timeout(CONNECT_TIMEOUT, connection.open_bi())
                    .await
                    .map_err(|_| "Timed out opening Iroh sync stream.".to_string())?
                    .map_err(|error| format!("Could not open Iroh sync stream: {error}"))?;
                Ok::<_, String>((connection, send, recv, runtime_handle))
            })?;
        let iroh_data = IrohDataConnection {
            connection,
            runtime_handle: runtime_handle.clone(),
        };
        SecurePeerConnection::connect_initiator(
            Box::new(IrohPeerStream::new(send, recv, runtime_handle)),
            TransportKind::Iroh,
            Some(iroh_data),
        )
    }

    fn handle_incoming_session(
        backend: BackendAccess,
        transport: TransportKind,
        stream: Box<dyn PeerStream>,
        iroh_data: Option<IrohDataConnection>,
        shared_status: Arc<Mutex<SharedStatus>>,
        endpoint_hints: Vec<String>,
    ) {
        let run_id = sync_run_id();
        let run_started_at = Utc::now();
        let run_started_instant = Instant::now();
        let run_cancel = register_active_run(&shared_status, &run_id, None);
        record_active_progress(
            &shared_status,
            &run_id,
            active_progress(protocol_status_payload(
                run_id.clone(),
                "peer_authentication",
                "Authenticating sync peer.",
                run_started_at.to_rfc3339(),
                0,
            )),
        );
        update_status(&shared_status, |status| {
            status.active_sessions += 1;
        });
        let transport_for_result = transport.clone();
        let result = serve_incoming_session(
            backend,
            transport,
            stream,
            iroh_data,
            endpoint_hints,
            Arc::clone(&shared_status),
            run_id.clone(),
            run_cancel.clone(),
            run_started_at,
            run_started_instant,
        );
        let result = match (result, run_cancel.interruption()) {
            (Err(_), Some(interruption)) => {
                let peer_device_id = interruption
                    .event
                    .peer_device_id
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string());
                let sync_result = lifecycle_interrupted_sync_result(
                    run_id.clone(),
                    peer_device_id.clone(),
                    peer_device_id.clone(),
                    transport_for_result.id().to_string(),
                    vec![transport_for_result.id().to_string()],
                    interruption,
                    lifecycle_events_for_run(&shared_status, &run_id),
                    run_started_at,
                    run_started_instant,
                    Vec::new(),
                    0,
                    SyncRunMetrics::start(run_started_instant),
                    Vec::new(),
                );
                Ok(IncomingSessionResult {
                    message: sync_result.message.clone(),
                    sync_result,
                })
            }
            (result, _) => result,
        };
        update_status(&shared_status, |status| {
            apply_incoming_session_status_result(status, result, &run_id);
        });
    }

    fn apply_incoming_session_status_result(
        status: &mut SharedStatus,
        result: Result<IncomingSessionResult, IncomingSessionHardFailure>,
        run_id: &str,
    ) {
        status.active_sessions = status.active_sessions.saturating_sub(1);
        remove_active_run(status, run_id);
        clear_active_progress_for_run(status, run_id);
        match result {
            Ok(result) => {
                status.last_status = Some(result.message);
                let sync_result = result.sync_result;
                if !sync_result_has_retryable_interruption(&sync_result) {
                    clear_retryable_interruption(status);
                }
                status.last_sync = Some(sync_result);
                status.last_error = None;
            }
            Err(failure) => {
                let IncomingSessionHardFailure {
                    error: _raw_error,
                    sync_result,
                } = failure;
                status.failed_sessions += 1;
                status.last_status = Some(sync_result.message.clone());
                status.last_sync = Some(sync_result.clone());
                status.last_error = Some(sync_result.message);
            }
        }
    }

    fn serve_incoming_session(
        backend: BackendAccess,
        transport: TransportKind,
        stream: Box<dyn PeerStream>,
        iroh_data: Option<IrohDataConnection>,
        endpoint_hints: Vec<String>,
        shared_status: Arc<Mutex<SharedStatus>>,
        run_id: String,
        run_cancel: RunCancellationToken,
        run_started_at: DateTime<Utc>,
        run_started_instant: Instant,
    ) -> Result<IncomingSessionResult, IncomingSessionHardFailure> {
        let mut timings = Vec::new();
        let mut metrics = SyncRunMetrics::start(run_started_instant);
        let transport_for_failure = transport.clone();
        let client = BackendClient::new(&backend).map_err(|error| {
            incoming_session_hard_failure(
                error,
                &run_id,
                "unknown",
                "unknown",
                TransportSelection::single(transport_for_failure.clone()).evidence(),
                &run_started_at,
                run_started_instant,
                &[],
                0,
                &metrics,
                &timings,
                0,
                0,
                Vec::new(),
            )
        })?;
        let timer = SyncPhaseTimer::start("peer_authentication");
        let mut connection =
            match SecurePeerConnection::connect_responder(stream, transport, iroh_data) {
                Ok(connection) => connection,
                Err(error) => {
                    let failure_timings =
                        sync_now_failure_timings_with_finished_timer(&timings, timer);
                    return Err(incoming_session_hard_failure(
                        error,
                        &run_id,
                        "unknown",
                        "unknown",
                        TransportSelection::single(transport_for_failure.clone()).evidence(),
                        &run_started_at,
                        run_started_instant,
                        &[],
                        0,
                        &metrics,
                        &failure_timings,
                        0,
                        0,
                        Vec::new(),
                    ));
                }
            };
        let session = match authenticate_session(&mut connection, &client, None, &endpoint_hints) {
            Ok(session) => session,
            Err(error) => {
                let failure_timings = sync_now_failure_timings_with_finished_timer(&timings, timer);
                return Err(incoming_session_hard_failure(
                    phase_context_error("peer authentication", error),
                    &run_id,
                    "unknown",
                    "unknown",
                    TransportSelection::single(transport_for_failure.clone()).evidence(),
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &failure_timings,
                    0,
                    0,
                    Vec::new(),
                ));
            }
        };
        update_active_run_peer(&shared_status, &run_id, session.remote_device_id.clone());
        if let Err(error) = connection.set_established_read_timeout() {
            let failure_timings = sync_now_failure_timings_with_finished_timer(&timings, timer);
            return Err(incoming_session_hard_failure(
                error,
                &run_id,
                &session.remote_device_id,
                &session.remote_device_id,
                TransportSelection::single(transport_for_failure.clone()).evidence(),
                &run_started_at,
                run_started_instant,
                &[],
                0,
                &metrics,
                &failure_timings,
                0,
                0,
                Vec::new(),
            ));
        }
        timings.push(timer.finish());
        let connection = SharedPeerConnection::new(connection);
        attach_active_run_connection(&shared_status, &run_id, connection.clone());
        let progress = ProgressReporter::new(
            run_id.clone(),
            run_started_instant,
            shared_status,
            connection.clone(),
            run_cancel.clone(),
        );
        let timer = SyncPhaseTimer::start("manifest_exchange");
        let remote_message = match connection
            .read_message_accepting_status_for_phase("manifest exchange", &progress)
        {
            Ok(message) => message,
            Err(error) => {
                let failure_timings = sync_now_failure_timings_with_finished_timer(&timings, timer);
                return Err(incoming_session_hard_failure(
                    error,
                    &run_id,
                    &session.remote_device_id,
                    &session.remote_device_id,
                    TransportSelection::single(connection.transport()).evidence(),
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &failure_timings,
                    0,
                    0,
                    Vec::new(),
                ));
            }
        };
        let remote_offer = match remote_message {
            ProtocolMessage::ManifestOffer(offer) => offer,
            ProtocolMessage::Error(error) => {
                let failure_timings = sync_now_failure_timings_with_finished_timer(&timings, timer);
                return Err(incoming_session_hard_failure(
                    phase_context_error(
                        "manifest exchange",
                        format!("Sync peer returned an error: {}", error.message),
                    ),
                    &run_id,
                    &session.remote_device_id,
                    &session.remote_device_id,
                    TransportSelection::single(connection.transport()).evidence(),
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &failure_timings,
                    0,
                    0,
                    Vec::new(),
                ));
            }
            other => {
                let failure_timings = sync_now_failure_timings_with_finished_timer(&timings, timer);
                return Err(incoming_session_hard_failure(
                    format!(
                        "Sync peer sent unexpected first sync message: {}",
                        other.kind()
                    ),
                    &run_id,
                    &session.remote_device_id,
                    &session.remote_device_id,
                    TransportSelection::single(connection.transport()).evidence(),
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &failure_timings,
                    0,
                    0,
                    Vec::new(),
                ));
            }
        };
        timings.push(timer.finish());
        let timer = SyncPhaseTimer::start("local_manifest_export");
        let local_offer = {
            let _progress =
                progress.start_phase("local_manifest_export", "Exporting local sync manifests.");
            load_local_manifest_offer(&client, None, true)
        };
        timings.push(timer.finish());
        let local_manifest_count = local_offer.project_manifests.len();
        if let Err(error) = connection.send_message_for_phase(
            "manifest exchange",
            &ProtocolMessage::ManifestOffer(local_offer.clone()),
        ) {
            return Err(incoming_session_hard_failure(
                error,
                &run_id,
                &session.remote_device_id,
                &session.remote_device_id,
                TransportSelection::single(connection.transport()).evidence(),
                &run_started_at,
                run_started_instant,
                &[],
                0,
                &metrics,
                &timings,
                local_manifest_count,
                remote_offer.project_manifests.len(),
                Vec::new(),
            ));
        }

        let timer = SyncPhaseTimer::start("serve_artifact_requests");
        let served_artifact_requests = match serve_artifact_requests_until_done(
            &client,
            &connection,
            &local_offer.project_manifests,
            &mut metrics,
            &progress,
        ) {
            Ok(served_artifact_requests) => served_artifact_requests,
            Err(error) => {
                let failure_timings = sync_now_failure_timings_with_finished_timer(&timings, timer);
                return Err(incoming_session_hard_failure(
                    error,
                    &run_id,
                    &session.remote_device_id,
                    &session.remote_device_id,
                    TransportSelection::single(connection.transport()).evidence(),
                    &run_started_at,
                    run_started_instant,
                    &[],
                    0,
                    &metrics,
                    &failure_timings,
                    local_manifest_count,
                    remote_offer.project_manifests.len(),
                    Vec::new(),
                ));
            }
        };
        timings.push(timer.finish());
        let transport_id = connection.transport_id();
        let prepared_remote_import = stage_remote_manifest_artifacts(
            &client,
            &connection,
            &session.remote_device_id,
            &remote_offer.metadata,
            &remote_offer.project_manifests,
            transport_id,
            &mut metrics,
            &mut timings,
            &progress,
        );
        if let Err(error) = connection.send_message_for_phase(
            "reconciliation apply",
            &ProtocolMessage::PhaseDone {
                phase: "responder_import".to_string(),
            },
        ) {
            let received_artifacts = prepared_remote_import.received_artifacts.clone();
            finish_staged_remote_import_for_failure(Some(prepared_remote_import));
            return Err(incoming_session_hard_failure(
                error,
                &run_id,
                &session.remote_device_id,
                &session.remote_device_id,
                TransportSelection::single(connection.transport()).evidence(),
                &run_started_at,
                run_started_instant,
                &received_artifacts,
                served_artifact_requests,
                &metrics,
                &timings,
                local_manifest_count,
                remote_offer.project_manifests.len(),
                Vec::new(),
            ));
        }
        let received_artifacts = prepared_remote_import.received_artifacts.clone();
        let imported_projects = finish_staged_remote_import(prepared_remote_import, &mut timings);
        let import_counts = import_outcome_counts(&imported_projects);

        let message = format!(
            "Sync session with {} completed: served {} artifact request(s), imported {} project(s), skipped {} project(s), failed {} project(s), offered {} local manifest(s).",
            session.remote_device_id,
            served_artifact_requests,
            import_counts.imported,
            import_counts.skipped,
            import_counts.failed,
            local_manifest_count
        );
        let manifest_errors =
            sync_manifest_errors(&local_offer.manifest_errors, &remote_offer.manifest_errors);
        let completed_at = Utc::now();
        let duration_ms = duration_millis(run_started_instant.elapsed());
        let transfer_counts = transfer_counts(&received_artifacts);
        let project_results = imported_projects.clone();
        let TransportEvidence {
            selected_transport,
            fallback_reason,
            fallback_code,
            attempted_transports,
        } = TransportSelection::single(connection.transport()).evidence();
        refresh_authenticated_endpoint_hints(
            &client,
            &session.remote_device_id,
            &session.remote_endpoint_hints,
        );
        let sync_result = SyncTransportSyncResult {
            run_id,
            peer_device_id: session.remote_device_id.clone(),
            remote_device_id: session.remote_device_id,
            status: sync_result_status(&manifest_errors, import_counts.failed),
            message: sync_result_message(
                local_manifest_count,
                remote_offer.project_manifests.len(),
                &transfer_counts,
                import_counts,
            ),
            selected_transport,
            fallback_reason,
            fallback_code,
            attempted_transports,
            started_at: run_started_at.to_rfc3339(),
            completed_at: completed_at.to_rfc3339(),
            duration_ms,
            project_results,
            imported_projects,
            imported_project_count: import_counts.imported,
            skipped_project_count: import_counts.skipped,
            failed_project_count: import_counts.failed,
            received_artifacts,
            transfer_counts,
            served_artifact_requests,
            total_received_bytes: metrics.total_received_bytes,
            total_served_bytes: metrics.total_served_bytes,
            time_to_first_artifact_ms: metrics.time_to_first_artifact_ms(),
            throughput_bytes_per_second: metrics
                .throughput_bytes_per_second(run_started_instant.elapsed()),
            scratch_peak_bytes: metrics.scratch_peak_bytes,
            staging_peak_bytes: metrics.staging_peak_bytes,
            max_active_streams: metrics.max_active_streams,
            credit_grants: metrics.credit_grants,
            credit_revokes: metrics.credit_revokes,
            remote_manifest_count: remote_offer.project_manifests.len(),
            local_manifest_count,
            manifest_errors,
            lifecycle_events: Vec::new(),
            retryable_interruption_code: None,
            retry_guidance: None,
            phase_timings: timings,
            diagnostics: metrics.diagnostics,
        };

        Ok(IncomingSessionResult {
            message,
            sync_result,
        })
    }

    fn update_status(
        shared_status: &Arc<Mutex<SharedStatus>>,
        update: impl FnOnce(&mut SharedStatus),
    ) {
        if let Ok(mut status) = shared_status.lock() {
            update(&mut status);
        }
    }

    struct SyncPhaseTimer {
        phase: String,
        project_id: Option<String>,
        artifact_id: Option<String>,
        started_at: DateTime<Utc>,
        started_instant: Instant,
    }

    impl SyncPhaseTimer {
        fn start(phase: impl Into<String>) -> Self {
            Self::start_scoped(phase, None, None)
        }

        fn start_project(phase: impl Into<String>, project_id: &str) -> Self {
            Self::start_scoped(phase, Some(project_id.to_string()), None)
        }

        fn start_artifact(phase: impl Into<String>, artifact: &RemoteArtifact) -> Self {
            Self::start_scoped(
                phase,
                Some(artifact.project_id.clone()),
                Some(artifact.artifact_id.clone()),
            )
        }

        fn start_scoped(
            phase: impl Into<String>,
            project_id: Option<String>,
            artifact_id: Option<String>,
        ) -> Self {
            Self {
                phase: phase.into(),
                project_id,
                artifact_id,
                started_at: Utc::now(),
                started_instant: Instant::now(),
            }
        }

        fn finish(self) -> SyncTransportTimingEvidence {
            let completed_at = Utc::now();
            SyncTransportTimingEvidence {
                phase: self.phase,
                project_id: self.project_id,
                artifact_id: self.artifact_id,
                started_at: self.started_at.to_rfc3339(),
                completed_at: completed_at.to_rfc3339(),
                duration_ms: duration_millis(self.started_instant.elapsed()),
            }
        }
    }

    fn duration_millis(duration: Duration) -> u64 {
        duration.as_millis().min(u128::from(u64::MAX)) as u64
    }

    fn phase_context_error(phase: &str, error: String) -> String {
        let failed_prefix = format!("Sync transport {phase} failed:");
        let stalled_prefix = format!("Sync transport {phase} stalled:");
        if error.starts_with(&failed_prefix) || error.starts_with(&stalled_prefix) {
            return error;
        }
        let lower = error.to_ascii_lowercase();
        let outcome = if lower.contains("timed out") || lower.contains("timeout") {
            "stalled"
        } else {
            "failed"
        };
        format!("Sync transport {phase} {outcome}: {error}")
    }

    fn read_message_accepting_status(
        phase: &str,
        mut read_next: impl FnMut() -> Result<ProtocolMessage, String>,
        mut record_status: impl FnMut(ProtocolStatusPayload),
    ) -> Result<ProtocolMessage, String> {
        loop {
            let message = read_next().map_err(|error| phase_context_error(phase, error))?;
            match split_protocol_status(message) {
                Ok(status) => record_status(status),
                Err(message) => return Ok(message),
            }
        }
    }

    fn active_progress(status: ProtocolStatusPayload) -> SyncTransportActiveProgress {
        SyncTransportActiveProgress {
            run_id: status.run_id,
            phase: status.phase,
            message: status.message,
            progress_at: status.progress_at,
            elapsed_ms: status.elapsed_ms,
        }
    }

    fn record_active_progress(
        shared_status: &Arc<Mutex<SharedStatus>>,
        owner_run_id: &str,
        progress: SyncTransportActiveProgress,
    ) {
        update_status(shared_status, |status| {
            status.active_progress = Some(progress);
            status.active_progress_owner_run_id = Some(owner_run_id.to_string());
        });
    }

    fn clear_active_progress_for_run(status: &mut SharedStatus, run_id: &str) {
        let progress_matches_run = status
            .active_progress
            .as_ref()
            .is_some_and(|progress| progress.run_id == run_id);
        let owner_matches_run = status.active_progress_owner_run_id.as_deref() == Some(run_id);
        if progress_matches_run || owner_matches_run {
            status.active_progress = None;
            status.active_progress_owner_run_id = None;
        }
    }

    fn clear_retryable_interruption(status: &mut SharedStatus) {
        status.retryable_interruption_code = None;
        status.retryable_interruption_peer_device_id = None;
        status.retry_guidance = None;
    }

    fn sync_result_has_retryable_interruption(sync_result: &SyncTransportSyncResult) -> bool {
        sync_result.retryable_interruption_code.is_some()
            || sync_result
                .lifecycle_events
                .iter()
                .any(|event| event.retryable)
    }

    fn apply_sync_now_status_result(
        status: &mut SharedStatus,
        result: &Result<SyncTransportSyncResult, SyncNowHardFailure>,
        run_id: &str,
    ) {
        match result {
            Ok(sync_result) => {
                status.last_status = Some(sync_result.message.clone());
                status.last_sync = Some(sync_result.clone());
                status.last_error = None;
                if !sync_result_has_retryable_interruption(sync_result) {
                    clear_retryable_interruption(status);
                }
                remove_active_run(status, &sync_result.run_id);
                clear_active_progress_for_run(status, &sync_result.run_id);
            }
            Err(failure) => {
                let SyncNowHardFailure {
                    error: _raw_error,
                    sync_result,
                } = failure;
                status.last_status = Some(sync_result.message.clone());
                status.last_sync = Some(sync_result.clone());
                status.last_error = Some(sync_result.message.clone());
                remove_active_run(status, run_id);
                clear_active_progress_for_run(status, run_id);
            }
        }
    }

    #[derive(Clone)]
    struct ProgressReporter {
        run_id: String,
        run_started_instant: Instant,
        shared_status: Arc<Mutex<SharedStatus>>,
        connection: SharedPeerConnection,
        cancel: RunCancellationToken,
    }

    impl ProgressReporter {
        fn new(
            run_id: String,
            run_started_instant: Instant,
            shared_status: Arc<Mutex<SharedStatus>>,
            connection: SharedPeerConnection,
            cancel: RunCancellationToken,
        ) -> Self {
            Self {
                run_id,
                run_started_instant,
                shared_status,
                connection,
                cancel,
            }
        }

        fn start_phase(
            &self,
            phase: impl Into<String>,
            message: impl Into<String>,
        ) -> ProgressScope {
            let phase = phase.into();
            let message = message.into();
            self.report_local_progress(&phase, &message);

            let reporter = self.clone();
            let ticker_phase = phase.clone();
            let ticker_message = message.clone();
            let (stop_sender, stop_receiver) = mpsc::channel();
            thread::spawn(move || loop {
                match stop_receiver.recv_timeout(STATUS_HEARTBEAT_INTERVAL) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        reporter.report_local_progress_if_connection_ready(
                            &ticker_phase,
                            &ticker_message,
                        );
                    }
                }
            });

            ProgressScope {
                stop_sender: Some(stop_sender),
            }
        }

        fn report_local_progress(&self, phase: &str, message: &str) {
            let payload = self.local_status_payload(phase, message);
            record_active_progress(
                &self.shared_status,
                &self.run_id,
                active_progress(payload.clone()),
            );
            let _ = self
                .connection
                .send_message_for_phase("status heartbeat", &protocol_status_message(payload));
        }

        fn report_local_progress_if_connection_ready(&self, phase: &str, message: &str) {
            let payload = self.local_status_payload(phase, message);
            record_active_progress(
                &self.shared_status,
                &self.run_id,
                active_progress(payload.clone()),
            );
            let _ = self
                .connection
                .try_send_message_for_phase("status heartbeat", &protocol_status_message(payload));
        }

        fn local_status_payload(&self, phase: &str, message: &str) -> ProtocolStatusPayload {
            protocol_status_payload(
                self.run_id.clone(),
                phase.to_string(),
                message.to_string(),
                Utc::now().to_rfc3339(),
                duration_millis(self.run_started_instant.elapsed()),
            )
        }

        fn record_peer_status(&self, status: ProtocolStatusPayload) {
            record_active_progress(&self.shared_status, &self.run_id, active_progress(status));
        }

        fn is_cancelled(&self) -> bool {
            self.cancel.is_cancelled()
        }

        fn interruption(&self) -> Option<LifecycleInterruptionEvidence> {
            self.cancel.interruption()
        }

        fn interruption_message(&self) -> Option<String> {
            self.interruption().map(|interruption| {
                format!(
                    "Sync interrupted by lifecycle event {}. {}",
                    interruption.event.kind, interruption.guidance
                )
            })
        }

        fn check_not_cancelled(&self) -> Result<(), String> {
            match self.interruption_message() {
                Some(message) => Err(message),
                None => Ok(()),
            }
        }

        fn cancel_token(&self) -> RunCancellationToken {
            self.cancel.clone()
        }
    }

    struct ProgressScope {
        stop_sender: Option<mpsc::Sender<()>>,
    }

    impl Drop for ProgressScope {
        fn drop(&mut self) {
            if let Some(stop_sender) = self.stop_sender.take() {
                let _ = stop_sender.send(());
            }
        }
    }

    fn throughput_bytes_per_second(bytes: u64, duration: Duration) -> f64 {
        if bytes == 0 {
            return 0.0;
        }
        let seconds = duration.as_secs_f64();
        if seconds <= 0.0 {
            0.0
        } else {
            bytes as f64 / seconds
        }
    }

    #[derive(Clone, Debug)]
    struct SyncRunMetrics {
        started_instant: Instant,
        total_received_bytes: u64,
        total_served_bytes: u64,
        first_artifact_at: Option<Duration>,
        scratch_peak_bytes: u64,
        staging_peak_bytes: u64,
        max_active_streams: u64,
        credit_grants: u64,
        credit_revokes: u64,
        diagnostics: SyncTransportDiagnostics,
    }

    impl SyncRunMetrics {
        fn start(started_instant: Instant) -> Self {
            Self {
                started_instant,
                total_received_bytes: 0,
                total_served_bytes: 0,
                first_artifact_at: None,
                scratch_peak_bytes: 0,
                staging_peak_bytes: 0,
                max_active_streams: 0,
                credit_grants: 0,
                credit_revokes: 0,
                diagnostics: SyncTransportDiagnostics::default(),
            }
        }

        fn record_received_artifact_bytes(&mut self, bytes: u64) {
            self.total_received_bytes = self.total_received_bytes.saturating_add(bytes);
            self.record_first_artifact_bytes(bytes);
        }

        fn record_received_artifact_bytes_at(
            &mut self,
            bytes: u64,
            first_bytes_at: Option<Duration>,
        ) {
            self.total_received_bytes = self.total_received_bytes.saturating_add(bytes);
            self.record_first_artifact_bytes_at(bytes, first_bytes_at);
        }

        fn record_served_artifact_bytes(&mut self, bytes: u64) {
            self.total_served_bytes = self.total_served_bytes.saturating_add(bytes);
            self.record_first_artifact_bytes(bytes);
        }

        fn record_served_artifact_bytes_at(
            &mut self,
            bytes: u64,
            first_bytes_at: Option<Duration>,
        ) {
            self.total_served_bytes = self.total_served_bytes.saturating_add(bytes);
            self.record_first_artifact_bytes_at(bytes, first_bytes_at);
        }

        fn record_scratch_peak_bytes(&mut self, bytes: u64) {
            self.scratch_peak_bytes = self.scratch_peak_bytes.max(bytes);
        }

        fn record_staging_peak_bytes(&mut self, bytes: u64) {
            self.staging_peak_bytes = self.staging_peak_bytes.max(bytes);
        }

        fn record_max_active_streams(&mut self, active_streams: usize) {
            self.max_active_streams = self.max_active_streams.max(active_streams as u64);
        }

        fn record_credit_grants(&mut self, count: usize) {
            self.credit_grants = self.credit_grants.saturating_add(count as u64);
        }

        fn record_credit_revokes(&mut self, count: usize) {
            self.credit_revokes = self.credit_revokes.saturating_add(count as u64);
        }

        fn record_diagnostics(&mut self, diagnostics: &SyncTransportDiagnostics) {
            self.diagnostics.merge_from(diagnostics);
        }

        fn record_first_artifact_bytes(&mut self, bytes: u64) {
            if bytes > 0 && self.first_artifact_at.is_none() {
                self.first_artifact_at = Some(self.started_instant.elapsed());
            }
        }

        fn record_first_artifact_bytes_at(&mut self, bytes: u64, first_bytes_at: Option<Duration>) {
            if bytes == 0 {
                return;
            }
            match (self.first_artifact_at, first_bytes_at) {
                (None, Some(first_bytes_at)) => self.first_artifact_at = Some(first_bytes_at),
                (Some(existing), Some(first_bytes_at)) if first_bytes_at < existing => {
                    self.first_artifact_at = Some(first_bytes_at);
                }
                (None, None) => self.first_artifact_at = Some(self.started_instant.elapsed()),
                _ => {}
            }
        }

        fn time_to_first_artifact_ms(&self) -> Option<u64> {
            self.first_artifact_at.map(duration_millis)
        }

        fn throughput_bytes_per_second(&self, duration: Duration) -> f64 {
            throughput_bytes_per_second(
                self.total_received_bytes
                    .saturating_add(self.total_served_bytes),
                duration,
            )
        }
    }

    #[derive(Clone, Debug)]
    struct TransferTiming {
        started_at: String,
        completed_at: String,
        duration_ms: u64,
        throughput_bytes_per_second: f64,
    }

    struct TransferTimer {
        started_at: DateTime<Utc>,
        started_instant: Instant,
    }

    impl TransferTimer {
        fn start() -> Self {
            Self {
                started_at: Utc::now(),
                started_instant: Instant::now(),
            }
        }

        fn zero_now() -> TransferTiming {
            let now = Utc::now().to_rfc3339();
            TransferTiming {
                started_at: now.clone(),
                completed_at: now,
                duration_ms: 0,
                throughput_bytes_per_second: 0.0,
            }
        }

        fn finish(self, bytes: u64) -> TransferTiming {
            let completed_at = Utc::now();
            let duration = self.started_instant.elapsed();
            TransferTiming {
                started_at: self.started_at.to_rfc3339(),
                completed_at: completed_at.to_rfc3339(),
                duration_ms: duration_millis(duration),
                throughput_bytes_per_second: throughput_bytes_per_second(bytes, duration),
            }
        }

        fn finish_with_phase(
            self,
            bytes: u64,
            phase: &str,
            artifact: &RemoteArtifact,
        ) -> (TransferTiming, SyncTransportTimingEvidence) {
            let completed_at = Utc::now();
            let duration = self.started_instant.elapsed();
            let timing = TransferTiming {
                started_at: self.started_at.to_rfc3339(),
                completed_at: completed_at.to_rfc3339(),
                duration_ms: duration_millis(duration),
                throughput_bytes_per_second: throughput_bytes_per_second(bytes, duration),
            };
            let phase_timing = SyncTransportTimingEvidence {
                phase: phase.to_string(),
                project_id: Some(artifact.project_id.clone()),
                artifact_id: Some(artifact.artifact_id.clone()),
                started_at: timing.started_at.clone(),
                completed_at: timing.completed_at.clone(),
                duration_ms: timing.duration_ms,
            };
            (timing, phase_timing)
        }
    }

    struct TcpPeerStream {
        stream: TcpStream,
        abort_stream: Option<Arc<TcpStream>>,
    }

    impl TcpPeerStream {
        fn new(stream: TcpStream) -> Result<Self, String> {
            configure_stream(&stream)?;
            let abort_stream = stream.try_clone().ok().map(Arc::new);
            Ok(Self {
                stream,
                abort_stream,
            })
        }
    }

    impl PeerStream for TcpPeerStream {
        fn read_exact(&mut self, buffer: &mut [u8]) -> io::Result<()> {
            self.stream.read_exact(buffer)
        }

        fn write_all(&mut self, buffer: &[u8]) -> io::Result<()> {
            self.stream.write_all(buffer)
        }

        fn set_read_timeout(&mut self, timeout: Duration) -> io::Result<()> {
            self.stream.set_read_timeout(Some(timeout))
        }

        fn tcp_abort_stream(&self) -> Option<Arc<TcpStream>> {
            self.abort_stream.clone()
        }
    }

    struct IrohPeerStream {
        send: SendStream,
        recv: RecvStream,
        read_timeout: Duration,
        runtime_handle: tokio::runtime::Handle,
    }

    impl IrohPeerStream {
        fn new(send: SendStream, recv: RecvStream, runtime_handle: tokio::runtime::Handle) -> Self {
            Self {
                send,
                recv,
                read_timeout: READ_TIMEOUT,
                runtime_handle,
            }
        }
    }

    impl PeerStream for IrohPeerStream {
        fn read_exact(&mut self, buffer: &mut [u8]) -> io::Result<()> {
            let read_timeout = self.read_timeout;
            match self.runtime_handle.block_on(async {
                tokio::time::timeout(read_timeout, self.recv.read_exact(buffer)).await
            }) {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    error.to_string(),
                )),
                Err(_) => Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Timed out reading from Iroh sync stream.",
                )),
            }
        }

        fn write_all(&mut self, buffer: &[u8]) -> io::Result<()> {
            match self.runtime_handle.block_on(async {
                tokio::time::timeout(WRITE_TIMEOUT, self.send.write_all(buffer)).await
            }) {
                Ok(Ok(())) => Ok(()),
                Ok(Err(error)) => Err(io::Error::new(io::ErrorKind::Other, error.to_string())),
                Err(_) => Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Timed out writing to Iroh sync stream.",
                )),
            }
        }

        fn set_read_timeout(&mut self, timeout: Duration) -> io::Result<()> {
            self.read_timeout = timeout;
            Ok(())
        }
    }

    impl IrohDataConnection {
        fn close_for_artifact_batch_abort(&self) {
            self.connection
                .close(VarInt::from_u32(0), b"artifact batch aborted");
        }

        fn open_send_stream(&self) -> Result<SendStream, String> {
            let connection = self.connection.clone();
            self.runtime_handle.block_on(async move {
                tokio::time::timeout(CONNECT_TIMEOUT, connection.open_uni())
                    .await
                    .map_err(|_| "Timed out opening Iroh artifact data stream.".to_string())?
                    .map_err(|error| format!("Could not open Iroh artifact data stream: {error}"))
            })
        }

        fn accept_recv_stream_with_timeout(
            &self,
            timeout: Duration,
        ) -> Result<Option<RecvStream>, String> {
            let connection = self.connection.clone();
            self.runtime_handle.block_on(async move {
                match tokio::time::timeout(timeout, connection.accept_uni()).await {
                    Ok(Ok(recv)) => Ok(Some(recv)),
                    Ok(Err(error)) => Err(format!(
                        "Could not accept Iroh artifact data stream: {error}"
                    )),
                    Err(_) => Ok(None),
                }
            })
        }

        fn write_all(&self, send: &mut SendStream, buffer: &[u8]) -> Result<(), String> {
            self.runtime_handle
                .block_on(async {
                    tokio::time::timeout(WRITE_TIMEOUT, send.write_all(buffer)).await
                })
                .map_err(|_| "Timed out writing to Iroh artifact data stream.".to_string())?
                .map_err(|error| format!("Could not write Iroh artifact data stream: {error}"))
        }

        fn finish_send(&self, send: &mut SendStream) -> Result<(), String> {
            send.finish()
                .map_err(|error| format!("Could not finish Iroh artifact data stream: {error}"))
        }

        fn read_with_timeout(
            &self,
            recv: &mut RecvStream,
            buffer: &mut [u8],
            timeout: Duration,
        ) -> Result<IrohDataReadPoll, String> {
            match self
                .runtime_handle
                .block_on(async { tokio::time::timeout(timeout, recv.read(buffer)).await })
            {
                Ok(Ok(Some(read))) => Ok(IrohDataReadPoll::Data(read)),
                Ok(Ok(None)) => Ok(IrohDataReadPoll::EndOfStream),
                Ok(Err(error)) => Err(format!("Could not read Iroh artifact data stream: {error}")),
                Err(_) => Ok(IrohDataReadPoll::TimedOut),
            }
        }
    }

    struct SecurePeerConnection {
        stream: Box<dyn PeerStream>,
        noise: snow::TransportState,
        handshake_hash: String,
        next_message_id: u64,
        transport: TransportKind,
        iroh_data: Option<IrohDataConnection>,
    }

    impl SecurePeerConnection {
        fn connect_initiator(
            mut stream: Box<dyn PeerStream>,
            transport: TransportKind,
            iroh_data: Option<IrohDataConnection>,
        ) -> Result<Self, String> {
            let mut handshake = build_noise_handshake(true)?;
            let mut buffer = vec![0_u8; MAX_RAW_FRAME];
            let written = handshake
                .write_message(&[], &mut buffer)
                .map_err(|error| format!("Noise handshake write failed: {error}"))?;
            write_raw_frame(stream.as_mut(), &buffer[..written])?;

            let message = read_raw_frame(stream.as_mut())?;
            handshake
                .read_message(&message, &mut buffer)
                .map_err(|error| format!("Noise handshake read failed: {error}"))?;

            let written = handshake
                .write_message(&[], &mut buffer)
                .map_err(|error| format!("Noise handshake write failed: {error}"))?;
            write_raw_frame(stream.as_mut(), &buffer[..written])?;
            let handshake_hash = encode_urlsafe_key(handshake.get_handshake_hash());
            let noise = handshake
                .into_transport_mode()
                .map_err(|error| format!("Noise transport setup failed: {error}"))?;
            Ok(Self {
                stream,
                noise,
                handshake_hash,
                next_message_id: 1,
                transport,
                iroh_data,
            })
        }

        fn connect_responder(
            mut stream: Box<dyn PeerStream>,
            transport: TransportKind,
            iroh_data: Option<IrohDataConnection>,
        ) -> Result<Self, String> {
            let mut handshake = build_noise_handshake(false)?;
            let mut buffer = vec![0_u8; MAX_RAW_FRAME];

            let message = read_raw_frame(stream.as_mut())?;
            handshake
                .read_message(&message, &mut buffer)
                .map_err(|error| format!("Noise handshake read failed: {error}"))?;

            let written = handshake
                .write_message(&[], &mut buffer)
                .map_err(|error| format!("Noise handshake write failed: {error}"))?;
            write_raw_frame(stream.as_mut(), &buffer[..written])?;

            let message = read_raw_frame(stream.as_mut())?;
            handshake
                .read_message(&message, &mut buffer)
                .map_err(|error| format!("Noise handshake read failed: {error}"))?;
            let handshake_hash = encode_urlsafe_key(handshake.get_handshake_hash());
            let noise = handshake
                .into_transport_mode()
                .map_err(|error| format!("Noise transport setup failed: {error}"))?;
            Ok(Self {
                stream,
                noise,
                handshake_hash,
                next_message_id: 1,
                transport,
                iroh_data,
            })
        }

        fn transport(&self) -> TransportKind {
            self.transport.clone()
        }

        fn set_established_read_timeout(&mut self) -> Result<(), String> {
            self.stream
                .set_read_timeout(PROTOCOL_WATCHDOG_TIMEOUT)
                .map_err(|error| {
                    format!("Could not configure established sync transport read timeout: {error}")
                })
        }

        fn read_message_with_timeout(
            &mut self,
            timeout: Duration,
        ) -> Result<Option<ProtocolMessage>, String> {
            self.stream.set_read_timeout(timeout).map_err(|error| {
                format!("Could not configure sync transport read timeout: {error}")
            })?;
            let result = self.read_message();
            let restore_result = self.set_established_read_timeout();
            match (result, restore_result) {
                (Ok(message), Ok(())) => Ok(Some(message)),
                (Err(error), Ok(())) if sync_transport_read_timed_out(&error) => Ok(None),
                (Err(error), Ok(())) => Err(error),
                (Ok(_), Err(error)) | (Err(_), Err(error)) => Err(error),
            }
        }

        fn send_message(&mut self, message: &ProtocolMessage) -> Result<(), String> {
            let payload = serde_json::to_vec(message)
                .map_err(|error| format!("Could not encode sync transport message: {error}"))?;
            let message_id = self.next_message_id;
            self.next_message_id = self.next_message_id.saturating_add(1);
            let chunk_count = payload.len().max(1).div_ceil(ENCRYPTED_PAYLOAD_CHUNK) as u32;
            for (index, chunk) in payload.chunks(ENCRYPTED_PAYLOAD_CHUNK).enumerate() {
                let envelope = EncryptedChunk {
                    message_id,
                    chunk_index: index as u32,
                    chunk_count,
                    data: encode_standard_base64(chunk),
                };
                self.send_encrypted_chunk(&envelope)?;
            }
            if payload.is_empty() {
                let envelope = EncryptedChunk {
                    message_id,
                    chunk_index: 0,
                    chunk_count: 1,
                    data: String::new(),
                };
                self.send_encrypted_chunk(&envelope)?;
            }
            Ok(())
        }

        fn read_message(&mut self) -> Result<ProtocolMessage, String> {
            let first = match self.read_encrypted_frame()? {
                EncryptedFrame::MessageChunk(chunk) => chunk,
                EncryptedFrame::ArtifactChunk(_) => {
                    return Err(
                        "Received artifact bytes while waiting for a sync transport message."
                            .to_string(),
                    );
                }
            };
            self.read_message_from_first_chunk(first)
        }

        fn send_artifact_chunk(&mut self, chunk: &[u8]) -> Result<(), String> {
            let plaintext = encode_artifact_chunk_frame(chunk);
            self.send_encrypted_plaintext(&plaintext)
        }

        fn read_artifact_transfer_frame(&mut self) -> Result<ArtifactTransferFrame, String> {
            match self.read_encrypted_frame()? {
                EncryptedFrame::ArtifactChunk(chunk) => Ok(ArtifactTransferFrame::Chunk(chunk)),
                EncryptedFrame::MessageChunk(chunk) => self
                    .read_message_from_first_chunk(chunk)
                    .map(ArtifactTransferFrame::Message),
            }
        }

        fn read_message_from_first_chunk(
            &mut self,
            first: EncryptedChunk,
        ) -> Result<ProtocolMessage, String> {
            if first.chunk_count == 0 {
                return Err("Encrypted sync transport message has no chunks.".to_string());
            }
            if first.chunk_index != 0 {
                return Err("Encrypted sync transport chunks arrived out of order.".to_string());
            }
            let mut chunks = Vec::with_capacity(first.chunk_count as usize);
            let message_id = first.message_id;
            chunks.push(decode_standard_base64(&first.data)?);
            for expected_index in 1..first.chunk_count {
                let next = match self.read_encrypted_frame()? {
                    EncryptedFrame::MessageChunk(chunk) => chunk,
                    EncryptedFrame::ArtifactChunk(_) => {
                        return Err(
                            "Received artifact bytes inside a chunked sync transport message."
                                .to_string(),
                        );
                    }
                };
                if next.message_id != message_id || next.chunk_index != expected_index {
                    return Err("Encrypted sync transport chunks arrived out of order.".to_string());
                }
                if next.chunk_count != first.chunk_count {
                    return Err("Encrypted sync transport chunk count changed.".to_string());
                }
                chunks.push(decode_standard_base64(&next.data)?);
            }
            let payload = chunks.concat();
            serde_json::from_slice(&payload)
                .map_err(|error| format!("Could not decode sync transport message: {error}"))
        }

        fn send_encrypted_chunk(&mut self, chunk: &EncryptedChunk) -> Result<(), String> {
            let plaintext = encode_message_chunk_frame(chunk)?;
            self.send_encrypted_plaintext(&plaintext)
        }

        fn send_encrypted_plaintext(&mut self, plaintext: &[u8]) -> Result<(), String> {
            let mut ciphertext = vec![0_u8; plaintext.len() + 1024];
            let written = self
                .noise
                .write_message(plaintext, &mut ciphertext)
                .map_err(|error| format!("Noise transport write failed: {error}"))?;
            write_raw_frame(self.stream.as_mut(), &ciphertext[..written])
        }

        fn read_encrypted_frame(&mut self) -> Result<EncryptedFrame, String> {
            let ciphertext = read_raw_frame(self.stream.as_mut())?;
            let mut plaintext = vec![0_u8; MAX_RAW_FRAME];
            let read = self
                .noise
                .read_message(&ciphertext, &mut plaintext)
                .map_err(|error| format!("Noise transport read failed: {error}"))?;
            decode_encrypted_frame_plaintext(&plaintext[..read])
        }
    }

    #[derive(Clone, Default)]
    struct ConnectionAbortHandle {
        tcp_stream: Option<Arc<TcpStream>>,
        iroh_connection: Option<Connection>,
    }

    impl ConnectionAbortHandle {
        fn from_connection(connection: &SecurePeerConnection) -> Self {
            Self {
                tcp_stream: connection.stream.tcp_abort_stream(),
                iroh_connection: connection
                    .iroh_data
                    .as_ref()
                    .map(|iroh_data| iroh_data.connection.clone()),
            }
        }

        fn abort(&self) {
            if let Some(stream) = &self.tcp_stream {
                let _ = stream.shutdown(Shutdown::Both);
            }
            if let Some(connection) = &self.iroh_connection {
                connection.close(VarInt::from_u32(0), b"lifecycle interrupted");
            }
        }
    }

    #[derive(Clone)]
    struct SharedPeerConnection {
        inner: Arc<Mutex<SecurePeerConnection>>,
        abort_handle: ConnectionAbortHandle,
    }

    impl SharedPeerConnection {
        fn new(connection: SecurePeerConnection) -> Self {
            let abort_handle = ConnectionAbortHandle::from_connection(&connection);
            Self {
                inner: Arc::new(Mutex::new(connection)),
                abort_handle,
            }
        }

        fn abort_for_lifecycle_interruption(&self) {
            self.abort_handle.abort();
        }

        fn with_connection<T>(
            &self,
            action: impl FnOnce(&mut SecurePeerConnection) -> Result<T, String>,
        ) -> Result<T, String> {
            let mut connection = self
                .inner
                .lock()
                .map_err(|_| "Sync transport connection state is unavailable.".to_string())?;
            action(&mut connection)
        }

        fn send_message_for_phase(
            &self,
            phase: &str,
            message: &ProtocolMessage,
        ) -> Result<(), String> {
            self.with_connection(|connection| {
                connection
                    .send_message(message)
                    .map_err(|error| phase_context_error(phase, error))
            })
        }

        fn try_send_message_for_phase(
            &self,
            phase: &str,
            message: &ProtocolMessage,
        ) -> Result<(), String> {
            let mut connection = match self.inner.try_lock() {
                Ok(connection) => connection,
                Err(std::sync::TryLockError::WouldBlock) => return Ok(()),
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("Sync transport connection state is unavailable.".to_string());
                }
            };
            connection
                .send_message(message)
                .map_err(|error| phase_context_error(phase, error))
        }

        fn send_artifact_chunk_for_phase(&self, phase: &str, chunk: &[u8]) -> Result<(), String> {
            self.with_connection(|connection| {
                connection
                    .send_artifact_chunk(chunk)
                    .map_err(|error| phase_context_error(phase, error))
            })
        }

        fn read_message(&self) -> Result<ProtocolMessage, String> {
            self.with_connection(SecurePeerConnection::read_message)
        }

        fn read_message_with_timeout(
            &self,
            timeout: Duration,
        ) -> Result<Option<ProtocolMessage>, String> {
            self.with_connection(|connection| connection.read_message_with_timeout(timeout))
        }

        fn read_message_accepting_status_for_phase(
            &self,
            phase: &str,
            progress: &ProgressReporter,
        ) -> Result<ProtocolMessage, String> {
            read_message_accepting_status(
                phase,
                || self.read_message(),
                |status| progress.record_peer_status(status),
            )
        }

        fn read_message_with_timeout_accepting_status_for_phase(
            &self,
            phase: &str,
            timeout: Duration,
            progress: &ProgressReporter,
        ) -> Result<(Option<ProtocolMessage>, bool), String> {
            let mut had_status_progress = false;
            loop {
                let Some(message) = self
                    .read_message_with_timeout(timeout)
                    .map_err(|error| phase_context_error(phase, error))?
                else {
                    return Ok((None, had_status_progress));
                };
                match split_protocol_status(message) {
                    Ok(status) => {
                        had_status_progress = true;
                        progress.record_peer_status(status);
                    }
                    Err(message) => return Ok((Some(message), had_status_progress)),
                }
            }
        }

        fn read_artifact_transfer_frame(&self) -> Result<ArtifactTransferFrame, String> {
            self.with_connection(SecurePeerConnection::read_artifact_transfer_frame)
        }

        fn read_artifact_transfer_frame_accepting_status_for_phase(
            &self,
            phase: &str,
            progress: &ProgressReporter,
        ) -> Result<ArtifactTransferFrame, String> {
            loop {
                let frame = self
                    .read_artifact_transfer_frame()
                    .map_err(|error| phase_context_error(phase, error))?;
                match frame {
                    ArtifactTransferFrame::Message(message) => {
                        match split_protocol_status(message) {
                            Ok(status) => progress.record_peer_status(status),
                            Err(message) => return Ok(ArtifactTransferFrame::Message(message)),
                        }
                    }
                    ArtifactTransferFrame::Chunk(chunk) => {
                        return Ok(ArtifactTransferFrame::Chunk(chunk));
                    }
                }
            }
        }

        fn transport(&self) -> TransportKind {
            self.inner
                .lock()
                .map(|connection| connection.transport())
                .unwrap_or_else(|_| TransportKind::Other(TCP_TRANSPORT_ID.to_string()))
        }

        fn transport_id(&self) -> &'static str {
            match self.transport() {
                TransportKind::Tcp => TCP_TRANSPORT_ID,
                TransportKind::Iroh => IROH_TRANSPORT_ID,
                TransportKind::Other(_) => TCP_TRANSPORT_ID,
            }
        }

        fn iroh_data_connection(&self) -> Option<IrohDataConnection> {
            self.inner
                .lock()
                .ok()
                .and_then(|connection| connection.iroh_data.clone())
        }
    }

    impl ProtocolConnection for SecurePeerConnection {
        fn send_message(&mut self, message: &ProtocolMessage) -> Result<(), String> {
            SecurePeerConnection::send_message(self, message)
        }

        fn read_message(&mut self) -> Result<ProtocolMessage, String> {
            SecurePeerConnection::read_message(self)
        }

        fn handshake_hash(&self) -> &str {
            &self.handshake_hash
        }
    }

    fn build_noise_handshake(initiator: bool) -> Result<snow::HandshakeState, String> {
        let params: NoiseParams = NOISE_PATTERN
            .parse()
            .map_err(|error| format!("Noise pattern is invalid: {error}"))?;
        let builder = Builder::new(params);
        let keypair = builder
            .generate_keypair()
            .map_err(|error| format!("Could not generate Noise static keypair: {error}"))?;
        let params: NoiseParams = NOISE_PATTERN
            .parse()
            .map_err(|error| format!("Noise pattern is invalid: {error}"))?;
        let builder = Builder::new(params)
            .local_private_key(&keypair.private)
            .map_err(|error| format!("Could not configure Noise static keypair: {error}"))?;
        if initiator {
            builder
                .build_initiator()
                .map_err(|error| format!("Could not create Noise initiator: {error}"))
        } else {
            builder
                .build_responder()
                .map_err(|error| format!("Could not create Noise responder: {error}"))
        }
    }

    fn configure_stream(stream: &TcpStream) -> Result<(), String> {
        stream.set_nonblocking(false).map_err(|error| {
            format!("Could not configure sync transport blocking mode: {error}")
        })?;
        stream
            .set_read_timeout(Some(READ_TIMEOUT))
            .map_err(|error| format!("Could not set sync transport read timeout: {error}"))?;
        stream
            .set_write_timeout(Some(WRITE_TIMEOUT))
            .map_err(|error| format!("Could not set sync transport write timeout: {error}"))?;
        stream
            .set_nodelay(true)
            .map_err(|error| format!("Could not configure sync transport socket: {error}"))?;
        Ok(())
    }

    fn load_local_manifest_offer(
        client: &BackendClient,
        project_ids: Option<&[String]>,
        include_manifests: bool,
    ) -> ManifestOffer {
        let metadata = client
            .get_json_value("/api/v1/sync/metadata")
            .unwrap_or_else(|error| json!({ "error": error.to_string() }));
        let mut project_manifests = Vec::new();
        let mut manifest_errors = Vec::new();
        if include_manifests {
            let selected_project_ids = project_ids
                .map(|values| values.to_vec())
                .unwrap_or_else(|| project_ids_from_metadata(&metadata));
            let manifests = load_local_project_manifests(client, &selected_project_ids);
            project_manifests = manifests.project_manifests;
            manifest_errors = manifests.manifest_errors;
        }
        ManifestOffer {
            metadata,
            project_manifests,
            manifest_errors,
        }
    }

    fn load_local_project_manifests(
        client: &BackendClient,
        project_ids: &[String],
    ) -> ManifestOffer {
        if project_ids.is_empty() {
            return ManifestOffer {
                metadata: Value::Null,
                project_manifests: Vec::new(),
                manifest_errors: Vec::new(),
            };
        }

        let mut project_manifests = Vec::new();
        let mut manifest_errors = Vec::new();
        for project_id_batch in project_ids.chunks(LOCAL_MANIFEST_EXPORT_BATCH_SIZE) {
            let body = json!({ "project_ids": project_id_batch });
            match client.post_manifest_batch_json_value(&body) {
                Ok(response) => {
                    let batch_offer =
                        manifest_offer_from_batch_response(&response, project_id_batch);
                    project_manifests.extend(batch_offer.project_manifests);
                    manifest_errors.extend(batch_offer.manifest_errors);
                }
                Err(error) if client.manifest_batch_unavailable(&error) => {
                    return load_local_project_manifests_one_by_one(client, project_ids);
                }
                Err(error) => {
                    let message = error.to_string();
                    manifest_errors.extend(project_id_batch.iter().map(|project_id| {
                        SyncTransportManifestError {
                            project_id: project_id.clone(),
                            message: message.clone(),
                        }
                    }));
                }
            }
        }
        ManifestOffer {
            metadata: Value::Null,
            project_manifests,
            manifest_errors,
        }
    }

    fn load_local_project_manifests_one_by_one(
        client: &BackendClient,
        project_ids: &[String],
    ) -> ManifestOffer {
        let mut project_manifests = Vec::new();
        let mut manifest_errors = Vec::new();
        for project_id in project_ids {
            match client.get_project_manifest_json_value(project_id) {
                Ok(response) => {
                    if let Some(manifest) = response
                        .get("project_manifest")
                        .or_else(|| response.get("projectManifest"))
                    {
                        project_manifests.push(manifest.clone());
                    } else {
                        manifest_errors.push(SyncTransportManifestError {
                            project_id: project_id.clone(),
                            message: "Backend manifest response did not include project_manifest."
                                .to_string(),
                        });
                    }
                }
                Err(error) => manifest_errors.push(SyncTransportManifestError {
                    project_id: project_id.clone(),
                    message: error.to_string(),
                }),
            }
        }
        ManifestOffer {
            metadata: Value::Null,
            project_manifests,
            manifest_errors,
        }
    }

    fn manifest_offer_from_batch_response(
        response: &Value,
        project_ids: &[String],
    ) -> ManifestOffer {
        let project_manifests = response
            .get("project_manifests")
            .or_else(|| response.get("projectManifests"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut manifest_errors = response
            .get("manifest_errors")
            .or_else(|| response.get("manifestErrors"))
            .and_then(Value::as_array)
            .map(|errors| {
                errors
                    .iter()
                    .map(manifest_error_from_value)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let mut completed_project_ids: HashSet<String> = project_manifests
            .iter()
            .map(manifest_project_id)
            .filter(|project_id| project_id != "unknown")
            .collect();
        completed_project_ids.extend(manifest_errors.iter().map(|error| error.project_id.clone()));
        for project_id in project_ids {
            if !completed_project_ids.contains(project_id) {
                manifest_errors.push(SyncTransportManifestError {
                    project_id: project_id.clone(),
                    message: "Backend batch manifest response omitted this project.".to_string(),
                });
            }
        }

        ManifestOffer {
            metadata: Value::Null,
            project_manifests,
            manifest_errors,
        }
    }

    fn manifest_error_from_value(value: &Value) -> SyncTransportManifestError {
        SyncTransportManifestError {
            project_id: value
                .get("project_id")
                .or_else(|| value.get("projectId"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Backend manifest export failed.")
                .to_string(),
        }
    }

    fn project_ids_from_metadata(metadata: &Value) -> Vec<String> {
        metadata
            .get("projects")
            .and_then(Value::as_array)
            .map(|projects| {
                projects
                    .iter()
                    .filter_map(|project| project.get("project_id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    struct StagedRemoteImport {
        plan_failures: Vec<SyncTransportProjectResult>,
        apply_worker: Option<RemoteApplyWorker>,
        received_artifacts: Vec<SyncTransportTransferResult>,
    }

    #[derive(Clone, Debug)]
    struct PlannedRemoteProject {
        project_id: String,
        manifest: Option<Value>,
        plan: Value,
    }

    enum RemotePlanRequest<'a> {
        Manifest { manifests: &'a [Value] },
        Delete { project_ids: &'a [String] },
    }

    impl RemotePlanRequest<'_> {
        fn project_ids(&self) -> Vec<String> {
            match self {
                Self::Manifest { manifests } => manifests.iter().map(manifest_project_id).collect(),
                Self::Delete { project_ids } => project_ids.to_vec(),
            }
        }
    }

    #[derive(Clone, Debug)]
    struct StagedRemoteProject {
        manifest: Value,
        cleanup_context_manifests: Vec<Value>,
        available_content_sha256: Vec<String>,
        transfer_failure: Option<String>,
    }

    enum RemoteApplyTask {
        Project(StagedRemoteProject),
        Tombstone(String),
    }

    enum BackendWriteTask {
        StageIrohArtifact {
            received: IrohReceivedArtifact,
            queued_at: Instant,
        },
        Apply {
            project_id: String,
            task: RemoteApplyTask,
        },
    }

    struct QueuedRemoteApplyTask {
        project_id: String,
        task: RemoteApplyTask,
    }

    enum BackendWriteEvent {
        Stage(IrohStageResult),
        Apply {
            project_ids: Vec<String>,
            results: Vec<SyncTransportProjectResult>,
            timings: Vec<SyncTransportTimingEvidence>,
        },
    }

    // Backend writes run through one FIFO lane so staging and reconciliation apply never overlap.
    struct RemoteApplyWorker {
        sender: Option<mpsc::SyncSender<BackendWriteTask>>,
        event_receiver: mpsc::Receiver<BackendWriteEvent>,
        handle: Option<JoinHandle<()>>,
        queued_project_ids: Arc<Mutex<Vec<String>>>,
        completed_project_ids: HashSet<String>,
        enqueue_failures: Arc<Mutex<Vec<SyncTransportProjectResult>>>,
        apply_cancelled: Arc<AtomicBool>,
        project_results: Vec<SyncTransportProjectResult>,
        pending_stage_jobs: usize,
        pending_stage_bytes: u64,
        staging_peak_bytes: u64,
    }

    #[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
    struct ImportOutcomeCounts {
        imported: usize,
        skipped: usize,
        failed: usize,
    }

    fn stage_remote_manifest_artifacts(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
        transport_id: &str,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> StagedRemoteImport {
        let mut received_artifacts = Vec::new();
        let mut apply_worker = RemoteApplyWorker::start(
            client,
            peer_device_id,
            remote_metadata,
            transport_id,
            progress.clone(),
        );
        if progress.is_cancelled() {
            apply_worker.cancel_pending_apply();
            return StagedRemoteImport {
                plan_failures: Vec::new(),
                apply_worker: Some(apply_worker),
                received_artifacts,
            };
        }
        let (planned_projects, plan_failures) =
            plan_remote_manifest_projects(manifests, remote_metadata, |request| {
                let project_ids = request.project_ids();
                let timers: Vec<_> = project_ids
                    .iter()
                    .map(|project_id| {
                        SyncPhaseTimer::start_project("reconciliation_plan", project_id)
                    })
                    .collect();
                let result = {
                    match request {
                        RemotePlanRequest::Manifest { manifests } => {
                            let _progress = progress.start_phase(
                                "reconciliation_plan",
                                "Planning sync reconciliation for remote projects.",
                            );
                            plan_remote_manifest_chunk(
                                client,
                                peer_device_id,
                                remote_metadata,
                                manifests,
                                transport_id,
                            )
                        }
                        RemotePlanRequest::Delete { project_ids } => {
                            let _progress = progress.start_phase(
                                "reconciliation_plan",
                                "Planning sync reconciliation for remote delete tombstones.",
                            );
                            plan_remote_delete_chunk(
                                client,
                                peer_device_id,
                                remote_metadata,
                                project_ids,
                                transport_id,
                            )
                        }
                    }
                };
                timings.extend(timers.into_iter().map(SyncPhaseTimer::finish));
                result
            });
        if connection.transport() == TransportKind::Iroh {
            if let Some(iroh_data) = connection.iroh_data_connection() {
                stage_remote_manifest_iroh_artifacts(
                    client,
                    connection,
                    iroh_data,
                    peer_device_id,
                    planned_projects,
                    &mut apply_worker,
                    &mut received_artifacts,
                    metrics,
                    timings,
                    progress,
                );
            } else {
                stage_remote_manifest_artifacts_sequential(
                    client,
                    connection,
                    peer_device_id,
                    planned_projects,
                    &mut apply_worker,
                    &mut received_artifacts,
                    metrics,
                    timings,
                    progress,
                );
            }
        } else {
            stage_remote_manifest_artifacts_sequential(
                client,
                connection,
                peer_device_id,
                planned_projects,
                &mut apply_worker,
                &mut received_artifacts,
                metrics,
                timings,
                progress,
            );
        }

        StagedRemoteImport {
            plan_failures,
            apply_worker: Some(apply_worker),
            received_artifacts,
        }
    }

    fn stage_remote_manifest_artifacts_sequential(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        peer_device_id: &str,
        planned_projects: Vec<PlannedRemoteProject>,
        apply_worker: &mut RemoteApplyWorker,
        received_artifacts: &mut Vec<SyncTransportTransferResult>,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) {
        for planned in planned_projects {
            if progress.is_cancelled() {
                apply_worker.cancel_pending_apply();
                break;
            }
            match planned.manifest {
                Some(manifest) => {
                    let staged = stage_remote_manifest_project_artifacts(
                        client,
                        connection,
                        peer_device_id,
                        &manifest,
                        &planned.plan,
                        received_artifacts,
                        metrics,
                        timings,
                        progress,
                    );
                    apply_worker.enqueue_project(staged);
                }
                None => {
                    if planned_delete_project_ids(&planned.plan)
                        .into_iter()
                        .any(|project_id| project_id == planned.project_id)
                    {
                        apply_worker.enqueue_tombstone(planned.project_id);
                    }
                }
            }
        }
    }

    fn plan_remote_manifest_projects(
        manifests: &[Value],
        remote_metadata: &Value,
        mut plan: impl for<'a> FnMut(RemotePlanRequest<'a>) -> Result<Value, BackendError>,
    ) -> (Vec<PlannedRemoteProject>, Vec<SyncTransportProjectResult>) {
        let mut planned_projects = Vec::new();
        let mut plan_failures = Vec::new();
        let manifest_project_ids: HashSet<String> =
            manifests.iter().map(manifest_project_id).collect();

        for chunk in manifests.chunks(RECONCILIATION_PLAN_MANIFEST_CHUNK_SIZE) {
            plan_remote_manifest_chunk_with_split(
                chunk,
                &mut plan,
                &mut planned_projects,
                &mut plan_failures,
            );
        }

        let delete_project_ids: Vec<String> = remote_delete_tombstone_project_ids(remote_metadata)
            .into_iter()
            .filter(|project_id| !manifest_project_ids.contains(project_id.as_str()))
            .collect();
        for chunk in delete_project_ids.chunks(RECONCILIATION_PLAN_DELETE_CHUNK_SIZE) {
            plan_remote_delete_chunk_with_split(
                chunk,
                &mut plan,
                &mut planned_projects,
                &mut plan_failures,
            );
        }

        (planned_projects, plan_failures)
    }

    fn plan_remote_manifest_chunk_with_split<F>(
        manifests: &[Value],
        plan: &mut F,
        planned_projects: &mut Vec<PlannedRemoteProject>,
        plan_failures: &mut Vec<SyncTransportProjectResult>,
    ) where
        F: for<'a> FnMut(RemotePlanRequest<'a>) -> Result<Value, BackendError>,
    {
        if manifests.is_empty() {
            return;
        }

        match plan(RemotePlanRequest::Manifest { manifests }) {
            Ok(project_plan) => {
                planned_projects.extend(manifests.iter().map(|manifest| PlannedRemoteProject {
                    project_id: manifest_project_id(manifest),
                    manifest: Some(manifest.clone()),
                    plan: project_plan.clone(),
                }));
            }
            Err(error) if manifests.len() == 1 => {
                let project_id = manifest_project_id(&manifests[0]);
                plan_failures.push(plan_failure_project_result(
                    &project_id,
                    format!("Could not plan remote sync reconciliation project: {error}"),
                ));
            }
            Err(_) => {
                let split_at = manifests.len() / 2;
                plan_remote_manifest_chunk_with_split(
                    &manifests[..split_at],
                    plan,
                    planned_projects,
                    plan_failures,
                );
                plan_remote_manifest_chunk_with_split(
                    &manifests[split_at..],
                    plan,
                    planned_projects,
                    plan_failures,
                );
            }
        }
    }

    fn plan_remote_delete_chunk_with_split<F>(
        project_ids: &[String],
        plan: &mut F,
        planned_projects: &mut Vec<PlannedRemoteProject>,
        plan_failures: &mut Vec<SyncTransportProjectResult>,
    ) where
        F: for<'a> FnMut(RemotePlanRequest<'a>) -> Result<Value, BackendError>,
    {
        if project_ids.is_empty() {
            return;
        }

        match plan(RemotePlanRequest::Delete { project_ids }) {
            Ok(project_plan) => {
                planned_projects.extend(project_ids.iter().map(|project_id| {
                    PlannedRemoteProject {
                        project_id: project_id.clone(),
                        manifest: None,
                        plan: project_plan.clone(),
                    }
                }));
            }
            Err(error) if project_ids.len() == 1 => {
                plan_failures.push(plan_failure_project_result(
                    &project_ids[0],
                    format!("Could not plan remote sync reconciliation delete tombstone: {error}"),
                ));
            }
            Err(_) => {
                let split_at = project_ids.len() / 2;
                plan_remote_delete_chunk_with_split(
                    &project_ids[..split_at],
                    plan,
                    planned_projects,
                    plan_failures,
                );
                plan_remote_delete_chunk_with_split(
                    &project_ids[split_at..],
                    plan,
                    planned_projects,
                    plan_failures,
                );
            }
        }
    }

    fn finish_staged_remote_import(
        staged: StagedRemoteImport,
        timings: &mut Vec<SyncTransportTimingEvidence>,
    ) -> Vec<SyncTransportProjectResult> {
        let mut project_results = staged.plan_failures;

        if let Some(apply_worker) = staged.apply_worker {
            project_results.extend(apply_worker.finish(timings));
        }

        project_results
    }

    fn finish_staged_remote_import_for_failure(staged: Option<StagedRemoteImport>) {
        if let Some(staged) = staged {
            if let Some(apply_worker) = staged.apply_worker.as_ref() {
                apply_worker.cancel_pending_apply();
            }
            let mut timings = Vec::new();
            let _ = finish_staged_remote_import(staged, &mut timings);
        }
    }

    impl RemoteApplyWorker {
        fn start(
            client: &BackendClient,
            peer_device_id: &str,
            remote_metadata: &Value,
            transport_id: &str,
            progress: ProgressReporter,
        ) -> Self {
            let (sender, receiver) =
                mpsc::sync_channel::<BackendWriteTask>(IROH_ARTIFACT_STAGING_QUEUE_CAPACITY);
            let (event_sender, event_receiver) = mpsc::channel::<BackendWriteEvent>();
            let client = client.clone();
            let peer_device_id = peer_device_id.to_string();
            let remote_metadata = remote_metadata.clone();
            let transport_id = transport_id.to_string();
            let queued_project_ids = Arc::new(Mutex::new(Vec::new()));
            let enqueue_failures = Arc::new(Mutex::new(Vec::new()));
            let apply_cancelled = Arc::new(AtomicBool::new(false));
            let handle = thread::spawn({
                let progress = progress.clone();
                let apply_cancelled = Arc::clone(&apply_cancelled);
                move || {
                    let mut pending_task = None;
                    loop {
                        let task = match pending_task.take() {
                            Some(task) => task,
                            None => match receiver.recv() {
                                Ok(task) => task,
                                Err(_) => break,
                            },
                        };
                        let event = match task {
                            BackendWriteTask::StageIrohArtifact {
                                received,
                                queued_at,
                            } => {
                                let mut stage_timings = Vec::new();
                                let mut diagnostics = SyncTransportDiagnostics::default();
                                diagnostics.record_stage_queue_wait(queued_at.elapsed());
                                let transfer =
                                    if let Some(message) = progress.interruption_message() {
                                        let artifact = received.artifact.clone();
                                        let cleanup_timer = SyncPhaseTimer::start_artifact(
                                            "artifact_cleanup",
                                            &artifact,
                                        );
                                        let _ = fs::remove_file(&received.temp_path);
                                        stage_timings.push(cleanup_timer.finish());
                                        Err(post_receive_transfer_failure(
                                            &artifact,
                                            received.timing,
                                            message,
                                        ))
                                    } else {
                                        stage_received_iroh_artifact(
                                            &client,
                                            &transport_id,
                                            &peer_device_id,
                                            received,
                                            &mut stage_timings,
                                            &mut diagnostics,
                                        )
                                    };
                                BackendWriteEvent::Stage(IrohStageResult {
                                    transfer,
                                    timings: stage_timings,
                                    diagnostics,
                                })
                            }
                            BackendWriteTask::Apply { project_id, task } => {
                                let apply_tasks = collect_remote_apply_batch(
                                    QueuedRemoteApplyTask { project_id, task },
                                    &receiver,
                                    &mut pending_task,
                                );
                                let project_ids = apply_tasks
                                    .iter()
                                    .map(|task| task.project_id.clone())
                                    .collect::<Vec<_>>();
                                let mut apply_timings = Vec::new();
                                let results = if apply_cancelled.load(Ordering::SeqCst) {
                                    project_ids
                                        .iter()
                                        .map(|project_id| {
                                            failed_project_result(
                                                project_id,
                                                "Remote sync import skipped after Iroh artifact transfer aborted.",
                                            )
                                        })
                                        .collect()
                                } else if let Some(message) = progress.interruption_message() {
                                    project_ids
                                        .iter()
                                        .map(|project_id| {
                                            failed_project_result(project_id, &message)
                                        })
                                        .collect()
                                } else {
                                    apply_remote_ready_project_batch(
                                        &client,
                                        &peer_device_id,
                                        &remote_metadata,
                                        apply_tasks,
                                        &transport_id,
                                        &mut apply_timings,
                                        &progress,
                                    )
                                };
                                BackendWriteEvent::Apply {
                                    project_ids,
                                    results,
                                    timings: apply_timings,
                                }
                            }
                        };
                        if event_sender.send(event).is_err() {
                            break;
                        }
                    }
                }
            });

            Self {
                sender: Some(sender),
                event_receiver,
                handle: Some(handle),
                queued_project_ids,
                completed_project_ids: HashSet::new(),
                enqueue_failures,
                apply_cancelled,
                project_results: Vec::new(),
                pending_stage_jobs: 0,
                pending_stage_bytes: 0,
                staging_peak_bytes: 0,
            }
        }

        fn cancel_pending_apply(&self) {
            self.apply_cancelled.store(true, Ordering::SeqCst);
        }

        fn enqueue_project(&mut self, project: StagedRemoteProject) {
            let project_id = manifest_project_id(&project.manifest);
            self.enqueue(project_id, RemoteApplyTask::Project(project));
        }

        fn enqueue_tombstone(&mut self, project_id: String) {
            self.enqueue(project_id.clone(), RemoteApplyTask::Tombstone(project_id));
        }

        fn enqueue(&mut self, project_id: String, task: RemoteApplyTask) {
            let Some(sender) = &self.sender else {
                self.enqueue_failures
                    .lock()
                    .map(|mut failures| {
                        failures.push(failed_project_result(
                            &project_id,
                            "Remote sync import worker is closed.",
                        ));
                    })
                    .ok();
                return;
            };
            match sender.send(BackendWriteTask::Apply {
                project_id: project_id.clone(),
                task,
            }) {
                Ok(()) => {
                    if let Ok(mut queued) = self.queued_project_ids.lock() {
                        queued.push(project_id);
                    }
                }
                Err(_) => {
                    if let Ok(mut failures) = self.enqueue_failures.lock() {
                        failures.push(failed_project_result(
                            &project_id,
                            "Remote sync import worker stopped.",
                        ));
                    }
                }
            }
        }

        fn process_backend_write_event(
            &mut self,
            event: BackendWriteEvent,
            timings: &mut Vec<SyncTransportTimingEvidence>,
            stage_results: &mut Vec<IrohStageResult>,
        ) {
            match event {
                BackendWriteEvent::Stage(stage_result) => {
                    let size_bytes = iroh_stage_result_size_bytes(&stage_result);
                    self.pending_stage_jobs = self.pending_stage_jobs.saturating_sub(1);
                    self.pending_stage_bytes = self.pending_stage_bytes.saturating_sub(size_bytes);
                    stage_results.push(stage_result);
                }
                BackendWriteEvent::Apply {
                    project_ids,
                    results,
                    timings: mut apply_timings,
                } => {
                    timings.append(&mut apply_timings);
                    self.completed_project_ids.extend(project_ids);
                    self.project_results.extend(results);
                }
            }
        }

        fn drain_backend_write_events(
            &mut self,
            timings: &mut Vec<SyncTransportTimingEvidence>,
        ) -> Vec<IrohStageResult> {
            let mut stage_results = Vec::new();
            while let Ok(event) = self.event_receiver.try_recv() {
                self.process_backend_write_event(event, timings, &mut stage_results);
            }
            stage_results
        }

        fn enqueue_received_iroh_artifact(
            &mut self,
            received: IrohReceivedArtifact,
        ) -> Result<(), IrohReceivedArtifact> {
            let Some(sender) = &self.sender else {
                return Err(received);
            };
            let received_size_bytes = received.size_bytes;
            match sender.send(BackendWriteTask::StageIrohArtifact {
                received,
                queued_at: Instant::now(),
            }) {
                Ok(()) => {
                    self.pending_stage_bytes =
                        self.pending_stage_bytes.saturating_add(received_size_bytes);
                    self.staging_peak_bytes = self.staging_peak_bytes.max(self.pending_stage_bytes);
                    self.pending_stage_jobs = self.pending_stage_jobs.saturating_add(1);
                    Ok(())
                }
                Err(error) => match error.0 {
                    BackendWriteTask::StageIrohArtifact { received, .. } => Err(received),
                    BackendWriteTask::Apply { .. } => unreachable!(),
                },
            }
        }

        fn staging_peak_bytes(&self) -> u64 {
            self.staging_peak_bytes
        }

        fn pending_stage_bytes(&self) -> u64 {
            self.pending_stage_bytes
        }

        fn finish_iroh_stage_jobs(
            &mut self,
            timings: &mut Vec<SyncTransportTimingEvidence>,
        ) -> Result<Vec<IrohStageResult>, String> {
            let mut stage_results = Vec::new();
            while self.pending_stage_jobs > 0 {
                let event = self.event_receiver.recv().map_err(|_| {
                    "Remote sync backend write lane stopped before staging all received artifacts."
                        .to_string()
                })?;
                self.process_backend_write_event(event, timings, &mut stage_results);
            }
            Ok(stage_results)
        }

        fn finish(
            mut self,
            timings: &mut Vec<SyncTransportTimingEvidence>,
        ) -> Vec<SyncTransportProjectResult> {
            self.sender.take();
            let mut stage_results = Vec::new();
            while let Ok(event) = self.event_receiver.recv() {
                self.process_backend_write_event(event, timings, &mut stage_results);
            }
            if let Some(handle) = self.handle.take() {
                if handle.join().is_err() {
                    if let Ok(queued) = self.queued_project_ids.lock() {
                        for project_id in queued.iter() {
                            if !self.completed_project_ids.contains(project_id) {
                                self.project_results.push(failed_project_result(
                                    project_id,
                                    "Remote sync import worker panicked.",
                                ));
                            }
                        }
                    }
                }
            }
            if let Ok(mut failures) = self.enqueue_failures.lock() {
                self.project_results.extend(failures.drain(..));
            }
            self.project_results
        }
    }

    fn collect_remote_apply_batch(
        first: QueuedRemoteApplyTask,
        receiver: &mpsc::Receiver<BackendWriteTask>,
        pending_task: &mut Option<BackendWriteTask>,
    ) -> Vec<QueuedRemoteApplyTask> {
        let mut tasks = vec![first];
        while tasks.len() < RECONCILIATION_APPLY_BATCH_SIZE {
            match receiver.recv_timeout(RECONCILIATION_APPLY_BATCH_COALESCE_TIMEOUT) {
                Ok(BackendWriteTask::Apply { project_id, task }) => {
                    tasks.push(QueuedRemoteApplyTask { project_id, task });
                }
                Ok(task @ BackendWriteTask::StageIrohArtifact { .. }) => {
                    *pending_task = Some(task);
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {
                    break;
                }
            }
        }
        tasks
    }

    fn apply_remote_ready_project_batch(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        tasks: Vec<QueuedRemoteApplyTask>,
        transport_id: &str,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> Vec<SyncTransportProjectResult> {
        let mut ordered_project_ids = Vec::with_capacity(tasks.len());
        let mut backend_tasks = Vec::new();
        let mut local_failures = HashMap::new();

        for queued in tasks {
            ordered_project_ids.push(queued.project_id.clone());
            let transfer_failure_result = match &queued.task {
                RemoteApplyTask::Project(project) => project
                    .transfer_failure
                    .as_deref()
                    .map(|error| staged_transfer_failure_project_result(&project.manifest, error)),
                RemoteApplyTask::Tombstone(_) => None,
            };
            if let Some(result) = transfer_failure_result {
                local_failures.insert(queued.project_id.clone(), result);
            } else {
                backend_tasks.push(queued);
            }
        }

        let mut backend_results = apply_remote_project_batch_with_split_on_error(
            client,
            peer_device_id,
            remote_metadata,
            backend_tasks,
            transport_id,
            timings,
            progress,
        )
        .into_iter()
        .map(|result| (result.project_id.clone(), result))
        .collect::<HashMap<_, _>>();

        ordered_project_ids
            .into_iter()
            .map(|project_id| {
                local_failures
                    .remove(&project_id)
                    .or_else(|| backend_results.remove(&project_id))
                    .unwrap_or_else(|| {
                        failed_project_result(
                            &project_id,
                            "Backend apply response did not include this project.",
                        )
                    })
            })
            .collect()
    }

    fn apply_remote_project_batch_with_split_on_error(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        mut tasks: Vec<QueuedRemoteApplyTask>,
        transport_id: &str,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> Vec<SyncTransportProjectResult> {
        if tasks.is_empty() {
            return Vec::new();
        }

        match apply_remote_project_batch(
            client,
            peer_device_id,
            remote_metadata,
            &tasks,
            transport_id,
            timings,
            progress,
        ) {
            Ok(results) => results,
            Err(_) if tasks.len() > 1 => {
                let split_at = tasks.len() / 2;
                let right_tasks = tasks.split_off(split_at);
                let mut results = apply_remote_project_batch_with_split_on_error(
                    client,
                    peer_device_id,
                    remote_metadata,
                    tasks,
                    transport_id,
                    timings,
                    progress,
                );
                results.extend(apply_remote_project_batch_with_split_on_error(
                    client,
                    peer_device_id,
                    remote_metadata,
                    right_tasks,
                    transport_id,
                    timings,
                    progress,
                ));
                results
            }
            Err(error) => {
                let message = phase_context_error("reconciliation apply", error.to_string());
                vec![failed_project_result(&tasks[0].project_id, &message)]
            }
        }
    }

    fn apply_remote_project_batch(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        tasks: &[QueuedRemoteApplyTask],
        transport_id: &str,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> Result<Vec<SyncTransportProjectResult>, BackendError> {
        let mut project_ids = Vec::new();
        let mut manifests = Vec::new();
        let mut metadata_project_ids = Vec::new();
        let mut available_content_sha256 = Vec::new();
        let mut seen_project_ids = HashSet::new();
        let mut seen_manifests = HashSet::new();
        let mut seen_metadata_project_ids = HashSet::new();
        let mut seen_content_sha256 = HashSet::new();

        for queued in tasks {
            match &queued.task {
                RemoteApplyTask::Project(project) => {
                    push_unique_string(
                        &mut project_ids,
                        &mut seen_project_ids,
                        queued.project_id.clone(),
                    );
                    for manifest in apply_project_manifests_with_cleanup_context(
                        &project.manifest,
                        &project.cleanup_context_manifests,
                    ) {
                        push_apply_manifest_for_batch(
                            &mut manifests,
                            &mut metadata_project_ids,
                            &mut seen_manifests,
                            &mut seen_metadata_project_ids,
                            manifest,
                        );
                    }
                    for content_sha256 in &project.available_content_sha256 {
                        push_unique_string(
                            &mut available_content_sha256,
                            &mut seen_content_sha256,
                            content_sha256.clone(),
                        );
                    }
                }
                RemoteApplyTask::Tombstone(project_id) => {
                    push_unique_string(&mut project_ids, &mut seen_project_ids, project_id.clone());
                    push_unique_string(
                        &mut metadata_project_ids,
                        &mut seen_metadata_project_ids,
                        project_id.clone(),
                    );
                }
            }
        }

        let remote_metadata = remote_metadata_for_projects(remote_metadata, &metadata_project_ids);
        let body = reconciliation_apply_body_with_project_ids(
            peer_device_id,
            &remote_metadata,
            &manifests,
            &available_content_sha256,
            &project_ids,
            transport_id,
        );
        let timer = SyncPhaseTimer::start("reconciliation_apply");
        let response = {
            let _progress =
                progress.start_phase("reconciliation_apply", "Applying remote reconciliation.");
            client.post_json_value("/api/v1/sync/reconciliation/apply", &body)
        };
        timings.push(timer.finish());
        response.map(|response| map_project_apply_response(&project_ids, &response))
    }

    fn staged_transfer_failure_project_result(
        manifest: &Value,
        error: &str,
    ) -> SyncTransportProjectResult {
        let project_id = manifest_project_id(manifest);
        let transfer_failures = HashMap::from([(project_id.clone(), error.to_string())]);
        apply_failure_results(
            std::slice::from_ref(manifest),
            &transfer_failures,
            "Could not stage all remote artifact content before import.",
        )
        .into_iter()
        .next()
        .unwrap_or_else(|| {
            failed_project_result(
                &project_id,
                "Could not stage all remote artifact content before import.",
            )
        })
    }

    fn push_apply_manifest_for_batch(
        manifests: &mut Vec<Value>,
        metadata_project_ids: &mut Vec<String>,
        seen_manifests: &mut HashSet<String>,
        seen_metadata_project_ids: &mut HashSet<String>,
        manifest: Value,
    ) {
        let project_id = manifest_project_id(&manifest);
        push_unique_string(
            metadata_project_ids,
            seen_metadata_project_ids,
            project_id.clone(),
        );
        if seen_manifests.insert(project_id) {
            manifests.push(manifest);
        }
    }

    fn push_unique_string(values: &mut Vec<String>, seen: &mut HashSet<String>, value: String) {
        if seen.insert(value.clone()) {
            values.push(value);
        }
    }

    struct IrohScheduledRemoteProject {
        manifest: Value,
        transfers: Vec<SyncTransportTransferResult>,
        pending_artifacts: HashMap<String, RemoteArtifact>,
        transfer_failure: Option<String>,
        discovered: bool,
        enqueued: bool,
    }

    impl IrohScheduledRemoteProject {
        fn new(manifest: Value) -> Self {
            Self {
                manifest,
                transfers: Vec::new(),
                pending_artifacts: HashMap::new(),
                transfer_failure: None,
                discovered: false,
                enqueued: false,
            }
        }

        fn add_pending_artifact(&mut self, artifact: RemoteArtifact) {
            self.pending_artifacts
                .insert(artifact.artifact_id.clone(), artifact);
        }

        fn mark_discovered(&mut self) {
            self.discovered = true;
        }

        fn record_transfer(
            &mut self,
            transfer: Result<SyncTransportTransferResult, TransferFailure>,
            received_artifacts: &mut Vec<SyncTransportTransferResult>,
        ) {
            match transfer {
                Ok(result) => {
                    self.pending_artifacts.remove(&result.artifact_id);
                    self.transfers.push(result.clone());
                    received_artifacts.push(result);
                }
                Err(error) => {
                    self.pending_artifacts.remove(&error.result.artifact_id);
                    self.transfers.push(error.result.clone());
                    received_artifacts.push(error.result);
                    self.transfer_failure.get_or_insert(error.message);
                }
            }
        }

        fn fail_pending_artifacts(
            &mut self,
            message: &str,
            received_artifacts: &mut Vec<SyncTransportTransferResult>,
        ) {
            let pending = self.pending_artifacts.values().cloned().collect::<Vec<_>>();
            for artifact in pending {
                self.record_transfer(
                    Err(transfer_failure(
                        &artifact,
                        TransferTimer::zero_now(),
                        message.to_string(),
                    )),
                    received_artifacts,
                );
            }
        }

        fn is_ready(&self) -> bool {
            if !self.discovered
                || self.enqueued
                || (self.transfer_failure.is_none() && !self.pending_artifacts.is_empty())
            {
                return false;
            }
            true
        }

        fn take_ready_project(
            &mut self,
            cleanup_context_manifests: Vec<Value>,
        ) -> Option<StagedRemoteProject> {
            if !self.is_ready() {
                return None;
            }
            self.enqueued = true;
            Some(StagedRemoteProject {
                manifest: self.manifest.clone(),
                cleanup_context_manifests,
                available_content_sha256: available_content_sha256(&self.transfers),
                transfer_failure: self.transfer_failure.clone(),
            })
        }
    }

    struct IrohPendingArtifactSubscribers {
        artifact: RemoteArtifact,
        project_indices: Vec<usize>,
    }

    enum IrohRegisteredPlannedRemoteProject {
        Manifest {
            project_index: usize,
            manifest: Value,
            plan: Value,
        },
        Tombstone {
            project_id: String,
            plan: Value,
        },
    }

    #[derive(Default)]
    struct IrohGlobalProjectScheduler {
        projects: Vec<IrohScheduledRemoteProject>,
        artifact_subscribers: HashMap<String, IrohPendingArtifactSubscribers>,
    }

    impl IrohGlobalProjectScheduler {
        fn push_project(&mut self, manifest: Value) -> usize {
            let index = self.projects.len();
            self.projects
                .push(IrohScheduledRemoteProject::new(manifest));
            index
        }

        fn mark_project_discovered(&mut self, project_index: usize) {
            if let Some(project) = self.projects.get_mut(project_index) {
                project.mark_discovered();
            }
        }

        fn add_pending_artifact(
            &mut self,
            project_index: usize,
            artifact: RemoteArtifact,
        ) -> Result<bool, String> {
            let artifact_id = artifact.artifact_id.clone();
            if let Some(project) = self.projects.get_mut(project_index) {
                project.add_pending_artifact(artifact.clone());
            }
            if let Some(subscribers) = self.artifact_subscribers.get_mut(&artifact_id) {
                if subscribers.artifact.content_sha256 != artifact.content_sha256
                    || subscribers.artifact.size_bytes != artifact.size_bytes
                {
                    return Err(format!(
                        "Sync artifact batch repeated artifact {artifact_id}."
                    ));
                }
                subscribers.project_indices.push(project_index);
                return Ok(false);
            }
            self.artifact_subscribers.insert(
                artifact_id,
                IrohPendingArtifactSubscribers {
                    artifact,
                    project_indices: vec![project_index],
                },
            );
            Ok(true)
        }

        fn record_project_transfer(
            &mut self,
            project_index: usize,
            transfer: Result<SyncTransportTransferResult, TransferFailure>,
            received_artifacts: &mut Vec<SyncTransportTransferResult>,
        ) {
            if let Some(project) = self.projects.get_mut(project_index) {
                project.record_transfer(transfer, received_artifacts);
            }
        }

        fn record_artifact_transfer(
            &mut self,
            transfer: Result<SyncTransportTransferResult, TransferFailure>,
            received_artifacts: &mut Vec<SyncTransportTransferResult>,
        ) {
            let artifact_id = match &transfer {
                Ok(result) => result.artifact_id.clone(),
                Err(error) => error.result.artifact_id.clone(),
            };
            let Some(subscribers) = self.artifact_subscribers.remove(&artifact_id) else {
                return;
            };
            for project_index in subscribers.project_indices {
                self.record_project_transfer(project_index, transfer.clone(), received_artifacts);
            }
        }

        fn drain_ready_projects(&mut self) -> Vec<StagedRemoteProject> {
            let ready_indices = self
                .projects
                .iter()
                .enumerate()
                .filter_map(|(index, project)| project.is_ready().then_some(index))
                .collect::<Vec<_>>();
            let mut staged = Vec::new();
            for index in ready_indices {
                let cleanup_context_manifests = self.cleanup_context_manifests_for(index);
                if let Some(project) = self
                    .projects
                    .get_mut(index)
                    .and_then(|project| project.take_ready_project(cleanup_context_manifests))
                {
                    staged.push(project);
                }
            }
            staged
        }

        fn cleanup_context_manifests_for(&self, ready_index: usize) -> Vec<Value> {
            self.projects
                .iter()
                .enumerate()
                .filter(|(index, project)| *index != ready_index && !project.enqueued)
                .map(|(_, project)| project.manifest.clone())
                .collect()
        }

        fn fail_unfinished_projects(
            &mut self,
            message: &str,
            received_artifacts: &mut Vec<SyncTransportTransferResult>,
        ) -> Vec<StagedRemoteProject> {
            for project in &mut self.projects {
                if !project.enqueued && !project.pending_artifacts.is_empty() {
                    project.fail_pending_artifacts(message, received_artifacts);
                }
            }
            self.drain_ready_projects()
        }
    }

    fn register_planned_iroh_projects(
        planned_projects: Vec<PlannedRemoteProject>,
        scheduler: &mut IrohGlobalProjectScheduler,
    ) -> Vec<IrohRegisteredPlannedRemoteProject> {
        planned_projects
            .into_iter()
            .map(|planned| match planned.manifest {
                Some(manifest) => {
                    let project_index = scheduler.push_project(manifest.clone());
                    IrohRegisteredPlannedRemoteProject::Manifest {
                        project_index,
                        manifest,
                        plan: planned.plan,
                    }
                }
                None => IrohRegisteredPlannedRemoteProject::Tombstone {
                    project_id: planned.project_id,
                    plan: planned.plan,
                },
            })
            .collect()
    }

    fn record_iroh_batch_scheduler_transfer(
        scheduler: &mut IrohGlobalProjectScheduler,
        received_artifacts: &mut Vec<SyncTransportTransferResult>,
        ready_projects: &mut Vec<StagedRemoteProject>,
        ready_tombstone_project_ids: &mut Vec<String>,
        apply_worker: &mut RemoteApplyWorker,
        transfer: Result<SyncTransportTransferResult, TransferFailure>,
        allow_project_apply: bool,
    ) {
        scheduler.record_artifact_transfer(transfer, received_artifacts);
        ready_projects.extend(scheduler.drain_ready_projects());
        if allow_project_apply {
            enqueue_collected_iroh_ready_projects(
                apply_worker,
                ready_projects,
                ready_tombstone_project_ids,
            );
        }
    }

    fn stage_remote_manifest_iroh_artifacts(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        iroh_data: IrohDataConnection,
        peer_device_id: &str,
        planned_projects: Vec<PlannedRemoteProject>,
        apply_worker: &mut RemoteApplyWorker,
        received_artifacts: &mut Vec<SyncTransportTransferResult>,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) {
        let mut scheduler = IrohGlobalProjectScheduler::default();
        let mut pending = Vec::new();
        let mut ready_projects = Vec::new();
        let mut ready_tombstone_project_ids = Vec::new();
        let registered_projects = register_planned_iroh_projects(planned_projects, &mut scheduler);

        for planned in registered_projects {
            if progress.is_cancelled() {
                apply_worker.cancel_pending_apply();
                break;
            }
            match planned {
                IrohRegisteredPlannedRemoteProject::Manifest {
                    project_index,
                    manifest,
                    plan,
                } => {
                    let entries = planned_fetch_artifact_entries(
                        &plan,
                        std::slice::from_ref(&manifest),
                        peer_device_id,
                    );
                    for entry in entries {
                        let artifact = entry.artifact;
                        let timer =
                            SyncPhaseTimer::start_artifact("artifact_staging_check", &artifact);
                        let staged = {
                            let _progress = progress.start_phase(
                                "artifact_transfer",
                                "Checking staged artifact content.",
                            );
                            already_staged_artifact_result(client, &artifact)
                        };
                        timings.push(timer.finish());
                        match staged {
                            Ok(true) => {
                                scheduler.record_project_transfer(
                                    project_index,
                                    Ok(transfer_result(
                                        &artifact,
                                        "already_staged",
                                        Some(
                                            "Artifact content was already staged and verified locally."
                                                .to_string(),
                                        ),
                                        TransferTimer::zero_now(),
                                    )),
                                    received_artifacts,
                                );
                            }
                            Ok(false) => match scheduler
                                .add_pending_artifact(project_index, artifact.clone())
                            {
                                Ok(true) => pending.push(PendingArtifactTransfer { artifact }),
                                Ok(false) => {}
                                Err(error) => scheduler.record_project_transfer(
                                    project_index,
                                    Err(transfer_failure(
                                        &artifact,
                                        TransferTimer::zero_now(),
                                        error,
                                    )),
                                    received_artifacts,
                                ),
                            },
                            Err(error) => scheduler.record_project_transfer(
                                project_index,
                                Err(transfer_failure(
                                    &artifact,
                                    TransferTimer::zero_now(),
                                    error,
                                )),
                                received_artifacts,
                            ),
                        }
                    }
                    scheduler.mark_project_discovered(project_index);
                    ready_projects.extend(scheduler.drain_ready_projects());
                }
                IrohRegisteredPlannedRemoteProject::Tombstone { project_id, plan } => {
                    if planned_delete_project_ids(&plan)
                        .into_iter()
                        .any(|delete_project_id| delete_project_id == project_id)
                    {
                        ready_tombstone_project_ids.push(project_id);
                    }
                }
            }
        }

        if !pending.is_empty() {
            if progress.is_cancelled() {
                apply_worker.cancel_pending_apply();
                return;
            }
            let pending = round_robin_pending_artifacts_by_project(pending);
            let can_apply_after_iroh = request_and_stage_global_iroh_artifact_batch_on_write_lane(
                client,
                connection,
                iroh_data,
                peer_device_id,
                pending,
                metrics,
                timings,
                progress,
                apply_worker,
                |transfer, allow_project_apply, apply_worker| {
                    record_iroh_batch_scheduler_transfer(
                        &mut scheduler,
                        received_artifacts,
                        &mut ready_projects,
                        &mut ready_tombstone_project_ids,
                        apply_worker,
                        transfer,
                        allow_project_apply,
                    );
                },
            );
            if !can_apply_after_iroh {
                apply_worker.cancel_pending_apply();
                enqueue_collected_iroh_ready_projects(
                    apply_worker,
                    &mut ready_projects,
                    &mut ready_tombstone_project_ids,
                );
                for staged in scheduler.fail_unfinished_projects(
                    "Sync artifact batch transfer stopped before all project artifacts were staged.",
                    received_artifacts,
                ) {
                    apply_worker.enqueue_project(staged);
                }
                return;
            }
        }

        enqueue_collected_iroh_ready_projects(
            apply_worker,
            &mut ready_projects,
            &mut ready_tombstone_project_ids,
        );
        for staged in scheduler.fail_unfinished_projects(
            "Sync artifact batch transfer stopped before all project artifacts were staged.",
            received_artifacts,
        ) {
            apply_worker.enqueue_project(staged);
        }
    }

    fn enqueue_collected_iroh_ready_projects(
        apply_worker: &mut RemoteApplyWorker,
        ready_projects: &mut Vec<StagedRemoteProject>,
        ready_tombstone_project_ids: &mut Vec<String>,
    ) {
        for staged in ready_projects.drain(..) {
            apply_worker.enqueue_project(staged);
        }
        for project_id in ready_tombstone_project_ids.drain(..) {
            apply_worker.enqueue_tombstone(project_id);
        }
    }

    fn stage_remote_manifest_project_artifacts(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        peer_device_id: &str,
        manifest: &Value,
        plan: &Value,
        received_artifacts: &mut Vec<SyncTransportTransferResult>,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> StagedRemoteProject {
        let mut project_transfers = Vec::new();
        let mut transfer_failure = None;

        let entries =
            planned_fetch_artifact_entries(plan, std::slice::from_ref(manifest), peer_device_id);
        for transfer in request_or_use_staged_artifacts(
            client,
            connection,
            peer_device_id,
            &entries,
            metrics,
            timings,
            progress,
        ) {
            match transfer {
                Ok(result) => {
                    project_transfers.push(result.clone());
                    received_artifacts.push(result);
                }
                Err(error) => {
                    project_transfers.push(error.result.clone());
                    received_artifacts.push(error.result);
                    transfer_failure.get_or_insert(error.message);
                }
            }
        }

        StagedRemoteProject {
            manifest: manifest.clone(),
            cleanup_context_manifests: Vec::new(),
            available_content_sha256: available_content_sha256(&project_transfers),
            transfer_failure,
        }
    }

    fn plan_remote_manifest_chunk(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
        transport_id: &str,
    ) -> Result<Value, BackendError> {
        let body = reconciliation_plan_body_for_manifest_chunk(
            peer_device_id,
            remote_metadata,
            manifests,
            transport_id,
        );
        client.post_json_value("/api/v1/sync/reconciliation/plan", &body)
    }

    fn plan_remote_delete_chunk(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        project_ids: &[String],
        transport_id: &str,
    ) -> Result<Value, BackendError> {
        let body = reconciliation_plan_body_for_delete_chunk(
            peer_device_id,
            remote_metadata,
            project_ids,
            transport_id,
        );
        client.post_json_value("/api/v1/sync/reconciliation/plan", &body)
    }

    fn apply_project_manifests_with_cleanup_context(
        manifest: &Value,
        cleanup_context_manifests: &[Value],
    ) -> Vec<Value> {
        let project_id = manifest_project_id(manifest);
        let mut seen_project_ids = HashSet::from([project_id]);
        let mut manifests = Vec::with_capacity(cleanup_context_manifests.len() + 1);
        manifests.push(manifest.clone());
        for context_manifest in cleanup_context_manifests {
            let context_project_id = manifest_project_id(context_manifest);
            if seen_project_ids.insert(context_project_id) {
                manifests.push(context_manifest.clone());
            }
        }
        manifests
    }

    fn reconciliation_plan_body(
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
        available_content_sha256: &[String],
        transport_id: &str,
    ) -> Value {
        json!({
            "remote_library": remote_metadata,
            "project_manifests": manifests,
            "peer_inventory": [{
                "device_id": peer_device_id,
                "available_content_sha256": available_content_sha256,
                "metadata": { "transport": transport_id },
            }],
        })
    }

    fn reconciliation_plan_body_for_manifest_chunk(
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
        transport_id: &str,
    ) -> Value {
        let project_ids: Vec<String> = manifests.iter().map(manifest_project_id).collect();
        let remote_metadata = remote_metadata_for_projects(remote_metadata, &project_ids);
        let advertised_content_sha256 = manifest_content_sha256(manifests);
        reconciliation_plan_body(
            peer_device_id,
            &remote_metadata,
            manifests,
            &advertised_content_sha256,
            transport_id,
        )
    }

    fn reconciliation_plan_body_for_delete_chunk(
        peer_device_id: &str,
        remote_metadata: &Value,
        project_ids: &[String],
        transport_id: &str,
    ) -> Value {
        let remote_metadata = remote_metadata_for_projects(remote_metadata, project_ids);
        reconciliation_plan_body(peer_device_id, &remote_metadata, &[], &[], transport_id)
    }

    #[cfg(test)]
    fn reconciliation_apply_body(
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
        available_content_sha256: &[String],
        transport_id: &str,
    ) -> Value {
        let project_ids: Vec<String> = manifests.iter().map(manifest_project_id).collect();
        reconciliation_apply_body_with_project_ids(
            peer_device_id,
            remote_metadata,
            manifests,
            available_content_sha256,
            &project_ids,
            transport_id,
        )
    }

    fn reconciliation_apply_body_with_project_ids(
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
        available_content_sha256: &[String],
        project_ids: &[String],
        transport_id: &str,
    ) -> Value {
        json!({
            "remote_library": remote_metadata,
            "project_manifests": manifests,
            "peer_inventory": [{
                "device_id": peer_device_id,
                "available_content_sha256": available_content_sha256,
                "metadata": { "transport": transport_id },
            }],
            "project_ids": project_ids,
            "use_content_addressed_staging": true,
            "include_timing_evidence": true,
        })
    }

    #[cfg(test)]
    fn remote_metadata_for_project(remote_metadata: &Value, project_id: &str) -> Value {
        remote_metadata_for_projects(remote_metadata, &[project_id.to_string()])
    }

    fn remote_metadata_for_projects(remote_metadata: &Value, project_ids: &[String]) -> Value {
        let project_ids: HashSet<&str> = project_ids.iter().map(String::as_str).collect();
        let mut metadata = remote_metadata
            .as_object()
            .cloned()
            .unwrap_or_else(serde_json::Map::new);
        metadata.insert(
            "projects".to_string(),
            filtered_project_array_for_projects(remote_metadata, "projects", &project_ids),
        );
        metadata.insert(
            "artifacts".to_string(),
            filtered_project_array_for_projects(remote_metadata, "artifacts", &project_ids),
        );
        metadata.insert(
            "entity_revisions".to_string(),
            filtered_project_array_for_projects(remote_metadata, "entity_revisions", &project_ids),
        );
        metadata.insert(
            "delete_tombstones".to_string(),
            filtered_project_array_for_projects(remote_metadata, "delete_tombstones", &project_ids),
        );
        Value::Object(metadata)
    }

    fn filtered_project_array_for_projects(
        metadata: &Value,
        key: &str,
        project_ids: &HashSet<&str>,
    ) -> Value {
        let values = metadata
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        value_project_id(item)
                            .is_some_and(|project_id| project_ids.contains(project_id))
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Value::Array(values)
    }

    fn value_project_id(value: &Value) -> Option<&str> {
        value
            .get("project_id")
            .and_then(Value::as_str)
            .or_else(|| value.get("projectId").and_then(Value::as_str))
            .or_else(|| {
                value
                    .get("project")
                    .and_then(|project| project.get("project_id"))
                    .and_then(Value::as_str)
            })
    }

    fn remote_delete_tombstone_project_ids(remote_metadata: &Value) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut project_ids: Vec<String> = remote_metadata
            .get("delete_tombstones")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(value_project_id)
            .map(str::to_string)
            .filter(|project_id| seen.insert(project_id.clone()))
            .collect();
        project_ids.sort();
        project_ids
    }

    fn planned_delete_project_ids(plan: &Value) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut project_ids: Vec<String> = plan
            .get("actions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|action| {
                action.get("action_type").and_then(Value::as_str) == Some("apply_delete_tombstone")
            })
            .filter_map(|action| {
                action
                    .get("project_id")
                    .and_then(Value::as_str)
                    .or_else(|| action.get("item_id").and_then(Value::as_str))
                    .map(str::to_string)
            })
            .filter(|project_id| seen.insert(project_id.clone()))
            .collect();
        project_ids.sort();
        project_ids
    }

    #[derive(Clone, Debug, Default)]
    struct ProjectApplyOutcome {
        applied_actions: u64,
        satisfied_actions: u64,
        skipped_actions: u64,
        failed_actions: u64,
        conflicted_actions: u64,
        imported_project_manifest: bool,
        applied_delete_tombstone: bool,
        selected_reason: Option<String>,
        selected_reason_priority: u8,
    }

    impl ProjectApplyOutcome {
        fn record(&mut self, status: &str, action: &Value, reason: Option<&str>) {
            let action_type = action.get("action_type").and_then(Value::as_str);
            if action_type == Some("record_conflict")
                || action_project_status(action) == Some("conflicted")
            {
                self.conflicted_actions = self.conflicted_actions.saturating_add(1);
            }
            match status {
                "applied" => {
                    self.applied_actions = self.applied_actions.saturating_add(1);
                    if action_type == Some("import_project_manifest") {
                        self.imported_project_manifest = true;
                    }
                    if action_type == Some("apply_delete_tombstone") {
                        self.applied_delete_tombstone = true;
                    }
                }
                "satisfied" => self.satisfied_actions = self.satisfied_actions.saturating_add(1),
                "skipped" => self.skipped_actions = self.skipped_actions.saturating_add(1),
                "failed" => self.failed_actions = self.failed_actions.saturating_add(1),
                _ => self.skipped_actions = self.skipped_actions.saturating_add(1),
            }
            if let Some(reason) = reason {
                self.select_reason(reason, action_reason_priority(status, action));
            }
        }

        fn record_plan_item(&mut self, item: &Value) {
            let Some(reason) = item.get("reason").and_then(Value::as_str) else {
                return;
            };
            self.select_reason(reason, plan_item_reason_priority(item));
        }

        fn select_reason(&mut self, reason: &str, priority: u8) {
            let reason = reason.trim();
            if reason.is_empty() {
                return;
            }
            if self.selected_reason.is_none() || priority >= self.selected_reason_priority {
                self.selected_reason = Some(reason.to_string());
                self.selected_reason_priority = priority;
            }
        }

        fn status(&self) -> &'static str {
            if self.failed_actions > 0 {
                "failed"
            } else if self.conflicted_actions > 0 {
                "conflicted"
            } else if self.applied_delete_tombstone {
                "deleted"
            } else if self.imported_project_manifest {
                "imported"
            } else if self.applied_actions > 0 {
                "applied"
            } else {
                "skipped"
            }
        }

        fn message(&self) -> String {
            let mut message = format!(
                "Reconciliation apply: {} applied, {} satisfied, {} skipped, {} failed, {} conflicted action(s).",
                self.applied_actions,
                self.satisfied_actions,
                self.skipped_actions,
                self.failed_actions,
                self.conflicted_actions,
            );
            if let Some(reason) = &self.selected_reason {
                message.push(' ');
                message.push_str(reason);
            }
            message
        }
    }

    fn action_reason_priority(status: &str, action: &Value) -> u8 {
        let action_type = action.get("action_type").and_then(Value::as_str);
        if status == "failed" {
            return 50;
        }
        if action_type == Some("record_conflict") {
            return 45;
        }
        if action_project_status(action) == Some("conflicted") {
            return 40;
        }
        match status {
            "applied" => 30,
            "satisfied" => 20,
            "skipped" => 10,
            _ => 0,
        }
    }

    fn plan_item_reason_priority(item: &Value) -> u8 {
        if let Some(reason) = item.get("reason").and_then(Value::as_str) {
            if generated_analysis_reason(reason, item) {
                return 35;
            }
        }
        match item.get("status").and_then(Value::as_str) {
            Some("conflicted") => 42,
            Some("missing_provider") | Some("missing_local_bytes") | Some("remote_available") => 15,
            Some("identical_content") | Some("noop") => 12,
            _ => 5,
        }
    }

    fn apply_result_reason<'a>(result: &'a Value, action: &'a Value) -> Option<&'a str> {
        let result_reason = result.get("reason").and_then(Value::as_str);
        let action_reason = action.get("reason").and_then(Value::as_str);
        if action.get("action_type").and_then(Value::as_str) == Some("record_conflict") {
            return action_reason.or(result_reason);
        }
        if action_reason.is_some_and(|reason| generated_analysis_reason(reason, action)) {
            return action_reason;
        }
        if result_reason.is_some_and(is_generic_apply_reason) {
            return action_reason.or(result_reason);
        }
        result_reason.or(action_reason)
    }

    fn is_generic_apply_reason(reason: &str) -> bool {
        matches!(
            reason.trim(),
            "Action is already satisfied."
                | "Required artifact content is staged."
                | "Required artifact content is staged and verified locally."
                | "Artifact manifest was imported into the existing project."
                | "Artifact manifest was imported through the mobile sync manifest service."
                | "Project sync status was updated through the mobile sync status service."
        )
    }

    fn generated_analysis_reason(reason: &str, value: &Value) -> bool {
        let reason = reason.to_ascii_lowercase();
        if reason.contains("generated analysis")
            || reason.contains("analysis artifact")
            || reason.contains("analysis_json")
        {
            return true;
        }
        if !value_contains_text(value, "analysis_json") {
            return false;
        }
        [
            "diverg",
            "newer",
            "updated",
            "kept",
            "keep",
            "local",
            "remote",
            "tie",
            "generated",
        ]
        .iter()
        .any(|needle| reason.contains(needle))
    }

    fn value_contains_text(value: &Value, needle: &str) -> bool {
        match value {
            Value::String(value) => value.to_ascii_lowercase().contains(needle),
            Value::Array(values) => values
                .iter()
                .any(|value| value_contains_text(value, needle)),
            Value::Object(values) => values.iter().any(|(key, value)| {
                key.to_ascii_lowercase().contains(needle) || value_contains_text(value, needle)
            }),
            _ => false,
        }
    }

    #[cfg(test)]
    fn map_batch_apply_response(
        manifests: &[Value],
        response: &Value,
    ) -> Vec<SyncTransportProjectResult> {
        let mut outcomes: HashMap<String, ProjectApplyOutcome> = manifests
            .iter()
            .map(|manifest| {
                (
                    manifest_project_id(manifest),
                    ProjectApplyOutcome::default(),
                )
            })
            .collect();

        record_plan_item_reasons(&mut outcomes, response);

        for result in response
            .get("results")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let action = result.get("action").unwrap_or(&Value::Null);
            let Some(project_id) = apply_result_project_id(action) else {
                continue;
            };
            let Some(outcome) = outcomes.get_mut(project_id) else {
                continue;
            };
            let status = result
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("skipped");
            outcome.record(status, action, apply_result_reason(result, action));
        }

        manifests
            .iter()
            .map(|manifest| manifest_project_id(manifest))
            .map(|project_id| {
                let outcome = outcomes.remove(&project_id);
                outcome_to_project_result(project_id, outcome)
            })
            .collect()
    }

    fn map_project_apply_response(
        project_ids: &[String],
        response: &Value,
    ) -> Vec<SyncTransportProjectResult> {
        let mut outcomes: HashMap<String, ProjectApplyOutcome> = project_ids
            .iter()
            .map(|project_id| (project_id.clone(), ProjectApplyOutcome::default()))
            .collect();

        record_plan_item_reasons(&mut outcomes, response);

        for result in response
            .get("results")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let action = result.get("action").unwrap_or(&Value::Null);
            let Some(project_id) = apply_result_project_id(action) else {
                continue;
            };
            let Some(outcome) = outcomes.get_mut(project_id) else {
                continue;
            };
            let status = result
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("skipped");
            outcome.record(status, action, apply_result_reason(result, action));
        }

        project_ids
            .iter()
            .map(|project_id| {
                let outcome = outcomes.remove(project_id);
                outcome_to_project_result(project_id.clone(), outcome)
            })
            .collect()
    }

    fn record_plan_item_reasons(
        outcomes: &mut HashMap<String, ProjectApplyOutcome>,
        response: &Value,
    ) {
        for item in response
            .get("plan")
            .and_then(|plan| plan.get("items"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(project_id) = plan_item_project_id(item) else {
                continue;
            };
            if let Some(outcome) = outcomes.get_mut(project_id) {
                outcome.record_plan_item(item);
            }
        }
    }

    fn plan_item_project_id(item: &Value) -> Option<&str> {
        item.get("project_id").and_then(Value::as_str).or_else(|| {
            if item.get("item_type").and_then(Value::as_str) == Some("project") {
                item.get("item_id").and_then(Value::as_str)
            } else {
                None
            }
        })
    }

    fn outcome_to_project_result(
        project_id: String,
        outcome: Option<ProjectApplyOutcome>,
    ) -> SyncTransportProjectResult {
        let outcome = outcome.unwrap_or_default();
        let message = if outcome.applied_actions == 0
            && outcome.satisfied_actions == 0
            && outcome.skipped_actions == 0
            && outcome.failed_actions == 0
            && outcome.conflicted_actions == 0
        {
            "Reconciliation apply: no import actions were needed for this project.".to_string()
        } else {
            outcome.message()
        };
        SyncTransportProjectResult {
            project_id,
            status: outcome.status().to_string(),
            message: Some(message),
        }
    }

    fn apply_result_project_id(action: &Value) -> Option<&str> {
        action
            .get("project_id")
            .and_then(Value::as_str)
            .or_else(|| match action.get("item_type").and_then(Value::as_str) {
                Some("project") => action.get("item_id").and_then(Value::as_str),
                _ => None,
            })
    }

    fn action_project_status(action: &Value) -> Option<&str> {
        action
            .get("details")
            .and_then(|details| details.get("project_status"))
            .and_then(Value::as_str)
    }

    fn apply_failure_results(
        manifests: &[Value],
        transfer_failures: &HashMap<String, String>,
        apply_error: &str,
    ) -> Vec<SyncTransportProjectResult> {
        manifests
            .iter()
            .map(|manifest| {
                let project_id = manifest_project_id(manifest);
                let message = transfer_failures.get(&project_id).map_or_else(
                    || format!("Could not apply remote sync reconciliation batch: {apply_error}"),
                    |error| {
                        format!(
                            "Could not stage all remote artifact content before import: {error}"
                        )
                    },
                );
                SyncTransportProjectResult {
                    project_id,
                    status: "failed".to_string(),
                    message: Some(message),
                }
            })
            .collect()
    }

    fn failed_project_result(project_id: &str, message: &str) -> SyncTransportProjectResult {
        SyncTransportProjectResult {
            project_id: project_id.to_string(),
            status: "failed".to_string(),
            message: Some(message.to_string()),
        }
    }

    fn plan_failure_project_result(
        project_id: &str,
        message: String,
    ) -> SyncTransportProjectResult {
        failed_project_result(
            project_id,
            &phase_context_error("reconciliation plan", message),
        )
    }

    fn available_content_sha256(received_artifacts: &[SyncTransportTransferResult]) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut values: Vec<String> = received_artifacts
            .iter()
            .filter(|artifact| matches!(artifact.status.as_str(), "received" | "already_staged"))
            .filter_map(|artifact| {
                if seen.insert(artifact.content_sha256.clone()) {
                    Some(artifact.content_sha256.clone())
                } else {
                    None
                }
            })
            .collect();
        values.sort();
        values
    }

    fn transfer_counts(
        transfer_results: &[SyncTransportTransferResult],
    ) -> SyncTransportTransferCounts {
        let mut counts = SyncTransportTransferCounts {
            requested: transfer_results.len(),
            ..SyncTransportTransferCounts::default()
        };
        for result in transfer_results {
            match result.status.as_str() {
                "received" => {
                    counts.received = counts.received.saturating_add(1);
                    counts.received_bytes = counts.received_bytes.saturating_add(result.size_bytes);
                }
                "already_staged" => {
                    counts.already_staged = counts.already_staged.saturating_add(1);
                    counts.already_staged_bytes = counts
                        .already_staged_bytes
                        .saturating_add(result.size_bytes);
                }
                "failed" => counts.failed = counts.failed.saturating_add(1),
                _ => {}
            }
        }
        counts
    }

    fn manifest_content_sha256(manifests: &[Value]) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut values: Vec<String> = manifest_artifact_entries(manifests)
            .into_iter()
            .filter_map(|entry| {
                if seen.insert(entry.artifact.content_sha256.clone()) {
                    Some(entry.artifact.content_sha256)
                } else {
                    None
                }
            })
            .collect();
        values.sort();
        values
    }

    fn planned_fetch_artifact_entries(
        plan: &Value,
        manifests: &[Value],
        provider_device_id: &str,
    ) -> Vec<ManifestArtifactEntry> {
        let requested = planned_fetch_keys(plan, provider_device_id);
        manifest_artifact_entries(manifests)
            .into_iter()
            .filter(|entry| {
                requested.contains(&(
                    entry.artifact.artifact_id.clone(),
                    entry.artifact.project_id.clone(),
                    entry.artifact.content_sha256.clone(),
                ))
            })
            .collect()
    }

    fn planned_fetch_keys(
        plan: &Value,
        provider_device_id: &str,
    ) -> HashSet<(String, String, String)> {
        plan.get("actions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|action| {
                action.get("action_type").and_then(Value::as_str) == Some("fetch_artifact_content")
                    && action.get("provider_device_id").and_then(Value::as_str)
                        == Some(provider_device_id)
            })
            .filter_map(|action| {
                Some((
                    action.get("item_id")?.as_str()?.to_string(),
                    action.get("project_id")?.as_str()?.to_string(),
                    action.get("content_sha256")?.as_str()?.to_string(),
                ))
            })
            .collect()
    }

    fn import_outcome_counts(results: &[SyncTransportProjectResult]) -> ImportOutcomeCounts {
        let mut counts = ImportOutcomeCounts::default();
        for result in results {
            match result.status.as_str() {
                "imported" => counts.imported += 1,
                "failed" | "conflicted" => counts.failed += 1,
                _ => counts.skipped += 1,
            }
        }
        counts
    }

    fn sync_result_status(
        manifest_errors: &[SyncTransportManifestError],
        failed_project_count: usize,
    ) -> String {
        if failed_project_count > 0 || !manifest_errors.is_empty() {
            "completed_with_errors"
        } else {
            "completed"
        }
        .to_string()
    }

    fn sync_manifest_errors(
        local_errors: &[SyncTransportManifestError],
        remote_errors: &[SyncTransportManifestError],
    ) -> Vec<SyncTransportManifestError> {
        let mut errors = Vec::with_capacity(local_errors.len() + remote_errors.len());
        errors.extend(local_errors.iter().map(|error| SyncTransportManifestError {
            project_id: error.project_id.clone(),
            message: format!("Local manifest export failed: {}", error.message),
        }));
        errors.extend(
            remote_errors
                .iter()
                .map(|error| SyncTransportManifestError {
                    project_id: error.project_id.clone(),
                    message: format!("Peer manifest export failed: {}", error.message),
                }),
        );
        errors
    }

    fn sync_result_message(
        local_manifest_count: usize,
        remote_manifest_count: usize,
        transfer_counts: &SyncTransportTransferCounts,
        import_counts: ImportOutcomeCounts,
    ) -> String {
        format!(
            "Exchanged {local_manifest_count} local and {remote_manifest_count} remote manifest(s); imported {} project(s), skipped {} project(s), failed {} project(s), received {} artifact(s), reused {} staged artifact(s), failed {} transfer(s).",
            import_counts.imported,
            import_counts.skipped,
            import_counts.failed,
            transfer_counts.received,
            transfer_counts.already_staged,
            transfer_counts.failed
        )
    }

    #[derive(Clone, Debug)]
    struct RemoteArtifact {
        artifact_id: String,
        project_id: String,
        content_sha256: String,
        size_bytes: u64,
    }

    impl RemoteArtifact {
        fn artifact_request(&self) -> ArtifactRequest {
            ArtifactRequest {
                artifact_id: self.artifact_id.clone(),
                project_id: Some(self.project_id.clone()),
                content_sha256: self.content_sha256.clone(),
                size_bytes: self.size_bytes,
            }
        }
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct IrohArtifactStreamHeader {
        batch_token: String,
        artifact_id: String,
        content_sha256: String,
        size_bytes: u64,
        #[serde(default, skip_serializing_if = "is_false")]
        unavailable: bool,
    }

    fn is_false(value: &bool) -> bool {
        !*value
    }

    #[derive(Clone, Debug)]
    struct ManifestArtifactEntry {
        artifact: RemoteArtifact,
    }

    fn manifest_project_id(manifest: &Value) -> String {
        manifest
            .get("project")
            .and_then(|project| project.get("project_id"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string()
    }

    fn manifest_artifacts(manifest: &Value) -> Vec<RemoteArtifact> {
        manifest
            .get("artifacts")
            .and_then(Value::as_array)
            .map(|artifacts| {
                artifacts
                    .iter()
                    .filter_map(|artifact| {
                        let artifact_id = artifact.get("artifact_id")?.as_str()?.to_string();
                        let project_id = artifact.get("project_id")?.as_str()?.to_string();
                        let content_sha256 = artifact.get("content_sha256")?.as_str()?.to_string();
                        let size_bytes = artifact.get("size_bytes")?.as_u64()?;
                        Some(RemoteArtifact {
                            artifact_id,
                            project_id,
                            content_sha256,
                            size_bytes,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn manifest_artifact_entries(manifests: &[Value]) -> Vec<ManifestArtifactEntry> {
        manifests
            .iter()
            .flat_map(|manifest| {
                manifest_artifacts(manifest)
                    .into_iter()
                    .map(|artifact| ManifestArtifactEntry { artifact })
            })
            .collect()
    }

    struct PendingArtifactTransfer {
        artifact: RemoteArtifact,
    }

    fn round_robin_pending_artifacts_by_project(
        pending: Vec<PendingArtifactTransfer>,
    ) -> Vec<PendingArtifactTransfer> {
        let total = pending.len();
        let mut groups: Vec<(String, VecDeque<PendingArtifactTransfer>)> = Vec::new();
        for transfer in pending {
            let project_id = transfer.artifact.project_id.clone();
            if let Some((_, queue)) = groups.iter_mut().find(|(id, _)| id == &project_id) {
                queue.push_back(transfer);
                continue;
            }

            let mut queue = VecDeque::new();
            queue.push_back(transfer);
            groups.push((project_id, queue));
        }

        let mut ordered = Vec::with_capacity(total);
        while ordered.len() < total {
            let before = ordered.len();
            for (_, queue) in &mut groups {
                if let Some(transfer) = queue.pop_front() {
                    ordered.push(transfer);
                }
            }
            if ordered.len() == before {
                break;
            }
        }
        ordered
    }

    fn request_or_use_staged_artifacts(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        peer_device_id: &str,
        entries: &[ManifestArtifactEntry],
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> Vec<Result<SyncTransportTransferResult, TransferFailure>> {
        let mut results = Vec::new();
        let mut pending = Vec::new();

        for entry in entries {
            let artifact = &entry.artifact;
            if let Some(message) = progress.interruption_message() {
                results.push(Err(transfer_failure(
                    artifact,
                    TransferTimer::zero_now(),
                    message,
                )));
                continue;
            }
            let timer = SyncPhaseTimer::start_artifact("artifact_staging_check", artifact);
            let staged = {
                let _progress =
                    progress.start_phase("artifact_transfer", "Checking staged artifact content.");
                already_staged_artifact_result(client, artifact)
            };
            timings.push(timer.finish());
            match staged {
                Ok(true) => {
                    results.push(Ok(transfer_result(
                        artifact,
                        "already_staged",
                        Some(
                            "Artifact content was already staged and verified locally.".to_string(),
                        ),
                        TransferTimer::zero_now(),
                    )));
                }
                Ok(false) => pending.push(PendingArtifactTransfer {
                    artifact: artifact.clone(),
                }),
                Err(error) => {
                    results.push(Err(transfer_failure(
                        artifact,
                        TransferTimer::zero_now(),
                        error,
                    )));
                }
            }
        }

        results.extend(request_and_stage_artifact_batch(
            client,
            connection,
            peer_device_id,
            pending,
            metrics,
            timings,
            progress,
        ));
        results
    }

    fn already_staged_artifact_result(
        client: &BackendClient,
        artifact: &RemoteArtifact,
    ) -> Result<bool, String> {
        let path = format!(
            "/api/v1/sync/artifacts/staging/{}",
            percent_encode_path_segment(&artifact.content_sha256)
        );
        match client.get_json_value(&path) {
            Ok(staged) => {
                let staged_size_bytes = staged.get("size_bytes").and_then(Value::as_u64);
                if staged_size_bytes != Some(artifact.size_bytes) {
                    return Err(
                        "Existing staged sync artifact did not match the requested size."
                            .to_string(),
                    );
                }
                Ok(true)
            }
            Err(error) if error.status == Some(404) => Ok(false),
            Err(error) => Err(format!(
                "Could not inspect staged sync artifact {}: {error}",
                artifact.content_sha256
            )),
        }
    }

    fn request_and_stage_artifact_batch(
        client: &(impl ArtifactStagingClient + Sync),
        connection: &SharedPeerConnection,
        peer_device_id: &str,
        pending: Vec<PendingArtifactTransfer>,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> Vec<Result<SyncTransportTransferResult, TransferFailure>> {
        if pending.is_empty() {
            return Vec::new();
        }
        if let Some(message) = progress.interruption_message() {
            return pending
                .into_iter()
                .map(|pending| {
                    Err(transfer_failure(
                        &pending.artifact,
                        TransferTimer::zero_now(),
                        message.clone(),
                    ))
                })
                .collect();
        }

        let request = ArtifactBatchRequest {
            batch_token: None,
            artifacts: pending
                .iter()
                .map(|pending| pending.artifact.artifact_request())
                .collect(),
        };
        let _progress = progress.start_phase("artifact_transfer", "Transferring artifact content.");
        if let Err(error) = connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::ArtifactBatchRequest(request),
        ) {
            return pending
                .into_iter()
                .map(|pending| {
                    Err(transfer_failure(
                        &pending.artifact,
                        TransferTimer::zero_now(),
                        error.clone(),
                    ))
                })
                .collect();
        }

        let mut results = Vec::new();
        let mut pending = pending.into_iter();
        while let Some(pending_transfer) = pending.next() {
            if let Some(message) = progress.interruption_message() {
                results.push(Err(transfer_failure(
                    &pending_transfer.artifact,
                    TransferTimer::zero_now(),
                    message.clone(),
                )));
                results.extend(pending.map(|pending| {
                    Err(transfer_failure(
                        &pending.artifact,
                        TransferTimer::zero_now(),
                        message.clone(),
                    ))
                }));
                break;
            }
            match receive_and_stage_artifact(
                client,
                connection,
                peer_device_id,
                pending_transfer,
                metrics,
                timings,
                progress,
            ) {
                Ok(result) => results.push(Ok(result)),
                Err(error) => {
                    if error.can_continue_batch {
                        results.push(Err(error));
                        continue;
                    }
                    let message = error.message.clone();
                    results.push(Err(error));
                    results.extend(pending.map(|pending| {
                        Err(transfer_failure(
                            &pending.artifact,
                            TransferTimer::zero_now(),
                            format!(
                                "Sync artifact batch transfer stopped after a peer error: {message}"
                            ),
                        ))
                    }));
                    break;
                }
            }
        }
        results
    }

    #[derive(Clone)]
    struct IrohPendingReceive {
        artifact: RemoteArtifact,
        temp_path: PathBuf,
    }

    struct IrohReceivedArtifact {
        artifact: RemoteArtifact,
        temp_path: PathBuf,
        timing: TransferTiming,
        phase_timing: SyncTransportTimingEvidence,
        size_bytes: u64,
        first_bytes_at: Option<Duration>,
        diagnostics: SyncTransportDiagnostics,
    }

    struct IrohArtifactReceiveError {
        artifact_id: Option<String>,
        message: String,
        timing: Option<TransferTiming>,
        phase_timing: Option<SyncTransportTimingEvidence>,
        diagnostics: SyncTransportDiagnostics,
    }

    struct IrohStageResult {
        transfer: Result<SyncTransportTransferResult, TransferFailure>,
        timings: Vec<SyncTransportTimingEvidence>,
        diagnostics: SyncTransportDiagnostics,
    }

    struct IrohActiveCredit {
        size_bytes: u64,
        granted_at: Instant,
    }

    struct IrohBatchCreditWindow {
        queue: VecDeque<String>,
        artifact_sizes: HashMap<String, u64>,
        active: HashMap<String, IrohActiveCredit>,
        reserved_bytes: u64,
        stream_cap: usize,
        byte_budget: u64,
        grants_issued: usize,
    }

    impl IrohBatchCreditWindow {
        fn new(pending: &[PendingArtifactTransfer], stream_cap: usize, byte_budget: u64) -> Self {
            let mut queue = VecDeque::with_capacity(pending.len());
            let mut artifact_sizes = HashMap::with_capacity(pending.len());
            for pending in pending {
                queue.push_back(pending.artifact.artifact_id.clone());
                artifact_sizes.insert(
                    pending.artifact.artifact_id.clone(),
                    pending.artifact.size_bytes,
                );
            }
            Self {
                queue,
                artifact_sizes,
                active: HashMap::new(),
                reserved_bytes: 0,
                stream_cap: stream_cap.max(1),
                byte_budget,
                grants_issued: 0,
            }
        }

        fn grant_available(&mut self, pending_stage_bytes: u64) -> Result<Vec<String>, String> {
            let mut artifact_ids = Vec::new();
            while self.active.len() < self.stream_cap {
                let Some(artifact_id) = self.queue.front().cloned() else {
                    break;
                };
                let size_bytes = self.artifact_sizes.get(&artifact_id).copied().unwrap_or(0);
                if size_bytes > self.byte_budget {
                    if self.active.is_empty() && artifact_ids.is_empty() {
                        return Err(format!(
                            "Iroh artifact {artifact_id} requires {size_bytes} byte(s), which exceeds the receive credit budget of {} byte(s).",
                            self.byte_budget
                        ));
                    }
                    break;
                }
                let scratch_bytes = self.reserved_bytes.saturating_add(pending_stage_bytes);
                if scratch_bytes.saturating_add(size_bytes) > self.byte_budget {
                    break;
                }
                self.queue.pop_front();
                self.reserved_bytes = self.reserved_bytes.saturating_add(size_bytes);
                self.active.insert(
                    artifact_id.clone(),
                    IrohActiveCredit {
                        size_bytes,
                        granted_at: Instant::now(),
                    },
                );
                self.grants_issued = self.grants_issued.saturating_add(1);
                artifact_ids.push(artifact_id);
            }
            Ok(artifact_ids)
        }

        fn release(&mut self, artifact_id: &str) -> Option<Duration> {
            if let Some(active) = self.active.remove(artifact_id) {
                self.reserved_bytes = self.reserved_bytes.saturating_sub(active.size_bytes);
                return Some(active.granted_at.elapsed());
            }
            None
        }

        fn clear(&mut self) -> Vec<Duration> {
            self.queue.clear();
            let held = self
                .active
                .drain()
                .map(|(_, active)| active.granted_at.elapsed())
                .collect();
            self.active.clear();
            self.reserved_bytes = 0;
            held
        }

        fn grants_issued(&self) -> usize {
            self.grants_issued
        }

        fn scratch_bytes(&self, pending_stage_bytes: u64) -> u64 {
            self.reserved_bytes.saturating_add(pending_stage_bytes)
        }

        fn active_credit_count(&self) -> usize {
            self.active.len()
        }
    }

    #[derive(Clone)]
    struct IrohBatchProgressMarker {
        progress_at: Arc<Mutex<Instant>>,
    }

    impl IrohBatchProgressMarker {
        fn new(started_at: Instant) -> Self {
            Self {
                progress_at: Arc::new(Mutex::new(started_at)),
            }
        }

        fn record(&self) {
            self.record_at(Instant::now());
        }

        fn record_at(&self, progress_at: Instant) {
            if let Ok(mut current) = self.progress_at.lock() {
                if progress_at > *current {
                    *current = progress_at;
                }
            }
        }

        fn snapshot(&self) -> Option<Instant> {
            self.progress_at.lock().ok().map(|current| *current)
        }
    }

    struct IrohBatchProgressWatchdog {
        last_progress_at: Instant,
        timeout: Duration,
        marker: IrohBatchProgressMarker,
    }

    impl IrohBatchProgressWatchdog {
        fn new(started_at: Instant, timeout: Duration) -> Self {
            Self {
                last_progress_at: started_at,
                timeout,
                marker: IrohBatchProgressMarker::new(started_at),
            }
        }

        fn marker(&self) -> IrohBatchProgressMarker {
            self.marker.clone()
        }

        fn record(&mut self) {
            self.record_at(Instant::now());
        }

        fn record_at(&mut self, progress_at: Instant) {
            if progress_at > self.last_progress_at {
                self.last_progress_at = progress_at;
                self.marker.record_at(progress_at);
            }
        }

        fn timed_out(&mut self) -> bool {
            self.timed_out_at(Instant::now())
        }

        fn timed_out_at(&mut self, now: Instant) -> bool {
            if let Some(progress_at) = self.marker.snapshot() {
                if progress_at > self.last_progress_at {
                    self.last_progress_at = progress_at;
                }
            }
            now.checked_duration_since(self.last_progress_at)
                .is_some_and(|elapsed| elapsed > self.timeout)
        }
    }

    enum IrohBatchControlStatus {
        Pending,
        Progress,
        Done,
    }

    fn poll_iroh_artifact_batch_control(
        connection: &SharedPeerConnection,
        batch_token: &str,
        progress: &ProgressReporter,
    ) -> Result<IrohBatchControlStatus, String> {
        let (message, had_status_progress) = connection
            .read_message_with_timeout_accepting_status_for_phase(
                "artifact request/transfer",
                IROH_BATCH_CONTROL_POLL_INTERVAL,
                progress,
            )?;
        match message {
            None if had_status_progress => Ok(IrohBatchControlStatus::Progress),
            None => Ok(IrohBatchControlStatus::Pending),
            Some(ProtocolMessage::ArtifactBatchEnd {
                batch_token: peer_batch_token,
            }) if peer_batch_token == batch_token => Ok(IrohBatchControlStatus::Done),
            Some(ProtocolMessage::ArtifactBatchEnd { .. }) => Err(
                "Sync peer Iroh artifact batch completion did not match the request.".to_string(),
            ),
            Some(ProtocolMessage::ArtifactBatchAbort {
                batch_token: peer_batch_token,
                message,
            }) if peer_batch_token == batch_token => {
                Err(phase_context_error("artifact request/transfer", message))
            }
            Some(ProtocolMessage::ArtifactBatchAbort { .. }) => {
                Err("Sync peer Iroh artifact batch abort did not match the request.".to_string())
            }
            Some(ProtocolMessage::Error(error)) => Err(phase_context_error(
                "artifact request/transfer",
                error.message,
            )),
            Some(other) => Err(format!(
                "Sync peer sent unexpected Iroh artifact batch completion: {}",
                other.kind()
            )),
        }
    }

    fn send_iroh_artifact_batch_credit(
        connection: &SharedPeerConnection,
        batch_token: &str,
        artifact_ids: Vec<String>,
    ) -> Result<(), String> {
        if artifact_ids.is_empty() {
            return Ok(());
        }
        connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::ArtifactBatchCredit {
                batch_token: batch_token.to_string(),
                artifact_ids,
            },
        )
    }

    fn send_iroh_artifact_batch_abort(
        connection: &SharedPeerConnection,
        batch_token: &str,
        message: &str,
    ) {
        let _ = connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::ArtifactBatchAbort {
                batch_token: batch_token.to_string(),
                message: message.to_string(),
            },
        );
    }

    fn send_available_iroh_batch_credit(
        connection: &SharedPeerConnection,
        batch_token: &str,
        credit_window: &mut IrohBatchCreditWindow,
        credited_artifact_ids: &Arc<Mutex<HashSet<String>>>,
        pending_stage_bytes: u64,
        metrics: &mut SyncRunMetrics,
    ) -> Result<bool, String> {
        let artifact_ids = credit_window.grant_available(pending_stage_bytes)?;
        if artifact_ids.is_empty() {
            return Ok(false);
        }
        let grant_count = artifact_ids.len();
        let granted_artifact_ids = artifact_ids.clone();
        {
            let mut credited = credited_artifact_ids.lock().map_err(|_| {
                for artifact_id in &granted_artifact_ids {
                    let _ = credit_window.release(artifact_id);
                }
                "Iroh artifact batch credit state is unavailable.".to_string()
            })?;
            credited.extend(artifact_ids.iter().cloned());
        }
        match send_iroh_artifact_batch_credit(connection, batch_token, artifact_ids) {
            Ok(()) => {
                metrics.record_credit_grants(grant_count);
                metrics.record_scratch_peak_bytes(credit_window.scratch_bytes(pending_stage_bytes));
                Ok(true)
            }
            Err(error) => {
                if let Ok(mut credited) = credited_artifact_ids.lock() {
                    for artifact_id in &granted_artifact_ids {
                        credited.remove(artifact_id.as_str());
                    }
                }
                for artifact_id in &granted_artifact_ids {
                    let _ = credit_window.release(artifact_id);
                }
                Err(error)
            }
        }
    }

    fn release_iroh_batch_credit(
        credit_window: &mut IrohBatchCreditWindow,
        credited_artifact_ids: &Arc<Mutex<HashSet<String>>>,
        artifact_id: &str,
        metrics: &mut SyncRunMetrics,
    ) {
        if let Some(held) = credit_window.release(artifact_id) {
            metrics.diagnostics.record_credit_hold(held);
        }
        if let Ok(mut credited) = credited_artifact_ids.lock() {
            credited.remove(artifact_id);
        }
    }

    fn clear_iroh_batch_credits(
        credit_window: &mut IrohBatchCreditWindow,
        credited_artifact_ids: &Arc<Mutex<HashSet<String>>>,
        metrics: &mut SyncRunMetrics,
    ) {
        for held in credit_window.clear() {
            metrics.diagnostics.record_credit_hold(held);
        }
        if let Ok(mut credited) = credited_artifact_ids.lock() {
            credited.clear();
        }
    }

    fn iroh_stage_result_artifact_id(stage_result: &IrohStageResult) -> &str {
        match &stage_result.transfer {
            Ok(result) => &result.artifact_id,
            Err(error) => &error.result.artifact_id,
        }
    }

    fn iroh_stage_result_size_bytes(stage_result: &IrohStageResult) -> u64 {
        match &stage_result.transfer {
            Ok(result) => result.size_bytes,
            Err(error) => error.result.size_bytes,
        }
    }

    fn fatal_iroh_receive_error_message(
        error: &IrohArtifactReceiveError,
        expected: &HashMap<String, IrohPendingReceive>,
    ) -> Option<String> {
        match error.artifact_id.as_deref() {
            Some(artifact_id) if expected.contains_key(artifact_id) => None,
            _ => Some(error.message.clone()),
        }
    }

    fn fail_unfinished_iroh_pending_transfers(
        pending: &[PendingArtifactTransfer],
        completed_artifact_ids: &mut HashSet<String>,
        message: &str,
        allow_project_apply: bool,
        apply_worker: &mut RemoteApplyWorker,
        record_transfer: &mut impl FnMut(
            Result<SyncTransportTransferResult, TransferFailure>,
            bool,
            &mut RemoteApplyWorker,
        ),
    ) {
        for pending in pending {
            if completed_artifact_ids.insert(pending.artifact.artifact_id.clone()) {
                record_transfer(
                    Err(transfer_failure(
                        &pending.artifact,
                        TransferTimer::zero_now(),
                        message.to_string(),
                    )),
                    allow_project_apply,
                    apply_worker,
                );
            }
        }
    }

    fn repeated_pending_iroh_artifact_message(
        pending: &[PendingArtifactTransfer],
    ) -> Option<String> {
        let mut seen = HashSet::new();
        for pending_transfer in pending {
            if !seen.insert(pending_transfer.artifact.artifact_id.as_str()) {
                return Some(format!(
                    "Sync artifact batch repeated artifact {}.",
                    pending_transfer.artifact.artifact_id
                ));
            }
        }
        None
    }

    fn record_iroh_stage_result(
        stage_result: IrohStageResult,
        completed_artifact_ids: &mut HashSet<String>,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        allow_project_apply: bool,
        apply_worker: &mut RemoteApplyWorker,
        record_transfer: &mut impl FnMut(
            Result<SyncTransportTransferResult, TransferFailure>,
            bool,
            &mut RemoteApplyWorker,
        ),
    ) {
        let artifact_id = iroh_stage_result_artifact_id(&stage_result).to_string();
        metrics.record_diagnostics(&stage_result.diagnostics);
        timings.extend(stage_result.timings);
        if completed_artifact_ids.insert(artifact_id) {
            record_transfer(stage_result.transfer, allow_project_apply, apply_worker);
        }
    }

    fn drain_iroh_stage_results(
        stage_results: Vec<IrohStageResult>,
        completed_artifact_ids: &mut HashSet<String>,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        allow_project_apply: bool,
        apply_worker: &mut RemoteApplyWorker,
        record_transfer: &mut impl FnMut(
            Result<SyncTransportTransferResult, TransferFailure>,
            bool,
            &mut RemoteApplyWorker,
        ),
    ) {
        for stage_result in stage_results {
            record_iroh_stage_result(
                stage_result,
                completed_artifact_ids,
                metrics,
                timings,
                allow_project_apply,
                apply_worker,
                record_transfer,
            );
        }
    }

    fn handle_iroh_receive_result(
        result: Result<IrohReceivedArtifact, IrohArtifactReceiveError>,
        expected: &HashMap<String, IrohPendingReceive>,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        credit_window: &mut IrohBatchCreditWindow,
        credited_artifact_ids: &Arc<Mutex<HashSet<String>>>,
        completed_artifact_ids: &mut HashSet<String>,
        fatal_error: &mut Option<String>,
        apply_worker: &mut RemoteApplyWorker,
        record_transfer: &mut impl FnMut(
            Result<SyncTransportTransferResult, TransferFailure>,
            bool,
            &mut RemoteApplyWorker,
        ),
    ) {
        match result {
            Ok(received) => {
                metrics.record_diagnostics(&received.diagnostics);
                let artifact = received.artifact.clone();
                timings.push(received.phase_timing.clone());
                metrics.record_received_artifact_bytes_at(
                    received.size_bytes,
                    received.first_bytes_at,
                );
                if let Err(received) = apply_worker.enqueue_received_iroh_artifact(received) {
                    let _ = fs::remove_file(&received.temp_path);
                    release_iroh_batch_credit(
                        credit_window,
                        credited_artifact_ids,
                        &artifact.artifact_id,
                        metrics,
                    );
                    fatal_error.get_or_insert(
                        "Iroh artifact staging worker stopped before staging all received files."
                            .to_string(),
                    );
                    apply_worker.cancel_pending_apply();
                    if completed_artifact_ids.insert(artifact.artifact_id.clone()) {
                        record_transfer(
                            Err(post_receive_transfer_failure(
                                &artifact,
                                received.timing,
                                "Iroh artifact staging worker stopped before staging the received file."
                                    .to_string(),
                            )),
                            false,
                            apply_worker,
                        );
                    }
                } else {
                    release_iroh_batch_credit(
                        credit_window,
                        credited_artifact_ids,
                        &artifact.artifact_id,
                        metrics,
                    );
                    metrics.record_staging_peak_bytes(apply_worker.staging_peak_bytes());
                    metrics.record_scratch_peak_bytes(
                        credit_window.scratch_bytes(apply_worker.pending_stage_bytes()),
                    );
                }
            }
            Err(error) => {
                metrics.record_diagnostics(&error.diagnostics);
                if error.message == IROH_ARTIFACT_RECEIVE_CANCELLED {
                    return;
                }
                if let Some(phase_timing) = error.phase_timing {
                    timings.push(phase_timing);
                }
                if let Some(artifact_id) = error.artifact_id {
                    if let Some(expected) = expected.get(&artifact_id) {
                        release_iroh_batch_credit(
                            credit_window,
                            credited_artifact_ids,
                            &artifact_id,
                            metrics,
                        );
                        let failure = transfer_failure(
                            &expected.artifact,
                            error.timing.unwrap_or_else(TransferTimer::zero_now),
                            error.message,
                        );
                        if completed_artifact_ids.insert(artifact_id) {
                            record_transfer(Err(failure), false, apply_worker);
                        }
                    } else {
                        fatal_error.get_or_insert(error.message);
                    }
                } else {
                    fatal_error.get_or_insert(error.message);
                }
            }
        }
    }

    fn request_and_stage_iroh_artifact_batch_with_stage_queue(
        client: &(impl ArtifactStagingClient + Sync),
        connection: &SharedPeerConnection,
        iroh_data: IrohDataConnection,
        _peer_device_id: &str,
        pending: Vec<PendingArtifactTransfer>,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
        apply_worker: &mut RemoteApplyWorker,
        mut record_transfer: impl FnMut(
            Result<SyncTransportTransferResult, TransferFailure>,
            bool,
            &mut RemoteApplyWorker,
        ),
    ) -> bool {
        if pending.is_empty() {
            return true;
        }
        if let Some(message) = progress.interruption_message() {
            for pending in pending {
                record_transfer(
                    Err(transfer_failure(
                        &pending.artifact,
                        TransferTimer::zero_now(),
                        message.clone(),
                    )),
                    false,
                    apply_worker,
                );
            }
            apply_worker.cancel_pending_apply();
            return false;
        }

        if let Some(message) = repeated_pending_iroh_artifact_message(&pending) {
            for pending in pending {
                record_transfer(
                    Err(transfer_failure(
                        &pending.artifact,
                        TransferTimer::zero_now(),
                        message.clone(),
                    )),
                    false,
                    apply_worker,
                );
            }
            return false;
        }

        let temp_root = match client.temp_artifact_root() {
            Ok(root) => root,
            Err(error) => {
                for pending in pending {
                    record_transfer(
                        Err(transfer_failure(
                            &pending.artifact,
                            TransferTimer::zero_now(),
                            format!("Could not allocate sync artifact temp path: {error}"),
                        )),
                        false,
                        apply_worker,
                    );
                }
                return false;
            }
        };

        let mut expected = HashMap::new();
        for pending_transfer in &pending {
            let temp_path =
                temp_artifact_path_in(temp_root.clone(), &pending_transfer.artifact.content_sha256);
            expected.insert(
                pending_transfer.artifact.artifact_id.clone(),
                IrohPendingReceive {
                    artifact: pending_transfer.artifact.clone(),
                    temp_path,
                },
            );
        }
        let batch_token = random_nonce();
        let request = ArtifactBatchRequest {
            batch_token: Some(batch_token.clone()),
            artifacts: pending
                .iter()
                .map(|pending| pending.artifact.artifact_request())
                .collect(),
        };
        let _progress = progress.start_phase("artifact_transfer", "Transferring artifact content.");
        if let Err(error) = connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::ArtifactBatchRequest(request),
        ) {
            for pending in pending {
                record_transfer(
                    Err(transfer_failure(
                        &pending.artifact,
                        TransferTimer::zero_now(),
                        error.clone(),
                    )),
                    false,
                    apply_worker,
                );
            }
            return false;
        }

        match connection
            .read_message_accepting_status_for_phase("artifact request/transfer", progress)
        {
            Ok(ProtocolMessage::ArtifactBatchStart {
                batch_token: peer_batch_token,
                artifact_count,
            }) if peer_batch_token == batch_token && artifact_count == pending.len() as u64 => {}
            Ok(ProtocolMessage::ArtifactBatchStart { .. }) => {
                let message =
                    "Sync peer Iroh artifact batch response did not match the request.".to_string();
                for pending in pending {
                    record_transfer(
                        Err(transfer_failure(
                            &pending.artifact,
                            TransferTimer::zero_now(),
                            message.clone(),
                        )),
                        false,
                        apply_worker,
                    );
                }
                return false;
            }
            Ok(ProtocolMessage::Error(error)) => {
                let message = phase_context_error("artifact request/transfer", error.message);
                for pending in pending {
                    record_transfer(
                        Err(transfer_failure(
                            &pending.artifact,
                            TransferTimer::zero_now(),
                            message.clone(),
                        )),
                        false,
                        apply_worker,
                    );
                }
                return false;
            }
            Ok(other) => {
                let message = format!(
                    "Sync peer sent unexpected Iroh artifact batch response: {}",
                    other.kind()
                );
                for pending in pending {
                    record_transfer(
                        Err(transfer_failure(
                            &pending.artifact,
                            TransferTimer::zero_now(),
                            message.clone(),
                        )),
                        false,
                        apply_worker,
                    );
                }
                return false;
            }
            Err(error) => {
                for pending in pending {
                    record_transfer(
                        Err(transfer_failure(
                            &pending.artifact,
                            TransferTimer::zero_now(),
                            error.clone(),
                        )),
                        false,
                        apply_worker,
                    );
                }
                return false;
            }
        }

        let expected = Arc::new(expected);
        receive_and_stage_iroh_artifact_batch_pipeline(
            connection,
            iroh_data,
            batch_token,
            Arc::clone(&expected),
            &pending,
            metrics,
            timings,
            progress,
            apply_worker,
            &mut record_transfer,
        )
    }

    fn receive_and_stage_iroh_artifact_batch_pipeline(
        connection: &SharedPeerConnection,
        iroh_data: IrohDataConnection,
        batch_token: String,
        expected: Arc<HashMap<String, IrohPendingReceive>>,
        pending: &[PendingArtifactTransfer],
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
        apply_worker: &mut RemoteApplyWorker,
        record_transfer: &mut impl FnMut(
            Result<SyncTransportTransferResult, TransferFailure>,
            bool,
            &mut RemoteApplyWorker,
        ),
    ) -> bool {
        let seen = Arc::new(Mutex::new(HashSet::new()));
        let credited_artifact_ids = Arc::new(Mutex::new(HashSet::new()));
        let cancel_receivers = Arc::new(AtomicBool::new(false));
        let (sender, receiver) =
            mpsc::channel::<Result<IrohReceivedArtifact, IrohArtifactReceiveError>>();
        let mut control_done = false;
        let mut handles = Vec::new();
        let mut fatal_error: Option<String> = None;
        let mut completed_artifact_ids = HashSet::new();
        let mut accepted_streams = 0_usize;
        let mut active_workers = 0_usize;
        let mut accept_started: Option<Instant> = None;
        let total_expected = expected.len();
        let mut credit_window = IrohBatchCreditWindow::new(
            pending,
            IROH_ARTIFACT_PARALLELISM,
            IROH_ARTIFACT_RECEIVE_BYTE_BUDGET,
        );
        let mut progress_watchdog =
            IrohBatchProgressWatchdog::new(Instant::now(), PROTOCOL_WATCHDOG_TIMEOUT);
        let data_progress_marker = progress_watchdog.marker();

        match send_available_iroh_batch_credit(
            connection,
            &batch_token,
            &mut credit_window,
            &credited_artifact_ids,
            apply_worker.pending_stage_bytes(),
            metrics,
        ) {
            Ok(true) => progress_watchdog.record(),
            Ok(false) => {}
            Err(error) => {
                fatal_error.get_or_insert(error);
            }
        }

        while fatal_error.is_none()
            && (!control_done
                || completed_artifact_ids.len() < total_expected
                || active_workers > 0
                || apply_worker.pending_stage_jobs > 0)
        {
            if let Some(message) = progress.interruption_message() {
                fatal_error.get_or_insert(message);
                apply_worker.cancel_pending_apply();
                cancel_receivers.store(true, Ordering::SeqCst);
                break;
            }
            if !control_done {
                match poll_iroh_artifact_batch_control(connection, &batch_token, progress) {
                    Ok(IrohBatchControlStatus::Pending) => {
                        if progress_watchdog.timed_out() {
                            fatal_error.get_or_insert(
                                "Timed out waiting for Iroh artifact batch control completion."
                                    .to_string(),
                            );
                            apply_worker.cancel_pending_apply();
                            break;
                        }
                    }
                    Ok(IrohBatchControlStatus::Progress) => {
                        progress_watchdog.record();
                    }
                    Ok(IrohBatchControlStatus::Done) => {
                        control_done = true;
                        progress_watchdog.record();
                    }
                    Err(error) => {
                        fatal_error.get_or_insert(error);
                        apply_worker.cancel_pending_apply();
                        break;
                    }
                }
            }
            if fatal_error.is_some() {
                apply_worker.cancel_pending_apply();
                break;
            }

            let stage_results = apply_worker.drain_backend_write_events(timings);
            if !stage_results.is_empty() {
                progress_watchdog.record();
                drain_iroh_stage_results(
                    stage_results,
                    &mut completed_artifact_ids,
                    metrics,
                    timings,
                    false,
                    apply_worker,
                    record_transfer,
                );
                match send_available_iroh_batch_credit(
                    connection,
                    &batch_token,
                    &mut credit_window,
                    &credited_artifact_ids,
                    apply_worker.pending_stage_bytes(),
                    metrics,
                ) {
                    Ok(true) => progress_watchdog.record(),
                    Ok(false) => {}
                    Err(error) => {
                        fatal_error.get_or_insert(error);
                        apply_worker.cancel_pending_apply();
                        break;
                    }
                }
            }

            while active_workers > 0 {
                match receiver.try_recv() {
                    Ok(result) => {
                        progress_watchdog.record();
                        active_workers = active_workers.saturating_sub(1);
                        if let Err(error) = &result {
                            if let Some(message) =
                                fatal_iroh_receive_error_message(error, expected.as_ref())
                            {
                                fatal_error.get_or_insert(message);
                            }
                        }
                        handle_iroh_receive_result(
                            result,
                            expected.as_ref(),
                            metrics,
                            timings,
                            &mut credit_window,
                            &credited_artifact_ids,
                            &mut completed_artifact_ids,
                            &mut fatal_error,
                            apply_worker,
                            record_transfer,
                        );
                        if fatal_error.is_none() {
                            match send_available_iroh_batch_credit(
                                connection,
                                &batch_token,
                                &mut credit_window,
                                &credited_artifact_ids,
                                apply_worker.pending_stage_bytes(),
                                metrics,
                            ) {
                                Ok(true) => progress_watchdog.record(),
                                Ok(false) => {}
                                Err(error) => {
                                    fatal_error.get_or_insert(error);
                                    apply_worker.cancel_pending_apply();
                                    cancel_receivers.store(true, Ordering::SeqCst);
                                    break;
                                }
                            }
                        }
                        if fatal_error.is_some() {
                            apply_worker.cancel_pending_apply();
                            cancel_receivers.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        fatal_error.get_or_insert(
                            "Iroh artifact receive worker stopped before reporting completion."
                                .to_string(),
                        );
                        apply_worker.cancel_pending_apply();
                        break;
                    }
                }
            }
            if fatal_error.is_some() {
                apply_worker.cancel_pending_apply();
                break;
            }

            if accepted_streams < credit_window.grants_issued() {
                let started = accept_started.get_or_insert_with(Instant::now);
                let accept_watchdog = if control_done {
                    IROH_MISSING_STREAM_AFTER_CONTROL_TIMEOUT
                } else {
                    PROTOCOL_WATCHDOG_TIMEOUT
                };
                let Some(remaining) = accept_watchdog.checked_sub(started.elapsed()) else {
                    let message = if control_done {
                        "Sync peer ended the Iroh artifact batch before sending all requested data streams."
                    } else {
                        "Timed out accepting Iroh artifact data stream."
                    };
                    fatal_error.get_or_insert(message.to_string());
                    apply_worker.cancel_pending_apply();
                    break;
                };
                if remaining.is_zero() {
                    let message = if control_done {
                        "Sync peer ended the Iroh artifact batch before sending all requested data streams."
                    } else {
                        "Timed out accepting Iroh artifact data stream."
                    };
                    fatal_error.get_or_insert(message.to_string());
                    apply_worker.cancel_pending_apply();
                    break;
                }
                let accept_timeout = remaining.min(IROH_BATCH_CONTROL_POLL_INTERVAL);
                match iroh_data.accept_recv_stream_with_timeout(accept_timeout) {
                    Ok(Some(recv)) => {
                        progress_watchdog.record();
                        accept_started = None;
                        accepted_streams = accepted_streams.saturating_add(1);
                        active_workers = active_workers.saturating_add(1);
                        metrics.record_max_active_streams(active_workers);
                        let sender = sender.clone();
                        let data = iroh_data.clone();
                        let expected = Arc::clone(&expected);
                        let seen = Arc::clone(&seen);
                        let credited_artifact_ids = Arc::clone(&credited_artifact_ids);
                        let cancel_receivers = Arc::clone(&cancel_receivers);
                        let data_progress_marker = data_progress_marker.clone();
                        let batch_token = batch_token.clone();
                        let run_started_instant = metrics.started_instant;
                        handles.push(thread::spawn(move || {
                            let result = receive_iroh_artifact_stream(
                                data,
                                recv,
                                &batch_token,
                                expected,
                                seen,
                                credited_artifact_ids,
                                cancel_receivers,
                                data_progress_marker,
                                run_started_instant,
                            );
                            if let Err(send_error) = sender.send(result) {
                                if let Ok(artifact) = send_error.0 {
                                    let _ = fs::remove_file(&artifact.temp_path);
                                }
                            }
                        }));
                        continue;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        let message = if control_done {
                            "Sync peer ended the Iroh artifact batch before sending all requested data streams."
                                .to_string()
                        } else {
                            error
                        };
                        fatal_error.get_or_insert(message);
                        apply_worker.cancel_pending_apply();
                        cancel_receivers.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            } else {
                accept_started = None;
                match receiver.recv_timeout(IROH_BATCH_CONTROL_POLL_INTERVAL) {
                    Ok(result) => {
                        progress_watchdog.record();
                        active_workers = active_workers.saturating_sub(1);
                        if let Err(error) = &result {
                            if let Some(message) =
                                fatal_iroh_receive_error_message(error, expected.as_ref())
                            {
                                fatal_error.get_or_insert(message);
                            }
                        }
                        handle_iroh_receive_result(
                            result,
                            expected.as_ref(),
                            metrics,
                            timings,
                            &mut credit_window,
                            &credited_artifact_ids,
                            &mut completed_artifact_ids,
                            &mut fatal_error,
                            apply_worker,
                            record_transfer,
                        );
                        if fatal_error.is_none() {
                            match send_available_iroh_batch_credit(
                                connection,
                                &batch_token,
                                &mut credit_window,
                                &credited_artifact_ids,
                                apply_worker.pending_stage_bytes(),
                                metrics,
                            ) {
                                Ok(true) => progress_watchdog.record(),
                                Ok(false) => {}
                                Err(error) => {
                                    fatal_error.get_or_insert(error);
                                }
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        fatal_error.get_or_insert(
                            "Iroh artifact receive worker stopped before reporting completion."
                                .to_string(),
                        );
                        apply_worker.cancel_pending_apply();
                        break;
                    }
                }
            }
        }

        if fatal_error.is_some() {
            apply_worker.cancel_pending_apply();
            if let Some(message) = fatal_error.as_deref() {
                send_iroh_artifact_batch_abort(connection, &batch_token, message);
            }
            iroh_data.close_for_artifact_batch_abort();
            metrics.record_credit_revokes(credit_window.active_credit_count());
            clear_iroh_batch_credits(&mut credit_window, &credited_artifact_ids, metrics);
        }
        cancel_receivers.store(true, Ordering::SeqCst);
        drop(sender);
        while let Ok(result) = receiver.try_recv() {
            handle_iroh_receive_result(
                result,
                expected.as_ref(),
                metrics,
                timings,
                &mut credit_window,
                &credited_artifact_ids,
                &mut completed_artifact_ids,
                &mut fatal_error,
                apply_worker,
                record_transfer,
            );
        }
        for handle in handles {
            if handle.join().is_err() {
                fatal_error.get_or_insert("Iroh artifact receive worker panicked.".to_string());
            }
        }
        while let Ok(result) = receiver.try_recv() {
            handle_iroh_receive_result(
                result,
                expected.as_ref(),
                metrics,
                timings,
                &mut credit_window,
                &credited_artifact_ids,
                &mut completed_artifact_ids,
                &mut fatal_error,
                apply_worker,
                record_transfer,
            );
        }
        match apply_worker.finish_iroh_stage_jobs(timings) {
            Ok(stage_results) => drain_iroh_stage_results(
                stage_results,
                &mut completed_artifact_ids,
                metrics,
                timings,
                false,
                apply_worker,
                record_transfer,
            ),
            Err(error) => {
                fatal_error.get_or_insert(error);
                apply_worker.cancel_pending_apply();
            }
        }

        drain_iroh_stage_results(
            apply_worker.drain_backend_write_events(timings),
            &mut completed_artifact_ids,
            metrics,
            timings,
            false,
            apply_worker,
            record_transfer,
        );
        if fatal_error.is_some() {
            apply_worker.cancel_pending_apply();
        }

        drain_iroh_stage_results(
            apply_worker.drain_backend_write_events(timings),
            &mut completed_artifact_ids,
            metrics,
            timings,
            false,
            apply_worker,
            record_transfer,
        );

        let missing_message = fatal_error
            .as_ref()
            .map(|message| {
                format!("Sync artifact batch transfer stopped after a peer error: {message}")
            })
            .unwrap_or_else(|| {
                "Sync peer did not send the requested Iroh artifact stream.".to_string()
            });
        fail_unfinished_iroh_pending_transfers(
            pending,
            &mut completed_artifact_ids,
            &missing_message,
            false,
            apply_worker,
            record_transfer,
        );
        fatal_error.is_none()
    }

    fn request_and_stage_global_iroh_artifact_batch_on_write_lane(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        iroh_data: IrohDataConnection,
        peer_device_id: &str,
        pending: Vec<PendingArtifactTransfer>,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
        apply_worker: &mut RemoteApplyWorker,
        mut record_transfer: impl FnMut(
            Result<SyncTransportTransferResult, TransferFailure>,
            bool,
            &mut RemoteApplyWorker,
        ),
    ) -> bool {
        request_and_stage_iroh_artifact_batch_with_stage_queue(
            client,
            connection,
            iroh_data,
            peer_device_id,
            pending,
            metrics,
            timings,
            progress,
            apply_worker,
            &mut record_transfer,
        )
    }

    fn receive_iroh_artifact_stream(
        iroh_data: IrohDataConnection,
        mut recv: RecvStream,
        batch_token: &str,
        expected: Arc<HashMap<String, IrohPendingReceive>>,
        seen: Arc<Mutex<HashSet<String>>>,
        credited_artifact_ids: Arc<Mutex<HashSet<String>>>,
        cancel_receivers: Arc<AtomicBool>,
        data_progress_marker: IrohBatchProgressMarker,
        run_started_instant: Instant,
    ) -> Result<IrohReceivedArtifact, IrohArtifactReceiveError> {
        let transfer_timer = TransferTimer::start();
        let mut diagnostics = SyncTransportDiagnostics::default();
        let header = read_iroh_artifact_stream_header(
            &iroh_data,
            &mut recv,
            &cancel_receivers,
            &mut diagnostics,
        )
        .map_err(|message| IrohArtifactReceiveError {
            artifact_id: None,
            message,
            timing: None,
            phase_timing: None,
            diagnostics: diagnostics.clone(),
        })?;
        let artifact_id = header.artifact_id.clone();
        let Some(pending) = expected.get(&header.artifact_id).cloned() else {
            return Err(IrohArtifactReceiveError {
                artifact_id: Some(artifact_id),
                message: "Iroh artifact stream referenced an artifact outside the current batch."
                    .to_string(),
                timing: None,
                phase_timing: None,
                diagnostics: diagnostics.clone(),
            });
        };
        if header.batch_token != batch_token {
            return Err(known_iroh_receive_failure(
                &pending.artifact,
                transfer_timer,
                0,
                "Iroh artifact stream used an unknown batch token.".to_string(),
                diagnostics.clone(),
            ));
        }
        if header.unavailable {
            if header.content_sha256 != IROH_ARTIFACT_UNAVAILABLE_CONTENT_SHA256
                || header.size_bytes != pending.artifact.size_bytes
            {
                return Err(known_iroh_receive_failure(
                    &pending.artifact,
                    transfer_timer,
                    0,
                    "Iroh artifact stream header did not match the requested artifact.".to_string(),
                    diagnostics.clone(),
                ));
            }
        } else if header.content_sha256 != pending.artifact.content_sha256
            || header.size_bytes != pending.artifact.size_bytes
        {
            return Err(known_iroh_receive_failure(
                &pending.artifact,
                transfer_timer,
                0,
                "Iroh artifact stream header did not match the requested artifact.".to_string(),
                diagnostics.clone(),
            ));
        }
        {
            let credited = credited_artifact_ids
                .lock()
                .map_err(|_| IrohArtifactReceiveError {
                    artifact_id: Some(pending.artifact.artifact_id.clone()),
                    message: "Iroh artifact batch credit state is unavailable.".to_string(),
                    timing: None,
                    phase_timing: None,
                    diagnostics: diagnostics.clone(),
                })?;
            if !credited.contains(&pending.artifact.artifact_id) {
                return Err(known_iroh_receive_failure(
                    &pending.artifact,
                    transfer_timer,
                    0,
                    "Iroh artifact stream was opened before receiver credit.".to_string(),
                    diagnostics.clone(),
                ));
            }
        }
        {
            let mut seen = seen.lock().map_err(|_| IrohArtifactReceiveError {
                artifact_id: Some(pending.artifact.artifact_id.clone()),
                message: "Iroh artifact stream receive state is unavailable.".to_string(),
                timing: None,
                phase_timing: None,
                diagnostics: diagnostics.clone(),
            })?;
            if !seen.insert(pending.artifact.artifact_id.clone()) {
                return Err(known_iroh_receive_failure(
                    &pending.artifact,
                    transfer_timer,
                    0,
                    "Iroh artifact stream repeated an artifact in the current batch.".to_string(),
                    diagnostics.clone(),
                ));
            }
        }
        if header.unavailable {
            return Err(known_iroh_receive_failure(
                &pending.artifact,
                transfer_timer,
                0,
                UNAVAILABLE_ARTIFACT_TRANSFER_MESSAGE.to_string(),
                diagnostics.clone(),
            ));
        }

        if let Some(parent) = pending.temp_path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                return Err(known_iroh_receive_failure(
                    &pending.artifact,
                    transfer_timer,
                    0,
                    format!("Could not create sync artifact temp dir: {error}"),
                    diagnostics.clone(),
                ));
            }
        }
        let mut file = match File::create(&pending.temp_path) {
            Ok(file) => file,
            Err(error) => {
                return Err(known_iroh_receive_failure(
                    &pending.artifact,
                    transfer_timer,
                    0,
                    format!("Could not create sync artifact temp file: {error}"),
                    diagnostics.clone(),
                ));
            }
        };
        let mut hasher = Sha256::new();
        let mut size_bytes = 0_u64;
        let mut buffer = [0_u8; ARTIFACT_CHUNK_SIZE];
        let mut first_bytes_at = None;
        while size_bytes < pending.artifact.size_bytes {
            let remaining = pending.artifact.size_bytes.saturating_sub(size_bytes);
            let read_len = remaining.min(buffer.len() as u64) as usize;
            let read_started = Instant::now();
            let read = match read_iroh_artifact_stream_chunk(
                &iroh_data,
                &mut recv,
                &mut buffer[..read_len],
                &cancel_receivers,
            ) {
                Ok(Some(read)) => {
                    diagnostics.record_receiver_read(read_started.elapsed());
                    read
                }
                Ok(None) => {
                    diagnostics.record_receiver_read(read_started.elapsed());
                    let _ = fs::remove_file(&pending.temp_path);
                    let message = if size_bytes == 0 {
                        UNAVAILABLE_ARTIFACT_TRANSFER_MESSAGE.to_string()
                    } else {
                        "Iroh artifact stream ended before the requested size.".to_string()
                    };
                    return Err(known_iroh_receive_failure(
                        &pending.artifact,
                        transfer_timer,
                        size_bytes,
                        message,
                        diagnostics.clone(),
                    ));
                }
                Err(error) => {
                    diagnostics.record_receiver_read(read_started.elapsed());
                    let _ = fs::remove_file(&pending.temp_path);
                    return Err(known_iroh_receive_failure(
                        &pending.artifact,
                        transfer_timer,
                        size_bytes,
                        error,
                        diagnostics.clone(),
                    ));
                }
            };
            if read == 0 {
                let _ = fs::remove_file(&pending.temp_path);
                return Err(known_iroh_receive_failure(
                    &pending.artifact,
                    transfer_timer,
                    size_bytes,
                    "Iroh artifact stream returned an empty read before completion.".to_string(),
                    diagnostics.clone(),
                ));
            }
            if first_bytes_at.is_none() {
                first_bytes_at = Some(run_started_instant.elapsed());
            }
            data_progress_marker.record();
            size_bytes = size_bytes.saturating_add(read as u64);
            let hash_started = Instant::now();
            hasher.update(&buffer[..read]);
            diagnostics.record_receiver_hash(hash_started.elapsed());
            let write_started = Instant::now();
            if let Err(error) = file.write_all(&buffer[..read]) {
                diagnostics.record_receiver_temp_write(write_started.elapsed());
                let _ = fs::remove_file(&pending.temp_path);
                return Err(known_iroh_receive_failure(
                    &pending.artifact,
                    transfer_timer,
                    size_bytes,
                    format!("Could not write received sync artifact bytes: {error}"),
                    diagnostics.clone(),
                ));
            }
            diagnostics.record_receiver_temp_write(write_started.elapsed());
        }
        if let Err(error) = file.flush() {
            let _ = fs::remove_file(&pending.temp_path);
            return Err(known_iroh_receive_failure(
                &pending.artifact,
                transfer_timer,
                size_bytes,
                format!("Could not flush received sync artifact bytes: {error}"),
                diagnostics.clone(),
            ));
        }
        let actual_sha256 = hex_digest(hasher.finalize().as_slice());
        if actual_sha256 != pending.artifact.content_sha256
            || size_bytes != pending.artifact.size_bytes
        {
            let _ = fs::remove_file(&pending.temp_path);
            return Err(known_iroh_receive_failure(
                &pending.artifact,
                transfer_timer,
                size_bytes,
                "Received sync artifact bytes failed SHA-256 or size verification.".to_string(),
                diagnostics.clone(),
            ));
        }
        let (timing, phase_timing) =
            transfer_timer.finish_with_phase(size_bytes, "artifact_transfer", &pending.artifact);
        Ok(IrohReceivedArtifact {
            artifact: pending.artifact,
            temp_path: pending.temp_path,
            timing,
            phase_timing,
            size_bytes,
            first_bytes_at,
            diagnostics,
        })
    }

    fn known_iroh_receive_failure(
        artifact: &RemoteArtifact,
        transfer_timer: TransferTimer,
        bytes: u64,
        message: String,
        diagnostics: SyncTransportDiagnostics,
    ) -> IrohArtifactReceiveError {
        let (timing, phase_timing) =
            transfer_timer.finish_with_phase(bytes, "artifact_transfer", artifact);
        IrohArtifactReceiveError {
            artifact_id: Some(artifact.artifact_id.clone()),
            message,
            timing: Some(timing),
            phase_timing: Some(phase_timing),
            diagnostics,
        }
    }

    fn write_iroh_artifact_stream_header(
        iroh_data: &IrohDataConnection,
        send: &mut SendStream,
        header: &IrohArtifactStreamHeader,
        diagnostics: &mut SyncTransportDiagnostics,
    ) -> Result<(), String> {
        let payload = serde_json::to_vec(header)
            .map_err(|error| format!("Could not encode Iroh artifact stream header: {error}"))?;
        if payload.len() > IROH_DATA_HEADER_MAX_BYTES {
            return Err("Iroh artifact stream header is too large.".to_string());
        }
        let length = (payload.len() as u32).to_be_bytes();
        let write_started = Instant::now();
        iroh_data.write_all(send, &length)?;
        diagnostics.record_sender_write(write_started.elapsed());
        let write_started = Instant::now();
        iroh_data.write_all(send, &payload)?;
        diagnostics.record_sender_write(write_started.elapsed());
        Ok(())
    }

    fn read_iroh_artifact_stream_header(
        iroh_data: &IrohDataConnection,
        recv: &mut RecvStream,
        cancel_receivers: &AtomicBool,
        diagnostics: &mut SyncTransportDiagnostics,
    ) -> Result<IrohArtifactStreamHeader, String> {
        let mut length = [0_u8; 4];
        let read_started = Instant::now();
        if let Err(error) =
            read_iroh_artifact_stream_exact(iroh_data, recv, &mut length, cancel_receivers)
        {
            diagnostics.record_receiver_read(read_started.elapsed());
            return Err(error);
        }
        diagnostics.record_receiver_read(read_started.elapsed());
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 || length > IROH_DATA_HEADER_MAX_BYTES {
            return Err("Iroh artifact stream header has an invalid length.".to_string());
        }
        let mut payload = vec![0_u8; length];
        let read_started = Instant::now();
        if let Err(error) =
            read_iroh_artifact_stream_exact(iroh_data, recv, &mut payload, cancel_receivers)
        {
            diagnostics.record_receiver_read(read_started.elapsed());
            return Err(error);
        }
        diagnostics.record_receiver_read(read_started.elapsed());
        serde_json::from_slice(&payload)
            .map_err(|error| format!("Could not decode Iroh artifact stream header: {error}"))
    }

    fn read_iroh_artifact_stream_exact(
        iroh_data: &IrohDataConnection,
        recv: &mut RecvStream,
        buffer: &mut [u8],
        cancel_receivers: &AtomicBool,
    ) -> Result<(), String> {
        let mut read_bytes = 0_usize;
        while read_bytes < buffer.len() {
            match read_iroh_artifact_stream_chunk(
                iroh_data,
                recv,
                &mut buffer[read_bytes..],
                cancel_receivers,
            )? {
                Some(0) => {
                    return Err(
                        "Iroh artifact stream returned an empty read before completion."
                            .to_string(),
                    );
                }
                Some(read) => read_bytes = read_bytes.saturating_add(read),
                None => {
                    return Err(
                        "Iroh artifact stream ended before the requested bytes.".to_string()
                    );
                }
            }
        }
        Ok(())
    }

    fn read_iroh_artifact_stream_chunk(
        iroh_data: &IrohDataConnection,
        recv: &mut RecvStream,
        buffer: &mut [u8],
        cancel_receivers: &AtomicBool,
    ) -> Result<Option<usize>, String> {
        let read_started = Instant::now();
        loop {
            if cancel_receivers.load(Ordering::SeqCst) {
                return Err(IROH_ARTIFACT_RECEIVE_CANCELLED.to_string());
            }
            let Some(remaining) = PROTOCOL_WATCHDOG_TIMEOUT.checked_sub(read_started.elapsed())
            else {
                return Err("Timed out reading Iroh artifact data stream.".to_string());
            };
            if remaining.is_zero() {
                return Err("Timed out reading Iroh artifact data stream.".to_string());
            }
            let timeout = remaining.min(IROH_BATCH_CONTROL_POLL_INTERVAL);
            match iroh_data.read_with_timeout(recv, buffer, timeout)? {
                IrohDataReadPoll::Data(read) => return Ok(Some(read)),
                IrohDataReadPoll::EndOfStream => return Ok(None),
                IrohDataReadPoll::TimedOut => {}
            }
        }
    }

    fn stage_received_iroh_artifact(
        client: &impl ArtifactStagingClient,
        transport_id: &str,
        peer_device_id: &str,
        received: IrohReceivedArtifact,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        diagnostics: &mut SyncTransportDiagnostics,
    ) -> Result<SyncTransportTransferResult, TransferFailure> {
        let artifact = received.artifact;
        let body = json!({
            "source_path": received.temp_path.to_string_lossy(),
            "content_sha256": &artifact.content_sha256,
            "size_bytes": artifact.size_bytes,
            "provider_device_id": peer_device_id,
            "metadata": {
                "source": transport_id,
                "artifact_id": &artifact.artifact_id,
                "project_id": &artifact.project_id,
            },
        });
        let timer = SyncPhaseTimer::start_artifact("artifact_staging", &artifact);
        let post_started = Instant::now();
        let stage_result = client.post_json_value("/api/v1/sync/artifacts/staging", &body);
        diagnostics.record_staging_post(post_started.elapsed());
        timings.push(timer.finish());
        let cleanup_timer = SyncPhaseTimer::start_artifact("artifact_cleanup", &artifact);
        let _ = fs::remove_file(&received.temp_path);
        timings.push(cleanup_timer.finish());
        if let Err(error) = stage_result {
            return Err(post_receive_transfer_failure(
                &artifact,
                received.timing,
                phase_context_error(
                    "reconciliation staging",
                    format!("Could not stage received sync artifact: {error}"),
                ),
            ));
        }

        Ok(transfer_result(
            &artifact,
            "received",
            None,
            received.timing,
        ))
    }

    fn receive_and_stage_artifact(
        client: &impl ArtifactStagingClient,
        connection: &SharedPeerConnection,
        peer_device_id: &str,
        pending: PendingArtifactTransfer,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> Result<SyncTransportTransferResult, TransferFailure> {
        let artifact = pending.artifact;
        let transfer_timer = TransferTimer::start();
        let timer = SyncPhaseTimer::start_artifact("artifact_transfer", &artifact);
        let _progress = progress.start_phase("artifact_transfer", "Transferring artifact content.");
        if let Some(message) = progress.interruption_message() {
            timings.push(timer.finish());
            return Err(transfer_failure(
                &artifact,
                transfer_timer.finish(0),
                message,
            ));
        }

        match connection
            .read_message_accepting_status_for_phase("artifact request/transfer", progress)
        {
            Ok(ProtocolMessage::ArtifactStart {
                artifact_id,
                content_sha256,
                size_bytes,
            }) => {
                if artifact_id != artifact.artifact_id
                    || content_sha256 != artifact.content_sha256
                    || size_bytes != artifact.size_bytes
                {
                    timings.push(timer.finish());
                    return Err(transfer_failure(
                        &artifact,
                        transfer_timer.finish(0),
                        "Sync peer artifact response did not match the request.".to_string(),
                    ));
                }
            }
            Ok(ProtocolMessage::Error(error)) => {
                timings.push(timer.finish());
                let message = phase_context_error("artifact request/transfer", error.message);
                if error.code == "artifact_unavailable" {
                    return Err(post_receive_transfer_failure(
                        &artifact,
                        transfer_timer.finish(0),
                        message,
                    ));
                }
                return Err(transfer_failure(
                    &artifact,
                    transfer_timer.finish(0),
                    message,
                ));
            }
            Ok(other) => {
                timings.push(timer.finish());
                return Err(transfer_failure(
                    &artifact,
                    transfer_timer.finish(0),
                    format!(
                        "Sync peer sent unexpected artifact response: {}",
                        other.kind()
                    ),
                ));
            }
            Err(error) => {
                timings.push(timer.finish());
                return Err(transfer_failure(&artifact, transfer_timer.finish(0), error));
            }
        }

        let temp_path = match client.temp_artifact_path(&artifact.content_sha256) {
            Ok(path) => path,
            Err(error) => {
                timings.push(timer.finish());
                return Err(transfer_failure(
                    &artifact,
                    transfer_timer.finish(0),
                    format!("Could not allocate sync artifact temp path: {error}"),
                ));
            }
        };
        if let Some(parent) = temp_path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                timings.push(timer.finish());
                return Err(transfer_failure(
                    &artifact,
                    transfer_timer.finish(0),
                    format!("Could not create sync artifact temp dir: {error}"),
                ));
            }
        }
        let mut file = match File::create(&temp_path) {
            Ok(file) => file,
            Err(error) => {
                timings.push(timer.finish());
                return Err(transfer_failure(
                    &artifact,
                    transfer_timer.finish(0),
                    format!("Could not create sync artifact temp file: {error}"),
                ));
            }
        };
        let mut hasher = Sha256::new();
        let mut size_bytes = 0_u64;
        let mut receive_can_continue = false;
        let receive_result = loop {
            if let Some(message) = progress.interruption_message() {
                break Err(message);
            }
            match connection.read_artifact_transfer_frame_accepting_status_for_phase(
                "artifact request/transfer",
                progress,
            ) {
                Ok(ArtifactTransferFrame::Chunk(chunk)) => {
                    let next_size_bytes = size_bytes.saturating_add(chunk.len() as u64);
                    if next_size_bytes > artifact.size_bytes {
                        break Err(
                            "Received sync artifact exceeded the requested size.".to_string()
                        );
                    }
                    size_bytes = next_size_bytes;
                    metrics.record_received_artifact_bytes(chunk.len() as u64);
                    hasher.update(&chunk);
                    if let Err(error) = file.write_all(&chunk) {
                        break Err(format!(
                            "Could not write received sync artifact bytes: {error}"
                        ));
                    }
                }
                Ok(ArtifactTransferFrame::Message(ProtocolMessage::ArtifactEnd {
                    content_sha256,
                    size_bytes: peer_size_bytes,
                })) => {
                    if let Err(error) = file.flush() {
                        break Err(format!(
                            "Could not flush received sync artifact bytes: {error}"
                        ));
                    }
                    let actual_sha256 = hex_digest(hasher.finalize().as_slice());
                    if content_sha256 != artifact.content_sha256
                        || actual_sha256 != artifact.content_sha256
                        || peer_size_bytes != artifact.size_bytes
                        || size_bytes != artifact.size_bytes
                    {
                        receive_can_continue = true;
                        break Err(
                            "Received sync artifact bytes failed SHA-256 or size verification."
                                .to_string(),
                        );
                    }
                    break Ok(());
                }
                Ok(ArtifactTransferFrame::Message(ProtocolMessage::Error(error))) => {
                    if error.code == "artifact_unavailable" {
                        receive_can_continue = true;
                    }
                    break Err(phase_context_error(
                        "artifact request/transfer",
                        error.message,
                    ));
                }
                Ok(ArtifactTransferFrame::Message(other)) => {
                    break Err(format!(
                        "Sync peer sent unexpected artifact transfer message: {}",
                        other.kind()
                    ));
                }
                Err(error) => break Err(error),
            }
        };
        let transfer_timing = transfer_timer.finish(size_bytes);
        timings.push(timer.finish());

        if let Err(error) = receive_result {
            let cleanup_timer = SyncPhaseTimer::start_artifact("artifact_cleanup", &artifact);
            let _ = fs::remove_file(&temp_path);
            timings.push(cleanup_timer.finish());
            if receive_can_continue {
                return Err(post_receive_transfer_failure(
                    &artifact,
                    transfer_timing,
                    error,
                ));
            }
            return Err(transfer_failure(&artifact, transfer_timing, error));
        }
        if let Some(message) = progress.interruption_message() {
            let cleanup_timer = SyncPhaseTimer::start_artifact("artifact_cleanup", &artifact);
            let _ = fs::remove_file(&temp_path);
            timings.push(cleanup_timer.finish());
            return Err(transfer_failure(&artifact, transfer_timing, message));
        }

        let body = json!({
            "source_path": temp_path.to_string_lossy(),
            "content_sha256": &artifact.content_sha256,
            "size_bytes": artifact.size_bytes,
            "provider_device_id": peer_device_id,
            "metadata": {
                "source": connection.transport_id(),
                "artifact_id": &artifact.artifact_id,
                "project_id": &artifact.project_id,
            },
        });
        let timer = SyncPhaseTimer::start_artifact("artifact_staging", &artifact);
        let post_started = Instant::now();
        let stage_result = client.post_json_value("/api/v1/sync/artifacts/staging", &body);
        metrics
            .diagnostics
            .record_staging_post(post_started.elapsed());
        timings.push(timer.finish());
        let cleanup_timer = SyncPhaseTimer::start_artifact("artifact_cleanup", &artifact);
        let _ = fs::remove_file(&temp_path);
        timings.push(cleanup_timer.finish());
        if let Err(error) = stage_result {
            return Err(post_receive_transfer_failure(
                &artifact,
                transfer_timing,
                phase_context_error(
                    "reconciliation staging",
                    format!("Could not stage received sync artifact: {error}"),
                ),
            ));
        }

        Ok(transfer_result(
            &artifact,
            "received",
            None,
            transfer_timing,
        ))
    }

    #[derive(Clone, Debug)]
    struct TransferFailure {
        message: String,
        result: SyncTransportTransferResult,
        can_continue_batch: bool,
    }

    fn transfer_result(
        artifact: &RemoteArtifact,
        status: &str,
        message: Option<String>,
        timing: TransferTiming,
    ) -> SyncTransportTransferResult {
        SyncTransportTransferResult {
            artifact_id: artifact.artifact_id.clone(),
            content_sha256: artifact.content_sha256.clone(),
            size_bytes: artifact.size_bytes,
            started_at: timing.started_at,
            completed_at: timing.completed_at,
            duration_ms: timing.duration_ms,
            throughput_bytes_per_second: timing.throughput_bytes_per_second,
            status: status.to_string(),
            message,
        }
    }

    fn transfer_failure(
        artifact: &RemoteArtifact,
        timing: TransferTiming,
        message: String,
    ) -> TransferFailure {
        TransferFailure {
            result: transfer_result(artifact, "failed", Some(message.clone()), timing),
            message,
            can_continue_batch: false,
        }
    }

    fn post_receive_transfer_failure(
        artifact: &RemoteArtifact,
        timing: TransferTiming,
        message: String,
    ) -> TransferFailure {
        TransferFailure {
            result: transfer_result(artifact, "failed", Some(message.clone()), timing),
            message,
            can_continue_batch: true,
        }
    }

    fn temp_artifact_path_in(root: PathBuf, content_sha256: &str) -> PathBuf {
        root.join(format!(
            "{}-{}-{content_sha256}",
            process::id(),
            random_nonce()
        ))
    }

    fn cleanup_stale_transport_temp_artifacts(root: &Path) -> Result<(), String> {
        fs::create_dir_all(root).map_err(|error| {
            format!("Could not create sync transport artifact temp directory: {error}")
        })?;
        let current_process_prefix = format!("{}-", process::id());
        let entries = fs::read_dir(root).map_err(|error| {
            format!("Could not inspect sync transport artifact temp directory: {error}")
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!("Could not inspect sync transport artifact temp entry: {error}")
            })?;
            let file_name = entry.file_name();
            if file_name
                .to_str()
                .is_some_and(|name| name.starts_with(&current_process_prefix))
            {
                continue;
            }
            let path = entry.path();
            let file_type = entry.file_type().map_err(|error| {
                format!("Could not inspect sync transport artifact temp entry: {error}")
            })?;
            let result = if file_type.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
            result.map_err(stale_transport_temp_cleanup_error)?;
        }
        Ok(())
    }

    fn stale_transport_temp_cleanup_error(error: io::Error) -> String {
        format!("Could not remove stale sync transport artifact temp entry: {error}")
    }

    fn sync_transport_temp_root_from_health(health: &Value) -> Result<PathBuf, String> {
        let data_root = health
            .get("data_root")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "Backend health response did not include data_root for sync transport.".to_string()
            })?;
        Ok(PathBuf::from(data_root).join("sync").join("transport-tmp"))
    }

    fn serve_artifact_requests_until_done(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        offered_manifests: &[Value],
        metrics: &mut SyncRunMetrics,
        progress: &ProgressReporter,
    ) -> Result<u64, String> {
        let offered_artifacts = offered_artifacts(offered_manifests);
        let mut served = 0_u64;
        progress
            .report_local_progress("serve_artifact_requests", "Serving peer artifact requests.");
        loop {
            progress.check_not_cancelled()?;
            match connection
                .read_message_accepting_status_for_phase("serve artifact requests", progress)?
            {
                ProtocolMessage::ArtifactRequest(request) => {
                    let result = requested_offered_artifact(&offered_artifacts, &request).and_then(
                        |artifact| {
                            send_artifact_response(client, connection, &artifact, metrics, progress)
                                .map(|_| 1_u64)
                        },
                    );
                    match result {
                        Ok(count) => served = served.saturating_add(count),
                        Err(error) => {
                            let peer_error =
                                phase_context_error("artifact request/transfer", error.clone());
                            let _ = connection.send_message_for_phase(
                                "serve artifact requests",
                                &ProtocolMessage::Error(ProtocolError {
                                    code: "artifact_transfer_failed".to_string(),
                                    message: peer_error,
                                }),
                            );
                            return Err(phase_context_error("serve artifact requests", error));
                        }
                    }
                }
                ProtocolMessage::ArtifactBatchRequest(request) => {
                    let result = requested_offered_artifact_batch(&offered_artifacts, &request)
                        .and_then(|artifacts| {
                            if connection.transport() == TransportKind::Iroh {
                                if let (Some(batch_token), Some(iroh_data)) = (
                                    request.batch_token.as_deref(),
                                    connection.iroh_data_connection(),
                                ) {
                                    send_iroh_artifact_batch_response(
                                        client,
                                        connection,
                                        iroh_data,
                                        batch_token,
                                        &artifacts,
                                        metrics,
                                        progress,
                                    )?;
                                    return Ok(artifacts.len() as u64);
                                }
                            }
                            send_artifact_batch_response(
                                client, connection, &artifacts, metrics, progress,
                            )
                        });
                    match result {
                        Ok(count) => served = served.saturating_add(count),
                        Err(error) => {
                            let peer_error =
                                phase_context_error("artifact request/transfer", error.clone());
                            let _ = connection.send_message_for_phase(
                                "serve artifact requests",
                                &ProtocolMessage::Error(ProtocolError {
                                    code: "artifact_transfer_failed".to_string(),
                                    message: peer_error,
                                }),
                            );
                            return Err(phase_context_error("serve artifact requests", error));
                        }
                    }
                }
                ProtocolMessage::PhaseDone { .. } => return Ok(served),
                ProtocolMessage::Error(error) => {
                    return Err(phase_context_error(
                        "serve artifact requests",
                        error.message,
                    ));
                }
                other => {
                    return Err(format!(
                        "Sync peer sent unexpected message while serving artifacts: {}",
                        other.kind()
                    ));
                }
            }
        }
    }

    fn send_iroh_artifact_batch_response(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        iroh_data: IrohDataConnection,
        batch_token: &str,
        artifacts: &[RemoteArtifact],
        metrics: &mut SyncRunMetrics,
        progress: &ProgressReporter,
    ) -> Result<(), String> {
        let resolved = client
            .resolve_artifact_files(artifacts)
            .map_err(|error| phase_context_error("artifact request/transfer", error.to_string()))?;
        let _progress = progress.start_phase("artifact_transfer", "Transferring artifact content.");
        progress.check_not_cancelled()?;
        connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::ArtifactBatchStart {
                batch_token: batch_token.to_string(),
                artifact_count: artifacts.len() as u64,
            },
        )?;

        let artifacts_by_id: HashMap<_, _> = artifacts
            .iter()
            .map(|artifact| (artifact.artifact_id.clone(), artifact.clone()))
            .collect();
        let mut served_artifact_ids = HashSet::new();
        while served_artifact_ids.len() < artifacts.len() {
            progress.check_not_cancelled()?;
            let credit_wait_started = Instant::now();
            let credit_message = connection
                .read_message_accepting_status_for_phase("artifact request/transfer", progress)?;
            metrics
                .diagnostics
                .record_credit_wait(credit_wait_started.elapsed());
            let artifact_ids = match credit_message {
                ProtocolMessage::ArtifactBatchCredit {
                    batch_token: peer_batch_token,
                    artifact_ids,
                } if peer_batch_token == batch_token => artifact_ids,
                ProtocolMessage::ArtifactBatchCredit { .. } => {
                    let message =
                        "Sync peer Iroh artifact batch credit did not match the response."
                            .to_string();
                    send_iroh_artifact_batch_abort(connection, batch_token, &message);
                    return Err(message);
                }
                ProtocolMessage::ArtifactBatchAbort {
                    batch_token: peer_batch_token,
                    message,
                } if peer_batch_token == batch_token => {
                    return Err(phase_context_error("artifact request/transfer", message));
                }
                ProtocolMessage::ArtifactBatchAbort { .. } => {
                    return Err(
                        "Sync peer Iroh artifact batch abort did not match the response."
                            .to_string(),
                    );
                }
                ProtocolMessage::Error(error) => {
                    return Err(phase_context_error(
                        "artifact request/transfer",
                        error.message,
                    ));
                }
                other => {
                    let message = format!(
                        "Sync peer sent unexpected Iroh artifact batch credit message: {}",
                        other.kind()
                    );
                    send_iroh_artifact_batch_abort(connection, batch_token, &message);
                    return Err(message);
                }
            };
            if artifact_ids.is_empty() {
                let message = "Sync peer sent an empty Iroh artifact batch credit.".to_string();
                send_iroh_artifact_batch_abort(connection, batch_token, &message);
                return Err(message);
            }

            let mut handles = Vec::new();
            for artifact_id in artifact_ids {
                let Some(artifact) = artifacts_by_id.get(&artifact_id).cloned() else {
                    let message =
                        format!("Sync peer credited unknown Iroh artifact {artifact_id}.");
                    send_iroh_artifact_batch_abort(connection, batch_token, &message);
                    return Err(message);
                };
                if !served_artifact_ids.insert(artifact_id.clone()) {
                    let message =
                        format!("Sync peer credited Iroh artifact {artifact_id} more than once.");
                    send_iroh_artifact_batch_abort(connection, batch_token, &message);
                    return Err(message);
                }
                let local_file = match resolved.files.get(&artifact_id).cloned() {
                    Some(local_file) => Some(local_file),
                    None if resolved.failures.contains_key(&artifact_id) => None,
                    None => {
                        let message = format!(
                            "Backend artifact resolver omitted artifact {}.",
                            artifact_id
                        );
                        send_iroh_artifact_batch_abort(connection, batch_token, &message);
                        return Err(message);
                    }
                };
                let data = iroh_data.clone();
                let batch_token = batch_token.to_string();
                let run_started_instant = metrics.started_instant;
                let cancel = progress.cancel_token();
                handles.push(thread::spawn(move || {
                    if let Some(local_file) = local_file {
                        return stream_iroh_artifact_file(
                            data,
                            &batch_token,
                            artifact,
                            local_file,
                            run_started_instant,
                            cancel,
                        );
                    }
                    stream_unavailable_iroh_artifact(data, &batch_token, artifact, cancel)
                }));
            }
            for handle in handles {
                let streamed = match handle
                    .join()
                    .map_err(|_| "Iroh artifact stream worker panicked.".to_string())
                    .and_then(|result| result)
                {
                    Ok(streamed) => streamed,
                    Err(error) => {
                        send_iroh_artifact_batch_abort(connection, batch_token, &error);
                        return Err(error);
                    }
                };
                metrics
                    .record_served_artifact_bytes_at(streamed.size_bytes, streamed.first_bytes_at);
                metrics.record_diagnostics(&streamed.diagnostics);
            }
        }
        connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::ArtifactBatchEnd {
                batch_token: batch_token.to_string(),
            },
        )
    }

    fn send_artifact_batch_response(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        artifacts: &[RemoteArtifact],
        metrics: &mut SyncRunMetrics,
        progress: &ProgressReporter,
    ) -> Result<u64, String> {
        let mut resolved = client
            .resolve_artifact_files(artifacts)
            .map_err(|error| phase_context_error("artifact request/transfer", error.to_string()))?;
        let mut handled = 0_u64;
        for artifact in artifacts {
            if let Some(local_file) = resolved.files.remove(&artifact.artifact_id) {
                send_artifact_response_from_file(
                    connection, artifact, local_file, metrics, progress,
                )?;
                handled = handled.saturating_add(1);
                continue;
            }
            if let Some(failure) = resolved.failures.get(&artifact.artifact_id) {
                send_artifact_unavailable_with_message(connection, &failure.message)?;
                handled = handled.saturating_add(1);
                continue;
            }
            return Err(format!(
                "Backend artifact resolver omitted artifact {}.",
                artifact.artifact_id
            ));
        }
        Ok(handled)
    }

    struct StreamedIrohArtifact {
        size_bytes: u64,
        first_bytes_at: Option<Duration>,
        diagnostics: SyncTransportDiagnostics,
    }

    fn stream_unavailable_iroh_artifact(
        iroh_data: IrohDataConnection,
        batch_token: &str,
        artifact: RemoteArtifact,
        cancel: RunCancellationToken,
    ) -> Result<StreamedIrohArtifact, String> {
        if let Some(interruption) = cancel.interruption() {
            return Err(format!(
                "Sync interrupted by lifecycle event {}. {}",
                interruption.event.kind, interruption.guidance
            ));
        }
        let mut diagnostics = SyncTransportDiagnostics::default();
        let stream_open_started = Instant::now();
        let mut send = iroh_data.open_send_stream()?;
        diagnostics.record_stream_open(stream_open_started.elapsed());
        write_iroh_artifact_stream_header(
            &iroh_data,
            &mut send,
            &IrohArtifactStreamHeader {
                batch_token: batch_token.to_string(),
                artifact_id: artifact.artifact_id,
                content_sha256: IROH_ARTIFACT_UNAVAILABLE_CONTENT_SHA256.to_string(),
                size_bytes: artifact.size_bytes,
                unavailable: true,
            },
            &mut diagnostics,
        )?;
        iroh_data.finish_send(&mut send)?;
        Ok(StreamedIrohArtifact {
            size_bytes: 0,
            first_bytes_at: None,
            diagnostics,
        })
    }

    fn send_artifact_unavailable(connection: &SharedPeerConnection) -> Result<(), String> {
        send_artifact_unavailable_with_message(connection, UNAVAILABLE_ARTIFACT_TRANSFER_MESSAGE)
    }

    fn send_artifact_unavailable_with_message(
        connection: &SharedPeerConnection,
        message: &str,
    ) -> Result<(), String> {
        connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::Error(ProtocolError {
                code: "artifact_unavailable".to_string(),
                message: message.to_string(),
            }),
        )
    }

    fn send_artifact_response_from_file(
        connection: &SharedPeerConnection,
        artifact: &RemoteArtifact,
        local_file: LocalArtifactFile,
        metrics: &mut SyncRunMetrics,
        progress: &ProgressReporter,
    ) -> Result<(), String> {
        let mut body = {
            let _progress =
                progress.start_phase("artifact_transfer", "Transferring artifact content.");
            progress.check_not_cancelled()?;
            if local_file.verify_matches(artifact).is_err() {
                send_artifact_unavailable(connection)?;
                return Ok(());
            }
            match local_file.open_body() {
                Ok(body) => body,
                Err(_) => {
                    send_artifact_unavailable(connection)?;
                    return Ok(());
                }
            }
        };
        let _progress = progress.start_phase("artifact_transfer", "Transferring artifact content.");
        progress.check_not_cancelled()?;
        connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::ArtifactStart {
                artifact_id: artifact.artifact_id.clone(),
                content_sha256: artifact.content_sha256.clone(),
                size_bytes: artifact.size_bytes,
            },
        )?;

        let mut buffer = [0_u8; ARTIFACT_CHUNK_SIZE];
        let mut hasher = Sha256::new();
        let mut actual_size = 0_u64;
        loop {
            progress.check_not_cancelled()?;
            let read = match body.read(&mut buffer) {
                Ok(read) => read,
                Err(_) => {
                    send_artifact_unavailable(connection)?;
                    return Ok(());
                }
            };
            if read == 0 {
                break;
            }
            actual_size = actual_size.saturating_add(read as u64);
            hasher.update(&buffer[..read]);
            connection
                .send_artifact_chunk_for_phase("artifact request/transfer", &buffer[..read])?;
            metrics.record_served_artifact_bytes(read as u64);
        }

        let actual_sha256 = hex_digest(hasher.finalize().as_slice());
        if actual_sha256 != artifact.content_sha256 || actual_size != artifact.size_bytes {
            send_artifact_unavailable(connection)?;
            return Ok(());
        }
        connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::ArtifactEnd {
                content_sha256: actual_sha256,
                size_bytes: actual_size,
            },
        )
    }

    fn send_artifact_response(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        artifact: &RemoteArtifact,
        metrics: &mut SyncRunMetrics,
        progress: &ProgressReporter,
    ) -> Result<(), String> {
        let mut resolved = client
            .resolve_artifact_files(std::slice::from_ref(artifact))
            .map_err(|error| {
                phase_context_error(
                    "artifact request/transfer",
                    format!(
                        "Could not read local artifact {}: {error}",
                        artifact.artifact_id
                    ),
                )
            })?;
        if let Some(failure) = resolved.failures.remove(&artifact.artifact_id) {
            send_artifact_unavailable_with_message(connection, &failure.message)?;
            return Ok(());
        }
        let local_file = resolved
            .files
            .remove(&artifact.artifact_id)
            .ok_or_else(|| {
                format!(
                    "Backend artifact resolver omitted artifact {}.",
                    artifact.artifact_id
                )
            })?;
        send_artifact_response_from_file(connection, artifact, local_file, metrics, progress)
    }

    fn stream_iroh_artifact_file(
        iroh_data: IrohDataConnection,
        batch_token: &str,
        artifact: RemoteArtifact,
        local_file: LocalArtifactFile,
        run_started_instant: Instant,
        cancel: RunCancellationToken,
    ) -> Result<StreamedIrohArtifact, String> {
        let mut diagnostics = SyncTransportDiagnostics::default();
        if local_file.verify_matches(&artifact).is_err() {
            return stream_unavailable_iroh_artifact(iroh_data, batch_token, artifact, cancel);
        }
        let mut file = match local_file.open_file() {
            Ok(file) => file,
            Err(_) => {
                return stream_unavailable_iroh_artifact(iroh_data, batch_token, artifact, cancel);
            }
        };
        let stream_open_started = Instant::now();
        let mut send = iroh_data.open_send_stream()?;
        diagnostics.record_stream_open(stream_open_started.elapsed());
        write_iroh_artifact_stream_header(
            &iroh_data,
            &mut send,
            &IrohArtifactStreamHeader {
                batch_token: batch_token.to_string(),
                artifact_id: artifact.artifact_id.clone(),
                content_sha256: artifact.content_sha256.clone(),
                size_bytes: artifact.size_bytes,
                unavailable: false,
            },
            &mut diagnostics,
        )?;
        let mut buffer = [0_u8; ARTIFACT_CHUNK_SIZE];
        let mut hasher = Sha256::new();
        let mut actual_size = 0_u64;
        let mut first_bytes_at = None;
        loop {
            if let Some(interruption) = cancel.interruption() {
                return Err(format!(
                    "Sync interrupted by lifecycle event {}. {}",
                    interruption.event.kind, interruption.guidance
                ));
            }
            let read = match file.read(&mut buffer) {
                Ok(read) => read,
                Err(_) => {
                    iroh_data.finish_send(&mut send)?;
                    return Ok(StreamedIrohArtifact {
                        size_bytes: actual_size,
                        first_bytes_at,
                        diagnostics,
                    });
                }
            };
            if read == 0 {
                break;
            }
            if first_bytes_at.is_none() {
                first_bytes_at = Some(run_started_instant.elapsed());
            }
            actual_size = actual_size.saturating_add(read as u64);
            hasher.update(&buffer[..read]);
            let write_started = Instant::now();
            iroh_data.write_all(&mut send, &buffer[..read])?;
            diagnostics.record_sender_write(write_started.elapsed());
        }
        iroh_data.finish_send(&mut send)?;
        let actual_sha256 = hex_digest(hasher.finalize().as_slice());
        if actual_sha256 != artifact.content_sha256 || actual_size != artifact.size_bytes {
            return Ok(StreamedIrohArtifact {
                size_bytes: actual_size,
                first_bytes_at,
                diagnostics,
            });
        }
        Ok(StreamedIrohArtifact {
            size_bytes: actual_size,
            first_bytes_at,
            diagnostics,
        })
    }

    fn offered_artifacts(manifests: &[Value]) -> Vec<RemoteArtifact> {
        manifests.iter().flat_map(manifest_artifacts).collect()
    }

    fn requested_offered_artifact(
        offered_artifacts: &[RemoteArtifact],
        request: &ArtifactRequest,
    ) -> Result<RemoteArtifact, String> {
        let matches: Vec<_> = offered_artifacts
            .iter()
            .filter(|artifact| artifact_matches_request(artifact, request))
            .collect();
        match matches.as_slice() {
            [artifact] => Ok((*artifact).clone()),
            [] => Err(format!(
                "Sync peer requested artifact {} that was not offered by the manifest.",
                request.artifact_id
            )),
            _ => Err(format!(
                "Sync peer request for artifact {} is ambiguous without a project id.",
                request.artifact_id
            )),
        }
    }

    fn requested_offered_artifact_batch(
        offered_artifacts: &[RemoteArtifact],
        request: &ArtifactBatchRequest,
    ) -> Result<Vec<RemoteArtifact>, String> {
        if request.artifacts.is_empty() {
            return Err("Sync peer sent an empty artifact batch request.".to_string());
        }

        let mut seen = HashSet::new();
        let mut artifacts = Vec::with_capacity(request.artifacts.len());
        for artifact_request in &request.artifacts {
            if artifact_request.project_id.is_none() {
                return Err(format!(
                    "Sync peer batch request for artifact {} did not include a project id.",
                    artifact_request.artifact_id
                ));
            }
            let key = (
                artifact_request.project_id.clone(),
                artifact_request.artifact_id.clone(),
                artifact_request.content_sha256.clone(),
                artifact_request.size_bytes,
            );
            if !seen.insert(key) {
                return Err(format!(
                    "Sync peer batch request repeated artifact {}.",
                    artifact_request.artifact_id
                ));
            }
            artifacts.push(requested_offered_artifact(
                offered_artifacts,
                artifact_request,
            )?);
        }
        Ok(artifacts)
    }

    fn artifact_matches_request(artifact: &RemoteArtifact, request: &ArtifactRequest) -> bool {
        artifact.artifact_id == request.artifact_id
            && request
                .project_id
                .as_deref()
                .is_none_or(|project_id| artifact.project_id == project_id)
            && artifact.content_sha256 == request.content_sha256
            && artifact.size_bytes == request.size_bytes
    }

    #[derive(Clone, Debug)]
    struct LocalArtifactFile {
        artifact_id: String,
        source_path: PathBuf,
        content_sha256: String,
        size_bytes: u64,
    }

    impl LocalArtifactFile {
        fn verify_matches(&self, artifact: &RemoteArtifact) -> Result<(), String> {
            if self.artifact_id != artifact.artifact_id
                || self.content_sha256 != artifact.content_sha256
                || self.size_bytes != artifact.size_bytes
            {
                return Err(
                    "Resolved local artifact file did not match the requested SHA-256 or size."
                        .to_string(),
                );
            }
            Ok(())
        }

        fn open_file(&self) -> Result<File, String> {
            File::open(&self.source_path)
                .map_err(|error| format!("Could not open resolved local artifact file: {error}"))
        }

        fn open_body(&self) -> Result<BackendBody, String> {
            Ok(BackendBody {
                reader: Box::new(self.open_file()?),
                remaining: Some(self.size_bytes),
            })
        }
    }

    #[derive(Clone, Debug, Deserialize)]
    struct SyncLocalIdentityResponse {
        identity: SyncLocalIdentity,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct SyncTrustedPeersResponse {
        trusted_peers: Vec<SyncTrustedPeer>,
    }

    #[derive(Clone)]
    struct BackendClient {
        #[cfg(not(target_os = "android"))]
        host: String,
        #[cfg(not(target_os = "android"))]
        port: u16,
        #[cfg(not(target_os = "android"))]
        sync_transport_temp_root: Arc<Mutex<Option<PathBuf>>>,
        #[cfg(target_os = "android")]
        app: AppHandle,
    }

    impl BackendClient {
        fn new(access: &BackendAccess) -> Result<Self, String> {
            #[cfg(target_os = "android")]
            {
                if access.base_url != "mobile://embedded" {
                    return Err(
                        "Android sync transport requires the embedded mobile backend.".to_string(),
                    );
                }
                return Ok(Self {
                    app: access.app.clone(),
                });
            }

            #[cfg(not(target_os = "android"))]
            {
                let base_url = &access.base_url;
                let without_scheme = base_url.strip_prefix("http://").ok_or_else(|| {
                    "Sync transport only supports loopback http:// backends.".to_string()
                })?;
                let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
                let (host, port) = match authority.rsplit_once(':') {
                    Some((host, port)) => {
                        let port = port.parse::<u16>().map_err(|_| {
                            format!("Backend base URL has an invalid port: {base_url}")
                        })?;
                        (host.to_string(), port)
                    }
                    None => (authority.to_string(), 80),
                };
                if host != "127.0.0.1" && host != "localhost" && host != "[::1]" && host != "::1" {
                    return Err(
                        "Sync transport refuses to proxy a non-loopback backend over LAN."
                            .to_string(),
                    );
                }
                Ok(Self {
                    host,
                    port,
                    sync_transport_temp_root: Arc::new(Mutex::new(None)),
                })
            }
        }

        fn sync_preflight(&self) -> Result<SyncBackendPreflight, BackendError> {
            #[cfg(target_os = "android")]
            {
                return Ok(SyncBackendPreflight::ready());
            }

            #[cfg(not(target_os = "android"))]
            self.get_json_with_timeout("/api/v1/sync/preflight", BACKEND_PREFLIGHT_TIMEOUT)
        }

        fn sync_metadata_preflight_probe(&self) -> Result<(), BackendError> {
            #[cfg(target_os = "android")]
            {
                return Ok(());
            }

            #[cfg(not(target_os = "android"))]
            self.get_json_with_timeout::<Value>("/api/v1/sync/metadata", BACKEND_PREFLIGHT_TIMEOUT)
                .map(|_| ())
        }

        fn local_identity(&self) -> Result<SyncLocalIdentity, BackendError> {
            #[cfg(target_os = "android")]
            {
                let value = crate::mobile_backend::mobile_sync_transport_local_identity_value(
                    self.app.clone(),
                )
                .map_err(BackendError::local)?;
                return serde_json::from_value::<SyncLocalIdentityResponse>(value)
                    .map(|response| response.identity)
                    .map_err(|error| BackendError::local(error.to_string()));
            }

            #[cfg(not(target_os = "android"))]
            self.get_json::<SyncLocalIdentityResponse>("/api/v1/sync/identity")
                .map(|response| response.identity)
        }

        fn trusted_peer(&self, device_id: &str) -> Result<Option<SyncTrustedPeer>, BackendError> {
            #[cfg(target_os = "android")]
            {
                let response = crate::mobile_backend::mobile_sync_transport_trusted_peers_value(
                    self.app.clone(),
                )
                .map_err(BackendError::local)?;
                let response = serde_json::from_value::<SyncTrustedPeersResponse>(response)
                    .map_err(|error| BackendError::local(error.to_string()))?;
                return Ok(response
                    .trusted_peers
                    .into_iter()
                    .find(|peer| peer.device_id == device_id && peer.revoked_at.is_none()));
            }

            #[cfg(not(target_os = "android"))]
            {
                let response =
                    self.get_json::<SyncTrustedPeersResponse>("/api/v1/sync/trusted-peers")?;
                Ok(response
                    .trusted_peers
                    .into_iter()
                    .find(|peer| peer.device_id == device_id && peer.revoked_at.is_none()))
            }
        }

        fn create_pairing_offer(
            &self,
            endpoint_hints: Vec<String>,
            ttl_seconds: u32,
        ) -> Result<Value, BackendError> {
            #[cfg(target_os = "android")]
            {
                return crate::mobile_backend::mobile_sync_transport_create_pairing_offer_value(
                    self.app.clone(),
                    endpoint_hints,
                    i64::from(ttl_seconds),
                )
                .map_err(BackendError::local);
            }

            #[cfg(not(target_os = "android"))]
            {
                let body = json!({
                    "endpoint_hints": endpoint_hints,
                    "ttl_seconds": ttl_seconds,
                });
                self.post_json_value("/api/v1/sync/pairing/offers", &body)
            }
        }

        fn refresh_trusted_peer_endpoint_hints(
            &self,
            device_id: &str,
            endpoint_hints: &[String],
        ) -> Result<(), BackendError> {
            let endpoint_hints = normalize_advisory_endpoint_hints(endpoint_hints.to_vec())
                .map_err(BackendError::local)?;
            if endpoint_hints.is_empty() {
                return Ok(());
            }

            #[cfg(target_os = "android")]
            {
                crate::mobile_backend::mobile_sync_transport_update_trusted_peer_endpoint_hints_value(
                    self.app.clone(),
                    device_id.to_string(),
                    endpoint_hints,
                )
                .map(|_| ())
                .map_err(BackendError::local)
            }

            #[cfg(not(target_os = "android"))]
            {
                let body = json!({ "endpoint_hints": endpoint_hints });
                let path = format!(
                    "/api/v1/sync/trusted-peers/{}/endpoint-hints",
                    percent_encode_path_segment(device_id)
                );
                match self.request_json_value("PATCH", &path, Some(&body)) {
                    Ok(_) => Ok(()),
                    Err(error) if matches!(error.status, Some(404 | 405)) => Ok(()),
                    Err(error) => Err(error),
                }
            }
        }

        fn sign_transport_handshake(
            &self,
            peer_device_id: &str,
            challenge: &Value,
        ) -> Result<Value, BackendError> {
            #[cfg(target_os = "android")]
            {
                return crate::mobile_backend::mobile_sign_transport_handshake(
                    self.app.clone(),
                    peer_device_id.to_string(),
                    challenge.clone(),
                )
                .map_err(BackendError::local);
            }

            #[cfg(not(target_os = "android"))]
            {
                let body = json!({
                    "peer_device_id": peer_device_id,
                    "challenge": challenge,
                });
                self.post_json_value("/api/v1/sync/transport/handshake/sign", &body)
            }
        }

        fn temp_artifact_root(&self) -> Result<PathBuf, String> {
            #[cfg(target_os = "android")]
            {
                if let Ok(path) = self.app.path().app_cache_dir() {
                    return Ok(path);
                }
                if let Ok(path) = self.app.path().app_data_dir() {
                    return Ok(path);
                }
                return Err(
                    "Could not resolve Android sync transport artifact temp directory.".to_string(),
                );
            }

            #[cfg(not(target_os = "android"))]
            {
                let mut cached = self
                    .sync_transport_temp_root
                    .lock()
                    .map_err(|_| "Sync transport temp root cache is unavailable.".to_string())?;
                if let Some(temp_root) = cached.as_ref() {
                    return Ok(temp_root.clone());
                }
                let health = self.get_json_value("/api/v1/health").map_err(|error| {
                    format!("Could not resolve backend data root for sync transport: {error}")
                })?;
                let temp_root = sync_transport_temp_root_from_health(&health)?;
                cleanup_stale_transport_temp_artifacts(&temp_root)?;
                *cached = Some(temp_root.clone());
                Ok(temp_root)
            }
        }

        #[cfg(not(target_os = "android"))]
        fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, BackendError> {
            let value = self.request_json_value("GET", path, None)?;
            serde_json::from_value(value).map_err(|error| BackendError::local(error.to_string()))
        }

        #[cfg(not(target_os = "android"))]
        fn get_json_with_timeout<T: for<'de> Deserialize<'de>>(
            &self,
            path: &str,
            timeout: Duration,
        ) -> Result<T, BackendError> {
            let value = self.request_json_value_with_timeout("GET", path, None, timeout)?;
            serde_json::from_value(value).map_err(|error| BackendError::local(error.to_string()))
        }

        fn get_json_value(&self, path: &str) -> Result<Value, BackendError> {
            #[cfg(target_os = "android")]
            {
                if path == "/api/v1/sync/metadata" {
                    return crate::mobile_backend::mobile_sync_transport_metadata_value(
                        self.app.clone(),
                    )
                    .map_err(BackendError::local);
                }
                if let Some(project_id) = path
                    .strip_prefix("/api/v1/sync/projects/")
                    .and_then(|value| value.strip_suffix("/manifest"))
                {
                    return crate::mobile_backend::mobile_sync_transport_project_manifest_value(
                        self.app.clone(),
                        percent_decode(project_id),
                    )
                    .map_err(BackendError::local);
                }
                if let Some(content_sha256) = path.strip_prefix("/api/v1/sync/artifacts/staging/") {
                    return crate::mobile_backend::mobile_sync_transport_staged_artifact_value(
                        self.app.clone(),
                        percent_decode(content_sha256),
                    )
                    .map_err(|error| {
                        if error.contains("not been staged") {
                            BackendError {
                                status: Some(404),
                                message: error,
                            }
                        } else {
                            BackendError::local(error)
                        }
                    });
                }
                return Err(BackendError::local(format!(
                    "Android mobile backend does not implement GET {path}."
                )));
            }

            #[cfg(not(target_os = "android"))]
            self.request_json_value("GET", path, None)
        }

        fn get_project_manifest_json_value(&self, project_id: &str) -> Result<Value, BackendError> {
            #[cfg(target_os = "android")]
            {
                return crate::mobile_backend::mobile_sync_transport_project_manifest_value(
                    self.app.clone(),
                    project_id.to_string(),
                )
                .map_err(BackendError::local);
            }

            #[cfg(not(target_os = "android"))]
            {
                let path = format!(
                    "/api/v1/sync/projects/{}/manifest",
                    percent_encode_path_segment(project_id)
                );
                self.request_json_value_with_timeout(
                    "GET",
                    &path,
                    None,
                    MANIFEST_EXPORT_HTTP_TIMEOUT,
                )
            }
        }

        fn post_json_value(&self, path: &str, body: &Value) -> Result<Value, BackendError> {
            #[cfg(target_os = "android")]
            {
                return match path {
                    "/api/v1/sync/artifacts/staging" => {
                        crate::mobile_backend::mobile_sync_transport_stage_artifact_value(
                            self.app.clone(),
                            body.clone(),
                        )
                    }
                    "/api/v1/sync/reconciliation/plan" => {
                        crate::mobile_backend::mobile_sync_transport_reconciliation_plan_value(
                            self.app.clone(),
                            body.clone(),
                        )
                    }
                    "/api/v1/sync/reconciliation/apply" => {
                        crate::mobile_backend::mobile_sync_transport_reconciliation_apply_value(
                            self.app.clone(),
                            body.clone(),
                        )
                    }
                    _ => Err(format!(
                        "Android mobile backend does not implement POST {path}."
                    )),
                }
                .map_err(BackendError::local);
            }

            #[cfg(not(target_os = "android"))]
            self.request_json_value("POST", path, Some(body))
        }

        fn post_manifest_batch_json_value(&self, body: &Value) -> Result<Value, BackendError> {
            #[cfg(target_os = "android")]
            {
                Err(BackendError::local(
                    "Android mobile backend does not implement POST /api/v1/sync/projects/manifests."
                        .to_string(),
                ))
            }

            #[cfg(not(target_os = "android"))]
            self.request_json_value_with_timeout(
                "POST",
                "/api/v1/sync/projects/manifests",
                Some(body),
                MANIFEST_EXPORT_HTTP_TIMEOUT,
            )
        }

        fn manifest_batch_unavailable(&self, error: &BackendError) -> bool {
            if matches!(error.status, Some(404 | 405)) {
                return true;
            }
            #[cfg(target_os = "android")]
            {
                error.status.is_none()
                    && error
                        .message
                        .contains("does not implement POST /api/v1/sync/projects/manifests")
            }
            #[cfg(not(target_os = "android"))]
            {
                false
            }
        }

        #[cfg(not(target_os = "android"))]
        fn request_json_value(
            &self,
            method: &str,
            path: &str,
            body: Option<&Value>,
        ) -> Result<Value, BackendError> {
            self.request_json_value_with_timeout(method, path, body, HTTP_TIMEOUT)
        }

        #[cfg(not(target_os = "android"))]
        fn request_json_value_with_timeout(
            &self,
            method: &str,
            path: &str,
            body: Option<&Value>,
            timeout: Duration,
        ) -> Result<Value, BackendError> {
            let mut response = self.request_body_with_timeout(method, path, body, timeout)?;
            let mut bytes = Vec::new();
            response
                .read_to_end(&mut bytes)
                .map_err(|error| backend_http_io_error(error, timeout))?;
            if bytes.is_empty() {
                return Ok(Value::Null);
            }
            serde_json::from_slice(&bytes).map_err(|error| {
                BackendError::local(format!("Could not decode backend JSON response: {error}"))
            })
        }

        fn resolve_artifact_files(
            &self,
            artifacts: &[RemoteArtifact],
        ) -> Result<ArtifactFileResolveResult, BackendError> {
            #[cfg(target_os = "android")]
            {
                let mut files = HashMap::new();
                for artifact in artifacts {
                    let mobile_artifact =
                        crate::mobile_backend::mobile_sync_transport_artifact_file(
                            self.app.clone(),
                            &artifact.artifact_id,
                        )
                        .map_err(BackendError::local)?;
                    files.insert(
                        artifact.artifact_id.clone(),
                        LocalArtifactFile {
                            artifact_id: artifact.artifact_id.clone(),
                            source_path: mobile_artifact.path,
                            content_sha256: artifact.content_sha256.clone(),
                            size_bytes: mobile_artifact.size_bytes,
                        },
                    );
                }
                return Ok(ArtifactFileResolveResult {
                    files,
                    failures: HashMap::new(),
                });
            }

            #[cfg(not(target_os = "android"))]
            {
                let artifact_ids: Vec<_> = artifacts
                    .iter()
                    .map(|artifact| artifact.artifact_id.clone())
                    .collect();
                let body = json!({ "artifact_ids": artifact_ids });
                let response =
                    self.post_json_value("/api/v1/sync/artifacts/files/resolve", &body)?;
                parse_artifact_file_resolve_response(&response, artifacts)
            }
        }

        #[cfg(not(target_os = "android"))]
        fn request_body_with_timeout(
            &self,
            method: &str,
            path: &str,
            body: Option<&Value>,
            timeout: Duration,
        ) -> Result<BackendBody, BackendError> {
            let mut stream = self.connect_with_timeout(timeout)?;
            stream
                .set_read_timeout(Some(timeout))
                .map_err(|error| BackendError::local(error.to_string()))?;
            stream
                .set_write_timeout(Some(timeout))
                .map_err(|error| BackendError::local(error.to_string()))?;

            let body_bytes = match body {
                Some(value) => serde_json::to_vec(value)
                    .map_err(|error| BackendError::local(error.to_string()))?,
                None => Vec::new(),
            };
            write!(
                stream,
                "{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: application/json\r\nContent-Length: {}\r\n",
                self.host,
                body_bytes.len()
            )
            .map_err(|error| backend_http_io_error(error, timeout))?;
            if body.is_some() {
                stream
                    .write_all(b"Content-Type: application/json\r\n")
                    .map_err(|error| backend_http_io_error(error, timeout))?;
            }
            stream
                .write_all(b"\r\n")
                .and_then(|_| stream.write_all(&body_bytes))
                .map_err(|error| backend_http_io_error(error, timeout))?;

            let mut reader = BufReader::new(stream);
            let mut status_line = String::new();
            reader
                .read_line(&mut status_line)
                .map_err(|error| backend_http_io_error(error, timeout))?;
            let status = parse_status_code(&status_line)?;
            let mut content_length = None;
            loop {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .map_err(|error| backend_http_io_error(error, timeout))?;
                if line == "\r\n" || line == "\n" || line.is_empty() {
                    break;
                }
                if let Some(value) = line
                    .strip_prefix("Content-Length:")
                    .or_else(|| line.strip_prefix("content-length:"))
                {
                    content_length = value.trim().parse::<u64>().ok();
                }
            }
            if !(200..300).contains(&status) {
                let mut error_body = String::new();
                let _ = reader.read_to_string(&mut error_body);
                return Err(BackendError {
                    status: Some(status),
                    message: backend_error_message(status, &error_body),
                });
            }
            Ok(BackendBody {
                reader: Box::new(reader),
                remaining: content_length,
            })
        }

        #[cfg(not(target_os = "android"))]
        fn connect_with_timeout(&self, timeout: Duration) -> Result<TcpStream, BackendError> {
            let host = self
                .host
                .strip_prefix('[')
                .and_then(|value| value.strip_suffix(']'))
                .unwrap_or(&self.host);
            let addresses: Vec<SocketAddr> = (host, self.port)
                .to_socket_addrs()
                .map_err(|error| BackendError::local(error.to_string()))?
                .collect();
            if addresses.is_empty() {
                return Err(BackendError::local(
                    "Backend loopback address did not resolve.".to_string(),
                ));
            }

            let mut last_error = None;
            for address in addresses {
                match TcpStream::connect_timeout(&address, timeout) {
                    Ok(stream) => return Ok(stream),
                    Err(error) => last_error = Some(error),
                }
            }

            Err(last_error
                .map(|error| backend_http_io_error(error, timeout))
                .unwrap_or_else(|| {
                    BackendError::local("Could not connect to backend.".to_string())
                }))
        }
    }

    #[cfg(not(target_os = "android"))]
    fn backend_http_io_error(error: io::Error, timeout: Duration) -> BackendError {
        if matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ) {
            BackendError::local(format!(
                "Local backend HTTP request timed out after {} seconds.",
                timeout.as_secs()
            ))
        } else {
            BackendError::local(error.to_string())
        }
    }

    impl SyncTransportAuthBackend for BackendClient {
        fn local_identity(&self) -> Result<SyncLocalIdentity, String> {
            BackendClient::local_identity(self).map_err(|error| error.to_string())
        }

        fn trusted_peer(&self, device_id: &str) -> Result<Option<SyncTrustedPeer>, String> {
            BackendClient::trusted_peer(self, device_id).map_err(|error| error.to_string())
        }

        fn sign_transport_handshake(
            &self,
            peer_device_id: &str,
            challenge: &Value,
        ) -> Result<Value, String> {
            BackendClient::sign_transport_handshake(self, peer_device_id, challenge)
                .map_err(|error| error.to_string())
        }
    }

    struct BackendBody {
        reader: Box<dyn Read + Send>,
        remaining: Option<u64>,
    }

    impl Read for BackendBody {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if matches!(self.remaining, Some(0)) {
                return Ok(0);
            }
            let max_read = self
                .remaining
                .map(|remaining| remaining.min(buf.len() as u64) as usize)
                .unwrap_or(buf.len());
            let read = self.reader.read(&mut buf[..max_read])?;
            if let Some(remaining) = self.remaining.as_mut() {
                *remaining = remaining.saturating_sub(read as u64);
            }
            Ok(read)
        }
    }

    #[derive(Debug)]
    struct BackendError {
        status: Option<u16>,
        message: String,
    }

    impl BackendError {
        fn local(message: String) -> Self {
            Self {
                status: None,
                message,
            }
        }
    }

    impl std::fmt::Display for BackendError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self.status {
                Some(status) => write!(formatter, "backend HTTP {status}: {}", self.message),
                None => formatter.write_str(&self.message),
            }
        }
    }

    #[derive(Clone, Debug)]
    struct ArtifactFileResolveFailure {
        message: String,
    }

    #[derive(Clone, Debug, Default)]
    struct ArtifactFileResolveResult {
        files: HashMap<String, LocalArtifactFile>,
        failures: HashMap<String, ArtifactFileResolveFailure>,
    }

    fn parse_artifact_file_resolve_response(
        response: &Value,
        artifacts: &[RemoteArtifact],
    ) -> Result<ArtifactFileResolveResult, BackendError> {
        let requested: HashMap<_, _> = artifacts
            .iter()
            .map(|artifact| (artifact.artifact_id.as_str(), artifact))
            .collect();
        let mut failures = HashMap::new();
        for error in artifact_resolve_error_values(response) {
            let artifact_id =
                value_string(error, &["artifact_id", "artifactId"]).ok_or_else(|| {
                    BackendError::local(
                        "Artifact file resolver error omitted artifact_id.".to_string(),
                    )
                })?;
            if requested.contains_key(artifact_id.as_str()) {
                failures.insert(
                    artifact_id,
                    ArtifactFileResolveFailure {
                        message: UNAVAILABLE_ARTIFACT_TRANSFER_MESSAGE.to_string(),
                    },
                );
            }
        }

        let records = artifact_resolve_record_values(response);
        let mut files = HashMap::new();
        for record in records {
            let artifact_id =
                value_string(record, &["artifact_id", "artifactId"]).ok_or_else(|| {
                    BackendError::local(
                        "Artifact file resolver record omitted artifact_id.".to_string(),
                    )
                })?;
            let Some(artifact) = requested.get(artifact_id.as_str()) else {
                continue;
            };
            let source_path =
                value_string(record, &["source_path", "sourcePath"]).ok_or_else(|| {
                    BackendError::local(
                        "Artifact file resolver record omitted source_path.".to_string(),
                    )
                })?;
            let content_sha256 = value_string(record, &["content_sha256", "contentSha256"])
                .ok_or_else(|| {
                    BackendError::local(
                        "Artifact file resolver record omitted content_sha256.".to_string(),
                    )
                })?;
            let size_bytes = value_u64(record, &["size_bytes", "sizeBytes"]).ok_or_else(|| {
                BackendError::local("Artifact file resolver record omitted size_bytes.".to_string())
            })?;
            let local_file = LocalArtifactFile {
                artifact_id,
                source_path: PathBuf::from(source_path),
                content_sha256,
                size_bytes,
            };
            local_file
                .verify_matches(artifact)
                .map_err(BackendError::local)?;
            failures.remove(&local_file.artifact_id);
            files.insert(local_file.artifact_id.clone(), local_file);
        }

        for artifact in artifacts {
            if !files.contains_key(&artifact.artifact_id)
                && !failures.contains_key(&artifact.artifact_id)
            {
                return Err(BackendError::local(format!(
                    "Backend artifact resolver omitted artifact {}.",
                    artifact.artifact_id
                )));
            }
        }
        Ok(ArtifactFileResolveResult { files, failures })
    }

    fn artifact_resolve_record_values(response: &Value) -> Vec<&Value> {
        if let Some(records) = response.as_array() {
            return records.iter().collect();
        }
        ["records", "files", "artifacts", "resolved"]
            .into_iter()
            .find_map(|key| response.get(key).and_then(Value::as_array))
            .map(|records| records.iter().collect())
            .unwrap_or_default()
    }

    fn artifact_resolve_error_values(response: &Value) -> Vec<&Value> {
        [
            "errors",
            "artifact_errors",
            "artifactErrors",
            "file_errors",
            "fileErrors",
        ]
        .into_iter()
        .find_map(|key| response.get(key).and_then(Value::as_array))
        .map(|errors| errors.iter().collect())
        .unwrap_or_default()
    }

    fn value_string(value: &Value, keys: &[&str]) -> Option<String> {
        keys.iter()
            .find_map(|key| value.get(*key).and_then(Value::as_str))
            .map(str::to_string)
    }

    fn value_u64(value: &Value, keys: &[&str]) -> Option<u64> {
        keys.iter()
            .find_map(|key| value.get(*key).and_then(Value::as_u64))
    }

    #[cfg(not(target_os = "android"))]
    fn parse_status_code(status_line: &str) -> Result<u16, BackendError> {
        status_line
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse::<u16>().ok())
            .ok_or_else(|| {
                BackendError::local(format!("Invalid backend HTTP status: {status_line}"))
            })
    }

    #[cfg(not(target_os = "android"))]
    fn backend_error_message(status: u16, body: &str) -> String {
        serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .or_else(|| value.get("detail"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| {
                let trimmed = body.trim();
                if trimmed.is_empty() {
                    format!("Backend returned HTTP {status}.")
                } else {
                    trimmed.to_string()
                }
            })
    }

    fn endpoint_hints_for_port(port: u16, device_id: &str) -> Vec<String> {
        let mut hosts = Vec::new();
        if let Ok(addresses) = if_addrs::get_if_addrs() {
            for address in addresses {
                match address.ip() {
                    IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() => {
                        let host = ip.to_string();
                        if !hosts.contains(&host) {
                            hosts.push(host);
                        }
                    }
                    _ => {}
                }
            }
        }
        if hosts.is_empty() {
            hosts.push("127.0.0.1".to_string());
        }
        hosts
            .into_iter()
            .map(|host| {
                format!(
                    "{ENDPOINT_SCHEME}{host}:{port}?device_id={}&v=1",
                    percent_encode_query_value(device_id)
                )
            })
            .collect()
    }

    fn iroh_endpoint_hints(transport: &IrohTransport, device_id: &str) -> Vec<String> {
        iroh_endpoint_hints_from_addr(&transport.endpoint.addr(), device_id)
    }

    fn iroh_endpoint_hints_from_addr(addr: &EndpointAddr, device_id: &str) -> Vec<String> {
        let mut direct_addrs: Vec<SocketAddr> = addr.ip_addrs().copied().collect();
        direct_addrs.sort();
        direct_addrs.dedup();
        if direct_addrs.is_empty() {
            return Vec::new();
        }

        let mut query = format!("device_id={}&v=1", percent_encode_query_value(device_id));
        for direct_addr in direct_addrs {
            query.push_str("&addr=");
            query.push_str(&percent_encode_query_value(&direct_addr.to_string()));
        }
        vec![format!(
            "{IROH_ENDPOINT_SCHEME}{}?{query}",
            percent_encode_query_value(&addr.id.to_string())
        )]
    }

    fn parse_iroh_endpoint_hint(
        endpoint_hint: &str,
        expected_device_id: Option<&str>,
    ) -> Result<EndpointAddr, String> {
        let rest = endpoint_hint
            .strip_prefix(IROH_ENDPOINT_SCHEME)
            .ok_or_else(|| "Endpoint hint is not a TuneForge Iroh URI.".to_string())?;
        let (authority, query) = rest.split_once('?').unwrap_or((rest, ""));
        if let Some(expected_device_id) = expected_device_id {
            if let Some(device_id) = query_parameter(query, "device_id") {
                if device_id != expected_device_id {
                    return Err(
                        "Iroh endpoint hint device_id does not match the trusted peer.".to_string(),
                    );
                }
            }
        }
        let endpoint_id = EndpointId::from_str(&percent_decode(authority))
            .map_err(|error| format!("Iroh endpoint id is invalid: {error}"))?;
        let mut endpoint_addr = EndpointAddr::new(endpoint_id);
        for direct_addr in query_parameters(query, "addr") {
            let direct_addr = direct_addr
                .parse::<SocketAddr>()
                .map_err(|error| format!("Iroh endpoint direct address is invalid: {error}"))?;
            endpoint_addr = endpoint_addr.with_ip_addr(direct_addr);
        }
        if endpoint_addr.ip_addrs().next().is_none() {
            return Err("Iroh endpoint hint did not include a direct address.".to_string());
        }
        Ok(endpoint_addr)
    }

    trait ArtifactStagingClient {
        fn temp_artifact_root(&self) -> Result<PathBuf, String>;
        fn temp_artifact_path(&self, content_sha256: &str) -> Result<PathBuf, String> {
            Ok(temp_artifact_path_in(
                self.temp_artifact_root()?,
                content_sha256,
            ))
        }
        fn post_json_value(&self, path: &str, body: &Value) -> Result<Value, BackendError>;
    }

    impl ArtifactStagingClient for BackendClient {
        fn temp_artifact_root(&self) -> Result<PathBuf, String> {
            BackendClient::temp_artifact_root(self)
        }

        fn post_json_value(&self, path: &str, body: &Value) -> Result<Value, BackendError> {
            BackendClient::post_json_value(self, path, body)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::collections::VecDeque;

        const MISSING_SOURCE_HASH_GUIDANCE: &str =
            "Restore the original source file or re-import affected projects so TuneForge can compute source hashes.";
        const DUPLICATE_SOURCE_HASH_GUIDANCE: &str =
            "Delete duplicate same-source projects or keep one canonical project before enabling sync.";

        fn test_transfer_result(
            artifact_id: &str,
            content_sha256: &str,
            size_bytes: u64,
            status: &str,
        ) -> SyncTransportTransferResult {
            SyncTransportTransferResult {
                artifact_id: artifact_id.to_string(),
                content_sha256: content_sha256.to_string(),
                size_bytes,
                started_at: "2026-01-01T00:00:00Z".to_string(),
                completed_at: "2026-01-01T00:00:01Z".to_string(),
                duration_ms: 1_000,
                throughput_bytes_per_second: size_bytes as f64,
                status: status.to_string(),
                message: None,
            }
        }

        fn test_sync_now_hard_failure(
            run_id: &str,
            error: &str,
            received_artifacts: Vec<SyncTransportTransferResult>,
        ) -> SyncNowHardFailure {
            let started_instant = Instant::now();
            sync_now_hard_failure(
                error.to_string(),
                run_id,
                "dev_peer",
                "dev_remote",
                TransportEvidence {
                    selected_transport: TCP_TRANSPORT_ID.to_string(),
                    fallback_reason: None,
                    fallback_code: None,
                    attempted_transports: vec![TCP_TRANSPORT_ID.to_string()],
                },
                &Utc::now(),
                started_instant,
                &received_artifacts,
                2,
                &SyncRunMetrics::start(started_instant),
                &[SyncTransportTimingEvidence {
                    phase: "reconciliation_staging".to_string(),
                    project_id: Some("proj_one".to_string()),
                    artifact_id: Some("art_one".to_string()),
                    started_at: "2026-01-01T00:00:00Z".to_string(),
                    completed_at: "2026-01-01T00:00:01Z".to_string(),
                    duration_ms: 1_000,
                }],
                4,
                5,
                Vec::new(),
            )
        }

        fn test_incoming_session_hard_failure(
            run_id: &str,
            error: &str,
            received_artifacts: Vec<SyncTransportTransferResult>,
        ) -> IncomingSessionHardFailure {
            let started_instant = Instant::now();
            let mut metrics = SyncRunMetrics::start(started_instant);
            metrics.record_received_artifact_bytes(42);
            metrics.record_served_artifact_bytes(84);
            incoming_session_hard_failure(
                error.to_string(),
                run_id,
                "device_peer_1",
                "device_peer_1",
                TransportEvidence {
                    selected_transport: TCP_TRANSPORT_ID.to_string(),
                    fallback_reason: None,
                    fallback_code: None,
                    attempted_transports: vec![TCP_TRANSPORT_ID.to_string()],
                },
                &Utc::now(),
                started_instant,
                &received_artifacts,
                3,
                &metrics,
                &[SyncTransportTimingEvidence {
                    phase: "serve_artifact_requests".to_string(),
                    project_id: Some("proj_secret".to_string()),
                    artifact_id: Some("art_secret".to_string()),
                    started_at: "2026-01-01T00:00:00Z".to_string(),
                    completed_at: "2026-01-01T00:00:01Z".to_string(),
                    duration_ms: 1_000,
                }],
                4,
                5,
                vec![SyncTransportManifestError {
                    project_id: "proj_secret".to_string(),
                    message: "Backend HTTP 500 for project_id proj_secret at /tmp/secret.wav"
                        .to_string(),
                }],
            )
        }

        fn test_sha256(bytes: &[u8]) -> String {
            let digest = Sha256::digest(bytes);
            hex_digest(digest.as_ref())
        }

        struct ChannelPeerStream {
            incoming: mpsc::Receiver<Vec<u8>>,
            outgoing: mpsc::Sender<Vec<u8>>,
            read_buffer: VecDeque<u8>,
            read_timeout: Duration,
        }

        impl PeerStream for ChannelPeerStream {
            fn read_exact(&mut self, buffer: &mut [u8]) -> io::Result<()> {
                let mut written = 0_usize;
                while written < buffer.len() {
                    if self.read_buffer.is_empty() {
                        match self.incoming.recv_timeout(self.read_timeout) {
                            Ok(bytes) => self.read_buffer.extend(bytes),
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                return Err(io::Error::new(
                                    io::ErrorKind::TimedOut,
                                    "Timed out reading test peer stream.",
                                ));
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => {
                                return Err(io::Error::new(
                                    io::ErrorKind::UnexpectedEof,
                                    "Test peer stream closed.",
                                ));
                            }
                        }
                    }
                    while written < buffer.len() {
                        let Some(byte) = self.read_buffer.pop_front() else {
                            break;
                        };
                        buffer[written] = byte;
                        written += 1;
                    }
                }
                Ok(())
            }

            fn write_all(&mut self, buffer: &[u8]) -> io::Result<()> {
                self.outgoing
                    .send(buffer.to_vec())
                    .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error.to_string()))
            }

            fn set_read_timeout(&mut self, timeout: Duration) -> io::Result<()> {
                self.read_timeout = timeout;
                Ok(())
            }
        }

        fn test_peer_stream_pair() -> (ChannelPeerStream, ChannelPeerStream) {
            let (left_outgoing, right_incoming) = mpsc::channel();
            let (right_outgoing, left_incoming) = mpsc::channel();
            (
                ChannelPeerStream {
                    incoming: left_incoming,
                    outgoing: left_outgoing,
                    read_buffer: VecDeque::new(),
                    read_timeout: Duration::from_secs(2),
                },
                ChannelPeerStream {
                    incoming: right_incoming,
                    outgoing: right_outgoing,
                    read_buffer: VecDeque::new(),
                    read_timeout: Duration::from_secs(2),
                },
            )
        }

        fn spawn_test_sync_peer(
            action: impl FnOnce(SecurePeerConnection) -> Result<(), String> + Send + 'static,
        ) -> (SharedPeerConnection, JoinHandle<Result<(), String>>) {
            let (local_stream, peer_stream) = test_peer_stream_pair();
            let peer = thread::spawn(move || {
                let connection = SecurePeerConnection::connect_responder(
                    Box::new(peer_stream),
                    TransportKind::Tcp,
                    None,
                )?;
                action(connection)
            });

            let connection = SecurePeerConnection::connect_initiator(
                Box::new(local_stream),
                TransportKind::Tcp,
                None,
            )
            .expect("establish test sync connection");
            (SharedPeerConnection::new(connection), peer)
        }

        fn spawn_test_iroh_sync_peer(
            action: impl FnOnce(SecurePeerConnection, IrohDataConnection) -> Result<(), String>
                + Send
                + 'static,
        ) -> (
            SharedPeerConnection,
            Endpoint,
            JoinHandle<Result<(), String>>,
        ) {
            let (server_endpoint, client_endpoint) = tauri::async_runtime::block_on(async {
                let server_endpoint = Endpoint::builder(presets::Minimal)
                    .clear_ip_transports()
                    .clear_relay_transports()
                    .bind_addr((Ipv4Addr::LOCALHOST, 0))
                    .expect("configure test Iroh server bind")
                    .transport_config(iroh_lan_transport_config())
                    .alpns(vec![IROH_ALPN.to_vec()])
                    .bind()
                    .await
                    .expect("bind test Iroh server");
                let client_endpoint = Endpoint::builder(presets::Minimal)
                    .clear_ip_transports()
                    .clear_relay_transports()
                    .bind_addr((Ipv4Addr::LOCALHOST, 0))
                    .expect("configure test Iroh client bind")
                    .transport_config(iroh_lan_transport_config())
                    .bind()
                    .await
                    .expect("bind test Iroh client");
                (server_endpoint, client_endpoint)
            });
            let server_addr = server_endpoint.addr();
            assert!(
                server_addr.ip_addrs().next().is_some(),
                "test Iroh server must expose a direct address"
            );
            let peer = thread::spawn(move || {
                let accepted =
                    tauri::async_runtime::block_on(async {
                        let incoming = server_endpoint.accept().await.ok_or_else(|| {
                            "Test Iroh server closed before accepting.".to_string()
                        })?;
                        let connection = incoming
                            .await
                            .map_err(|error| format!("Could not accept test Iroh peer: {error}"))?;
                        let runtime_handle = tokio::runtime::Handle::current();
                        let (send, recv) = connection.accept_bi().await.map_err(|error| {
                            format!("Could not accept test Iroh stream: {error}")
                        })?;
                        Ok::<_, String>((connection, send, recv, runtime_handle))
                    });
                let result = accepted.and_then(|(connection, send, recv, runtime_handle)| {
                    let iroh_data = IrohDataConnection {
                        connection,
                        runtime_handle: runtime_handle.clone(),
                    };
                    let connection = SecurePeerConnection::connect_responder(
                        Box::new(IrohPeerStream::new(send, recv, runtime_handle)),
                        TransportKind::Iroh,
                        Some(iroh_data.clone()),
                    )?;
                    action(connection, iroh_data)
                });
                tauri::async_runtime::block_on(server_endpoint.close());
                result
            });

            let (connection, send, recv, runtime_handle) = tauri::async_runtime::block_on(async {
                let connection = client_endpoint
                    .connect(server_addr, IROH_ALPN)
                    .await
                    .map_err(|error| format!("Could not connect test Iroh peer: {error}"))
                    .expect("connect test Iroh peer");
                let runtime_handle = tokio::runtime::Handle::current();
                let (send, recv) = connection
                    .open_bi()
                    .await
                    .map_err(|error| format!("Could not open test Iroh stream: {error}"))
                    .expect("open test Iroh stream");
                (connection, send, recv, runtime_handle)
            });
            let iroh_data = IrohDataConnection {
                connection,
                runtime_handle: runtime_handle.clone(),
            };
            let connection = SecurePeerConnection::connect_initiator(
                Box::new(IrohPeerStream::new(send, recv, runtime_handle)),
                TransportKind::Iroh,
                Some(iroh_data),
            )
            .expect("establish test Iroh sync connection");
            (SharedPeerConnection::new(connection), client_endpoint, peer)
        }

        fn close_test_iroh_endpoint(endpoint: &Endpoint) {
            tauri::async_runtime::block_on(endpoint.close());
        }

        fn send_test_iroh_artifact_stream(
            iroh_data: &IrohDataConnection,
            batch_token: &str,
            artifact: &RemoteArtifact,
            bytes: &[u8],
        ) -> Result<(), String> {
            let mut send = iroh_data.open_send_stream()?;
            let mut diagnostics = SyncTransportDiagnostics::default();
            write_iroh_artifact_stream_header(
                iroh_data,
                &mut send,
                &IrohArtifactStreamHeader {
                    batch_token: batch_token.to_string(),
                    artifact_id: artifact.artifact_id.clone(),
                    content_sha256: artifact.content_sha256.clone(),
                    size_bytes: artifact.size_bytes,
                    unavailable: false,
                },
                &mut diagnostics,
            )?;
            iroh_data.write_all(&mut send, bytes)?;
            iroh_data.finish_send(&mut send)
        }

        fn send_test_iroh_unavailable_artifact_stream(
            iroh_data: &IrohDataConnection,
            batch_token: &str,
            artifact: &RemoteArtifact,
        ) -> Result<(), String> {
            let mut send = iroh_data.open_send_stream()?;
            let mut diagnostics = SyncTransportDiagnostics::default();
            write_iroh_artifact_stream_header(
                iroh_data,
                &mut send,
                &IrohArtifactStreamHeader {
                    batch_token: batch_token.to_string(),
                    artifact_id: artifact.artifact_id.clone(),
                    content_sha256: IROH_ARTIFACT_UNAVAILABLE_CONTENT_SHA256.to_string(),
                    size_bytes: artifact.size_bytes,
                    unavailable: true,
                },
                &mut diagnostics,
            )?;
            iroh_data.finish_send(&mut send)
        }

        fn receive_test_iroh_artifact_stream(
            iroh_data: &IrohDataConnection,
            batch_token: &str,
            artifact: &RemoteArtifact,
        ) -> Result<Vec<u8>, String> {
            let mut recv = iroh_data
                .accept_recv_stream_with_timeout(Duration::from_secs(5))?
                .ok_or_else(|| "test peer did not receive Iroh artifact stream".to_string())?;
            let cancel_receivers = AtomicBool::new(false);
            let mut diagnostics = SyncTransportDiagnostics::default();
            let header = read_iroh_artifact_stream_header(
                iroh_data,
                &mut recv,
                &cancel_receivers,
                &mut diagnostics,
            )?;
            if header.batch_token != batch_token
                || header.artifact_id != artifact.artifact_id
                || header.content_sha256 != artifact.content_sha256
                || header.size_bytes != artifact.size_bytes
                || header.unavailable
            {
                return Err("test Iroh artifact stream header did not match credit".to_string());
            }
            let mut bytes = vec![0_u8; artifact.size_bytes as usize];
            read_iroh_artifact_stream_exact(iroh_data, &mut recv, &mut bytes, &cancel_receivers)?;
            Ok(bytes)
        }

        fn receive_test_iroh_unavailable_artifact_stream(
            iroh_data: &IrohDataConnection,
            batch_token: &str,
            artifact: &RemoteArtifact,
        ) -> Result<(), String> {
            let mut recv = iroh_data
                .accept_recv_stream_with_timeout(Duration::from_secs(5))?
                .ok_or_else(|| "test peer did not receive Iroh artifact stream".to_string())?;
            let cancel_receivers = AtomicBool::new(false);
            let mut diagnostics = SyncTransportDiagnostics::default();
            let header = read_iroh_artifact_stream_header(
                iroh_data,
                &mut recv,
                &cancel_receivers,
                &mut diagnostics,
            )?;
            if header.batch_token != batch_token
                || header.artifact_id != artifact.artifact_id
                || header.content_sha256 != IROH_ARTIFACT_UNAVAILABLE_CONTENT_SHA256
                || header.size_bytes != artifact.size_bytes
                || !header.unavailable
            {
                return Err("test Iroh artifact stream header did not match credit".to_string());
            }
            let mut byte = [0_u8; 1];
            match iroh_data.read_with_timeout(&mut recv, &mut byte, Duration::from_secs(5))? {
                IrohDataReadPoll::Data(0) | IrohDataReadPoll::EndOfStream => Ok(()),
                IrohDataReadPoll::Data(read) => Err(format!(
                    "unavailable Iroh artifact stream sent {read} unexpected byte(s)"
                )),
                IrohDataReadPoll::TimedOut => {
                    Err("timed out waiting for unavailable Iroh artifact stream end".to_string())
                }
            }
        }

        fn receive_test_tcp_artifact(
            peer: &mut SecurePeerConnection,
            artifact: &RemoteArtifact,
        ) -> Result<Vec<u8>, String> {
            let start = read_message_accepting_status(
                "artifact request/transfer",
                || peer.read_message(),
                |_| {},
            )?;
            match start {
                ProtocolMessage::ArtifactStart {
                    artifact_id,
                    content_sha256,
                    size_bytes,
                } if artifact_id == artifact.artifact_id
                    && content_sha256 == artifact.content_sha256
                    && size_bytes == artifact.size_bytes => {}
                other => {
                    return Err(format!(
                        "expected artifact start for {}, got {}",
                        artifact.artifact_id,
                        other.kind()
                    ));
                }
            }

            let mut bytes = Vec::new();
            loop {
                match peer.read_artifact_transfer_frame()? {
                    ArtifactTransferFrame::Chunk(chunk) => bytes.extend(chunk),
                    ArtifactTransferFrame::Message(ProtocolMessage::ArtifactEnd {
                        content_sha256,
                        size_bytes,
                    }) => {
                        if content_sha256 != artifact.content_sha256
                            || size_bytes != artifact.size_bytes
                            || test_sha256(&bytes) != artifact.content_sha256
                        {
                            return Err("test artifact response failed hash or size verification."
                                .to_string());
                        }
                        return Ok(bytes);
                    }
                    ArtifactTransferFrame::Message(ProtocolMessage::Status { .. }) => {}
                    ArtifactTransferFrame::Message(other) => {
                        return Err(format!(
                            "expected artifact bytes/end for {}, got {}",
                            artifact.artifact_id,
                            other.kind()
                        ));
                    }
                }
            }
        }

        fn try_read_test_iroh_artifact_stream_header(
            iroh_data: &IrohDataConnection,
            recv: &mut RecvStream,
        ) -> Result<Option<IrohArtifactStreamHeader>, String> {
            let mut length = [0_u8; 4];
            if !read_test_iroh_data_exact_with_short_timeout(iroh_data, recv, &mut length)? {
                return Ok(None);
            }
            let length = u32::from_be_bytes(length) as usize;
            if length == 0 || length > IROH_DATA_HEADER_MAX_BYTES {
                return Ok(None);
            }
            let mut payload = vec![0_u8; length];
            if !read_test_iroh_data_exact_with_short_timeout(iroh_data, recv, &mut payload)? {
                return Ok(None);
            }
            Ok(serde_json::from_slice(&payload).ok())
        }

        fn read_test_iroh_data_exact_with_short_timeout(
            iroh_data: &IrohDataConnection,
            recv: &mut RecvStream,
            buffer: &mut [u8],
        ) -> Result<bool, String> {
            let started = Instant::now();
            let mut read_bytes = 0_usize;
            while read_bytes < buffer.len() && started.elapsed() < Duration::from_millis(250) {
                match iroh_data.read_with_timeout(
                    recv,
                    &mut buffer[read_bytes..],
                    Duration::from_millis(25),
                )? {
                    IrohDataReadPoll::Data(0) | IrohDataReadPoll::EndOfStream => return Ok(false),
                    IrohDataReadPoll::Data(read) => read_bytes = read_bytes.saturating_add(read),
                    IrohDataReadPoll::TimedOut => {}
                }
            }
            Ok(read_bytes == buffer.len())
        }

        fn collect_test_files(root: &Path) -> Vec<PathBuf> {
            let Ok(entries) = fs::read_dir(root) else {
                return Vec::new();
            };
            let mut files = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    files.extend(collect_test_files(&path));
                } else {
                    files.push(path);
                }
            }
            files
        }

        #[cfg(not(target_os = "android"))]
        struct TestBackendServer {
            port: u16,
            requests: Arc<Mutex<Vec<String>>>,
            manifest_batch_requests: Arc<Mutex<Vec<Vec<String>>>>,
            manifest_get_requests: Arc<Mutex<Vec<String>>>,
            request_bodies: Arc<Mutex<Vec<(String, Value)>>>,
            data_root: PathBuf,
            stop_sender: Option<mpsc::Sender<()>>,
            handle: Option<JoinHandle<()>>,
        }

        #[cfg(not(target_os = "android"))]
        struct TestBackendResponses {
            data_root: PathBuf,
            staged_artifact_sizes: HashMap<String, u64>,
            artifact_files: HashMap<String, LocalArtifactFile>,
            artifact_file_errors: HashMap<String, String>,
            staging_failure: Option<String>,
            project_manifests: HashMap<String, Value>,
            manifest_batch_status: Option<u16>,
            manifest_batch_status_by_project_ids: HashMap<Vec<String>, u16>,
            manifest_batch_requests: Arc<Mutex<Vec<Vec<String>>>>,
            manifest_get_requests: Arc<Mutex<Vec<String>>>,
            apply_failure_project_ids: HashSet<String>,
        }

        #[cfg(not(target_os = "android"))]
        impl TestBackendServer {
            fn start_with_staged_artifacts(staged_artifact_sizes: HashMap<String, u64>) -> Self {
                Self::start_with_staged_artifacts_and_files(staged_artifact_sizes, HashMap::new())
            }

            fn start_with_staged_artifacts_and_files(
                staged_artifact_sizes: HashMap<String, u64>,
                artifact_files: HashMap<String, LocalArtifactFile>,
            ) -> Self {
                Self::start_with_responses(
                    staged_artifact_sizes,
                    artifact_files,
                    None,
                    HashMap::new(),
                    None,
                    HashMap::new(),
                )
            }

            fn start_with_staged_artifacts_files_and_resolve_errors(
                staged_artifact_sizes: HashMap<String, u64>,
                artifact_files: HashMap<String, LocalArtifactFile>,
                artifact_file_errors: HashMap<String, String>,
            ) -> Self {
                Self::start_with_responses_and_resolve_errors(
                    staged_artifact_sizes,
                    artifact_files,
                    artifact_file_errors,
                    None,
                    HashMap::new(),
                    None,
                    HashMap::new(),
                )
            }

            fn start_with_staging_failure(staging_failure: impl Into<String>) -> Self {
                Self::start_with_responses(
                    HashMap::new(),
                    HashMap::new(),
                    Some(staging_failure.into()),
                    HashMap::new(),
                    None,
                    HashMap::new(),
                )
            }

            fn start_with_project_manifests(project_manifests: HashMap<String, Value>) -> Self {
                Self::start_with_manifest_responses(project_manifests, None, HashMap::new())
            }

            fn start_with_project_manifests_and_batch_status(
                project_manifests: HashMap<String, Value>,
                manifest_batch_status: u16,
            ) -> Self {
                Self::start_with_manifest_responses(
                    project_manifests,
                    Some(manifest_batch_status),
                    HashMap::new(),
                )
            }

            fn start_with_project_manifests_and_batch_statuses(
                project_manifests: HashMap<String, Value>,
                manifest_batch_status_by_project_ids: HashMap<Vec<String>, u16>,
            ) -> Self {
                Self::start_with_manifest_responses(
                    project_manifests,
                    None,
                    manifest_batch_status_by_project_ids,
                )
            }

            fn start_with_manifest_responses(
                project_manifests: HashMap<String, Value>,
                manifest_batch_status: Option<u16>,
                manifest_batch_status_by_project_ids: HashMap<Vec<String>, u16>,
            ) -> Self {
                Self::start_with_responses(
                    HashMap::new(),
                    HashMap::new(),
                    None,
                    project_manifests,
                    manifest_batch_status,
                    manifest_batch_status_by_project_ids,
                )
            }

            fn start_with_apply_failure_project_ids(project_ids: HashSet<String>) -> Self {
                Self::start_with_responses_and_apply_failures(
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                    None,
                    project_ids,
                )
            }

            fn start_with_responses(
                staged_artifact_sizes: HashMap<String, u64>,
                artifact_files: HashMap<String, LocalArtifactFile>,
                staging_failure: Option<String>,
                project_manifests: HashMap<String, Value>,
                manifest_batch_status: Option<u16>,
                manifest_batch_status_by_project_ids: HashMap<Vec<String>, u16>,
            ) -> Self {
                Self::start_with_responses_and_resolve_errors(
                    staged_artifact_sizes,
                    artifact_files,
                    HashMap::new(),
                    staging_failure,
                    project_manifests,
                    manifest_batch_status,
                    manifest_batch_status_by_project_ids,
                )
            }

            fn start_with_responses_and_resolve_errors(
                staged_artifact_sizes: HashMap<String, u64>,
                artifact_files: HashMap<String, LocalArtifactFile>,
                artifact_file_errors: HashMap<String, String>,
                staging_failure: Option<String>,
                project_manifests: HashMap<String, Value>,
                manifest_batch_status: Option<u16>,
                manifest_batch_status_by_project_ids: HashMap<Vec<String>, u16>,
            ) -> Self {
                Self::start_with_responses_manifest_and_apply_failures(
                    staged_artifact_sizes,
                    artifact_files,
                    artifact_file_errors,
                    staging_failure,
                    project_manifests,
                    manifest_batch_status,
                    manifest_batch_status_by_project_ids,
                    HashSet::new(),
                )
            }

            fn start_with_responses_and_apply_failures(
                staged_artifact_sizes: HashMap<String, u64>,
                artifact_files: HashMap<String, LocalArtifactFile>,
                artifact_file_errors: HashMap<String, String>,
                staging_failure: Option<String>,
                apply_failure_project_ids: HashSet<String>,
            ) -> Self {
                Self::start_with_responses_manifest_and_apply_failures(
                    staged_artifact_sizes,
                    artifact_files,
                    artifact_file_errors,
                    staging_failure,
                    HashMap::new(),
                    None,
                    HashMap::new(),
                    apply_failure_project_ids,
                )
            }

            fn start_with_responses_manifest_and_apply_failures(
                staged_artifact_sizes: HashMap<String, u64>,
                artifact_files: HashMap<String, LocalArtifactFile>,
                artifact_file_errors: HashMap<String, String>,
                staging_failure: Option<String>,
                project_manifests: HashMap<String, Value>,
                manifest_batch_status: Option<u16>,
                manifest_batch_status_by_project_ids: HashMap<Vec<String>, u16>,
                apply_failure_project_ids: HashSet<String>,
            ) -> Self {
                let listener =
                    TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind test backend");
                listener
                    .set_nonblocking(true)
                    .expect("set test backend nonblocking");
                let port = listener
                    .local_addr()
                    .expect("test backend local addr")
                    .port();
                let requests = Arc::new(Mutex::new(Vec::new()));
                let manifest_batch_requests = Arc::new(Mutex::new(Vec::new()));
                let manifest_get_requests = Arc::new(Mutex::new(Vec::new()));
                let request_bodies = Arc::new(Mutex::new(Vec::new()));
                let data_root =
                    env::temp_dir().join(format!("tuneforge-sync-backend-test-{}", random_nonce()));
                fs::create_dir_all(data_root.join("sync").join("transport-tmp"))
                    .expect("create test sync transport temp root");
                let responses = Arc::new(TestBackendResponses {
                    data_root: data_root.clone(),
                    staged_artifact_sizes,
                    artifact_files,
                    artifact_file_errors,
                    staging_failure,
                    project_manifests,
                    manifest_batch_status,
                    manifest_batch_status_by_project_ids,
                    manifest_batch_requests: Arc::clone(&manifest_batch_requests),
                    manifest_get_requests: Arc::clone(&manifest_get_requests),
                    apply_failure_project_ids,
                });
                let (stop_sender, stop_receiver) = mpsc::channel();
                let handle = {
                    let requests = Arc::clone(&requests);
                    let request_bodies = Arc::clone(&request_bodies);
                    let responses = Arc::clone(&responses);
                    thread::spawn(move || loop {
                        if stop_receiver.try_recv().is_ok() {
                            break;
                        }
                        match listener.accept() {
                            Ok((stream, _addr)) => {
                                let requests = Arc::clone(&requests);
                                let request_bodies = Arc::clone(&request_bodies);
                                let responses = Arc::clone(&responses);
                                thread::spawn(move || {
                                    handle_test_backend_stream(
                                        stream,
                                        &requests,
                                        &request_bodies,
                                        &responses,
                                    );
                                });
                            }
                            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                                thread::sleep(Duration::from_millis(10));
                            }
                            Err(_) => break,
                        }
                    })
                };
                Self {
                    port,
                    requests,
                    manifest_batch_requests,
                    manifest_get_requests,
                    request_bodies,
                    data_root,
                    stop_sender: Some(stop_sender),
                    handle: Some(handle),
                }
            }

            fn requests(&self) -> Vec<String> {
                self.requests
                    .lock()
                    .expect("read test backend requests")
                    .clone()
            }

            fn manifest_batch_requests(&self) -> Vec<Vec<String>> {
                self.manifest_batch_requests
                    .lock()
                    .expect("read test manifest batch requests")
                    .clone()
            }

            fn manifest_get_requests(&self) -> Vec<String> {
                self.manifest_get_requests
                    .lock()
                    .expect("read test manifest get requests")
                    .clone()
            }

            fn request_bodies(&self, path: &str) -> Vec<Value> {
                self.request_bodies
                    .lock()
                    .expect("read test backend request bodies")
                    .iter()
                    .filter(|(request_path, _)| request_path == path)
                    .map(|(_, body)| body.clone())
                    .collect()
            }

            fn transport_temp_root(&self) -> PathBuf {
                self.data_root.join("sync").join("transport-tmp")
            }
        }

        #[cfg(not(target_os = "android"))]
        impl Drop for TestBackendServer {
            fn drop(&mut self) {
                if let Some(stop_sender) = self.stop_sender.take() {
                    let _ = stop_sender.send(());
                    let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, self.port));
                }
                if let Some(handle) = self.handle.take() {
                    let _ = handle.join();
                }
                let _ = fs::remove_dir_all(&self.data_root);
            }
        }

        #[cfg(not(target_os = "android"))]
        fn handle_test_backend_stream(
            stream: TcpStream,
            requests: &Arc<Mutex<Vec<String>>>,
            request_bodies: &Arc<Mutex<Vec<(String, Value)>>>,
            responses: &TestBackendResponses,
        ) {
            let mut reader = BufReader::new(stream);
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                return;
            }
            let path = request_line
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .to_string();
            let mut content_length = 0_usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line == "\r\n" || line == "\n" {
                    break;
                }
                if let Some(value) = line
                    .strip_prefix("Content-Length:")
                    .or_else(|| line.strip_prefix("content-length:"))
                {
                    content_length = value.trim().parse().unwrap_or(0);
                }
            }
            let request_body = if content_length > 0 {
                let mut body = vec![0_u8; content_length];
                let _ = reader.read_exact(&mut body);
                serde_json::from_slice::<Value>(&body).ok()
            } else {
                None
            };
            if !path.is_empty() {
                requests
                    .lock()
                    .expect("record test backend request")
                    .push(path.clone());
                if let Some(body) = request_body.as_ref() {
                    request_bodies
                        .lock()
                        .expect("record test backend request body")
                        .push((path.clone(), body.clone()));
                }
            }
            let (status, body) = if path == "/api/v1/sync/reconciliation/apply" {
                let project_ids = request_body
                    .as_ref()
                    .and_then(|body| body.get("project_ids"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<HashSet<_>>();
                if responses
                    .apply_failure_project_ids
                    .iter()
                    .any(|project_id| project_ids.contains(project_id.as_str()))
                {
                    (
                        "500 Internal Server Error".to_string(),
                        json!({ "detail": "apply refused requested project" }).to_string(),
                    )
                } else {
                    ("200 OK".to_string(), json!({ "actions": [] }).to_string())
                }
            } else if path == "/api/v1/health" {
                (
                    "200 OK".to_string(),
                    json!({ "data_root": responses.data_root.to_string_lossy() }).to_string(),
                )
            } else if path == "/api/v1/sync/projects/manifests" {
                let project_ids = request_body
                    .as_ref()
                    .and_then(|value| {
                        value
                            .get("project_ids")
                            .or_else(|| value.get("projectIds"))
                            .and_then(Value::as_array)
                    })
                    .map(|ids| {
                        ids.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                responses
                    .manifest_batch_requests
                    .lock()
                    .expect("record test manifest batch request")
                    .push(project_ids.clone());
                if let Some(status) = responses
                    .manifest_batch_status_by_project_ids
                    .get(&project_ids)
                    .copied()
                    .or(responses.manifest_batch_status)
                {
                    (
                        test_http_status_line(status),
                        json!({ "detail": "test manifest batch failed" }).to_string(),
                    )
                } else {
                    let mut project_manifests = Vec::new();
                    let mut manifest_errors = Vec::new();
                    for project_id in project_ids {
                        if let Some(manifest) = responses.project_manifests.get(&project_id) {
                            project_manifests.push(manifest.clone());
                        } else {
                            manifest_errors.push(json!({
                                "project_id": project_id,
                                "message": "test manifest missing",
                            }));
                        }
                    }
                    (
                        "200 OK".to_string(),
                        json!({
                            "project_manifests": project_manifests,
                            "manifest_errors": manifest_errors,
                        })
                        .to_string(),
                    )
                }
            } else if let Some(project_id) = path
                .strip_prefix("/api/v1/sync/projects/")
                .and_then(|value| value.strip_suffix("/manifest"))
            {
                let project_id = percent_decode(project_id);
                responses
                    .manifest_get_requests
                    .lock()
                    .expect("record test manifest get request")
                    .push(project_id.clone());
                match responses.project_manifests.get(&project_id) {
                    Some(manifest) => (
                        "200 OK".to_string(),
                        json!({ "project_manifest": manifest }).to_string(),
                    ),
                    None => (
                        "404 Not Found".to_string(),
                        json!({ "detail": "test manifest missing" }).to_string(),
                    ),
                }
            } else if path == "/api/v1/sync/artifacts/files/resolve" {
                let records = responses
                    .artifact_files
                    .values()
                    .map(|file| {
                        json!({
                            "artifact_id": &file.artifact_id,
                            "source_path": file.source_path.to_string_lossy().to_string(),
                            "content_sha256": &file.content_sha256,
                            "size_bytes": file.size_bytes,
                        })
                    })
                    .collect::<Vec<_>>();
                let errors = responses
                    .artifact_file_errors
                    .iter()
                    .map(|(artifact_id, message)| {
                        json!({
                            "artifact_id": artifact_id,
                            "message": message,
                        })
                    })
                    .collect::<Vec<_>>();
                (
                    "200 OK".to_string(),
                    json!({ "records": records, "errors": errors }).to_string(),
                )
            } else if path == "/api/v1/sync/artifacts/staging" {
                if let Some(message) = responses.staging_failure.as_deref() {
                    (
                        "500 Internal Server Error".to_string(),
                        json!({ "detail": message }).to_string(),
                    )
                } else {
                    ("200 OK".to_string(), "{}".to_string())
                }
            } else if let Some(content_sha256) =
                path.strip_prefix("/api/v1/sync/artifacts/staging/")
            {
                match responses.staged_artifact_sizes.get(content_sha256) {
                    Some(size_bytes) => (
                        "200 OK".to_string(),
                        json!({ "size_bytes": size_bytes }).to_string(),
                    ),
                    None => (
                        "404 Not Found".to_string(),
                        json!({ "detail": "not staged" }).to_string(),
                    ),
                }
            } else {
                ("200 OK".to_string(), "{}".to_string())
            };
            let mut stream = reader.into_inner();
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        }

        #[cfg(not(target_os = "android"))]
        fn test_http_status_line(status: u16) -> String {
            match status {
                200 => "200 OK".to_string(),
                404 => "404 Not Found".to_string(),
                405 => "405 Method Not Allowed".to_string(),
                500 => "500 Internal Server Error".to_string(),
                _ => format!("{status} Test Status"),
            }
        }

        #[cfg(not(target_os = "android"))]
        fn test_backend_client(backend: &TestBackendServer) -> BackendClient {
            BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            }
        }

        fn test_project_manifest(project_id: &str) -> Value {
            json!({
                "project": { "project_id": project_id },
                "artifacts": [],
                "entity_revisions": [],
            })
        }

        struct TestStagingClient {
            temp_root: PathBuf,
            responses: Mutex<VecDeque<Result<Value, BackendError>>>,
            requests: Mutex<Vec<Value>>,
        }

        impl TestStagingClient {
            fn new(responses: Vec<Result<Value, BackendError>>) -> Self {
                Self {
                    temp_root: env::temp_dir()
                        .join(format!("tuneforge-sync-transport-test-{}", random_nonce())),
                    responses: Mutex::new(responses.into()),
                    requests: Mutex::new(Vec::new()),
                }
            }

            fn requests(&self) -> Vec<Value> {
                self.requests
                    .lock()
                    .expect("read test staging requests")
                    .clone()
            }
        }

        impl ArtifactStagingClient for TestStagingClient {
            fn temp_artifact_root(&self) -> Result<PathBuf, String> {
                Ok(self.temp_root.clone())
            }

            fn post_json_value(&self, path: &str, body: &Value) -> Result<Value, BackendError> {
                if path != "/api/v1/sync/artifacts/staging" {
                    return Err(BackendError::local(format!(
                        "Unexpected test staging path: {path}"
                    )));
                }
                {
                    let mut requests = self.requests.lock().map_err(|_| {
                        BackendError::local("Test staging requests unavailable.".to_string())
                    })?;
                    requests.push(body.clone());
                }
                self.responses
                    .lock()
                    .map_err(|_| {
                        BackendError::local("Test staging responses unavailable.".to_string())
                    })?
                    .pop_front()
                    .unwrap_or_else(|| {
                        Err(BackendError::local(
                            "Unexpected test staging request.".to_string(),
                        ))
                    })
            }
        }

        impl Drop for TestStagingClient {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.temp_root);
            }
        }

        #[test]
        fn endpoint_hint_rejects_unexpected_device_id() {
            let hint = format!("{ENDPOINT_SCHEME}127.0.0.1:3000?device_id=dev_one&v=1");
            let error = parse_endpoint_hint(&hint, Some("dev_two")).expect_err("reject mismatch");

            assert!(error.contains("device_id"));
        }

        #[test]
        fn endpoint_hint_parses_ipv4_socket() {
            let hint = format!("{ENDPOINT_SCHEME}127.0.0.1:3000?device_id=dev_one&v=1");
            let socket = parse_endpoint_hint(&hint, Some("dev_one")).expect("parse hint");

            assert_eq!(socket.port(), 3000);
        }

        #[test]
        fn iroh_endpoint_hint_round_trips_direct_addresses_and_device_id() {
            let endpoint_id = SecretKey::generate().public();
            let endpoint_addr = EndpointAddr::new(endpoint_id)
                .with_ip_addr("127.0.0.1:47620".parse().expect("direct addr"));
            let hints = iroh_endpoint_hints_from_addr(&endpoint_addr, "dev_one");

            assert_eq!(hints.len(), 1);
            assert!(hints[0].starts_with(IROH_ENDPOINT_SCHEME));

            let parsed =
                parse_iroh_endpoint_hint(&hints[0], Some("dev_one")).expect("parse iroh hint");
            assert_eq!(parsed.id, endpoint_id);
            assert_eq!(
                parsed.ip_addrs().copied().collect::<Vec<_>>(),
                vec!["127.0.0.1:47620".parse::<SocketAddr>().expect("addr")]
            );
            assert!(parse_iroh_endpoint_hint(&hints[0], Some("dev_two"))
                .expect_err("reject mismatched device")
                .contains("device_id"));
        }

        #[test]
        fn iroh_auth_error_does_not_record_tcp_fallback() {
            let mut connection =
                ScriptedProtocolConnection::new(vec![ProtocolMessage::Error(ProtocolError {
                    code: "auth_failed".to_string(),
                    message: "auth proof rejected".to_string(),
                })]);
            let selection = select_sync_transport(
                None,
                None,
                &[
                    format!(
                        "{IROH_ENDPOINT_SCHEME}iroh_peer?device_id=dev_peer&v=1&addr=127.0.0.1%3A47620"
                    ),
                    format!("{ENDPOINT_SCHEME}127.0.0.1:47619?device_id=dev_peer&v=1"),
                ],
                "dev_peer",
                true,
            )
            .expect("select Iroh before auth");

            let error = authenticate_session(
                &mut connection,
                &TestAuthBackend,
                Some("dev_peer".to_string()),
                &[],
            )
            .expect_err("peer auth error should fail session");

            assert!(error.contains("auth proof rejected"));
            assert_eq!(
                selection.evidence(),
                TransportEvidence {
                    selected_transport: IROH_TRANSPORT_ID.to_string(),
                    fallback_reason: None,
                    fallback_code: None,
                    attempted_transports: vec![IROH_TRANSPORT_ID.to_string()],
                }
            );
            assert_eq!(connection.sent_count, 1);
        }

        #[test]
        fn iroh_listener_port_is_stable_adjacent_to_tcp_port() {
            assert_eq!(iroh_listener_port(47619).expect("iroh port"), 47620);
        }

        #[test]
        fn iroh_listener_port_rejects_overflow() {
            assert!(iroh_listener_port(u16::MAX).is_err());
        }

        #[test]
        fn mismatched_iroh_device_id_does_not_fall_back_to_tcp() {
            let endpoint_id = SecretKey::generate().public();
            let endpoint_addr = EndpointAddr::new(endpoint_id)
                .with_ip_addr("127.0.0.1:47620".parse().expect("direct addr"));
            let iroh_hint = iroh_endpoint_hints_from_addr(&endpoint_addr, "dev_other")
                .into_iter()
                .next()
                .expect("iroh hint");
            let tcp_hint = format!("{ENDPOINT_SCHEME}127.0.0.1:notaport?device_id=dev_peer&v=1");
            let endpoint_hints = vec![iroh_hint, tcp_hint.clone()];
            let mut selection = select_sync_transport(
                Some(IROH_TRANSPORT_ID),
                None,
                &endpoint_hints,
                "dev_peer",
                true,
            )
            .expect("select iroh");

            let result = connect_iroh_selection_with_fallback(
                &mut selection,
                "dev_peer",
                |_| -> Result<SecurePeerConnection, String> {
                    panic!("mismatched Iroh endpoint should not connect")
                },
            );

            let error = match result {
                Ok(_) => panic!("accepted mismatched iroh endpoint"),
                Err(error) => error,
            };
            assert!(error.contains("device_id"));
            assert_eq!(
                selection.evidence(),
                TransportEvidence {
                    selected_transport: IROH_TRANSPORT_ID.to_string(),
                    fallback_reason: None,
                    fallback_code: None,
                    attempted_transports: vec![IROH_TRANSPORT_ID.to_string()],
                }
            );
            assert_eq!(selection.tcp_fallback_endpoint_hint, Some(tcp_hint));
        }

        #[test]
        fn endpoint_hint_advertisement_orders_iroh_before_tcp() {
            let endpoint_id = SecretKey::generate().public();
            let endpoint_addr = EndpointAddr::new(endpoint_id)
                .with_ip_addr("127.0.0.1:47620".parse().expect("direct addr"));
            let mut hints = iroh_endpoint_hints_from_addr(&endpoint_addr, "dev_one");
            hints.extend(endpoint_hints_for_port(47619, "dev_one"));

            assert!(hints[0].starts_with(IROH_ENDPOINT_SCHEME));
            assert!(hints
                .iter()
                .skip(1)
                .any(|hint| hint.starts_with(ENDPOINT_SCHEME)));
        }

        #[test]
        fn discovery_beacon_payload_contains_advisory_fields_only() {
            let identity = SyncLocalIdentity {
                device_id: "dev_local".to_string(),
                sync_group_id: "syncgrp_one".to_string(),
                display_name: Some("Studio Mac".to_string()),
                public_key: "public_key".to_string(),
            };
            let endpoint_hints = vec![format!(
                "{ENDPOINT_SCHEME}192.0.2.2:47619?device_id=dev_local&v=1"
            )];
            let payload = discovery_beacon_payload(
                &identity,
                &endpoint_hints,
                DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                    .expect("timestamp")
                    .with_timezone(&Utc),
            )
            .expect("beacon payload");
            let value = serde_json::to_value(&payload).expect("serialize beacon");

            assert_eq!(
                value.get("protocol_version").and_then(Value::as_str),
                Some(DISCOVERY_PROTOCOL_VERSION)
            );
            assert_eq!(value.get("endpoint_hints"), Some(&json!(endpoint_hints)));
            assert!(value.get("pairing_secret").is_none());
            assert!(value.get("source_path").is_none());
        }

        #[test]
        fn discovery_broadcast_targets_include_directed_and_limited_broadcasts() {
            let targets = discovery_broadcast_targets_from_ipv4([
                (
                    Ipv4Addr::new(192, 0, 2, 10),
                    Some(Ipv4Addr::new(192, 0, 2, 255)),
                ),
                (
                    Ipv4Addr::new(192, 0, 2, 11),
                    Some(Ipv4Addr::new(192, 0, 2, 255)),
                ),
                (
                    Ipv4Addr::new(198, 51, 100, 20),
                    Some(Ipv4Addr::new(198, 51, 100, 255)),
                ),
                (
                    Ipv4Addr::new(127, 0, 0, 1),
                    Some(Ipv4Addr::new(127, 255, 255, 255)),
                ),
                (
                    Ipv4Addr::new(169, 254, 1, 20),
                    Some(Ipv4Addr::new(169, 254, 255, 255)),
                ),
                (Ipv4Addr::new(203, 0, 113, 7), None),
            ]);

            assert_eq!(
                targets,
                vec![
                    SocketAddr::from((Ipv4Addr::new(192, 0, 2, 255), DISCOVERY_PORT)),
                    SocketAddr::from((Ipv4Addr::new(198, 51, 100, 255), DISCOVERY_PORT)),
                    SocketAddr::from((Ipv4Addr::BROADCAST, DISCOVERY_PORT)),
                ]
            );
        }

        #[test]
        fn discovery_beacon_parser_ignores_self_and_expires_peers() {
            let payload = DiscoveryBeaconPayload {
                protocol_version: DISCOVERY_PROTOCOL_VERSION.to_string(),
                device_id: "dev_peer".to_string(),
                sync_group_id: "syncgrp_one".to_string(),
                display_name: Some("Peer Phone".to_string()),
                public_key: "peer_public".to_string(),
                endpoint_hints: vec![format!(
                    "{ENDPOINT_SCHEME}192.0.2.3:47619?device_id=dev_peer&v=1"
                )],
                timestamp: "2026-01-01T00:00:00Z".to_string(),
            };
            let bytes = serde_json::to_vec(&payload).expect("encode beacon");
            let observed_at = DateTime::parse_from_rfc3339("2026-01-01T00:00:02Z")
                .expect("timestamp")
                .with_timezone(&Utc);
            let now = Instant::now();
            let entry =
                parse_discovery_beacon(&bytes, "dev_local", observed_at, now + DISCOVERY_PEER_TTL)
                    .expect("parse beacon")
                    .expect("peer entry");

            assert_eq!(entry.peer.device_id, "dev_peer");
            assert_eq!(entry.peer.observed_at, "2026-01-01T00:00:02+00:00");
            assert!(parse_discovery_beacon(
                &bytes,
                "dev_peer",
                observed_at,
                now + DISCOVERY_PEER_TTL
            )
            .expect("ignore self")
            .is_none());

            let mut status = SharedStatus::default();
            status
                .nearby_peers
                .insert(entry.peer.device_id.clone(), entry);
            assert_eq!(
                nearby_peers_from_status(status.nearby_peers.clone()).len(),
                1
            );
            prune_nearby_peers(
                &mut status,
                now + DISCOVERY_PEER_TTL + Duration::from_secs(1),
            );
            assert!(status.nearby_peers.is_empty());
        }

        #[test]
        fn passive_lifecycle_event_records_without_retry_or_abort() {
            let cancel = RunCancellationToken::default();
            let mut status = SharedStatus::default();
            status.active_runs.insert(
                "sync_passive".to_string(),
                ActiveSyncRun {
                    peer_device_id: Some("dev_peer".to_string()),
                    cancel: cancel.clone(),
                    connection: None,
                },
            );

            let outcome = record_lifecycle_event_in_status(
                &mut status,
                SyncTransportLifecycleEventRequest {
                    kind: "blur".to_string(),
                    occurred_at: Some("2026-01-01T00:00:00Z".to_string()),
                    message: Some("window blurred".to_string()),
                },
            );

            assert!(outcome.interrupted_runs.is_empty());
            assert!(!cancel.is_cancelled());
            assert_eq!(status.lifecycle_events.len(), 1);
            assert_eq!(status.lifecycle_events[0].kind, "blur");
            assert!(!status.lifecycle_events[0].retryable);
            assert_eq!(
                status.lifecycle_events[0].message.as_deref(),
                Some("window blurred")
            );
            assert!(status.retryable_interruption_code.is_none());
        }

        #[test]
        fn retryable_lifecycle_event_sets_interruption_evidence() {
            let cancel = RunCancellationToken::default();
            let mut status = SharedStatus::default();
            status.active_runs.insert(
                "sync_retry".to_string(),
                ActiveSyncRun {
                    peer_device_id: Some("dev_peer".to_string()),
                    cancel: cancel.clone(),
                    connection: None,
                },
            );

            let outcome = record_lifecycle_event_in_status(
                &mut status,
                SyncTransportLifecycleEventRequest {
                    kind: "network_offline".to_string(),
                    occurred_at: Some("2026-01-01T00:00:01Z".to_string()),
                    message: Some("lost tuneforge-sync+tcp://192.0.2.2:47619 endpoint".to_string()),
                },
            );
            interrupt_active_runs_for_lifecycle(&outcome.event, outcome.interrupted_runs);

            assert_eq!(
                status.retryable_interruption_code.as_deref(),
                Some("lifecycle_interrupted_network_offline")
            );
            assert_eq!(
                status.retryable_interruption_peer_device_id.as_deref(),
                Some("dev_peer")
            );
            assert_eq!(
                status.retry_guidance.as_deref(),
                Some(LIFECYCLE_INTERRUPTION_NETWORK_GUIDANCE)
            );
            let event = status.last_lifecycle_event.expect("last lifecycle event");
            assert!(event.retryable);
            assert_eq!(event.run_id.as_deref(), Some("sync_retry"));
            assert_eq!(event.peer_device_id.as_deref(), Some("dev_peer"));
            assert!(event.message.is_none());

            let interruption = cancel.interruption().expect("run interrupted");
            assert_eq!(interruption.code, "lifecycle_interrupted_network_offline");
            assert_eq!(interruption.event.run_id.as_deref(), Some("sync_retry"));
            assert_eq!(
                interruption.event.peer_device_id.as_deref(),
                Some("dev_peer")
            );
        }

        #[test]
        fn retryable_lifecycle_event_cancels_pending_remote_apply_before_drain() {
            let (sender, receiver) =
                mpsc::sync_channel::<BackendWriteTask>(IROH_ARTIFACT_STAGING_QUEUE_CAPACITY);
            let (event_sender, event_receiver) = mpsc::channel::<BackendWriteEvent>();
            let (observed_cancel_sender, observed_cancel_receiver) = mpsc::channel::<bool>();
            let queued_project_ids = Arc::new(Mutex::new(Vec::new()));
            let enqueue_failures = Arc::new(Mutex::new(Vec::new()));
            let apply_cancelled = Arc::new(AtomicBool::new(false));
            let run_cancel = RunCancellationToken::default();
            let worker_run_cancel = run_cancel.clone();
            let handle = thread::spawn(move || {
                while let Ok(task) = receiver.recv() {
                    let BackendWriteTask::Apply { project_id, .. } = task else {
                        continue;
                    };
                    let wait_started = Instant::now();
                    while !worker_run_cancel.is_cancelled()
                        && wait_started.elapsed() < Duration::from_secs(2)
                    {
                        thread::sleep(Duration::from_millis(1));
                    }
                    let cancelled = worker_run_cancel.is_cancelled();
                    let _ = observed_cancel_sender.send(cancelled);
                    let message = if cancelled {
                        "Remote sync import skipped after lifecycle interruption."
                    } else {
                        "Remote sync import worker drained without lifecycle cancellation."
                    };
                    let _ = event_sender.send(BackendWriteEvent::Apply {
                        project_ids: vec![project_id.clone()],
                        results: vec![failed_project_result(&project_id, message)],
                        timings: Vec::new(),
                    });
                }
            });
            let mut apply_worker = RemoteApplyWorker {
                sender: Some(sender),
                event_receiver,
                handle: Some(handle),
                queued_project_ids,
                completed_project_ids: HashSet::new(),
                enqueue_failures,
                apply_cancelled,
                project_results: Vec::new(),
                pending_stage_jobs: 0,
                pending_stage_bytes: 0,
                staging_peak_bytes: 0,
            };
            apply_worker.enqueue_tombstone("proj_lifecycle_abort".to_string());
            let mut status = SharedStatus::default();
            status.active_runs.insert(
                "sync_lifecycle_abort".to_string(),
                ActiveSyncRun {
                    peer_device_id: Some("dev_peer".to_string()),
                    cancel: run_cancel,
                    connection: None,
                },
            );

            let outcome = record_lifecycle_event_in_status(
                &mut status,
                SyncTransportLifecycleEventRequest {
                    kind: "sleep".to_string(),
                    occurred_at: None,
                    message: None,
                },
            );
            interrupt_active_runs_for_lifecycle(&outcome.event, outcome.interrupted_runs);
            let results = apply_worker.finish(&mut Vec::new());

            assert!(
                observed_cancel_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("worker observed lifecycle cancellation"),
                "lifecycle abort must cancel pending reconciliation apply before draining worker"
            );
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].status, "failed");
            assert!(results[0]
                .message
                .as_deref()
                .unwrap_or("")
                .contains("lifecycle interruption"));
        }

        #[test]
        fn recovery_lifecycle_event_clears_nearby_peers_and_requests_refresh() {
            let mut status = SharedStatus {
                retryable_interruption_code: Some(
                    "lifecycle_interrupted_network_offline".to_string(),
                ),
                retryable_interruption_peer_device_id: Some("dev_peer".to_string()),
                retry_guidance: Some(LIFECYCLE_INTERRUPTION_NETWORK_GUIDANCE.to_string()),
                ..SharedStatus::default()
            };
            status.nearby_peers.insert(
                "dev_stale".to_string(),
                DiscoveryPeerEntry {
                    peer: SyncTransportNearbyPeer {
                        device_id: "dev_stale".to_string(),
                        sync_group_id: "syncgrp_one".to_string(),
                        display_name: None,
                        public_key: "peer_public".to_string(),
                        endpoint_hints: Vec::new(),
                        protocol_version: DISCOVERY_PROTOCOL_VERSION.to_string(),
                        timestamp: "2026-01-01T00:00:00Z".to_string(),
                        observed_at: "2026-01-01T00:00:00Z".to_string(),
                        expires_at: "2026-01-01T00:01:00Z".to_string(),
                    },
                    expires_at_instant: Instant::now() + DISCOVERY_PEER_TTL,
                },
            );

            let outcome = record_lifecycle_event_in_status(
                &mut status,
                SyncTransportLifecycleEventRequest {
                    kind: "network_online".to_string(),
                    occurred_at: None,
                    message: None,
                },
            );

            assert!(outcome.refresh_endpoint_hints);
            assert!(outcome.interrupted_runs.is_empty());
            assert!(status.nearby_peers.is_empty());
            assert_eq!(
                status
                    .last_lifecycle_event
                    .as_ref()
                    .map(|event| event.kind.as_str()),
                Some("network_online")
            );
            assert!(status.retryable_interruption_code.is_none());
            assert!(status.retryable_interruption_peer_device_id.is_none());
            assert!(status.retry_guidance.is_none());
        }

        #[test]
        fn sync_now_request_missing_preferred_transport_selects_tcp_default() {
            let request: SyncTransportSyncNowRequest = serde_json::from_value(json!({
                "peerDeviceId": "dev_peer"
            }))
            .expect("deserialize sync now request");
            let endpoint_hints = vec![format!(
                "{ENDPOINT_SCHEME}127.0.0.1:47619?device_id=dev_peer&v=1"
            )];

            let default_selection = select_sync_transport(
                request
                    .preferred_transport
                    .as_deref()
                    .and_then(normalized_transport_id),
                request.endpoint_hint.as_deref(),
                &endpoint_hints,
                &request.peer_device_id,
                false,
            )
            .expect("select default transport");
            let explicit_tcp_selection = select_sync_transport(
                Some(TCP_TRANSPORT_ID),
                request.endpoint_hint.as_deref(),
                &endpoint_hints,
                &request.peer_device_id,
                false,
            )
            .expect("select explicit TCP transport");

            assert_eq!(request.preferred_transport, None);
            assert_eq!(
                default_selection.endpoint_hint(),
                Some(endpoint_hints[0].as_str())
            );
            assert_eq!(
                default_selection.evidence(),
                TransportEvidence {
                    selected_transport: TCP_TRANSPORT_ID.to_string(),
                    fallback_reason: Some(format!(
                        "Iroh sync transport is not available locally; using {TCP_TRANSPORT_ID}."
                    )),
                    fallback_code: Some("iroh_unavailable".to_string()),
                    attempted_transports: vec![
                        IROH_TRANSPORT_ID.to_string(),
                        TCP_TRANSPORT_ID.to_string()
                    ],
                }
            );
            assert_eq!(
                explicit_tcp_selection.evidence(),
                TransportEvidence {
                    selected_transport: TCP_TRANSPORT_ID.to_string(),
                    fallback_reason: None,
                    fallback_code: None,
                    attempted_transports: vec![TCP_TRANSPORT_ID.to_string()],
                }
            );
        }

        #[test]
        fn auto_transport_prefers_iroh_when_local_endpoint_and_peer_hint_exist() {
            let request: SyncTransportSyncNowRequest = serde_json::from_value(json!({
                "peerDeviceId": "dev_peer",
                "preferredTransport": "auto"
            }))
            .expect("deserialize sync now request");
            let endpoint_hints = vec![
                format!("{ENDPOINT_SCHEME}127.0.0.1:47619?device_id=dev_peer&v=1"),
                format!(
                    "{IROH_ENDPOINT_SCHEME}iroh_peer?device_id=dev_peer&v=1&addr=127.0.0.1%3A47620"
                ),
            ];

            let selection = select_sync_transport(
                request
                    .preferred_transport
                    .as_deref()
                    .and_then(normalized_transport_id),
                request.endpoint_hint.as_deref(),
                &endpoint_hints,
                &request.peer_device_id,
                true,
            )
            .expect("select iroh");

            assert_eq!(request.preferred_transport.as_deref(), Some("auto"));
            assert_eq!(
                selection.evidence(),
                TransportEvidence {
                    selected_transport: IROH_TRANSPORT_ID.to_string(),
                    fallback_reason: None,
                    fallback_code: None,
                    attempted_transports: vec![IROH_TRANSPORT_ID.to_string()],
                }
            );
            assert_eq!(
                selection.tcp_fallback_endpoint_hint,
                Some(endpoint_hints[0].clone())
            );
        }

        #[test]
        fn sync_now_request_uses_discovered_tcp_hint_for_iroh_fallback() {
            let discovered_iroh_hint = format!(
                "{IROH_ENDPOINT_SCHEME}iroh_peer?device_id=dev_peer&v=1&addr=127.0.0.1%3A47620"
            );
            let discovered_tcp_hint =
                format!("{ENDPOINT_SCHEME}127.0.0.1:47619?device_id=dev_peer&v=1");
            let stored_stale_iroh_hint = format!(
                "{IROH_ENDPOINT_SCHEME}old_peer?device_id=dev_peer&v=1&addr=127.0.0.1%3A47621"
            );
            let request: SyncTransportSyncNowRequest = serde_json::from_value(json!({
                "peerDeviceId": "dev_peer",
                "endpointHint": discovered_iroh_hint.clone(),
                "endpointHints": [
                    discovered_iroh_hint.clone(),
                    discovered_tcp_hint.clone()
                ],
                "preferredTransport": "auto"
            }))
            .expect("deserialize sync now request");
            let selection_endpoint_hints = sync_now_selection_endpoint_hints(
                request.endpoint_hint.as_deref(),
                request.endpoint_hints.as_deref(),
                &[stored_stale_iroh_hint.clone()],
            );

            assert_eq!(
                selection_endpoint_hints,
                vec![
                    discovered_iroh_hint.clone(),
                    discovered_tcp_hint.clone(),
                    stored_stale_iroh_hint
                ]
            );

            let mut selection = select_sync_transport(
                request
                    .preferred_transport
                    .as_deref()
                    .and_then(normalized_transport_id),
                None,
                &selection_endpoint_hints,
                &request.peer_device_id,
                true,
            )
            .expect("select discovered iroh");

            assert_eq!(
                selection.endpoint_hint(),
                Some(discovered_iroh_hint.as_str())
            );
            assert_eq!(
                selection.tcp_fallback_endpoint_hint.as_deref(),
                Some(discovered_tcp_hint.as_str())
            );
            selection
                .record_iroh_connect_fallback(format!(
                    "Iroh sync transport was unavailable (connect failed); using {TCP_TRANSPORT_ID}."
                ))
                .expect("record discovered tcp fallback");
            assert_eq!(
                selection.endpoint_hint(),
                Some(discovered_tcp_hint.as_str())
            );
            assert_eq!(
                selection.evidence().fallback_code.as_deref(),
                Some("iroh_connect_failed")
            );
        }

        #[test]
        fn preferred_iroh_falls_back_to_tcp_when_local_endpoint_is_unavailable() {
            let endpoint_hints = vec![
                format!(
                    "{IROH_ENDPOINT_SCHEME}iroh_peer?device_id=dev_peer&v=1&addr=127.0.0.1%3A47620"
                ),
                format!("{ENDPOINT_SCHEME}127.0.0.1:47619?device_id=dev_peer&v=1"),
            ];

            let selection = select_sync_transport(
                Some(IROH_TRANSPORT_ID),
                None,
                &endpoint_hints,
                "dev_peer",
                false,
            )
            .expect("select tcp fallback");

            assert_eq!(
                selection.evidence(),
                TransportEvidence {
                    selected_transport: TCP_TRANSPORT_ID.to_string(),
                    fallback_reason: Some(format!(
                        "Preferred sync transport {IROH_TRANSPORT_ID} is not available locally; using {TCP_TRANSPORT_ID}."
                    )),
                    fallback_code: Some("iroh_unavailable".to_string()),
                    attempted_transports: vec![
                        IROH_TRANSPORT_ID.to_string(),
                        TCP_TRANSPORT_ID.to_string()
                    ],
                }
            );
        }

        #[test]
        fn missing_iroh_hint_records_fallback_code() {
            let endpoint_hints = vec![format!(
                "{ENDPOINT_SCHEME}127.0.0.1:47619?device_id=dev_peer&v=1"
            )];

            let selection = select_sync_transport(None, None, &endpoint_hints, "dev_peer", true)
                .expect("select tcp fallback");

            assert_eq!(
                selection.evidence().fallback_code.as_deref(),
                Some("missing_iroh_hint")
            );
        }

        #[test]
        fn iroh_connect_failure_can_be_marked_as_stale_hint_after_auth() {
            let endpoint_hints = vec![
                format!(
                    "{IROH_ENDPOINT_SCHEME}old_peer?device_id=dev_peer&v=1&addr=127.0.0.1%3A47620"
                ),
                format!("{ENDPOINT_SCHEME}127.0.0.1:47619?device_id=dev_peer&v=1"),
            ];
            let authenticated_hints = vec![format!(
                "{IROH_ENDPOINT_SCHEME}new_peer?device_id=dev_peer&v=1&addr=127.0.0.1%3A47620"
            )];
            let mut selection =
                select_sync_transport(None, None, &endpoint_hints, "dev_peer", true)
                    .expect("select iroh");

            selection
                .record_iroh_connect_fallback(format!(
                    "Iroh sync transport was unavailable (connect failed); using {TCP_TRANSPORT_ID}."
                ))
                .expect("record fallback");
            assert_eq!(
                selection.evidence().fallback_code.as_deref(),
                Some("iroh_connect_failed")
            );
            if authenticated_hints_make_trusted_iroh_hint_stale(
                &endpoint_hints,
                &authenticated_hints,
            ) {
                selection.mark_stale_iroh_hint();
            }

            assert_eq!(
                selection.evidence().fallback_code.as_deref(),
                Some("stale_iroh_hint")
            );
            let expected_reason = format!(
                "Iroh sync transport was unavailable (connect failed); using {TCP_TRANSPORT_ID}."
            );
            assert_eq!(
                selection.evidence().fallback_reason.as_deref(),
                Some(expected_reason.as_str())
            );
        }

        #[test]
        fn only_availability_hint_and_connect_paths_record_tcp_fallback() {
            let iroh_hint = format!(
                "{IROH_ENDPOINT_SCHEME}iroh_peer?device_id=dev_peer&v=1&addr=127.0.0.1%3A47620"
            );
            let tcp_hint = format!("{ENDPOINT_SCHEME}127.0.0.1:47619?device_id=dev_peer&v=1");
            let endpoint_hints = vec![iroh_hint.clone(), tcp_hint.clone()];

            let unavailable = select_sync_transport(
                Some(IROH_TRANSPORT_ID),
                None,
                &endpoint_hints,
                "dev_peer",
                false,
            )
            .expect("local Iroh unavailable falls back");
            assert_eq!(
                unavailable.evidence().fallback_code.as_deref(),
                Some("iroh_unavailable")
            );

            let missing_hint = select_sync_transport(
                Some(IROH_TRANSPORT_ID),
                None,
                std::slice::from_ref(&tcp_hint),
                "dev_peer",
                true,
            )
            .expect("missing Iroh hint falls back");
            assert_eq!(
                missing_hint.evidence().fallback_code.as_deref(),
                Some("missing_iroh_hint")
            );

            let mut connect_failed =
                select_sync_transport(None, None, &endpoint_hints, "dev_peer", true)
                    .expect("select Iroh with TCP fallback hint");
            connect_failed
                .record_iroh_connect_fallback(format!(
                    "Iroh sync transport was unavailable (connect failed); using {TCP_TRANSPORT_ID}."
                ))
                .expect("connect failure can fall back");
            assert_eq!(
                connect_failed.evidence().fallback_code.as_deref(),
                Some("iroh_connect_failed")
            );

            let auth_error =
                phase_context_error("peer authentication", "auth proof rejected".to_string());
            let manifest_error =
                phase_context_error("manifest exchange", "manifest rejected".to_string());
            let hash_error =
                "Received sync artifact bytes failed SHA-256 or size verification.".to_string();
            let staging_error = phase_context_error(
                "reconciliation staging",
                "Could not stage received sync artifact.".to_string(),
            );
            for non_fallback_error in [auth_error, manifest_error, hash_error, staging_error] {
                assert!(!non_fallback_error.is_empty());
            }
            let post_connect =
                select_sync_transport(None, None, &[iroh_hint, tcp_hint], "dev_peer", true)
                    .expect("select post-connect Iroh");
            assert_eq!(
                post_connect.evidence(),
                TransportEvidence {
                    selected_transport: IROH_TRANSPORT_ID.to_string(),
                    fallback_reason: None,
                    fallback_code: None,
                    attempted_transports: vec![IROH_TRANSPORT_ID.to_string()],
                }
            );
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn connected_iroh_manifest_exchange_failure_does_not_attempt_tcp_fallback() {
            let selection = test_iroh_selection_with_tcp_hint();
            let (connection, client_endpoint, peer_thread) =
                spawn_test_iroh_sync_peer(move |mut peer, _iroh_data| {
                    let local_offer = read_message_accepting_status(
                        "manifest exchange",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    match local_offer {
                        ProtocolMessage::ManifestOffer(_) => {}
                        other => {
                            return Err(format!("expected manifest offer, got {}", other.kind()));
                        }
                    }
                    peer.send_message(&ProtocolMessage::Error(ProtocolError {
                        code: "manifest_failed".to_string(),
                        message: "remote manifest invalid".to_string(),
                    }))?;
                    thread::sleep(Duration::from_millis(250));
                    Ok(())
                });
            let progress = test_progress("sync_iroh_manifest_failure_test", &connection);

            connection
                .send_message_for_phase(
                    "manifest exchange",
                    &ProtocolMessage::ManifestOffer(ManifestOffer {
                        metadata: json!({ "projects": [] }),
                        project_manifests: Vec::new(),
                        manifest_errors: Vec::new(),
                    }),
                )
                .expect("send local manifest offer");
            let error = match connection
                .read_message_accepting_status_for_phase("manifest exchange", &progress)
            {
                Ok(ProtocolMessage::Error(error)) => phase_context_error(
                    "manifest exchange",
                    format!("Sync peer returned an error: {}", error.message),
                ),
                Ok(other) => format!(
                    "Sync peer sent unexpected message during manifest exchange: {}",
                    other.kind()
                ),
                Err(error) => error,
            };
            close_test_iroh_endpoint(&client_endpoint);
            peer_thread
                .join()
                .expect("join manifest failure peer")
                .expect("manifest failure peer completed");

            assert!(
                error.contains("remote manifest invalid"),
                "unexpected manifest failure error: {error}"
            );
            assert_iroh_selection_has_no_tcp_fallback(&selection);
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn connected_iroh_peer_trust_failure_does_not_attempt_tcp_fallback() {
            let selection = test_iroh_selection_with_tcp_hint();
            let (connection, client_endpoint, peer_thread) =
                spawn_test_iroh_sync_peer(move |mut peer, _iroh_data| {
                    let challenge = peer.read_message()?;
                    match challenge {
                        ProtocolMessage::AuthChallenge { .. } => {}
                        other => {
                            return Err(format!("expected auth challenge, got {}", other.kind()));
                        }
                    }
                    peer.send_message(&ProtocolMessage::AuthChallenge {
                        protocol_version: TRANSPORT_PROTOCOL_VERSION.to_string(),
                        device_id: "dev_peer".to_string(),
                        session_nonce: "peer_nonce".to_string(),
                    })?;
                    thread::sleep(Duration::from_millis(250));
                    Ok(())
                });

            let error = connection
                .with_connection(|connection| {
                    authenticate_session(
                        connection,
                        &UntrustedPeerAuthBackend,
                        Some("dev_peer".to_string()),
                        &[],
                    )
                })
                .expect_err("untrusted connected Iroh peer should fail auth");
            close_test_iroh_endpoint(&client_endpoint);
            peer_thread
                .join()
                .expect("join untrusted peer")
                .expect("untrusted peer completed");

            assert!(error.contains("not trusted"));
            assert_iroh_selection_has_no_tcp_fallback(&selection);
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn connected_iroh_hash_verification_failure_does_not_attempt_tcp_fallback() {
            let selection = test_iroh_selection_with_tcp_hint();
            let payload = b"hash checked streamed payload".to_vec();
            let mut corrupt_payload = payload.clone();
            corrupt_payload[0] ^= 0xff;
            let artifact = RemoteArtifact {
                artifact_id: "art_hash_fail".to_string(),
                project_id: "proj_hash_fail".to_string(),
                content_sha256: test_sha256(&payload),
                size_bytes: payload.len() as u64,
            };
            let backend = TestBackendServer::start_with_staged_artifacts(HashMap::new());

            let (received_artifacts, project_results, requests, temp_files) =
                run_connected_iroh_stage_artifact(
                    &backend,
                    artifact,
                    corrupt_payload,
                    "sync_iroh_hash_failure_test",
                );

            let counts = transfer_counts(&received_artifacts);
            assert_eq!(counts.received, 0);
            assert_eq!(counts.failed, 1);
            assert_eq!(project_results.len(), 1);
            assert_eq!(project_results[0].status, "failed");
            assert_eq!(
                requests
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/artifacts/staging")
                    .count(),
                0,
                "hash failure must not stage corrupt bytes: {requests:?}"
            );
            assert!(
                temp_files.is_empty(),
                "hash failure left transport temp files: {temp_files:?}"
            );
            assert_iroh_selection_has_no_tcp_fallback(&selection);
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn iroh_zero_byte_unavailable_stream_fails_without_staging_and_continues() {
            let empty_bytes = Vec::new();
            let good_bytes = b"good streamed payload".to_vec();
            let unavailable_artifact = RemoteArtifact {
                artifact_id: "art_zero_unavailable".to_string(),
                project_id: "proj_zero_unavailable".to_string(),
                content_sha256: test_sha256(&empty_bytes),
                size_bytes: 0,
            };
            let good_artifact = RemoteArtifact {
                artifact_id: "art_good_after_zero".to_string(),
                project_id: "proj_zero_unavailable".to_string(),
                content_sha256: test_sha256(&good_bytes),
                size_bytes: good_bytes.len() as u64,
            };
            let backend = TestBackendServer::start_with_staged_artifacts(HashMap::new());
            let peer_unavailable = unavailable_artifact.clone();
            let peer_good = good_artifact.clone();
            let peer_good_bytes = good_bytes.clone();
            let (connection, client_endpoint, peer_thread) =
                spawn_test_iroh_sync_peer(move |mut peer, iroh_data| {
                    let request = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    let ProtocolMessage::ArtifactBatchRequest(request) = request else {
                        return Err("expected Iroh artifact batch request".to_string());
                    };
                    if request.artifacts.len() != 2 {
                        return Err(format!(
                            "expected 2 artifact requests, got {}",
                            request.artifacts.len()
                        ));
                    }
                    let batch_token = request
                        .batch_token
                        .ok_or_else(|| "expected Iroh batch token".to_string())?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchStart {
                        batch_token: batch_token.clone(),
                        artifact_count: 2,
                    })?;
                    let mut sent = HashSet::new();
                    while sent.len() < 2 {
                        let credit = read_message_accepting_status(
                            "artifact request/transfer",
                            || peer.read_message(),
                            |_| {},
                        )?;
                        let ProtocolMessage::ArtifactBatchCredit {
                            batch_token: peer_batch_token,
                            artifact_ids,
                        } = credit
                        else {
                            return Err(format!(
                                "expected Iroh batch credit, got {}",
                                credit.kind()
                            ));
                        };
                        if peer_batch_token != batch_token {
                            return Err("Iroh batch credit token mismatch".to_string());
                        }
                        for artifact_id in artifact_ids {
                            if !sent.insert(artifact_id.clone()) {
                                return Err(format!(
                                    "duplicate Iroh batch credit for {artifact_id}"
                                ));
                            }
                            if artifact_id == peer_unavailable.artifact_id {
                                send_test_iroh_unavailable_artifact_stream(
                                    &iroh_data,
                                    &batch_token,
                                    &peer_unavailable,
                                )?;
                            } else if artifact_id == peer_good.artifact_id {
                                send_test_iroh_artifact_stream(
                                    &iroh_data,
                                    &batch_token,
                                    &peer_good,
                                    &peer_good_bytes,
                                )?;
                            } else {
                                return Err(format!(
                                    "unexpected Iroh batch credit for {artifact_id}"
                                ));
                            }
                        }
                    }
                    peer.send_message(&ProtocolMessage::ArtifactBatchEnd { batch_token })?;
                    thread::sleep(Duration::from_millis(250));
                    Ok(())
                });
            let client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };
            let progress = test_progress("sync_iroh_zero_unavailable_test", &connection);
            let mut apply_worker = RemoteApplyWorker::start(
                &client,
                "dev_peer",
                &json!({ "projects": [{ "project_id": unavailable_artifact.project_id.clone() }] }),
                IROH_TRANSPORT_ID,
                progress.clone(),
            );
            let mut metrics = SyncRunMetrics::start(Instant::now());
            let mut timings = Vec::new();
            let mut received_artifacts = Vec::new();
            let planned = PlannedRemoteProject {
                project_id: unavailable_artifact.project_id.clone(),
                manifest: Some(json!({
                    "project": { "project_id": unavailable_artifact.project_id.clone() },
                    "artifacts": [
                        {
                            "artifact_id": unavailable_artifact.artifact_id.clone(),
                            "project_id": unavailable_artifact.project_id.clone(),
                            "content_sha256": unavailable_artifact.content_sha256.clone(),
                            "size_bytes": unavailable_artifact.size_bytes,
                        },
                        {
                            "artifact_id": good_artifact.artifact_id.clone(),
                            "project_id": good_artifact.project_id.clone(),
                            "content_sha256": good_artifact.content_sha256.clone(),
                            "size_bytes": good_artifact.size_bytes,
                        }
                    ]
                })),
                plan: json!({
                    "actions": [
                        {
                            "action_type": "fetch_artifact_content",
                            "provider_device_id": "dev_peer",
                            "item_id": unavailable_artifact.artifact_id.clone(),
                            "project_id": unavailable_artifact.project_id.clone(),
                            "content_sha256": unavailable_artifact.content_sha256.clone()
                        },
                        {
                            "action_type": "fetch_artifact_content",
                            "provider_device_id": "dev_peer",
                            "item_id": good_artifact.artifact_id.clone(),
                            "project_id": good_artifact.project_id.clone(),
                            "content_sha256": good_artifact.content_sha256.clone()
                        }
                    ]
                }),
            };

            stage_remote_manifest_iroh_artifacts(
                &client,
                &connection,
                connection
                    .iroh_data_connection()
                    .expect("test Iroh data connection"),
                "dev_peer",
                vec![planned],
                &mut apply_worker,
                &mut received_artifacts,
                &mut metrics,
                &mut timings,
                &progress,
            );
            let project_results = apply_worker.finish(&mut timings);
            let requests = backend.requests();
            let temp_files = collect_test_files(&backend.transport_temp_root());
            close_test_iroh_endpoint(&client_endpoint);
            peer_thread
                .join()
                .expect("join Iroh zero unavailable peer")
                .expect("Iroh zero unavailable peer completed");

            let counts = transfer_counts(&received_artifacts);
            assert_eq!(counts.received, 1);
            assert_eq!(counts.failed, 1);
            let unavailable_result = received_artifacts
                .iter()
                .find(|result| result.artifact_id == unavailable_artifact.artifact_id)
                .expect("zero unavailable transfer result");
            assert_eq!(unavailable_result.status, "failed");
            assert!(unavailable_result
                .message
                .as_deref()
                .is_some_and(|message| message.contains(UNAVAILABLE_ARTIFACT_TRANSFER_MESSAGE)));
            let good_result = received_artifacts
                .iter()
                .find(|result| result.artifact_id == good_artifact.artifact_id)
                .expect("good transfer result");
            assert_eq!(good_result.status, "received");
            assert_eq!(
                requests
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/artifacts/staging")
                    .count(),
                1,
                "zero unavailable artifact must not be staged: {requests:?}"
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/reconciliation/apply")
                    .count(),
                0,
                "failed zero-byte artifact must prevent project apply: {requests:?}"
            );
            assert!(
                temp_files.is_empty(),
                "zero unavailable transfer left temp files: {temp_files:?}"
            );
            assert_eq!(project_results.len(), 1);
            assert_eq!(project_results[0].status, "failed");
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn connected_iroh_staging_post_failure_does_not_attempt_tcp_fallback() {
            let selection = test_iroh_selection_with_tcp_hint();
            let payload = b"staging failure streamed payload".to_vec();
            let artifact = RemoteArtifact {
                artifact_id: "art_staging_fail".to_string(),
                project_id: "proj_staging_fail".to_string(),
                content_sha256: test_sha256(&payload),
                size_bytes: payload.len() as u64,
            };
            let backend = TestBackendServer::start_with_staging_failure("staging unavailable");

            let (received_artifacts, project_results, requests, temp_files) =
                run_connected_iroh_stage_artifact(
                    &backend,
                    artifact,
                    payload,
                    "sync_iroh_staging_failure_test",
                );

            let counts = transfer_counts(&received_artifacts);
            assert_eq!(counts.received, 0);
            assert_eq!(counts.failed, 1);
            assert_eq!(project_results.len(), 1);
            assert_eq!(project_results[0].status, "failed");
            assert_eq!(
                requests
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/artifacts/staging")
                    .count(),
                1,
                "staging failure should attempt Iroh staging once: {requests:?}"
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/reconciliation/apply")
                    .count(),
                0,
                "staging failure must not apply import: {requests:?}"
            );
            assert!(
                temp_files.is_empty(),
                "staging failure left transport temp files: {temp_files:?}"
            );
            assert_iroh_selection_has_no_tcp_fallback(&selection);
        }

        #[test]
        fn transport_handshake_challenge_binds_nonces_and_noise_hash() {
            let challenge = transport_handshake_challenge(
                "dev_requester",
                "dev_responder",
                "local",
                "remote",
                "noise_hash",
            );

            assert_eq!(
                challenge.get("requester_device_id").and_then(Value::as_str),
                Some("dev_requester")
            );
            assert_eq!(
                challenge.get("responder_device_id").and_then(Value::as_str),
                Some("dev_responder")
            );
            assert_eq!(
                challenge.get("session_id").and_then(Value::as_str),
                Some("local")
            );
            assert_eq!(
                challenge.get("challenge_nonce").and_then(Value::as_str),
                Some("remote.noise_hash")
            );
        }

        struct RecordingPeerStream {
            read_timeout: Duration,
        }

        impl PeerStream for RecordingPeerStream {
            fn read_exact(&mut self, _buffer: &mut [u8]) -> io::Result<()> {
                Ok(())
            }

            fn write_all(&mut self, _buffer: &[u8]) -> io::Result<()> {
                Ok(())
            }

            fn set_read_timeout(&mut self, timeout: Duration) -> io::Result<()> {
                self.read_timeout = timeout;
                Ok(())
            }
        }

        struct ScriptedProtocolConnection {
            incoming: VecDeque<ProtocolMessage>,
            sent_count: usize,
        }

        impl ScriptedProtocolConnection {
            fn new(incoming: Vec<ProtocolMessage>) -> Self {
                Self {
                    incoming: incoming.into(),
                    sent_count: 0,
                }
            }
        }

        impl ProtocolConnection for ScriptedProtocolConnection {
            fn send_message(&mut self, _message: &ProtocolMessage) -> Result<(), String> {
                self.sent_count = self.sent_count.saturating_add(1);
                Ok(())
            }

            fn read_message(&mut self) -> Result<ProtocolMessage, String> {
                self.incoming
                    .pop_front()
                    .ok_or_else(|| "missing scripted protocol message".to_string())
            }

            fn handshake_hash(&self) -> &str {
                "test_handshake_hash"
            }
        }

        struct TestAuthBackend;

        impl SyncTransportAuthBackend for TestAuthBackend {
            fn local_identity(&self) -> Result<SyncLocalIdentity, String> {
                Ok(SyncLocalIdentity {
                    device_id: "dev_local".to_string(),
                    sync_group_id: "syncgrp_test".to_string(),
                    display_name: None,
                    public_key: "local_public_key".to_string(),
                })
            }

            fn trusted_peer(&self, _device_id: &str) -> Result<Option<SyncTrustedPeer>, String> {
                panic!("auth error test should stop before trusted peer lookup")
            }

            fn sign_transport_handshake(
                &self,
                _peer_device_id: &str,
                _challenge: &Value,
            ) -> Result<Value, String> {
                panic!("auth error test should stop before signing")
            }
        }

        struct UntrustedPeerAuthBackend;

        impl SyncTransportAuthBackend for UntrustedPeerAuthBackend {
            fn local_identity(&self) -> Result<SyncLocalIdentity, String> {
                Ok(SyncLocalIdentity {
                    device_id: "dev_local".to_string(),
                    sync_group_id: "syncgrp_test".to_string(),
                    display_name: None,
                    public_key: "local_public_key".to_string(),
                })
            }

            fn trusted_peer(&self, _device_id: &str) -> Result<Option<SyncTrustedPeer>, String> {
                Ok(None)
            }

            fn sign_transport_handshake(
                &self,
                _peer_device_id: &str,
                _challenge: &Value,
            ) -> Result<Value, String> {
                panic!("untrusted peer should stop before signing")
            }
        }

        fn test_iroh_selection_with_tcp_hint() -> TransportSelection {
            let endpoint_hints = vec![
                format!(
                    "{IROH_ENDPOINT_SCHEME}iroh_peer?device_id=dev_peer&v=1&addr=127.0.0.1%3A47620"
                ),
                format!("{ENDPOINT_SCHEME}127.0.0.1:47619?device_id=dev_peer&v=1"),
            ];
            select_sync_transport(None, None, &endpoint_hints, "dev_peer", true)
                .expect("select Iroh with TCP fallback hint")
        }

        fn assert_iroh_selection_has_no_tcp_fallback(selection: &TransportSelection) {
            assert_eq!(
                selection.evidence(),
                TransportEvidence {
                    selected_transport: IROH_TRANSPORT_ID.to_string(),
                    fallback_reason: None,
                    fallback_code: None,
                    attempted_transports: vec![IROH_TRANSPORT_ID.to_string()],
                }
            );
            assert!(
                selection.tcp_fallback_endpoint_hint.is_some(),
                "TCP fallback hint should remain advisory, not attempted"
            );
        }

        fn test_progress(
            run_id: impl Into<String>,
            connection: &SharedPeerConnection,
        ) -> ProgressReporter {
            ProgressReporter::new(
                run_id.into(),
                Instant::now(),
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            )
        }

        fn test_no_transfer_staged_project(project_id: &str) -> StagedRemoteProject {
            StagedRemoteProject {
                manifest: json!({
                    "project": { "project_id": project_id },
                    "artifacts": []
                }),
                cleanup_context_manifests: Vec::new(),
                available_content_sha256: Vec::new(),
                transfer_failure: None,
            }
        }

        fn test_transfer_failed_staged_project(
            project_id: &str,
            message: &str,
        ) -> StagedRemoteProject {
            StagedRemoteProject {
                transfer_failure: Some(message.to_string()),
                ..test_no_transfer_staged_project(project_id)
            }
        }

        fn test_remote_metadata(project_ids: &[&str]) -> Value {
            json!({
                "projects": project_ids
                    .iter()
                    .map(|project_id| json!({ "project_id": project_id }))
                    .collect::<Vec<_>>()
            })
        }

        fn apply_request_count(requests: &[String]) -> usize {
            requests
                .iter()
                .filter(|path| path.as_str() == "/api/v1/sync/reconciliation/apply")
                .count()
        }

        fn planned_project_with_fetch_artifact(
            project_id: &str,
            artifact: &RemoteArtifact,
        ) -> PlannedRemoteProject {
            PlannedRemoteProject {
                project_id: project_id.to_string(),
                manifest: Some(json!({
                    "project": { "project_id": project_id },
                    "artifacts": [{
                        "artifact_id": artifact.artifact_id.clone(),
                        "project_id": artifact.project_id.clone(),
                        "content_sha256": artifact.content_sha256.clone(),
                        "size_bytes": artifact.size_bytes
                    }]
                })),
                plan: json!({
                    "actions": [{
                        "action_type": "fetch_artifact_content",
                        "provider_device_id": "dev_peer",
                        "item_id": artifact.artifact_id.clone(),
                        "project_id": artifact.project_id.clone(),
                        "content_sha256": artifact.content_sha256.clone()
                    }]
                }),
            }
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn remote_apply_worker_batches_ready_no_transfer_projects() {
            let backend = TestBackendServer::start_with_staged_artifacts(HashMap::new());
            let client = test_backend_client(&backend);
            let (connection, peer_thread) = spawn_test_sync_peer(|_| Ok(()));
            let progress = test_progress("sync_batch_apply_ready_test", &connection);
            let mut apply_worker = RemoteApplyWorker::start(
                &client,
                "dev_peer",
                &test_remote_metadata(&["proj_one", "proj_two", "proj_three"]),
                TCP_TRANSPORT_ID,
                progress,
            );

            apply_worker.enqueue_project(test_no_transfer_staged_project("proj_one"));
            apply_worker.enqueue_project(test_no_transfer_staged_project("proj_two"));
            apply_worker.enqueue_project(test_no_transfer_staged_project("proj_three"));
            let results = apply_worker.finish(&mut Vec::new());
            peer_thread
                .join()
                .expect("join ready batch peer")
                .expect("ready batch peer completed");

            assert_eq!(apply_request_count(&backend.requests()), 1);
            let apply_bodies = backend.request_bodies("/api/v1/sync/reconciliation/apply");
            assert_eq!(apply_bodies.len(), 1);
            let apply_body = &apply_bodies[0];
            assert_eq!(
                apply_body
                    .get("project_manifests")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(3)
            );
            assert_eq!(
                apply_body.get("project_ids"),
                Some(&json!(["proj_one", "proj_two", "proj_three"]))
            );
            assert_eq!(
                apply_body
                    .get("peer_inventory")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1)
            );
            assert_eq!(results.len(), 3);
            assert!(results.iter().all(|result| result.status == "skipped"));
            assert_eq!(
                results
                    .iter()
                    .map(|result| result.project_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["proj_one", "proj_two", "proj_three"]
            );
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn remote_apply_worker_splits_backend_error_batch_and_isolates_failed_project() {
            let backend = TestBackendServer::start_with_apply_failure_project_ids(HashSet::from([
                "proj_bad".to_string(),
            ]));
            let client = test_backend_client(&backend);
            let (connection, peer_thread) = spawn_test_sync_peer(|_| Ok(()));
            let progress = test_progress("sync_batch_apply_split_error_test", &connection);
            let mut apply_worker = RemoteApplyWorker::start(
                &client,
                "dev_peer",
                &test_remote_metadata(&["proj_ok_one", "proj_bad", "proj_ok_two"]),
                TCP_TRANSPORT_ID,
                progress,
            );

            apply_worker.enqueue_project(test_no_transfer_staged_project("proj_ok_one"));
            apply_worker.enqueue_project(test_no_transfer_staged_project("proj_bad"));
            apply_worker.enqueue_project(test_no_transfer_staged_project("proj_ok_two"));
            let results = apply_worker.finish(&mut Vec::new());
            peer_thread
                .join()
                .expect("join split error batch peer")
                .expect("split error batch peer completed");

            let apply_bodies = backend.request_bodies("/api/v1/sync/reconciliation/apply");
            assert!(
                apply_bodies.len() > 1,
                "backend apply error should split retry requests: {apply_bodies:?}"
            );
            let request_project_ids = apply_bodies
                .iter()
                .map(|body| {
                    body.get("project_ids")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            assert_eq!(
                request_project_ids.first(),
                Some(&vec![
                    "proj_ok_one".to_string(),
                    "proj_bad".to_string(),
                    "proj_ok_two".to_string()
                ])
            );
            assert!(request_project_ids
                .iter()
                .any(|project_ids| project_ids == &vec!["proj_ok_one".to_string()]));
            assert!(request_project_ids
                .iter()
                .any(|project_ids| project_ids == &vec!["proj_bad".to_string()]));
            assert!(request_project_ids
                .iter()
                .any(|project_ids| project_ids == &vec!["proj_ok_two".to_string()]));

            assert_eq!(results.len(), 3);
            let ok_one = results
                .iter()
                .find(|result| result.project_id == "proj_ok_one")
                .expect("first successful project result");
            let bad = results
                .iter()
                .find(|result| result.project_id == "proj_bad")
                .expect("failed project result");
            let ok_two = results
                .iter()
                .find(|result| result.project_id == "proj_ok_two")
                .expect("second successful project result");
            assert_eq!(ok_one.status, "skipped");
            assert_eq!(ok_two.status, "skipped");
            assert_eq!(bad.status, "failed");
            let bad_message = bad.message.as_deref().unwrap_or("");
            assert!(bad_message.contains("apply refused requested project"));
            assert!(!bad_message.contains("source_path"));
            assert!(!bad_message.contains("/private/"));
            assert_eq!(
                results
                    .iter()
                    .filter(|result| result.status == "failed")
                    .count(),
                1
            );
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn remote_apply_worker_reports_transfer_failure_without_blocking_batch() {
            let backend = TestBackendServer::start_with_staged_artifacts(HashMap::new());
            let client = test_backend_client(&backend);
            let (connection, peer_thread) = spawn_test_sync_peer(|_| Ok(()));
            let progress = test_progress("sync_batch_apply_transfer_failure_test", &connection);
            let mut apply_worker = RemoteApplyWorker::start(
                &client,
                "dev_peer",
                &test_remote_metadata(&["proj_failed", "proj_ok_one", "proj_ok_two"]),
                TCP_TRANSPORT_ID,
                progress,
            );

            apply_worker.enqueue_project(test_transfer_failed_staged_project(
                "proj_failed",
                "stream failed",
            ));
            apply_worker.enqueue_project(test_no_transfer_staged_project("proj_ok_one"));
            apply_worker.enqueue_project(test_no_transfer_staged_project("proj_ok_two"));
            let results = apply_worker.finish(&mut Vec::new());
            peer_thread
                .join()
                .expect("join transfer failure batch peer")
                .expect("transfer failure batch peer completed");

            assert_eq!(apply_request_count(&backend.requests()), 1);
            assert_eq!(results.len(), 3);
            let failed = results
                .iter()
                .find(|result| result.project_id == "proj_failed")
                .expect("failed project result");
            assert_eq!(failed.status, "failed");
            assert!(failed
                .message
                .as_deref()
                .is_some_and(|message| message.contains("stream failed")));
            assert!(results
                .iter()
                .filter(|result| result.project_id != "proj_failed")
                .all(|result| result.status == "skipped"));
        }

        #[test]
        fn reconciliation_apply_batching_does_not_change_iroh_transfer_limits() {
            assert_eq!(IROH_ARTIFACT_PARALLELISM, 4);
            assert_eq!(
                IROH_ARTIFACT_STAGING_QUEUE_CAPACITY,
                IROH_ARTIFACT_PARALLELISM * 2
            );
            assert_eq!(IROH_ARTIFACT_RECEIVE_BYTE_BUDGET, 4 * 1024 * 1024 * 1024);
            assert_eq!(IROH_STREAM_RECEIVE_WINDOW_BYTES, 32 * 1024 * 1024);
            assert_eq!(IROH_CONNECTION_RECEIVE_WINDOW_BYTES, 128 * 1024 * 1024);
            assert_eq!(IROH_SEND_WINDOW_BYTES, 64 * 1024 * 1024);
        }

        #[cfg(not(target_os = "android"))]
        fn run_connected_iroh_stage_artifact(
            backend: &TestBackendServer,
            artifact: RemoteArtifact,
            stream_payload: Vec<u8>,
            run_id: &str,
        ) -> (
            Vec<SyncTransportTransferResult>,
            Vec<SyncTransportProjectResult>,
            Vec<String>,
            Vec<PathBuf>,
        ) {
            let peer_artifact = artifact.clone();
            let (connection, client_endpoint, peer_thread) =
                spawn_test_iroh_sync_peer(move |mut peer, iroh_data| {
                    let request = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    let ProtocolMessage::ArtifactBatchRequest(request) = request else {
                        return Err("expected Iroh artifact batch request".to_string());
                    };
                    if request.artifacts.len() != 1
                        || request.artifacts[0].artifact_id != peer_artifact.artifact_id
                    {
                        return Err(format!(
                            "expected one artifact request for {}, got {:?}",
                            peer_artifact.artifact_id,
                            request
                                .artifacts
                                .iter()
                                .map(|artifact| artifact.artifact_id.as_str())
                                .collect::<Vec<_>>()
                        ));
                    }
                    let batch_token = request
                        .batch_token
                        .ok_or_else(|| "expected Iroh batch token".to_string())?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchStart {
                        batch_token: batch_token.clone(),
                        artifact_count: 1,
                    })?;
                    send_test_iroh_artifact_stream(
                        &iroh_data,
                        &batch_token,
                        &peer_artifact,
                        &stream_payload,
                    )?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchEnd { batch_token })?;
                    thread::sleep(Duration::from_millis(250));
                    Ok(())
                });
            let client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };
            let progress = test_progress(run_id, &connection);
            let mut apply_worker = RemoteApplyWorker::start(
                &client,
                "dev_peer",
                &json!({ "projects": [{ "project_id": artifact.project_id.clone() }] }),
                IROH_TRANSPORT_ID,
                progress.clone(),
            );
            let mut metrics = SyncRunMetrics::start(Instant::now());
            let mut timings = Vec::new();
            let mut received_artifacts = Vec::new();

            stage_remote_manifest_iroh_artifacts(
                &client,
                &connection,
                connection
                    .iroh_data_connection()
                    .expect("test Iroh data connection"),
                "dev_peer",
                vec![planned_project_with_fetch_artifact(
                    &artifact.project_id,
                    &artifact,
                )],
                &mut apply_worker,
                &mut received_artifacts,
                &mut metrics,
                &mut timings,
                &progress,
            );
            let project_results = apply_worker.finish(&mut timings);
            let requests = backend.requests();
            let temp_files = collect_test_files(&backend.transport_temp_root());
            close_test_iroh_endpoint(&client_endpoint);
            peer_thread
                .join()
                .expect("join connected Iroh artifact peer")
                .expect("connected Iroh artifact peer completed");

            (received_artifacts, project_results, requests, temp_files)
        }

        #[test]
        fn peer_stream_can_switch_to_protocol_watchdog_timeout() {
            let mut peer_stream = RecordingPeerStream {
                read_timeout: READ_TIMEOUT,
            };

            peer_stream
                .set_read_timeout(PROTOCOL_WATCHDOG_TIMEOUT)
                .expect("set watchdog timeout");

            assert_eq!(peer_stream.read_timeout, Duration::from_secs(75));
        }

        #[test]
        fn transport_protocol_version_gates_watchdog_status_frames() {
            assert_eq!(TRANSPORT_PROTOCOL_VERSION, "tuneforge-sync-transport-v5");
        }

        #[test]
        fn phase_context_labels_timeout_as_stalled() {
            let error = phase_context_error(
                "manifest exchange",
                "Timed out reading from Iroh sync stream.".to_string(),
            );

            assert_eq!(
                error,
                "Sync transport manifest exchange stalled: Timed out reading from Iroh sync stream."
            );
        }

        #[test]
        fn phase_context_labels_watchdog_timeout_as_stalled() {
            let error = phase_context_error(
                "serve artifact requests",
                "Timed out waiting for sync transport protocol progress.".to_string(),
            );

            assert_eq!(
                error,
                "Sync transport serve artifact requests stalled: Timed out waiting for sync transport protocol progress."
            );
        }

        #[test]
        fn failure_finalizer_cancels_pending_remote_apply_before_drain() {
            let (sender, receiver) =
                mpsc::sync_channel::<BackendWriteTask>(IROH_ARTIFACT_STAGING_QUEUE_CAPACITY);
            let (event_sender, event_receiver) = mpsc::channel::<BackendWriteEvent>();
            let (observed_cancel_sender, observed_cancel_receiver) = mpsc::channel::<bool>();
            let queued_project_ids = Arc::new(Mutex::new(Vec::new()));
            let enqueue_failures = Arc::new(Mutex::new(Vec::new()));
            let apply_cancelled = Arc::new(AtomicBool::new(false));
            let worker_apply_cancelled = Arc::clone(&apply_cancelled);
            let handle = thread::spawn(move || {
                while let Ok(task) = receiver.recv() {
                    let BackendWriteTask::Apply { project_id, .. } = task else {
                        continue;
                    };
                    let wait_started = Instant::now();
                    while !worker_apply_cancelled.load(Ordering::SeqCst)
                        && wait_started.elapsed() < Duration::from_secs(2)
                    {
                        thread::sleep(Duration::from_millis(1));
                    }
                    let cancelled = worker_apply_cancelled.load(Ordering::SeqCst);
                    let _ = observed_cancel_sender.send(cancelled);
                    let message = if cancelled {
                        "Remote sync import skipped after Iroh artifact transfer aborted."
                    } else {
                        "Remote sync import worker drained without cancellation."
                    };
                    let _ = event_sender.send(BackendWriteEvent::Apply {
                        project_ids: vec![project_id.clone()],
                        results: vec![failed_project_result(&project_id, message)],
                        timings: Vec::new(),
                    });
                }
            });
            let mut apply_worker = RemoteApplyWorker {
                sender: Some(sender),
                event_receiver,
                handle: Some(handle),
                queued_project_ids,
                completed_project_ids: HashSet::new(),
                enqueue_failures,
                apply_cancelled,
                project_results: Vec::new(),
                pending_stage_jobs: 0,
                pending_stage_bytes: 0,
                staging_peak_bytes: 0,
            };
            apply_worker.enqueue_tombstone("proj_abort".to_string());

            finish_staged_remote_import_for_failure(Some(StagedRemoteImport {
                plan_failures: Vec::new(),
                apply_worker: Some(apply_worker),
                received_artifacts: Vec::new(),
            }));

            assert!(
                observed_cancel_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("worker observed failure finalizer drain"),
                "failure finalizer must cancel pending reconciliation apply before draining worker"
            );
        }

        #[test]
        fn iroh_receiver_cancel_does_not_record_fatal_transfer() {
            let (_event_sender, event_receiver) = mpsc::channel::<BackendWriteEvent>();
            let mut apply_worker = RemoteApplyWorker {
                sender: None,
                event_receiver,
                handle: None,
                queued_project_ids: Arc::new(Mutex::new(Vec::new())),
                completed_project_ids: HashSet::new(),
                enqueue_failures: Arc::new(Mutex::new(Vec::new())),
                apply_cancelled: Arc::new(AtomicBool::new(false)),
                project_results: Vec::new(),
                pending_stage_jobs: 0,
                pending_stage_bytes: 0,
                staging_peak_bytes: 0,
            };
            let mut metrics = SyncRunMetrics::start(Instant::now());
            let mut timings = Vec::new();
            let mut credit_window = IrohBatchCreditWindow::new(&[], 1, 1024);
            let credited_artifact_ids = Arc::new(Mutex::new(HashSet::new()));
            let mut completed_artifact_ids = HashSet::new();
            let mut fatal_error = None;
            let mut recorded = Vec::new();

            handle_iroh_receive_result(
                Err(IrohArtifactReceiveError {
                    artifact_id: Some("art_cancelled".to_string()),
                    message: IROH_ARTIFACT_RECEIVE_CANCELLED.to_string(),
                    timing: None,
                    phase_timing: None,
                    diagnostics: SyncTransportDiagnostics::default(),
                }),
                &HashMap::new(),
                &mut metrics,
                &mut timings,
                &mut credit_window,
                &credited_artifact_ids,
                &mut completed_artifact_ids,
                &mut fatal_error,
                &mut apply_worker,
                &mut |transfer, allow_project_apply, _apply_worker| {
                    recorded.push((transfer, allow_project_apply));
                },
            );

            assert!(fatal_error.is_none());
            assert!(completed_artifact_ids.is_empty());
            assert!(recorded.is_empty());
            assert!(timings.is_empty());
        }

        #[test]
        fn protocol_status_serializes_progress_fields() {
            let message = protocol_status_message(protocol_status_payload(
                "sync_run",
                "reconciliation_plan",
                "Planning sync reconciliation.",
                "2026-01-01T00:00:00Z",
                15_000,
            ));

            let value = serde_json::to_value(message).expect("serialize status");

            assert_eq!(value.get("type"), Some(&json!("status")));
            assert_eq!(value.get("run_id"), Some(&json!("sync_run")));
            assert_eq!(value.get("phase"), Some(&json!("reconciliation_plan")));
            assert_eq!(
                value.get("message"),
                Some(&json!("Planning sync reconciliation."))
            );
            assert_eq!(
                value.get("progress_at"),
                Some(&json!("2026-01-01T00:00:00Z"))
            );
            assert_eq!(value.get("elapsed_ms"), Some(&json!(15_000)));
            assert!(value.get("source_path").is_none());
            assert!(value.get("data").is_none());
            assert!(value.get("artifact_id").is_none());
        }

        #[test]
        fn artifact_batch_credit_and_abort_serialize_as_internal_protocol_messages() {
            let credit = ProtocolMessage::ArtifactBatchCredit {
                batch_token: "batch_one".to_string(),
                artifact_ids: vec!["art_one".to_string(), "art_two".to_string()],
            };
            let abort = ProtocolMessage::ArtifactBatchAbort {
                batch_token: "batch_one".to_string(),
                message: "receiver cancelled".to_string(),
            };

            let credit_value = serde_json::to_value(credit).expect("serialize credit");
            let abort_value = serde_json::to_value(abort).expect("serialize abort");

            assert_eq!(
                credit_value.get("type"),
                Some(&json!("artifact_batch_credit"))
            );
            assert_eq!(credit_value.get("batch_token"), Some(&json!("batch_one")));
            assert_eq!(
                credit_value.get("artifact_ids"),
                Some(&json!(["art_one", "art_two"]))
            );
            assert_eq!(
                abort_value.get("type"),
                Some(&json!("artifact_batch_abort"))
            );
            assert_eq!(abort_value.get("batch_token"), Some(&json!("batch_one")));
            assert_eq!(
                abort_value.get("message"),
                Some(&json!("receiver cancelled"))
            );
            assert!(credit_value.get("source_path").is_none());
            assert!(abort_value.get("source_path").is_none());
        }

        #[test]
        fn iroh_batch_control_abort_surfaces_peer_reason() {
            let (connection, peer_thread) = spawn_test_sync_peer(move |mut peer| {
                peer.send_message(&ProtocolMessage::ArtifactBatchAbort {
                    batch_token: "batch_abort".to_string(),
                    message: "receiver cancelled transfer".to_string(),
                })
            });
            let started = Instant::now();
            let progress = ProgressReporter::new(
                "sync_abort_control_test".to_string(),
                started,
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            );

            let error =
                match poll_iroh_artifact_batch_control(&connection, "batch_abort", &progress) {
                    Ok(_) => panic!("abort should fail control polling"),
                    Err(error) => error,
                };
            peer_thread
                .join()
                .expect("join abort control peer")
                .expect("abort control peer completed");

            assert!(error.contains("artifact request/transfer"));
            assert!(error.contains("receiver cancelled transfer"));
        }

        #[test]
        fn read_message_accepting_status_records_progress_and_keeps_waiting() {
            let mut messages = std::collections::VecDeque::from([
                protocol_status_message(protocol_status_payload(
                    "sync_run",
                    "reconciliation_apply",
                    "Applying remote reconciliation.",
                    "2026-01-01T00:00:15Z",
                    15_000,
                )),
                ProtocolMessage::ManifestOffer(ManifestOffer {
                    metadata: json!({}),
                    project_manifests: Vec::new(),
                    manifest_errors: Vec::new(),
                }),
            ]);
            let mut statuses = Vec::new();

            let message = read_message_accepting_status(
                "manifest exchange",
                || {
                    messages
                        .pop_front()
                        .ok_or_else(|| "missing test protocol message".to_string())
                },
                |status| statuses.push(status),
            )
            .expect("read expected message");

            assert_eq!(statuses.len(), 1);
            assert_eq!(statuses[0].run_id, "sync_run");
            assert_eq!(statuses[0].phase, "reconciliation_apply");
            assert!(matches!(message, ProtocolMessage::ManifestOffer(_)));
        }

        #[test]
        fn active_progress_serializes_for_native_status() {
            let progress = SyncTransportActiveProgress {
                run_id: "sync_run".to_string(),
                phase: "artifact_transfer".to_string(),
                message: "Transferring artifact content.".to_string(),
                progress_at: "2026-01-01T00:00:15Z".to_string(),
                elapsed_ms: 15_000,
            };

            let value = serde_json::to_value(progress).expect("serialize active progress");

            assert_eq!(value.get("runId"), Some(&json!("sync_run")));
            assert_eq!(value.get("phase"), Some(&json!("artifact_transfer")));
            assert_eq!(
                value.get("message"),
                Some(&json!("Transferring artifact content."))
            );
            assert_eq!(
                value.get("progressAt"),
                Some(&json!("2026-01-01T00:00:15Z"))
            );
            assert_eq!(value.get("elapsedMs"), Some(&json!(15_000)));
        }

        #[test]
        fn active_progress_clears_peer_status_owned_by_completed_run() {
            let mut status = SharedStatus {
                active_progress: Some(SyncTransportActiveProgress {
                    run_id: "peer_run".to_string(),
                    phase: "reconciliation_apply".to_string(),
                    message: "Applying remote reconciliation.".to_string(),
                    progress_at: "2026-01-01T00:00:15Z".to_string(),
                    elapsed_ms: 15_000,
                }),
                active_progress_owner_run_id: Some("local_run".to_string()),
                ..SharedStatus::default()
            };

            clear_active_progress_for_run(&mut status, "local_run");

            assert!(status.active_progress.is_none());
            assert!(status.active_progress_owner_run_id.is_none());
        }

        #[test]
        fn active_progress_clear_preserves_unrelated_session() {
            let mut status = SharedStatus {
                active_progress: Some(SyncTransportActiveProgress {
                    run_id: "peer_run_two".to_string(),
                    phase: "artifact_transfer".to_string(),
                    message: "Transferring artifact content.".to_string(),
                    progress_at: "2026-01-01T00:00:15Z".to_string(),
                    elapsed_ms: 15_000,
                }),
                active_progress_owner_run_id: Some("local_run_two".to_string()),
                ..SharedStatus::default()
            };

            clear_active_progress_for_run(&mut status, "local_run_one");

            assert!(status.active_progress.is_some());
            assert_eq!(
                status.active_progress_owner_run_id.as_deref(),
                Some("local_run_two")
            );
        }

        #[test]
        fn sync_now_error_clears_only_owned_active_progress() {
            let mut owned_status = SharedStatus {
                active_progress: Some(SyncTransportActiveProgress {
                    run_id: "peer_run".to_string(),
                    phase: "reconciliation_plan".to_string(),
                    message: "Planning sync reconciliation.".to_string(),
                    progress_at: "2026-01-01T00:00:15Z".to_string(),
                    elapsed_ms: 15_000,
                }),
                active_progress_owner_run_id: Some("local_run".to_string()),
                ..SharedStatus::default()
            };
            let owned_result: Result<SyncTransportSyncResult, SyncNowHardFailure> = Err(
                test_sync_now_hard_failure("local_run", "outbound sync failed", Vec::new()),
            );

            apply_sync_now_status_result(&mut owned_status, &owned_result, "local_run");

            assert_eq!(
                owned_status.last_error.as_deref(),
                Some("Sync now failed: outbound sync failed")
            );
            assert!(owned_status.last_sync.is_some());
            assert!(owned_status.active_progress.is_none());
            assert!(owned_status.active_progress_owner_run_id.is_none());

            let mut unrelated_status = SharedStatus {
                active_progress: Some(SyncTransportActiveProgress {
                    run_id: "inbound_peer_run".to_string(),
                    phase: "artifact_transfer".to_string(),
                    message: "Transferring artifact content.".to_string(),
                    progress_at: "2026-01-01T00:00:15Z".to_string(),
                    elapsed_ms: 15_000,
                }),
                active_progress_owner_run_id: Some("inbound_local_run".to_string()),
                ..SharedStatus::default()
            };
            let unrelated_result: Result<SyncTransportSyncResult, SyncNowHardFailure> =
                Err(test_sync_now_hard_failure(
                    "outbound_local_run",
                    "outbound sync failed",
                    Vec::new(),
                ));

            apply_sync_now_status_result(
                &mut unrelated_status,
                &unrelated_result,
                "outbound_local_run",
            );

            assert!(unrelated_status.active_progress.is_some());
            assert_eq!(
                unrelated_status.active_progress_owner_run_id.as_deref(),
                Some("inbound_local_run")
            );
        }

        #[test]
        fn sync_now_hard_error_records_failed_last_sync_evidence() {
            let error =
                "Sync transport reconciliation staging failed: Could not write sync transport frame: connection lost";
            let received_artifacts =
                vec![test_transfer_result("art_one", "hash_one", 42, "received")];
            let result: Result<SyncTransportSyncResult, SyncNowHardFailure> = Err(
                test_sync_now_hard_failure("local_run", error, received_artifacts),
            );
            let mut status = SharedStatus::default();

            apply_sync_now_status_result(&mut status, &result, "local_run");

            let last_sync = status.last_sync.expect("hard failure records last sync");
            let expected_message = format!("Sync now failed: {error}");
            assert_eq!(
                status.last_error.as_deref(),
                Some(expected_message.as_str())
            );
            assert_eq!(
                status.last_status.as_deref(),
                Some(expected_message.as_str())
            );
            assert_eq!(last_sync.run_id, "local_run");
            assert_eq!(last_sync.peer_device_id, "dev_peer");
            assert_eq!(last_sync.remote_device_id, "dev_remote");
            assert_eq!(last_sync.status, "failed");
            assert_eq!(last_sync.message, expected_message);
            assert_eq!(last_sync.selected_transport, TCP_TRANSPORT_ID);
            assert_eq!(
                last_sync.attempted_transports,
                vec![TCP_TRANSPORT_ID.to_string()]
            );
            assert_eq!(last_sync.local_manifest_count, 4);
            assert_eq!(last_sync.remote_manifest_count, 5);
            assert_eq!(last_sync.served_artifact_requests, 2);
            assert_eq!(last_sync.received_artifacts.len(), 1);
            assert_eq!(last_sync.received_artifacts[0].artifact_id, "artifact_1");
            assert_eq!(
                last_sync.received_artifacts[0].content_sha256,
                "[redacted_hash]"
            );
            assert_eq!(last_sync.transfer_counts.received, 1);
            assert_eq!(last_sync.transfer_counts.received_bytes, 42);
            assert_eq!(last_sync.phase_timings.len(), 1);
            assert_eq!(
                last_sync.phase_timings[0].project_id.as_deref(),
                Some("project_1")
            );
            assert_eq!(
                last_sync.phase_timings[0].artifact_id.as_deref(),
                Some("artifact_1")
            );
        }

        #[test]
        fn sync_now_hard_error_sanitizes_exposed_status_fields() {
            let raw_error = concat!(
                "Sync transport artifact request/transfer failed: Could not read ",
                "/Users/test/Music/Secret Demo.wav from device_peer_1 for proj_secret ",
                "through tuneforge-sync+tcp://192.0.2.2:47619 with content_sha256 ",
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            );
            let result: Result<SyncTransportSyncResult, SyncNowHardFailure> = Err(
                test_sync_now_hard_failure("sync_run_secret", raw_error, Vec::new()),
            );
            let mut status = SharedStatus::default();

            apply_sync_now_status_result(&mut status, &result, "sync_run_secret");

            let last_sync = status.last_sync.expect("hard failure records last sync");
            let exposed_fields = [
                status.last_error.as_deref().unwrap_or_default(),
                status.last_status.as_deref().unwrap_or_default(),
                last_sync.message.as_str(),
            ];
            for field in exposed_fields {
                assert_eq!(
                    field,
                    "Sync now failed: Sync transport artifact request/transfer failed: details redacted."
                );
                assert!(!field.contains("/Users/test"));
                assert!(!field.contains("Secret Demo.wav"));
                assert!(!field.contains("device_peer_1"));
                assert!(!field.contains("proj_secret"));
                assert!(!field.contains("tuneforge-sync+tcp"));
                assert!(!field.contains("192.0.2.2"));
                assert!(!field.contains("0123456789abcdef"));
            }
        }

        #[test]
        fn sync_now_hard_error_sanitizes_partial_evidence() {
            let raw_error = concat!(
                "Sync transport reconciliation staging failed: backend body project_id PlainProjectAlpha ",
                "artifactId PlainArtifactBeta deviceId PlainDeviceGamma endpointHints PlainEndpointDelta",
            );
            let started_instant = Instant::now();
            let mut metrics = SyncRunMetrics::start(started_instant);
            metrics.record_received_artifact_bytes(42);
            let failure = sync_now_hard_failure(
                raw_error.to_string(),
                "sync_run_outgoing_secret",
                "dev_peer",
                "dev_remote",
                TransportEvidence {
                    selected_transport: TCP_TRANSPORT_ID.to_string(),
                    fallback_reason: None,
                    fallback_code: None,
                    attempted_transports: vec![TCP_TRANSPORT_ID.to_string()],
                },
                &Utc::now(),
                started_instant,
                &[SyncTransportTransferResult {
                    artifact_id: "art_secret".to_string(),
                    content_sha256:
                        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                            .to_string(),
                    size_bytes: 42,
                    started_at: "2026-01-01T00:00:00Z".to_string(),
                    completed_at: "2026-01-01T00:00:01Z".to_string(),
                    duration_ms: 1_000,
                    throughput_bytes_per_second: 42.0,
                    status: "received".to_string(),
                    message: Some(
                        "Backend response body artifact_id PlainArtifactBeta from projectId PlainProjectAlpha"
                            .to_string(),
                    ),
                }],
                2,
                &metrics,
                &[SyncTransportTimingEvidence {
                    phase: "reconciliation_staging".to_string(),
                    project_id: Some("proj_secret".to_string()),
                    artifact_id: Some("art_secret".to_string()),
                    started_at: "2026-01-01T00:00:00Z".to_string(),
                    completed_at: "2026-01-01T00:00:01Z".to_string(),
                    duration_ms: 1_000,
                }],
                4,
                5,
                vec![SyncTransportManifestError {
                    project_id: "proj_manifest_secret".to_string(),
                    message: "backend body device_id PlainDeviceGamma endpoint_hint PlainEndpointDelta"
                        .to_string(),
                }],
            );

            let serialized = serde_json::to_string(&failure.sync_result)
                .expect("serialize outgoing failure evidence");

            assert_eq!(
                failure.sync_result.message,
                "Sync now failed: Sync transport reconciliation staging failed: details redacted."
            );
            assert_eq!(
                failure.sync_result.received_artifacts[0].artifact_id,
                "artifact_1"
            );
            assert_eq!(
                failure.sync_result.received_artifacts[0].content_sha256,
                "[redacted_hash]"
            );
            assert_eq!(
                failure.sync_result.received_artifacts[0].message.as_deref(),
                Some("Transfer details redacted.")
            );
            assert_eq!(
                failure.sync_result.manifest_errors[0].project_id,
                "project_1"
            );
            assert_eq!(
                failure.sync_result.manifest_errors[0].message,
                "Manifest error details redacted."
            );
            assert_eq!(
                failure.sync_result.phase_timings[0].project_id.as_deref(),
                Some("project_1")
            );
            assert_eq!(
                failure.sync_result.phase_timings[0].artifact_id.as_deref(),
                Some("artifact_1")
            );
            for raw_value in [
                "PlainProjectAlpha",
                "PlainArtifactBeta",
                "PlainDeviceGamma",
                "PlainEndpointDelta",
                "proj_secret",
                "art_secret",
                "0123456789abcdef",
                "artifact_id",
                "device_id",
                "endpoint_hint",
            ] {
                assert!(
                    !serialized.contains(raw_value),
                    "outgoing hard failure evidence leaked {raw_value}: {serialized}"
                );
            }
        }

        #[test]
        fn incoming_hard_error_records_failed_last_sync_evidence() {
            let raw_error =
                "Sync transport serve artifact requests failed: Could not write sync transport frame: connection lost";
            let result = Err(test_incoming_session_hard_failure(
                "listener_run",
                raw_error,
                Vec::new(),
            ));
            let mut status = SharedStatus {
                active_sessions: 1,
                active_progress: Some(SyncTransportActiveProgress {
                    run_id: "listener_run".to_string(),
                    phase: "serve_artifact_requests".to_string(),
                    message: "Serving peer artifact requests.".to_string(),
                    progress_at: "2026-01-01T00:00:15Z".to_string(),
                    elapsed_ms: 15_000,
                }),
                active_progress_owner_run_id: Some("listener_run".to_string()),
                ..SharedStatus::default()
            };

            apply_incoming_session_status_result(&mut status, result, "listener_run");

            let last_sync = status
                .last_sync
                .expect("incoming hard failure records last sync");
            let expected_message = format!("Sync session failed: {raw_error}");
            assert_eq!(status.active_sessions, 0);
            assert_eq!(status.failed_sessions, 1);
            assert!(status.active_progress.is_none());
            assert_eq!(
                status.last_error.as_deref(),
                Some(expected_message.as_str())
            );
            assert_eq!(
                status.last_status.as_deref(),
                Some(expected_message.as_str())
            );
            assert_eq!(last_sync.run_id, "listener_run");
            assert_eq!(last_sync.peer_device_id, "device_peer_1");
            assert_eq!(last_sync.remote_device_id, "device_peer_1");
            assert_eq!(last_sync.status, "failed");
            assert_eq!(last_sync.message, expected_message);
            assert_eq!(last_sync.selected_transport, TCP_TRANSPORT_ID);
            assert_eq!(last_sync.served_artifact_requests, 3);
            assert_eq!(last_sync.total_received_bytes, 42);
            assert_eq!(last_sync.total_served_bytes, 84);
            assert_eq!(last_sync.local_manifest_count, 4);
            assert_eq!(last_sync.remote_manifest_count, 5);
            assert_eq!(last_sync.phase_timings.len(), 1);
        }

        #[test]
        fn incoming_hard_error_sanitizes_exposed_evidence() {
            let raw_error = concat!(
                "Sync transport serve artifact requests failed: Could not open ",
                "/Users/test/Music/Secret Listener Demo.wav for proj_secret ",
                "through tuneforge-sync+tcp://192.0.2.2:47619 with artifact_id art_secret ",
                "and content_sha256 ",
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            );
            let received_artifacts = vec![SyncTransportTransferResult {
                artifact_id: "art_secret".to_string(),
                content_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                    .to_string(),
                size_bytes: 42,
                started_at: "2026-01-01T00:00:00Z".to_string(),
                completed_at: "2026-01-01T00:00:01Z".to_string(),
                duration_ms: 1_000,
                throughput_bytes_per_second: 42.0,
                status: "received".to_string(),
                message: Some(
                    "Fetched art_secret from /Users/test/Music/Secret Listener Demo.wav"
                        .to_string(),
                ),
            }];
            let result = Err(test_incoming_session_hard_failure(
                "listener_secret_run",
                raw_error,
                received_artifacts,
            ));
            let mut status = SharedStatus {
                active_sessions: 1,
                ..SharedStatus::default()
            };

            apply_incoming_session_status_result(&mut status, result, "listener_secret_run");

            let last_sync = status
                .last_sync
                .expect("incoming hard failure records last sync");
            let serialized =
                serde_json::to_string(&last_sync).expect("serialize incoming failure evidence");
            let exposed_fields = [
                status.last_error.as_deref().unwrap_or_default(),
                status.last_status.as_deref().unwrap_or_default(),
                last_sync.message.as_str(),
            ];
            for field in exposed_fields {
                assert_eq!(
                    field,
                    "Sync session failed: Sync transport serve artifact requests failed: details redacted."
                );
            }
            for raw_value in [
                "/Users/test",
                "Secret Listener Demo.wav",
                "tuneforge-sync+tcp://",
                "192.0.2.2",
                "proj_secret",
                "art_secret",
                "0123456789abcdef",
                "project_id",
            ] {
                assert!(
                    !serialized.contains(raw_value),
                    "incoming hard failure evidence leaked {raw_value}: {serialized}"
                );
            }
            assert_eq!(last_sync.received_artifacts[0].artifact_id, "artifact_1");
            assert_eq!(
                last_sync.received_artifacts[0].content_sha256,
                "[redacted_hash]"
            );
            assert_eq!(
                last_sync.received_artifacts[0].message.as_deref(),
                Some("Transfer details redacted.")
            );
            assert_eq!(last_sync.manifest_errors[0].project_id, "project_1");
            assert_eq!(
                last_sync.manifest_errors[0].message,
                "Manifest error details redacted."
            );
        }

        #[test]
        fn sync_now_read_timeout_hard_failure_includes_peer_authentication_timing() {
            let started_instant = Instant::now();
            let timings = sync_now_failure_timings_with_finished_timer(
                &[],
                SyncPhaseTimer::start("peer_authentication"),
            );
            let failure = sync_now_hard_failure(
                "Could not configure established sync transport read timeout: test failure"
                    .to_string(),
                "sync_run_timeout",
                "dev_peer",
                "dev_remote",
                TransportEvidence {
                    selected_transport: TCP_TRANSPORT_ID.to_string(),
                    fallback_reason: None,
                    fallback_code: None,
                    attempted_transports: vec![TCP_TRANSPORT_ID.to_string()],
                },
                &Utc::now(),
                started_instant,
                &[],
                0,
                &SyncRunMetrics::start(started_instant),
                &timings,
                0,
                0,
                Vec::new(),
            );

            assert_eq!(failure.sync_result.phase_timings.len(), 1);
            assert_eq!(
                failure.sync_result.phase_timings[0].phase,
                "peer_authentication"
            );
        }

        #[test]
        fn sync_now_failed_status_message_preserves_connection_lost_text() {
            let error =
                "Sync transport reconciliation staging failed: Could not write sync transport frame: connection lost";

            assert_eq!(
                sync_now_failed_status_message(error),
                format!("Sync now failed: {error}")
            );
        }

        #[test]
        fn sync_now_failed_status_message_redacts_sensitive_details() {
            let error = concat!(
                "Sync transport artifact request/transfer failed: Could not read ",
                "/Users/test/Music/Secret Demo.wav via ",
                "tuneforge-sync+tcp://192.0.2.2:47619 for proj_secret ",
                "with content_sha256 ",
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            );

            let message = sync_now_failed_status_message(error);

            assert_eq!(
                message,
                "Sync now failed: Sync transport artifact request/transfer failed: details redacted."
            );
            assert!(!message.contains("/Users/test"));
            assert!(!message.contains("tuneforge-sync+tcp"));
            assert!(!message.contains("proj_secret"));
            assert!(!message.contains("0123456789abcdef"));
        }

        #[test]
        fn sync_now_failed_status_message_redacts_endpoint_with_trailing_colon() {
            let error = "Could not connect to sync peer at 192.0.2.2:47619:";

            let message = sync_now_failed_status_message(error);

            assert_eq!(
                message,
                "Sync now failed: Sync transport failed: details redacted."
            );
            assert!(!message.contains("192.0.2.2"));
            assert!(!message.contains("47619"));
        }

        #[test]
        fn sync_now_failed_status_message_redacts_backend_body_keys_with_plain_values() {
            let error = concat!(
                "Backend response body project_id PlainProjectAlpha artifactId PlainArtifactBeta ",
                "deviceId PlainDeviceGamma endpointHints PlainEndpointDelta endpoint_hint PlainEndpointEpsilon",
            );

            let message = sync_now_failed_status_message(error);

            assert_eq!(
                message,
                "Sync now failed: Sync transport failed: details redacted."
            );
            for raw_value in [
                "PlainProjectAlpha",
                "PlainArtifactBeta",
                "PlainDeviceGamma",
                "PlainEndpointDelta",
                "PlainEndpointEpsilon",
            ] {
                assert!(!message.contains(raw_value));
            }
        }

        #[test]
        fn sync_now_failed_status_message_redacts_non_phase_endpoint_and_ids() {
            let error = "Could not connect to sync peer at 192.0.2.2:47619: device_peer_1 failed";

            let message = sync_now_failed_status_message(error);

            assert_eq!(
                message,
                "Sync now failed: Sync transport failed: details redacted."
            );
            assert!(!message.contains("192.0.2.2"));
            assert!(!message.contains("device_peer_1"));
        }

        #[test]
        fn sync_now_non_interrupted_result_clears_retryable_interruption() {
            let mut status = SharedStatus {
                retryable_interruption_code: Some(
                    "lifecycle_interrupted_android_background".to_string(),
                ),
                retryable_interruption_peer_device_id: Some("dev_peer".to_string()),
                retry_guidance: Some(LIFECYCLE_INTERRUPTION_FOREGROUND_GUIDANCE.to_string()),
                ..SharedStatus::default()
            };
            let result = Ok(failed_preflight_sync_result(
                "sync_run_recovered".to_string(),
                "dev_peer".to_string(),
                BACKEND_PREFLIGHT_UNRESPONSIVE_CODE,
                "Local backend was unavailable.".to_string(),
                Utc::now(),
                Instant::now(),
            ));

            apply_sync_now_status_result(&mut status, &result, "sync_run_recovered");

            assert!(status.retryable_interruption_code.is_none());
            assert!(status.retryable_interruption_peer_device_id.is_none());
            assert!(status.retry_guidance.is_none());
        }

        #[test]
        fn stale_transport_temp_cleanup_error_omits_entry_path() {
            let message = stale_transport_temp_cleanup_error(io::Error::from_raw_os_error(13));

            assert!(
                message.starts_with("Could not remove stale sync transport artifact temp entry:")
            );
            assert!(message.contains("Permission denied"));
            assert!(!message.contains("/"));
            assert!(!message.contains("transport-tmp"));
        }

        #[test]
        fn phase_context_labels_peer_manifest_errors() {
            let error = phase_context_error(
                "manifest exchange",
                "Sync peer returned an error: remote manifest invalid.".to_string(),
            );

            assert_eq!(
                error,
                "Sync transport manifest exchange failed: Sync peer returned an error: remote manifest invalid."
            );
        }

        #[test]
        fn phase_context_preserves_existing_same_phase_context() {
            let error = phase_context_error(
                "artifact request/transfer",
                "Sync transport artifact request/transfer failed: Could not read local artifact."
                    .to_string(),
            );

            assert_eq!(
                error,
                "Sync transport artifact request/transfer failed: Could not read local artifact."
            );
        }

        #[test]
        fn phase_context_can_add_serve_context_to_artifact_transfer_failure() {
            let error = phase_context_error(
                "serve artifact requests",
                phase_context_error(
                    "artifact request/transfer",
                    "Could not read local artifact.".to_string(),
                ),
            );

            assert_eq!(
                error,
                "Sync transport serve artifact requests failed: Sync transport artifact request/transfer failed: Could not read local artifact."
            );
        }

        #[test]
        fn artifact_chunks_encode_as_binary_frames_without_json_base64_payloads() {
            let frame = encode_artifact_chunk_frame(b"binary\0payload");

            assert_eq!(frame.first().copied(), Some(ENCRYPTED_FRAME_ARTIFACT_CHUNK));
            assert_eq!(&frame[1..], b"binary\0payload");
            assert!(serde_json::from_slice::<Value>(&frame).is_err());
            match decode_encrypted_frame_plaintext(&frame).expect("decode artifact frame") {
                EncryptedFrame::ArtifactChunk(chunk) => {
                    assert_eq!(chunk, b"binary\0payload");
                }
                EncryptedFrame::MessageChunk(_) => panic!("expected binary artifact frame"),
            }
        }

        #[test]
        fn artifact_chunk_size_leaves_raw_noise_frame_margin() {
            assert!(ARTIFACT_CHUNK_SIZE > 32 * 1024);
            assert_eq!(
                ARTIFACT_CHUNK_SIZE + 1 + NOISE_FRAME_SAFETY_MARGIN,
                MAX_RAW_FRAME
            );
        }

        #[test]
        fn artifact_batch_request_serializes_protocol_payload() {
            let message = ProtocolMessage::ArtifactBatchRequest(ArtifactBatchRequest {
                batch_token: None,
                artifacts: vec![ArtifactRequest {
                    artifact_id: "art_one".to_string(),
                    project_id: Some("proj_one".to_string()),
                    content_sha256: "hash_one".to_string(),
                    size_bytes: 42,
                }],
            });

            let value = serde_json::to_value(&message).expect("serialize batch request");
            assert_eq!(value.get("type"), Some(&json!("artifact_batch_request")));
            assert_eq!(
                value.pointer("/artifacts/0/projectId"),
                Some(&json!("proj_one"))
            );

            let legacy = json!({
                "type": "artifact_request",
                "artifactId": "art_legacy",
                "contentSha256": "hash_legacy",
                "sizeBytes": 11
            });
            let decoded =
                serde_json::from_value::<ProtocolMessage>(legacy).expect("decode request");
            match decoded {
                ProtocolMessage::ArtifactRequest(request) => {
                    assert_eq!(request.artifact_id, "art_legacy");
                    assert_eq!(request.project_id, None);
                    assert_eq!(request.content_sha256, "hash_legacy");
                    assert_eq!(request.size_bytes, 11);
                }
                other => panic!("expected artifact request, got {}", other.kind()),
            }
        }

        #[test]
        fn iroh_artifact_stream_header_uses_batch_metadata_without_local_paths() {
            let header = IrohArtifactStreamHeader {
                batch_token: "batch_one".to_string(),
                artifact_id: "art_one".to_string(),
                content_sha256: "hash_one".to_string(),
                size_bytes: 42,
                unavailable: false,
            };

            let value = serde_json::to_value(header).expect("serialize iroh stream header");

            assert_eq!(value.get("batchToken"), Some(&json!("batch_one")));
            assert_eq!(value.get("artifactId"), Some(&json!("art_one")));
            assert_eq!(value.get("contentSha256"), Some(&json!("hash_one")));
            assert_eq!(value.get("sizeBytes"), Some(&json!(42)));
            assert!(value.get("unavailable").is_none());
            assert!(value.get("source_path").is_none());
            assert!(value.get("sourcePath").is_none());
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn iroh_sender_waits_for_batch_credit_before_opening_streams() {
            let first_payload = b"first credited payload".to_vec();
            let second_payload = b"second credited payload".to_vec();
            let first_artifact = RemoteArtifact {
                artifact_id: "art_first".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: test_sha256(&first_payload),
                size_bytes: first_payload.len() as u64,
            };
            let second_artifact = RemoteArtifact {
                artifact_id: "art_second".to_string(),
                project_id: "proj_two".to_string(),
                content_sha256: test_sha256(&second_payload),
                size_bytes: second_payload.len() as u64,
            };
            let source_root =
                env::temp_dir().join(format!("tuneforge-sync-source-test-{}", random_nonce()));
            fs::create_dir_all(&source_root).expect("create source root");
            let first_path = source_root.join("first.bin");
            let second_path = source_root.join("second.bin");
            fs::write(&first_path, &first_payload).expect("write first payload");
            fs::write(&second_path, &second_payload).expect("write second payload");
            let backend = TestBackendServer::start_with_staged_artifacts_and_files(
                HashMap::new(),
                HashMap::from([
                    (
                        first_artifact.artifact_id.clone(),
                        LocalArtifactFile {
                            artifact_id: first_artifact.artifact_id.clone(),
                            source_path: first_path,
                            content_sha256: first_artifact.content_sha256.clone(),
                            size_bytes: first_artifact.size_bytes,
                        },
                    ),
                    (
                        second_artifact.artifact_id.clone(),
                        LocalArtifactFile {
                            artifact_id: second_artifact.artifact_id.clone(),
                            source_path: second_path,
                            content_sha256: second_artifact.content_sha256.clone(),
                            size_bytes: second_artifact.size_bytes,
                        },
                    ),
                ]),
            );
            let peer_first_artifact = first_artifact.clone();
            let peer_second_artifact = second_artifact.clone();
            let peer_first_payload = first_payload.clone();
            let peer_second_payload = second_payload.clone();
            let (connection, client_endpoint, peer_thread) = spawn_test_iroh_sync_peer(
                move |mut peer, iroh_data| {
                    let batch_token = "batch_credit_gate".to_string();
                    peer.send_message(&ProtocolMessage::ArtifactBatchRequest(
                        ArtifactBatchRequest {
                            batch_token: Some(batch_token.clone()),
                            artifacts: vec![
                                peer_first_artifact.artifact_request(),
                                peer_second_artifact.artifact_request(),
                            ],
                        },
                    ))?;
                    let start = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    match start {
                        ProtocolMessage::ArtifactBatchStart {
                            batch_token: peer_batch_token,
                            artifact_count,
                        } if peer_batch_token == batch_token && artifact_count == 2 => {}
                        other => {
                            return Err(format!(
                                "expected artifact batch start, got {}",
                                other.kind()
                            ));
                        }
                    }
                    if let Some(mut recv) =
                        iroh_data.accept_recv_stream_with_timeout(Duration::from_millis(250))?
                    {
                        if let Some(header) =
                            try_read_test_iroh_artifact_stream_header(&iroh_data, &mut recv)?
                        {
                            if header.batch_token == batch_token {
                                return Err(
                                    "sender opened Iroh data stream before credit".to_string()
                                );
                            }
                        }
                    }
                    peer.send_message(&ProtocolMessage::ArtifactBatchCredit {
                        batch_token: batch_token.clone(),
                        artifact_ids: vec![peer_first_artifact.artifact_id.clone()],
                    })?;
                    let first_bytes = receive_test_iroh_artifact_stream(
                        &iroh_data,
                        &batch_token,
                        &peer_first_artifact,
                    )?;
                    assert_eq!(first_bytes, peer_first_payload);
                    if let Some(mut recv) =
                        iroh_data.accept_recv_stream_with_timeout(Duration::from_millis(250))?
                    {
                        if let Some(header) =
                            try_read_test_iroh_artifact_stream_header(&iroh_data, &mut recv)?
                        {
                            if header.batch_token == batch_token {
                                return Err(
                                    "sender opened next Iroh data stream before replenishment credit"
                                        .to_string(),
                                );
                            }
                        }
                    }

                    peer.send_message(&ProtocolMessage::ArtifactBatchCredit {
                        batch_token: batch_token.clone(),
                        artifact_ids: vec![peer_second_artifact.artifact_id.clone()],
                    })?;
                    let second_bytes = receive_test_iroh_artifact_stream(
                        &iroh_data,
                        &batch_token,
                        &peer_second_artifact,
                    )?;
                    assert_eq!(second_bytes, peer_second_payload);
                    let end = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    match end {
                        ProtocolMessage::ArtifactBatchEnd {
                            batch_token: peer_batch_token,
                        } if peer_batch_token == batch_token => {}
                        other => {
                            return Err(format!(
                                "expected artifact batch end, got {}",
                                other.kind()
                            ));
                        }
                    }
                    peer.send_message(&ProtocolMessage::PhaseDone {
                        phase: "artifact_transfer".to_string(),
                    })?;
                    thread::sleep(Duration::from_millis(100));
                    Ok(())
                },
            );
            let client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };
            let started = Instant::now();
            let progress = ProgressReporter::new(
                "sync_iroh_credit_gate_sender_test".to_string(),
                started,
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            );
            let mut metrics = SyncRunMetrics::start(started);
            let served = serve_artifact_requests_until_done(
                &client,
                &connection,
                &[json!({
                    "project": { "project_id": "proj_one" },
                    "artifacts": [
                        {
                            "artifact_id": first_artifact.artifact_id,
                            "project_id": first_artifact.project_id,
                            "content_sha256": first_artifact.content_sha256,
                            "size_bytes": first_artifact.size_bytes,
                        },
                        {
                            "artifact_id": second_artifact.artifact_id,
                            "project_id": second_artifact.project_id,
                            "content_sha256": second_artifact.content_sha256,
                            "size_bytes": second_artifact.size_bytes,
                        }
                    ]
                })],
                &mut metrics,
                &progress,
            );
            close_test_iroh_endpoint(&client_endpoint);
            let peer_result = peer_thread.join().expect("join Iroh credit gate peer");
            let _ = fs::remove_dir_all(&source_root);

            assert_eq!(peer_result, Ok(()));
            assert_eq!(served.expect("serve credited Iroh artifacts"), 2);
            assert_eq!(
                backend
                    .requests()
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/artifacts/files/resolve")
                    .count(),
                1
            );
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn iroh_sender_maps_resolver_error_to_credited_artifact_without_dropping_good_stream() {
            let unavailable_payload = b"unavailable credited payload".to_vec();
            let good_payload = b"good credited payload".to_vec();
            let unavailable_artifact = RemoteArtifact {
                artifact_id: "art_unavailable".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: test_sha256(&unavailable_payload),
                size_bytes: unavailable_payload.len() as u64,
            };
            let good_artifact = RemoteArtifact {
                artifact_id: "art_good".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: test_sha256(&good_payload),
                size_bytes: good_payload.len() as u64,
            };
            let source_root =
                env::temp_dir().join(format!("tuneforge-sync-source-test-{}", random_nonce()));
            fs::create_dir_all(&source_root).expect("create source root");
            let good_path = source_root.join("good.bin");
            fs::write(&good_path, &good_payload).expect("write good payload");
            let backend = TestBackendServer::start_with_staged_artifacts_files_and_resolve_errors(
                HashMap::new(),
                HashMap::from([(
                    good_artifact.artifact_id.clone(),
                    LocalArtifactFile {
                        artifact_id: good_artifact.artifact_id.clone(),
                        source_path: good_path,
                        content_sha256: good_artifact.content_sha256.clone(),
                        size_bytes: good_artifact.size_bytes,
                    },
                )]),
                HashMap::from([(
                    unavailable_artifact.artifact_id.clone(),
                    "/private/local/path/unavailable.wav missing".to_string(),
                )]),
            );
            let peer_unavailable = unavailable_artifact.clone();
            let peer_good = good_artifact.clone();
            let peer_good_payload = good_payload.clone();
            let (connection, client_endpoint, peer_thread) =
                spawn_test_iroh_sync_peer(move |mut peer, iroh_data| {
                    let batch_token = "batch_resolver_failure".to_string();
                    peer.send_message(&ProtocolMessage::ArtifactBatchRequest(
                        ArtifactBatchRequest {
                            batch_token: Some(batch_token.clone()),
                            artifacts: vec![
                                peer_unavailable.artifact_request(),
                                peer_good.artifact_request(),
                            ],
                        },
                    ))?;
                    let start = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    match start {
                        ProtocolMessage::ArtifactBatchStart {
                            batch_token: peer_batch_token,
                            artifact_count,
                        } if peer_batch_token == batch_token && artifact_count == 2 => {}
                        other => {
                            return Err(format!(
                                "expected artifact batch start, got {}",
                                other.kind()
                            ));
                        }
                    }
                    peer.send_message(&ProtocolMessage::ArtifactBatchCredit {
                        batch_token: batch_token.clone(),
                        artifact_ids: vec![peer_unavailable.artifact_id.clone()],
                    })?;
                    receive_test_iroh_unavailable_artifact_stream(
                        &iroh_data,
                        &batch_token,
                        &peer_unavailable,
                    )?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchCredit {
                        batch_token: batch_token.clone(),
                        artifact_ids: vec![peer_good.artifact_id.clone()],
                    })?;
                    let good_bytes =
                        receive_test_iroh_artifact_stream(&iroh_data, &batch_token, &peer_good)?;
                    assert_eq!(good_bytes, peer_good_payload);
                    let end = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    match end {
                        ProtocolMessage::ArtifactBatchEnd {
                            batch_token: peer_batch_token,
                        } if peer_batch_token == batch_token => {}
                        other => {
                            return Err(format!(
                                "expected artifact batch end, got {}",
                                other.kind()
                            ));
                        }
                    }
                    peer.send_message(&ProtocolMessage::PhaseDone {
                        phase: "artifact_transfer".to_string(),
                    })?;
                    thread::sleep(Duration::from_millis(100));
                    Ok(())
                });
            let client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };
            let started = Instant::now();
            let progress = ProgressReporter::new(
                "sync_iroh_resolver_failure_sender_test".to_string(),
                started,
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            );
            let mut metrics = SyncRunMetrics::start(started);
            let served = serve_artifact_requests_until_done(
                &client,
                &connection,
                &[json!({
                    "project": { "project_id": "proj_one" },
                    "artifacts": [
                        {
                            "artifact_id": unavailable_artifact.artifact_id,
                            "project_id": unavailable_artifact.project_id,
                            "content_sha256": unavailable_artifact.content_sha256,
                            "size_bytes": unavailable_artifact.size_bytes,
                        },
                        {
                            "artifact_id": good_artifact.artifact_id,
                            "project_id": good_artifact.project_id,
                            "content_sha256": good_artifact.content_sha256,
                            "size_bytes": good_artifact.size_bytes,
                        }
                    ]
                })],
                &mut metrics,
                &progress,
            );
            close_test_iroh_endpoint(&client_endpoint);
            let peer_result = peer_thread.join().expect("join Iroh resolver failure peer");
            let _ = fs::remove_dir_all(&source_root);

            assert_eq!(peer_result, Ok(()));
            assert_eq!(served.expect("serve mixed Iroh resolver batch"), 2);
            assert_eq!(metrics.total_served_bytes, good_payload.len() as u64);
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn iroh_sender_treats_post_resolver_missing_file_as_unavailable_stream() {
            let missing_payload = b"missing credited payload".to_vec();
            let good_payload = b"good credited payload".to_vec();
            let missing_artifact = RemoteArtifact {
                artifact_id: "art_missing_after_resolve".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: test_sha256(&missing_payload),
                size_bytes: missing_payload.len() as u64,
            };
            let good_artifact = RemoteArtifact {
                artifact_id: "art_good_after_resolve".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: test_sha256(&good_payload),
                size_bytes: good_payload.len() as u64,
            };
            let source_root =
                env::temp_dir().join(format!("tuneforge-sync-source-test-{}", random_nonce()));
            fs::create_dir_all(&source_root).expect("create source root");
            let missing_path = source_root.join("missing.bin");
            let good_path = source_root.join("good.bin");
            fs::write(&missing_path, &missing_payload).expect("write missing payload");
            fs::remove_file(&missing_path).expect("remove missing payload after metadata");
            fs::write(&good_path, &good_payload).expect("write good payload");
            let backend = TestBackendServer::start_with_staged_artifacts_and_files(
                HashMap::new(),
                HashMap::from([
                    (
                        missing_artifact.artifact_id.clone(),
                        LocalArtifactFile {
                            artifact_id: missing_artifact.artifact_id.clone(),
                            source_path: missing_path,
                            content_sha256: missing_artifact.content_sha256.clone(),
                            size_bytes: missing_artifact.size_bytes,
                        },
                    ),
                    (
                        good_artifact.artifact_id.clone(),
                        LocalArtifactFile {
                            artifact_id: good_artifact.artifact_id.clone(),
                            source_path: good_path,
                            content_sha256: good_artifact.content_sha256.clone(),
                            size_bytes: good_artifact.size_bytes,
                        },
                    ),
                ]),
            );
            let peer_missing = missing_artifact.clone();
            let peer_good = good_artifact.clone();
            let peer_good_payload = good_payload.clone();
            let (connection, client_endpoint, peer_thread) =
                spawn_test_iroh_sync_peer(move |mut peer, iroh_data| {
                    let batch_token = "batch_missing_after_resolve".to_string();
                    peer.send_message(&ProtocolMessage::ArtifactBatchRequest(
                        ArtifactBatchRequest {
                            batch_token: Some(batch_token.clone()),
                            artifacts: vec![
                                peer_missing.artifact_request(),
                                peer_good.artifact_request(),
                            ],
                        },
                    ))?;
                    let start = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    match start {
                        ProtocolMessage::ArtifactBatchStart {
                            batch_token: peer_batch_token,
                            artifact_count,
                        } if peer_batch_token == batch_token && artifact_count == 2 => {}
                        other => {
                            return Err(format!(
                                "expected artifact batch start, got {}",
                                other.kind()
                            ));
                        }
                    }
                    peer.send_message(&ProtocolMessage::ArtifactBatchCredit {
                        batch_token: batch_token.clone(),
                        artifact_ids: vec![peer_missing.artifact_id.clone()],
                    })?;
                    receive_test_iroh_unavailable_artifact_stream(
                        &iroh_data,
                        &batch_token,
                        &peer_missing,
                    )?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchCredit {
                        batch_token: batch_token.clone(),
                        artifact_ids: vec![peer_good.artifact_id.clone()],
                    })?;
                    let good_bytes =
                        receive_test_iroh_artifact_stream(&iroh_data, &batch_token, &peer_good)?;
                    assert_eq!(good_bytes, peer_good_payload);
                    let end = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    match end {
                        ProtocolMessage::ArtifactBatchEnd {
                            batch_token: peer_batch_token,
                        } if peer_batch_token == batch_token => {}
                        other => {
                            return Err(format!(
                                "expected artifact batch end, got {}",
                                other.kind()
                            ));
                        }
                    }
                    peer.send_message(&ProtocolMessage::PhaseDone {
                        phase: "artifact_transfer".to_string(),
                    })?;
                    thread::sleep(Duration::from_millis(100));
                    Ok(())
                });
            let client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };
            let started = Instant::now();
            let progress = ProgressReporter::new(
                "sync_iroh_missing_after_resolve_sender_test".to_string(),
                started,
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            );
            let mut metrics = SyncRunMetrics::start(started);
            let served = serve_artifact_requests_until_done(
                &client,
                &connection,
                &[json!({
                    "project": { "project_id": "proj_one" },
                    "artifacts": [
                        {
                            "artifact_id": missing_artifact.artifact_id,
                            "project_id": missing_artifact.project_id,
                            "content_sha256": missing_artifact.content_sha256,
                            "size_bytes": missing_artifact.size_bytes,
                        },
                        {
                            "artifact_id": good_artifact.artifact_id,
                            "project_id": good_artifact.project_id,
                            "content_sha256": good_artifact.content_sha256,
                            "size_bytes": good_artifact.size_bytes,
                        }
                    ]
                })],
                &mut metrics,
                &progress,
            );
            close_test_iroh_endpoint(&client_endpoint);
            let peer_result = peer_thread
                .join()
                .expect("join Iroh missing-after-resolve peer");
            let _ = fs::remove_dir_all(&source_root);

            assert_eq!(peer_result, Ok(()));
            assert_eq!(served.expect("serve Iroh missing-after-resolve batch"), 2);
            assert_eq!(metrics.total_served_bytes, good_payload.len() as u64);
        }

        #[cfg(not(target_os = "android"))]
        #[cfg(not(target_os = "android"))]
        #[cfg(not(target_os = "android"))]
        #[test]
        fn iroh_global_batch_end_before_missing_stream_fails_without_apply() {
            let payload = b"missing streamed payload".to_vec();
            let artifact = RemoteArtifact {
                artifact_id: "art_missing".to_string(),
                project_id: "proj_missing".to_string(),
                content_sha256: test_sha256(&payload),
                size_bytes: payload.len() as u64,
            };
            let backend = TestBackendServer::start_with_staged_artifacts(HashMap::new());
            let (connection, client_endpoint, peer_thread) =
                spawn_test_iroh_sync_peer(move |mut peer, _iroh_data| {
                    let request = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    let ProtocolMessage::ArtifactBatchRequest(request) = request else {
                        return Err("expected Iroh artifact batch request".to_string());
                    };
                    if request.artifacts.len() != 1 {
                        return Err(format!(
                            "expected 1 artifact request, got {}",
                            request.artifacts.len()
                        ));
                    }
                    let batch_token = request
                        .batch_token
                        .ok_or_else(|| "expected Iroh batch token".to_string())?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchStart {
                        batch_token: batch_token.clone(),
                        artifact_count: 1,
                    })?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchEnd { batch_token })?;
                    thread::sleep(Duration::from_millis(250));
                    Ok(())
                });
            let client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };
            let started = Instant::now();
            let progress = ProgressReporter::new(
                "sync_iroh_batch_end_missing_stream_test".to_string(),
                started,
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            );
            let mut apply_worker = RemoteApplyWorker::start(
                &client,
                "dev_peer",
                &json!({ "projects": [{ "project_id": "proj_missing" }] }),
                IROH_TRANSPORT_ID,
                progress.clone(),
            );
            let planned_projects = vec![PlannedRemoteProject {
                project_id: artifact.project_id.clone(),
                manifest: Some(json!({
                    "project": { "project_id": artifact.project_id.clone() },
                    "artifacts": [{
                        "artifact_id": artifact.artifact_id.clone(),
                        "project_id": artifact.project_id.clone(),
                        "content_sha256": artifact.content_sha256.clone(),
                        "size_bytes": artifact.size_bytes
                    }]
                })),
                plan: json!({
                    "actions": [{
                        "action_type": "fetch_artifact_content",
                        "provider_device_id": "dev_peer",
                        "item_id": artifact.artifact_id.clone(),
                        "project_id": artifact.project_id.clone(),
                        "content_sha256": artifact.content_sha256.clone()
                    }]
                }),
            }];
            let mut metrics = SyncRunMetrics::start(started);
            let mut timings = Vec::new();
            let mut received_artifacts = Vec::new();

            stage_remote_manifest_iroh_artifacts(
                &client,
                &connection,
                connection
                    .iroh_data_connection()
                    .expect("test Iroh data connection"),
                "dev_peer",
                planned_projects,
                &mut apply_worker,
                &mut received_artifacts,
                &mut metrics,
                &mut timings,
                &progress,
            );
            let project_results = apply_worker.finish(&mut timings);
            let requests = backend.requests();
            let temp_files = collect_test_files(&backend.transport_temp_root());
            close_test_iroh_endpoint(&client_endpoint);
            peer_thread
                .join()
                .expect("join Iroh early-end peer")
                .expect("Iroh early-end peer completed");

            assert_eq!(
                requests
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/reconciliation/apply")
                    .count(),
                0,
                "early batch end must not call reconciliation apply; requests: {requests:?}"
            );
            assert!(
                temp_files.is_empty(),
                "Iroh early batch end left temp files: {temp_files:?}"
            );
            let transfer_counts = transfer_counts(&received_artifacts);
            assert_eq!(transfer_counts.failed, 1);
            assert_eq!(project_results.len(), 1);
            assert_eq!(project_results[0].project_id, "proj_missing");
            assert_eq!(project_results[0].status, "failed");
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn iroh_global_batch_abort_fails_ready_projects_without_apply() {
            let already_payload = b"already staged payload".to_vec();
            let first_payload = b"first streamed payload".to_vec();
            let second_payload = b"second streamed payload".to_vec();
            let already_artifact = RemoteArtifact {
                artifact_id: "art_already".to_string(),
                project_id: "proj_already".to_string(),
                content_sha256: test_sha256(&already_payload),
                size_bytes: already_payload.len() as u64,
            };
            let first_artifact = RemoteArtifact {
                artifact_id: "art_first".to_string(),
                project_id: "proj_first".to_string(),
                content_sha256: test_sha256(&first_payload),
                size_bytes: first_payload.len() as u64,
            };
            let second_artifact = RemoteArtifact {
                artifact_id: "art_second".to_string(),
                project_id: "proj_second".to_string(),
                content_sha256: test_sha256(&second_payload),
                size_bytes: second_payload.len() as u64,
            };
            let backend = TestBackendServer::start_with_staged_artifacts(HashMap::from([(
                already_artifact.content_sha256.clone(),
                already_artifact.size_bytes,
            )]));
            let backend_requests = Arc::clone(&backend.requests);
            let peer_first_artifact = first_artifact.clone();
            let peer_first_payload = first_payload.clone();
            let (connection, client_endpoint, peer_thread) =
                spawn_test_iroh_sync_peer(move |mut peer, iroh_data| {
                    let request = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    let ProtocolMessage::ArtifactBatchRequest(request) = request else {
                        return Err("expected Iroh artifact batch request".to_string());
                    };
                    if request.artifacts.len() != 2 {
                        return Err(format!(
                            "expected 2 artifact requests, got {}",
                            request.artifacts.len()
                        ));
                    }
                    let batch_token = request
                        .batch_token
                        .ok_or_else(|| "expected Iroh batch token".to_string())?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchStart {
                        batch_token: batch_token.clone(),
                        artifact_count: request.artifacts.len() as u64,
                    })?;
                    let credit = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    match credit {
                        ProtocolMessage::ArtifactBatchCredit {
                            batch_token: peer_batch_token,
                            artifact_ids,
                        } if peer_batch_token == batch_token
                            && artifact_ids.contains(&peer_first_artifact.artifact_id) => {}
                        other => {
                            return Err(format!(
                                "expected Iroh batch credit for first artifact, got {}",
                                other.kind()
                            ));
                        }
                    }
                    send_test_iroh_artifact_stream(
                        &iroh_data,
                        &batch_token,
                        &peer_first_artifact,
                        &peer_first_payload,
                    )?;
                    let wait_started = Instant::now();
                    loop {
                        let staged = backend_requests
                            .lock()
                            .map_err(|_| "test backend requests unavailable".to_string())?
                            .iter()
                            .any(|path| path == "/api/v1/sync/artifacts/staging");
                        if staged {
                            break;
                        }
                        if wait_started.elapsed() > Duration::from_secs(5) {
                            return Err("first Iroh artifact was not staged before control error"
                                .to_string());
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    peer.send_message(&ProtocolMessage::ArtifactBatchAbort {
                        batch_token,
                        message: "control error before second Iroh stream".to_string(),
                    })?;
                    thread::sleep(Duration::from_millis(250));
                    Ok(())
                });
            let client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };
            let started = Instant::now();
            let progress = ProgressReporter::new(
                "sync_iroh_batch_abort_ready_projects_test".to_string(),
                started,
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            );
            let mut apply_worker = RemoteApplyWorker::start(
                &client,
                "dev_peer",
                &json!({
                    "projects": [
                        { "project_id": "proj_already" },
                        { "project_id": "proj_first" },
                        { "project_id": "proj_second" }
                    ],
                    "delete_tombstones": [
                        { "project_id": "proj_deleted", "tombstone_id": "del_deleted" }
                    ]
                }),
                IROH_TRANSPORT_ID,
                progress.clone(),
            );
            let manifest_for = |artifact: &RemoteArtifact| {
                json!({
                    "project": { "project_id": artifact.project_id.clone() },
                    "artifacts": [{
                        "artifact_id": artifact.artifact_id.clone(),
                        "project_id": artifact.project_id.clone(),
                        "content_sha256": artifact.content_sha256.clone(),
                        "size_bytes": artifact.size_bytes
                    }]
                })
            };
            let fetch_plan_for = |artifact: &RemoteArtifact| {
                json!({
                    "actions": [{
                        "action_type": "fetch_artifact_content",
                        "provider_device_id": "dev_peer",
                        "item_id": artifact.artifact_id.clone(),
                        "project_id": artifact.project_id.clone(),
                        "content_sha256": artifact.content_sha256.clone()
                    }]
                })
            };
            let planned_projects = vec![
                PlannedRemoteProject {
                    project_id: already_artifact.project_id.clone(),
                    manifest: Some(manifest_for(&already_artifact)),
                    plan: fetch_plan_for(&already_artifact),
                },
                PlannedRemoteProject {
                    project_id: "proj_deleted".to_string(),
                    manifest: None,
                    plan: json!({
                        "actions": [{
                            "action_type": "apply_delete_tombstone",
                            "project_id": "proj_deleted",
                            "item_id": "proj_deleted"
                        }]
                    }),
                },
                PlannedRemoteProject {
                    project_id: first_artifact.project_id.clone(),
                    manifest: Some(manifest_for(&first_artifact)),
                    plan: fetch_plan_for(&first_artifact),
                },
                PlannedRemoteProject {
                    project_id: second_artifact.project_id.clone(),
                    manifest: Some(manifest_for(&second_artifact)),
                    plan: fetch_plan_for(&second_artifact),
                },
            ];
            let mut metrics = SyncRunMetrics::start(started);
            let mut timings = Vec::new();
            let mut received_artifacts = Vec::new();

            stage_remote_manifest_iroh_artifacts(
                &client,
                &connection,
                connection
                    .iroh_data_connection()
                    .expect("test Iroh data connection"),
                "dev_peer",
                planned_projects,
                &mut apply_worker,
                &mut received_artifacts,
                &mut metrics,
                &mut timings,
                &progress,
            );
            let project_results = apply_worker.finish(&mut timings);
            let requests = backend.requests();
            let temp_files = collect_test_files(&backend.transport_temp_root());
            close_test_iroh_endpoint(&client_endpoint);
            peer_thread
                .join()
                .expect("join Iroh abort peer")
                .expect("Iroh abort peer completed");

            assert_eq!(
                requests
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/reconciliation/apply")
                    .count(),
                0,
                "fatal abort must not call reconciliation apply; requests: {requests:?}"
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/artifacts/staging")
                    .count(),
                1
            );
            assert!(
                temp_files.is_empty(),
                "Iroh staging temp files should be cleaned up: {temp_files:?}"
            );
            let transfer_counts = transfer_counts(&received_artifacts);
            assert_eq!(transfer_counts.already_staged, 1);
            assert_eq!(transfer_counts.received, 1);
            assert_eq!(transfer_counts.failed, 1);
            assert_eq!(metrics.credit_grants, 2);
            assert_eq!(
                metrics.scratch_peak_bytes,
                first_artifact
                    .size_bytes
                    .saturating_add(second_artifact.size_bytes)
            );
            assert!(metrics.staging_peak_bytes >= first_artifact.size_bytes);
            assert_eq!(metrics.max_active_streams, 1);
            assert!(metrics.credit_revokes >= 1);
            assert!(metrics.credit_revokes <= 2);
            let mut result_project_ids = project_results
                .iter()
                .map(|result| {
                    assert_eq!(result.status, "failed");
                    result.project_id.as_str()
                })
                .collect::<Vec<_>>();
            result_project_ids.sort_unstable();
            assert_eq!(
                result_project_ids,
                vec!["proj_already", "proj_deleted", "proj_first", "proj_second"]
            );
            let import_counts = import_outcome_counts(&project_results);
            assert_eq!(import_counts.failed, 4);
            assert_eq!(
                sync_result_status(&[], import_counts.failed),
                "completed_with_errors"
            );
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn iroh_retry_reuses_staged_artifact_and_retransfers_incomplete_temp() {
            let reused_payload = b"verified staged payload".to_vec();
            let retry_payload = b"retry streamed payload after interruption".to_vec();
            let reused_artifact = RemoteArtifact {
                artifact_id: "art_reused".to_string(),
                project_id: "proj_retry".to_string(),
                content_sha256: test_sha256(&reused_payload),
                size_bytes: reused_payload.len() as u64,
            };
            let retry_artifact = RemoteArtifact {
                artifact_id: "art_retry".to_string(),
                project_id: "proj_retry".to_string(),
                content_sha256: test_sha256(&retry_payload),
                size_bytes: retry_payload.len() as u64,
            };
            let manifest = json!({
                "project": { "project_id": "proj_retry" },
                "artifacts": [
                    {
                        "artifact_id": reused_artifact.artifact_id.clone(),
                        "project_id": reused_artifact.project_id.clone(),
                        "content_sha256": reused_artifact.content_sha256.clone(),
                        "size_bytes": reused_artifact.size_bytes
                    },
                    {
                        "artifact_id": retry_artifact.artifact_id.clone(),
                        "project_id": retry_artifact.project_id.clone(),
                        "content_sha256": retry_artifact.content_sha256.clone(),
                        "size_bytes": retry_artifact.size_bytes
                    }
                ]
            });
            let plan = json!({
                "actions": [
                    {
                        "action_type": "fetch_artifact_content",
                        "provider_device_id": "dev_peer",
                        "item_id": reused_artifact.artifact_id.clone(),
                        "project_id": reused_artifact.project_id.clone(),
                        "content_sha256": reused_artifact.content_sha256.clone()
                    },
                    {
                        "action_type": "fetch_artifact_content",
                        "provider_device_id": "dev_peer",
                        "item_id": retry_artifact.artifact_id.clone(),
                        "project_id": retry_artifact.project_id.clone(),
                        "content_sha256": retry_artifact.content_sha256.clone()
                    }
                ]
            });
            let backend = TestBackendServer::start_with_staged_artifacts(HashMap::from([(
                reused_artifact.content_sha256.clone(),
                reused_artifact.size_bytes,
            )]));
            let client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };

            let first_peer_artifact = retry_artifact.clone();
            let first_partial_payload = retry_payload[..retry_payload.len() / 2].to_vec();
            let (first_connection, first_endpoint, first_peer_thread) =
                spawn_test_iroh_sync_peer(move |mut peer, iroh_data| {
                    let request = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    let ProtocolMessage::ArtifactBatchRequest(request) = request else {
                        return Err("expected first Iroh artifact batch request".to_string());
                    };
                    if request.artifacts.len() != 1
                        || request.artifacts[0].artifact_id != first_peer_artifact.artifact_id
                    {
                        return Err(format!(
                            "expected only retry artifact, got {:?}",
                            request
                                .artifacts
                                .iter()
                                .map(|artifact| artifact.artifact_id.as_str())
                                .collect::<Vec<_>>()
                        ));
                    }
                    let batch_token = request
                        .batch_token
                        .ok_or_else(|| "expected first Iroh batch token".to_string())?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchStart {
                        batch_token: batch_token.clone(),
                        artifact_count: 1,
                    })?;
                    let credit = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    match credit {
                        ProtocolMessage::ArtifactBatchCredit {
                            batch_token: peer_batch_token,
                            artifact_ids,
                        } if peer_batch_token == batch_token
                            && artifact_ids.contains(&first_peer_artifact.artifact_id) => {}
                        other => {
                            return Err(format!(
                                "expected first Iroh batch credit, got {}",
                                other.kind()
                            ));
                        }
                    }
                    send_test_iroh_artifact_stream(
                        &iroh_data,
                        &batch_token,
                        &first_peer_artifact,
                        &first_partial_payload,
                    )?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchEnd { batch_token })?;
                    thread::sleep(Duration::from_millis(250));
                    Ok(())
                });
            let first_started = Instant::now();
            let first_progress = ProgressReporter::new(
                "sync_iroh_retry_first_test".to_string(),
                first_started,
                Arc::new(Mutex::new(SharedStatus::default())),
                first_connection.clone(),
                RunCancellationToken::default(),
            );
            let mut first_apply_worker = RemoteApplyWorker::start(
                &client,
                "dev_peer",
                &json!({ "projects": [{ "project_id": "proj_retry" }] }),
                IROH_TRANSPORT_ID,
                first_progress.clone(),
            );
            let mut first_metrics = SyncRunMetrics::start(first_started);
            let mut first_timings = Vec::new();
            let mut first_received_artifacts = Vec::new();

            stage_remote_manifest_iroh_artifacts(
                &client,
                &first_connection,
                first_connection
                    .iroh_data_connection()
                    .expect("first test Iroh data connection"),
                "dev_peer",
                vec![PlannedRemoteProject {
                    project_id: "proj_retry".to_string(),
                    manifest: Some(manifest.clone()),
                    plan: plan.clone(),
                }],
                &mut first_apply_worker,
                &mut first_received_artifacts,
                &mut first_metrics,
                &mut first_timings,
                &first_progress,
            );
            let first_project_results = first_apply_worker.finish(&mut first_timings);
            let first_requests = backend.requests();
            let first_temp_files = collect_test_files(&backend.transport_temp_root());
            close_test_iroh_endpoint(&first_endpoint);
            first_peer_thread
                .join()
                .expect("join first retry peer")
                .expect("first retry peer completed");

            let first_counts = transfer_counts(&first_received_artifacts);
            assert_eq!(first_counts.already_staged, 1);
            assert_eq!(first_counts.received, 0);
            assert_eq!(first_counts.failed, 1);
            assert_eq!(first_project_results.len(), 1);
            assert_eq!(first_project_results[0].status, "failed");
            assert_eq!(
                first_requests
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/reconciliation/apply")
                    .count(),
                0,
                "incomplete retry transfer must not apply: {first_requests:?}"
            );
            assert!(
                first_temp_files.is_empty(),
                "incomplete retry transfer left temp files: {first_temp_files:?}"
            );

            let stale_temp_path = backend.transport_temp_root().join(format!(
                "0-stale-{}-{}",
                random_nonce(),
                retry_artifact.content_sha256
            ));
            fs::write(&stale_temp_path, &retry_payload[..retry_payload.len() / 2])
                .expect("write stale orphan temp artifact");
            assert!(
                stale_temp_path.exists(),
                "test must create stale orphan temp artifact before retry"
            );
            let retry_client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };

            let second_peer_artifact = retry_artifact.clone();
            let second_payload = retry_payload.clone();
            let (second_connection, second_endpoint, second_peer_thread) =
                spawn_test_iroh_sync_peer(move |mut peer, iroh_data| {
                    let request = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    let ProtocolMessage::ArtifactBatchRequest(request) = request else {
                        return Err("expected second Iroh artifact batch request".to_string());
                    };
                    if request.artifacts.len() != 1
                        || request.artifacts[0].artifact_id != second_peer_artifact.artifact_id
                    {
                        return Err(format!(
                            "expected only retry artifact on retry, got {:?}",
                            request
                                .artifacts
                                .iter()
                                .map(|artifact| artifact.artifact_id.as_str())
                                .collect::<Vec<_>>()
                        ));
                    }
                    let batch_token = request
                        .batch_token
                        .ok_or_else(|| "expected second Iroh batch token".to_string())?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchStart {
                        batch_token: batch_token.clone(),
                        artifact_count: 1,
                    })?;
                    let credit = read_message_accepting_status(
                        "artifact request/transfer",
                        || peer.read_message(),
                        |_| {},
                    )?;
                    match credit {
                        ProtocolMessage::ArtifactBatchCredit {
                            batch_token: peer_batch_token,
                            artifact_ids,
                        } if peer_batch_token == batch_token
                            && artifact_ids.contains(&second_peer_artifact.artifact_id) => {}
                        other => {
                            return Err(format!(
                                "expected second Iroh batch credit, got {}",
                                other.kind()
                            ));
                        }
                    }
                    send_test_iroh_artifact_stream(
                        &iroh_data,
                        &batch_token,
                        &second_peer_artifact,
                        &second_payload,
                    )?;
                    peer.send_message(&ProtocolMessage::ArtifactBatchEnd { batch_token })?;
                    thread::sleep(Duration::from_millis(250));
                    Ok(())
                });
            let second_started = Instant::now();
            let second_progress = ProgressReporter::new(
                "sync_iroh_retry_second_test".to_string(),
                second_started,
                Arc::new(Mutex::new(SharedStatus::default())),
                second_connection.clone(),
                RunCancellationToken::default(),
            );
            let mut second_apply_worker = RemoteApplyWorker::start(
                &retry_client,
                "dev_peer",
                &json!({ "projects": [{ "project_id": "proj_retry" }] }),
                IROH_TRANSPORT_ID,
                second_progress.clone(),
            );
            let mut second_metrics = SyncRunMetrics::start(second_started);
            let mut second_timings = Vec::new();
            let mut second_received_artifacts = Vec::new();

            stage_remote_manifest_iroh_artifacts(
                &retry_client,
                &second_connection,
                second_connection
                    .iroh_data_connection()
                    .expect("second test Iroh data connection"),
                "dev_peer",
                vec![PlannedRemoteProject {
                    project_id: "proj_retry".to_string(),
                    manifest: Some(manifest),
                    plan,
                }],
                &mut second_apply_worker,
                &mut second_received_artifacts,
                &mut second_metrics,
                &mut second_timings,
                &second_progress,
            );
            let second_project_results = second_apply_worker.finish(&mut second_timings);
            let second_requests = backend.requests();
            let second_temp_files = collect_test_files(&backend.transport_temp_root());
            close_test_iroh_endpoint(&second_endpoint);
            second_peer_thread
                .join()
                .expect("join second retry peer")
                .expect("second retry peer completed");

            let second_counts = transfer_counts(&second_received_artifacts);
            assert_eq!(second_counts.already_staged, 1);
            assert_eq!(second_counts.received, 1);
            assert_eq!(second_counts.failed, 0);
            assert_eq!(second_project_results.len(), 1);
            assert_ne!(second_project_results[0].status, "failed");
            assert_eq!(
                second_requests
                    .iter()
                    .filter(|path| path.as_str() == "/api/v1/sync/artifacts/staging")
                    .count(),
                1,
                "only successful retry should stage received bytes: {second_requests:?}"
            );
            assert_eq!(
                second_requests
                    .iter()
                    .filter(|path| {
                        path.as_str()
                            == format!(
                                "/api/v1/sync/artifacts/staging/{}",
                                retry_artifact.content_sha256
                            )
                    })
                    .count(),
                2,
                "retry artifact should be rechecked and retransferred, not treated as verified"
            );
            assert!(
                second_temp_files.is_empty(),
                "successful retry left temp files: {second_temp_files:?}"
            );
            assert!(
                !stale_temp_path.exists(),
                "retry should clean stale orphan temp artifact from previous process"
            );
        }

        #[test]
        fn artifact_file_resolver_response_maps_records_and_errors() {
            let first_artifact = RemoteArtifact {
                artifact_id: "art_one".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: "hash_one".to_string(),
                size_bytes: 42,
            };
            let second_artifact = RemoteArtifact {
                artifact_id: "art_two".to_string(),
                project_id: "proj_two".to_string(),
                content_sha256: "hash_two".to_string(),
                size_bytes: 84,
            };
            let response = json!({
                "records": [{
                    "artifact_id": "art_one",
                    "source_path": "/tmp/tuneforge/art_one.wav",
                    "content_sha256": "hash_one",
                    "size_bytes": 42
                }],
                "errors": [{
                    "artifact_id": "art_two",
                    "message": "/private/local/path/art_two.wav is missing"
                }]
            });

            let resolved =
                parse_artifact_file_resolve_response(&response, &[first_artifact, second_artifact])
                    .expect("parse resolver response");

            assert_eq!(resolved.files.len(), 1);
            assert_eq!(
                resolved
                    .files
                    .get("art_one")
                    .map(|file| file.source_path.as_path()),
                Some(Path::new("/tmp/tuneforge/art_one.wav"))
            );
            let failure = resolved
                .failures
                .get("art_two")
                .expect("resolver error maps to requested artifact");
            assert_eq!(failure.message, UNAVAILABLE_ARTIFACT_TRANSFER_MESSAGE);
            assert!(!failure.message.contains("/private/local/path"));
        }

        #[test]
        fn artifact_file_resolver_omitted_requested_artifact_remains_backend_error() {
            let artifact = RemoteArtifact {
                artifact_id: "art_one".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: "hash_one".to_string(),
                size_bytes: 42,
            };
            let response = json!({
                "records": [],
                "errors": []
            });
            let error = parse_artifact_file_resolve_response(&response, &[artifact])
                .expect_err("surface omitted resolver entry");

            assert!(error
                .to_string()
                .contains("Backend artifact resolver omitted artifact art_one."));
            assert!(!error.to_string().contains("/tmp"));
        }

        #[test]
        fn manifest_offer_round_trip_preserves_hash_bound_lyrics_payload_numbers() {
            let lyrics_payload_json = concat!(
                r#"{"segments":[{"end":12.209999999999999,"#,
                r#""start":11.639999999999999,"text":"first line"},"#,
                r#"{"end":21.540000000000003,"#,
                r#""start":20.329999999999998,"text":"second line"}]}"#
            );
            let lyrics_payload =
                serde_json::from_str::<Value>(lyrics_payload_json).expect("parse lyrics payload");
            let content_sha256 =
                hex_digest(Sha256::digest(lyrics_payload_json.as_bytes()).as_slice());
            let manifest = json!({
                "artifacts": [],
                "entity_revisions": [{
                    "content_sha256": content_sha256,
                    "entity_id": "lyrics-main",
                    "entity_type": "lyrics",
                    "metadata": {},
                    "payload": lyrics_payload,
                    "revision_id": "lyrics-rev",
                    "revision_type": "snapshot",
                    "state": "active",
                }],
                "project": { "project_id": "proj_lyrics" },
            });
            let message = ProtocolMessage::ManifestOffer(ManifestOffer {
                metadata: json!({ "projects": [] }),
                project_manifests: vec![manifest],
                manifest_errors: Vec::new(),
            });

            let encoded = serde_json::to_vec(&message).expect("serialize manifest offer");
            let decoded =
                serde_json::from_slice::<ProtocolMessage>(&encoded).expect("decode manifest offer");
            let decoded_manifest = match decoded {
                ProtocolMessage::ManifestOffer(offer) => offer
                    .project_manifests
                    .into_iter()
                    .next()
                    .expect("project manifest"),
                other => panic!("expected manifest offer, got {}", other.kind()),
            };
            let decoded_payload = decoded_manifest
                .pointer("/entity_revisions/0/payload")
                .expect("lyrics payload");
            let decoded_payload_bytes =
                serde_json::to_vec(decoded_payload).expect("serialize decoded lyrics payload");
            let decoded_payload_json =
                std::str::from_utf8(&decoded_payload_bytes).expect("utf8 payload json");

            assert_eq!(decoded_payload_json, lyrics_payload_json);
            assert!(decoded_payload_json.contains("11.639999999999999"));
            assert!(decoded_payload_json.contains("20.329999999999998"));
            assert_eq!(
                hex_digest(Sha256::digest(&decoded_payload_bytes).as_slice()),
                content_sha256
            );

            let apply_body = reconciliation_apply_body(
                "dev_peer",
                &json!({ "projects": [{ "project_id": "proj_lyrics" }] }),
                &[decoded_manifest],
                &[],
                "tcp",
            );
            let apply_body_payload = apply_body
                .pointer("/project_manifests/0/entity_revisions/0/payload")
                .expect("apply body lyrics payload");
            let apply_body_payload_bytes =
                serde_json::to_vec(apply_body_payload).expect("serialize apply body payload");

            assert_eq!(apply_body_payload_bytes, decoded_payload_bytes);
            assert_eq!(
                hex_digest(Sha256::digest(&apply_body_payload_bytes).as_slice()),
                content_sha256
            );
        }

        #[test]
        fn batch_manifest_response_maps_manifests_and_errors() {
            let response = json!({
                "project_manifests": [{
                    "project": { "project_id": "proj_ok" },
                    "artifacts": []
                }],
                "manifest_errors": [{
                    "project_id": "proj_failed",
                    "message": "manifest failed"
                }]
            });

            let offer = manifest_offer_from_batch_response(
                &response,
                &[
                    "proj_ok".to_string(),
                    "proj_failed".to_string(),
                    "proj_omitted".to_string(),
                ],
            );

            assert_eq!(offer.project_manifests.len(), 1);
            assert_eq!(offer.manifest_errors.len(), 2);
            assert_eq!(offer.manifest_errors[0].project_id, "proj_failed");
            assert_eq!(offer.manifest_errors[0].message, "manifest failed");
            assert_eq!(offer.manifest_errors[1].project_id, "proj_omitted");
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn large_local_manifest_export_batches_and_returns_all_manifests() {
            let project_ids = (0..(LOCAL_MANIFEST_EXPORT_BATCH_SIZE * 2 + 1))
                .map(|index| format!("proj_{index:02}"))
                .collect::<Vec<_>>();
            let project_manifests = project_ids
                .iter()
                .map(|project_id| (project_id.clone(), test_project_manifest(project_id)))
                .collect::<HashMap<_, _>>();
            let backend = TestBackendServer::start_with_project_manifests(project_manifests);
            let client = test_backend_client(&backend);

            let offer = load_local_project_manifests(&client, &project_ids);

            assert!(offer.manifest_errors.is_empty());
            assert_eq!(offer.project_manifests.len(), project_ids.len());
            assert_eq!(
                offer
                    .project_manifests
                    .iter()
                    .map(manifest_project_id)
                    .collect::<Vec<_>>(),
                project_ids
            );
            let manifest_batches = backend.manifest_batch_requests();
            assert_eq!(manifest_batches.len(), 3);
            assert_eq!(manifest_batches[0].len(), LOCAL_MANIFEST_EXPORT_BATCH_SIZE);
            assert_eq!(manifest_batches[1].len(), LOCAL_MANIFEST_EXPORT_BATCH_SIZE);
            assert_eq!(manifest_batches[2].len(), 1);
            assert_eq!(
                manifest_batches
                    .iter()
                    .flatten()
                    .cloned()
                    .collect::<Vec<_>>(),
                project_ids
            );
            assert!(backend.manifest_get_requests().is_empty());
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn unavailable_manifest_batch_route_falls_back_to_single_project_exports() {
            let project_ids = (0..(LOCAL_MANIFEST_EXPORT_BATCH_SIZE + 1))
                .map(|index| format!("proj_{index:02}"))
                .collect::<Vec<_>>();
            let project_manifests = project_ids
                .iter()
                .map(|project_id| (project_id.clone(), test_project_manifest(project_id)))
                .collect::<HashMap<_, _>>();
            let backend = TestBackendServer::start_with_project_manifests_and_batch_status(
                project_manifests,
                404,
            );
            let client = test_backend_client(&backend);

            let offer = load_local_project_manifests(&client, &project_ids);

            assert!(offer.manifest_errors.is_empty());
            assert_eq!(offer.project_manifests.len(), project_ids.len());
            assert_eq!(
                offer
                    .project_manifests
                    .iter()
                    .map(manifest_project_id)
                    .collect::<Vec<_>>(),
                project_ids
            );
            assert_eq!(
                backend.manifest_batch_requests(),
                vec![project_ids[..LOCAL_MANIFEST_EXPORT_BATCH_SIZE].to_vec()]
            );
            assert_eq!(backend.manifest_get_requests(), project_ids);
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn failed_manifest_batch_marks_only_that_batch() {
            let project_ids = (0..(LOCAL_MANIFEST_EXPORT_BATCH_SIZE * 2 + 1))
                .map(|index| format!("proj_{index:02}"))
                .collect::<Vec<_>>();
            let failed_batch = project_ids
                [LOCAL_MANIFEST_EXPORT_BATCH_SIZE..LOCAL_MANIFEST_EXPORT_BATCH_SIZE * 2]
                .to_vec();
            let project_manifests = project_ids
                .iter()
                .map(|project_id| (project_id.clone(), test_project_manifest(project_id)))
                .collect::<HashMap<_, _>>();
            let mut manifest_batch_status_by_project_ids = HashMap::new();
            manifest_batch_status_by_project_ids.insert(failed_batch.clone(), 500);
            let backend = TestBackendServer::start_with_project_manifests_and_batch_statuses(
                project_manifests,
                manifest_batch_status_by_project_ids,
            );
            let client = test_backend_client(&backend);

            let offer = load_local_project_manifests(&client, &project_ids);

            let mut expected_manifest_project_ids =
                project_ids[..LOCAL_MANIFEST_EXPORT_BATCH_SIZE].to_vec();
            expected_manifest_project_ids
                .extend_from_slice(&project_ids[LOCAL_MANIFEST_EXPORT_BATCH_SIZE * 2..]);
            assert_eq!(
                offer
                    .project_manifests
                    .iter()
                    .map(manifest_project_id)
                    .collect::<Vec<_>>(),
                expected_manifest_project_ids
            );
            assert_eq!(
                offer
                    .manifest_errors
                    .iter()
                    .map(|error| error.project_id.clone())
                    .collect::<Vec<_>>(),
                failed_batch
            );
            assert!(offer
                .manifest_errors
                .iter()
                .all(|error| error.message.contains("backend HTTP 500")));
            let manifest_batches = backend.manifest_batch_requests();
            assert_eq!(manifest_batches.len(), 3);
            assert_eq!(
                manifest_batches
                    .iter()
                    .flatten()
                    .cloned()
                    .collect::<Vec<_>>(),
                project_ids
            );
            assert!(backend.manifest_get_requests().is_empty());
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn manifest_timeout_io_errors_are_stable_and_privacy_safe() {
            let sensitive_project_id = "proj_secret_123";
            let sensitive_path = "/Users/example/Music/private/session.wav";
            let sensitive_manifest_payload = r#"{"project":{"project_id":"proj_secret_123"},"source_path":"/Users/example/Music/private/session.wav"}"#;
            let sensitive_request_path = "/api/v1/sync/projects/proj_secret_123/manifest";

            for kind in [io::ErrorKind::TimedOut, io::ErrorKind::WouldBlock] {
                let error = backend_http_io_error(
                    io::Error::new(
                        kind,
                        format!(
                            "{sensitive_project_id} {sensitive_path} {sensitive_manifest_payload} {sensitive_request_path}"
                        ),
                    ),
                    MANIFEST_EXPORT_HTTP_TIMEOUT,
                );
                let message = error.to_string();

                assert_eq!(
                    message,
                    "Local backend HTTP request timed out after 300 seconds."
                );
                assert_eq!(
                    phase_context_error("local manifest export", message.clone()),
                    "Sync transport local manifest export stalled: Local backend HTTP request timed out after 300 seconds."
                );
                for sensitive_value in [
                    sensitive_project_id,
                    sensitive_path,
                    sensitive_manifest_payload,
                    sensitive_request_path,
                ] {
                    assert!(
                        !message.contains(sensitive_value),
                        "timeout message leaked sensitive value: {message}"
                    );
                }
            }
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn manifest_export_keeps_transfer_sensitive_constants_stable() {
            assert_eq!(LOCAL_MANIFEST_EXPORT_BATCH_SIZE, 24);
            assert_eq!(MANIFEST_EXPORT_HTTP_TIMEOUT, Duration::from_secs(300));
            assert_eq!(HTTP_TIMEOUT, Duration::from_secs(45));
            assert_eq!(BACKEND_PREFLIGHT_TIMEOUT, Duration::from_secs(3));
            assert_eq!(IROH_ARTIFACT_PARALLELISM, 4);
            assert_eq!(IROH_ARTIFACT_RECEIVE_BYTE_BUDGET, 4 * 1024 * 1024 * 1024);
            assert_eq!(IROH_STREAM_RECEIVE_WINDOW_BYTES, 32 * 1024 * 1024);
            assert_eq!(IROH_CONNECTION_RECEIVE_WINDOW_BYTES, 128 * 1024 * 1024);
            assert_eq!(IROH_SEND_WINDOW_BYTES, 64 * 1024 * 1024);
        }

        #[test]
        fn offered_artifacts_are_scoped_to_manifest_metadata() {
            let manifests = vec![json!({
                "artifacts": [{
                    "artifact_id": "art_allowed",
                    "project_id": "proj_allowed",
                    "content_sha256": "abc123",
                    "size_bytes": 42,
                }]
            })];

            let offered = offered_artifacts(&manifests);

            assert_eq!(offered.len(), 1);
            assert_eq!(
                offered
                    .iter()
                    .find(|artifact| artifact.artifact_id == "art_allowed")
                    .map(|artifact| artifact.content_sha256.as_str()),
                Some("abc123")
            );
            assert!(requested_offered_artifact(
                &offered,
                &ArtifactRequest {
                    artifact_id: "art_unknown".to_string(),
                    project_id: None,
                    content_sha256: "abc123".to_string(),
                    size_bytes: 42,
                }
            )
            .is_err());
        }

        #[test]
        fn batch_artifact_requests_validate_against_offered_manifest() {
            let manifests = vec![json!({
                "artifacts": [{
                    "artifact_id": "art_one",
                    "project_id": "proj_one",
                    "content_sha256": "hash_one",
                    "size_bytes": 10,
                }, {
                    "artifact_id": "art_two",
                    "project_id": "proj_two",
                    "content_sha256": "hash_two",
                    "size_bytes": 20,
                }]
            })];
            let offered = offered_artifacts(&manifests);

            let artifacts = requested_offered_artifact_batch(
                &offered,
                &ArtifactBatchRequest {
                    batch_token: None,
                    artifacts: vec![
                        ArtifactRequest {
                            artifact_id: "art_one".to_string(),
                            project_id: Some("proj_one".to_string()),
                            content_sha256: "hash_one".to_string(),
                            size_bytes: 10,
                        },
                        ArtifactRequest {
                            artifact_id: "art_two".to_string(),
                            project_id: Some("proj_two".to_string()),
                            content_sha256: "hash_two".to_string(),
                            size_bytes: 20,
                        },
                    ],
                },
            )
            .expect("batch request is valid");

            assert_eq!(
                artifacts
                    .iter()
                    .map(|artifact| artifact.artifact_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["art_one", "art_two"]
            );

            let mismatch = requested_offered_artifact_batch(
                &offered,
                &ArtifactBatchRequest {
                    batch_token: None,
                    artifacts: vec![ArtifactRequest {
                        artifact_id: "art_one".to_string(),
                        project_id: Some("proj_one".to_string()),
                        content_sha256: "wrong_hash".to_string(),
                        size_bytes: 10,
                    }],
                },
            )
            .expect_err("reject mismatch");
            assert!(mismatch.contains("not offered"));
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn sender_batch_continues_after_local_artifact_hash_race() {
            let expected_first_bytes = b"first artifact content".to_vec();
            let changed_first_bytes = b"FIRST artifact content".to_vec();
            assert_eq!(expected_first_bytes.len(), changed_first_bytes.len());
            let second_bytes = b"second artifact content".to_vec();
            let first_artifact = RemoteArtifact {
                artifact_id: "art_changed".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: test_sha256(&expected_first_bytes),
                size_bytes: expected_first_bytes.len() as u64,
            };
            let second_artifact = RemoteArtifact {
                artifact_id: "art_good".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: test_sha256(&second_bytes),
                size_bytes: second_bytes.len() as u64,
            };
            let source_root =
                env::temp_dir().join(format!("tuneforge-sync-source-test-{}", random_nonce()));
            fs::create_dir_all(&source_root).expect("create source root");
            let first_path = source_root.join("changed.bin");
            let second_path = source_root.join("good.bin");
            fs::write(&first_path, &changed_first_bytes).expect("write changed payload");
            fs::write(&second_path, &second_bytes).expect("write second payload");
            let backend = TestBackendServer::start_with_staged_artifacts_and_files(
                HashMap::new(),
                HashMap::from([
                    (
                        first_artifact.artifact_id.clone(),
                        LocalArtifactFile {
                            artifact_id: first_artifact.artifact_id.clone(),
                            source_path: first_path,
                            content_sha256: first_artifact.content_sha256.clone(),
                            size_bytes: first_artifact.size_bytes,
                        },
                    ),
                    (
                        second_artifact.artifact_id.clone(),
                        LocalArtifactFile {
                            artifact_id: second_artifact.artifact_id.clone(),
                            source_path: second_path,
                            content_sha256: second_artifact.content_sha256.clone(),
                            size_bytes: second_artifact.size_bytes,
                        },
                    ),
                ]),
            );
            let peer_first = first_artifact.clone();
            let peer_second = second_artifact.clone();
            let peer_changed_first_bytes = changed_first_bytes.clone();
            let peer_second_bytes = second_bytes.clone();
            let (connection, peer_thread) = spawn_test_sync_peer(move |mut peer| {
                peer.send_message(&ProtocolMessage::ArtifactBatchRequest(
                    ArtifactBatchRequest {
                        batch_token: None,
                        artifacts: vec![
                            peer_first.artifact_request(),
                            peer_second.artifact_request(),
                        ],
                    },
                ))?;
                let start = read_message_accepting_status(
                    "artifact request/transfer",
                    || peer.read_message(),
                    |_| {},
                )?;
                match start {
                    ProtocolMessage::ArtifactStart {
                        artifact_id,
                        content_sha256,
                        size_bytes,
                    } if artifact_id == peer_first.artifact_id
                        && content_sha256 == peer_first.content_sha256
                        && size_bytes == peer_first.size_bytes => {}
                    other => {
                        return Err(format!(
                            "expected first artifact start, got {}",
                            other.kind()
                        ));
                    }
                }

                let mut first_bytes = Vec::new();
                loop {
                    match peer.read_artifact_transfer_frame()? {
                        ArtifactTransferFrame::Chunk(chunk) => first_bytes.extend(chunk),
                        ArtifactTransferFrame::Message(ProtocolMessage::Error(error))
                            if error.code == "artifact_unavailable" =>
                        {
                            break;
                        }
                        ArtifactTransferFrame::Message(ProtocolMessage::Status { .. }) => {}
                        ArtifactTransferFrame::Message(other) => {
                            return Err(format!(
                                "expected first artifact unavailable, got {}",
                                other.kind()
                            ));
                        }
                    }
                }
                assert_eq!(first_bytes, peer_changed_first_bytes);

                let second = receive_test_tcp_artifact(&mut peer, &peer_second)?;
                assert_eq!(second, peer_second_bytes);
                peer.send_message(&ProtocolMessage::PhaseDone {
                    phase: "artifact_transfer".to_string(),
                })?;
                Ok(())
            });
            let client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };
            let started = Instant::now();
            let progress = ProgressReporter::new(
                "sync_sender_hash_race_test".to_string(),
                started,
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            );
            let mut metrics = SyncRunMetrics::start(started);
            let served = serve_artifact_requests_until_done(
                &client,
                &connection,
                &[json!({
                    "project": { "project_id": "proj_one" },
                    "artifacts": [
                        {
                            "artifact_id": first_artifact.artifact_id,
                            "project_id": first_artifact.project_id,
                            "content_sha256": first_artifact.content_sha256,
                            "size_bytes": first_artifact.size_bytes,
                        },
                        {
                            "artifact_id": second_artifact.artifact_id,
                            "project_id": second_artifact.project_id,
                            "content_sha256": second_artifact.content_sha256,
                            "size_bytes": second_artifact.size_bytes,
                        }
                    ]
                })],
                &mut metrics,
                &progress,
            );
            let peer_result = peer_thread.join().expect("join sender hash race peer");
            let _ = fs::remove_dir_all(&source_root);

            assert_eq!(peer_result, Ok(()));
            assert_eq!(served.expect("serve batch after local hash race"), 2);
            assert_eq!(
                metrics.total_served_bytes,
                (changed_first_bytes.len() + second_bytes.len()) as u64
            );
        }

        #[cfg(not(target_os = "android"))]
        #[test]
        fn legacy_artifact_request_unavailable_keeps_serving_next_request() {
            let unavailable_bytes = b"unavailable artifact content".to_vec();
            let good_bytes = b"good artifact content".to_vec();
            let unavailable_artifact = RemoteArtifact {
                artifact_id: "art_unavailable".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: test_sha256(&unavailable_bytes),
                size_bytes: unavailable_bytes.len() as u64,
            };
            let good_artifact = RemoteArtifact {
                artifact_id: "art_good".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: test_sha256(&good_bytes),
                size_bytes: good_bytes.len() as u64,
            };
            let source_root =
                env::temp_dir().join(format!("tuneforge-sync-source-test-{}", random_nonce()));
            fs::create_dir_all(&source_root).expect("create source root");
            let good_path = source_root.join("good.bin");
            fs::write(&good_path, &good_bytes).expect("write good payload");
            let backend = TestBackendServer::start_with_staged_artifacts_files_and_resolve_errors(
                HashMap::new(),
                HashMap::from([(
                    good_artifact.artifact_id.clone(),
                    LocalArtifactFile {
                        artifact_id: good_artifact.artifact_id.clone(),
                        source_path: good_path,
                        content_sha256: good_artifact.content_sha256.clone(),
                        size_bytes: good_artifact.size_bytes,
                    },
                )]),
                HashMap::from([(
                    unavailable_artifact.artifact_id.clone(),
                    "/private/local/path/unavailable.wav missing".to_string(),
                )]),
            );
            let peer_unavailable = unavailable_artifact.clone();
            let peer_good = good_artifact.clone();
            let peer_good_bytes = good_bytes.clone();
            let (connection, peer_thread) = spawn_test_sync_peer(move |mut peer| {
                peer.send_message(&ProtocolMessage::ArtifactRequest(
                    peer_unavailable.artifact_request(),
                ))?;
                let unavailable = read_message_accepting_status(
                    "artifact request/transfer",
                    || peer.read_message(),
                    |_| {},
                )?;
                match unavailable {
                    ProtocolMessage::Error(error) if error.code == "artifact_unavailable" => {
                        assert_eq!(error.message, UNAVAILABLE_ARTIFACT_TRANSFER_MESSAGE);
                    }
                    other => {
                        return Err(format!(
                            "expected artifact unavailable, got {}",
                            other.kind()
                        ));
                    }
                }

                peer.send_message(&ProtocolMessage::ArtifactRequest(
                    peer_good.artifact_request(),
                ))?;
                let good = receive_test_tcp_artifact(&mut peer, &peer_good)?;
                assert_eq!(good, peer_good_bytes);
                peer.send_message(&ProtocolMessage::PhaseDone {
                    phase: "artifact_transfer".to_string(),
                })?;
                Ok(())
            });
            let client = BackendClient {
                host: "127.0.0.1".to_string(),
                port: backend.port,
                sync_transport_temp_root: Arc::new(Mutex::new(None)),
            };
            let started = Instant::now();
            let progress = ProgressReporter::new(
                "sync_legacy_artifact_request_unavailable_test".to_string(),
                started,
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            );
            let mut metrics = SyncRunMetrics::start(started);
            let served = serve_artifact_requests_until_done(
                &client,
                &connection,
                &[json!({
                    "project": { "project_id": "proj_one" },
                    "artifacts": [
                        {
                            "artifact_id": unavailable_artifact.artifact_id,
                            "project_id": unavailable_artifact.project_id,
                            "content_sha256": unavailable_artifact.content_sha256,
                            "size_bytes": unavailable_artifact.size_bytes,
                        },
                        {
                            "artifact_id": good_artifact.artifact_id,
                            "project_id": good_artifact.project_id,
                            "content_sha256": good_artifact.content_sha256,
                            "size_bytes": good_artifact.size_bytes,
                        }
                    ]
                })],
                &mut metrics,
                &progress,
            );
            let peer_result = peer_thread
                .join()
                .expect("join legacy artifact request peer");
            let _ = fs::remove_dir_all(&source_root);

            assert_eq!(peer_result, Ok(()));
            assert_eq!(served.expect("serve legacy requests after unavailable"), 2);
            assert_eq!(metrics.total_served_bytes, good_bytes.len() as u64);
        }

        #[test]
        fn artifact_batch_continues_after_post_receive_staging_failure() {
            let first_bytes = b"first artifact content".to_vec();
            let second_bytes = b"second artifact content".to_vec();
            let first_hash = test_sha256(&first_bytes);
            let second_hash = test_sha256(&second_bytes);
            let artifacts = vec![
                RemoteArtifact {
                    artifact_id: "art_one".to_string(),
                    project_id: "proj_one".to_string(),
                    content_sha256: first_hash.clone(),
                    size_bytes: first_bytes.len() as u64,
                },
                RemoteArtifact {
                    artifact_id: "art_two".to_string(),
                    project_id: "proj_two".to_string(),
                    content_sha256: second_hash.clone(),
                    size_bytes: second_bytes.len() as u64,
                },
            ];
            let peer_artifacts = artifacts.clone();
            let peer_payloads = vec![first_bytes, second_bytes];
            let (connection, peer_thread) = spawn_test_sync_peer(move |mut peer| {
                let request = read_message_accepting_status(
                    "artifact request/transfer",
                    || peer.read_message(),
                    |_| {},
                )?;
                let ProtocolMessage::ArtifactBatchRequest(request) = request else {
                    return Err("expected artifact batch request".to_string());
                };
                if request.artifacts.len() != 2 {
                    return Err(format!(
                        "expected 2 artifact requests, got {}",
                        request.artifacts.len()
                    ));
                }

                for (artifact, bytes) in peer_artifacts.iter().zip(peer_payloads.iter()) {
                    peer.send_message(&ProtocolMessage::ArtifactStart {
                        artifact_id: artifact.artifact_id.clone(),
                        content_sha256: artifact.content_sha256.clone(),
                        size_bytes: artifact.size_bytes,
                    })?;
                    peer.send_artifact_chunk(bytes)?;
                    peer.send_message(&ProtocolMessage::ArtifactEnd {
                        content_sha256: artifact.content_sha256.clone(),
                        size_bytes: artifact.size_bytes,
                    })?;
                }
                peer.send_message(&ProtocolMessage::PhaseDone {
                    phase: "artifact_batch_test".to_string(),
                })
            });
            let client = TestStagingClient::new(vec![
                Err(BackendError {
                    status: Some(500),
                    message: "stage refused".to_string(),
                }),
                Ok(json!({})),
            ]);
            let pending = artifacts
                .clone()
                .into_iter()
                .map(|artifact| PendingArtifactTransfer { artifact })
                .collect::<Vec<_>>();
            let started = Instant::now();
            let progress = ProgressReporter::new(
                "sync_test".to_string(),
                started,
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            );
            let mut metrics = SyncRunMetrics::start(started);
            let mut timings = Vec::new();

            let results = request_and_stage_artifact_batch(
                &client,
                &connection,
                "dev_peer",
                pending,
                &mut metrics,
                &mut timings,
                &progress,
            );
            let next_message = connection
                .read_message_accepting_status_for_phase("artifact batch test", &progress);
            peer_thread
                .join()
                .expect("join test sync peer")
                .expect("test sync peer completed");
            let next_message = next_message.expect("read message after artifact batch");

            assert_eq!(results.len(), 2);
            let first_error = results[0]
                .as_ref()
                .expect_err("first artifact staging fails");
            assert!(first_error.message.contains("reconciliation staging"));
            let second_result = results[1]
                .as_ref()
                .expect("second artifact is still received and staged");
            assert_eq!(second_result.artifact_id, "art_two");
            assert_eq!(second_result.status, "received");
            match next_message {
                ProtocolMessage::PhaseDone { phase } => {
                    assert_eq!(phase, "artifact_batch_test");
                }
                other => panic!(
                    "expected drained batch before phase_done, got {}",
                    other.kind()
                ),
            }

            let staging_requests = client.requests();
            assert_eq!(staging_requests.len(), 2);
            assert_eq!(
                staging_requests[0]
                    .get("content_sha256")
                    .and_then(Value::as_str),
                Some(first_hash.as_str())
            );
            assert_eq!(
                staging_requests[1]
                    .get("content_sha256")
                    .and_then(Value::as_str),
                Some(second_hash.as_str())
            );
        }

        #[test]
        fn artifact_batch_continues_after_peer_artifact_unavailable_error() {
            let first_bytes = b"unavailable artifact content".to_vec();
            let second_bytes = b"second artifact content".to_vec();
            let first_hash = test_sha256(&first_bytes);
            let second_hash = test_sha256(&second_bytes);
            let artifacts = vec![
                RemoteArtifact {
                    artifact_id: "art_unavailable".to_string(),
                    project_id: "proj_one".to_string(),
                    content_sha256: first_hash,
                    size_bytes: first_bytes.len() as u64,
                },
                RemoteArtifact {
                    artifact_id: "art_two".to_string(),
                    project_id: "proj_two".to_string(),
                    content_sha256: second_hash.clone(),
                    size_bytes: second_bytes.len() as u64,
                },
            ];
            let peer_second_artifact = artifacts[1].clone();
            let peer_second_bytes = second_bytes.clone();
            let (connection, peer_thread) = spawn_test_sync_peer(move |mut peer| {
                let request = read_message_accepting_status(
                    "artifact request/transfer",
                    || peer.read_message(),
                    |_| {},
                )?;
                let ProtocolMessage::ArtifactBatchRequest(request) = request else {
                    return Err("expected artifact batch request".to_string());
                };
                if request.artifacts.len() != 2 {
                    return Err(format!(
                        "expected 2 artifact requests, got {}",
                        request.artifacts.len()
                    ));
                }
                peer.send_message(&ProtocolMessage::Error(ProtocolError {
                    code: "artifact_unavailable".to_string(),
                    message: UNAVAILABLE_ARTIFACT_TRANSFER_MESSAGE.to_string(),
                }))?;
                peer.send_message(&ProtocolMessage::ArtifactStart {
                    artifact_id: peer_second_artifact.artifact_id.clone(),
                    content_sha256: peer_second_artifact.content_sha256.clone(),
                    size_bytes: peer_second_artifact.size_bytes,
                })?;
                peer.send_artifact_chunk(&peer_second_bytes)?;
                peer.send_message(&ProtocolMessage::ArtifactEnd {
                    content_sha256: peer_second_artifact.content_sha256.clone(),
                    size_bytes: peer_second_artifact.size_bytes,
                })?;
                peer.send_message(&ProtocolMessage::PhaseDone {
                    phase: "artifact_batch_test".to_string(),
                })
            });
            let client = TestStagingClient::new(vec![Ok(json!({}))]);
            let pending = artifacts
                .clone()
                .into_iter()
                .map(|artifact| PendingArtifactTransfer { artifact })
                .collect::<Vec<_>>();
            let started = Instant::now();
            let progress = ProgressReporter::new(
                "sync_test".to_string(),
                started,
                Arc::new(Mutex::new(SharedStatus::default())),
                connection.clone(),
                RunCancellationToken::default(),
            );
            let mut metrics = SyncRunMetrics::start(started);
            let mut timings = Vec::new();

            let results = request_and_stage_artifact_batch(
                &client,
                &connection,
                "dev_peer",
                pending,
                &mut metrics,
                &mut timings,
                &progress,
            );
            let next_message = connection
                .read_message_accepting_status_for_phase("artifact batch test", &progress);
            peer_thread
                .join()
                .expect("join test sync peer")
                .expect("test sync peer completed");
            let next_message = next_message.expect("read message after artifact batch");

            assert_eq!(results.len(), 2);
            let first_error = results[0].as_ref().expect_err("first artifact unavailable");
            assert!(first_error
                .message
                .contains(UNAVAILABLE_ARTIFACT_TRANSFER_MESSAGE));
            assert!(!first_error.message.contains("/private/local/path"));
            let second_result = results[1]
                .as_ref()
                .expect("second artifact is still received and staged");
            assert_eq!(second_result.artifact_id, "art_two");
            assert_eq!(second_result.status, "received");
            match next_message {
                ProtocolMessage::PhaseDone { phase } => {
                    assert_eq!(phase, "artifact_batch_test");
                }
                other => panic!(
                    "expected drained batch before phase_done, got {}",
                    other.kind()
                ),
            }
            let staging_requests = client.requests();
            assert_eq!(staging_requests.len(), 1);
            assert_eq!(
                staging_requests[0]
                    .get("content_sha256")
                    .and_then(Value::as_str),
                Some(second_hash.as_str())
            );
        }

        #[test]
        fn reconciliation_apply_body_batches_every_manifest_with_one_peer_inventory() {
            let manifests = vec![
                json!({ "project": { "project_id": "proj_one" }, "artifacts": [] }),
                json!({ "project": { "project_id": "proj_two" }, "artifacts": [] }),
            ];
            let remote_metadata = json!({ "projects": [] });
            let available = vec!["hash_a".to_string(), "hash_b".to_string()];

            let body = reconciliation_apply_body(
                "dev_peer",
                &remote_metadata,
                &manifests,
                &available,
                TCP_TRANSPORT_ID,
            );

            assert_eq!(
                body.get("project_manifests")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(2)
            );
            assert_eq!(
                body.get("peer_inventory")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1)
            );
            assert_eq!(
                body.get("peer_inventory")
                    .and_then(Value::as_array)
                    .and_then(|entries| entries.first())
                    .and_then(|entry| entry.get("device_id"))
                    .and_then(Value::as_str),
                Some("dev_peer")
            );
            assert_eq!(
                body.get("peer_inventory")
                    .and_then(Value::as_array)
                    .and_then(|entries| entries.first())
                    .and_then(|entry| entry.get("available_content_sha256")),
                Some(&json!(["hash_a", "hash_b"]))
            );
            assert_eq!(
                body.get("project_ids"),
                Some(&json!(["proj_one", "proj_two"]))
            );
            assert_eq!(body.get("include_timing_evidence"), Some(&json!(true)));
        }

        #[test]
        fn reconciliation_apply_body_can_scope_delete_only_project_without_manifest() {
            let body = reconciliation_apply_body_with_project_ids(
                "dev_peer",
                &json!({ "delete_tombstones": [{ "project_id": "proj_deleted" }] }),
                &[],
                &[],
                &["proj_deleted".to_string()],
                TCP_TRANSPORT_ID,
            );

            assert_eq!(
                body.get("project_manifests")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(0)
            );
            assert_eq!(body.get("project_ids"), Some(&json!(["proj_deleted"])));
        }

        #[test]
        fn reconciliation_plan_body_advertises_manifest_artifact_hashes() {
            let manifests = vec![
                json!({
                    "project": { "project_id": "proj_one" },
                    "artifacts": [{
                        "artifact_id": "art_one",
                        "project_id": "proj_one",
                        "content_sha256": "hash_b",
                        "size_bytes": 20
                    }]
                }),
                json!({
                    "project": { "project_id": "proj_two" },
                    "artifacts": [{
                        "artifact_id": "art_two",
                        "project_id": "proj_two",
                        "content_sha256": "hash_a",
                        "size_bytes": 10
                    }, {
                        "artifact_id": "art_two_duplicate_hash",
                        "project_id": "proj_two",
                        "content_sha256": "hash_b",
                        "size_bytes": 20
                    }]
                }),
            ];
            let remote_metadata = json!({ "projects": [] });
            let available = manifest_content_sha256(&manifests);

            let body = reconciliation_plan_body(
                "dev_peer",
                &remote_metadata,
                &manifests,
                &available,
                TCP_TRANSPORT_ID,
            );

            assert_eq!(
                body.get("peer_inventory")
                    .and_then(Value::as_array)
                    .and_then(|entries| entries.first())
                    .and_then(|entry| entry.get("available_content_sha256")),
                Some(&json!(["hash_a", "hash_b"]))
            );
            assert!(body.get("use_content_addressed_staging").is_none());
        }

        #[test]
        fn reconciliation_plan_body_scopes_to_one_project() {
            let remote_metadata = json!({
                "projects": [
                    { "project_id": "proj_one", "display_name": "One" },
                    { "project_id": "proj_two", "display_name": "Two" }
                ],
                "artifacts": [
                    { "artifact_id": "art_one", "project_id": "proj_one" },
                    { "artifact_id": "art_two", "project_id": "proj_two" }
                ],
                "entity_revisions": [
                    { "revision_id": "rev_one", "project_id": "proj_one" },
                    { "revision_id": "rev_two", "project_id": "proj_two" }
                ],
                "delete_tombstones": [
                    { "tombstone_id": "del_one", "project_id": "proj_one" },
                    { "tombstone_id": "del_two", "project_id": "proj_two" }
                ]
            });
            let manifest = json!({
                "project": { "project_id": "proj_two" },
                "artifacts": [{
                    "artifact_id": "art_two",
                    "project_id": "proj_two",
                    "content_sha256": "hash_two",
                    "size_bytes": 20
                }]
            });

            let body = reconciliation_plan_body_for_manifest_chunk(
                "dev_peer",
                &remote_metadata,
                &[manifest],
                TCP_TRANSPORT_ID,
            );

            assert_eq!(
                body.pointer("/remote_library/projects/0/project_id")
                    .and_then(Value::as_str),
                Some("proj_two")
            );
            assert_eq!(
                body.pointer("/remote_library/projects")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1)
            );
            assert_eq!(
                body.get("project_manifests")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1)
            );
            assert_eq!(
                body.pointer("/peer_inventory/0/available_content_sha256"),
                Some(&json!(["hash_two"]))
            );
        }

        #[test]
        fn remote_manifest_plan_success_uses_one_request_for_chunk() {
            let manifests = vec![
                json!({ "project": { "project_id": "proj_one" }, "artifacts": [] }),
                json!({ "project": { "project_id": "proj_two" }, "artifacts": [] }),
            ];
            let mut plan_requests = 0;

            let (planned, failures) =
                plan_remote_manifest_projects(&manifests, &json!({}), |request| match request {
                    RemotePlanRequest::Manifest { manifests } => {
                        plan_requests += 1;
                        assert_eq!(manifests.len(), 2);
                        Ok(json!({
                            "actions": manifests
                                .iter()
                                .map(|manifest| json!({
                                    "project_id": manifest_project_id(manifest)
                                }))
                                .collect::<Vec<_>>()
                        }))
                    }
                    RemotePlanRequest::Delete { .. } => unreachable!("no tombstones"),
                });

            assert!(failures.is_empty());
            assert_eq!(planned.len(), 2);
            assert_eq!(planned[0].project_id, "proj_one");
            assert_eq!(planned[1].project_id, "proj_two");
            assert_eq!(plan_requests, 1);
        }

        #[test]
        fn failed_manifest_plan_chunk_splits_and_isolates_failed_project() {
            let manifests = vec![
                json!({ "project": { "project_id": "proj_ok_one" }, "artifacts": [] }),
                json!({ "project": { "project_id": "proj_failed" }, "artifacts": [] }),
                json!({ "project": { "project_id": "proj_ok_two" }, "artifacts": [] }),
            ];
            let mut requested_chunks = Vec::new();

            let (planned, failures) =
                plan_remote_manifest_projects(&manifests, &json!({}), |request| match request {
                    RemotePlanRequest::Manifest { manifests } => {
                        let project_ids: Vec<String> =
                            manifests.iter().map(manifest_project_id).collect();
                        requested_chunks.push(project_ids.clone());
                        if project_ids
                            .iter()
                            .any(|project_id| project_id == "proj_failed")
                        {
                            Err(BackendError::local("planner refused project".to_string()))
                        } else {
                            Ok(json!({
                                "actions": project_ids
                                    .iter()
                                    .map(|project_id| json!({ "project_id": project_id }))
                                    .collect::<Vec<_>>()
                            }))
                        }
                    }
                    RemotePlanRequest::Delete { .. } => unreachable!("no tombstones"),
                });

            assert_eq!(planned.len(), 2);
            assert_eq!(planned[0].project_id, "proj_ok_one");
            assert_eq!(planned[1].project_id, "proj_ok_two");
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0].project_id, "proj_failed");
            assert_eq!(failures[0].status, "failed");
            assert!(failures[0]
                .message
                .as_deref()
                .is_some_and(|message| message.contains("planner refused project")));
            assert_eq!(
                requested_chunks,
                vec![
                    vec![
                        "proj_ok_one".to_string(),
                        "proj_failed".to_string(),
                        "proj_ok_two".to_string()
                    ],
                    vec!["proj_ok_one".to_string()],
                    vec!["proj_failed".to_string(), "proj_ok_two".to_string()],
                    vec!["proj_failed".to_string()],
                    vec!["proj_ok_two".to_string()],
                ]
            );
        }

        #[test]
        fn successful_project_still_queued_after_another_project_plan_fails() {
            let manifests = vec![
                json!({ "project": { "project_id": "proj_failed" }, "artifacts": [] }),
                json!({ "project": { "project_id": "proj_queued" }, "artifacts": [] }),
            ];

            let (planned, failures) =
                plan_remote_manifest_projects(&manifests, &json!({}), |request| match request {
                    RemotePlanRequest::Manifest { manifests } => {
                        let project_ids: Vec<String> =
                            manifests.iter().map(manifest_project_id).collect();
                        if project_ids
                            .iter()
                            .any(|project_id| project_id == "proj_failed")
                        {
                            Err(BackendError::local("planner refused project".to_string()))
                        } else {
                            Ok(json!({
                                "actions": project_ids
                                    .iter()
                                    .map(|project_id| json!({ "project_id": project_id }))
                                    .collect::<Vec<_>>()
                            }))
                        }
                    }
                    RemotePlanRequest::Delete { .. } => unreachable!("no tombstones"),
                });

            assert_eq!(failures.len(), 1);
            assert_eq!(planned.len(), 1);
            assert_eq!(planned[0].project_id, "proj_queued");
            assert!(planned[0].manifest.is_some());
        }

        #[test]
        fn delete_only_tombstone_project_is_planned_without_manifest() {
            let remote_metadata = json!({
                "delete_tombstones": [
                    { "tombstone_id": "del_deleted", "project_id": "proj_deleted" }
                ]
            });

            let (planned, failures) =
                plan_remote_manifest_projects(&[], &remote_metadata, |request| match request {
                    RemotePlanRequest::Delete { project_ids } => {
                        assert_eq!(project_ids, &["proj_deleted".to_string()]);
                        Ok(json!({
                            "actions": project_ids
                                .iter()
                                .map(|project_id| json!({
                                    "action_type": "apply_delete_tombstone",
                                    "project_id": project_id,
                                    "item_id": project_id
                                }))
                                .collect::<Vec<_>>()
                        }))
                    }
                    RemotePlanRequest::Manifest { .. } => unreachable!("no manifests"),
                });

            assert!(failures.is_empty());
            assert_eq!(planned.len(), 1);
            assert_eq!(planned[0].project_id, "proj_deleted");
            assert!(planned[0].manifest.is_none());
            assert_eq!(
                planned_delete_project_ids(&planned[0].plan),
                vec!["proj_deleted".to_string()]
            );
        }

        #[test]
        fn delete_only_tombstone_plan_success_uses_one_request_for_chunk() {
            let remote_metadata = json!({
                "delete_tombstones": [
                    { "tombstone_id": "del_a", "project_id": "proj_deleted_a" },
                    { "tombstone_id": "del_b", "project_id": "proj_deleted_b" }
                ]
            });
            let mut plan_requests = 0;

            let (planned, failures) =
                plan_remote_manifest_projects(&[], &remote_metadata, |request| match request {
                    RemotePlanRequest::Delete { project_ids } => {
                        plan_requests += 1;
                        assert_eq!(
                            project_ids,
                            &["proj_deleted_a".to_string(), "proj_deleted_b".to_string()]
                        );
                        Ok(json!({
                            "actions": project_ids
                                .iter()
                                .map(|project_id| json!({
                                    "action_type": "apply_delete_tombstone",
                                    "project_id": project_id,
                                    "item_id": project_id
                                }))
                                .collect::<Vec<_>>()
                        }))
                    }
                    RemotePlanRequest::Manifest { .. } => unreachable!("no manifests"),
                });

            assert!(failures.is_empty());
            assert_eq!(planned.len(), 2);
            assert!(planned.iter().all(|project| project.manifest.is_none()));
            assert_eq!(planned[0].project_id, "proj_deleted_a");
            assert_eq!(planned[1].project_id, "proj_deleted_b");
            assert_eq!(plan_requests, 1);
        }

        #[test]
        fn planned_fetch_artifact_entries_uses_backend_fetch_actions() {
            let manifests = vec![
                json!({
                    "project": { "project_id": "proj_one" },
                    "artifacts": [{
                        "artifact_id": "art_one",
                        "project_id": "proj_one",
                        "content_sha256": "hash_a",
                        "size_bytes": 10
                    }]
                }),
                json!({
                    "project": { "project_id": "proj_two" },
                    "artifacts": [{
                        "artifact_id": "art_two",
                        "project_id": "proj_two",
                        "content_sha256": "hash_b",
                        "size_bytes": 20
                    }]
                }),
            ];
            let plan = json!({
                "actions": [{
                    "action_type": "fetch_artifact_content",
                    "item_type": "artifact",
                    "item_id": "art_two",
                    "project_id": "proj_two",
                    "content_sha256": "hash_b",
                    "provider_device_id": "dev_peer",
                    "priority": 20
                }, {
                    "action_type": "import_project_manifest",
                    "item_type": "project",
                    "item_id": "proj_one",
                    "project_id": "proj_one",
                    "priority": 30
                }]
            });

            let entries = planned_fetch_artifact_entries(&plan, &manifests, "dev_peer");

            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].artifact.artifact_id, "art_two");
            assert_eq!(entries[0].artifact.project_id, "proj_two");
        }

        #[test]
        fn planned_fetch_artifact_entries_requires_matching_provider_device_id() {
            let manifests = vec![json!({
                "project": { "project_id": "proj_one" },
                "artifacts": [{
                    "artifact_id": "art_one",
                    "project_id": "proj_one",
                    "content_sha256": "hash_a",
                    "size_bytes": 10
                }, {
                    "artifact_id": "art_two",
                    "project_id": "proj_one",
                    "content_sha256": "hash_b",
                    "size_bytes": 20
                }]
            })];
            let plan = json!({
                "actions": [{
                    "action_type": "fetch_artifact_content",
                    "item_type": "artifact",
                    "item_id": "art_one",
                    "project_id": "proj_one",
                    "content_sha256": "hash_a",
                    "provider_device_id": "dev_other_peer",
                    "priority": 20
                }, {
                    "action_type": "fetch_artifact_content",
                    "item_type": "artifact",
                    "item_id": "art_two",
                    "project_id": "proj_one",
                    "content_sha256": "hash_b",
                    "provider_device_id": "dev_selected_peer",
                    "priority": 20
                }]
            });

            let entries = planned_fetch_artifact_entries(&plan, &manifests, "dev_selected_peer");

            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].artifact.artifact_id, "art_two");
            assert_eq!(entries[0].artifact.content_sha256, "hash_b");
        }

        #[test]
        fn planned_fetch_artifact_entries_is_empty_when_plan_needs_no_content() {
            let manifests = vec![json!({
                "project": { "project_id": "proj_one" },
                "artifacts": [{
                    "artifact_id": "art_one",
                    "project_id": "proj_one",
                    "content_sha256": "hash_a",
                    "size_bytes": 10
                }]
            })];
            let plan = json!({
                "actions": [{
                    "action_type": "noop",
                    "item_type": "artifact",
                    "item_id": "art_one",
                    "project_id": "proj_one",
                    "content_sha256": "hash_a",
                    "priority": 10
                }]
            });

            assert!(planned_fetch_artifact_entries(&plan, &manifests, "dev_peer").is_empty());
        }

        #[test]
        fn iroh_pending_artifacts_round_robin_projects_before_first_cap_window() {
            let pending = (0..IROH_ARTIFACT_PARALLELISM + 2)
                .map(|index| PendingArtifactTransfer {
                    artifact: RemoteArtifact {
                        artifact_id: format!("art_a_{index}"),
                        project_id: "proj_a".to_string(),
                        content_sha256: format!("hash_a_{index}"),
                        size_bytes: 10,
                    },
                })
                .chain((0..2).map(|index| PendingArtifactTransfer {
                    artifact: RemoteArtifact {
                        artifact_id: format!("art_b_{index}"),
                        project_id: "proj_b".to_string(),
                        content_sha256: format!("hash_b_{index}"),
                        size_bytes: 20,
                    },
                }))
                .collect::<Vec<_>>();

            let ordered = round_robin_pending_artifacts_by_project(pending);

            assert_eq!(
                ordered
                    .iter()
                    .take(IROH_ARTIFACT_PARALLELISM)
                    .map(|pending| pending.artifact.artifact_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["art_a_0", "art_b_0", "art_a_1", "art_b_1"]
            );
        }

        #[test]
        fn iroh_credit_window_replenishes_after_receive_release_when_budget_allows() {
            let pending = ["art_one", "art_two", "art_three"]
                .into_iter()
                .map(|artifact_id| PendingArtifactTransfer {
                    artifact: RemoteArtifact {
                        artifact_id: artifact_id.to_string(),
                        project_id: "proj_one".to_string(),
                        content_sha256: format!("hash_{artifact_id}"),
                        size_bytes: 10,
                    },
                })
                .collect::<Vec<_>>();
            let mut window = IrohBatchCreditWindow::new(&pending, 2, 30);

            assert_eq!(
                window.grant_available(0).expect("initial credit"),
                vec!["art_one".to_string(), "art_two".to_string()]
            );
            assert_eq!(window.reserved_bytes, 20);
            assert_eq!(window.grants_issued(), 2);

            window.release("art_one");

            assert_eq!(
                window.grant_available(10).expect("replenishment credit"),
                vec!["art_three".to_string()]
            );
            assert_eq!(window.reserved_bytes, 20);
            assert_eq!(window.grants_issued(), 3);
        }

        #[test]
        fn iroh_credit_window_counts_pending_staging_bytes_against_budget() {
            let pending = [
                ("art_one", 40_u64),
                ("art_two", 40_u64),
                ("art_three", 30_u64),
            ]
            .into_iter()
            .map(|(artifact_id, size_bytes)| PendingArtifactTransfer {
                artifact: RemoteArtifact {
                    artifact_id: artifact_id.to_string(),
                    project_id: "proj_one".to_string(),
                    content_sha256: format!("hash_{artifact_id}"),
                    size_bytes,
                },
            })
            .collect::<Vec<_>>();
            let mut window = IrohBatchCreditWindow::new(&pending, 2, 100);

            assert_eq!(
                window.grant_available(0).expect("initial credit"),
                vec!["art_one".to_string(), "art_two".to_string()]
            );
            assert_eq!(window.reserved_bytes, 80);

            window.release("art_one");

            assert!(window
                .grant_available(40)
                .expect("pending staging consumes budget")
                .is_empty());
            assert_eq!(window.reserved_bytes, 40);
            assert_eq!(window.scratch_bytes(40), 80);

            assert_eq!(
                window.grant_available(0).expect("staging drained"),
                vec!["art_three".to_string()]
            );
            assert_eq!(window.reserved_bytes, 70);
        }

        #[test]
        fn iroh_credit_window_byte_budget_prevents_over_credit() {
            let pending = [
                ("art_one", 60_u64),
                ("art_two", 50_u64),
                ("art_three", 10_u64),
            ]
            .into_iter()
            .map(|(artifact_id, size_bytes)| PendingArtifactTransfer {
                artifact: RemoteArtifact {
                    artifact_id: artifact_id.to_string(),
                    project_id: "proj_one".to_string(),
                    content_sha256: format!("hash_{artifact_id}"),
                    size_bytes,
                },
            })
            .collect::<Vec<_>>();
            let mut window = IrohBatchCreditWindow::new(&pending, 4, 100);

            assert_eq!(
                window.grant_available(0).expect("initial credit"),
                vec!["art_one".to_string()]
            );
            assert_eq!(window.reserved_bytes, 60);

            window.release("art_one");

            assert_eq!(
                window.grant_available(0).expect("budgeted replenishment"),
                vec!["art_two".to_string(), "art_three".to_string()]
            );
            assert_eq!(window.reserved_bytes, 60);
        }

        #[test]
        fn iroh_stale_credit_cleanup_revokes_and_clears_active_artifacts() {
            let pending = (0..2)
                .map(|index| PendingArtifactTransfer {
                    artifact: RemoteArtifact {
                        artifact_id: format!("art_{index}"),
                        project_id: format!("proj_{index}"),
                        content_sha256: format!("hash_{index}"),
                        size_bytes: 10,
                    },
                })
                .collect::<Vec<_>>();
            let mut window = IrohBatchCreditWindow::new(&pending, 2, 100);
            let credited_artifact_ids = Arc::new(Mutex::new(HashSet::new()));
            let mut metrics = SyncRunMetrics::start(Instant::now());

            let granted = window.grant_available(0).expect("grant stale credits");
            credited_artifact_ids
                .lock()
                .expect("record credited artifacts")
                .extend(granted);
            metrics.record_credit_revokes(window.active_credit_count());
            clear_iroh_batch_credits(&mut window, &credited_artifact_ids, &mut metrics);

            assert_eq!(metrics.credit_revokes, 2);
            assert_eq!(window.active_credit_count(), 0);
            assert_eq!(window.scratch_bytes(0), 0);
            assert!(credited_artifact_ids
                .lock()
                .expect("read credited artifacts")
                .is_empty());
        }

        #[test]
        fn iroh_progress_watchdog_allows_delayed_control_after_stream_and_staging_progress() {
            let started = Instant::now();
            let timeout = Duration::from_secs(75);
            let mut batch_started_only = IrohBatchProgressWatchdog::new(started, timeout);
            assert!(batch_started_only.timed_out_at(started + Duration::from_secs(76)));

            let mut watchdog = IrohBatchProgressWatchdog::new(started, timeout);
            let stream_progress = watchdog.marker();
            stream_progress.record_at(started + Duration::from_secs(60));

            assert!(!watchdog.timed_out_at(started + Duration::from_secs(100)));

            watchdog.record_at(started + Duration::from_secs(120));

            assert!(!watchdog.timed_out_at(started + Duration::from_secs(150)));
            assert!(watchdog.timed_out_at(started + Duration::from_secs(196)));
        }

        #[test]
        fn iroh_global_scheduler_releases_each_project_when_ready() {
            let mut scheduler = IrohGlobalProjectScheduler::default();
            let mut received_artifacts = Vec::new();
            let first = RemoteArtifact {
                artifact_id: "art_one".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: "hash_one".to_string(),
                size_bytes: 10,
            };
            let second = RemoteArtifact {
                artifact_id: "art_two".to_string(),
                project_id: "proj_two".to_string(),
                content_sha256: "hash_two".to_string(),
                size_bytes: 20,
            };
            let first_project =
                scheduler.push_project(json!({ "project": { "project_id": "proj_one" } }));
            let second_project =
                scheduler.push_project(json!({ "project": { "project_id": "proj_two" } }));

            assert!(scheduler
                .add_pending_artifact(first_project, first.clone())
                .expect("add first pending"));
            assert!(scheduler
                .add_pending_artifact(second_project, second.clone())
                .expect("add second pending"));
            scheduler.mark_project_discovered(first_project);
            scheduler.mark_project_discovered(second_project);

            assert!(scheduler.drain_ready_projects().is_empty());

            scheduler.record_artifact_transfer(
                Ok(test_transfer_result("art_two", "hash_two", 20, "received")),
                &mut received_artifacts,
            );
            let ready = scheduler.drain_ready_projects();

            assert_eq!(ready.len(), 1);
            assert_eq!(manifest_project_id(&ready[0].manifest), "proj_two");
            assert_eq!(
                ready[0].available_content_sha256,
                vec!["hash_two".to_string()]
            );
            assert!(ready[0].transfer_failure.is_none());

            scheduler.record_artifact_transfer(
                Ok(test_transfer_result("art_one", "hash_one", 10, "received")),
                &mut received_artifacts,
            );
            let ready = scheduler.drain_ready_projects();

            assert_eq!(ready.len(), 1);
            assert_eq!(manifest_project_id(&ready[0].manifest), "proj_one");
            assert_eq!(
                received_artifacts
                    .iter()
                    .map(|transfer| transfer.artifact_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["art_two", "art_one"]
            );
        }

        #[test]
        fn iroh_active_batch_stage_results_defer_apply_until_final_drain() {
            let mut scheduler = IrohGlobalProjectScheduler::default();
            let first = RemoteArtifact {
                artifact_id: "art_one".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: "hash_one".to_string(),
                size_bytes: 10,
            };
            let second = RemoteArtifact {
                artifact_id: "art_two".to_string(),
                project_id: "proj_two".to_string(),
                content_sha256: "hash_two".to_string(),
                size_bytes: 20,
            };
            let first_project =
                scheduler.push_project(json!({ "project": { "project_id": "proj_one" } }));
            let second_project =
                scheduler.push_project(json!({ "project": { "project_id": "proj_two" } }));
            scheduler
                .add_pending_artifact(first_project, first.clone())
                .expect("add first pending");
            scheduler
                .add_pending_artifact(second_project, second.clone())
                .expect("add second pending");
            scheduler.mark_project_discovered(first_project);
            scheduler.mark_project_discovered(second_project);
            let (task_sender, task_receiver) =
                mpsc::sync_channel::<BackendWriteTask>(IROH_ARTIFACT_STAGING_QUEUE_CAPACITY);
            let (_event_sender, event_receiver) = mpsc::channel::<BackendWriteEvent>();
            let mut apply_worker = RemoteApplyWorker {
                sender: Some(task_sender),
                event_receiver,
                handle: None,
                queued_project_ids: Arc::new(Mutex::new(Vec::new())),
                completed_project_ids: HashSet::new(),
                enqueue_failures: Arc::new(Mutex::new(Vec::new())),
                apply_cancelled: Arc::new(AtomicBool::new(false)),
                project_results: Vec::new(),
                pending_stage_jobs: 0,
                pending_stage_bytes: 0,
                staging_peak_bytes: 0,
            };
            let mut received_artifacts = Vec::new();
            let mut ready_projects = Vec::new();
            let mut ready_tombstone_project_ids = vec!["proj_deleted".to_string()];

            record_iroh_batch_scheduler_transfer(
                &mut scheduler,
                &mut received_artifacts,
                &mut ready_projects,
                &mut ready_tombstone_project_ids,
                &mut apply_worker,
                Ok(test_transfer_result("art_one", "hash_one", 10, "received")),
                false,
            );

            assert_eq!(
                ready_projects
                    .iter()
                    .map(|project| manifest_project_id(&project.manifest))
                    .collect::<Vec<_>>(),
                vec!["proj_one"]
            );
            assert!(matches!(
                task_receiver.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));

            record_iroh_batch_scheduler_transfer(
                &mut scheduler,
                &mut received_artifacts,
                &mut ready_projects,
                &mut ready_tombstone_project_ids,
                &mut apply_worker,
                Ok(test_transfer_result("art_two", "hash_two", 20, "received")),
                false,
            );

            assert_eq!(ready_projects.len(), 2);
            assert_eq!(ready_tombstone_project_ids, vec!["proj_deleted"]);
            assert!(matches!(
                task_receiver.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));

            enqueue_collected_iroh_ready_projects(
                &mut apply_worker,
                &mut ready_projects,
                &mut ready_tombstone_project_ids,
            );

            let mut enqueued_project_ids = Vec::new();
            for _ in 0..3 {
                match task_receiver
                    .try_recv()
                    .expect("project apply was enqueued")
                {
                    BackendWriteTask::Apply { project_id, .. } => {
                        enqueued_project_ids.push(project_id);
                    }
                    BackendWriteTask::StageIrohArtifact { .. } => {
                        panic!("final drain should enqueue apply tasks only");
                    }
                }
            }
            assert_eq!(
                enqueued_project_ids,
                vec!["proj_one", "proj_two", "proj_deleted"]
            );
            assert!(ready_projects.is_empty());
            assert!(ready_tombstone_project_ids.is_empty());
            assert_eq!(received_artifacts.len(), 2);
            assert!(matches!(
                task_receiver.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
        }

        #[test]
        fn iroh_global_scheduler_keeps_same_hash_artifact_ids_distinct() {
            let mut scheduler = IrohGlobalProjectScheduler::default();
            let first_project =
                scheduler.push_project(json!({ "project": { "project_id": "proj_one" } }));
            let second_project =
                scheduler.push_project(json!({ "project": { "project_id": "proj_two" } }));
            let first = RemoteArtifact {
                artifact_id: "art_same_hash_one".to_string(),
                project_id: "proj_one".to_string(),
                content_sha256: "hash_shared".to_string(),
                size_bytes: 10,
            };
            let second = RemoteArtifact {
                artifact_id: "art_same_hash_two".to_string(),
                project_id: "proj_two".to_string(),
                content_sha256: "hash_shared".to_string(),
                size_bytes: 10,
            };

            assert!(scheduler
                .add_pending_artifact(first_project, first)
                .expect("add first same-hash artifact"));
            assert!(scheduler
                .add_pending_artifact(second_project, second)
                .expect("add second same-hash artifact"));

            assert_eq!(scheduler.artifact_subscribers.len(), 2);
            assert!(scheduler
                .artifact_subscribers
                .contains_key("art_same_hash_one"));
            assert!(scheduler
                .artifact_subscribers
                .contains_key("art_same_hash_two"));
        }

        #[test]
        fn iroh_initial_scan_ready_project_includes_later_manifest_cleanup_context() {
            let mut scheduler = IrohGlobalProjectScheduler::default();
            let mut received_artifacts = Vec::new();
            let shared_hash = "hash_shared".to_string();
            let ready_manifest = json!({
                "project": { "project_id": "proj_ready" },
                "artifacts": [{
                    "artifact_id": "art_ready",
                    "project_id": "proj_ready",
                    "content_sha256": shared_hash,
                    "size_bytes": 10
                }]
            });
            let pending_manifest = json!({
                "project": { "project_id": "proj_pending" },
                "artifacts": [{
                    "artifact_id": "art_pending",
                    "project_id": "proj_pending",
                    "content_sha256": "hash_shared",
                    "size_bytes": 10
                }]
            });
            let ready_plan = json!({
                "actions": [{
                    "action_type": "fetch_artifact_content",
                    "item_type": "artifact",
                    "item_id": "art_ready",
                    "project_id": "proj_ready",
                    "content_sha256": "hash_shared",
                    "provider_device_id": "dev_peer",
                    "priority": 20
                }]
            });
            let pending_plan = json!({
                "actions": [{
                    "action_type": "fetch_artifact_content",
                    "item_type": "artifact",
                    "item_id": "art_pending",
                    "project_id": "proj_pending",
                    "content_sha256": "hash_shared",
                    "provider_device_id": "dev_peer",
                    "priority": 20
                }]
            });
            let registered_projects = register_planned_iroh_projects(
                vec![
                    PlannedRemoteProject {
                        project_id: "proj_ready".to_string(),
                        manifest: Some(ready_manifest),
                        plan: ready_plan,
                    },
                    PlannedRemoteProject {
                        project_id: "proj_pending".to_string(),
                        manifest: Some(pending_manifest),
                        plan: pending_plan,
                    },
                ],
                &mut scheduler,
            );
            assert_eq!(registered_projects.len(), 2);
            let first_registered = registered_projects
                .first()
                .expect("registered ready project");
            let IrohRegisteredPlannedRemoteProject::Manifest {
                project_index,
                manifest,
                plan,
            } = first_registered
            else {
                panic!("expected first registered manifest project");
            };
            let entries =
                planned_fetch_artifact_entries(plan, std::slice::from_ref(manifest), "dev_peer");

            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].artifact.content_sha256, "hash_shared");
            scheduler.record_project_transfer(
                *project_index,
                Ok(test_transfer_result(
                    "art_ready",
                    "hash_shared",
                    10,
                    "already_staged",
                )),
                &mut received_artifacts,
            );
            scheduler.mark_project_discovered(*project_index);

            let ready = scheduler.drain_ready_projects();

            assert_eq!(ready.len(), 1);
            assert!(scheduler.drain_ready_projects().is_empty());
            assert_eq!(received_artifacts.len(), 1);
            assert_eq!(received_artifacts[0].status, "already_staged");
            let staged = &ready[0];
            assert_eq!(manifest_project_id(&staged.manifest), "proj_ready");
            assert_eq!(staged.cleanup_context_manifests.len(), 1);
            assert_eq!(
                manifest_project_id(&staged.cleanup_context_manifests[0]),
                "proj_pending"
            );
            assert_eq!(staged.available_content_sha256, vec!["hash_shared"]);

            let apply_manifests = apply_project_manifests_with_cleanup_context(
                &staged.manifest,
                &staged.cleanup_context_manifests,
            );
            let remote_metadata = remote_metadata_for_projects(
                &json!({
                    "projects": [
                        { "project_id": "proj_ready" },
                        { "project_id": "proj_pending" }
                    ]
                }),
                &apply_manifests
                    .iter()
                    .map(manifest_project_id)
                    .collect::<Vec<_>>(),
            );
            let body = reconciliation_apply_body_with_project_ids(
                "dev_peer",
                &remote_metadata,
                &apply_manifests,
                &staged.available_content_sha256,
                &["proj_ready".to_string()],
                IROH_TRANSPORT_ID,
            );

            let body_manifest_ids = body
                .get("project_manifests")
                .and_then(Value::as_array)
                .expect("project manifests")
                .iter()
                .map(manifest_project_id)
                .collect::<Vec<_>>();
            assert_eq!(body_manifest_ids, vec!["proj_ready", "proj_pending"]);
            assert_eq!(body.get("project_ids"), Some(&json!(["proj_ready"])));
            assert_eq!(
                body.pointer("/peer_inventory/0/available_content_sha256"),
                Some(&json!(["hash_shared"]))
            );
        }

        #[test]
        fn iroh_global_scheduler_isolates_failed_artifact_project() {
            let mut scheduler = IrohGlobalProjectScheduler::default();
            let mut received_artifacts = Vec::new();
            let failed_artifact = RemoteArtifact {
                artifact_id: "art_failed".to_string(),
                project_id: "proj_failed".to_string(),
                content_sha256: "hash_failed".to_string(),
                size_bytes: 10,
            };
            let ok_artifact = RemoteArtifact {
                artifact_id: "art_ok".to_string(),
                project_id: "proj_ok".to_string(),
                content_sha256: "hash_ok".to_string(),
                size_bytes: 20,
            };
            let failed_project =
                scheduler.push_project(json!({ "project": { "project_id": "proj_failed" } }));
            let ok_project =
                scheduler.push_project(json!({ "project": { "project_id": "proj_ok" } }));

            scheduler
                .add_pending_artifact(failed_project, failed_artifact.clone())
                .expect("add failed pending");
            scheduler
                .add_pending_artifact(ok_project, ok_artifact.clone())
                .expect("add ok pending");
            scheduler.mark_project_discovered(failed_project);
            scheduler.mark_project_discovered(ok_project);

            scheduler.record_artifact_transfer(
                Err(transfer_failure(
                    &failed_artifact,
                    TransferTimer::zero_now(),
                    "stream failed".to_string(),
                )),
                &mut received_artifacts,
            );
            let ready = scheduler.drain_ready_projects();

            assert_eq!(ready.len(), 1);
            assert_eq!(manifest_project_id(&ready[0].manifest), "proj_failed");
            assert_eq!(ready[0].transfer_failure.as_deref(), Some("stream failed"));
            assert_eq!(received_artifacts.len(), 1);
            assert_eq!(received_artifacts[0].status, "failed");

            scheduler.record_artifact_transfer(
                Ok(test_transfer_result("art_ok", "hash_ok", 20, "received")),
                &mut received_artifacts,
            );
            let ready = scheduler.drain_ready_projects();

            assert_eq!(ready.len(), 1);
            assert_eq!(manifest_project_id(&ready[0].manifest), "proj_ok");
            assert!(ready[0].transfer_failure.is_none());
            assert_eq!(
                ready[0].available_content_sha256,
                vec!["hash_ok".to_string()]
            );
        }

        #[test]
        fn batch_apply_response_maps_projects_to_imported_skipped_and_failed() {
            let manifests = vec![
                json!({ "project": { "project_id": "proj_imported" }, "artifacts": [] }),
                json!({ "project": { "project_id": "proj_skipped" }, "artifacts": [] }),
                json!({ "project": { "project_id": "proj_conflicted" }, "artifacts": [] }),
                json!({ "project": { "project_id": "proj_failed" }, "artifacts": [] }),
            ];
            let response = json!({
                "results": [
                    {
                        "action": {
                            "action_type": "fetch_artifact_content",
                            "item_type": "artifact",
                            "item_id": "art_imported",
                            "project_id": "proj_imported"
                        },
                        "status": "satisfied",
                        "reason": "Required artifact content is staged."
                    },
                    {
                        "action": {
                            "action_type": "import_project_manifest",
                            "item_type": "project",
                            "item_id": "proj_imported",
                            "project_id": "proj_imported"
                        },
                        "status": "applied",
                        "reason": "Project manifest was imported."
                    },
                    {
                        "action": {
                            "action_type": "record_conflict",
                            "item_type": "project",
                            "item_id": "proj_conflicted",
                            "project_id": "proj_conflicted",
                            "reason": "Local and remote project data diverged."
                        },
                        "status": "skipped",
                        "reason": "Conflict persistence is not available through existing sync services."
                    },
                    {
                        "action": {
                            "action_type": "upsert_project_status",
                            "item_type": "project",
                            "item_id": "proj_conflicted",
                            "project_id": "proj_conflicted",
                            "details": {
                                "project_status": "conflicted"
                            }
                        },
                        "status": "applied",
                        "reason": "Marked project conflicted."
                    },
                    {
                        "action": {
                            "action_type": "import_project_manifest",
                            "item_type": "project",
                            "item_id": "proj_failed",
                            "project_id": "proj_failed"
                        },
                        "status": "failed",
                        "reason": "Project manifest import failed."
                    }
                ]
            });

            let results = map_batch_apply_response(&manifests, &response);

            assert_eq!(results.len(), 4);
            assert_eq!(results[0].project_id, "proj_imported");
            assert_eq!(results[0].status, "imported");
            assert_eq!(results[1].project_id, "proj_skipped");
            assert_eq!(results[1].status, "skipped");
            assert_eq!(results[2].project_id, "proj_conflicted");
            assert_eq!(results[2].status, "conflicted");
            assert_eq!(
                results[2].message.as_deref(),
                Some(
                    "Reconciliation apply: 1 applied, 0 satisfied, 1 skipped, 0 failed, 2 conflicted action(s). Local and remote project data diverged."
                )
            );
            assert_eq!(results[3].project_id, "proj_failed");
            assert_eq!(results[3].status, "failed");

            let counts = import_outcome_counts(&results);
            assert_eq!(
                counts,
                ImportOutcomeCounts {
                    imported: 1,
                    skipped: 1,
                    failed: 2,
                }
            );
        }

        #[test]
        fn batch_apply_response_surfaces_generated_analysis_remote_newer_resolution() {
            let manifests = vec![json!({
                "project": { "project_id": "proj_generated" },
                "artifacts": []
            })];
            let response = json!({
                "plan": {
                    "items": [{
                        "item_type": "artifact",
                        "item_id": "art_analysis",
                        "project_id": "proj_generated",
                        "status": "remote_available",
                        "action_type": "import_artifact_manifest",
                        "content_sha256": "hash_remote_analysis",
                        "reason": "Generated analysis artifact updated from newer peer analysis.",
                        "details": {
                            "artifact_type": "analysis_json",
                            "resolution": "remote_newer_import",
                            "can_regenerate": true
                        }
                    }]
                },
                "results": [{
                    "action": {
                        "action_type": "import_artifact_manifest",
                        "item_type": "artifact",
                        "item_id": "art_analysis",
                        "project_id": "proj_generated",
                        "content_sha256": "hash_remote_analysis",
                        "reason": "Generated analysis artifact updated from newer peer analysis.",
                        "details": {
                            "artifact_type": "analysis_json",
                            "resolution": "remote_newer_import",
                            "can_regenerate": true
                        }
                    },
                    "status": "applied",
                    "reason": "Artifact manifest was imported into the existing project."
                }]
            });

            let results = map_batch_apply_response(&manifests, &response);

            assert_eq!(results.len(), 1);
            assert_eq!(results[0].project_id, "proj_generated");
            assert_eq!(results[0].status, "applied");
            assert_eq!(
                results[0].message.as_deref(),
                Some(
                    "Reconciliation apply: 1 applied, 0 satisfied, 0 skipped, 0 failed, 0 conflicted action(s). Generated analysis artifact updated from newer peer analysis."
                )
            );
        }

        #[test]
        fn batch_apply_response_surfaces_generated_analysis_kept_local_resolution() {
            let manifests = vec![json!({
                "project": { "project_id": "proj_generated" },
                "artifacts": []
            })];
            let response = json!({
                "plan": {
                    "items": [{
                        "item_type": "artifact",
                        "item_id": "art_analysis",
                        "project_id": "proj_generated",
                        "status": "identical_content",
                        "action_type": "noop",
                        "content_sha256": "hash_local_analysis",
                        "reason": "Generated analysis artifact kept local because local analysis is newer.",
                        "details": {
                            "artifact_type": "analysis_json",
                            "resolution": "local_newer_keep_local",
                            "can_regenerate": true
                        }
                    }]
                },
                "results": [{
                    "action": {
                        "action_type": "noop",
                        "item_type": "artifact",
                        "item_id": "art_analysis",
                        "project_id": "proj_generated",
                        "content_sha256": "hash_local_analysis",
                        "reason": "Generated analysis artifact kept local because local analysis is newer.",
                        "details": {
                            "artifact_type": "analysis_json",
                            "resolution": "local_newer_keep_local",
                            "can_regenerate": true
                        }
                    },
                    "status": "satisfied",
                    "reason": "Action is already satisfied."
                }]
            });

            let results = map_batch_apply_response(&manifests, &response);

            assert_eq!(results.len(), 1);
            assert_eq!(results[0].project_id, "proj_generated");
            assert_eq!(results[0].status, "skipped");
            assert_eq!(
                results[0].message.as_deref(),
                Some(
                    "Reconciliation apply: 0 applied, 1 satisfied, 0 skipped, 0 failed, 0 conflicted action(s). Generated analysis artifact kept local because local analysis is newer."
                )
            );
        }

        #[test]
        fn sync_result_summary_distinguishes_import_skips_and_failures() {
            let counts = ImportOutcomeCounts {
                imported: 2,
                skipped: 1,
                failed: 1,
            };
            let transfer_counts = SyncTransportTransferCounts {
                requested: 8,
                received: 6,
                already_staged: 1,
                failed: 1,
                received_bytes: 120,
                already_staged_bytes: 20,
            };

            assert_eq!(
                sync_result_status(&[], counts.failed),
                "completed_with_errors"
            );
            let message = sync_result_message(4, 5, &transfer_counts, counts);
            let expected = "Exchanged 4 local and 5 remote manifest(s); imported 2 project(s), skipped 1 project(s), failed 1 project(s), received 6 artifact(s), reused 1 staged artifact(s), failed 1 transfer(s).";
            assert_eq!(message, expected);
        }

        #[test]
        fn backend_preflight_failed_result_serializes_not_started_transport() {
            let started_at = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
                .expect("timestamp")
                .with_timezone(&Utc);
            let result = failed_preflight_sync_result(
                "sync_preflight".to_string(),
                "dev_peer".to_string(),
                BACKEND_PREFLIGHT_UNRESPONSIVE_CODE,
                BACKEND_PREFLIGHT_UNRESPONSIVE_MESSAGE.to_string(),
                started_at,
                Instant::now(),
            );

            let value = serde_json::to_value(result).expect("serialize failed result");

            assert_eq!(value.get("status"), Some(&json!("failed")));
            assert_eq!(
                value.get("selectedTransport"),
                Some(&json!(NOT_STARTED_TRANSPORT_ID))
            );
            assert_eq!(value.get("attemptedTransports"), Some(&json!([])));
            assert_eq!(
                value.get("fallbackCode"),
                Some(&json!(BACKEND_PREFLIGHT_UNRESPONSIVE_CODE))
            );
            assert_eq!(value.get("remoteDeviceId"), Some(&json!("dev_peer")));
        }

        #[test]
        fn backend_preflight_gate_allows_busy_job_state() {
            let preflight: SyncBackendPreflight = serde_json::from_value(json!({
                "ok": true,
                "library_ok": true,
                "total_projects": 1,
                "ready_projects": 1,
                "missing_source_hash_projects": 0,
                "invalid_source_hash_projects": 0,
                "duplicate_source_hash_projects": 0,
                "noncanonical_project_id_projects": 0,
                "job_state": {
                    "state": "busy",
                    "running_job_count": 0,
                    "pending_job_count": 1,
                    "blocking_job_count": 1,
                    "blocking_job_counts": { "pending": 1, "running": 0 },
                    "blocking_jobs": [
                        {
                            "id": "job_pending_preflight",
                            "project_id": "project_pending",
                            "project_name": "Pending Fixture",
                            "type": "analyze",
                            "status": "pending",
                            "progress": 12,
                            "started_at": null,
                            "updated_at": "2026-01-02T03:04:05"
                        }
                    ],
                    "blocking_jobs_truncated": false,
                    "guidance": [
                        "Backend jobs are running. Sync can start, but backend work may delay sync endpoint responses."
                    ]
                },
                "manual_cleanup_required": false,
                "manual_cleanup_guidance": []
            }))
            .expect("preflight");

            assert!(sync_preflight_failure(&preflight).is_none());

            let failure = sync_endpoint_unresponsive_failure(&preflight);
            assert_eq!(failure.fallback_code, BACKEND_BUSY_CODE);
            assert!(!failure.message.contains("Library sync preflight failed"));
            assert!(failure.message.contains("1 pending job"));
            assert!(failure.message.contains("analyze: 1"));
        }

        #[test]
        fn backend_preflight_gate_uses_blocking_job_counts_without_jobs() {
            let preflight: SyncBackendPreflight = serde_json::from_value(json!({
                "ok": true,
                "library_ok": true,
                "job_state": {
                    "state": "busy",
                    "running_job_count": 0,
                    "pending_job_count": 1,
                    "blocking_job_count": 1,
                    "blocking_job_counts": { "pending": 1, "running": 0 },
                    "blocking_jobs": [],
                    "blocking_jobs_truncated": true,
                    "guidance": []
                },
                "manual_cleanup_required": false,
                "manual_cleanup_guidance": []
            }))
            .expect("preflight");

            assert!(sync_preflight_failure(&preflight).is_none());

            let failure = sync_endpoint_unresponsive_failure(&preflight);
            assert_eq!(failure.fallback_code, BACKEND_BUSY_CODE);
            assert!(failure.message.contains("1 pending job"));
        }

        #[test]
        fn backend_preflight_gate_blocks_unexplained_not_ok() {
            let preflight: SyncBackendPreflight = serde_json::from_value(json!({
                "ok": false,
                "library_ok": true,
                "total_projects": 1,
                "ready_projects": 1,
                "missing_source_hash_projects": 0,
                "invalid_source_hash_projects": 0,
                "duplicate_source_hash_projects": 0,
                "noncanonical_project_id_projects": 0,
                "job_state": {
                    "state": "ready",
                    "running_job_count": 0,
                    "pending_job_count": 0,
                    "blocking_job_count": 0,
                    "blocking_job_counts": { "pending": 0, "running": 0 },
                    "blocking_jobs": [],
                    "blocking_jobs_truncated": false,
                    "guidance": []
                },
                "manual_cleanup_required": false,
                "manual_cleanup_guidance": []
            }))
            .expect("preflight");

            let failure = sync_preflight_failure(&preflight).expect("not ok failure");

            assert_eq!(failure.fallback_code, LIBRARY_PREFLIGHT_FAILED_CODE);
            assert!(failure.message.contains("Library sync preflight failed"));
        }

        #[test]
        fn backend_preflight_gate_blocks_library_cleanup_failures() {
            let preflight: SyncBackendPreflight = serde_json::from_value(json!({
                "ok": false,
                "library_ok": false,
                "total_projects": 4,
                "ready_projects": 1,
                "missing_source_hash_projects": 1,
                "duplicate_source_hash_projects": 2,
                "manual_cleanup_required": true,
                "manual_cleanup_guidance": [
                    MISSING_SOURCE_HASH_GUIDANCE,
                    DUPLICATE_SOURCE_HASH_GUIDANCE
                ]
            }))
            .expect("preflight");

            let failure = sync_preflight_failure(&preflight).expect("library failure");

            assert_eq!(failure.fallback_code, LIBRARY_PREFLIGHT_FAILED_CODE);
            assert!(failure.message.contains("1 missing source hash project"));
            assert!(failure.message.contains("2 duplicate source hash projects"));
            assert!(failure.message.contains("Manual cleanup:"));
            assert!(failure.message.contains("re-import affected projects"));
            assert!(!failure.message.contains("source_path"));
        }

        #[test]
        fn sync_result_serializes_phase_timings_and_transport_metrics() {
            let result = SyncTransportSyncResult {
                run_id: "sync_test".to_string(),
                peer_device_id: "dev_peer".to_string(),
                remote_device_id: "dev_remote".to_string(),
                status: "completed".to_string(),
                message: "done".to_string(),
                selected_transport: TCP_TRANSPORT_ID.to_string(),
                fallback_reason: None,
                fallback_code: None,
                attempted_transports: vec![TCP_TRANSPORT_ID.to_string()],
                started_at: "2026-01-01T00:00:00Z".to_string(),
                completed_at: "2026-01-01T00:00:02Z".to_string(),
                duration_ms: 2_000,
                project_results: Vec::new(),
                imported_projects: Vec::new(),
                imported_project_count: 0,
                skipped_project_count: 0,
                failed_project_count: 0,
                received_artifacts: Vec::new(),
                transfer_counts: SyncTransportTransferCounts::default(),
                served_artifact_requests: 1,
                total_received_bytes: 30,
                total_served_bytes: 70,
                time_to_first_artifact_ms: Some(250),
                throughput_bytes_per_second: 50.0,
                scratch_peak_bytes: 0,
                staging_peak_bytes: 0,
                max_active_streams: 0,
                credit_grants: 0,
                credit_revokes: 0,
                remote_manifest_count: 0,
                local_manifest_count: 0,
                manifest_errors: Vec::new(),
                lifecycle_events: Vec::new(),
                retryable_interruption_code: None,
                retry_guidance: None,
                phase_timings: vec![SyncTransportTimingEvidence {
                    phase: "artifact_transfer".to_string(),
                    project_id: Some("proj_one".to_string()),
                    artifact_id: Some("art_one".to_string()),
                    started_at: "2026-01-01T00:00:00Z".to_string(),
                    completed_at: "2026-01-01T00:00:01Z".to_string(),
                    duration_ms: 1_000,
                }],
                diagnostics: SyncTransportDiagnostics {
                    credit_wait_ms_total: 42,
                    credit_wait_ms_max: 40,
                    credit_wait_events: 2,
                    credit_hold_ms_total: 80,
                    credit_hold_ms_max: 50,
                    stage_queue_wait_ms_total: 9,
                    stage_queue_wait_ms_max: 6,
                    stage_queue_wait_events: 3,
                    stream_open_ms_total: 5,
                    stream_open_ms_max: 4,
                    stream_open_events: 2,
                    sender_write_ms_total: 120,
                    sender_write_ms_max: 70,
                    sender_write_events: 4,
                    receiver_read_ms_total: 130,
                    receiver_read_ms_max: 90,
                    receiver_read_events: 5,
                    receiver_hash_ms_total: 11,
                    receiver_hash_ms_max: 5,
                    receiver_hash_events: 5,
                    receiver_temp_write_ms_total: 39,
                    receiver_temp_write_ms_max: 12,
                    receiver_temp_write_events: 5,
                    staging_post_ms_total: 300,
                    staging_post_ms_max: 200,
                    staging_post_events: 2,
                },
            };

            let value = serde_json::to_value(result).expect("serialize sync result");

            assert!(value.get("phaseTimings").is_some());
            assert!(value.get("timings").is_none());
            assert_eq!(
                value.get("selectedTransport"),
                Some(&json!(TCP_TRANSPORT_ID))
            );
            assert_eq!(value.get("fallbackReason"), Some(&Value::Null));
            assert_eq!(value.get("fallbackCode"), Some(&Value::Null));
            assert_eq!(
                value.get("attemptedTransports"),
                Some(&json!([TCP_TRANSPORT_ID]))
            );
            assert_eq!(value.get("totalReceivedBytes"), Some(&json!(30)));
            assert_eq!(value.get("totalServedBytes"), Some(&json!(70)));
            assert_eq!(value.get("timeToFirstArtifactMs"), Some(&json!(250)));
            assert_eq!(value.get("throughputBytesPerSecond"), Some(&json!(50.0)));
            assert_eq!(value.get("scratchPeakBytes"), Some(&json!(0)));
            assert_eq!(value.get("stagingPeakBytes"), Some(&json!(0)));
            assert_eq!(value.get("maxActiveStreams"), Some(&json!(0)));
            assert_eq!(value.get("creditGrants"), Some(&json!(0)));
            assert_eq!(value.get("creditRevokes"), Some(&json!(0)));
            assert_eq!(value.get("credit_wait_ms_total"), Some(&json!(42)));
            assert_eq!(value.get("credit_wait_ms_max"), Some(&json!(40)));
            assert_eq!(value.get("credit_wait_events"), Some(&json!(2)));
            assert_eq!(value.get("credit_hold_ms_total"), Some(&json!(80)));
            assert_eq!(value.get("credit_hold_ms_max"), Some(&json!(50)));
            assert_eq!(value.get("stage_queue_wait_ms_total"), Some(&json!(9)));
            assert_eq!(value.get("stage_queue_wait_ms_max"), Some(&json!(6)));
            assert_eq!(value.get("stage_queue_wait_events"), Some(&json!(3)));
            assert_eq!(value.get("stream_open_ms_total"), Some(&json!(5)));
            assert_eq!(value.get("stream_open_ms_max"), Some(&json!(4)));
            assert_eq!(value.get("stream_open_events"), Some(&json!(2)));
            assert_eq!(value.get("sender_write_ms_total"), Some(&json!(120)));
            assert_eq!(value.get("sender_write_ms_max"), Some(&json!(70)));
            assert_eq!(value.get("sender_write_events"), Some(&json!(4)));
            assert_eq!(value.get("receiver_read_ms_total"), Some(&json!(130)));
            assert_eq!(value.get("receiver_read_ms_max"), Some(&json!(90)));
            assert_eq!(value.get("receiver_read_events"), Some(&json!(5)));
            assert_eq!(value.get("receiver_hash_ms_total"), Some(&json!(11)));
            assert_eq!(value.get("receiver_hash_ms_max"), Some(&json!(5)));
            assert_eq!(value.get("receiver_hash_events"), Some(&json!(5)));
            assert_eq!(value.get("receiver_temp_write_ms_total"), Some(&json!(39)));
            assert_eq!(value.get("receiver_temp_write_ms_max"), Some(&json!(12)));
            assert_eq!(value.get("receiver_temp_write_events"), Some(&json!(5)));
            assert_eq!(value.get("staging_post_ms_total"), Some(&json!(300)));
            assert_eq!(value.get("staging_post_ms_max"), Some(&json!(200)));
            assert_eq!(value.get("staging_post_events"), Some(&json!(2)));
        }

        #[test]
        fn sync_result_serializes_iroh_transport_evidence() {
            let result = SyncTransportSyncResult {
                run_id: "sync_iroh".to_string(),
                peer_device_id: "dev_peer".to_string(),
                remote_device_id: "dev_remote".to_string(),
                status: "completed".to_string(),
                message: "done".to_string(),
                selected_transport: IROH_TRANSPORT_ID.to_string(),
                fallback_reason: Some(format!(
                    "Iroh sync transport was unavailable (direct path failed); using {TCP_TRANSPORT_ID}."
                )),
                fallback_code: Some("iroh_connect_failed".to_string()),
                attempted_transports: vec![
                    IROH_TRANSPORT_ID.to_string(),
                    TCP_TRANSPORT_ID.to_string(),
                ],
                started_at: "2026-01-01T00:00:00Z".to_string(),
                completed_at: "2026-01-01T00:00:02Z".to_string(),
                duration_ms: 2_000,
                project_results: Vec::new(),
                imported_projects: Vec::new(),
                imported_project_count: 0,
                skipped_project_count: 0,
                failed_project_count: 0,
                received_artifacts: Vec::new(),
                transfer_counts: SyncTransportTransferCounts::default(),
                served_artifact_requests: 0,
                total_received_bytes: 0,
                total_served_bytes: 0,
                time_to_first_artifact_ms: None,
                throughput_bytes_per_second: 0.0,
                scratch_peak_bytes: 96,
                staging_peak_bytes: 48,
                max_active_streams: 4,
                credit_grants: 7,
                credit_revokes: 2,
                remote_manifest_count: 0,
                local_manifest_count: 0,
                manifest_errors: Vec::new(),
                lifecycle_events: Vec::new(),
                retryable_interruption_code: None,
                retry_guidance: None,
                phase_timings: Vec::new(),
                diagnostics: SyncTransportDiagnostics::default(),
            };

            let value = serde_json::to_value(result).expect("serialize sync result");

            assert_eq!(
                value.get("selectedTransport"),
                Some(&json!(IROH_TRANSPORT_ID))
            );
            assert_eq!(
                value.get("attemptedTransports"),
                Some(&json!([IROH_TRANSPORT_ID, TCP_TRANSPORT_ID]))
            );
            assert_eq!(
                value.get("fallbackReason"),
                Some(&json!(format!(
                    "Iroh sync transport was unavailable (direct path failed); using {TCP_TRANSPORT_ID}."
                )))
            );
            assert_eq!(
                value.get("fallbackCode"),
                Some(&json!("iroh_connect_failed"))
            );
            assert_eq!(value.get("scratchPeakBytes"), Some(&json!(96)));
            assert_eq!(value.get("stagingPeakBytes"), Some(&json!(48)));
            assert_eq!(value.get("maxActiveStreams"), Some(&json!(4)));
            assert_eq!(value.get("creditGrants"), Some(&json!(7)));
            assert_eq!(value.get("creditRevokes"), Some(&json!(2)));
        }

        #[test]
        fn transfer_result_serializes_timing_and_throughput() {
            let result = test_transfer_result("art_one", "hash_a", 10, "received");

            let value = serde_json::to_value(result).expect("serialize transfer result");

            assert_eq!(value.get("startedAt"), Some(&json!("2026-01-01T00:00:00Z")));
            assert_eq!(
                value.get("completedAt"),
                Some(&json!("2026-01-01T00:00:01Z"))
            );
            assert_eq!(value.get("durationMs"), Some(&json!(1_000)));
            assert_eq!(value.get("throughputBytesPerSecond"), Some(&json!(10.0)));
        }

        #[test]
        fn sync_manifest_errors_include_local_and_peer_export_failures() {
            let local_errors = vec![SyncTransportManifestError {
                project_id: "proj_local".to_string(),
                message: "local failure".to_string(),
            }];
            let remote_errors = vec![SyncTransportManifestError {
                project_id: "proj_peer".to_string(),
                message: "peer failure".to_string(),
            }];

            let errors = sync_manifest_errors(&local_errors, &remote_errors);

            assert_eq!(errors.len(), 2);
            assert_eq!(errors[0].project_id, "proj_local");
            assert_eq!(
                errors[0].message,
                "Local manifest export failed: local failure"
            );
            assert_eq!(errors[1].project_id, "proj_peer");
            assert_eq!(
                errors[1].message,
                "Peer manifest export failed: peer failure"
            );
            assert_eq!(sync_result_status(&errors, 0), "completed_with_errors");
        }

        #[test]
        fn temp_artifact_path_is_unique_per_transfer() {
            let first = temp_artifact_path_in(env::temp_dir(), "hash_same");
            let second = temp_artifact_path_in(env::temp_dir(), "hash_same");

            assert_ne!(first, second);
        }

        #[test]
        fn desktop_temp_artifact_root_uses_health_data_root_without_tmp_fallback() {
            let health = json!({ "data_root": "/var/lib/tuneforge-test" });

            let root = sync_transport_temp_root_from_health(&health)
                .expect("resolve sync transport temp root");

            assert_eq!(
                root,
                PathBuf::from("/var/lib/tuneforge-test")
                    .join("sync")
                    .join("transport-tmp")
            );
            let temp_path = temp_artifact_path_in(root.clone(), "hash_one");
            assert!(temp_path.starts_with(&root));
            assert!(!temp_path
                .to_string_lossy()
                .contains("tuneforge-sync-transport"));
            assert!(sync_transport_temp_root_from_health(&json!({})).is_err());
            assert!(sync_transport_temp_root_from_health(&json!({ "data_root": "" })).is_err());
        }

        #[test]
        fn available_content_sha256_deduplicates_received_and_already_staged_artifacts() {
            let received_artifacts = vec![
                test_transfer_result("art_one", "hash_b", 10, "received"),
                test_transfer_result("art_two", "hash_a", 20, "already_staged"),
                test_transfer_result("art_three", "hash_b", 10, "already_staged"),
                SyncTransportTransferResult {
                    message: Some("transfer failed".to_string()),
                    ..test_transfer_result("art_failed", "hash_c", 30, "failed")
                },
            ];

            assert_eq!(
                available_content_sha256(&received_artifacts),
                vec!["hash_a".to_string(), "hash_b".to_string()]
            );
        }

        #[test]
        fn transfer_counts_summarizes_received_reused_and_failed_transfers() {
            let counts = transfer_counts(&[
                test_transfer_result("art_one", "hash_a", 10, "received"),
                test_transfer_result("art_two", "hash_b", 20, "already_staged"),
                SyncTransportTransferResult {
                    message: Some("transfer failed".to_string()),
                    ..test_transfer_result("art_three", "hash_c", 30, "failed")
                },
            ]);

            assert_eq!(counts.requested, 3);
            assert_eq!(counts.received, 1);
            assert_eq!(counts.already_staged, 1);
            assert_eq!(counts.failed, 1);
            assert_eq!(counts.received_bytes, 10);
            assert_eq!(counts.already_staged_bytes, 20);
        }

        #[test]
        fn remote_metadata_for_project_filters_full_offer_to_one_project() {
            let metadata = json!({
                "projects": [
                    { "project_id": "proj_one", "display_name": "One" },
                    { "project_id": "proj_two", "display_name": "Two" }
                ],
                "artifacts": [
                    { "artifact_id": "art_one", "project_id": "proj_one" },
                    { "artifact_id": "art_two", "project_id": "proj_two" }
                ],
                "entity_revisions": [
                    { "revision_id": "rev_one", "project_id": "proj_one" },
                    { "revision_id": "rev_two", "project_id": "proj_two" }
                ],
                "delete_tombstones": [
                    { "tombstone_id": "del_one", "project_id": "proj_one" },
                    { "tombstone_id": "del_two", "project_id": "proj_two" }
                ]
            });
            let filtered = remote_metadata_for_project(&metadata, "proj_two");

            assert_eq!(
                filtered
                    .get("projects")
                    .and_then(Value::as_array)
                    .and_then(|projects| projects.first())
                    .and_then(|project| project.get("project_id"))
                    .and_then(Value::as_str),
                Some("proj_two")
            );
            assert_eq!(
                filtered
                    .get("projects")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1)
            );
            assert_eq!(
                filtered
                    .get("artifacts")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1)
            );
            assert_eq!(
                filtered
                    .get("delete_tombstones")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1)
            );
        }

        #[test]
        fn planned_delete_project_ids_reads_tombstone_apply_actions() {
            let plan = json!({
                "actions": [
                    {
                        "action_type": "apply_delete_tombstone",
                        "project_id": "proj_deleted",
                        "item_id": "proj_deleted"
                    },
                    {
                        "action_type": "apply_delete_tombstone",
                        "project_id": "proj_deleted",
                        "item_id": "art_deleted"
                    },
                    {
                        "action_type": "import_project_manifest",
                        "project_id": "proj_live",
                        "item_id": "proj_live"
                    }
                ]
            });

            assert_eq!(
                planned_delete_project_ids(&plan),
                vec!["proj_deleted".to_string()]
            );
        }

        #[test]
        fn project_apply_response_maps_delete_tombstone_to_deleted_result() {
            let results = map_project_apply_response(
                &["proj_deleted".to_string()],
                &json!({
                    "results": [{
                        "action": {
                            "action_type": "apply_delete_tombstone",
                            "item_type": "project",
                            "item_id": "proj_deleted",
                            "project_id": "proj_deleted"
                        },
                        "status": "applied",
                        "reason": "Delete tombstone was applied through the sync tombstone service."
                    }]
                }),
            );

            assert_eq!(results.len(), 1);
            assert_eq!(results[0].project_id, "proj_deleted");
            assert_eq!(results[0].status, "deleted");
            assert_eq!(
                results[0].message.as_deref(),
                Some(
                    "Reconciliation apply: 1 applied, 0 satisfied, 0 skipped, 0 failed, 0 conflicted action(s). Delete tombstone was applied through the sync tombstone service."
                )
            );
        }

        #[test]
        fn batch_apply_response_uses_final_failure_reason_over_earlier_skip() {
            let manifests = vec![json!({
                "project": { "project_id": "proj_failed" },
                "artifacts": []
            })];
            let response = json!({
                "results": [
                    {
                        "action": {
                            "action_type": "fetch_artifact_content",
                            "item_type": "artifact",
                            "item_id": "art_missing",
                            "project_id": "proj_failed"
                        },
                        "status": "skipped",
                        "reason": "Required artifact content is not staged locally."
                    },
                    {
                        "action": {
                            "action_type": "import_project_manifest",
                            "item_type": "project",
                            "item_id": "proj_failed",
                            "project_id": "proj_failed"
                        },
                        "status": "failed",
                        "reason": "Project manifest import failed after staging completed."
                    }
                ]
            });

            let results = map_batch_apply_response(&manifests, &response);

            assert_eq!(results[0].status, "failed");
            assert_eq!(
                results[0].message.as_deref(),
                Some(
                    "Reconciliation apply: 0 applied, 0 satisfied, 1 skipped, 1 failed, 0 conflicted action(s). Project manifest import failed after staging completed."
                )
            );
        }

        #[test]
        fn percent_decode_preserves_plain_base64url_device_ids() {
            assert_eq!(
                percent_decode("dev_ed25519_abc-DEF_123"),
                "dev_ed25519_abc-DEF_123"
            );
        }
    }
}

pub use desktop::SyncTransportState;

#[tauri::command]
pub fn sync_transport_start_listener(
    state: tauri::State<'_, desktop::SyncTransportState>,
    payload: SyncTransportStartListenerRequest,
) -> Result<SyncTransportStatus, String> {
    desktop::sync_transport_start_listener(state, payload)
}

#[tauri::command]
pub fn sync_transport_stop_listener(
    state: tauri::State<'_, desktop::SyncTransportState>,
) -> Result<SyncTransportStatus, String> {
    desktop::sync_transport_stop_listener(state)
}

#[tauri::command]
pub fn sync_transport_status(
    state: tauri::State<'_, desktop::SyncTransportState>,
) -> SyncTransportStatus {
    desktop::sync_transport_status(state)
}

#[tauri::command]
pub fn sync_transport_record_lifecycle_event(
    state: tauri::State<'_, desktop::SyncTransportState>,
    payload: SyncTransportLifecycleEventRequest,
) -> SyncTransportStatus {
    desktop::sync_transport_record_lifecycle_event(state, payload)
}

#[tauri::command]
pub async fn sync_transport_create_pairing_offer(
    state: tauri::State<'_, desktop::SyncTransportState>,
    payload: SyncTransportPairingOfferRequest,
) -> Result<SyncTransportPairingOffer, String> {
    desktop::sync_transport_create_pairing_offer(state, payload).await
}

#[tauri::command]
pub async fn sync_transport_sync_now(
    state: tauri::State<'_, desktop::SyncTransportState>,
    payload: SyncTransportSyncNowRequest,
) -> Result<SyncTransportSyncResult, String> {
    desktop::sync_transport_sync_now(state, payload).await
}
