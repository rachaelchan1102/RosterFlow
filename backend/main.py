"""FastAPI backend: wraps the optimizer package behind HTTP endpoints.

Every request runs against a workspace (backend/workspace.py), picked by backend/registry.py:
a per-visitor playground (synthetic data, gone on refresh) unless the request carries a valid
coordinator login, in which case it's the shared Postgres-backed workspace.

Configuration (environment variables):
  NEON_DSN              Postgres connection string for the coordinator workspace
  COORDINATOR_PASSWORD  the shared coordinator password
Without both, only the playground is available.
"""
import os
import threading
from collections.abc import Generator
from datetime import date
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import Body, Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend import views
from backend.registry import NotConfiguredError, Registry
from backend.workspace import Workspace, WorkspaceError
from optimizer.data import (RecordConflictError, add_musician, add_show, delete_musician, delete_show,
                            set_weekly_availability, update_musician, update_show)
from optimizer.simulate import (DEFAULT_CANCEL_P, estimate_new_show_feasibility, simulate_fill_rate,
                                suggest_alternative_dates)

SAMPLE_DATA_DIR = Path(__file__).resolve().parent.parent / "sample_data"

registry = Registry(SAMPLE_DATA_DIR, dsn=os.environ.get("NEON_DSN"),
                    password=os.environ.get("COORDINATOR_PASSWORD"))

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Solve the synthetic dataset in the background so the first visitor isn't the one who waits.
    threading.Thread(target=registry.warm_up, daemon=True).start()
    yield


app = FastAPI(title="Multi-Site Staffing & Routing Optimizer API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],   # the Vite dev server
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Picking the workspace for a request
# ---------------------------------------------------------------------------

def _bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:]
    return None


def get_workspace(x_session_id: str | None = Header(default=None),
                  authorization: str | None = Header(default=None)) -> Workspace:
    token = _bearer(authorization)
    if token is not None:
        if not registry.is_valid_token(token):
            raise HTTPException(status_code=401, detail="Your coordinator login has expired — log in again.")
        try:
            return registry.coordinator()
        except NotConfiguredError as e:
            raise HTTPException(status_code=503, detail=str(e))
    if not x_session_id:
        raise HTTPException(status_code=400, detail="Missing session id.")
    return registry.playground(x_session_id)


@contextmanager
def using(ws: Workspace) -> Generator[Workspace]:
    """Serialize requests on one workspace, and turn validation errors into plain-language 400s."""
    with ws.lock:
        try:
            yield ws
        except (WorkspaceError, RecordConflictError) as e:
            raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------------------
# Session / login
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    password: str


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/session")
def session(authorization: str | None = Header(default=None)):
    return {"mode": "coordinator" if registry.is_valid_token(_bearer(authorization)) else "playground",
            "coordinator_available": registry.coordinator_configured}


@app.post("/api/login")
def login(req: LoginRequest):
    try:
        return {"token": registry.login(req.password)}
    except NotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/api/logout")
def logout(authorization: str | None = Header(default=None)):
    token = _bearer(authorization)
    if token:
        registry.logout(token)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Schedule: calendar view, drill-downs, re-solve / publish
# ---------------------------------------------------------------------------

