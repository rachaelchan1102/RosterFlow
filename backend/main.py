"""FastAPI backend: wraps the optimizer package behind HTTP endpoints.

Every request runs against a workspace (backend/workspace.py), picked by backend/registry.py:
a per-visitor playground (synthetic data, gone on refresh) unless the request carries a valid
coordinator login, in which case it's the shared Postgres-backed workspace.

Configuration (environment variables, or KEY=value lines in the project's .env file):
  NEON_DSN              Postgres connection string for the coordinator workspace
  COORDINATOR_PASSWORD  the shared coordinator password
Without both, only the playground is available.
"""
import os
import threading
from collections.abc import Generator
from datetime import date, timedelta
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import psycopg
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend import persistence, views
from backend.env import load_env_file
from backend.registry import NotConfiguredError, Registry, TooManyAttemptsError
from backend.workspace import Workspace, WorkspaceError, current_actor
from optimizer.data import (BOOKING_HORIZON_DAYS, MAX_SHOWS_PER_DAY, RecordConflictError, add_facility, add_musician,
                            add_show, bulk_add_musicians, bulk_set_show_availability, delete_musician, delete_show,
                            set_weekly_availability, update_facility, update_musician, update_show)
from optimizer.simulate import (DEFAULT_CANCEL_P, buffer_sizing_report, estimate_new_show_feasibility,
                                simulate_fill_rate, simulate_pianist_risk, simulate_regional_disruption,
                                suggest_alternative_dates)

load_env_file()

SAMPLE_DATA_DIR = Path(__file__).resolve().parent.parent / "sample_data"

registry = Registry(SAMPLE_DATA_DIR, dsn=os.environ.get("NEON_DSN"),
                    password=os.environ.get("COORDINATOR_PASSWORD"))

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Solve the synthetic dataset in the background so the first visitor isn't the one who waits.
    threading.Thread(target=registry.warm_up, daemon=True).start()
    yield


async def note_who_is_acting(authorization: str | None = Header(default=None)) -> None:
    """Stamps each request with the logged-in coordinator's name, for activity entries it records
    (see workspace.current_actor). Async on purpose: a value set here carries into the endpoint,
    where a sync dependency's would stay behind in its own worker thread."""
    token = _bearer(authorization)
    login = await run_in_threadpool(registry.session, token) if token else None
    current_actor.set(login.name if login else None)


app = FastAPI(title="Multi-Site Staffing & Routing Optimizer API", lifespan=lifespan,
              dependencies=[Depends(note_who_is_acting)])

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


# Registered before CORS so CORS stays the outermost layer and still labels this one's 503s.
@app.middleware("http")
async def one_coordinator_write_at_a_time(request: Request, call_next):
    """Several copies of the backend can be running (Vercel starts them on demand), each with the
    coordinator workspace in memory. Without this, two copies could each apply a change to their
    own copy and save, and the second save would silently wipe out the first. So any request that
    could change the coordinator workspace takes a Postgres advisory lock for its whole run: writes
    take turns across every copy, and each starts by reloading if another copy saved in between
    (Registry.coordinator). A transaction-scoped lock, not a session one, so it also works through
    Neon's pooled connection string and is released even if this copy dies mid-request."""
    touches_coordinator = request.method in WRITE_METHODS and (
        _bearer(request.headers.get("authorization")) is not None or request.url.path.startswith("/api/respond/"))
    if not (touches_coordinator and registry.coordinator_configured):
        return await call_next(request)
    try:
        conn = await psycopg.AsyncConnection.connect(registry.dsn)
    except psycopg.OperationalError:
        return JSONResponse(status_code=503, content={"detail": DB_UNREACHABLE})
    async with conn:
        await conn.execute("SELECT pg_advisory_xact_lock(%s)", (persistence.WRITE_LOCK_ID,))
        return await call_next(request)   # the lock ends with the transaction when `conn` closes


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],   # the Vite dev server
    allow_methods=["*"],
    allow_headers=["*"],
)


DB_UNREACHABLE = "Can't reach the coordinator database right now. Try again in a minute."


@app.exception_handler(psycopg.OperationalError)
def database_unreachable(_request: Request, _exc: psycopg.OperationalError):
    return JSONResponse(status_code=503, content={"detail": DB_UNREACHABLE})


# ---------------------------------------------------------------------------
# Picking the workspace for a request
# ---------------------------------------------------------------------------

