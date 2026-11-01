from __future__ import annotations
import math
from datetime import datetime
from typing import Literal, Annotated
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Tag = Annotated[str, Field(min_length=1, max_length=48, pattern=r"^[a-z][a-z0-9_]*$")]


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Point(Schema):
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-85, le=85)


class Place(Point):
    place_id: str
    name: str
    aliases: list[str] = Field(default_factory=list, max_length=20)
    address: str
    uid: str
    category: str
    coord_system: Literal["gcj02"] = "gcj02"
    location_source: Literal["baidu_place_v3", "partner_catalog", "user_location"] = "baidu_place_v3"
    retrieved_at: datetime
    entrance_reviewed: bool = False
    entrance_version: int = 1


class TimeWindow(Schema):
    opens: str
    closes: str

    @model_validator(mode="after")
    def validate_window(self):
        from datetime import time
        start, end = time.fromisoformat(self.opens), time.fromisoformat(self.closes)
        if start >= end:
            raise ValueError("Each daily window must end after it opens")
        return self


class Benefit(Schema):
    title: str
    conditions: str
    inventory_status: Literal["available", "unknown", "sold_out"] = "unknown"
    is_demo: bool = True


class CampaignStop(Schema):
    stop_id: str
    place_id: str
    title: str
    category: str
    interests: list[Tag]
    dwell_s: int = Field(gt=0)
    cost_min_fen: int = Field(ge=0)
    cost_max_fen: int = Field(ge=0)
    windows: list[TimeWindow]
    queue_s: int = Field(ge=0, default=0)
    status: Literal["open", "closed"] = "open"
    benefits: list[Benefit] = Field(default_factory=list)
    source: Literal["demo"] = "demo"
    experience_labels: dict[Tag, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def cost_order(self):
        if self.cost_max_fen < self.cost_min_fen:
            raise ValueError("Invalid cost range")
        return self


class VisitGoal(Schema):
    any_of: list[Tag] = Field(default_factory=list, max_length=8)
    place_ids: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(default_factory=list, max_length=5)

    @model_validator(mode="after")
    def nonempty(self):
        if not self.any_of and not self.place_ids:
            raise ValueError("A goal requires experiences or place IDs")
        if len(set(self.any_of))!=len(self.any_of) or len(set(self.place_ids))!=len(self.place_ids):
            raise ValueError("Goal alternatives must be unique")
        return self


class Preferences(Schema):
    campaign_id: Literal["chunxi_demo_2026"] = "chunxi_demo_2026"
    start_place_id: str = Field(min_length=1, max_length=100)
    end_place_id: str | None = Field(default=None, max_length=100)
    departure_at: datetime
    max_duration_s: int = Field(ge=900, le=43200)
    budget_per_person_fen: int = Field(ge=0, le=1000000)
    buffer_s: int = Field(default=600, ge=0, le=3600)
    interests: list[Tag] = Field(default_factory=list, max_length=10)
    required_experiences: list[Tag] = Field(default_factory=list, max_length=10)
    required_goals: list[VisitGoal] = Field(default_factory=list, max_length=8)
    visit_sequence: list[VisitGoal] = Field(default_factory=list, max_length=5)
    visit_mode: Literal["flexible", "focused"] = "flexible"
    category_limits: dict[Tag, Annotated[int, Field(strict=True, ge=0, le=5)]] = Field(default_factory=lambda: {"meal":1,"drink":1})
    must_visit_ids: list[str] = Field(default_factory=list, max_length=5)
    excluded_place_ids: list[str] = Field(default_factory=list, max_length=20)
    max_walk_m: int = Field(default=4000, ge=0, le=15000)
    max_queue_s: int = Field(default=1200, ge=0, le=10800)
    planning_style: Literal["balanced", "less_walking", "more_experiences"] = "balanced"
    excluded_interests: list[Tag] = Field(default_factory=list, max_length=10)
    use_current_position: bool = False

    @field_validator("departure_at")
    @classmethod
    def timezone_required(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("departure_at must include a timezone")
        return value

    @model_validator(mode="after")
    def unique_requirements(self):
        for goal in self.required_goals + self.visit_sequence:
            if goal.any_of and not goal.place_ids and set(goal.any_of) <= set(self.excluded_interests):
                raise ValueError("All alternatives of a goal are excluded")
            if goal.place_ids and not goal.any_of and set(goal.place_ids) <= set(self.excluded_place_ids):
                raise ValueError("All places of a goal are excluded")
        if len(set(self.required_experiences)) != len(self.required_experiences):
            raise ValueError("required_experiences must be unique")
        if set(self.required_experiences) & set(self.excluded_interests):
            raise ValueError("A required experience cannot also be excluded")
        if len(set(self.must_visit_ids)) != len(self.must_visit_ids):
            raise ValueError("must_visit_ids must be unique")
        if set(self.must_visit_ids) & set(self.excluded_place_ids):
            raise ValueError("A required place cannot also be excluded")
        return self


class WalkingLeg(Schema):
    from_place_id: str
    to_place_id: str
    distance_m: int = Field(ge=0)
    duration_s: int = Field(ge=0)
    points: list[Point]
    coord_system: Literal["gcj02"] = "gcj02"
    source: Literal["baidu_walking", "same_location"] = "baidu_walking"
    retrieved_at: datetime
    delivery: Literal["live", "cached"] = "live"
    entrance_version: str


class SessionCreate(Schema):
    campaign_id: Literal["chunxi_demo_2026"] = "chunxi_demo_2026"
    clock_mode: Literal["demo"] = "demo"
    business_now: datetime | None = None

    @field_validator("business_now")
    @classmethod
    def timezone_required(cls, value):
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("business_now must include a timezone")
        return value


class FavoriteUpdate(Schema):
    favorite: bool


class StartRoute(Schema):
    base_revision: int = Field(ge=1)


class PlaceDetailsArguments(Schema):
    place_id: str = Field(min_length=1, max_length=100)


class NearbyArguments(Point):
    radius_m: int = Field(default=1500, ge=1, le=10000)
    category: str | None = Field(default=None, max_length=32)
    interest: Tag | None = None
    limit: int = Field(default=20, ge=1, le=100)


class ToolCall(Schema):
    name: Literal["get_place_details", "search_nearby_places", "plan_route_options"]
    arguments: dict
