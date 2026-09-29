export type Status = "red" | "amber" | "green";

export interface Kpis {
  /** % of shows at their full TARGET headcount, songs covered, and a pianist present. */
  fill_rate: number;
  /** % of shows that at least cleared the minimum operational floor (a lower, looser bar than
   *  fill_rate — a show can clear this and still not be "fully staffed" in the fill_rate sense). */
  minimum_met_rate: number;
  backup_coverage: number;
  capacity_utilization_mean: number;
  capacity_utilization_spread: number;
  total_cars: number;
  total_car_km: number;
  guardian_car_km: number;
  peer_car_km: number;
  car_km_savings: number;
  solo_transit_count: number;
  rotation_repeat_rate: number;
  mileage_rate: number;
  car_cost_total: number;
  car_cost_savings: number;
}

export interface Change {
  change: "added" | "removed";
  musician_id: string;
  musician_name: string;
  show_id: string;
  date: string | null;
  start_time: string | null;
  facility_name: string | null;
  reason: string;
}

/** A show still critically short (below minimum headcount, or zero backups) right after an
 *  update — the resolve endpoint's honest counterpart to "changes": there being nothing to
 *  report there doesn't mean nothing's wrong. */
export interface StillShort {
  show_id: string;
  facility_name: string;
  date: string;
  start_time: string;
  reasons: string[];
}

export interface ShowSummary {
  show_id: string;
  facility_id: string;
  facility_name: string;
  date: string;
  start_time: string;
  duration_min: number;
  status: Status;
  status_label: string;
  reasons: string[];
  musician_count: number;
  target_musicians: number;
  songs_total: number;
  songs_target: number;
  has_pianist: boolean;
  backup_count: number;
  backup_ready: boolean;
  locked_count: number;
}

export interface ScheduleView {
  state: {
    needs_resolve: string | null;
    last_resolve_changes: Change[];
  };
  kpis: Kpis;
  shows: ShowSummary[];
  weekly_capacity: { week: string; needed: number; available: number }[];
}

export interface ShowDetail {
  show_id: string;
  facility_id: string;
  facility_name: string;
  region: string;
  date: string;
  start_time: string;
  duration_min: number;
  has_piano_onsite: boolean;
  status: Status;
  status_label: string;
  reasons: string[];
  coverage: {
    pianist_count: number;
    songs_total: number;
    songs_target: number;
    musician_count: number;
    min_musicians: number;
    target_musicians: number;
    has_pianist: boolean;
  };
  piano_warning: string | null;
  roster: {
    musician_id: string;
    name: string;
    instrument: string;
    age: number;
    songs: number;
    typical_songs: number;
    max_songs: number;
    locked: boolean;
    confirmed: boolean;
    phone: string;
    email: string;
    guardian_name: string;
    guardian_phone: string;
    song_title: string;
    song_title_duplicate: boolean;
    brings_keyboard: boolean;
    outside_availability: boolean;
  }[];
  backups: {
    rank: number;
    musician_id: string;
    name: string;
    age: number;
    instrument: string;
    is_pianist: boolean;
    phone: string;
    email: string;
    guardian_name: string;
    guardian_phone: string;
    reason: string;
  }[];
  cars: { driver: string; riders: string[]; distance_km: number }[];
  solo_transit: { musician_id: string; name: string; distance_km: number; est_minutes: number; long_trip: boolean }[];
  pending_call: { musician_id: string; name: string; age: number; phone: string; email: string; guardian_name: string; guardian_phone: string } | null;
  facility: { address: string; contact_name: string; contact_phone: string; parking_notes: string; piano_notes: string;
             load_in_buffer_min: number; max_per_car: number };
  attendance: Record<string, "attended" | "late_cancel" | "no_show">;
}

export interface VolunteerHours {
  musician_id: string;
  name: string;
  total_hours: number;
  shows_attended: number;
  shows: { show_id: string; date: string; facility_name: string; minutes: number }[];
}

export interface ShowRef {
  show_id: string;
  date: string;
  facility_name: string;
}

export interface MusicianProfile {
  musician_id: string;
  name: string;
  age: number;
  instrument: string;
  home_region: string;
  transport: string;
  can_drive: boolean;
  years_with_org: number;
  typical_songs: number;
  max_songs: number;
  max_shows_per_month: number;
  playing: (ShowRef & { songs: number; locked: boolean; outside_availability: boolean })[];
  backing: (ShowRef & { rank: number })[];
  cap_usage: { month: string; playing: number; cap: number }[];
  weekly_availability: { weekday: string; start_time: string; end_time: string }[];
  phone: string;
  email: string;
  guardian_name: string;
  guardian_phone: string;
  brings_keyboard: boolean;
  secondary_instruments: string;
}

