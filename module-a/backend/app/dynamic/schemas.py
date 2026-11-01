from datetime import datetime
from typing import Literal
from pydantic import Field, field_validator, model_validator
from app.schemas import Schema, Point, Preferences


class PositionUpdate(Point):
    coord_system: Literal["gcj02"] = "gcj02"
    accuracy_m: float = Field(ge=0, le=10000)
    observed_at: datetime
    source: Literal["device", "manual", "demo"]
    confirmed: bool = False

    @field_validator("observed_at")
    @classmethod
    def timezone_required(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Timezone required")
        return value


class StateEvent(Schema):
    place_id: str = Field(min_length=1,max_length=100)
    base_state_version: int = Field(ge=1)
    queue_s: int | None = Field(default=None,strict=True,ge=0,le=14400)
    status: Literal["open","closed"] | None = None
    inventory_status: Literal["available","unknown","sold_out"] | None = None
    source: Literal["demo"] = "demo"

    @model_validator(mode="after")
    def nonempty(self):
        if all(getattr(self,k) is None for k in ("queue_s","status","inventory_status")):
            raise ValueError("At least one changed state is required")
        return self


class ProgressUpdate(Schema):
    base_revision: int = Field(ge=1)
    completed_place_ids: list[str] = Field(max_length=5)
    effective_at: datetime
    spent_per_person_fen: int | None = Field(default=None,strict=True,ge=0,le=1000000)
    actual_walk_m: int | None = Field(default=None,strict=True,ge=0,le=100000)
    source: Literal["self_reported","demo"] = "demo"

    @field_validator("effective_at")
    @classmethod
    def timezone_required(cls,value):
        if value.tzinfo is None or value.utcoffset() is None:raise ValueError("Timezone required")
        return value


class ReplanRequest(Schema):
    base_revision: int = Field(ge=1)
    effective_at: datetime
    origin: Literal["current_position","last_completed","planned_start"] = "current_position"
    preference_patch: dict = Field(default_factory=dict)
    reason: str = Field(default="user_request",max_length=200)

    @field_validator("effective_at")
    @classmethod
    def timezone_required(cls,value):
        if value.tzinfo is None or value.utcoffset() is None:raise ValueError("Timezone required")
        return value


class AcceptProposal(Schema):
    base_revision: int = Field(ge=1)
    proposal_id: str = Field(min_length=1,max_length=100)
