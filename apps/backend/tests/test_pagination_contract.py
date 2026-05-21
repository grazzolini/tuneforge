from __future__ import annotations

from typing import Any

from app.main import app

PAGINATION_FIELDS = {"total", "limit", "offset", "has_more"}
LIST_RESPONSE_CONTRACTS = {
    ("/api/v1/chord-backends", "get"): ("ChordBackendsResponse", "backends", True),
    ("/api/v1/stem-models", "get"): ("StemModelsResponse", "models", True),
    ("/api/v1/projects/{project_id}/sections", "get"): ("SongSectionsResponse", "sections", False),
    ("/api/v1/projects/{project_id}/artifacts", "get"): ("ArtifactsResponse", "artifacts", True),
    ("/api/v1/sync/trusted-peers", "get"): ("SyncTrustedPeersResponse", "trusted_peers", True),
}
PAGINATED_LIST_RESPONSE_CONTRACTS = {
    ("/api/v1/projects", "get"): ("ProjectsResponse", "projects"),
    ("/api/v1/jobs", "get"): ("JobsResponse", "jobs"),
}
PROJECT_CHILD_DOCUMENT_RESPONSE_CONTRACTS = {
    ("/api/v1/projects/{project_id}/analysis", "get"): "AnalysisResponse",
    ("/api/v1/projects/{project_id}/chords", "get"): "ChordResponse",
    ("/api/v1/projects/{project_id}/lyrics", "get"): "LyricsResponse",
    ("/api/v1/projects/{project_id}/lyrics", "put"): "LyricsResponse",
    ("/api/v1/projects/{project_id}/tabs/proposals", "post"): "TabImportResponse",
    ("/api/v1/projects/{project_id}/tabs/{tab_import_id}", "get"): "TabImportResponse",
    ("/api/v1/projects/{project_id}/tabs/{tab_import_id}/accept", "post"): "TabImportApplyResponse",
}
PROJECT_CHILD_DOCUMENT_ARRAY_FIELDS = {
    "AnalysisTimingSchema": ("beats", "bars"),
    "ChordResponse": ("source_segments", "timeline"),
    "LyricsResponse": ("source_segments", "segments"),
    "TabImportSchema": ("groups",),
    "TabSuggestionGroupSchema": ("suggestions",),
    "TabImportApplyResponse": ("sections", "accepted_suggestion_ids", "ignored_suggestion_ids"),
}
PROJECT_CHILD_DOCUMENT_REFS = {
    "AnalysisResponse": {"analysis": "AnalysisSchema"},
    "AnalysisSchema": {"timing": "AnalysisTimingSchema"},
    "TabImportResponse": {"tab_import": "TabImportSchema"},
    "TabImportApplyResponse": {
        "tab_import": "TabImportSchema",
        "lyrics": "LyricsResponse",
        "chords": "ChordResponse",
    },
}
UNPAGINATED_ROUTE_CONTRACTS = {
    ("/api/v1/chord-backends", "get"),
    ("/api/v1/stem-models", "get"),
    ("/api/v1/projects/{project_id}/sections", "get"),
    ("/api/v1/projects/{project_id}/artifacts", "get"),
    *PROJECT_CHILD_DOCUMENT_RESPONSE_CONTRACTS.keys(),
}


def _property_refs(property_schema: dict[str, Any]) -> set[str]:
    refs = {property_schema["$ref"]} if "$ref" in property_schema else set()
    refs.update(entry["$ref"] for entry in property_schema.get("anyOf", []) if "$ref" in entry)
    return refs


def _operation_query_parameter_names(openapi: dict[str, Any], path: str, method: str) -> set[str]:
    path_item = openapi["paths"][path]
    parameters = [*path_item.get("parameters", []), *path_item[method].get("parameters", [])]

    return {parameter["name"] for parameter in parameters if parameter["in"] == "query"}


def test_list_routes_keep_concrete_openapi_response_refs() -> None:
    openapi = app.openapi()

    response_contracts = {
        **LIST_RESPONSE_CONTRACTS,
        **{
            route: (schema_name, list_field, True)
            for route, (schema_name, list_field) in PAGINATED_LIST_RESPONSE_CONTRACTS.items()
        },
        **{
            route: (schema_name, "", True)
            for route, schema_name in PROJECT_CHILD_DOCUMENT_RESPONSE_CONTRACTS.items()
        },
    }
    for (path, method), (schema_name, _list_field, _field_required) in response_contracts.items():
        content = openapi["paths"][path][method]["responses"]["200"]["content"]
        response_schema = content["application/json"]["schema"]

        assert response_schema == {"$ref": f"#/components/schemas/{schema_name}"}


def test_existing_list_response_components_do_not_add_pagination_metadata() -> None:
    openapi = app.openapi()
    components = openapi["components"]["schemas"]

    for schema_name, list_field, field_required in LIST_RESPONSE_CONTRACTS.values():
        component_schema = components[schema_name]

        assert set(component_schema["properties"]) == {list_field}
        assert set(component_schema["properties"][list_field]) >= {"items", "type", "title"}
        assert component_schema["properties"][list_field]["type"] == "array"
        if field_required:
            assert component_schema["required"] == [list_field]
        else:
            assert "required" not in component_schema
        assert PAGINATION_FIELDS.isdisjoint(component_schema["properties"])


def test_paginated_list_response_components_include_pagination_metadata() -> None:
    openapi = app.openapi()
    components = openapi["components"]["schemas"]

    for schema_name, list_field in PAGINATED_LIST_RESPONSE_CONTRACTS.values():
        component_schema = components[schema_name]

        assert set(component_schema["properties"]) == {list_field, *PAGINATION_FIELDS}
        assert component_schema["properties"][list_field]["type"] == "array"
        assert set(component_schema["required"]) == {list_field, *PAGINATION_FIELDS}


def test_unpaginated_exception_routes_do_not_expose_pagination_query_params() -> None:
    openapi = app.openapi()

    for path, method in UNPAGINATED_ROUTE_CONTRACTS:
        query_parameter_names = _operation_query_parameter_names(openapi, path, method)

        assert {"limit", "offset"}.isdisjoint(query_parameter_names)


def test_project_child_document_arrays_remain_unpaginated_document_content() -> None:
    openapi = app.openapi()
    components = openapi["components"]["schemas"]

    for schema_name in set(PROJECT_CHILD_DOCUMENT_RESPONSE_CONTRACTS.values()):
        component_schema = components[schema_name]

        assert PAGINATION_FIELDS.isdisjoint(component_schema["properties"])

    for schema_name, array_fields in PROJECT_CHILD_DOCUMENT_ARRAY_FIELDS.items():
        component_schema = components[schema_name]

        assert PAGINATION_FIELDS.isdisjoint(component_schema["properties"])
        for array_field in array_fields:
            assert component_schema["properties"][array_field]["type"] == "array"

    for schema_name, field_refs in PROJECT_CHILD_DOCUMENT_REFS.items():
        component_schema = components[schema_name]

        for field_name, ref_schema_name in field_refs.items():
            assert f"#/components/schemas/{ref_schema_name}" in _property_refs(
                component_schema["properties"][field_name]
            )
