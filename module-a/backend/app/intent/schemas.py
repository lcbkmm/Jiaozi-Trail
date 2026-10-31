from __future__ import annotations
from typing import Literal
from datetime import datetime
from pydantic import Field, model_validator
from app.schemas import Schema, Preferences

INTERESTS = {"coffee", "tea", "food", "hotpot", "landmark", "launch", "culture", "lifestyle", "photo", "local"}
OperationName = Literal["update_preferences", "require_place", "exclude_place", "replace_place", "insert_place", "get_place_details", "search_nearby_places", "plan_routes", "add_memory"]


class PreferencePatch(Schema):
    budget_per_person_fen: int | None = Field(default=None, strict=True, ge=0, le=1000000)
    max_duration_s: int | None = Field(default=None, strict=True, ge=900, le=43200)
    max_walk_m: int | None = Field(default=None, strict=True, ge=0, le=15000)
    max_queue_s: int | None = Field(default=None, strict=True, ge=0, le=10800)
    interests: list[str] | None = Field(default=None, max_length=10)
    excluded_interests: list[str] | None = Field(default=None, max_length=10)
    planning_style: Literal["balanced", "less_walking", "more_experiences"] | None = None

    @model_validator(mode="after")
    def known_tags(self):
        for values in (self.interests, self.excluded_interests):
            if values is not None and (set(values)-INTERESTS):
                raise ValueError("Unknown interest tags")
        return self


class Operation(Schema):
    type: OperationName
    evidence: str = Field(min_length=1, max_length=1000)
    duration_scope: Literal["total","remaining"] = "total"
    patch: PreferencePatch | None = None
    place_query: str | None = Field(default=None, max_length=100)
    replacement_query: str | None = Field(default=None, max_length=100)
    target_interest: str | None = None
    radius_m: int | None = Field(default=None, strict=True, ge=1, le=5000)
    category: Literal["coffee", "tea", "meal", "landmark", "culture", "lifestyle"] | None = None

    @model_validator(mode="after")
    def operation_fields(self):
        if self.type == "update_preferences":
            if self.patch is None or not self.patch.model_dump(exclude_none=True):
                raise ValueError("An update requires a nonempty patch")
        elif self.patch is not None:
            raise ValueError("Only update_preferences accepts patch")
        if self.target_interest is not None and self.target_interest not in INTERESTS:
            raise ValueError("Unknown target interest")
        return self


class ParsedTurn(Schema):
    operations: list[Operation] = Field(default_factory=list, max_length=6)
    clarification: str | None = Field(default=None, max_length=240)
    ambiguity_candidates: list[Literal["add_memory", "insert_place", "get_place_details"]] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def meaningful(self):
        if not self.operations and not self.clarification:
            raise ValueError("Empty interpretation")
        if self.ambiguity_candidates and (len(set(self.ambiguity_candidates)) < 2 or not self.clarification):
            raise ValueError("Ambiguity requires distinct candidates and a clarification")
        return self


class ChatRequest(Schema):
    text: str = Field(min_length=1, max_length=1000)
    current_preferences: Preferences | None = None
    selected_place_id: str | None = Field(default=None, max_length=100)
    route_id: str | None = Field(default=None, max_length=100)
    base_revision: int | None = Field(default=None, ge=1)
    context_revision: int | None = Field(default=None, ge=0)
    effective_at: datetime | None = None
    replan_origin: Literal["current_position","last_completed"] = "current_position"

    @model_validator(mode="after")
    def not_blank(self):
        if not self.text.strip():
            raise ValueError("Message cannot be blank")
        if self.effective_at is not None and (self.effective_at.tzinfo is None or self.effective_at.utcoffset() is None):
            raise ValueError("effective_at requires timezone")
        if self.base_revision is not None and not self.route_id:
            raise ValueError("base_revision requires route_id")
        return self
