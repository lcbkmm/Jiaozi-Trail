from __future__ import annotations
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from uuid import uuid4
import httpx
from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from app.config import Settings
from app.errors import AppError
from app.maps.baidu import BaiduMaps
from app.maps.nearby import NearbyPlaceRepository
from app.maps.segments import SegmentRepository
from app.planner.search import CST, search_routes
from app.schemas import CampaignStop, FavoriteUpdate, Place, Point, Preferences, SessionCreate, StartRoute, ToolCall
from app.storage.database import Database
from app.tools import BusinessTools
from app.intent.gateway import ModelGateway
from app.intent.resolver import IntentResolver
from app.intent.schemas import ChatRequest
from app.dynamic.repository import DynamicRepository
from app.dynamic.service import DynamicPlanning
from app.dynamic.schemas import PositionUpdate, StateEvent, ProgressUpdate, ReplanRequest, AcceptProposal


def create_app(settings: Settings | None = None):
    settings = settings or Settings.load()
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    @asynccontextmanager
    async def lifespan(app):
        database = Database(settings.database_path)
        if settings.places_path.exists():
            database.seed_places([Place.model_validate(p) for p in json.loads(settings.places_path.read_text(encoding="utf-8"))])
        campaign = json.loads(settings.campaign_path.read_text(encoding="utf-8"))
        app.state.stops = [CampaignStop.model_validate(s) for s in campaign["stops"]]
        app.state.database = database
        app.state.nearby = NearbyPlaceRepository(database, settings.nearby_provider)
        async with httpx.AsyncClient(base_url=settings.maps_base_url, follow_redirects=False,
                timeout=httpx.Timeout(15, connect=5, pool=20),
                limits=httpx.Limits(max_connections=4, max_keepalive_connections=2, keepalive_expiry=30)) as client:
            maps = BaiduMaps(client, settings.baidu_ak)
            app.state.maps = maps
            app.state.segments = SegmentRepository(database, maps, settings.maps_mode)
            app.state.tools = BusinessTools(database, app.state.stops, app.state.segments, app.state.nearby, settings.campaign_path)
            app.state.dynamic_repository = DynamicRepository(database)
            app.state.tools.dynamic = app.state.dynamic_repository
            app.state.dynamic_planning = DynamicPlanning(database,app.state.dynamic_repository,app.state.tools)
            app.state.tools.dynamic_planning = app.state.dynamic_planning
            app.state.gateway = ModelGateway(settings)
            app.state.intent = IntentResolver(database, app.state.tools, app.state.gateway)
            try:
                yield
            finally:
                app.state.gateway.close()

    app = FastAPI(title="Jiaozi Trail 模块 A", version="0.3.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                       allow_methods=["GET", "POST", "PUT"], allow_headers=["Content-Type", "X-Demo-Session", "Idempotency-Key"])

    @app.middleware("http")
    async def identify(request: Request, call_next):
        request.state.request_id = "req_" + uuid4().hex
        try:
            response = await call_next(request)
        except Exception as error:
            logging.getLogger("jiaozi").error("Request failed: %s (%s)", type(error).__name__, request.state.request_id)
            response = JSONResponse(status_code=500, content={"error": {"code": "INTERNAL_ERROR", "message": "服务内部错误，请凭请求编号检查。"},
                "meta": {"request_id": request.state.request_id, "mode": "demo"}})
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    def envelope(request, data):
        return {"data": data, "meta": {"request_id": request.state.request_id, "mode": "demo"}}

    @app.exception_handler(AppError)
    async def business_error(request, error):
        return JSONResponse(status_code=error.status, content={"error": {"code": error.code, "message": error.message, "details": error.details},
            "meta": {"request_id": request.state.request_id, "mode": "demo"}})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse(status_code=422, content={"error": {"code": "INVALID_INPUT", "message": "输入字段不符合要求。",
            "details": {"fields": [{"location": list(e["loc"]), "message": e["msg"], "type": e["type"]} for e in error.errors()]}},
            "meta": {"request_id": request.state.request_id, "mode": "demo"}})

    def session(request: Request, x_demo_session: str | None = Header(default=None)):
        if not x_demo_session:
            raise AppError("SESSION_REQUIRED", "请先创建演示会话。", 401)
        return request.app.state.database.session(x_demo_session)

    @app.get("/", include_in_schema=False)
    def home():
        return FileResponse(Path(__file__).parent / "static/index.html")

    @app.get("/health")
    def health(request: Request):
        return {"status": "ok", "stage": "phase2b", "places_count": len(request.app.state.database.places()),
                "walking_segments_cached": request.app.state.database.segment_count(),
                "maps_mode": settings.maps_mode, "nearby_provider": "sqlite", "llm_connected": request.app.state.gateway.extraction_verified}

    @app.post("/api/v1/demo/sessions", status_code=201)
    def create_session(body: SessionCreate, request: Request):
        when = body.business_now or datetime(2026, 10, 31, 14, 0, tzinfo=CST)
        data = request.app.state.database.create_session(body.campaign_id, when.astimezone(CST).isoformat())
        return envelope(request, data)

    @app.get("/api/v1/places")
    def places(request: Request, current=Depends(session), longitude: float | None = Query(default=None, ge=-180, le=180),
               latitude: float | None = Query(default=None, ge=-85, le=85), radius_m: int = Query(default=2000, ge=1, le=10000),
               category: str | None = Query(default=None, max_length=32)):
        if (longitude is None) != (latitude is None):
            raise AppError("INVALID_INPUT", "经度和纬度必须同时提供。")
        if longitude is not None:
            data = request.app.state.nearby.find(Point(longitude=longitude, latitude=latitude), radius_m, category)
        else:
            data = [p.model_dump(mode="json") for p in request.app.state.database.places() if not category or p.category == category]
        return envelope(request, data)

    @app.post("/api/v1/routes", status_code=201)
    async def create_route(body: Preferences, request: Request, current=Depends(session)):
        plan = await request.app.state.tools.plan(body, token=current["token"])
        return envelope(request, request.app.state.database.save_route(current["token"], plan))

    @app.post("/api/v1/route-options")
    async def route_options(body: Preferences, request: Request, current=Depends(session)):
        return envelope(request, await request.app.state.tools.plan(body, include_options=True, token=current["token"]))

    @app.get("/api/v1/places/{place_id}")
    def place_details(place_id: str, request: Request, current=Depends(session)):
        return envelope(request, request.app.state.tools.place_details(place_id, current["token"]))

    @app.get("/api/v1/tools")
    def tool_specs(request: Request, current=Depends(session)):
        return envelope(request, {"tools": BusinessTools.specifications(), "agent_connected": request.app.state.gateway.extraction_verified})

    @app.post("/api/v1/tools/call")
    async def call_tool(body: ToolCall, request: Request, current=Depends(session)):
        return envelope(request, await request.app.state.tools.call(body.name, body.arguments, token=current["token"]))

    @app.put('/api/v1/position')
    def set_position(body: PositionUpdate,request:Request,current=Depends(session)):
        snapshot=request.app.state.dynamic_planning.update_position(current['token'],body)
        return envelope(request,{'position':snapshot['position'],'position_revision':snapshot['position_revision']})

    @app.get('/api/v1/dynamic-state')
    def dynamic_state(request:Request,current=Depends(session)):
        return envelope(request,request.app.state.dynamic_planning.states(current['token']))

    @app.post('/api/v1/demo/events')
    def state_event(body:StateEvent,request:Request,current=Depends(session)):
        return envelope(request,request.app.state.dynamic_planning.event(current['token'],body))

    @app.post('/api/v1/routes/{route_id}/progress')
    def route_progress(route_id:str,body:ProgressUpdate,request:Request,current=Depends(session)):
        return envelope(request,request.app.state.dynamic_planning.progress(current['token'],route_id,body))

    @app.get('/api/v1/routes/{route_id}/assessment')
    def assess_route(route_id:str,request:Request,current=Depends(session)):
        return envelope(request,request.app.state.dynamic_planning.assess(current['token'],route_id))

    @app.post('/api/v1/routes/{route_id}/replan')
    async def replan_route(route_id:str,body:ReplanRequest,request:Request,current=Depends(session)):
        return envelope(request,await request.app.state.dynamic_planning.replan(current['token'],route_id,body))

    @app.post('/api/v1/routes/{route_id}/accept')
    def accept_route(route_id:str,body:AcceptProposal,request:Request,current=Depends(session)):
        return envelope(request,request.app.state.dynamic_repository.accept(current['token'],route_id,body))

    @app.get("/api/v1/model-status")
    def model_status(request: Request, current=Depends(session)):
        return envelope(request, request.app.state.gateway.status())

    @app.get("/api/v1/chat")
    def chat_history(request: Request, current=Depends(session)):
        return envelope(request, request.app.state.database.conversation(current["token"]))

    @app.post("/api/v1/chat")
    @app.post("/api/v1/intents/resolve")
    async def chat(body: ChatRequest, request: Request, current=Depends(session)):
        return envelope(request, await request.app.state.intent.handle(current["token"], body))

    @app.get("/api/v1/routes")
    def list_routes(request: Request, favorite: bool = False, current=Depends(session)):
        return envelope(request, request.app.state.database.routes(current["token"], favorite))

    @app.get("/api/v1/routes/{route_id}")
    def read_route(route_id: str, request: Request, current=Depends(session)):
        return envelope(request, request.app.state.database.route(current["token"], route_id))

    @app.put("/api/v1/routes/{route_id}/favorite")
    def favorite(route_id: str, body: FavoriteUpdate, request: Request, current=Depends(session)):
        return envelope(request, request.app.state.database.favorite(current["token"], route_id, body.favorite))

    @app.post("/api/v1/routes/{route_id}/start")
    def start(route_id: str, body: StartRoute, request: Request, current=Depends(session)):
        return envelope(request, request.app.state.database.start(current["token"], route_id, body.base_revision))

    return app


app = create_app()
