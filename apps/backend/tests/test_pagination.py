from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.pagination import (
    DEFAULT_LIMIT,
    DEFAULT_OFFSET,
    MAX_LIMIT,
    PaginationQuery,
    pagination_metadata,
)


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()

    @app.get("/items")
    def items(pagination: PaginationQuery) -> dict[str, int]:
        return {"limit": pagination.limit, "offset": pagination.offset}

    return TestClient(app)


def test_pagination_params_use_defaults(client: TestClient) -> None:
    response = client.get("/items")

    assert response.status_code == 200
    assert response.json() == {"limit": DEFAULT_LIMIT, "offset": DEFAULT_OFFSET}


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ({"limit": "1", "offset": "0"}, {"limit": 1, "offset": 0}),
        ({"limit": str(MAX_LIMIT), "offset": "25"}, {"limit": MAX_LIMIT, "offset": 25}),
    ],
)
def test_pagination_params_accept_bounds(
    client: TestClient,
    query: dict[str, str],
    expected: dict[str, int],
) -> None:
    response = client.get("/items", params=query)

    assert response.status_code == 200
    assert response.json() == expected


@pytest.mark.parametrize(
    "query",
    [
        {"limit": "0"},
        {"limit": str(MAX_LIMIT + 1)},
        {"offset": "-1"},
    ],
)
def test_pagination_params_reject_invalid_bounds(client: TestClient, query: dict[str, str]) -> None:
    response = client.get("/items", params=query)

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("total", "limit", "offset", "number_of_returned_items", "has_more"),
    [
        (10, 5, 0, 5, True),
        (10, 5, 5, 5, False),
        (10, 5, 8, 2, False),
        (3, 50, 0, 3, False),
    ],
)
def test_pagination_metadata_sets_has_more(
    total: int,
    limit: int,
    offset: int,
    number_of_returned_items: int,
    has_more: bool,
) -> None:
    assert pagination_metadata(
        total=total,
        limit=limit,
        offset=offset,
        number_of_returned_items=number_of_returned_items,
    ) == {
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": has_more,
    }
