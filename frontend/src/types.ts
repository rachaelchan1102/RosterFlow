export type Status = "red" | "amber" | "green";

export interface Kpis {
  fill_rate: number;
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

export interface ShowSummary {
  show_id: string;
  facility_id: string;
  facility_name: string;
  date: string;
  start_time: string;
  duration_min: number;
  status: Status;
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
  reasons: string[];
  coverage: {
    songs_total: number;
    songs_target: number;
    musician_count: number;
    min_musicians: number;
    target_musicians: number;
    has_pianist: boolean;
  };
  roster: {
    musician_id: string;
    name: string;
    instrument: string;
    age: number;
    songs: number;
    typical_songs: number;
    max_songs: number;
    locked: boolean;
  }[];
  backups: {
    rank: number;
    musician_id: string;
    name: string;
    instrument: string;
    is_pianist: boolean;
    reason: string;
  }[];
  cars: { driver: string; riders: string[]; distance_km: number }[];
  solo_transit: string[];
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
  playing: (ShowRef & { songs: number; locked: boolean })[];
  backing: (ShowRef & { rank: number })[];
  cap_usage: { month: string; playing: number; cap: number }[];
  weekly_availability: { weekday: string; start_time: string; end_time: string }[];
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
  show_duration_min: number;
  preferred_slot: string;
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
  cancelled: { musician_id: string; name: string };
  activated_backup: { musician_id: string; name: string } | null;
  extra_song_requests: { musician_id: string; name: string; add: number }[];
  suggested_musician: { musician_id: string; name: string; songs: number; is_pianist: boolean } | null;
  songs_covered: number;
  songs_target: number;
  musician_count: number;
  min_musicians: number;
  has_pianist: boolean;
  needs_attention: boolean;
}
