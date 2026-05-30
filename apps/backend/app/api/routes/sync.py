from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.dependencies import get_db
from app.schemas import (
    ErrorResponse,
    ProjectSchema,
    SyncArtifactFileResolveRequest,
    SyncArtifactFileResolveResponse,
    SyncArtifactStagingRequest,
    SyncLocalIdentityResponse,
    SyncLocalIdentitySchema,
    SyncLocalIdentityUpdateRequest,
    SyncMetadataResponse,
    SyncPairingAnswerRequest,
    SyncPairingAnswerResponse,
    SyncPairingOfferRequest,
    SyncPairingOfferResponse,
    SyncPairingOfferSchema,
    SyncPreflightResponse,
    SyncProjectImportResponse,
    SyncProjectManifestResponse,
    SyncProjectManifestsRequest,
    SyncProjectManifestsResponse,
    SyncProjectStagedImportRequest,
    SyncProjectStatusUpdateRequest,
    SyncProjectStatusUpdateResponse,
    SyncReconciliationApplyRequest,
    SyncReconciliationApplyResponse,
    SyncReconciliationPlanRequest,
    SyncReconciliationPlanResponse,
    SyncStagedArtifactSchema,
    SyncTransportHandshakeSignatureResponse,
    SyncTransportHandshakeSignRequest,
    SyncTrustedPeerCreateRequest,
    SyncTrustedPeerEndpointHintsRequest,
    SyncTrustedPeerResponse,
    SyncTrustedPeerSchema,
    SyncTrustedPeersResponse,
)
from app.services.sync_identity import run_sync_preflight
from app.services.sync_metadata import get_sync_metadata
from app.services.sync_project_status import update_project_sync_status
from app.services.sync_trust import (
    answer_pairing_offer,
    create_pairing_offer,
    get_or_create_local_identity,
    list_trusted_peers,
    revoke_trusted_peer,
    trust_peer_from_pairing_payload,
    update_local_identity_display_name,
    update_trusted_peer_endpoint_hints,
)

router = APIRouter(prefix="/sync", tags=["sync"])


def _stage_sync_artifact(
    session: Session,
    *,
    source_path: str,
    content_sha256: str,
    size_bytes: int,
    provider_device_id: str | None,
    metadata: dict[str, Any],
) -> Any:
    from app.services.sync_staging import stage_sync_artifact

    return stage_sync_artifact(
        session,
        source_path=source_path,
        content_sha256=content_sha256,
        size_bytes=size_bytes,
        provider_device_id=provider_device_id,
        metadata=metadata,
    )


def _require_staged_artifact(
    session: Session,
    *,
    content_sha256: str,
) -> Any:
    from app.services.sync_staging import require_staged_artifact

    return require_staged_artifact(session, content_sha256=content_sha256)


def plan_sync_reconciliation(session: Session, payload: SyncReconciliationPlanRequest) -> Any:
    from app.services.sync_reconciliation import plan_sync_reconciliation as service_plan_sync_reconciliation

    return service_plan_sync_reconciliation(session, payload)


def apply_sync_reconciliation(session: Session, payload: SyncReconciliationApplyRequest) -> Any:
    from app.services.sync_reconciliation_apply import apply_sync_reconciliation as service_apply_sync_reconciliation

    return service_apply_sync_reconciliation(session, payload)


def sign_transport_handshake_challenge(session: Session, payload: SyncTransportHandshakeSignRequest) -> Any:
    from app.services.sync_transport import sign_transport_handshake_challenge as service_sign_challenge

    return service_sign_challenge(session, payload)


def resolve_artifact_file_sources(session: Session, payload: SyncArtifactFileResolveRequest) -> Any:
    from app.services.sync_manifest import (
        resolve_artifact_file_sources as service_resolve_artifact_file_sources,
    )

    return service_resolve_artifact_file_sources(session, artifact_ids=payload.artifact_ids)


@router.get("/preflight", response_model=SyncPreflightResponse)
def sync_preflight(session: Session = Depends(get_db)) -> SyncPreflightResponse:
    return SyncPreflightResponse.model_validate(run_sync_preflight(session))


@router.get("/metadata", response_model=SyncMetadataResponse)
def sync_metadata(session: Session = Depends(get_db)) -> SyncMetadataResponse:
    return SyncMetadataResponse.model_validate(get_sync_metadata(session))


@router.post("/reconciliation/plan", response_model=SyncReconciliationPlanResponse)
def sync_reconciliation_plan(
    payload: SyncReconciliationPlanRequest,
    session: Session = Depends(get_db),
) -> SyncReconciliationPlanResponse:
    plan = plan_sync_reconciliation(session, payload)
    return SyncReconciliationPlanResponse.model_validate(plan)


