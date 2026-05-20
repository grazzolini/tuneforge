from __future__ import annotations

from app.main import app

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


def test_list_routes_keep_concrete_openapi_response_refs() -> None:
    openapi = app.openapi()

    response_contracts = {
        **LIST_RESPONSE_CONTRACTS,
        **{
            route: (schema_name, list_field, True)
            for route, (schema_name, list_field) in PAGINATED_LIST_RESPONSE_CONTRACTS.items()
        },
    }
    for (path, method), (schema_name, _list_field, _field_required) in response_contracts.items():
        response_schema = openapi["paths"][path][method]["responses"]["200"]["content"]["application/json"]["schema"]

        assert response_schema == {"$ref": f"#/components/schemas/{schema_name}"}


def test_existing_list_response_components_do_not_add_pagination_metadata() -> None:
    openapi = app.openapi()
    components = openapi["components"]["schemas"]
    pagination_fields = {"total", "limit", "offset", "has_more"}

    for schema_name, list_field, field_required in LIST_RESPONSE_CONTRACTS.values():
        component_schema = components[schema_name]

        assert set(component_schema["properties"]) == {list_field}
        assert set(component_schema["properties"][list_field]) >= {"items", "type", "title"}
        assert component_schema["properties"][list_field]["type"] == "array"
        if field_required:
            assert component_schema["required"] == [list_field]
        else:
            assert "required" not in component_schema
        assert pagination_fields.isdisjoint(component_schema["properties"])


def test_paginated_list_response_components_include_pagination_metadata() -> None:
    openapi = app.openapi()
    components = openapi["components"]["schemas"]
    pagination_fields = {"total", "limit", "offset", "has_more"}

    for schema_name, list_field in PAGINATED_LIST_RESPONSE_CONTRACTS.values():
        component_schema = components[schema_name]

        assert set(component_schema["properties"]) == {list_field, *pagination_fields}
        assert component_schema["properties"][list_field]["type"] == "array"
        assert set(component_schema["required"]) == {list_field, *pagination_fields}