def _client_ip(request: Request) -> str:
    # On Vercel every request reaches the app from Vercel's own proxy, so the visitor's address
    # is in x-real-ip, which Vercel sets itself and a client can't override.
    if os.environ.get("VERCEL") and request.headers.get("x-real-ip"):
        return request.headers["x-real-ip"]
    return request.client.host if request.client else "unknown"


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


def get_coordinator_workspace(authorization: str | None = Header(default=None)) -> Workspace:
    """Stricter than get_workspace: only a logged-in coordinator, never a playground session —
    for things scoped to the real roster, like minting a musician's self-service link, where a
    playground visitor's made-up musician_ids wouldn't mean anything."""
    if not registry.is_valid_token(_bearer(authorization)):
        raise HTTPException(status_code=401, detail="Log in as coordinator first.")
    try:
        return registry.coordinator()
    except NotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))


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
    name: str
    password: str


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/session")
def session(authorization: str | None = Header(default=None)):
    login = registry.session(_bearer(authorization))
    return {"mode": "coordinator" if login else "playground",
            "coordinator_available": registry.coordinator_configured,
            "expires_at": login.expires_at.isoformat() if login else None,
            "name": login.name if login else None}


@app.post("/api/login")
def login(req: LoginRequest, request: Request):
    try:
        token, login = registry.login(req.name, req.password, client=_client_ip(request))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except NotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except TooManyAttemptsError as e:
        raise HTTPException(status_code=429, detail=str(e), headers={"Retry-After": str(e.retry_after_s)})
    except PermissionError as e:
        raise HTTPException(status_code=401, detail=str(e))
    # A coordinator has no picker between several named schedules — there's exactly one shared,
    # persisted workspace — but they still deserve confirmation of *what* just loaded, not just
    # that login succeeded, so this doesn't read like the playground they were just in.
    ws = registry.coordinator()
    with using(ws):
        return {"token": token, "expires_at": login.expires_at.isoformat(), "name": login.name, "loaded": {
            "musicians": int(len(ws.data.musicians)),
            "facilities": int(len(ws.data.facilities)),
            "upcoming_shows": len(ws.upcoming_show_ids()),
        }}


@app.post("/api/logout")
def logout(authorization: str | None = Header(default=None)):
    token = _bearer(authorization)
    if token:
        registry.logout(token)
    return {"status": "ok"}


@app.post("/api/logout-everywhere")
def logout_everywhere(_ws: Workspace = Depends(get_coordinator_workspace)):
    registry.logout_everywhere()
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
        changes = views.describe_changes(ws, ws.solve())
        # A resolve can genuinely have nothing to move (or nothing more it can do) and STILL
        # leave a show below minimum headcount or with zero backups — that's not a no-op success,
        # it's the solver reporting it couldn't fix everything. The frontend needs this to say so
        # honestly instead of "Schedule updated" reading like everything's now fine.
        still_short = [dict(show_id=s["show_id"], facility_name=s["facility_name"], date=s["date"],
                            start_time=s["start_time"], reasons=s["reasons"])
                      for s in views.schedule_view(ws)["shows"] if s["status"] == "red"]
        return {"changes": changes, "still_short": still_short}


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


@app.get("/api/musicians/{musician_id}/self-service-link")
def get_self_service_link(musician_id: str, ws: Workspace = Depends(get_coordinator_workspace)):
    with using(ws):
        if musician_id not in ws.data.musicians.index:
            raise HTTPException(status_code=404, detail=f"No musician {musician_id}.")
        token = persistence.get_or_create_musician_token(registry.dsn, musician_id)
        return {"token": token}


@app.get("/api/respond/{token}")
def self_service_view(token: str):
    """No auth at all, by design — the token in the URL IS the credential, the same way an
    unsubscribe link works. Anyone with the link sees one musician's own upcoming shows and
    nothing else: no roster, no other musicians' availability, no coordinator tools."""
    if not registry.dsn:
        raise HTTPException(status_code=503, detail="Self-service links aren't available on this server.")
    musician_id = persistence.musician_id_for_token(registry.dsn, token)
    if not musician_id:
        raise HTTPException(status_code=404, detail="This link isn't valid.")
    ws = registry.coordinator()
    with using(ws):
        if musician_id not in ws.data.musicians.index:
            raise HTTPException(status_code=404, detail="This link isn't valid.")
        return views.self_service_view(ws, musician_id)


class SelfServiceRequest(BaseModel):
    responses: list[dict[str, Any]]     # [{show_id, available}]