@router.post("/reconciliation/apply", response_model=SyncReconciliationApplyResponse)
def sync_reconciliation_apply(
    payload: SyncReconciliationApplyRequest,
    session: Session = Depends(get_db),
) -> SyncReconciliationApplyResponse:
    result = apply_sync_reconciliation(session, payload)
    return SyncReconciliationApplyResponse.model_validate(result)


@router.post("/transport/handshake/sign", response_model=SyncTransportHandshakeSignatureResponse)
def sync_transport_handshake_sign(
    payload: SyncTransportHandshakeSignRequest,
    session: Session = Depends(get_db),
) -> SyncTransportHandshakeSignatureResponse:
    signature = sign_transport_handshake_challenge(session, payload)
    return SyncTransportHandshakeSignatureResponse.model_validate(signature)


@router.get("/identity", response_model=SyncLocalIdentityResponse)
def sync_local_identity(session: Session = Depends(get_db)) -> SyncLocalIdentityResponse:
    identity = get_or_create_local_identity(session)
    return SyncLocalIdentityResponse(identity=SyncLocalIdentitySchema.model_validate(identity))


@router.patch("/identity", response_model=SyncLocalIdentityResponse)
def sync_local_identity_update(
    payload: SyncLocalIdentityUpdateRequest,
    session: Session = Depends(get_db),
) -> SyncLocalIdentityResponse:
    identity = update_local_identity_display_name(session, display_name=payload.display_name)
    return SyncLocalIdentityResponse(identity=SyncLocalIdentitySchema.model_validate(identity))


@router.post("/pairing/offers", response_model=SyncPairingOfferResponse)
def sync_pairing_offer_create(
    payload: SyncPairingOfferRequest,
    session: Session = Depends(get_db),
) -> SyncPairingOfferResponse:
    pairing_offer = create_pairing_offer(
        session,
        endpoint_hints=payload.endpoint_hints,
        ttl_seconds=payload.ttl_seconds,
    )
    return SyncPairingOfferResponse(
        pairing_offer=SyncPairingOfferSchema.model_validate(
            {
                "payload": pairing_offer.payload,
                "expires_at": pairing_offer.expires_at,
                "ttl_seconds": payload.ttl_seconds,
            }
        )
    )


@router.post("/pairing/responses", response_model=SyncPairingAnswerResponse)
def sync_pairing_offer_answer(
    payload: SyncPairingAnswerRequest,
    session: Session = Depends(get_db),
) -> SyncPairingAnswerResponse:
    pairing_answer = answer_pairing_offer(
        session,
        offer=payload.offer.model_dump(mode="python"),
        endpoint_hints=payload.endpoint_hints,
        adopt_sync_group=payload.adopt_sync_group,
    )
    return SyncPairingAnswerResponse(
        pairing_response=SyncPairingOfferSchema.model_validate(
            {
                "payload": pairing_answer.payload,
                "expires_at": pairing_answer.payload["expires_at"],
            }
        ).payload,
        trusted_peer=SyncTrustedPeerSchema.model_validate(pairing_answer.trusted_peer),
    )


@router.get("/trusted-peers", response_model=SyncTrustedPeersResponse)
def sync_trusted_peers(session: Session = Depends(get_db)) -> SyncTrustedPeersResponse:
    trusted_peers = [SyncTrustedPeerSchema.model_validate(peer) for peer in list_trusted_peers(session)]
    return SyncTrustedPeersResponse(trusted_peers=trusted_peers)


@router.post("/trusted-peers", response_model=SyncTrustedPeerResponse)
def sync_trusted_peer_create(
    payload: SyncTrustedPeerCreateRequest,
    session: Session = Depends(get_db),
) -> SyncTrustedPeerResponse:
    trusted_peer = trust_peer_from_pairing_payload(
        session,
        payload=payload.payload.model_dump(mode="python"),
        adopt_sync_group=payload.adopt_sync_group,
    )
    return SyncTrustedPeerResponse(trusted_peer=SyncTrustedPeerSchema.model_validate(trusted_peer))


@router.delete("/trusted-peers/{device_id}", response_model=SyncTrustedPeerResponse)
def sync_trusted_peer_delete(
    device_id: str,
    session: Session = Depends(get_db),
) -> SyncTrustedPeerResponse:
    trusted_peer = revoke_trusted_peer(session, device_id=device_id)
    return SyncTrustedPeerResponse(trusted_peer=SyncTrustedPeerSchema.model_validate(trusted_peer))


