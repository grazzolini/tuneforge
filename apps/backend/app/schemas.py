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
    display_name: str

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Project name cannot be empty.")
        return normalized


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
    force: bool = False

    @model_validator(mode="after")
    def validate_backend(self) -> ChordRequest:
        if self.backend != "default":
            raise ValueError("Only the default chord backend is supported in v1.")
        return self


class ChordSegmentSchema(BaseModel):
    start_seconds: float
    end_seconds: float
    label: str
    confidence: float | None = None
    pitch_class: int | None = None
    quality: str | None = None


class ChordResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: str
    timeline: list[ChordSegmentSchema] = Field(default_factory=list, validation_alias="timeline_json")
    backend: str | None = None
    source_artifact_id: str | None = None
    created_at: datetime | None = None


class JobSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str | None
    type: str
    status: str
    progress: int
    source_artifact_id: str | None = None
    error_message: str | None
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

    @model_validator(mode="after")
    def validate_stem_request(self) -> StemRequest:
        if self.mode != "two_stem":
            raise ValueError("Only two_stem mode is supported in v1.")
        if self.output_format != "wav":
            raise ValueError("Stem output must be wav in v1.")
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