@app.post("/api/respond/{token}")
def self_service_submit(token: str, req: SelfServiceRequest):
    if not registry.dsn:
        raise HTTPException(status_code=503, detail="Self-service links aren't available on this server.")
    musician_id = persistence.musician_id_for_token(registry.dsn, token)
    if not musician_id:
        raise HTTPException(status_code=404, detail="This link isn't valid.")
    ws = registry.coordinator()
    with using(ws):
        responses = [(r["show_id"], bool(r["available"])) for r in req.responses]
        ws.self_service_respond(musician_id, responses)
        return {"status": "ok"}


@app.get("/api/availability-heatmap")
def get_availability_heatmap(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return views.availability_heatmap(ws)


# ---------------------------------------------------------------------------
# Control Tower home: activity feed / audit log, forecast
# ---------------------------------------------------------------------------

@app.get("/api/capacity-forecast")
def get_capacity_forecast(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return views.capacity_forecast(ws)


@app.get("/api/facility-demand-forecast")
def get_facility_demand_forecast(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return {"facilities": views.facility_demand_forecast(ws)}


@app.get("/api/activity")
def get_activity(limit: int | None = None, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return views.activity_log(ws, limit)


class RevertRequest(BaseModel):
    confirm: bool = False


@app.post("/api/activity/{entry_id}/revert")
def revert_activity(entry_id: int, req: RevertRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        later = ws.revert_preview(entry_id)
        # The frontend always makes an unconfirmed preview call first, then a second call with
        # confirm=true to actually revert — so `not req.confirm` alone (not `later and not
        # req.confirm`) has to gate the mutation. Previously, reverting the MOST RECENT entry
        # (where `later` is an empty list, itself falsy) skipped the early return and reverted
        # on that first "just checking" call — then the frontend's confirmed second call
        # reverted a second time, producing two identical "Reverted: ..." entries from one click.
        if not req.confirm:
            return {"needs_confirmation": bool(later), "later": later}
        ws.revert(entry_id)
        return {"needs_confirmation": False, "status": "ok"}


@app.get("/api/activity/{entry_id}/changes")
def activity_entry_changes(entry_id: int, ws: Workspace = Depends(get_workspace)):
    """What THIS entry actually changed on the roster — the same per-show/per-musician breakdown
    the update bar shows right after a live resolve, for any past Activity entry. Most entries
    (a lock, a ban, an edit that didn't need a re-solve yet) simply changed nothing about who's
    playing what, so an empty list here is the normal, honest answer, not a broken one."""
    with using(ws):
        return {"changes": views.describe_changes(ws, ws.entry_changes(entry_id))}


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


@app.get("/api/problem-locations")
def get_problem_locations(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return {"locations": views.problem_locations(ws)}


@app.get("/api/slot-collisions")
def get_slot_collisions(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return views.slot_collision_view(ws)


@app.get("/api/cost-waterfall")
def get_cost_waterfall(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return views.cost_waterfall(ws)


@app.get("/api/crossing-swaps")
def get_crossing_swaps(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return {"swaps": views.crossing_swaps(ws)}


class SwapRequest(BaseModel):
    show_a: str
    musician_a: str
    show_b: str
    musician_b: str


@app.post("/api/crossing-swaps/apply")
def apply_crossing_swap(req: SwapRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.swap_across_shows(req.show_a, req.musician_a, req.show_b, req.musician_b)
        return {"status": "ok"}


# ---------------------------------------------------------------------------
# Cancellations
# ---------------------------------------------------------------------------

class CancellationRequest(BaseModel):
    show_id: str
    musician_id: str
    backup_choice: str = "auto"          # "auto", "none", or a musician_id
    accept_extra_songs: bool = True
    add_suggested_musician: bool = False
    # Seconds from opening this flow to pressing Apply, timed client-side — logged on the
    # resulting audit entry so "time to fill" can be reported honestly (see UI_Supply_Chain2.md
    # Part 1 item 7), rather than a number nobody can trace back to a real measurement.
    fill_seconds: float | None = None


def _plan_to_dict(ws: Workspace, plan) -> dict:
    facility_id = ws.data.shows.at[plan.show_id, "facility_id"]
    fac = ws.data.facilities.loc[facility_id]
    newcomers = [m for m in (plan.activated_backup_id, plan.additional_backup_id) if m]
    warnings = [w for m in newcomers if (w := views.cap_warning(ws, m, plan.show_id))]
    cancelled_km = ws.data.distance_to_facility(plan.cancelled_musician_id, facility_id)
    backup_km = (ws.data.distance_to_facility(plan.activated_backup_id, facility_id)
                if plan.activated_backup_id else None)
    km_delta = (backup_km - cancelled_km) if backup_km is not None else None
    pooled_with = (views._pool_candidates(ws, plan.activated_backup_id, plan.show_id)
                  if plan.activated_backup_id else [])
    return dict(
        warnings=warnings,
        show_id=plan.show_id,
        cancelled=dict(musician_id=plan.cancelled_musician_id, name=views.musician_name(ws, plan.cancelled_musician_id),
                      distance_km=round(cancelled_km, 1)),
        activated_backup=(dict(musician_id=plan.activated_backup_id, name=views.musician_name(ws, plan.activated_backup_id),
                              distance_km=round(backup_km, 1), km_delta=round(km_delta, 1),
                              cost_delta=round(km_delta * ws.mileage_rate, 2), pooled_with=pooled_with)
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
                                     req.accept_extra_songs, req.add_suggested_musician, req.fill_seconds)
        return _plan_to_dict(ws, plan)


class AddToShowRequest(BaseModel):
    musician_id: str


@app.post("/api/shows/{show_id}/add-musician")
def add_musician_to_show(show_id: str, req: AddToShowRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.add_to_show(show_id, req.musician_id)
        return {"status": "ok"}


class AttendanceRecord(BaseModel):
    musician_id: str
    status: str            # "attended", "late_cancel", "no_show"
    actual_set_min: int = 0


class AttendanceRequest(BaseModel):
    records: list[AttendanceRecord]


@app.post("/api/shows/{show_id}/attendance")
def check_in_attendance(show_id: str, req: AttendanceRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        show = ws.data.shows.loc[show_id] if show_id in ws.data.shows.index else None
        planned = int(show.duration_min) if show is not None else 0
        records = [dict(show_id=show_id, musician_id=r.musician_id, planned_set_min=planned,
                       status=r.status, actual_set_min=r.actual_set_min) for r in req.records]
        ws.check_in_attendance(show_id, records)
        return {"status": "ok"}


@app.get("/api/musicians/{musician_id}/volunteer-hours")
def get_volunteer_hours(musician_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        if musician_id not in ws.data.musicians.index:
            raise HTTPException(status_code=404, detail=f"No musician {musician_id}.")
        return views.volunteer_hours(ws, musician_id)


@app.post("/api/shows/{show_id}/pending/confirm")
def confirm_pending_call(show_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.confirm_pending(show_id)
        return {"status": "ok"}


@app.post("/api/shows/{show_id}/pending/decline")
def decline_pending_call(show_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.decline_pending(show_id)
        return {"status": "ok"}


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


@app.post("/api/confirmations")
def confirm_musician(req: LockRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.confirm_musician(req.musician_id, req.show_id)
        return {"status": "ok"}


class SongTitleRequest(BaseModel):
    musician_id: str
    show_id: str
    title: str


@app.put("/api/song-titles")
def set_song_title(req: SongTitleRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.set_song_title(req.musician_id, req.show_id, req.title)
        return {"status": "ok"}


@app.delete("/api/confirmations")
def unconfirm_musician(musician_id: str, show_id: str, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.unconfirm_musician(musician_id, show_id)
        return {"status": "ok"}


class MileageRateRequest(BaseModel):
    rate: float


@app.get("/api/settings")
def get_settings(ws: Workspace = Depends(get_workspace)):
    with using(ws):
        return {"mileage_rate": ws.mileage_rate}


@app.put("/api/settings/mileage-rate")
def set_mileage_rate(req: MileageRateRequest, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.set_mileage_rate(req.rate)
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
        baseline_kpis = views.schedule_kpis(ws.data, draft, ws.mileage_rate)
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
        scenario_kpis = views.schedule_kpis(what_if.data, what_if.draft, ws.mileage_rate)
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


# ---------------------------------------------------------------------------
# Simulation: recurring/structural what-ifs, each with a real trigger — separate from the
# scenario/feasibility tools above (docs/Scenario_Planner.md). Deterministic modules re-run the
# real solver on a throwaway copy of the data, same pattern as /api/scenario; probabilistic ones
# reuse the Monte Carlo engine in optimizer/simulate.py against the CURRENT draft, unchanged.
# ---------------------------------------------------------------------------

class CapacityDropRequest(BaseModel):
    n_musicians: int = 18
    new_cap: int = 1


@app.post("/api/simulation/capacity-drop")
def simulation_capacity_drop(req: CapacityDropRequest, ws: Workspace = Depends(get_workspace)):
    """"What if our N highest-capacity musicians all dropped to `new_cap` shows a month at once?"
    — the flagship recurring risk (docs/Scenario_Planner.md item 4a), modeled here as a capacity
    cut across the whole upcoming window rather than literally scoped to September: a musician's
    monthly cap isn't a per-month field in this data model, so there's no month to scope it to
    without a deeper schema change. The N highest-cap musicians are picked because they're the
    only ones a cut like this actually changes — capping someone already at 1 to 1 does nothing."""
    with using(ws):
        draft = ws.require_draft()
        baseline_kpis = views.schedule_kpis(ws.data, draft, ws.mileage_rate)
        baseline_fill = simulate_fill_rate(ws.data, draft.assignments, draft.backups, n_runs=3000, seed=1)
        data = ws.data

    n = max(0, min(req.n_musicians, len(data.musicians)))
    affected = data.musicians.sort_values("max_shows_per_month", ascending=False).index[:n].tolist()
    for musician_id in affected:
        data = update_musician(data, musician_id, {"max_shows_per_month": req.new_cap})

    what_if = Workspace(data)
    with using(what_if):
        what_if.solve()
        scenario_kpis = views.schedule_kpis(what_if.data, what_if.draft, ws.mileage_rate)
        scenario_fill = simulate_fill_rate(what_if.data, what_if.draft.assignments, what_if.draft.backups,
                                           n_runs=3000, seed=1)

    for kpis, fill in ((baseline_kpis, baseline_fill), (scenario_kpis, scenario_fill)):
        kpis["fill_rate"] = float(fill.fill_rate.mean())
        kpis["minutes_short"] = float(fill.minutes_short.sum())
    return {"baseline": baseline_kpis, "scenario": scenario_kpis, "affected_musicians": len(affected)}


@app.get("/api/simulation/pianist-risk")
def simulation_pianist_risk(ws: Workspace = Depends(get_workspace)):
    """Per upcoming show, two different pianist problems, not one: the chance no pianist is
    present after cancellations even after backups activate (simulated — reads the CURRENT hard
    pianist requirement, see simulate_pianist_risk's docstring on why this doesn't adopt the
    separate, undecided pianist soft-preference idea), and, deterministically from today's
    roster, whether the lineup is ALL pianists with no other instrument, and whether the room
    actually has a piano for them to play — a show can score near-zero on the first without ever
    being safe on the second."""
    with using(ws):
        draft = ws.require_draft()
        risk = simulate_pianist_risk(ws.data, draft.assignments, draft.backups, n_runs=3000, seed=1)
        rows = []
        for r in risk.itertuples():
            show = ws.data.shows.loc[r.show_id]
            fac = ws.data.facilities.loc[show.facility_id]
            rows.append(dict(show_id=r.show_id, facility_name=fac.display_name, date=str(show.date),
                             start_time=show.start_time, pianist_risk=r.pianist_risk,
                             pianists_in_reach=r.pianists_in_reach, non_pianists_booked=r.non_pianists_booked,
                             has_piano_onsite=r.has_piano_onsite))
    rows.sort(key=lambda r: -r["pianist_risk"])
    return {"shows": rows}


@app.get("/api/simulation/buffer-sizing")
def simulation_buffer_sizing(target_fill_rate: float = 0.95, ws: Workspace = Depends(get_workspace)):
    """Per upcoming show: backups on hand now vs. what backups_needed_for_target says it'd take
    to clear `target_fill_rate` — the UI this function was written for but never got."""
    with using(ws):
        draft = ws.require_draft()
        report = buffer_sizing_report(ws.data, draft.assignments, draft.backups,
                                      target_fill_rate=target_fill_rate, n_runs=2000, seed=1)
        rows = []
        for r in report.itertuples():
            show = ws.data.shows.loc[r.show_id]
            fac = ws.data.facilities.loc[show.facility_id]
            # backups_needed comes back as pandas' float NaN (not Python None) for "even
            # max_backups isn't enough" once it's round-tripped through a DataFrame column that
            # also holds real ints — NaN isn't valid JSON, so it's converted back to None here.
            needed = None if pd.isna(r.backups_needed) else int(r.backups_needed)
            rows.append(dict(show_id=r.show_id, facility_id=show.facility_id, facility_name=fac.display_name,
                             date=str(show.date), start_time=show.start_time, current_backups=int(r.current_backups),
                             backups_needed=needed))
    rows.sort(key=lambda r: (r["backups_needed"] - r["current_backups"]) if r["backups_needed"] is not None else 999,
             reverse=True)
    return {"target_fill_rate": target_fill_rate, "shows": rows}


class DemandGrowthRequest(BaseModel):
    facility_id: str
    extra_shows: int = 2   # spread across the booking window (see BOOKING_HORIZON_DAYS), not per calendar month


def _open_dates_in_window(data, count: int) -> list[str]:
    """The next `count` dates inside the booking window that aren't already at the org-wide
    per-day show cap — evenly spread rather than piled on the first open days, so a demand-growth
    projection doesn't cluster every new show in the next week."""
    day_counts = data.shows.groupby("date").size().to_dict()
    window = [(date.today() + timedelta(days=i)).isoformat() for i in range(BOOKING_HORIZON_DAYS + 1)]
    open_days = [d for d in window if day_counts.get(d, 0) < MAX_SHOWS_PER_DAY]
    if not open_days or count <= 0:
        return []
    if count >= len(open_days):
        return open_days
    step = len(open_days) / count
    return [open_days[int(i * step)] for i in range(count)]


@app.post("/api/simulation/demand-growth")
def simulation_demand_growth(req: DemandGrowthRequest, ws: Workspace = Depends(get_workspace)):
    """"What if this location asked for N more shows?" — adds N synthetic upcoming shows at the
    facility's usual slot, spread across the current booking window, and compares KPIs against a
    throwaway re-solve, same pattern as /api/scenario's remove_musicians path."""
    with using(ws):
        if req.facility_id not in ws.data.facilities.index:
            raise HTTPException(status_code=400, detail="That location doesn't exist.")
        draft = ws.require_draft()
        baseline_kpis = views.schedule_kpis(ws.data, draft, ws.mileage_rate)
        data = ws.data

    fac = data.facilities.loc[req.facility_id]
    dates = _open_dates_in_window(data, max(0, req.extra_shows))
    if not dates:
        raise HTTPException(status_code=400, detail="No open dates left in the booking window to add shows to.")
    start_time = fac.preferred_slot.split(" ")[1] if " " in str(fac.preferred_slot) else "14:00"
    for i, show_date in enumerate(dates):
        data = add_show(data, dict(show_id=f"SIMDG{i:04d}", facility_id=req.facility_id, date=show_date,
                                   start_time=start_time, duration_min=int(fac.show_duration_min), period="upcoming"))

    what_if = Workspace(data)
    with using(what_if):
        what_if.solve()
        scenario_kpis = views.schedule_kpis(what_if.data, what_if.draft, ws.mileage_rate)
    return {"baseline": baseline_kpis, "scenario": scenario_kpis, "shows_added": len(dates)}


@app.get("/api/simulation/regions")
def simulation_regions(ws: Workspace = Depends(get_workspace)):
    """Every home region with at least one musician in it — populates the Regional Disruption
    picker without hardcoding the org's actual region names anywhere in this file."""
    with using(ws):
        regions = sorted(ws.data.musicians["home_region"].dropna().unique().tolist())
    return {"regions": regions}


class RegionalDisruptionRequest(BaseModel):
    region: str
    disruption_p: float = 0.15    # chance an affected show's region-group cancels together, per run
    disrupted_cancel_p: float = 0.7


@app.post("/api/simulation/regional-disruption")
def simulation_regional_disruption(req: RegionalDisruptionRequest, ws: Workspace = Depends(get_workspace)):
    """Per upcoming show: fill rate under simulate_fill_rate's normal independent-cancellation
    model vs. simulate_regional_disruption's correlated one, for shows with someone from
    `req.region` on the roster. See that function's docstring for exactly what is and isn't
    modeled as correlated here."""
    with using(ws):
        if req.region not in set(ws.data.musicians["home_region"]):
            raise HTTPException(status_code=400, detail=f"No musicians have {req.region!r} as their home region.")
        draft = ws.require_draft()
        baseline = simulate_fill_rate(ws.data, draft.assignments, draft.backups, n_runs=3000, seed=1)
        disrupted = simulate_regional_disruption(ws.data, draft.assignments, draft.backups, region=req.region,
                                                  disruption_p=req.disruption_p,
                                                  disrupted_cancel_p=req.disrupted_cancel_p, n_runs=3000, seed=1)
        merged = baseline.merge(disrupted, on="show_id", suffixes=("_normal", "_disrupted"))
        rows = []
        for r in merged.itertuples():
            if not r.affected:
                continue
            show = ws.data.shows.loc[r.show_id]
            fac = ws.data.facilities.loc[show.facility_id]
            rows.append(dict(show_id=r.show_id, facility_name=fac.display_name, date=str(show.date),
                             start_time=show.start_time, from_region_count=int(r.from_region_count),
                             fill_rate_normal=float(r.fill_rate_normal), fill_rate_disrupted=float(r.fill_rate_disrupted)))
    rows.sort(key=lambda r: r["fill_rate_normal"] - r["fill_rate_disrupted"], reverse=True)
    return {"region": req.region, "shows_affected": len(rows), "shows_total": len(merged), "shows": rows}


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
                mean_available_count=feas.mean_available_count, mean_available_songs=feas.mean_available_songs,
                mean_travel_km=feas.mean_travel_km)


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
        horizon = (date.today() + timedelta(days=BOOKING_HORIZON_DAYS)).isoformat()
        # Never suggest a date that's already past, OR one outside the window a show can actually
        # be booked in — a "100%" alternative nobody can act on isn't a real suggestion.
        alternatives = [a for a in alternatives if today <= a.date <= horizon][:3]
        return {"requested": _feasibility_to_dict(requested),
                "alternatives": [_feasibility_to_dict(a) for a in alternatives]}


@app.get("/api/simulation/best-dates")
def simulation_best_dates(facility_id: str, month: str | None = None, ws: Workspace = Depends(get_workspace)):
    """The inverse of /api/feasibility: instead of checking one date a coordinator proposes,
    checks every day in the booking window for this facility and ranks them — both the single
    best days to propose, and which whole month is looking strongest on average, so "which day
    next month works best" and "is next month even good for this location" both have an answer.
    Returns every checked day (not just the top ones), so the frontend can lay out a full-month
    calendar and pick out that month's best AND worst days itself, not just a global top 10.

    `month` ("2026-10") scopes the actual simulation work to just that month instead of all
    ~120 days in the booking window — the frontend asks for a month up front instead of running
    the full window and only then letting the coordinator look at one part of it."""
    with using(ws):
        if facility_id not in ws.data.facilities.index:
            raise HTTPException(status_code=400, detail="That location doesn't exist.")
        draft = ws.require_draft()
        fac = ws.data.facilities.loc[facility_id]
        slot_time = str(fac.preferred_slot).split(" ")[1] if " " in str(fac.preferred_slot) else None
        duration = int(fac.show_duration_min)
        shows_by_date = ws.data.shows["date"].value_counts()

        days = []
        # Starts at tomorrow, not today — this tool is for proposing a date to a location, and
        # "today" isn't a real option for that (no lead time to actually confirm and notify
        # anyone), so it shouldn't show up as a top recommendation.
        for i in range(1, BOOKING_HORIZON_DAYS + 1):
            d = (date.today() + timedelta(days=i)).isoformat()
            if month and not d.startswith(month):
                continue
            if shows_by_date.get(d, 0) >= MAX_SHOWS_PER_DAY:
                # Already at the org-wide per-day cap — not a real candidate, but still reported
                # (with no probability) so a full-month calendar doesn't just show a hole.
                days.append(dict(date=d, full=True, probability_fully_staffed=None, eligible_pool_size=None))
                continue
            feas = estimate_new_show_feasibility(ws.data, draft.assignments, facility_id, d,
                                                  n_runs=1500, seed=1, start_time=slot_time, duration_min=duration)
            days.append({**_feasibility_to_dict(feas), "full": False})

    def _odds_tier(p: float) -> int:
        return 0 if p >= 0.9 else 1 if p >= 0.6 else 2   # lower is better, matches the frontend's own tiers

    checked = [d for d in days if not d["full"]]
    # Staffing odds come first (a day that can't be staffed isn't "best" no matter how close
    # everyone lives), but within the same odds tier, lower expected travel distance wins — so
    # among several equally-staffable days, the ones cheaper and easier to get to sort first.
    best_days = sorted(checked, key=lambda r: (_odds_tier(r["probability_fully_staffed"]), r["mean_travel_km"]))[:10]
    by_month: dict[str, list[float]] = {}
    for r in checked:
        by_month.setdefault(r["date"][:7], []).append(r["probability_fully_staffed"])
    months = sorted(
        ({"month": m, "avg_probability": sum(ps) / len(ps), "days_checked": len(ps)} for m, ps in by_month.items()),
        key=lambda x: x["month"])
    return {"facility_id": facility_id, "days": days, "best_days": best_days, "months": months}


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
    phone: str = ""
    email: str = ""
    guardian_name: str = ""
    guardian_phone: str = ""
    brings_keyboard: bool = False
    household_id: str = ""
    secondary_instruments: str = ""


class WeeklyWindowIn(BaseModel):
    weekday: str
    start_time: str
    end_time: str


class BulkMusicianRow(BaseModel):
    """The columns a coordinator would actually have on hand pasting from a sign-up spreadsheet —
    everything else (transport, songs, ...) gets a sensible default they can fix individually
    afterward, the same way a brand-new musician's "More details" are placeholders until someone
    checks them. `home_lat`/`home_lng` are geocoded client-side from a pasted address column
    before this ever reaches the backend — a missing pin used to silently default to the org's
    rough center and break every distance calculation for that person, so the frontend now
    requires an address per row instead of sending nothing."""
    display_name: str
    age: int
    instrument: str = "piano"
    home_region: str = ""
    home_lat: float
    home_lng: float
    phone: str = ""
    email: str = ""
    guardian_name: str = ""
    guardian_phone: str = ""
    weekly_availability: list[WeeklyWindowIn] = []


class BulkMusicianRequest(BaseModel):
    musicians: list[BulkMusicianRow]


@app.post("/api/musicians/bulk-import")
def bulk_import_musicians(req: BulkMusicianRequest, ws: Workspace = Depends(get_workspace)):
    """Adds every row in one pass — see bulk_add_musicians' docstring for why that's one
    validated write instead of N. `home_lat`/`home_lng` come pre-geocoded from the frontend's
    address column, not a placeholder — see BulkMusicianRow."""
    with using(ws):
        existing_max = max((int("".join(c for c in mid if c.isdigit()) or 0)
                            for mid in ws.data.musicians.index), default=0)
        musicians = [dict(
            musician_id=f"M{existing_max + i + 1:02d}", display_name=row.display_name, age=row.age,
            instrument=row.instrument, home_region=row.home_region, home_lat=row.home_lat, home_lng=row.home_lng,
            transport="car", can_drive=True, years_with_org=0.0, max_shows_per_month=2,
            min_songs=1, typical_songs=2, max_songs=3, phone=row.phone, email=row.email,
            guardian_name=row.guardian_name, guardian_phone=row.guardian_phone,
            brings_keyboard=False, household_id="", secondary_instruments="",
            _weekly_availability=[w.model_dump() for w in row.weekly_availability],
        ) for i, row in enumerate(req.musicians)]
        n = len(musicians)
        ws.mutate_data(lambda d: bulk_add_musicians(d, musicians),
                       f"{n} musician{'s' if n != 1 else ''} added to the roster from a bulk import.")
        return {"status": "ok", "added": n}


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


class BulkMarkUnavailableRequest(BaseModel):
    musician_ids: list[str]
    date: str


@app.post("/api/musicians/bulk-mark-unavailable")
def bulk_mark_unavailable(req: BulkMarkUnavailableRequest, ws: Workspace = Depends(get_workspace)):
    """Marks every one of these musicians unavailable for every upcoming show on `date` — a
    holiday or exam block hits everyone at once, so this is a group action, not one-by-one."""
    with using(ws):
        show_ids = ws.data.shows.index[(ws.data.shows.date == req.date) & (ws.data.shows.period == "upcoming")].tolist()
        pairs = [(m, s) for m in req.musician_ids for s in show_ids]
        n = len(show_ids)
        ws.mutate_data(lambda d: bulk_set_show_availability(d, pairs, False),
                       f"{len(req.musician_ids)} musicians marked unavailable for {n} show{'s' if n != 1 else ''} on {req.date}.")
        return {"status": "ok", "shows_affected": n}


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


class FacilityIn(BaseModel):
    facility_id: str
    display_name: str
    region: str
    lat: float
    lng: float
    show_duration_min: int = 60
    songs_per_show: int = 15
    preferred_slot: str = "Mon 18:30"
    target_musicians: int = 7
    min_musicians: int = 3
    max_musicians: int = 10
    has_piano_onsite: bool = True
    address: str = ""
    contact_name: str = ""
    contact_phone: str = ""
    parking_notes: str = ""
    piano_notes: str = ""
    load_in_buffer_min: int = 15
    max_per_car: int = 3


@app.post("/api/facilities")
def create_facility(facility: FacilityIn, ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.mutate_data(lambda d: add_facility(d, facility.model_dump()),
                       f"{facility.display_name} was added as a new location.")
        return {"status": "ok"}


@app.put("/api/facilities/{facility_id}")
def edit_facility(facility_id: str, changes: dict[str, Any] = Body(...), ws: Workspace = Depends(get_workspace)):
    with using(ws):
        ws.mutate_data(lambda d: update_facility(d, facility_id, changes),
                       lambda: f"{views._facility_name(ws, facility_id)}'s location record was updated.")
        return {"status": "ok"}


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
