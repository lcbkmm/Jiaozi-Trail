from __future__ import annotations
import os
from dataclasses import dataclass, field
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[2]


def local_values() -> dict[str, str]:
    path = MODULE_ROOT / ".env.local"
    values = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                name, value = line.split("=", 1)
                values[name.strip()] = value.strip().strip("\"'")
    return values


@dataclass(frozen=True)
class Settings:
    database_path: Path = MODULE_ROOT / "runtime/jiaozi-trail.sqlite3"
    places_path: Path = MODULE_ROOT / "runtime/places.json"
    campaign_path: Path = MODULE_ROOT / "data/campaign.json"
    baidu_ak: str = field(default="", repr=False)
    maps_mode: str = "prepared"
    nearby_provider: str = "sqlite"
    maps_base_url: str = "https://api.map.baidu.com"
    llm_base_url: str = "https://api.openai-next.com/v1"
    llm_model: str = "deepseek-v4-1-flash-261017"
    llm_api_key: str = field(default="", repr=False)
    llm_thinking_profile: str = "deepseek_disabled"
    llm_top_logprobs: int = 5
    jev_enabled: bool = False

    @classmethod
    def load(cls):
        values = {**local_values(), **os.environ}
        db_path = Path(values.get("DATABASE_PATH", "runtime/jiaozi-trail.sqlite3"))
        if not db_path.is_absolute():
            db_path = MODULE_ROOT / db_path
        places_path=Path(values.get("PLACES_PATH",str(MODULE_ROOT / "runtime/places.json")))
        campaign_path=Path(values.get("CAMPAIGN_PATH",str(MODULE_ROOT / "data/campaign.json")))
        if not places_path.is_absolute():places_path=MODULE_ROOT / places_path
        if not campaign_path.is_absolute():campaign_path=MODULE_ROOT / campaign_path
        return cls(database_path=db_path,places_path=places_path,campaign_path=campaign_path,
                   baidu_ak=values.get("BAIDU_SERVER_AK", ""),
                   maps_mode=values.get("MAPS_MODE", "prepared"),
                   nearby_provider=values.get("NEARBY_PROVIDER", "sqlite"),
                   llm_base_url=values.get("LLM_BASE_URL", "https://api.openai-next.com/v1"),
                   llm_model=values.get("LLM_MODEL", "deepseek-v4-1-flash-261017"),
                   llm_api_key=values.get("LLM_API_KEY", ""),
                   llm_thinking_profile=values.get("LLM_THINKING_PROFILE", "deepseek_disabled"),
                   llm_top_logprobs=int(values.get("LLM_TOP_LOGPROBS", "5")),
                   jev_enabled=values.get("JEV_ENABLED", "false").lower() == "true")
