from __future__ import annotations
import json
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from app.errors import AppError
from app.schemas import Place


class Database:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY, participant_id TEXT NOT NULL,
                campaign_id TEXT NOT NULL, business_now TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS places (
                place_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS segments (
                cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS conversations (
                token TEXT PRIMARY KEY REFERENCES sessions(token), revision INTEGER NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS routes (
                route_id TEXT PRIMARY KEY, token TEXT NOT NULL REFERENCES sessions(token),
                revision INTEGER NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS route_revisions (
                route_id TEXT NOT NULL REFERENCES routes(route_id), revision INTEGER NOT NULL,
                payload TEXT NOT NULL, PRIMARY KEY(route_id, revision));
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def create_session(self, campaign_id, business_now):
        token, participant = secrets.token_urlsafe(32), "demo_" + uuid4().hex[:16]
        with self.connection() as db:
            db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)",
                       (token, participant, campaign_id, business_now))
        return {"session_token": token, "participant_id": participant,
                "campaign_id": campaign_id, "clock_mode": "demo", "business_now": business_now}

    def session(self, token):
        with self.connection() as db:
            row = db.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
        if row is None:
            raise AppError("SESSION_REQUIRED", "请先创建演示会话。", 401)
        return dict(row)

    def seed_places(self, places):
        with self.connection() as db:
            for place in places:
                db.execute("INSERT INTO places VALUES (?, ?) ON CONFLICT(place_id) DO UPDATE SET payload=excluded.payload",
                           (place.place_id, place.model_dump_json()))

    def places(self):
        with self.connection() as db:
            rows = db.execute("SELECT payload FROM places ORDER BY place_id").fetchall()
        return [Place.model_validate_json(row[0]) for row in rows]

    def segment(self, key):
        with self.connection() as db:
            row = db.execute("SELECT payload FROM segments WHERE cache_key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_segment(self, key, leg):
        with self.connection() as db:
            db.execute("INSERT INTO segments VALUES (?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload",
                       (key, leg.model_dump_json()))

    def segment_count(self):
        with self.connection() as db:
            return db.execute("SELECT COUNT(*) FROM segments").fetchone()[0]

    def save_route(self, token, plan):
        self.session(token)
        route_id = "route_" + uuid4().hex
        route = {**plan, "route_id": route_id, "revision": 1, "status": "planned",
                 "is_favorite": False, "state_version": plan.get("state_version", 1),
                 "created_at": datetime.now(timezone.utc).isoformat()}
        payload = json.dumps(route, ensure_ascii=False)
        with self.connection() as db:
            db.execute("INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?)",
                       (route_id, token, 1, 0, route["created_at"], payload))
            db.execute("INSERT INTO route_revisions VALUES (?, ?, ?)", (route_id, 1, payload))
        return route

    def route(self, token, route_id):
        with self.connection() as db:
            row = db.execute("SELECT payload, favorite FROM routes WHERE route_id=? AND token=?",
                             (route_id, token)).fetchone()
        if row is None:
            raise AppError("RESOURCE_NOT_FOUND", "路线不存在或不属于当前会话。", 404)
        return {**json.loads(row[0]), "is_favorite": bool(row[1])}

    def routes(self, token, favorite=False):
        with self.connection() as db:
            rows = db.execute("SELECT payload, favorite FROM routes WHERE token=? AND (?=0 OR favorite=1) ORDER BY created_at DESC",
                              (token, int(favorite))).fetchall()
        return [{**json.loads(row[0]), "is_favorite": bool(row[1])} for row in rows]

    def favorite(self, token, route_id, value):
        self.route(token, route_id)
        with self.connection() as db:
            db.execute("UPDATE routes SET favorite=? WHERE route_id=? AND token=?", (int(value), route_id, token))
        return self.route(token, route_id)

    def start(self, token, route_id, base_revision):
        route = self.route(token, route_id)
        if route["status"] == "active":
            return route
        if route["revision"] != base_revision:
            raise AppError("STALE_REVISION", "路线版本已变化，请重新读取。", 409)
        route.update(status="active", revision=base_revision + 1)
        payload = json.dumps(route, ensure_ascii=False)
        with self.connection() as db:
            changed = db.execute("UPDATE routes SET revision=?, payload=? WHERE route_id=? AND token=? AND revision=?",
                                 (route["revision"], payload, route_id, token, base_revision)).rowcount
            if changed != 1:
                raise AppError("STALE_REVISION", "路线版本已变化，请重新读取。", 409)
            db.execute("INSERT INTO route_revisions VALUES (?, ?, ?)", (route_id, route["revision"], payload))
        return self.route(token, route_id)

    def conversation(self, token):
        self.session(token)
        with self.connection() as db:
            row = db.execute("SELECT revision, payload FROM conversations WHERE token=?", (token,)).fetchone()
        return {"revision":row[0], **json.loads(row[1])} if row else {"revision":0, "preferences":None, "history":[]}

    def save_conversation(self, token, expected_revision, preferences, history):
        payload = json.dumps({"preferences":preferences, "history":history[-8:]}, ensure_ascii=False)
        with self.connection() as db:
            if expected_revision == 0:
                changed = db.execute("INSERT OR IGNORE INTO conversations VALUES (?, 1, ?)", (token,payload)).rowcount
            else:
                changed = db.execute("UPDATE conversations SET revision=revision+1,payload=? WHERE token=? AND revision=?",
                                     (payload,token,expected_revision)).rowcount
            if changed != 1:
                raise AppError("STALE_CONTEXT", "对话上下文已变化，请读取最新对话后重试。", 409)
        return expected_revision+1
