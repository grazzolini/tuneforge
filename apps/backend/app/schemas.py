from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

SUPPORTED_CHORD_BACKENDS = {"default", "fast", "tuneforge-fast", "librosa", "advanced", "crema", "crema-advanced"}
SUPPORTED_STEM_MODELS = {
    "default",
    "6_stems",
    "six_stems",
    "htdemucs_6s",
    "2_stems",
    "two_stems",
    "two_stem",
    "htdemucs_ft",
}
LyricsLanguageOverride = Literal["none", "en", "pt", "es", "fr", "de", "it", "ja", "ko", "zh", "hi"]
SUPPORTED_LYRICS_LANGUAGE_OVERRIDES: set[LyricsLanguageOverride] = {
    "none",
    "en",
    "pt",
    "es",
    "fr",
    "de",
    "it",
    "ja",
    "ko",
    "zh",
    "hi",
}
SIX_STEM_MODEL_ALIASES = {"6_stems", "six_stems", "htdemucs_6s"}
TWO_STEM_MODEL_ALIASES = {"2_stems", "two_stems", "two_stem", "htdemucs_ft"}
SyncProjectStatus = Literal[
    "local",
    "syncing",
    "remote_available",
    "downloading",
    "missing",
    "deleted",
    "conflicted",
]


def _validate_chord_backend_fields(backend: str | None, backend_fallback_from: str | None) -> None:
    if backend is not None and backend not in SUPPORTED_CHORD_BACKENDS:
        raise ValueError("Unsupported chord backend.")
    if backend_fallback_from is not None and backend_fallback_from not in SUPPORTED_CHORD_BACKENDS:
        raise ValueError("Unsupported chord backend.")