export interface Musician {
  musician_id: string;
  display_name: string;
  age: number;
  instrument: string;
  home_region: string;
  home_lat: number;
  home_lng: number;
  transport: string;
  can_drive: boolean;
  years_with_org: number;
  max_shows_per_month: number;
  min_songs: number;
  typical_songs: number;
  max_songs: number;
  phone: string;
  email: string;
  guardian_name: string;
  guardian_phone: string;
  brings_keyboard: boolean;
  household_id: string;
  secondary_instruments: string;
}

export interface Show {
  show_id: string;
  facility_id: string;
  date: string;
  start_time: string;
  duration_min: number;
  period: string;
}

export interface Facility {
  facility_id: string;
  display_name: string;
  region: string;
  lat: number;
  lng: number;
  show_duration_min: number;
  songs_per_show: number;
  preferred_slot: string;
  target_musicians: number;
  min_musicians: number;
  max_musicians: number;
  has_piano_onsite: boolean;
  address: string;
  contact_name: string;
  contact_phone: string;
  parking_notes: string;
  piano_notes: string;
  load_in_buffer_min: number;
  max_per_car: number;
}

export interface NetworkFacility {
  show_id: string;
  facility_id: string;
  name: string;
  lat: number;
  lng: number;
  start_time: string;
  status: Status;
  musician_count: number;
  target_musicians: number;
}

export interface NetworkRoute {
  musician_id: string;
  name: string;
  show_id: string;
  from_lat: number;
  from_lng: number;
  to_lat: number;
  to_lng: number;
  group: string;
  mode: "car" | "guardian" | "transit";
  is_driver: boolean;
}

export interface NetworkView {
  date: string | null;
  facilities: NetworkFacility[];
  routes: NetworkRoute[];
}


export interface FlowNode {
  id: string;
  label: string;
  kind: "region" | "facility";
}

export interface FlowLink {
  source: string;
  target: string;
  value: number;
  avg_km: number;
  total_km: number;
}

export interface FlowView {
  nodes: FlowNode[];
  links: FlowLink[];
}

export interface MusicianUtilization {
  musician_id: string;
  name: string;
  played: number;
  capacity: number;
  /** The calendar month `played`/`capacity` are measured against (their worst month, "2026-10"),
   *  or null if they aren't on any upcoming show. */
  month: string | null;
  utilization: number;
}

export interface FacilityUtilization {
  facility_id: string;
  name: string;
  shows: number;
  avg_musicians: number;
  target_musicians: number;
  preferred_slot: string;
  utilization: number;
}

export interface UtilizationView {
  musicians: MusicianUtilization[];
  facilities: FacilityUtilization[];
}

export interface Feasibility {
  date: string;
  probability_fully_staffed: number;
  eligible_pool_size: number;
  excluded_day_conflict: number;
  excluded_over_cap: number;
  excluded_guardian_range: number;
  excluded_time: number;
  mean_available_count: number;
  mean_available_songs: number;
}

export interface CancellationPlan {
  warnings: string[];
  show_id: string;
  cancelled: { musician_id: string; name: string; distance_km: number };
  activated_backup: { musician_id: string; name: string; distance_km: number; km_delta: number; cost_delta: number; pooled_with: string[] } | null;
  extra_song_requests: { musician_id: string; name: string; add: number }[];
  suggested_musician: { musician_id: string; name: string; songs: number; is_pianist: boolean } | null;
  songs_covered: number;
  songs_target: number;
  musician_count: number;
  min_musicians: number;
  has_pianist: boolean;
  needs_attention: boolean;
}

export interface ActivityEntry {
  id: number;
  at: string;
  description: string;
  fill_seconds: number | null;
  /** Who made the change, as typed at login — null for sample data and self-service links. */
  by: string | null;
}

export interface CapacityForecastRow {
  month: string;
  needed: number;
  available: number;
  target_roster_size: number | null;
}

export interface RevertResult {
  needs_confirmation: boolean;
  later?: string[];
  status?: string;
}

export interface SelfServiceShow {
  show_id: string;
  facility_name: string;
  date: string;
  start_time: string;
  available: boolean;
}

export interface SelfServiceView {
  musician_id: string;
  name: string;
  shows: SelfServiceShow[];
}

export interface FacilityDemandForecast {
  facility_id: string;
  name: string;
  region: string;
  preferred_slot: string;
  target_musicians: number;
  avg_shows_per_month: number;
  projected_next_month: number;
  months_of_history: number;
}

export interface CrossingSwap {
  date: string;
  show_a: string;
  show_b: string;
  facility_a: string;
  facility_b: string;
  musician_a: { musician_id: string; name: string };
  musician_b: { musician_id: string; name: string };
  savings_km: number;
}

export interface SlotCollision {
  slot: string;
  weekday: string;
  start_time: string;
  facilities: { facility_id: string; name: string; target_musicians: number }[];
  free_pool_size: number;
  total_demand: number;
  headroom: number;
}

export interface ProblemLocation {
  facility_id: string;
  name: string;
  shows: number;
  avg_musicians: number;
  target_musicians: number;
  summary: string;
  suggestion: string | null;
}
