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
    pub remote_manifest_count: usize,
    pub local_manifest_count: usize,
    pub manifest_errors: Vec<SyncTransportManifestError>,
    pub phase_timings: Vec<SyncTransportTimingEvidence>,
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
    use std::{io, path::Path, sync::Arc, time::Duration};

    pub(crate) const TCP_TRANSPORT_ID: &str = "tuneforge-sync+tcp";
    pub(crate) const IROH_TRANSPORT_ID: &str = "tuneforge-sync+iroh";
    pub(crate) const ENDPOINT_SCHEME: &str = "tuneforge-sync+tcp://";
    pub(crate) const IROH_ENDPOINT_SCHEME: &str = "tuneforge-sync+iroh://";
    pub(crate) const PAIRING_PROTOCOL_VERSION: &str = "tuneforge-sync-v1";
    pub(crate) const TRANSPORT_PROTOCOL_VERSION: &str = "tuneforge-sync-transport-v3";
    pub(crate) const TRANSPORT_HANDSHAKE_CHALLENGE_TYPE: &str = "transport_handshake";
    pub(crate) const MAX_RAW_FRAME: usize = 65_535;
    pub(crate) const ENCRYPTED_PAYLOAD_CHUNK: usize = 32 * 1024;
    pub(crate) const ARTIFACT_CHUNK_SIZE: usize = 32 * 1024;
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
        ArtifactRequest {
            artifact_id: String,
            content_sha256: String,
            size_bytes: u64,
        },
        ArtifactStart {
            artifact_id: String,
            content_sha256: String,
            size_bytes: u64,
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
                Self::ArtifactRequest { .. } => "artifact_request",
                Self::ArtifactStart { .. } => "artifact_start",
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
    }

    pub(crate) trait ProtocolConnection {
        fn send_message(&mut self, message: &ProtocolMessage) -> Result<(), String>;
        fn read_message(&mut self) -> Result<ProtocolMessage, String>;
        fn handshake_hash(&self) -> &str;
    }

    pub(crate) trait TransportBlobRecorder: Send + Sync {
        fn record_path_identity(&self, path: &Path) -> Result<String, String>;
    }

    pub(crate) type TransportBlobRecorderRef = Arc<dyn TransportBlobRecorder>;

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
        sync_core::*, SyncTransportActiveProgress, SyncTransportManifestError,
        SyncTransportNearbyPeer, SyncTransportPairingOffer, SyncTransportPairingOfferRequest,
        SyncTransportProjectResult, SyncTransportStartListenerRequest, SyncTransportStatus,
        SyncTransportSyncNowRequest, SyncTransportSyncResult, SyncTransportTimingEvidence,
        SyncTransportTransferCounts, SyncTransportTransferResult,
    };
    use chrono::{DateTime, Utc};
    use iroh::{
        endpoint::{presets, BindOpts, RecvStream, SendStream},
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
        collections::{HashMap, HashSet},
        env,
        fs::{self, File},
        io::{self, Read, Write},
        net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream, UdpSocket},
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
    const NOISE_PATTERN: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
    const READ_TIMEOUT: Duration = Duration::from_secs(45);
    const PROTOCOL_WATCHDOG_TIMEOUT: Duration = Duration::from_secs(75);
    const STATUS_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
    const WRITE_TIMEOUT: Duration = Duration::from_secs(45);
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    const ACCEPT_SLEEP: Duration = Duration::from_millis(100);
    #[cfg(not(target_os = "android"))]
    const HTTP_TIMEOUT: Duration = Duration::from_secs(45);

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
            }
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
            let result = self.run_sync_now(payload, run_id.clone());
            update_status(&self.shared_status, |status| {
                apply_sync_now_status_result(status, &result, &run_id);
            });
            result
        }

        fn run_sync_now(
            &self,
            payload: SyncTransportSyncNowRequest,
            run_id: String,
        ) -> Result<SyncTransportSyncResult, String> {
            let run_started_at = Utc::now();
            let run_started_instant = Instant::now();
            record_active_progress(
                &self.shared_status,
                &run_id,
                active_progress(protocol_status_payload(
                    run_id.clone(),
                    "peer_connect",
                    "Connecting to sync peer.",
                    Utc::now().to_rfc3339(),
                    0,
                )),
            );
            let mut timings = Vec::new();
            let mut metrics = SyncRunMetrics::start(run_started_instant);
            let client = BackendClient::new(&self.backend)?;
            let peer = client
                .trusted_peer(&payload.peer_device_id)
                .map_err(|error| format!("Could not load trusted sync peer: {error}"))?
                .ok_or_else(|| {
                    format!(
                        "Trusted sync peer {} is not known or has been revoked.",
                        payload.peer_device_id
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
            )?;
            let mut transport_selection = transport_selection;
            let timer = SyncPhaseTimer::start("peer_connect");
            let mut connection = connect_selected_transport(
                &mut transport_selection,
                local_iroh,
                &payload.peer_device_id,
            )?;
            timings.push(timer.finish());

            let timer = SyncPhaseTimer::start("peer_authentication");
            let local_endpoint_hints = self.current_endpoint_hints();
            let session = authenticate_session(
                &mut connection,
                &client,
                Some(payload.peer_device_id.clone()),
                &local_endpoint_hints,
            )
            .map_err(|error| phase_context_error("peer authentication", error))?;
            connection.set_established_read_timeout()?;
            timings.push(timer.finish());
            let connection = SharedPeerConnection::new(connection);
            let progress = ProgressReporter::new(
                run_id.clone(),
                run_started_instant,
                Arc::clone(&self.shared_status),
                connection.clone(),
            );
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
            connection.send_message_for_phase(
                "manifest exchange",
                &ProtocolMessage::ManifestOffer(local_offer.clone()),
            )?;
            let remote_offer = match connection
                .read_message_accepting_status_for_phase("manifest exchange", &progress)?
            {
                ProtocolMessage::ManifestOffer(offer) => offer,
                ProtocolMessage::Error(error) => {
                    return Err(phase_context_error(
                        "manifest exchange",
                        format!("Sync peer returned an error: {}", error.message),
                    ));
                }
                other => {
                    return Err(format!(
                        "Sync peer sent unexpected message during manifest exchange: {}",
                        other.kind()
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
            if let Err(error) = connection.send_message_for_phase(
                "reconciliation staging",
                &ProtocolMessage::PhaseDone {
                    phase: "initiator_import".to_string(),
                },
            ) {
                finish_staged_remote_import_for_failure(prepared_remote_import);
                return Err(error);
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
                    return Err(error);
                }
            };
            timings.push(timer.finish());
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
                remote_manifest_count: remote_offer.project_manifests.len(),
                local_manifest_count,
                manifest_errors,
                phase_timings: timings,
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
    }

    #[derive(Clone)]
    struct BackendAccess {
        base_url: String,
        #[cfg_attr(not(target_os = "android"), allow(dead_code))]
        app: AppHandle,
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
    }

    #[derive(Clone)]
    struct DiscoveryPeerEntry {
        peer: SyncTransportNearbyPeer,
        expires_at_instant: Instant,
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

    #[derive(Clone)]
    struct IrohTransport {
        endpoint: Endpoint,
        blob_store: IrohBlobStore,
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

    impl IrohBlobStore {
        fn add_path(&self, path: &Path) -> Result<String, String> {
            let store = self.store.clone();
            let path = path.to_path_buf();
            tauri::async_runtime::block_on(async move {
                let tag = store.blobs().add_path(path).await.map_err(|error| {
                    format!("Could not import artifact into iroh-blobs store: {error}")
                })?;
                store.sync_db().await.map_err(|error| {
                    format!("Could not sync iroh-blobs store metadata: {error}")
                })?;
                Ok(tag.hash.to_string())
            })
        }
    }

    impl TransportBlobRecorder for IrohBlobStore {
        fn record_path_identity(&self, path: &Path) -> Result<String, String> {
            self.add_path(path)
        }
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
                .bind_addr((Ipv4Addr::UNSPECIFIED, iroh_port))
                .map_err(|error| format!("Could not configure Iroh IPv4 bind: {error}"))?
                .bind_addr_with_opts(
                    (Ipv6Addr::UNSPECIFIED, iroh_port),
                    BindOpts::default().set_is_required(false),
                )
                .map_err(|error| format!("Could not configure Iroh IPv6 bind: {error}"))?
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
                        let blob_store = transport.blob_store.clone();
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
                                Ok(connection) => match connection.accept_bi().await {
                                    Ok((send, recv)) => Ok(Box::new(IrohPeerStream::new(
                                        send,
                                        recv,
                                        tokio::runtime::Handle::current(),
                                    ))
                                        as Box<dyn PeerStream>),
                                    Err(error) => {
                                        Err(format!("Could not accept Iroh sync stream: {error}"))
                                    }
                                },
                                Err(error) => {
                                    Err(format!("Could not accept Iroh sync connection: {error}"))
                                }
                            };
                            match stream {
                                Ok(stream) => {
                                    let session_status = Arc::clone(&shared_status);
                                    let error_status = Arc::clone(&shared_status);
                                    let join = tauri::async_runtime::spawn_blocking(move || {
                                        handle_incoming_session(
                                            backend,
                                            TransportKind::Iroh,
                                            stream,
                                            Some(Arc::new(blob_store) as TransportBlobRecorderRef),
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
        let blob_store = transport.blob_store.clone();
        let (send, recv, runtime_handle) = tauri::async_runtime::block_on(async move {
            let runtime_handle = tokio::runtime::Handle::current();
            let connection =
                tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(endpoint_addr, IROH_ALPN))
                    .await
                    .map_err(|_| "Timed out connecting to Iroh sync peer.".to_string())?
                    .map_err(|error| format!("Could not connect to Iroh sync peer: {error}"))?;
            let (send, recv) = tokio::time::timeout(CONNECT_TIMEOUT, connection.open_bi())
                .await
                .map_err(|_| "Timed out opening Iroh sync stream.".to_string())?
                .map_err(|error| format!("Could not open Iroh sync stream: {error}"))?;
            Ok::<_, String>((send, recv, runtime_handle))
        })?;
        SecurePeerConnection::connect_initiator(
            Box::new(IrohPeerStream::new(send, recv, runtime_handle)),
            TransportKind::Iroh,
            Some(Arc::new(blob_store) as TransportBlobRecorderRef),
        )
    }

    fn handle_incoming_session(
        backend: BackendAccess,
        transport: TransportKind,
        stream: Box<dyn PeerStream>,
        blob_store: Option<TransportBlobRecorderRef>,
        shared_status: Arc<Mutex<SharedStatus>>,
        endpoint_hints: Vec<String>,
    ) {
        let run_id = sync_run_id();
        let run_started_at = Utc::now();
        let run_started_instant = Instant::now();
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
        let result = serve_incoming_session(
            backend,
            transport,
            stream,
            blob_store,
            endpoint_hints,
            Arc::clone(&shared_status),
            run_id.clone(),
            run_started_at,
            run_started_instant,
        );
        update_status(&shared_status, |status| {
            status.active_sessions = status.active_sessions.saturating_sub(1);
            clear_active_progress_for_run(status, &run_id);
            match result {
                Ok(result) => {
                    status.last_status = Some(result.message);
                    status.last_sync = Some(result.sync_result);
                    status.last_error = None;
                }
                Err(error) => {
                    status.failed_sessions += 1;
                    status.last_error = Some(error);
                }
            }
        });
    }

    fn serve_incoming_session(
        backend: BackendAccess,
        transport: TransportKind,
        stream: Box<dyn PeerStream>,
        blob_store: Option<TransportBlobRecorderRef>,
        endpoint_hints: Vec<String>,
        shared_status: Arc<Mutex<SharedStatus>>,
        run_id: String,
        run_started_at: DateTime<Utc>,
        run_started_instant: Instant,
    ) -> Result<IncomingSessionResult, String> {
        let mut timings = Vec::new();
        let mut metrics = SyncRunMetrics::start(run_started_instant);
        let client = BackendClient::new(&backend)?;
        let timer = SyncPhaseTimer::start("peer_authentication");
        let mut connection =
            SecurePeerConnection::connect_responder(stream, transport, blob_store)?;
        let session = authenticate_session(&mut connection, &client, None, &endpoint_hints)
            .map_err(|error| phase_context_error("peer authentication", error))?;
        connection.set_established_read_timeout()?;
        timings.push(timer.finish());
        let connection = SharedPeerConnection::new(connection);
        let progress = ProgressReporter::new(
            run_id.clone(),
            run_started_instant,
            shared_status,
            connection.clone(),
        );
        let timer = SyncPhaseTimer::start("manifest_exchange");
        let remote_offer = match connection
            .read_message_accepting_status_for_phase("manifest exchange", &progress)?
        {
            ProtocolMessage::ManifestOffer(offer) => offer,
            ProtocolMessage::Error(error) => {
                return Err(phase_context_error(
                    "manifest exchange",
                    format!("Sync peer returned an error: {}", error.message),
                ));
            }
            other => {
                return Err(format!(
                    "Sync peer sent unexpected first sync message: {}",
                    other.kind()
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
        connection.send_message_for_phase(
            "manifest exchange",
            &ProtocolMessage::ManifestOffer(local_offer.clone()),
        )?;

        let timer = SyncPhaseTimer::start("serve_artifact_requests");
        let served_artifact_requests = serve_artifact_requests_until_done(
            &client,
            &connection,
            &local_offer.project_manifests,
            &mut metrics,
            &progress,
        )?;
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
            finish_staged_remote_import_for_failure(Some(prepared_remote_import));
            return Err(error);
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
            remote_manifest_count: remote_offer.project_manifests.len(),
            local_manifest_count,
            manifest_errors,
            phase_timings: timings,
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

    fn apply_sync_now_status_result(
        status: &mut SharedStatus,
        result: &Result<SyncTransportSyncResult, String>,
        run_id: &str,
    ) {
        match result {
            Ok(sync_result) => {
                status.last_status = Some(sync_result.message.clone());
                status.last_sync = Some(sync_result.clone());
                status.last_error = None;
                clear_active_progress_for_run(status, &sync_result.run_id);
            }
            Err(error) => {
                status.last_error = Some(error.clone());
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
    }

    impl ProgressReporter {
        fn new(
            run_id: String,
            run_started_instant: Instant,
            shared_status: Arc<Mutex<SharedStatus>>,
            connection: SharedPeerConnection,
        ) -> Self {
            Self {
                run_id,
                run_started_instant,
                shared_status,
                connection,
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
    }

    impl SyncRunMetrics {
        fn start(started_instant: Instant) -> Self {
            Self {
                started_instant,
                total_received_bytes: 0,
                total_served_bytes: 0,
                first_artifact_at: None,
            }
        }

        fn record_received_artifact_bytes(&mut self, bytes: u64) {
            self.total_received_bytes = self.total_received_bytes.saturating_add(bytes);
            self.record_first_artifact_bytes(bytes);
        }

        fn record_served_artifact_bytes(&mut self, bytes: u64) {
            self.total_served_bytes = self.total_served_bytes.saturating_add(bytes);
            self.record_first_artifact_bytes(bytes);
        }

        fn record_first_artifact_bytes(&mut self, bytes: u64) {
            if bytes > 0 && self.first_artifact_at.is_none() {
                self.first_artifact_at = Some(self.started_instant.elapsed());
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
    }

    struct TcpPeerStream {
        stream: TcpStream,
    }

    impl TcpPeerStream {
        fn new(stream: TcpStream) -> Result<Self, String> {
            configure_stream(&stream)?;
            Ok(Self { stream })
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

    struct SecurePeerConnection {
        stream: Box<dyn PeerStream>,
        noise: snow::TransportState,
        handshake_hash: String,
        next_message_id: u64,
        transport: TransportKind,
        blob_store: Option<TransportBlobRecorderRef>,
    }

    impl SecurePeerConnection {
        fn connect_initiator(
            mut stream: Box<dyn PeerStream>,
            transport: TransportKind,
            blob_store: Option<TransportBlobRecorderRef>,
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
                blob_store,
            })
        }

        fn connect_responder(
            mut stream: Box<dyn PeerStream>,
            transport: TransportKind,
            blob_store: Option<TransportBlobRecorderRef>,
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
                blob_store,
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

    #[derive(Clone)]
    struct SharedPeerConnection {
        inner: Arc<Mutex<SecurePeerConnection>>,
    }

    impl SharedPeerConnection {
        fn new(connection: SecurePeerConnection) -> Self {
            Self {
                inner: Arc::new(Mutex::new(connection)),
            }
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

        fn record_transport_blob_identity(&self, path: &Path) -> Option<String> {
            let blob_store = self
                .inner
                .lock()
                .ok()
                .and_then(|connection| connection.blob_store.clone())?;
            blob_store.record_path_identity(path).ok()
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
            for project_id in selected_project_ids {
                let path = format!(
                    "/api/v1/sync/projects/{}/manifest",
                    percent_encode_path_segment(&project_id)
                );
                match client.get_json_value(&path) {
                    Ok(response) => {
                        if let Some(manifest) = response.get("project_manifest") {
                            project_manifests.push(manifest.clone());
                        } else {
                            manifest_errors.push(SyncTransportManifestError {
                                project_id,
                                message:
                                    "Backend manifest response did not include project_manifest."
                                        .to_string(),
                            });
                        }
                    }
                    Err(error) => manifest_errors.push(SyncTransportManifestError {
                        project_id,
                        message: error.to_string(),
                    }),
                }
            }
        }
        ManifestOffer {
            metadata,
            project_manifests,
            manifest_errors,
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
        manifests: Vec<Value>,
        plan_error: Option<String>,
        apply_worker: Option<RemoteApplyWorker>,
        received_artifacts: Vec<SyncTransportTransferResult>,
    }

    #[derive(Clone, Debug)]
    struct StagedRemoteProject {
        manifest: Value,
        available_content_sha256: Vec<String>,
        transfer_failure: Option<String>,
    }

    enum RemoteApplyTask {
        Project(StagedRemoteProject),
        Tombstone(String),
    }

    // Apply work stays off the transport thread so peers keep serving artifact requests.
    struct RemoteApplyWorker {
        sender: Option<mpsc::Sender<RemoteApplyTask>>,
        handle: JoinHandle<RemoteApplyWorkerResult>,
        queued_project_ids: Vec<String>,
        enqueue_failures: Vec<SyncTransportProjectResult>,
    }

    struct RemoteApplyWorkerResult {
        project_results: Vec<SyncTransportProjectResult>,
        timings: Vec<SyncTransportTimingEvidence>,
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

        let timer = SyncPhaseTimer::start("reconciliation_plan");
        let plan = match {
            let _progress =
                progress.start_phase("reconciliation_plan", "Planning sync reconciliation.");
            plan_remote_manifest_batch(
                client,
                peer_device_id,
                remote_metadata,
                manifests,
                transport_id,
            )
        } {
            Ok(plan) => {
                timings.push(timer.finish());
                plan
            }
            Err(error) => {
                timings.push(timer.finish());
                return StagedRemoteImport {
                    manifests: manifests.to_vec(),
                    plan_error: Some(phase_context_error(
                        "reconciliation plan",
                        format!("Could not plan remote sync reconciliation batch: {error}"),
                    )),
                    apply_worker: None,
                    received_artifacts,
                };
            }
        };

        let mut apply_worker = RemoteApplyWorker::start(
            client,
            peer_device_id,
            remote_metadata,
            transport_id,
            progress.clone(),
        );
        stage_remote_manifest_projects(
            manifests,
            |manifest| {
                stage_remote_manifest_project_artifacts(
                    client,
                    connection,
                    peer_device_id,
                    manifest,
                    &plan,
                    &mut received_artifacts,
                    metrics,
                    timings,
                    progress,
                )
            },
            |staged| apply_worker.enqueue_project(staged),
        );
        let manifest_project_ids: HashSet<String> =
            manifests.iter().map(manifest_project_id).collect();
        for project_id in planned_delete_project_ids(&plan)
            .into_iter()
            .filter(|project_id| !manifest_project_ids.contains(project_id.as_str()))
        {
            apply_worker.enqueue_tombstone(project_id);
        }

        StagedRemoteImport {
            manifests: manifests.to_vec(),
            plan_error: None,
            apply_worker: Some(apply_worker),
            received_artifacts,
        }
    }

    fn stage_remote_manifest_projects(
        manifests: &[Value],
        mut stage_project: impl FnMut(&Value) -> StagedRemoteProject,
        mut enqueue_project: impl FnMut(StagedRemoteProject),
    ) {
        for manifest in manifests {
            let staged = stage_project(manifest);
            enqueue_project(staged);
        }
    }

    fn finish_staged_remote_import(
        staged: StagedRemoteImport,
        timings: &mut Vec<SyncTransportTimingEvidence>,
    ) -> Vec<SyncTransportProjectResult> {
        if let Some(error) = &staged.plan_error {
            return apply_failure_results(&staged.manifests, &HashMap::new(), error);
        }

        if let Some(apply_worker) = staged.apply_worker {
            return apply_worker.finish(timings);
        }

        Vec::new()
    }

    fn finish_staged_remote_import_for_failure(staged: Option<StagedRemoteImport>) {
        if let Some(staged) = staged {
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
            let (sender, receiver) = mpsc::channel();
            let client = client.clone();
            let peer_device_id = peer_device_id.to_string();
            let remote_metadata = remote_metadata.clone();
            let transport_id = transport_id.to_string();
            let handle = thread::spawn(move || {
                let mut result = RemoteApplyWorkerResult {
                    project_results: Vec::new(),
                    timings: Vec::new(),
                };
                while let Ok(task) = receiver.recv() {
                    let project_result = match task {
                        RemoteApplyTask::Project(project) => apply_staged_remote_manifest_project(
                            &client,
                            &peer_device_id,
                            &remote_metadata,
                            &project,
                            &transport_id,
                            &mut result.timings,
                            &progress,
                        ),
                        RemoteApplyTask::Tombstone(project_id) => apply_remote_tombstone_project(
                            &client,
                            &peer_device_id,
                            &remote_metadata,
                            &project_id,
                            &transport_id,
                            &mut result.timings,
                            &progress,
                        ),
                    };
                    result.project_results.push(project_result);
                }
                result
            });

            Self {
                sender: Some(sender),
                handle,
                queued_project_ids: Vec::new(),
                enqueue_failures: Vec::new(),
            }
        }

        fn enqueue_project(&mut self, project: StagedRemoteProject) {
            let project_id = manifest_project_id(&project.manifest);
            self.enqueue(project_id, RemoteApplyTask::Project(project));
        }

        fn enqueue_tombstone(&mut self, project_id: String) {
            self.enqueue(project_id.clone(), RemoteApplyTask::Tombstone(project_id));
        }

        fn enqueue(&mut self, project_id: String, task: RemoteApplyTask) {
            let send_result = self
                .sender
                .as_ref()
                .ok_or_else(|| "Remote sync import worker is closed.".to_string())
                .and_then(|sender| {
                    sender
                        .send(task)
                        .map_err(|_| "Remote sync import worker stopped.".to_string())
                });
            match send_result {
                Ok(()) => self.queued_project_ids.push(project_id),
                Err(error) => self
                    .enqueue_failures
                    .push(failed_project_result(&project_id, &error)),
            }
        }

        fn finish(
            mut self,
            timings: &mut Vec<SyncTransportTimingEvidence>,
        ) -> Vec<SyncTransportProjectResult> {
            self.sender.take();
            match self.handle.join() {
                Ok(mut result) => {
                    timings.append(&mut result.timings);
                    result.project_results.extend(self.enqueue_failures);
                    result.project_results
                }
                Err(_) => self
                    .queued_project_ids
                    .iter()
                    .map(|project_id| {
                        failed_project_result(project_id, "Remote sync import worker panicked.")
                    })
                    .chain(self.enqueue_failures)
                    .collect(),
            }
        }
    }

    fn apply_remote_tombstone_project(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        project_id: &str,
        transport_id: &str,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> SyncTransportProjectResult {
        let remote_metadata = remote_metadata_for_project(remote_metadata, project_id);
        let body = reconciliation_apply_body_with_project_ids(
            peer_device_id,
            &remote_metadata,
            &[],
            &[],
            &[project_id.to_string()],
            transport_id,
        );
        let timer = SyncPhaseTimer::start_project("reconciliation_apply", project_id);
        let response = {
            let _progress =
                progress.start_phase("reconciliation_apply", "Applying remote reconciliation.");
            client.post_json_value("/api/v1/sync/reconciliation/apply", &body)
        };
        timings.push(timer.finish());
        match response {
            Ok(response) => map_project_apply_response(&[project_id.to_string()], &response)
                .pop()
                .unwrap_or_else(|| {
                    failed_project_result(
                        project_id,
                        "Backend apply response did not include this project.",
                    )
                }),
            Err(error) => failed_project_result(
                project_id,
                &phase_context_error("reconciliation apply", error.to_string()),
            ),
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

        for entry in
            planned_fetch_artifact_entries(plan, std::slice::from_ref(manifest), peer_device_id)
        {
            match request_or_use_staged_artifact(
                client,
                connection,
                peer_device_id,
                &entry.artifact,
                metrics,
                timings,
                progress,
            ) {
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
            available_content_sha256: available_content_sha256(&project_transfers),
            transfer_failure,
        }
    }

    fn apply_staged_remote_manifest_project(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        staged: &StagedRemoteProject,
        transport_id: &str,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> SyncTransportProjectResult {
        let project_id = manifest_project_id(&staged.manifest);
        if let Some(error) = &staged.transfer_failure {
            let transfer_failures = HashMap::from([(project_id.clone(), error.clone())]);
            return apply_failure_results(
                std::slice::from_ref(&staged.manifest),
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
            });
        }

        match apply_remote_manifest_project(
            client,
            peer_device_id,
            remote_metadata,
            &staged.manifest,
            &staged.available_content_sha256,
            transport_id,
            timings,
            progress,
        ) {
            Ok(result) => result,
            Err(error) => apply_failure_results(
                std::slice::from_ref(&staged.manifest),
                &HashMap::new(),
                &phase_context_error("reconciliation apply", error.to_string()),
            )
            .into_iter()
            .next()
            .unwrap_or_else(|| {
                failed_project_result(
                    &project_id,
                    "Sync transport reconciliation apply failed without a project result.",
                )
            }),
        }
    }

    fn plan_remote_manifest_batch(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
        transport_id: &str,
    ) -> Result<Value, BackendError> {
        let advertised_content_sha256 = manifest_content_sha256(manifests);
        let body = reconciliation_plan_body(
            peer_device_id,
            remote_metadata,
            manifests,
            &advertised_content_sha256,
            transport_id,
        );
        client.post_json_value("/api/v1/sync/reconciliation/plan", &body)
    }

    fn apply_remote_manifest_project(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        manifest: &Value,
        available_content_sha256: &[String],
        transport_id: &str,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> Result<SyncTransportProjectResult, BackendError> {
        let project_id = manifest_project_id(manifest);
        let manifests = vec![manifest.clone()];
        let remote_metadata = remote_metadata_for_project(remote_metadata, &project_id);
        let body = reconciliation_apply_body(
            peer_device_id,
            &remote_metadata,
            &manifests,
            available_content_sha256,
            transport_id,
        );
        let timer = SyncPhaseTimer::start_project("reconciliation_apply", &project_id);
        let response = {
            let _progress =
                progress.start_phase("reconciliation_apply", "Applying remote reconciliation.");
            client.post_json_value("/api/v1/sync/reconciliation/apply", &body)
        };
        timings.push(timer.finish());
        let response = response?;
        let mut results = map_batch_apply_response(&manifests, &response);
        Ok(results.pop().unwrap_or_else(|| {
            failed_project_result(
                &project_id,
                "Backend apply response did not include this project.",
            )
        }))
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

    fn remote_metadata_for_project(remote_metadata: &Value, project_id: &str) -> Value {
        let mut metadata = remote_metadata
            .as_object()
            .cloned()
            .unwrap_or_else(serde_json::Map::new);
        metadata.insert(
            "projects".to_string(),
            filtered_project_array(remote_metadata, "projects", project_id),
        );
        metadata.insert(
            "artifacts".to_string(),
            filtered_project_array(remote_metadata, "artifacts", project_id),
        );
        metadata.insert(
            "entity_revisions".to_string(),
            filtered_project_array(remote_metadata, "entity_revisions", project_id),
        );
        metadata.insert(
            "delete_tombstones".to_string(),
            filtered_project_array(remote_metadata, "delete_tombstones", project_id),
        );
        Value::Object(metadata)
    }

    fn filtered_project_array(metadata: &Value, key: &str, project_id: &str) -> Value {
        let values = metadata
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| value_project_id(item) == Some(project_id))
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
                let priority = action_reason_priority(status, action);
                if self.selected_reason.is_none() || priority >= self.selected_reason_priority {
                    self.selected_reason = Some(reason.to_string());
                    self.selected_reason_priority = priority;
                }
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
            let reason = result
                .get("reason")
                .and_then(Value::as_str)
                .or_else(|| action.get("reason").and_then(Value::as_str));
            let reason =
                if action.get("action_type").and_then(Value::as_str) == Some("record_conflict") {
                    action.get("reason").and_then(Value::as_str).or(reason)
                } else {
                    reason
                };
            outcome.record(status, action, reason);
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
            let reason = result
                .get("reason")
                .and_then(Value::as_str)
                .or_else(|| action.get("reason").and_then(Value::as_str));
            let reason =
                if action.get("action_type").and_then(Value::as_str) == Some("record_conflict") {
                    action.get("reason").and_then(Value::as_str).or(reason)
                } else {
                    reason
                };
            outcome.record(status, action, reason);
        }

        project_ids
            .iter()
            .map(|project_id| {
                let outcome = outcomes.remove(project_id);
                outcome_to_project_result(project_id.clone(), outcome)
            })
            .collect()
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

    fn request_or_use_staged_artifact(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        peer_device_id: &str,
        artifact: &RemoteArtifact,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> Result<SyncTransportTransferResult, TransferFailure> {
        let transfer_timer = TransferTimer::start();
        let timer = SyncPhaseTimer::start_artifact("artifact_staging_check", artifact);
        let staged = {
            let _progress =
                progress.start_phase("artifact_transfer", "Checking staged artifact content.");
            already_staged_artifact_result(client, artifact)
        };
        timings.push(timer.finish());
        match staged {
            Ok(true) => {
                return Ok(transfer_result(
                    artifact,
                    "already_staged",
                    Some("Artifact content was already staged and verified locally.".to_string()),
                    transfer_timer.finish(0),
                ));
            }
            Ok(false) => {}
            Err(error) => {
                return Err(transfer_failure(artifact, transfer_timer.finish(0), error));
            }
        }
        request_and_stage_artifact(
            client,
            connection,
            peer_device_id,
            artifact,
            transfer_timer,
            metrics,
            timings,
            progress,
        )
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

    fn request_and_stage_artifact(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        peer_device_id: &str,
        artifact: &RemoteArtifact,
        transfer_timer: TransferTimer,
        metrics: &mut SyncRunMetrics,
        timings: &mut Vec<SyncTransportTimingEvidence>,
        progress: &ProgressReporter,
    ) -> Result<SyncTransportTransferResult, TransferFailure> {
        let timer = SyncPhaseTimer::start_artifact("artifact_transfer", artifact);
        let _progress = progress.start_phase("artifact_transfer", "Transferring artifact content.");
        if let Err(error) = connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::ArtifactRequest {
                artifact_id: artifact.artifact_id.clone(),
                content_sha256: artifact.content_sha256.clone(),
                size_bytes: artifact.size_bytes,
            },
        ) {
            timings.push(timer.finish());
            return Err(transfer_failure(artifact, transfer_timer.finish(0), error));
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
                        artifact,
                        transfer_timer.finish(0),
                        "Sync peer artifact response did not match the request.".to_string(),
                    ));
                }
            }
            Ok(ProtocolMessage::Error(error)) => {
                timings.push(timer.finish());
                return Err(transfer_failure(
                    artifact,
                    transfer_timer.finish(0),
                    phase_context_error("artifact request/transfer", error.message),
                ));
            }
            Ok(other) => {
                timings.push(timer.finish());
                return Err(transfer_failure(
                    artifact,
                    transfer_timer.finish(0),
                    format!(
                        "Sync peer sent unexpected artifact response: {}",
                        other.kind()
                    ),
                ));
            }
            Err(error) => {
                timings.push(timer.finish());
                return Err(transfer_failure(artifact, transfer_timer.finish(0), error));
            }
        }

        let temp_path = client.temp_artifact_path(&artifact.content_sha256);
        if let Some(parent) = temp_path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                timings.push(timer.finish());
                return Err(transfer_failure(
                    artifact,
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
                    artifact,
                    transfer_timer.finish(0),
                    format!("Could not create sync artifact temp file: {error}"),
                ));
            }
        };
        let mut hasher = Sha256::new();
        let mut size_bytes = 0_u64;
        let receive_result = loop {
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
                        break Err(
                            "Received sync artifact bytes failed SHA-256 or size verification."
                                .to_string(),
                        );
                    }
                    break Ok(());
                }
                Ok(ArtifactTransferFrame::Message(ProtocolMessage::Error(error))) => {
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
            let cleanup_timer = SyncPhaseTimer::start_artifact("artifact_cleanup", artifact);
            let _ = fs::remove_file(&temp_path);
            timings.push(cleanup_timer.finish());
            return Err(transfer_failure(artifact, transfer_timing, error));
        }

        // Prototype scope: bytes still move over the TuneForge stream frames. The
        // disk-backed iroh-blobs store records a transport-local BLAKE3 identity
        // only after TuneForge SHA-256/size verification succeeds.
        let transport_local_blob_hash = connection.record_transport_blob_identity(&temp_path);
        let body = json!({
            "source_path": temp_path.to_string_lossy(),
            "content_sha256": artifact.content_sha256,
            "size_bytes": artifact.size_bytes,
            "provider_device_id": peer_device_id,
            "metadata": {
                "source": connection.transport_id(),
                "artifact_id": artifact.artifact_id,
                "project_id": artifact.project_id,
                "iroh_blob_hash": transport_local_blob_hash,
            },
        });
        let timer = SyncPhaseTimer::start_artifact("artifact_staging", artifact);
        let stage_result = client.post_json_value("/api/v1/sync/artifacts/staging", &body);
        timings.push(timer.finish());
        let cleanup_timer = SyncPhaseTimer::start_artifact("artifact_cleanup", artifact);
        let _ = fs::remove_file(&temp_path);
        timings.push(cleanup_timer.finish());
        if let Err(error) = stage_result {
            return Err(transfer_failure(
                artifact,
                transfer_timing,
                phase_context_error(
                    "reconciliation staging",
                    format!("Could not stage received sync artifact: {error}"),
                ),
            ));
        }

        Ok(transfer_result(artifact, "received", None, transfer_timing))
    }

    #[derive(Clone, Debug)]
    struct TransferFailure {
        message: String,
        result: SyncTransportTransferResult,
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
        }
    }

    fn temp_artifact_path_in(root: PathBuf, content_sha256: &str) -> PathBuf {
        root.join("tuneforge-sync-transport").join(format!(
            "{}-{}-{content_sha256}",
            process::id(),
            random_nonce()
        ))
    }

    fn serve_artifact_requests_until_done(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        offered_manifests: &[Value],
        metrics: &mut SyncRunMetrics,
        progress: &ProgressReporter,
    ) -> Result<u64, String> {
        let offered_artifacts = offered_artifacts_by_id(offered_manifests);
        let mut served = 0_u64;
        progress
            .report_local_progress("serve_artifact_requests", "Serving peer artifact requests.");
        loop {
            match connection
                .read_message_accepting_status_for_phase("serve artifact requests", progress)?
            {
                ProtocolMessage::ArtifactRequest {
                    artifact_id,
                    content_sha256,
                    size_bytes,
                } => {
                    let result = offered_artifacts
                        .get(&artifact_id)
                        .ok_or_else(|| {
                            format!("Sync peer requested artifact {artifact_id} that was not offered.")
                        })
                        .and_then(|artifact| {
                            if artifact.content_sha256 != content_sha256
                                || artifact.size_bytes != size_bytes
                            {
                                return Err(format!(
                                    "Sync peer request for artifact {artifact_id} does not match the offered manifest."
                                ));
                            }
                            send_artifact_response(client, connection, artifact, metrics, progress)
                        });
                    if let Err(error) = result {
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
                    served = served.saturating_add(1);
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

    fn send_artifact_response(
        client: &BackendClient,
        connection: &SharedPeerConnection,
        artifact: &RemoteArtifact,
        metrics: &mut SyncRunMetrics,
        progress: &ProgressReporter,
    ) -> Result<(), String> {
        let path = format!(
            "/api/v1/artifacts/{}/stream",
            percent_encode_path_segment(&artifact.artifact_id)
        );
        let mut body = {
            let _progress =
                progress.start_phase("artifact_transfer", "Transferring artifact content.");
            client.get_body(&path).map_err(|error| {
                phase_context_error(
                    "artifact request/transfer",
                    format!(
                        "Could not read local artifact {}: {error}",
                        artifact.artifact_id
                    ),
                )
            })?
        };
        let _progress = progress.start_phase("artifact_transfer", "Transferring artifact content.");
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
            let read = body.read(&mut buffer).map_err(|error| {
                phase_context_error(
                    "artifact request/transfer",
                    format!("Could not stream local artifact bytes: {error}"),
                )
            })?;
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
            return Err(phase_context_error(
                "artifact request/transfer",
                "Local artifact bytes do not match the requested SHA-256 or size.".to_string(),
            ));
        }
        connection.send_message_for_phase(
            "artifact request/transfer",
            &ProtocolMessage::ArtifactEnd {
                content_sha256: actual_sha256,
                size_bytes: actual_size,
            },
        )
    }

    fn offered_artifacts_by_id(manifests: &[Value]) -> HashMap<String, RemoteArtifact> {
        manifests
            .iter()
            .flat_map(manifest_artifacts)
            .map(|artifact| (artifact.artifact_id.clone(), artifact))
            .collect()
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
                Ok(Self { host, port })
            }
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

        fn temp_artifact_path(&self, content_sha256: &str) -> PathBuf {
            #[cfg(target_os = "android")]
            {
                if let Ok(path) = self.app.path().app_cache_dir() {
                    return temp_artifact_path_in(path, content_sha256);
                }
                if let Ok(path) = self.app.path().app_data_dir() {
                    return temp_artifact_path_in(path, content_sha256);
                }
            }

            temp_artifact_path_in(env::temp_dir(), content_sha256)
        }

        #[cfg(not(target_os = "android"))]
        fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, BackendError> {
            let value = self.request_json_value("GET", path, None)?;
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

        #[cfg(not(target_os = "android"))]
        fn request_json_value(
            &self,
            method: &str,
            path: &str,
            body: Option<&Value>,
        ) -> Result<Value, BackendError> {
            let mut response = self.request_body(method, path, body)?;
            let mut bytes = Vec::new();
            response
                .read_to_end(&mut bytes)
                .map_err(|error| BackendError::local(error.to_string()))?;
            if bytes.is_empty() {
                return Ok(Value::Null);
            }
            serde_json::from_slice(&bytes).map_err(|error| {
                BackendError::local(format!("Could not decode backend JSON response: {error}"))
            })
        }

        fn get_body(&self, path: &str) -> Result<BackendBody, BackendError> {
            #[cfg(target_os = "android")]
            {
                let artifact_id = path
                    .strip_prefix("/api/v1/artifacts/")
                    .and_then(|value| value.strip_suffix("/stream"))
                    .ok_or_else(|| {
                        BackendError::local(format!(
                            "Android mobile backend does not implement body stream {path}."
                        ))
                    })?;
                let artifact = crate::mobile_backend::mobile_sync_transport_artifact_file(
                    self.app.clone(),
                    &percent_decode(artifact_id),
                )
                .map_err(BackendError::local)?;
                let file = File::open(&artifact.path).map_err(|error| {
                    BackendError::local(format!("Could not open mobile artifact file: {error}"))
                })?;
                return Ok(BackendBody {
                    reader: Box::new(file),
                    remaining: Some(artifact.size_bytes),
                });
            }

            #[cfg(not(target_os = "android"))]
            self.request_body("GET", path, None)
        }

        #[cfg(not(target_os = "android"))]
        fn request_body(
            &self,
            method: &str,
            path: &str,
            body: Option<&Value>,
        ) -> Result<BackendBody, BackendError> {
            let mut stream = TcpStream::connect((self.host.as_str(), self.port))
                .map_err(|error| BackendError::local(error.to_string()))?;
            stream
                .set_read_timeout(Some(HTTP_TIMEOUT))
                .map_err(|error| BackendError::local(error.to_string()))?;
            stream
                .set_write_timeout(Some(HTTP_TIMEOUT))
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
            .map_err(|error| BackendError::local(error.to_string()))?;
            if body.is_some() {
                stream
                    .write_all(b"Content-Type: application/json\r\n")
                    .map_err(|error| BackendError::local(error.to_string()))?;
            }
            stream
                .write_all(b"\r\n")
                .and_then(|_| stream.write_all(&body_bytes))
                .map_err(|error| BackendError::local(error.to_string()))?;

            let mut reader = BufReader::new(stream);
            let mut status_line = String::new();
            reader
                .read_line(&mut status_line)
                .map_err(|error| BackendError::local(error.to_string()))?;
            let status = parse_status_code(&status_line)?;
            let mut content_length = None;
            loop {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .map_err(|error| BackendError::local(error.to_string()))?;
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

    #[cfg(test)]
    mod tests {
        use super::*;

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
            assert_eq!(TRANSPORT_PROTOCOL_VERSION, "tuneforge-sync-transport-v3");
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
            let owned_result: Result<SyncTransportSyncResult, String> =
                Err("outbound sync failed".to_string());

            apply_sync_now_status_result(&mut owned_status, &owned_result, "local_run");

            assert_eq!(
                owned_status.last_error.as_deref(),
                Some("outbound sync failed")
            );
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
            let unrelated_result: Result<SyncTransportSyncResult, String> =
                Err("outbound sync failed".to_string());

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
        fn offered_artifacts_are_scoped_to_manifest_metadata() {
            let manifests = vec![json!({
                "artifacts": [{
                    "artifact_id": "art_allowed",
                    "project_id": "proj_allowed",
                    "content_sha256": "abc123",
                    "size_bytes": 42,
                }]
            })];

            let offered = offered_artifacts_by_id(&manifests);

            assert_eq!(offered.len(), 1);
            assert_eq!(
                offered
                    .get("art_allowed")
                    .map(|artifact| artifact.content_sha256.as_str()),
                Some("abc123")
            );
            assert!(offered.get("art_unknown").is_none());
        }

        #[test]
        fn remote_project_apply_is_queued_after_each_project_stages() {
            let manifests = vec![
                json!({ "project": { "project_id": "proj_one" }, "artifacts": [] }),
                json!({ "project": { "project_id": "proj_two" }, "artifacts": [] }),
            ];
            let events = std::cell::RefCell::new(Vec::new());

            stage_remote_manifest_projects(
                &manifests,
                |manifest| {
                    let project_id = manifest_project_id(manifest);
                    events.borrow_mut().push(format!("stage:{project_id}"));
                    StagedRemoteProject {
                        manifest: manifest.clone(),
                        available_content_sha256: Vec::new(),
                        transfer_failure: None,
                    }
                },
                |project| {
                    let project_id = manifest_project_id(&project.manifest);
                    events.borrow_mut().push(format!("apply:{project_id}"));
                },
            );

            assert_eq!(
                events.into_inner(),
                vec![
                    "stage:proj_one".to_string(),
                    "apply:proj_one".to_string(),
                    "stage:proj_two".to_string(),
                    "apply:proj_two".to_string(),
                ]
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
            assert_eq!(
                sync_result_message(4, 5, &transfer_counts, counts),
                "Exchanged 4 local and 5 remote manifest(s); imported 2 project(s), skipped 1 project(s), failed 1 project(s), received 6 artifact(s), reused 1 staged artifact(s), failed 1 transfer(s)."
            );
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
                remote_manifest_count: 0,
                local_manifest_count: 0,
                manifest_errors: Vec::new(),
                phase_timings: vec![SyncTransportTimingEvidence {
                    phase: "artifact_transfer".to_string(),
                    project_id: Some("proj_one".to_string()),
                    artifact_id: Some("art_one".to_string()),
                    started_at: "2026-01-01T00:00:00Z".to_string(),
                    completed_at: "2026-01-01T00:00:01Z".to_string(),
                    duration_ms: 1_000,
                }],
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
                remote_manifest_count: 0,
                local_manifest_count: 0,
                manifest_errors: Vec::new(),
                phase_timings: Vec::new(),
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
