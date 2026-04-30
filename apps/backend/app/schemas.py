from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ErrorInfo(BaseModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    error: ErrorInfo


class HealthResponse(BaseModel):
    name: str
    version: str
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
    created_at: datetime
    updated_at: datetime


class ProjectImportRequest(BaseModel):
    source_path: str
    copy_into_project: bool = True
    display_name: str | None = None


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


class DeleteResponse(BaseModel):
    deleted: bool


class AnalysisRequest(BaseModel):
    include_tempo: bool = False
    force: bool = False


class AnalysisSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: str
    source_artifact_id: str | None = None
    estimated_key: str | None
    key_confidence: float | None
    estimated_reference_hz: float | None
    tuning_offset_cents: float | None
    tempo_bpm: float | None
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
        supported = {"default", "fast", "tuneforge-fast", "librosa", "advanced", "crema", "crema-advanced"}
        if self.backend not in supported or (
            self.backend_fallback_from is not None and self.backend_fallback_from not in supported
        ):
            raise ValueError("Unsupported chord backend.")
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


class LyricsGenerateRequest(BaseModel):
    force: bool = False


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
    error_message: str | None
    runtime_device: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    duration_seconds: float | None = None
    created_at: datetime
    updated_at: datetime


class JobResponse(BaseModel):
    job: JobSchema


class JobsResponse(BaseModel):
    jobs: list[JobSchema]


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
    mode: str = "two_stem"
    output_format: str = "wav"
    force: bool = False
    source_artifact_id: str | None = None
    chord_backend: str = "default"
    chord_backend_fallback_from: str | None = None
    overwrite_chord_edits: bool = False

    @model_validator(mode="after")
    def validate_stem_request(self) -> StemRequest:
        if self.mode != "two_stem":
            raise ValueError("Only two_stem mode is supported in v1.")
        if self.output_format != "wav":
            raise ValueError("Stem output must be wav in v1.")
        supported = {"default", "fast", "tuneforge-fast", "librosa", "advanced", "crema", "crema-advanced"}
        if self.chord_backend not in supported or (
            self.chord_backend_fallback_from is not None and self.chord_backend_fallback_from not in supported
        ):
            raise ValueError("Unsupported chord backend.")
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