class ErrorInfo(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    error: ErrorInfo


class VersionInfo(BaseModel):
    package_version: str
    git_ref: str


class HealthResponse(BaseModel):
    name: str
    version: str
    backend_version: VersionInfo
    frontend_version: VersionInfo
    status: str
    api_base_url: str
    data_root: str
    default_export_format: str
    preview_format: str


class ProjectSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    display_name: str
    source_key_override: str | None
    source_path: str
    imported_path: str
    duration_seconds: float | None
    sample_rate: int | None
    channels: int | None
    sync_status: SyncProjectStatus = "local"
    sync_status_reason: str | None = None
    sync_editable: bool = True
    sync_required_artifact_ids: list[str] = Field(default_factory=list)
    sync_provider_device_ids: list[str] = Field(default_factory=list)
    sync_conflict_count: int = 0
    created_at: datetime
    updated_at: datetime


class ProjectImportRequest(BaseModel):
    source_path: str
    copy_into_project: bool = True
    display_name: str | None = None
    chord_backend: str | None = None
    chord_backend_fallback_from: str | None = None
    stem_model: str | None = None

    @model_validator(mode="after")
    def validate_import_request(self) -> ProjectImportRequest:
        _validate_chord_backend_fields(self.chord_backend, self.chord_backend_fallback_from)
        if self.stem_model is not None and self.stem_model not in SUPPORTED_STEM_MODELS:
            raise ValueError("Unsupported stem model.")
        return self


class ProjectUpdateRequest(BaseModel):
    display_name: str | None = None
    source_key_override: str | None = None

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("Project name cannot be empty.")
        return normalized

    @field_validator("source_key_override")
    @classmethod
    def validate_source_key_override(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        parts = normalized.split(":")
        if len(parts) != 2:
            raise ValueError("Source key override must use serialized key format.")
        pitch_class_raw, mode_raw = parts
        try:
            pitch_class = int(pitch_class_raw)
        except ValueError as exc:
            raise ValueError("Source key override pitch class must be an integer.") from exc
        if pitch_class < 0 or pitch_class > 11:
            raise ValueError("Source key override pitch class must be between 0 and 11.")
        if mode_raw not in {"major", "minor"}:
            raise ValueError("Source key override mode must be major or minor.")
        return normalized

    @model_validator(mode="after")
    def validate_update_request(self) -> ProjectUpdateRequest:
        if not self.model_fields_set:
            raise ValueError("At least one project field must be updated.")
        return self


class ProjectResponse(BaseModel):
    project: ProjectSchema


class ProjectsResponse(BaseModel):
    projects: list[ProjectSchema]
    total: int
    limit: int
    offset: int
    has_more: bool


class DeleteResponse(BaseModel):
    deleted: bool


SyncPreflightProjectStatus = Literal[
    "ready",
    "missing_source_hash",
    "invalid_source_hash",
    "duplicate_source_hash",
    "noncanonical_project_id",
]
SyncPreflightSourceHashSource = Literal[
    "database",
    "original_copy_path",
]


class SyncPreflightProjectSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: str
    display_name: str
    status: SyncPreflightProjectStatus
    source_sha256: str | None
    expected_project_id: str | None
    expected_storage_key: str | None
    source_hash_source: SyncPreflightSourceHashSource | None
    reason: str | None = None


class SyncPreflightDuplicateProjectSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: str
    display_name: str


class SyncPreflightDuplicateGroupSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    source_sha256: str
    expected_project_id: str
    projects: list[SyncPreflightDuplicateProjectSchema]


class SyncPreflightResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    ok: bool
    total_projects: int
    ready_projects: int
    missing_source_hash_projects: int
    invalid_source_hash_projects: int
    duplicate_source_hash_projects: int
    noncanonical_project_id_projects: int
    projects: list[SyncPreflightProjectSchema]
    duplicate_groups: list[SyncPreflightDuplicateGroupSchema]
    manual_cleanup_required: bool
    manual_cleanup_guidance: list[str]


class SyncMetadataProjectSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: str
    display_name: str
    source_key_override: str | None
    source_sha256: str | None
    duration_seconds: float | None
    sample_rate: int | None
    channels: int | None
    created_at: datetime
    updated_at: datetime


class SyncMetadataArtifactSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    artifact_id: str
    project_id: str
    type: str
    format: str
    relative_path: str | None
    content_sha256: str | None
    size_bytes: int
    generated_by: str
    can_delete: bool
    can_regenerate: bool
    cache_key: str | None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class SyncDeleteTombstoneSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    tombstone_id: str = Field(validation_alias=AliasChoices("tombstone_id", "id"))
    sync_group_id: str
    project_id: str
    target_type: str
    target_id: str
    author_device_id: str
    deleted_at: datetime
    prior_metadata: dict[str, Any] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("prior_metadata", "prior_metadata_json"),
    )
    created_at: datetime
    updated_at: datetime


class SyncMetadataResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    projects: list[SyncMetadataProjectSchema]
    artifacts: list[SyncMetadataArtifactSchema]
    delete_tombstones: list[SyncDeleteTombstoneSchema] = Field(default_factory=list)


class SyncProjectManifestProjectSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: str
    display_name: str
    source_key_override: str | None
    source_sha256: str
    duration_seconds: float | None
    sample_rate: int | None
    channels: int | None
    created_at: datetime
    updated_at: datetime


class SyncProjectManifestArtifactSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    artifact_id: str
    project_id: str
    type: str
    format: str
    relative_path: str
    content_sha256: str
    size_bytes: int
    generated_by: str
    can_delete: bool
    can_regenerate: bool
    cache_key: str | None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class SyncProjectManifestEntityRevisionSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    revision_id: str
    project_id: str
    entity_type: str
    entity_id: str
    revision_type: str
    base_revision_id: str | None
    author_device_id: str
    source_artifact_id: str | None
    content_sha256: str
    state: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class SyncProjectManifestSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    schema_version: str
    exported_at: datetime
    project: SyncProjectManifestProjectSchema
    entity_revisions: list[SyncProjectManifestEntityRevisionSchema] = Field(default_factory=list)
    artifacts: list[SyncProjectManifestArtifactSchema]
    delete_tombstones: list[SyncDeleteTombstoneSchema] = Field(default_factory=list)


class SyncProjectManifestResponse(BaseModel):
    project_manifest: SyncProjectManifestSchema


class SyncProjectStatusProjectMetadataSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: str
    display_name: str
    source_key_override: str | None = None
    source_sha256: str | None = None
    duration_seconds: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SyncProjectStatusUpdateRequest(BaseModel):
    sync_status: SyncProjectStatus
    sync_status_reason: str | None = None
    sync_required_artifact_ids: list[str] | None = None
    sync_provider_device_ids: list[str] | None = None
    sync_conflict_count: int | None = Field(default=None, ge=0)
    manifest: SyncProjectManifestSchema | None = None
    project: SyncProjectStatusProjectMetadataSchema | None = None

    @field_validator("sync_status_reason")
    @classmethod
    def validate_sync_status_reason(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("sync_required_artifact_ids", "sync_provider_device_ids")
    @classmethod
    def validate_sync_id_list(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        normalized = [item.strip() for item in value]
        if any(not item for item in normalized):
            raise ValueError("Sync ID lists cannot contain empty values.")
        return normalized

    @model_validator(mode="after")
    def validate_status_metadata(self) -> SyncProjectStatusUpdateRequest:
        if self.manifest is not None and self.project is not None:
            raise ValueError("Provide either manifest or project metadata, not both.")
        return self


class SyncProjectStatusUpdateResponse(BaseModel):
    project: ProjectSchema


class SyncArtifactStagingRequest(BaseModel):
    source_path: str = Field(min_length=1)
    content_sha256: str = Field(min_length=64, max_length=64)
    size_bytes: int = Field(ge=0)
    provider_device_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SyncStagedArtifactSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    content_sha256: str
    size_bytes: int
    relative_path: str
    provider_device_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    verified_at: datetime
    created_at: datetime
    updated_at: datetime


class SyncProjectStagedImportRequest(BaseModel):
    manifest: SyncProjectManifestSchema
    staging_root: str | None = Field(default=None, min_length=1)
    use_content_addressed_staging: bool | None = None


class SyncProjectImportResponse(BaseModel):
    project: ProjectSchema


SyncReconciliationStatus = Literal[
    "noop",
    "identical_content",
    "missing_local_bytes",
    "remote_available",
    "missing_provider",
    "deleted",
    "conflicted",
]
SyncReconciliationActionType = Literal[
    "apply_delete_tombstone",
    "import_project_manifest",
    "import_entity_revision",
    "fetch_artifact_content",
    "import_artifact_manifest",
    "upsert_project_status",
    "record_conflict",
    "noop",
]


class SyncPeerInventoryEntrySchema(BaseModel):
    device_id: str
    available_content_sha256: list[str]
    metadata: dict[str, Any] = Field(default_factory=dict)


class SyncReconciliationRemoteLibrarySchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    projects: list[SyncMetadataProjectSchema]
    artifacts: list[SyncMetadataArtifactSchema]
    entity_revisions: list[SyncProjectManifestEntityRevisionSchema] = Field(default_factory=list)
    delete_tombstones: list[SyncDeleteTombstoneSchema] = Field(default_factory=list)


class SyncReconciliationPlanRequest(BaseModel):
    remote_library: SyncReconciliationRemoteLibrarySchema
    project_manifests: list[SyncProjectManifestSchema] = Field(default_factory=list)
    peer_inventory: list[SyncPeerInventoryEntrySchema]


class SyncReconciliationSummarySchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    total_items: int
    total_actions: int
    total_conflicts: int
    status_counts: dict[SyncReconciliationStatus, int] = Field(default_factory=dict)


class SyncReconciliationItemSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    item_type: str
    item_id: str
    project_id: str | None = None
    status: SyncReconciliationStatus
    action_type: SyncReconciliationActionType | None = None
    content_sha256: str | None = None
    chosen_provider_device_id: str | None = None
    reason: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class SyncReconciliationActionSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    action_type: SyncReconciliationActionType
    item_type: str
    item_id: str
    project_id: str | None = None
    content_sha256: str | None = None
    provider_device_id: str | None = None
    reason: str | None = None
    priority: int
    details: dict[str, Any] = Field(default_factory=dict)


class SyncReconciliationPlanResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    summary: SyncReconciliationSummarySchema
    items: list[SyncReconciliationItemSchema]
    actions: list[SyncReconciliationActionSchema]


SyncReconciliationApplyActionStatus = Literal["applied", "satisfied", "skipped", "failed"]
SyncReconciliationTimingPhase = Literal["plan", "apply", "action", "staging_cleanup"]


class SyncReconciliationApplyRequest(SyncReconciliationPlanRequest):
    staging_root: str | None = Field(default=None, min_length=1)
    use_content_addressed_staging: bool = True
    project_ids: list[str] = Field(default_factory=list)
    include_timing_evidence: bool = False

    @field_validator("project_ids")
    @classmethod
    def validate_project_ids(cls, value: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for project_id in value:
            cleaned = project_id.strip()
            if not cleaned:
                raise ValueError("Project IDs cannot contain empty values.")
            if cleaned in seen:
                continue
            normalized.append(cleaned)
            seen.add(cleaned)
        return normalized


class SyncReconciliationApplySummarySchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    planned_actions: int
    applied_actions: int
    satisfied_actions: int
    skipped_actions: int
    failed_actions: int


class SyncReconciliationApplyActionResultSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    action: SyncReconciliationActionSchema
    status: SyncReconciliationApplyActionStatus
    reason: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class SyncReconciliationTimingEvidenceSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    phase: SyncReconciliationTimingPhase
    duration_ms: float = Field(ge=0)
    action_type: SyncReconciliationActionType | None = None
    item_type: str | None = None
    item_id: str | None = None
    project_id: str | None = None
    status: SyncReconciliationApplyActionStatus | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class SyncReconciliationApplyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    summary: SyncReconciliationApplySummarySchema
    plan: SyncReconciliationPlanResponse
    results: list[SyncReconciliationApplyActionResultSchema]
    timing_evidence: list[SyncReconciliationTimingEvidenceSchema] = Field(default_factory=list)


class SyncTransportHandshakeChallengeSchema(BaseModel):
    protocol_version: str = Field(min_length=1)
    challenge_type: Literal["transport_handshake"]
    session_id: str = Field(min_length=16, max_length=128)
    challenge_nonce: str = Field(min_length=16, max_length=512)
    requester_device_id: str = Field(min_length=1, max_length=128)
    responder_device_id: str = Field(min_length=1, max_length=128)
    issued_at: datetime
    expires_at: datetime

    @field_validator(
        "protocol_version",
        "session_id",
        "challenge_nonce",
        "requester_device_id",
        "responder_device_id",
    )
    @classmethod
    def validate_canonical_string(cls, value: str) -> str:
        if value != value.strip() or not value:
            raise ValueError("Transport handshake challenge fields must be canonical strings.")
        return value

    @model_validator(mode="after")
    def validate_time_window(self) -> SyncTransportHandshakeChallengeSchema:
        if self.issued_at >= self.expires_at:
            raise ValueError("Transport handshake issued_at must be before expires_at.")
        return self


class SyncTransportHandshakeSignRequest(BaseModel):
    peer_device_id: str = Field(min_length=1, max_length=128)
    challenge: SyncTransportHandshakeChallengeSchema

    @field_validator("peer_device_id")
    @classmethod
    def validate_peer_device_id(cls, value: str) -> str:
        if value != value.strip() or not value:
            raise ValueError("peer_device_id must be canonical.")
        return value


class SyncTransportHandshakeSignatureResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    protocol_version: str
    challenge_type: Literal["transport_handshake"]
    local_device_id: str
    peer_device_id: str
    public_key: str
    challenge: SyncTransportHandshakeChallengeSchema
    canonical_challenge_json: str
    signature: str
    signed_at: datetime


class SyncLocalIdentitySchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    device_id: str
    sync_group_id: str
    display_name: str | None = None
    public_key: str = Field(validation_alias=AliasChoices("public_key", "public_key_pem", "public_identity"))
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SyncLocalIdentityResponse(BaseModel):
    identity: SyncLocalIdentitySchema


class SyncLocalIdentityUpdateRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=255)

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Display name cannot be empty.")
        return normalized


class SyncPairingPayloadSchema(BaseModel):
    sync_group_id: str
    device_id: str
    display_name: str | None = None
    public_key: str = Field(validation_alias=AliasChoices("public_key", "public_key_pem", "public_identity"))
    endpoint_hints: list[str] = Field(default_factory=list)
    protocol_version: str
    pairing_offer_id: str = Field(min_length=1)
    pairing_secret: str = Field(
        validation_alias=AliasChoices("pairing_secret", "secret", "confirmation_code"),
        min_length=1,
    )
    expires_at: datetime
    signature: str = Field(min_length=1)

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("Display name cannot be empty.")
        return normalized

    @field_validator("endpoint_hints")
    @classmethod
    def validate_endpoint_hints(cls, value: list[str]) -> list[str]:
        normalized = [hint.strip() for hint in value]
        if any(not hint for hint in normalized):
            raise ValueError("Endpoint hints cannot be empty.")
        return normalized


class SyncPairingOfferSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    payload: SyncPairingPayloadSchema
    expires_at: datetime
    ttl_seconds: int | None = None


class SyncPairingOfferRequest(BaseModel):
    endpoint_hints: list[str] = Field(default_factory=list)
    ttl_seconds: int = Field(default=600, ge=1, le=3600)

    @field_validator("endpoint_hints")
    @classmethod
    def validate_endpoint_hints(cls, value: list[str]) -> list[str]:
        normalized = [hint.strip() for hint in value]
        if any(not hint for hint in normalized):
            raise ValueError("Endpoint hints cannot be empty.")
        return normalized


class SyncPairingOfferResponse(BaseModel):
    pairing_offer: SyncPairingOfferSchema


class SyncPairingAnswerRequest(BaseModel):
    offer: SyncPairingPayloadSchema
    endpoint_hints: list[str] = Field(default_factory=list)
    adopt_sync_group: bool = False

    @field_validator("endpoint_hints")
    @classmethod
    def validate_endpoint_hints(cls, value: list[str]) -> list[str]:
        normalized = [hint.strip() for hint in value]
        if any(not hint for hint in normalized):
            raise ValueError("Endpoint hints cannot be empty.")
        return normalized


class SyncTrustedPeerSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    device_id: str
    sync_group_id: str
    display_name: str | None = None
    public_key: str = Field(validation_alias=AliasChoices("public_key", "public_key_pem", "public_identity"))
    endpoint_hints: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices("endpoint_hints", "endpoint_hints_json"),
    )
    trusted_at: datetime = Field(validation_alias=AliasChoices("trusted_at", "created_at"))
    revoked_at: datetime | None = None
    updated_at: datetime | None = None


class SyncTrustedPeerCreateRequest(BaseModel):
    payload: SyncPairingPayloadSchema
    adopt_sync_group: bool = False

    @model_validator(mode="before")
    @classmethod
    def normalize_payload_wrapper(cls, value: Any) -> Any:
        if not isinstance(value, dict) or "payload" in value:
            return value
        pairing_payload_fields = {
            "protocol_version",
            "sync_group_id",
            "device_id",
            "public_key",
            "pairing_secret",
            "expires_at",
        }
        if not pairing_payload_fields <= set(value):
            return value
        adopt_sync_group = value.get("adopt_sync_group", False)
        payload = {key: child for key, child in value.items() if key != "adopt_sync_group"}
        return {"payload": payload, "adopt_sync_group": adopt_sync_group}


class SyncTrustedPeerResponse(BaseModel):
    trusted_peer: SyncTrustedPeerSchema


class SyncPairingAnswerResponse(BaseModel):
    pairing_response: SyncPairingPayloadSchema
    trusted_peer: SyncTrustedPeerSchema


class SyncTrustedPeersResponse(BaseModel):
    trusted_peers: list[SyncTrustedPeerSchema]


class AnalysisRequest(BaseModel):
    include_tempo: bool = False
    force: bool = False


class AnalysisTimingBeatSchema(BaseModel):
    index: int
    seconds: float
    bar_index: int
    beat_in_bar: int


class AnalysisTimingBarSchema(BaseModel):
    index: int
    start_seconds: float
    end_seconds: float


class AnalysisTimingSchema(BaseModel):
    beats_per_bar: int
    source: str
    beats: list[AnalysisTimingBeatSchema] = Field(default_factory=list)
    bars: list[AnalysisTimingBarSchema] = Field(default_factory=list)


class AnalysisSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: str
    source_artifact_id: str | None = None
    estimated_key: str | None
    key_confidence: float | None
    estimated_reference_hz: float | None
    tuning_offset_cents: float | None
    tempo_bpm: float | None
    timing: AnalysisTimingSchema | None = Field(default=None, validation_alias="timing_json")
    analysis_version: str
    created_at: datetime


class AnalysisResponse(BaseModel):
    analysis: AnalysisSchema | None


class ChordRequest(BaseModel):
    backend: str = "default"
    backend_fallback_from: str | None = None
    force: bool = False
    overwrite_user_edits: bool = False

    @model_validator(mode="after")
    def validate_backend(self) -> ChordRequest:
        _validate_chord_backend_fields(self.backend, self.backend_fallback_from)
        return self


class ChordSegmentSchema(BaseModel):
    start_seconds: float
    end_seconds: float
    label: str
    display_label: str | None = None
    raw_label: str | None = None
    confidence: float | None = None
    pitch_class: int | None = None
    root_pitch_class: int | None = None
    quality: str | None = None
    bass_pitch_class: int | None = None
    bass_degree: str | None = None


class ChordResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: str
    source_segments: list[ChordSegmentSchema] = Field(
        default_factory=list,
        validation_alias="source_segments_json",
    )
    timeline: list[ChordSegmentSchema] = Field(default_factory=list, validation_alias="segments_json")
    backend: str | None = None
    source_artifact_id: str | None = None
    has_user_edits: bool = False
    source_kind: str = "generated"
    metadata: dict[str, Any] = Field(default_factory=dict, validation_alias="metadata_json")
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ChordBackendCapabilitiesSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    supports_sevenths: bool = Field(alias="supportsSevenths")
    supports_inversions: bool = Field(alias="supportsInversions")
    supports_confidence: bool = Field(alias="supportsConfidence")
    supports_no_chord: bool = Field(alias="supportsNoChord")
    estimated_speed: str = Field(alias="estimatedSpeed")
    desktop_only: bool = Field(alias="desktopOnly")
    experimental: bool


class ChordBackendSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    label: str
    description: str
    availability: str
    available: bool
    unavailable_reason: str | None = None
    capabilities: ChordBackendCapabilitiesSchema
    experimental: bool
    desktop_only: bool = Field(alias="desktopOnly")


class ChordBackendsResponse(BaseModel):
    backends: list[ChordBackendSchema]


class StemModelSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    label: str
    description: str
    sources: list[str]
    source_count: int = Field(alias="sourceCount")
    default: bool
    availability: str
    available: bool
    unavailable_reason: str | None = None


class StemModelsResponse(BaseModel):
    models: list[StemModelSchema]


class LyricsGenerateRequest(BaseModel):
    force: bool = False
    language_override: LyricsLanguageOverride | None = None

    @field_validator("language_override", mode="before")
    @classmethod
    def validate_language_override(cls, value: object) -> object:
        if value is None:
            return None
        if not isinstance(value, str):
            return value
        normalized = value.strip().lower()
        if not normalized:
            return None
        if normalized not in SUPPORTED_LYRICS_LANGUAGE_OVERRIDES:
            raise ValueError("Unsupported lyrics language override.")
        return normalized


class LyricsWordSchema(BaseModel):
    text: str
    start_seconds: float | None = None
    end_seconds: float | None = None
    confidence: float | None = None


class LyricsSegmentSchema(BaseModel):
    start_seconds: float | None = None
    end_seconds: float | None = None
    text: str
    words: list[LyricsWordSchema] = Field(default_factory=list)


class LyricsEditSegmentSchema(BaseModel):
    text: str


class LyricsUpdateRequest(BaseModel):
    segments: list[LyricsEditSegmentSchema] = Field(default_factory=list)


class LyricsResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: str
    backend: str | None = None
    source_artifact_id: str | None = None
    source_kind: str | None = None
    requested_device: str | None = None
    device: str | None = None
    model_name: str | None = None
    language: str | None = None
    language_override: LyricsLanguageOverride | None = None
    source_segments: list[LyricsSegmentSchema] = Field(
        default_factory=list, validation_alias="source_segments_json"
    )
    segments: list[LyricsSegmentSchema] = Field(default_factory=list, validation_alias="segments_json")
    has_user_edits: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SongSectionSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    tab_import_id: str | None = None
    label: str
    start_seconds: float | None = None
    end_seconds: float | None = None
    source: str
    metadata: dict[str, Any] = Field(default_factory=dict, validation_alias="metadata_json")
    created_at: datetime
    updated_at: datetime


class SongSectionsResponse(BaseModel):
    sections: list[SongSectionSchema] = Field(default_factory=list)


class TabImportCreateRequest(BaseModel):
    raw_text: str

    @field_validator("raw_text")
    @classmethod
    def validate_raw_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Tab text cannot be empty.")
        return value


class TabSuggestionSchema(BaseModel):
    id: str
    kind: str
    status: str = "pending"
    title: str
    current_text: str | None = None
    suggested_text: str | None = None
    start_seconds: float | None = None
    end_seconds: float | None = None
    segment_index: int | None = None
    chord_index: int | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class TabSuggestionGroupSchema(BaseModel):
    kind: str
    label: str
    suggestions: list[TabSuggestionSchema] = Field(default_factory=list)


class TabImportSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    raw_text: str
    parser_version: str
    status: str
    parsed: dict[str, Any] = Field(default_factory=dict, validation_alias="parsed_json")
    groups: list[TabSuggestionGroupSchema] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class TabImportResponse(BaseModel):
    tab_import: TabImportSchema


class TabImportApplyRequest(BaseModel):
    accepted_suggestion_ids: list[str] = Field(default_factory=list)


class TabImportApplyResponse(BaseModel):
    tab_import: TabImportSchema
    accepted_suggestion_ids: list[str] = Field(default_factory=list)
    ignored_suggestion_ids: list[str] = Field(default_factory=list)
    lyrics: LyricsResponse | None = None
    chords: ChordResponse | None = None
    sections: list[SongSectionSchema] = Field(default_factory=list)
    project: ProjectSchema


class JobSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str | None
    type: str
    status: str
    progress: int
    source_artifact_id: str | None = None
    chord_backend: str | None = None
    chord_backend_fallback_from: str | None = None
    chord_source: str | None = None
    stem_model: str | None = None
    stem_model_label: str | None = None
    error_message: str | None
    runtime_device: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    duration_seconds: float | None = None
    created_at: datetime
    updated_at: datetime


class JobResponse(BaseModel):
    job: JobSchema


BulkJobType = Literal["analyze", "chords", "lyrics", "stems"]
BulkJobSkipReason = Literal["active_job", "locked", "creation_failed", "no_existing_stems"]


class BulkJobRequest(BaseModel):
    job_type: BulkJobType = Field(description="Project job type to enqueue for every project.")
    chord_backend: str | None = None
    chord_backend_fallback_from: str | None = None
    stem_model: str | None = None

    @model_validator(mode="after")
    def validate_bulk_job_request(self) -> BulkJobRequest:
        _validate_chord_backend_fields(self.chord_backend, self.chord_backend_fallback_from)
        if self.stem_model is not None and self.stem_model not in SUPPORTED_STEM_MODELS:
            raise ValueError("Unsupported stem model.")
        return self


class BulkJobSkippedProjectSchema(BaseModel):
    project_id: str
    project_name: str
    reason: BulkJobSkipReason


class BulkJobsResponse(BaseModel):
    created_jobs: list[JobSchema]
    total_projects: int
    skipped: list[BulkJobSkippedProjectSchema]


class JobsResponse(BaseModel):
    jobs: list[JobSchema]
    total: int
    limit: int
    offset: int
    has_more: bool


class ArtifactSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    type: str
    format: str
    path: str
    size_bytes: int
    generated_by: str
    can_delete: bool
    can_regenerate: bool
    metadata: dict[str, Any] = Field(validation_alias="metadata_json")
    created_at: datetime


class ArtifactsResponse(BaseModel):
    artifacts: list[ArtifactSchema]


class RetuneRequest(BaseModel):
    target_reference_hz: float | None = None
    target_cents_offset: float | None = None
    preview_only: bool = True
    output_format: str = "wav"

    @model_validator(mode="after")
    def validate_retune(self) -> RetuneRequest:
        provided = [self.target_reference_hz is not None, self.target_cents_offset is not None]
        if sum(provided) != 1:
            raise ValueError("Exactly one of target_reference_hz or target_cents_offset is required.")
        return self


class TransposeRequest(BaseModel):
    semitones: int
    preview_only: bool = True
    output_format: str = "wav"


class PreviewRetuneRequest(BaseModel):
    target_reference_hz: float | None = None
    target_cents_offset: float | None = None

    @model_validator(mode="after")
    def validate_retune(self) -> PreviewRetuneRequest:
        provided = [self.target_reference_hz is not None, self.target_cents_offset is not None]
        if sum(provided) != 1:
            raise ValueError("Exactly one of target_reference_hz or target_cents_offset is required.")
        return self


class PreviewTransposeRequest(BaseModel):
    semitones: int


class PreviewRequest(BaseModel):
    retune: PreviewRetuneRequest | None = None
    transpose: PreviewTransposeRequest | None = None
    output_format: str = "wav"

    @model_validator(mode="after")
    def validate_preview(self) -> PreviewRequest:
        if self.retune is None and self.transpose is None:
            raise ValueError("At least one preview transform is required.")
        return self


class StemRequest(BaseModel):
    mode: str = "stems"
    stem_model: str | None = None
    output_format: str = "wav"
    force: bool = False
    source_artifact_id: str | None = None
    chord_backend: str = "default"
    chord_backend_fallback_from: str | None = None
    overwrite_chord_edits: bool = False

    @model_validator(mode="after")
    def validate_stem_request(self) -> StemRequest:
        if self.mode not in {"stems", "two_stem"}:
            raise ValueError("Only stems mode is supported.")
        if self.stem_model is not None and self.stem_model not in SUPPORTED_STEM_MODELS:
            raise ValueError("Unsupported stem model.")
        if self.mode == "two_stem" and self.stem_model in SIX_STEM_MODEL_ALIASES:
            raise ValueError("two_stem mode requires a two-stem model.")
        if self.output_format != "wav":
            raise ValueError("Stem output must be wav in v1.")
        _validate_chord_backend_fields(self.chord_backend, self.chord_backend_fallback_from)
        return self


class ExportRequest(BaseModel):
    artifact_ids: list[str]
    mixdown_mode: str = "copy"
    output_format: str = "wav"
    destination_path: str | None = None

    @model_validator(mode="after")
    def validate_export(self) -> ExportRequest:
        if not self.artifact_ids:
            raise ValueError("At least one artifact id is required.")
        return self