@app.get("/api/schedule")
def get_schedule(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return views.schedule_view(ws)


@app.get("/api/schedule/status")
def get_schedule_status(ws: Workspace = Depends(get_workspace)):
    """Cheap check any page can make: is the schedule out of date, and why?"""
    with using(ws):
        return {"needs_update": ws.needs_resolve}


@app.post("/api/schedule/resolve")
def resolve_schedule(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return {"changes": views.describe_changes(ws, ws.solve())}


@app.post("/api/schedule/publish")
def publish_schedule(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.publish()
        return {"status": "ok"}


@app.get("/api/shows/{show_id}/detail")
def get_show_detail(show_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        if show_id not in ws.upcoming_show_ids():
            raise HTTPException(status_code=404, detail="That show isn't on the upcoming schedule.")
        return views.show_detail(ws, show_id)


@app.get("/api/musicians/{musician_id}/profile")
def get_musician_profile(musician_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        if musician_id not in ws.data.musicians.index:
            raise HTTPException(status_code=404, detail=f"No musician {musician_id}.")
        return views.musician_profile(ws, musician_id)


@app.get("/api/availability-heatmap")
def get_availability_heatmap(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return views.availability_heatmap(ws)


@app.get("/api/network")
def get_network(date: str | None = None, ws: Workspace = Depends(get_workspace)):
    """One day's routes for the network map. Defaults to the earliest upcoming show's date."""
    with using(ws):
        d = date or views.first_upcoming_date(ws)
        if d is None:
            return {"date": None, "facilities": [], "routes": []}
        return views.network_view(ws, d)


@app.get("/api/flow")
def get_flow(show_id: str | None = None, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return views.flow_view(ws, show_id)


@app.get("/api/utilization")
def get_utilization(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return views.utilization_view(ws)


# ---------------------------------------------------------------------------
# Cancellations
# ---------------------------------------------------------------------------

class CancellationRequest(BaseModel):
    show_id: str
    musician_id: str
    backup_choice: str = "auto"          # "auto", "none", or a musician_id
    accept_extra_songs: bool = True
    add_suggested_musician: bool = False


def _plan_to_dict(ws: Workspace, plan) -> dict:
    fac = ws.data.facilities.loc[ws.data.shows.at[plan.show_id, "facility_id"]]
    newcomers = [m for m in (plan.activated_backup_id, plan.additional_backup_id) if m]
    warnings = [w for m in newcomers if (w := views.cap_warning(ws, m, plan.show_id))]
    return dict(
        warnings=warnings,
        show_id=plan.show_id,
        cancelled=dict(musician_id=plan.cancelled_musician_id, name=views.musician_name(ws, plan.cancelled_musician_id)),
        activated_backup=(dict(musician_id=plan.activated_backup_id, name=views.musician_name(ws, plan.activated_backup_id))
                          if plan.activated_backup_id else None),
        extra_song_requests=[dict(musician_id=m, name=views.musician_name(ws, m), add=int(n))
                             for m, n in plan.extra_song_requests],
        suggested_musician=(dict(musician_id=plan.additional_backup_id, name=views.musician_name(ws, plan.additional_backup_id),
                                 songs=int(plan.additional_backup_songs), is_pianist=bool(plan.additional_backup_is_pianist))
                            if plan.additional_backup_id else None),
        songs_covered=int(plan.songs_covered), songs_target=int(plan.songs_target),
        musician_count=int(plan.musician_count), min_musicians=int(fac.min_musicians),
        has_pianist=bool(plan.has_pianist), needs_attention=bool(plan.needs_attention),
    )


@app.post("/api/cancellations/preview")
def preview_cancellation(req: CancellationRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return _plan_to_dict(ws, ws.plan_cancellation(req.show_id, req.musician_id, req.backup_choice))


@app.post("/api/cancellations/apply")
def apply_cancellation(req: CancellationRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        plan = ws.apply_cancellation(req.show_id, req.musician_id, req.backup_choice,
                                     req.accept_extra_songs, req.add_suggested_musician)
        return _plan_to_dict(ws, plan)


# ---------------------------------------------------------------------------
# Locks and bans
# ---------------------------------------------------------------------------

class LockRequest(BaseModel):
    musician_id: str
    show_id: str


class BanRequest(BaseModel):
    musician_id: str
    scope: str        # "show" or "facility"
    target_id: str


@app.post("/api/locks")
def add_lock(req: LockRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.add_lock(req.musician_id, req.show_id)
        return {"status": "ok"}


@app.delete("/api/locks")
def remove_lock(musician_id: str, show_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.remove_lock(musician_id, show_id)
        return {"status": "ok"}


@app.post("/api/bans")
def add_ban(req: BanRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.add_ban(req.musician_id, req.scope, req.target_id)
        return {"status": "ok"}


@app.delete("/api/bans")
def remove_ban(musician_id: str, scope: str, target_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.remove_ban(musician_id, scope, target_id)
        return {"status": "ok"}


# ---------------------------------------------------------------------------
# Scenario planner and "will this fit"
# ---------------------------------------------------------------------------

class ScenarioRequest(BaseModel):
    cancellation_p: float = DEFAULT_CANCEL_P
    remove_musicians: int = 0


@app.post("/api/scenario")
def scenario(req: ScenarioRequest, ws: Workspace = Depends(get_workspace)):
    """Compare the current draft at the normal cancellation rate ("this month") against the same
    roster under a worse rate and/or with musicians removed. Removing musicians needs a real
    re-solve on a throwaway copy — the workspace itself is never touched."""
    with using(ws):
        draft = ws.require_draft()
        baseline_kpis = views.schedule_kpis(ws, draft)
        baseline_fill = simulate_fill_rate(ws.data, draft.assignments, draft.backups,
                                           cancellation_p=DEFAULT_CANCEL_P, n_runs=3000, seed=1)
        data = ws.data

    if req.remove_musicians > 0:
        rng = np.random.default_rng(42)   # same N always removes the same people, for repeatable comparisons
        ids = rng.choice(data.musicians.index, size=min(req.remove_musicians, len(data.musicians) - 5), replace=False)
        for musician_id in ids:
            data = delete_musician(data, musician_id)
        what_if = Workspace(data)
        with using(what_if):    # a throwaway copy, but its errors still need to reach the page as a 400
            what_if.solve()
        scenario_kpis = views.schedule_kpis(what_if, what_if.draft)
        scenario_fill = simulate_fill_rate(data, what_if.draft.assignments, what_if.draft.backups,
                                           cancellation_p=req.cancellation_p, n_runs=3000, seed=1)
    else:
        scenario_kpis = dict(baseline_kpis)
        with using(ws):
            scenario_fill = simulate_fill_rate(ws.data, draft.assignments, draft.backups,
                                               cancellation_p=req.cancellation_p, n_runs=3000, seed=1)

    # Shows never get cancelled for lack of musicians — they go ahead short. So alongside "how many
    # keep a full set", report the total music missing across every upcoming show.
    for kpis, fill in ((baseline_kpis, baseline_fill), (scenario_kpis, scenario_fill)):
        kpis["fill_rate"] = float(fill.fill_rate.mean())
        kpis["minutes_short"] = float(fill.minutes_short.sum())
    return {"baseline": baseline_kpis, "scenario": scenario_kpis, "show_count": len(baseline_fill)}


class FeasibilityRequest(BaseModel):
    facility_id: str
    date: str
    start_time: str | None = None      # "HH:MM"; when given, musicians not usually free then are excluded
    duration_min: int | None = None    # defaults to the facility's usual show length


def _feasibility_to_dict(feas) -> dict:
    return dict(date=feas.date, probability_fully_staffed=feas.probability_fully_staffed,
                eligible_pool_size=feas.eligible_pool_size, excluded_day_conflict=feas.excluded_day_conflict,
                excluded_over_cap=feas.excluded_over_cap, excluded_guardian_range=feas.excluded_guardian_range,
                excluded_time=feas.excluded_time,
                mean_available_count=feas.mean_available_count, mean_available_songs=feas.mean_available_songs)


@app.post("/api/feasibility")
def feasibility(req: FeasibilityRequest, ws: Workspace = Depends(get_workspace)):
    """"If a care home asks for this date, could we staff it?" — checked against the current
    draft's commitments, before any musician has been asked about that date."""
    with using(ws):
        if req.facility_id not in ws.data.facilities.index:
            raise HTTPException(status_code=400, detail="That location doesn't exist.")
        draft = ws.require_draft()
        slot = dict(start_time=req.start_time, duration_min=req.duration_min)
        requested = estimate_new_show_feasibility(ws.data, draft.assignments, req.facility_id, req.date,
                                                  n_runs=3000, seed=1, **slot)
        alternatives = suggest_alternative_dates(ws.data, draft.assignments, req.facility_id, req.date,
                                                 window_days=14, n_runs=1500, top_n=8, seed=1, **slot)
        today = date.today().isoformat()
        alternatives = [a for a in alternatives if a.date >= today][:3]   # never suggest a date that's already past
        return {"requested": _feasibility_to_dict(requested),
                "alternatives": [_feasibility_to_dict(a) for a in alternatives]}


# ---------------------------------------------------------------------------
# Working tools: roster CRUD. Every write goes through data.py's validated CRUD functions;
# a rejected write becomes a plain-language 400 and nothing changes.
# ---------------------------------------------------------------------------

class MusicianIn(BaseModel):
    musician_id: str
    display_name: str
    age: int
    instrument: str
    home_region: str
    home_lat: float
    home_lng: float
    transport: str
    can_drive: bool
    years_with_org: float
    max_shows_per_month: int
    min_songs: int
    typical_songs: int
    max_songs: int


class ShowIn(BaseModel):
    show_id: str
    facility_id: str
    date: str
    start_time: str
    duration_min: int
    period: str = "upcoming"


class BulkUpdateRequest(BaseModel):
    musician_ids: list[str]
    changes: dict[str, Any]


class BulkDeleteRequest(BaseModel):
    musician_ids: list[str]


def _records(df) -> list[dict]:
    return df.reset_index(drop=True).to_dict(orient="records")


@app.get("/api/musicians")
def list_musicians(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return _records(ws.data.musicians)


@app.post("/api/musicians")
def create_musician(musician: MusicianIn, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.mutate_data(lambda d: add_musician(d, musician.model_dump()),
                       f"{musician.display_name} was added to the roster.")
        return {"status": "ok"}


@app.put("/api/musicians/{musician_id}")
def edit_musician(musician_id: str, changes: dict[str, Any] = Body(...), ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.mutate_data(lambda d: update_musician(d, musician_id, changes),
                       lambda: f"{views.musician_name(ws, musician_id)}'s details changed.")
        return {"status": "ok"}


@app.delete("/api/musicians/{musician_id}")
def remove_musician(musician_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        name = views.musician_name(ws, musician_id) if musician_id in ws.data.musicians.index else "A musician"
        ws.mutate_data(lambda d: delete_musician(d, musician_id), f"{name} was removed from the roster.")
        return {"status": "ok"}


@app.post("/api/musicians/bulk-update")
def bulk_update_musicians(req: BulkUpdateRequest, ws: Workspace = Depends(get_workspace)):
    """All-or-nothing: every musician is validated on a copy first, so one bad row leaves the
    whole roster untouched."""
    def apply(d):
        for musician_id in req.musician_ids:
            d = update_musician(d, musician_id, req.changes)
        return d
    with using(ws):
        ws.mutate_data(apply, f"{len(req.musician_ids)} musicians were edited at once.")
        return {"status": "ok"}


@app.post("/api/musicians/bulk-delete")
def bulk_delete_musicians(req: BulkDeleteRequest, ws: Workspace = Depends(get_workspace)):
    def apply(d):
        for musician_id in req.musician_ids:
            d = delete_musician(d, musician_id)
        return d
    with using(ws):
        ws.mutate_data(apply, f"{len(req.musician_ids)} musicians were removed from the roster.")
        return {"status": "ok"}


@app.get("/api/musicians/{musician_id}/availability")
def get_musician_availability(musician_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        wa = ws.data.weekly_availability
        return _records(wa[wa.musician_id == musician_id][["weekday", "start_time", "end_time"]])


@app.put("/api/musicians/{musician_id}/availability")
def put_musician_availability(musician_id: str, windows: list[dict[str, Any]] = Body(...),
                              ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.mutate_data(lambda d: set_weekly_availability(d, musician_id, windows),
                       lambda: f"{views.musician_name(ws, musician_id)}'s weekly availability changed.")
        return {"status": "ok"}


@app.get("/api/shows")
def list_shows(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return _records(ws.data.shows)


@app.get("/api/facilities")
def list_facilities(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return _records(ws.data.facilities)


@app.post("/api/shows")
def create_show(show: ShowIn, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.mutate_data(lambda d: add_show(d, show.model_dump()),
                       lambda: f"A new show at {views.show_label(ws, show.show_id)} was added and has no one on it yet.")
        return {"status": "ok"}


@app.put("/api/shows/{show_id}")
def edit_show(show_id: str, changes: dict[str, Any] = Body(...), ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.mutate_data(lambda d: update_show(d, show_id, changes),
                       lambda: f"The show at {views.show_label(ws, show_id)} changed.")
        return {"status": "ok"}


@app.delete("/api/shows/{show_id}")
def remove_show(show_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        label = views.show_label(ws, show_id) if show_id in ws.data.shows.index else "a show"
        ws.mutate_data(lambda d: delete_show(d, show_id), f"The show at {label} was removed.")
        return {"status": "ok"}
