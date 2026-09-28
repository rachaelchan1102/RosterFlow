"""Phase 7: the metrics/KPI layer — SPEC.md sections 12.1 (control tower) and 13.

This layer only reads what the layers below it already computed (assignment, carpool, backups)
— it runs no new optimization or simulation of its own. Its job is purely aggregation: turn
those separate outputs into the control tower's per-show flags table and headline KPI numbers.
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from optimizer.assignment import AssignmentResult
from optimizer.backups import BackupResult
from optimizer.carpool import Car, SoloTransit
from optimizer.data import Data

ROTATION_LOOKBACK_MONTHS = 3


@dataclass
class Kpis:
    fill_rate: float                    # % of shows at their full TARGET headcount, songs and pianist
    minimum_met_rate: float             # % of shows that at least cleared the minimum operational floor
    backup_coverage: float              # % of shows with 3 backups incl. a pianist
    capacity_utilization_mean: float    # share of monthly cap used, averaged across musicians
    capacity_utilization_spread: float  # std dev across musicians -> the fairness spread indicator
    total_cars: int
    total_car_km: float
    guardian_car_km: float
    peer_car_km: float
    car_km_savings: float                # naive "everyone drives themselves" km minus actual car-km
    solo_transit_count: int
    rotation_repeat_rate: float           # % of assignments that are repeat facility visits


def compute_capacity_utilization(data: Data, assignments: pd.DataFrame) -> tuple[float, float, pd.Series]:
    show_dates = data.shows.loc[assignments.show_id.unique(), "date"]
    months = pd.to_datetime(show_dates).dt.to_period("M").nunique() or 1
    played = assignments.groupby("musician_id").size()
    caps = data.musicians["max_shows_per_month"] * months
    utilization = (played.reindex(data.musicians.index, fill_value=0) / caps).clip(upper=1.0)
    return float(utilization.mean()), float(utilization.std(ddof=0)), utilization


def compute_network_cost(cars: list[Car], solo_transit: list[SoloTransit]) -> dict:
    total_car_km = sum(c.distance_km for c in cars)
    guardian_km = sum(c.distance_km for c in cars if c.driver_id is None)
    peer_km = total_car_km - guardian_km
    # Baseline for "savings": what it would cost if every rider in every car made that same trip
    # alone, instead of sharing it. distance_km is already per-car (not per-person), so the
    # solo-equivalent is that distance times how many people are in the car.
    naive_km = sum(c.distance_km * len(c.musician_ids) for c in cars)
    return dict(total_cars=len(cars), total_car_km=total_car_km, guardian_car_km=guardian_km,
               peer_car_km=peer_km, car_km_savings=naive_km - total_car_km,
               solo_transit_count=len(solo_transit))


def compute_rotation_rate(data: Data, assignments: pd.DataFrame) -> float:
    """% of assignments that are repeat visits to the same facility — either within recent
    history (same lookback window assignment.py uses for its rotation penalty) or more than
    once within this solve's own horizon."""
    show_facility = data.shows["facility_id"]
    hist = data.history_assignments.merge(data.shows[["facility_id", "date"]], left_on="show_id", right_index=True)
    hist = hist[hist.status == "attended"]

    horizon_start = pd.to_datetime(data.shows.loc[assignments.show_id.unique(), "date"]).min()
    cutoff = horizon_start - pd.DateOffset(months=ROTATION_LOOKBACK_MONTHS)
    recent_pairs = set(zip(hist.loc[pd.to_datetime(hist.date) >= cutoff, "musician_id"],
                           hist.loc[pd.to_datetime(hist.date) >= cutoff, "facility_id"]))

    seen: set[tuple[str, str]] = set()
    repeat_flags = []
    for row in assignments.itertuples():
        fac = show_facility[row.show_id]
        key = (row.musician_id, fac)
        repeat_flags.append(key in recent_pairs or key in seen)
        seen.add(key)
    return float(pd.Series(repeat_flags).mean()) if repeat_flags else 0.0


def compute_kpis(data: Data, assignment_result: AssignmentResult, cars: list[Car],
                 solo_transit: list[SoloTransit], backup_result: BackupResult) -> Kpis:
    util_mean, util_spread, _ = compute_capacity_utilization(data, assignment_result.assignments)
    net = compute_network_cost(cars, solo_transit)
    return Kpis(
        fill_rate=float(assignment_result.show_flags.at_target.mean()),
        minimum_met_rate=float(assignment_result.show_flags.fully_staffed.mean()),
        backup_coverage=float(backup_result.show_flags.backup_ready.mean()),
        capacity_utilization_mean=util_mean, capacity_utilization_spread=util_spread,
        total_cars=net["total_cars"], total_car_km=net["total_car_km"],
        guardian_car_km=net["guardian_car_km"], peer_car_km=net["peer_car_km"],
        car_km_savings=net["car_km_savings"], solo_transit_count=net["solo_transit_count"],
        rotation_repeat_rate=compute_rotation_rate(data, assignment_result.assignments),
    )
