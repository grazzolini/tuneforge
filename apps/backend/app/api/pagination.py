from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, TypedDict

from fastapi import Depends, Query

DEFAULT_LIMIT = 50
MAX_LIMIT = 200
DEFAULT_OFFSET = 0


@dataclass(frozen=True, slots=True)
class PaginationParams:
    limit: int
    offset: int


class PaginationMetadata(TypedDict):
    total: int
    limit: int
    offset: int
    has_more: bool


def pagination_params(
    limit: int = Query(
        default=DEFAULT_LIMIT,
        ge=1,
        le=MAX_LIMIT,
        description="Maximum number of items to return.",
    ),
    offset: int = Query(
        default=DEFAULT_OFFSET,
        ge=0,
        description="Number of items to skip before returning results.",
    ),
) -> PaginationParams:
    return PaginationParams(limit=limit, offset=offset)


PaginationQuery = Annotated[PaginationParams, Depends(pagination_params)]


def pagination_metadata(
    *,
    total: int,
    limit: int,
    offset: int,
    number_of_returned_items: int,
) -> PaginationMetadata:
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + number_of_returned_items < total,
    }