@router.patch("/trusted-peers/{device_id}/endpoint-hints", response_model=SyncTrustedPeerResponse)
def sync_trusted_peer_endpoint_hints_update(
    device_id: str,
    payload: SyncTrustedPeerEndpointHintsRequest,
    session: Session = Depends(get_db),
) -> SyncTrustedPeerResponse:
    trusted_peer = update_trusted_peer_endpoint_hints(
        session,
        device_id=device_id,
        endpoint_hints=payload.endpoint_hints,
    )
    return SyncTrustedPeerResponse(trusted_peer=SyncTrustedPeerSchema.model_validate(trusted_peer))


@router.get("/projects/{project_id}/manifest", response_model=SyncProjectManifestResponse)
def sync_project_manifest(
    project_id: str,
    session: Session = Depends(get_db),
) -> SyncProjectManifestResponse:
    from app.services.sync_manifest import export_project_manifest

    project_manifest = export_project_manifest(session, project_id=project_id)
    return SyncProjectManifestResponse.model_validate({"project_manifest": project_manifest})


@router.post("/projects/manifests", response_model=SyncProjectManifestsResponse)
def sync_project_manifests(
    payload: SyncProjectManifestsRequest,
    session: Session = Depends(get_db),
) -> SyncProjectManifestsResponse:
    from app.services.sync_manifest import export_project_manifests

    manifest_export = export_project_manifests(session, project_ids=payload.project_ids)
    return SyncProjectManifestsResponse.model_validate(manifest_export)


@router.patch("/projects/{project_id}/status", response_model=SyncProjectStatusUpdateResponse)
def sync_project_status_update(
    project_id: str,
    payload: SyncProjectStatusUpdateRequest,
    session: Session = Depends(get_db),
) -> SyncProjectStatusUpdateResponse:
    placeholder_metadata: dict[str, Any] | None = None
    if payload.manifest is not None:
        placeholder_metadata = payload.manifest.model_dump(mode="python")
    elif payload.project is not None:
        placeholder_metadata = payload.project.model_dump(mode="python")
    project = update_project_sync_status(
        session,
        project_id=project_id,
        sync_status=payload.sync_status,
        sync_status_reason=payload.sync_status_reason,
        sync_required_artifact_ids=payload.sync_required_artifact_ids,
        sync_provider_device_ids=payload.sync_provider_device_ids,
        sync_conflict_count=payload.sync_conflict_count,
        manifest=placeholder_metadata,
    )
    session.commit()
    session.refresh(project)
    return SyncProjectStatusUpdateResponse(project=ProjectSchema.model_validate(project))


@router.post("/artifacts/staging", response_model=SyncStagedArtifactSchema)
def sync_artifact_stage(
    payload: SyncArtifactStagingRequest,
    session: Session = Depends(get_db),
) -> SyncStagedArtifactSchema:
    staged_artifact = _stage_sync_artifact(
        session,
        source_path=payload.source_path,
        content_sha256=payload.content_sha256,
        size_bytes=payload.size_bytes,
        provider_device_id=payload.provider_device_id,
        metadata=payload.metadata,
    )
    return SyncStagedArtifactSchema.model_validate(staged_artifact)


@router.post("/artifacts/files/resolve", response_model=SyncArtifactFileResolveResponse)
def sync_artifact_files_resolve(
    payload: SyncArtifactFileResolveRequest,
    session: Session = Depends(get_db),
) -> SyncArtifactFileResolveResponse:
    resolved_files = resolve_artifact_file_sources(session, payload)
    return SyncArtifactFileResolveResponse.model_validate(resolved_files)


@router.get("/artifacts/staging/{content_sha256}", response_model=SyncStagedArtifactSchema)
def sync_artifact_staging_detail(
    content_sha256: str,
    session: Session = Depends(get_db),
) -> SyncStagedArtifactSchema:
    staged_artifact = _require_staged_artifact(session, content_sha256=content_sha256)
    return SyncStagedArtifactSchema.model_validate(staged_artifact)


@router.post(
    "/projects/import",
    response_model=SyncProjectImportResponse,
    responses={409: {"model": ErrorResponse, "description": "Duplicate sync project source."}},
)
def sync_project_import(
    payload: SyncProjectStagedImportRequest,
    session: Session = Depends(get_db),
) -> SyncProjectImportResponse:
    from app.services.sync_manifest import import_staged_project_manifest

    import_kwargs: dict[str, Any] = {
        "manifest": payload.manifest.model_dump(mode="python"),
        "staging_root": payload.staging_root,
        "use_content_addressed_staging": payload.use_content_addressed_staging is True,
    }

    project = import_staged_project_manifest(session, **import_kwargs)
    session.commit()
    session.refresh(project)
    return SyncProjectImportResponse(project=ProjectSchema.model_validate(project))
