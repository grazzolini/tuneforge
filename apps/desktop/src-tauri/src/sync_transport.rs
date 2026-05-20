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
pub struct SyncTransportStatus {
    pub supported: bool,
    pub running: bool,
    pub bind_host: Option<String>,
    pub port: Option<u16>,
    pub endpoint_hints: Vec<String>,
    pub active_sessions: usize,
    pub accepted_sessions: u64,
    pub failed_sessions: u64,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_sync: Option<SyncTransportSyncResult>,
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
    pub remote_manifest_count: usize,
    pub local_manifest_count: usize,
    pub manifest_errors: Vec<SyncTransportManifestError>,
    pub timings: Vec<SyncTransportTimingEvidence>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransportManifestError {
    pub project_id: String,
    pub message: String,
}

#[cfg(not(target_os = "android"))]
mod desktop {
    use super::{
        SyncTransportManifestError, SyncTransportPairingOffer, SyncTransportPairingOfferRequest,
        SyncTransportProjectResult, SyncTransportStartListenerRequest, SyncTransportStatus,
        SyncTransportSyncNowRequest, SyncTransportSyncResult, SyncTransportTimingEvidence,
        SyncTransportTransferCounts, SyncTransportTransferResult,
    };
    use base64::{
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
        Engine as _,
    };
    use chrono::{DateTime, Utc};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use rand::{rngs::OsRng, RngCore};
    use serde::{Deserialize, Serialize};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use snow::{params::NoiseParams, Builder};
    use std::{
        collections::{HashMap, HashSet},
        env,
        fs::{self, File},
        io::{self, BufRead, BufReader, Read, Write},
        net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
        path::PathBuf,
        process,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    use tauri::State;

    const DEFAULT_BIND_HOST: &str = "0.0.0.0";
    const DEFAULT_LISTENER_PORT: u16 = 47619;
    const ENDPOINT_SCHEME: &str = "tuneforge-sync+tcp://";
    const PAIRING_PROTOCOL_VERSION: &str = "tuneforge-sync-v1";
    const TRANSPORT_PROTOCOL_VERSION: &str = "tuneforge-sync-transport-v1";
    const TRANSPORT_HANDSHAKE_CHALLENGE_TYPE: &str = "transport_handshake";
    const NOISE_PATTERN: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
    const READ_TIMEOUT: Duration = Duration::from_secs(45);
    const WRITE_TIMEOUT: Duration = Duration::from_secs(45);
    const ACCEPT_SLEEP: Duration = Duration::from_millis(100);
    const MAX_RAW_FRAME: usize = 65_535;
    const ENCRYPTED_PAYLOAD_CHUNK: usize = 32 * 1024;
    const ARTIFACT_CHUNK_SIZE: usize = 24 * 1024;
    const PAIRING_OFFER_TTL_SECONDS: u32 = 600;
    const TRANSPORT_HANDSHAKE_TTL_SECONDS: i64 = 60;
    const HTTP_TIMEOUT: Duration = Duration::from_secs(45);

    #[derive(Clone)]
    pub struct SyncTransportState {
        base_url: String,
        listener: Arc<Mutex<Option<ListenerHandle>>>,
        shared_status: Arc<Mutex<SharedStatus>>,
    }

    impl SyncTransportState {
        pub fn new(base_url: String) -> Self {
            Self {
                base_url,
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

            let client = BackendClient::new(&self.base_url)?;
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
            let endpoint_hints = endpoint_hints_for_port(bind_addr.port(), &identity.device_id);
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = Arc::clone(&stop);
            let base_url = self.base_url.clone();
            let shared_status = Arc::clone(&self.shared_status);
            let thread = thread::spawn(move || {
                accept_loop(listener, base_url, thread_stop, shared_status);
            });

            let handle = ListenerHandle {
                bind_addr,
                endpoint_hints,
                stop,
                thread: Some(thread),
            };
            {
                let mut guard = self
                    .listener
                    .lock()
                    .map_err(|_| "Sync transport listener state is unavailable.".to_string())?;
                *guard = Some(handle);
            }
            update_status(&self.shared_status, |status| {
                status.last_status = Some("Sync transport listener started.".to_string());
                status.last_error = None;
                status.last_sync = None;
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
                if let Some(thread) = listener.thread.take() {
                    thread
                        .join()
                        .map_err(|_| "Sync transport listener thread panicked.".to_string())?;
                }
                update_status(&self.shared_status, |status| {
                    status.last_status = Some("Sync transport listener stopped.".to_string());
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
                .map(|status| status.clone())
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
                active_sessions: shared.active_sessions,
                accepted_sessions: shared.accepted_sessions,
                failed_sessions: shared.failed_sessions,
                last_status: shared.last_status,
                last_error: shared.last_error,
                last_sync: shared.last_sync,
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
            let client = BackendClient::new(&self.base_url)?;
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
            let result = self.run_sync_now(payload);
            update_status(&self.shared_status, |status| match &result {
                Ok(sync_result) => {
                    status.last_status = Some(sync_result.message.clone());
                    status.last_sync = Some(sync_result.clone());
                    status.last_error = None;
                }
                Err(error) => {
                    status.last_error = Some(error.clone());
                }
            });
            result
        }

        fn run_sync_now(
            &self,
            payload: SyncTransportSyncNowRequest,
        ) -> Result<SyncTransportSyncResult, String> {
            let run_id = sync_run_id();
            let run_started_at = Utc::now();
            let run_started_instant = Instant::now();
            let mut timings = Vec::new();
            let client = BackendClient::new(&self.base_url)?;
            let peer = client
                .trusted_peer(&payload.peer_device_id)
                .map_err(|error| format!("Could not load trusted sync peer: {error}"))?
                .ok_or_else(|| {
                    format!(
                        "Trusted sync peer {} is not known or has been revoked.",
                        payload.peer_device_id
                    )
                })?;
            let endpoint_hint = payload
                .endpoint_hint
                .clone()
                .or_else(|| first_tcp_endpoint_hint(&peer.endpoint_hints))
                .ok_or_else(|| {
                    format!(
                        "Trusted sync peer {} does not have a TuneForge TCP endpoint hint.",
                        payload.peer_device_id
                    )
                })?;
            let endpoint = parse_endpoint_hint(&endpoint_hint, Some(&payload.peer_device_id))?;
            let timer = SyncPhaseTimer::start("peer_connect");
            let stream = TcpStream::connect_timeout(&endpoint, Duration::from_secs(10)).map_err(
                |error| format!("Could not connect to sync peer at {endpoint}: {error}"),
            )?;
            configure_stream(&stream)?;
            timings.push(timer.finish());

            let timer = SyncPhaseTimer::start("peer_authentication");
            let mut connection = SecurePeerConnection::connect_initiator(stream)?;
            let session = authenticate_session(
                &mut connection,
                &client,
                Some(payload.peer_device_id.clone()),
            )?;
            timings.push(timer.finish());

            let timer = SyncPhaseTimer::start("local_manifest_export");
            let local_offer = load_local_manifest_offer(
                &client,
                payload.project_ids.as_deref(),
                payload.export_local,
            );
            timings.push(timer.finish());
            let local_manifest_count = local_offer.project_manifests.len();
            let timer = SyncPhaseTimer::start("manifest_exchange");
            connection.send_message(&ProtocolMessage::ManifestOffer(local_offer.clone()))?;
            let remote_offer = match connection.read_message()? {
                ProtocolMessage::ManifestOffer(offer) => offer,
                ProtocolMessage::Error(error) => {
                    return Err(format!("Sync peer returned an error: {}", error.message));
                }
                other => {
                    return Err(format!(
                        "Sync peer sent unexpected message during manifest exchange: {}",
                        other.kind()
                    ));
                }
            };
            timings.push(timer.finish());

            let mut imported_projects = Vec::new();
            let mut received_artifacts = Vec::new();
            if payload.import_remote {
                let imported = import_remote_manifests(
                    &client,
                    &mut connection,
                    &session.remote_device_id,
                    &remote_offer.metadata,
                    &remote_offer.project_manifests,
                    &mut timings,
                );
                imported_projects = imported.imported_projects;
                received_artifacts = imported.received_artifacts;
            }
            let import_counts = import_outcome_counts(&imported_projects);
            connection.send_message(&ProtocolMessage::PhaseDone {
                phase: "initiator_import".to_string(),
            })?;
            let timer = SyncPhaseTimer::start("serve_artifact_requests");
            let served_artifact_requests = serve_artifact_requests_until_done(
                &client,
                &mut connection,
                &local_offer.project_manifests,
            )?;
            timings.push(timer.finish());
            let manifest_errors =
                sync_manifest_errors(&local_offer.manifest_errors, &remote_offer.manifest_errors);
            let completed_at = Utc::now();
            let duration_ms = duration_millis(run_started_instant.elapsed());
            let transfer_counts = transfer_counts(&received_artifacts);
            let project_results = imported_projects.clone();

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
                remote_manifest_count: remote_offer.project_manifests.len(),
                local_manifest_count,
                manifest_errors,
                timings,
            })
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
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
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
    }

    fn accept_loop(
        listener: TcpListener,
        base_url: String,
        stop: Arc<AtomicBool>,
        shared_status: Arc<Mutex<SharedStatus>>,
    ) {
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, address)) => {
                    let base_url = base_url.clone();
                    let shared_status = Arc::clone(&shared_status);
                    update_status(&shared_status, |status| {
                        status.accepted_sessions += 1;
                        status.last_status =
                            Some(format!("Accepted sync peer session from {address}."));
                        status.last_error = None;
                        status.last_sync = None;
                    });
                    thread::spawn(move || {
                        handle_incoming_session(base_url, stream, shared_status);
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

    fn handle_incoming_session(
        base_url: String,
        stream: TcpStream,
        shared_status: Arc<Mutex<SharedStatus>>,
    ) {
        update_status(&shared_status, |status| {
            status.active_sessions += 1;
        });
        let result = serve_incoming_session(base_url, stream);
        update_status(&shared_status, |status| {
            status.active_sessions = status.active_sessions.saturating_sub(1);
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
        base_url: String,
        stream: TcpStream,
    ) -> Result<IncomingSessionResult, String> {
        let run_id = sync_run_id();
        let run_started_at = Utc::now();
        let run_started_instant = Instant::now();
        let mut timings = Vec::new();
        configure_stream(&stream)?;
        let client = BackendClient::new(&base_url)?;
        let timer = SyncPhaseTimer::start("peer_authentication");
        let mut connection = SecurePeerConnection::connect_responder(stream)?;
        let session = authenticate_session(&mut connection, &client, None)?;
        timings.push(timer.finish());
        let timer = SyncPhaseTimer::start("manifest_exchange");
        let remote_offer = match connection.read_message()? {
            ProtocolMessage::ManifestOffer(offer) => offer,
            ProtocolMessage::Error(error) => {
                return Err(format!("Sync peer returned an error: {}", error.message));
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
        let local_offer = load_local_manifest_offer(&client, None, true);
        timings.push(timer.finish());
        let local_manifest_count = local_offer.project_manifests.len();
        connection.send_message(&ProtocolMessage::ManifestOffer(local_offer.clone()))?;

        let timer = SyncPhaseTimer::start("serve_artifact_requests");
        let served_artifact_requests = serve_artifact_requests_until_done(
            &client,
            &mut connection,
            &local_offer.project_manifests,
        )?;
        timings.push(timer.finish());
        let imported = import_remote_manifests(
            &client,
            &mut connection,
            &session.remote_device_id,
            &remote_offer.metadata,
            &remote_offer.project_manifests,
            &mut timings,
        );
        let import_counts = import_outcome_counts(&imported.imported_projects);
        connection.send_message(&ProtocolMessage::PhaseDone {
            phase: "responder_import".to_string(),
        })?;

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
        let transfer_counts = transfer_counts(&imported.received_artifacts);
        let project_results = imported.imported_projects.clone();
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
            started_at: run_started_at.to_rfc3339(),
            completed_at: completed_at.to_rfc3339(),
            duration_ms,
            project_results,
            imported_projects: imported.imported_projects,
            imported_project_count: import_counts.imported,
            skipped_project_count: import_counts.skipped,
            failed_project_count: import_counts.failed,
            received_artifacts: imported.received_artifacts,
            transfer_counts,
            served_artifact_requests,
            remote_manifest_count: remote_offer.project_manifests.len(),
            local_manifest_count,
            manifest_errors,
            timings,
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

    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ManifestOffer {
        metadata: Value,
        project_manifests: Vec<Value>,
        manifest_errors: Vec<SyncTransportManifestError>,
    }

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum ProtocolMessage {
        AuthChallenge {
            protocol_version: String,
            device_id: String,
            session_nonce: String,
        },
        AuthProof {
            handshake_signature: Value,
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
        ArtifactChunk {
            data: String,
        },
        ArtifactEnd {
            content_sha256: String,
            size_bytes: u64,
        },
        Status {
            phase: String,
            message: String,
        },
        PhaseDone {
            phase: String,
        },
        Error(ProtocolError),
    }

    impl ProtocolMessage {
        fn kind(&self) -> &'static str {
            match self {
                Self::AuthChallenge { .. } => "auth_challenge",
                Self::AuthProof { .. } => "auth_proof",
                Self::ManifestOffer(_) => "manifest_offer",
                Self::ArtifactRequest { .. } => "artifact_request",
                Self::ArtifactStart { .. } => "artifact_start",
                Self::ArtifactChunk { .. } => "artifact_chunk",
                Self::ArtifactEnd { .. } => "artifact_end",
                Self::Status { .. } => "status",
                Self::PhaseDone { .. } => "phase_done",
                Self::Error(_) => "error",
            }
        }
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProtocolError {
        code: String,
        message: String,
    }

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EncryptedChunk {
        message_id: u64,
        chunk_index: u32,
        chunk_count: u32,
        data: String,
    }

    struct SecurePeerConnection {
        stream: TcpStream,
        noise: snow::TransportState,
        handshake_hash: String,
        next_message_id: u64,
    }

    impl SecurePeerConnection {
        fn connect_initiator(mut stream: TcpStream) -> Result<Self, String> {
            let mut handshake = build_noise_handshake(true)?;
            let mut buffer = vec![0_u8; MAX_RAW_FRAME];
            let written = handshake
                .write_message(&[], &mut buffer)
                .map_err(|error| format!("Noise handshake write failed: {error}"))?;
            write_raw_frame(&mut stream, &buffer[..written])?;

            let message = read_raw_frame(&mut stream)?;
            handshake
                .read_message(&message, &mut buffer)
                .map_err(|error| format!("Noise handshake read failed: {error}"))?;

            let written = handshake
                .write_message(&[], &mut buffer)
                .map_err(|error| format!("Noise handshake write failed: {error}"))?;
            write_raw_frame(&mut stream, &buffer[..written])?;
            let handshake_hash = URL_SAFE_NO_PAD.encode(handshake.get_handshake_hash());
            let noise = handshake
                .into_transport_mode()
                .map_err(|error| format!("Noise transport setup failed: {error}"))?;
            Ok(Self {
                stream,
                noise,
                handshake_hash,
                next_message_id: 1,
            })
        }

        fn connect_responder(mut stream: TcpStream) -> Result<Self, String> {
            let mut handshake = build_noise_handshake(false)?;
            let mut buffer = vec![0_u8; MAX_RAW_FRAME];

            let message = read_raw_frame(&mut stream)?;
            handshake
                .read_message(&message, &mut buffer)
                .map_err(|error| format!("Noise handshake read failed: {error}"))?;

            let written = handshake
                .write_message(&[], &mut buffer)
                .map_err(|error| format!("Noise handshake write failed: {error}"))?;
            write_raw_frame(&mut stream, &buffer[..written])?;

            let message = read_raw_frame(&mut stream)?;
            handshake
                .read_message(&message, &mut buffer)
                .map_err(|error| format!("Noise handshake read failed: {error}"))?;
            let handshake_hash = URL_SAFE_NO_PAD.encode(handshake.get_handshake_hash());
            let noise = handshake
                .into_transport_mode()
                .map_err(|error| format!("Noise transport setup failed: {error}"))?;
            Ok(Self {
                stream,
                noise,
                handshake_hash,
                next_message_id: 1,
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
                    data: STANDARD.encode(chunk),
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
            let first = self.read_encrypted_chunk()?;
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
                let next = self.read_encrypted_chunk()?;
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
            let plaintext = serde_json::to_vec(chunk)
                .map_err(|error| format!("Could not encode encrypted chunk: {error}"))?;
            let mut ciphertext = vec![0_u8; plaintext.len() + 1024];
            let written = self
                .noise
                .write_message(&plaintext, &mut ciphertext)
                .map_err(|error| format!("Noise transport write failed: {error}"))?;
            write_raw_frame(&mut self.stream, &ciphertext[..written])
        }

        fn read_encrypted_chunk(&mut self) -> Result<EncryptedChunk, String> {
            let ciphertext = read_raw_frame(&mut self.stream)?;
            let mut plaintext = vec![0_u8; MAX_RAW_FRAME];
            let read = self
                .noise
                .read_message(&ciphertext, &mut plaintext)
                .map_err(|error| format!("Noise transport read failed: {error}"))?;
            serde_json::from_slice(&plaintext[..read])
                .map_err(|error| format!("Could not decode encrypted chunk: {error}"))
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
        let builder = Builder::new(params).local_private_key(&keypair.private);
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

    fn write_raw_frame(stream: &mut TcpStream, payload: &[u8]) -> Result<(), String> {
        if payload.len() > MAX_RAW_FRAME {
            return Err("Sync transport frame is too large.".to_string());
        }
        let length = (payload.len() as u32).to_be_bytes();
        stream
            .write_all(&length)
            .and_then(|_| stream.write_all(payload))
            .map_err(|error| format!("Could not write sync transport frame: {error}"))
    }

    fn read_raw_frame(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
        let mut length = [0_u8; 4];
        stream
            .read_exact(&mut length)
            .map_err(|error| format!("Could not read sync transport frame length: {error}"))?;
        let length = u32::from_be_bytes(length) as usize;
        if length > MAX_RAW_FRAME {
            return Err("Sync transport frame exceeds the maximum frame size.".to_string());
        }
        let mut payload = vec![0_u8; length];
        stream
            .read_exact(&mut payload)
            .map_err(|error| format!("Could not read sync transport frame: {error}"))?;
        Ok(payload)
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

    #[derive(Debug)]
    struct AuthenticatedSession {
        remote_device_id: String,
    }

    fn authenticate_session(
        connection: &mut SecurePeerConnection,
        client: &BackendClient,
        expected_peer_device_id: Option<String>,
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
            &connection.handshake_hash,
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
            &connection.handshake_hash,
        )?;

        Ok(AuthenticatedSession { remote_device_id })
    }

    fn transport_handshake_challenge(
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

    fn random_nonce() -> String {
        let mut bytes = [0_u8; 24];
        OsRng.fill_bytes(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn sync_run_id() -> String {
        format!("sync_{}", random_nonce())
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

    struct ImportRemoteResult {
        imported_projects: Vec<SyncTransportProjectResult>,
        received_artifacts: Vec<SyncTransportTransferResult>,
    }

    #[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
    struct ImportOutcomeCounts {
        imported: usize,
        skipped: usize,
        failed: usize,
    }

    fn import_remote_manifests(
        client: &BackendClient,
        connection: &mut SecurePeerConnection,
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
        timings: &mut Vec<SyncTransportTimingEvidence>,
    ) -> ImportRemoteResult {
        let mut received_artifacts = Vec::new();

        let timer = SyncPhaseTimer::start("reconciliation_plan");
        let plan =
            match plan_remote_manifest_batch(client, peer_device_id, remote_metadata, manifests) {
                Ok(plan) => {
                    timings.push(timer.finish());
                    plan
                }
                Err(error) => {
                    timings.push(timer.finish());
                    return ImportRemoteResult {
                        imported_projects: apply_failure_results(
                            manifests,
                            &HashMap::new(),
                            &format!("Could not plan remote sync reconciliation batch: {error}"),
                        ),
                        received_artifacts,
                    };
                }
            };

        let mut imported_projects = Vec::with_capacity(manifests.len());
        let manifest_project_ids: HashSet<String> =
            manifests.iter().map(manifest_project_id).collect();
        for manifest in manifests {
            let project_result = import_remote_manifest_project(
                client,
                connection,
                peer_device_id,
                remote_metadata,
                manifest,
                &plan,
                &mut received_artifacts,
                timings,
            );
            imported_projects.push(project_result);
        }
        for project_id in planned_delete_project_ids(&plan)
            .into_iter()
            .filter(|project_id| !manifest_project_ids.contains(project_id))
        {
            imported_projects.push(apply_remote_tombstone_project(
                client,
                peer_device_id,
                remote_metadata,
                &project_id,
                timings,
            ));
        }

        ImportRemoteResult {
            imported_projects,
            received_artifacts,
        }
    }

    fn apply_remote_tombstone_project(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        project_id: &str,
        timings: &mut Vec<SyncTransportTimingEvidence>,
    ) -> SyncTransportProjectResult {
        let remote_metadata = remote_metadata_for_project(remote_metadata, project_id);
        let body = reconciliation_apply_body_with_project_ids(
            peer_device_id,
            &remote_metadata,
            &[],
            &[],
            &[project_id.to_string()],
        );
        let timer = SyncPhaseTimer::start_project("reconciliation_apply", project_id);
        let response = client.post_json_value("/api/v1/sync/reconciliation/apply", &body);
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
            Err(error) => failed_project_result(project_id, &error.to_string()),
        }
    }

    fn import_remote_manifest_project(
        client: &BackendClient,
        connection: &mut SecurePeerConnection,
        peer_device_id: &str,
        remote_metadata: &Value,
        manifest: &Value,
        plan: &Value,
        received_artifacts: &mut Vec<SyncTransportTransferResult>,
        timings: &mut Vec<SyncTransportTimingEvidence>,
    ) -> SyncTransportProjectResult {
        let project_id = manifest_project_id(manifest);
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
                timings,
            ) {
                Ok(result) => {
                    project_transfers.push(result.clone());
                    received_artifacts.push(result);
                }
                Err(error) => {
                    let failed = failed_transfer_result(&entry.artifact, &error);
                    project_transfers.push(failed.clone());
                    received_artifacts.push(failed);
                    transfer_failure.get_or_insert((entry.manifest_project_id, error));
                }
            }
        }

        let transfer_failures = transfer_failure
            .as_ref()
            .map(|(project_id, error)| HashMap::from([(project_id.clone(), error.clone())]))
            .unwrap_or_default();
        if !transfer_failures.is_empty() {
            return apply_failure_results(
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
            });
        }

        let available_content_sha256 = available_content_sha256(&project_transfers);
        match apply_remote_manifest_project(
            client,
            peer_device_id,
            remote_metadata,
            manifest,
            &available_content_sha256,
            timings,
        ) {
            Ok(result) => result,
            Err(error) => apply_failure_results(
                std::slice::from_ref(manifest),
                &HashMap::new(),
                &error.to_string(),
            )
            .into_iter()
            .next()
            .unwrap_or_else(|| failed_project_result(&project_id, &error.to_string())),
        }
    }

    fn plan_remote_manifest_batch(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
    ) -> Result<Value, BackendError> {
        let advertised_content_sha256 = manifest_content_sha256(manifests);
        let body = reconciliation_plan_body(
            peer_device_id,
            remote_metadata,
            manifests,
            &advertised_content_sha256,
        );
        client.post_json_value("/api/v1/sync/reconciliation/plan", &body)
    }

    fn apply_remote_manifest_project(
        client: &BackendClient,
        peer_device_id: &str,
        remote_metadata: &Value,
        manifest: &Value,
        available_content_sha256: &[String],
        timings: &mut Vec<SyncTransportTimingEvidence>,
    ) -> Result<SyncTransportProjectResult, BackendError> {
        let project_id = manifest_project_id(manifest);
        let manifests = vec![manifest.clone()];
        let remote_metadata = remote_metadata_for_project(remote_metadata, &project_id);
        let body = reconciliation_apply_body(
            peer_device_id,
            &remote_metadata,
            &manifests,
            available_content_sha256,
        );
        let timer = SyncPhaseTimer::start_project("reconciliation_apply", &project_id);
        let response = client.post_json_value("/api/v1/sync/reconciliation/apply", &body);
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
    ) -> Value {
        json!({
            "remote_library": remote_metadata,
            "project_manifests": manifests,
            "peer_inventory": [{
                "device_id": peer_device_id,
                "available_content_sha256": available_content_sha256,
                "metadata": { "transport": "tuneforge-sync+tcp" },
            }],
        })
    }

    fn reconciliation_apply_body(
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
        available_content_sha256: &[String],
    ) -> Value {
        let project_ids: Vec<String> = manifests.iter().map(manifest_project_id).collect();
        reconciliation_apply_body_with_project_ids(
            peer_device_id,
            remote_metadata,
            manifests,
            available_content_sha256,
            &project_ids,
        )
    }

    fn reconciliation_apply_body_with_project_ids(
        peer_device_id: &str,
        remote_metadata: &Value,
        manifests: &[Value],
        available_content_sha256: &[String],
        project_ids: &[String],
    ) -> Value {
        json!({
            "remote_library": remote_metadata,
            "project_manifests": manifests,
            "peer_inventory": [{
                "device_id": peer_device_id,
                "available_content_sha256": available_content_sha256,
                "metadata": { "transport": "tuneforge-sync+tcp" },
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
        manifest_project_id: String,
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
                let manifest_project_id = manifest_project_id(manifest);
                manifest_artifacts(manifest)
                    .into_iter()
                    .map(move |artifact| ManifestArtifactEntry {
                        manifest_project_id: manifest_project_id.clone(),
                        artifact,
                    })
            })
            .collect()
    }

    fn request_or_use_staged_artifact(
        client: &BackendClient,
        connection: &mut SecurePeerConnection,
        peer_device_id: &str,
        artifact: &RemoteArtifact,
        timings: &mut Vec<SyncTransportTimingEvidence>,
    ) -> Result<SyncTransportTransferResult, String> {
        let timer = SyncPhaseTimer::start_artifact("artifact_staging_check", artifact);
        let staged = already_staged_artifact_result(client, artifact);
        timings.push(timer.finish());
        if let Some(result) = staged? {
            return Ok(result);
        }
        request_and_stage_artifact(client, connection, peer_device_id, artifact, timings)
    }

    fn already_staged_artifact_result(
        client: &BackendClient,
        artifact: &RemoteArtifact,
    ) -> Result<Option<SyncTransportTransferResult>, String> {
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
                Ok(Some(SyncTransportTransferResult {
                    artifact_id: artifact.artifact_id.clone(),
                    content_sha256: artifact.content_sha256.clone(),
                    size_bytes: artifact.size_bytes,
                    status: "already_staged".to_string(),
                    message: Some(
                        "Artifact content was already staged and verified locally.".to_string(),
                    ),
                }))
            }
            Err(error) if error.status == Some(404) => Ok(None),
            Err(error) => Err(format!(
                "Could not inspect staged sync artifact {}: {error}",
                artifact.content_sha256
            )),
        }
    }

    fn request_and_stage_artifact(
        client: &BackendClient,
        connection: &mut SecurePeerConnection,
        peer_device_id: &str,
        artifact: &RemoteArtifact,
        timings: &mut Vec<SyncTransportTimingEvidence>,
    ) -> Result<SyncTransportTransferResult, String> {
        let timer = SyncPhaseTimer::start_artifact("artifact_transfer", artifact);
        connection.send_message(&ProtocolMessage::ArtifactRequest {
            artifact_id: artifact.artifact_id.clone(),
            content_sha256: artifact.content_sha256.clone(),
            size_bytes: artifact.size_bytes,
        })?;

        match connection.read_message()? {
            ProtocolMessage::ArtifactStart {
                artifact_id,
                content_sha256,
                size_bytes,
            } => {
                if artifact_id != artifact.artifact_id
                    || content_sha256 != artifact.content_sha256
                    || size_bytes != artifact.size_bytes
                {
                    return Err(
                        "Sync peer artifact response did not match the request.".to_string()
                    );
                }
            }
            ProtocolMessage::Error(error) => return Err(error.message),
            other => {
                return Err(format!(
                    "Sync peer sent unexpected artifact response: {}",
                    other.kind()
                ));
            }
        }

        let temp_path = temp_artifact_path(&artifact.content_sha256);
        if let Some(parent) = temp_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create sync artifact temp dir: {error}"))?;
        }
        let mut file = File::create(&temp_path)
            .map_err(|error| format!("Could not create sync artifact temp file: {error}"))?;
        let mut hasher = Sha256::new();
        let mut size_bytes = 0_u64;
        let receive_result = loop {
            match connection.read_message()? {
                ProtocolMessage::ArtifactChunk { data } => {
                    let chunk = decode_standard_base64(&data)?;
                    let next_size_bytes = size_bytes.saturating_add(chunk.len() as u64);
                    if next_size_bytes > artifact.size_bytes {
                        break Err(
                            "Received sync artifact exceeded the requested size.".to_string()
                        );
                    }
                    size_bytes = next_size_bytes;
                    hasher.update(&chunk);
                    file.write_all(&chunk).map_err(|error| {
                        format!("Could not write received sync artifact bytes: {error}")
                    })?;
                }
                ProtocolMessage::ArtifactEnd {
                    content_sha256,
                    size_bytes: peer_size_bytes,
                } => {
                    file.flush().map_err(|error| {
                        format!("Could not flush received sync artifact bytes: {error}")
                    })?;
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
                ProtocolMessage::Error(error) => break Err(error.message),
                other => {
                    break Err(format!(
                        "Sync peer sent unexpected artifact transfer message: {}",
                        other.kind()
                    ));
                }
            }
        };
        timings.push(timer.finish());

        if let Err(error) = receive_result {
            let cleanup_timer = SyncPhaseTimer::start_artifact("artifact_cleanup", artifact);
            let _ = fs::remove_file(&temp_path);
            timings.push(cleanup_timer.finish());
            return Err(error);
        }

        let body = json!({
            "source_path": temp_path.to_string_lossy(),
            "content_sha256": artifact.content_sha256,
            "size_bytes": artifact.size_bytes,
            "provider_device_id": peer_device_id,
            "metadata": {
                "source": "tuneforge-sync+tcp",
                "artifact_id": artifact.artifact_id,
                "project_id": artifact.project_id,
            },
        });
        let timer = SyncPhaseTimer::start_artifact("artifact_staging", artifact);
        let stage_result = client.post_json_value("/api/v1/sync/artifacts/staging", &body);
        timings.push(timer.finish());
        let cleanup_timer = SyncPhaseTimer::start_artifact("artifact_cleanup", artifact);
        let _ = fs::remove_file(&temp_path);
        timings.push(cleanup_timer.finish());
        stage_result.map_err(|error| format!("Could not stage received sync artifact: {error}"))?;

        Ok(SyncTransportTransferResult {
            artifact_id: artifact.artifact_id.clone(),
            content_sha256: artifact.content_sha256.clone(),
            size_bytes: artifact.size_bytes,
            status: "received".to_string(),
            message: None,
        })
    }

    fn failed_transfer_result(
        artifact: &RemoteArtifact,
        message: &str,
    ) -> SyncTransportTransferResult {
        SyncTransportTransferResult {
            artifact_id: artifact.artifact_id.clone(),
            content_sha256: artifact.content_sha256.clone(),
            size_bytes: artifact.size_bytes,
            status: "failed".to_string(),
            message: Some(message.to_string()),
        }
    }

    fn temp_artifact_path(content_sha256: &str) -> PathBuf {
        env::temp_dir()
            .join("tuneforge-sync-transport")
            .join(format!(
                "{}-{}-{content_sha256}",
                process::id(),
                random_nonce()
            ))
    }

    fn serve_artifact_requests_until_done(
        client: &BackendClient,
        connection: &mut SecurePeerConnection,
        offered_manifests: &[Value],
    ) -> Result<u64, String> {
        let offered_artifacts = offered_artifacts_by_id(offered_manifests);
        let mut served = 0_u64;
        loop {
            match connection.read_message()? {
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
                            send_artifact_response(client, connection, artifact)
                        });
                    if let Err(error) = result {
                        let _ = connection.send_message(&ProtocolMessage::Error(ProtocolError {
                            code: "artifact_transfer_failed".to_string(),
                            message: error.clone(),
                        }));
                        return Err(error);
                    }
                    served = served.saturating_add(1);
                }
                ProtocolMessage::PhaseDone { .. } => return Ok(served),
                ProtocolMessage::Status { .. } => {}
                ProtocolMessage::Error(error) => return Err(error.message),
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
        connection: &mut SecurePeerConnection,
        artifact: &RemoteArtifact,
    ) -> Result<(), String> {
        let path = format!(
            "/api/v1/artifacts/{}/stream",
            percent_encode_path_segment(&artifact.artifact_id)
        );
        let mut body = client.get_body(&path).map_err(|error| {
            format!(
                "Could not read local artifact {}: {error}",
                artifact.artifact_id
            )
        })?;
        connection.send_message(&ProtocolMessage::ArtifactStart {
            artifact_id: artifact.artifact_id.clone(),
            content_sha256: artifact.content_sha256.clone(),
            size_bytes: artifact.size_bytes,
        })?;

        let mut buffer = [0_u8; ARTIFACT_CHUNK_SIZE];
        let mut hasher = Sha256::new();
        let mut actual_size = 0_u64;
        loop {
            let read = body
                .read(&mut buffer)
                .map_err(|error| format!("Could not stream local artifact bytes: {error}"))?;
            if read == 0 {
                break;
            }
            actual_size = actual_size.saturating_add(read as u64);
            hasher.update(&buffer[..read]);
            connection.send_message(&ProtocolMessage::ArtifactChunk {
                data: STANDARD.encode(&buffer[..read]),
            })?;
        }

        let actual_sha256 = hex_digest(hasher.finalize().as_slice());
        if actual_sha256 != artifact.content_sha256 || actual_size != artifact.size_bytes {
            return Err(
                "Local artifact bytes do not match the requested SHA-256 or size.".to_string(),
            );
        }
        connection.send_message(&ProtocolMessage::ArtifactEnd {
            content_sha256: actual_sha256,
            size_bytes: actual_size,
        })
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
    struct SyncLocalIdentity {
        device_id: String,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct SyncTrustedPeersResponse {
        trusted_peers: Vec<SyncTrustedPeer>,
    }

    #[derive(Clone, Debug, Deserialize)]
    struct SyncTrustedPeer {
        device_id: String,
        public_key: String,
        endpoint_hints: Vec<String>,
        revoked_at: Option<String>,
    }

    #[derive(Debug)]
    struct BackendClient {
        host: String,
        port: u16,
    }

    impl BackendClient {
        fn new(base_url: &str) -> Result<Self, String> {
            let without_scheme = base_url.strip_prefix("http://").ok_or_else(|| {
                "Sync transport only supports loopback http:// backends.".to_string()
            })?;
            let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
            let (host, port) = match authority.rsplit_once(':') {
                Some((host, port)) => {
                    let port = port
                        .parse::<u16>()
                        .map_err(|_| format!("Backend base URL has an invalid port: {base_url}"))?;
                    (host.to_string(), port)
                }
                None => (authority.to_string(), 80),
            };
            if host != "127.0.0.1" && host != "localhost" && host != "[::1]" && host != "::1" {
                return Err(
                    "Sync transport refuses to proxy a non-loopback backend over LAN.".to_string(),
                );
            }
            Ok(Self { host, port })
        }

        fn local_identity(&self) -> Result<SyncLocalIdentity, BackendError> {
            self.get_json::<SyncLocalIdentityResponse>("/api/v1/sync/identity")
                .map(|response| response.identity)
        }

        fn trusted_peer(&self, device_id: &str) -> Result<Option<SyncTrustedPeer>, BackendError> {
            let response =
                self.get_json::<SyncTrustedPeersResponse>("/api/v1/sync/trusted-peers")?;
            Ok(response
                .trusted_peers
                .into_iter()
                .find(|peer| peer.device_id == device_id && peer.revoked_at.is_none()))
        }

        fn create_pairing_offer(
            &self,
            endpoint_hints: Vec<String>,
            ttl_seconds: u32,
        ) -> Result<Value, BackendError> {
            let body = json!({
                "endpoint_hints": endpoint_hints,
                "ttl_seconds": ttl_seconds,
            });
            self.post_json_value("/api/v1/sync/pairing/offers", &body)
        }

        fn sign_transport_handshake(
            &self,
            peer_device_id: &str,
            challenge: &Value,
        ) -> Result<Value, BackendError> {
            let body = json!({
                "peer_device_id": peer_device_id,
                "challenge": challenge,
            });
            self.post_json_value("/api/v1/sync/transport/handshake/sign", &body)
        }

        fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, BackendError> {
            let value = self.request_json_value("GET", path, None)?;
            serde_json::from_value(value).map_err(|error| BackendError::local(error.to_string()))
        }

        fn get_json_value(&self, path: &str) -> Result<Value, BackendError> {
            self.request_json_value("GET", path, None)
        }

        fn post_json_value(&self, path: &str, body: &Value) -> Result<Value, BackendError> {
            self.request_json_value("POST", path, Some(body))
        }

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
            self.request_body("GET", path, None)
        }

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
                reader,
                remaining: content_length,
            })
        }
    }

    struct BackendBody {
        reader: BufReader<TcpStream>,
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

    fn parse_status_code(status_line: &str) -> Result<u16, BackendError> {
        status_line
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse::<u16>().ok())
            .ok_or_else(|| {
                BackendError::local(format!("Invalid backend HTTP status: {status_line}"))
            })
    }

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

    fn first_tcp_endpoint_hint(endpoint_hints: &[String]) -> Option<String> {
        endpoint_hints
            .iter()
            .find(|hint| hint.starts_with(ENDPOINT_SCHEME))
            .cloned()
    }

    fn parse_endpoint_hint(
        endpoint_hint: &str,
        expected_device_id: Option<&str>,
    ) -> Result<SocketAddr, String> {
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
        let mut addresses = socket_text
            .to_socket_addrs()
            .map_err(|error| format!("Could not resolve sync endpoint hint: {error}"))?;
        addresses
            .next()
            .ok_or_else(|| "Sync endpoint hint did not resolve to a socket address.".to_string())
    }

    fn query_parameter(query: &str, key: &str) -> Option<String> {
        query.split('&').find_map(|part| {
            let (part_key, value) = part.split_once('=')?;
            (part_key == key).then(|| percent_decode(value))
        })
    }

    fn decode_public_key(public_key: &str) -> Result<[u8; 32], String> {
        let decoded =
            decode_urlsafe_key(public_key.strip_prefix("ed25519:").unwrap_or(public_key))?;
        decoded
            .try_into()
            .map_err(|_| "Ed25519 public key must be 32 bytes.".to_string())
    }

    fn derive_device_id(public_key: &str) -> Result<String, String> {
        let public_key = decode_public_key(public_key)?;
        let digest = Sha256::digest(public_key);
        Ok(format!("dev_ed25519_{}", URL_SAFE_NO_PAD.encode(digest)))
    }

    fn decode_urlsafe_key(value: &str) -> Result<Vec<u8>, String> {
        URL_SAFE_NO_PAD
            .decode(value.trim().trim_end_matches('='))
            .map_err(|error| format!("Value must be URL-safe base64: {error}"))
    }

    fn decode_standard_base64(value: &str) -> Result<Vec<u8>, String> {
        STANDARD
            .decode(value)
            .map_err(|error| format!("Value must be base64: {error}"))
    }

    fn hex_digest(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
        output
    }

    fn percent_encode_path_segment(value: &str) -> String {
        percent_encode(value)
    }

    fn percent_encode_query_value(value: &str) -> String {
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

    fn percent_decode(value: &str) -> String {
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

    #[cfg(test)]
    mod tests {
        use super::*;

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
        fn reconciliation_apply_body_batches_every_manifest_with_one_peer_inventory() {
            let manifests = vec![
                json!({ "project": { "project_id": "proj_one" }, "artifacts": [] }),
                json!({ "project": { "project_id": "proj_two" }, "artifacts": [] }),
            ];
            let remote_metadata = json!({ "projects": [] });
            let available = vec!["hash_a".to_string(), "hash_b".to_string()];

            let body =
                reconciliation_apply_body("dev_peer", &remote_metadata, &manifests, &available);

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

            let body =
                reconciliation_plan_body("dev_peer", &remote_metadata, &manifests, &available);

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
            assert_eq!(entries[0].manifest_project_id, "proj_two");
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
            let first = temp_artifact_path("hash_same");
            let second = temp_artifact_path("hash_same");

            assert_ne!(first, second);
        }

        #[test]
        fn available_content_sha256_deduplicates_received_and_already_staged_artifacts() {
            let received_artifacts = vec![
                SyncTransportTransferResult {
                    artifact_id: "art_one".to_string(),
                    content_sha256: "hash_b".to_string(),
                    size_bytes: 10,
                    status: "received".to_string(),
                    message: None,
                },
                SyncTransportTransferResult {
                    artifact_id: "art_two".to_string(),
                    content_sha256: "hash_a".to_string(),
                    size_bytes: 20,
                    status: "already_staged".to_string(),
                    message: None,
                },
                SyncTransportTransferResult {
                    artifact_id: "art_three".to_string(),
                    content_sha256: "hash_b".to_string(),
                    size_bytes: 10,
                    status: "already_staged".to_string(),
                    message: None,
                },
                SyncTransportTransferResult {
                    artifact_id: "art_failed".to_string(),
                    content_sha256: "hash_c".to_string(),
                    size_bytes: 30,
                    status: "failed".to_string(),
                    message: Some("transfer failed".to_string()),
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
                SyncTransportTransferResult {
                    artifact_id: "art_one".to_string(),
                    content_sha256: "hash_a".to_string(),
                    size_bytes: 10,
                    status: "received".to_string(),
                    message: None,
                },
                SyncTransportTransferResult {
                    artifact_id: "art_two".to_string(),
                    content_sha256: "hash_b".to_string(),
                    size_bytes: 20,
                    status: "already_staged".to_string(),
                    message: None,
                },
                SyncTransportTransferResult {
                    artifact_id: "art_three".to_string(),
                    content_sha256: "hash_c".to_string(),
                    size_bytes: 30,
                    status: "failed".to_string(),
                    message: Some("transfer failed".to_string()),
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

#[cfg(not(target_os = "android"))]
pub use desktop::SyncTransportState;

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn sync_transport_start_listener(
    state: tauri::State<'_, desktop::SyncTransportState>,
    payload: SyncTransportStartListenerRequest,
) -> Result<SyncTransportStatus, String> {
    desktop::sync_transport_start_listener(state, payload)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn sync_transport_stop_listener(
    state: tauri::State<'_, desktop::SyncTransportState>,
) -> Result<SyncTransportStatus, String> {
    desktop::sync_transport_stop_listener(state)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn sync_transport_status(
    state: tauri::State<'_, desktop::SyncTransportState>,
) -> SyncTransportStatus {
    desktop::sync_transport_status(state)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn sync_transport_create_pairing_offer(
    state: tauri::State<'_, desktop::SyncTransportState>,
    payload: SyncTransportPairingOfferRequest,
) -> Result<SyncTransportPairingOffer, String> {
    desktop::sync_transport_create_pairing_offer(state, payload).await
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn sync_transport_sync_now(
    state: tauri::State<'_, desktop::SyncTransportState>,
    payload: SyncTransportSyncNowRequest,
) -> Result<SyncTransportSyncResult, String> {
    desktop::sync_transport_sync_now(state, payload).await
}

#[cfg(target_os = "android")]
mod android_stub {
    use super::{
        SyncTransportPairingOffer, SyncTransportPairingOfferRequest,
        SyncTransportStartListenerRequest, SyncTransportStatus, SyncTransportSyncNowRequest,
        SyncTransportSyncResult,
    };
    use tauri::State;

    #[derive(Clone, Default)]
    pub struct SyncTransportState;

    impl SyncTransportState {
        pub fn new(_base_url: String) -> Self {
            Self
        }

        pub fn shutdown(&self) {}
    }

    fn unsupported_status() -> SyncTransportStatus {
        SyncTransportStatus {
            supported: false,
            running: false,
            bind_host: None,
            port: None,
            endpoint_hints: Vec::new(),
            active_sessions: 0,
            accepted_sessions: 0,
            failed_sessions: 0,
            last_status: None,
            last_error: Some("Sync transport is only available on desktop.".to_string()),
            last_sync: None,
        }
    }

    pub fn sync_transport_start_listener(
        _state: State<'_, SyncTransportState>,
        _payload: SyncTransportStartListenerRequest,
    ) -> Result<SyncTransportStatus, String> {
        Err("Sync transport is only available on desktop.".to_string())
    }

    pub fn sync_transport_stop_listener(
        _state: State<'_, SyncTransportState>,
    ) -> Result<SyncTransportStatus, String> {
        Err("Sync transport is only available on desktop.".to_string())
    }

    pub fn sync_transport_status(_state: State<'_, SyncTransportState>) -> SyncTransportStatus {
        unsupported_status()
    }

    pub async fn sync_transport_create_pairing_offer(
        _state: State<'_, SyncTransportState>,
        _payload: SyncTransportPairingOfferRequest,
    ) -> Result<SyncTransportPairingOffer, String> {
        Err("Sync transport is only available on desktop.".to_string())
    }

    pub async fn sync_transport_sync_now(
        _state: State<'_, SyncTransportState>,
        _payload: SyncTransportSyncNowRequest,
    ) -> Result<SyncTransportSyncResult, String> {
        Err("Sync transport is only available on desktop.".to_string())
    }
}

#[cfg(target_os = "android")]
pub use android_stub::SyncTransportState;

#[cfg(target_os = "android")]
#[tauri::command]
pub fn sync_transport_start_listener(
    state: tauri::State<'_, android_stub::SyncTransportState>,
    payload: SyncTransportStartListenerRequest,
) -> Result<SyncTransportStatus, String> {
    android_stub::sync_transport_start_listener(state, payload)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn sync_transport_stop_listener(
    state: tauri::State<'_, android_stub::SyncTransportState>,
) -> Result<SyncTransportStatus, String> {
    android_stub::sync_transport_stop_listener(state)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn sync_transport_status(
    state: tauri::State<'_, android_stub::SyncTransportState>,
) -> SyncTransportStatus {
    android_stub::sync_transport_status(state)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn sync_transport_create_pairing_offer(
    state: tauri::State<'_, android_stub::SyncTransportState>,
    payload: SyncTransportPairingOfferRequest,
) -> Result<SyncTransportPairingOffer, String> {
    android_stub::sync_transport_create_pairing_offer(state, payload).await
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn sync_transport_sync_now(
    state: tauri::State<'_, android_stub::SyncTransportState>,
    payload: SyncTransportSyncNowRequest,
) -> Result<SyncTransportSyncResult, String> {
    android_stub::sync_transport_sync_now(state, payload).await
}
