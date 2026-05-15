from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.dependencies import get_db
from app.schemas import (
    ErrorResponse,
    ProjectSchema,
    SyncLocalIdentityResponse,
    SyncLocalIdentitySchema,
    SyncLocalIdentityUpdateRequest,
    SyncMetadataResponse,
    SyncPairingOfferRequest,
    SyncPairingOfferResponse,
    SyncPairingOfferSchema,
    SyncPreflightResponse,
    SyncProjectImportResponse,
    SyncProjectManifestResponse,
    SyncProjectStagedImportRequest,
    SyncTrustedPeerCreateRequest,
    SyncTrustedPeerResponse,
    SyncTrustedPeerSchema,
    SyncTrustedPeersResponse,
)
from app.services.sync_identity import run_sync_preflight
from app.services.sync_metadata import get_sync_metadata
from app.services.sync_trust import (
    create_pairing_offer,
    get_or_create_local_identity,
    list_trusted_peers,
    revoke_trusted_peer,
    trust_peer_from_pairing_payload,
    update_local_identity_display_name,
)

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/preflight", response_model=SyncPreflightResponse)
def sync_preflight(session: Session = Depends(get_db)) -> SyncPreflightResponse:
    return SyncPreflightResponse.model_validate(run_sync_preflight(session))


@router.get("/metadata", response_model=SyncMetadataResponse)
def sync_metadata(session: Session = Depends(get_db)) -> SyncMetadataResponse:
    return SyncMetadataResponse.model_validate(get_sync_metadata(session))


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


@router.get("/projects/{project_id}/manifest", response_model=SyncProjectManifestResponse)
def sync_project_manifest(
    project_id: str,
    session: Session = Depends(get_db),
) -> SyncProjectManifestResponse:
    from app.services.sync_manifest import export_project_manifest

    project_manifest = export_project_manifest(session, project_id=project_id)
    return SyncProjectManifestResponse.model_validate({"project_manifest": project_manifest})


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

    project = import_staged_project_manifest(
        session,
        manifest=payload.manifest.model_dump(mode="python"),
        staging_root=payload.staging_root,
    )
    session.commit()
    session.refresh(project)
    return SyncProjectImportResponse(project=ProjectSchema.model_validate(project))
