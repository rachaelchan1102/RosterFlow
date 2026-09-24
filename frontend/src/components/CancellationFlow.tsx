import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp, usePanelTitle } from "../AppState";
import { formatDate } from "../format";
import type { CancellationPlan, ScheduleView, ShowDetail, ShowSummary } from "../types";
import { CoverageBar, StatusBadge } from "./Status";

/** The three-step "someone can't make it" flow. Used as a stacked panel on top of a show (so the
 *  calendar stays exactly where it was) and as the whole Cancellations page. All three steps are
 *  visible from the start so the shape of the flow is clear; later ones stay greyed until reached. */
export default function CancellationFlow({ initialShowId = "", initialMusicianId = "", inPanel = false }: {
  initialShowId?: string; initialMusicianId?: string; inPanel?: boolean;
}) {
  const { version, refresh, openPanel, backPanel, showToast } = useApp();
  usePanelTitle(inPanel ? "Report cancellation" : null);
  const [showId, setShowId] = useState(initialShowId);
  const [musicianId, setMusicianId] = useState(initialMusicianId);

  const [shows, setShows] = useState<ShowSummary[]>([]);
  // Each fetched result is kept with the request it answers, so nothing stale is ever shown.
  const [loadedDetail, setLoadedDetail] = useState<{ showId: string; detail: ShowDetail } | null>(null);
  const [choice, setChoice] = useState<string>("auto");
  const [preview, setPreview] = useState<{ key: string; plan: CancellationPlan | null; error: string | null } | null>(null);
  const [acceptSongs, setAcceptSongs] = useState(true);
  const [addSuggested, setAddSuggested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<CancellationPlan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (inPanel) return;
    api<ScheduleView>("/api/schedule").then((v) => setShows(v.shows));
  }, [version, inPanel]);

  useEffect(() => {
    if (!showId) return;
    api<ShowDetail>(`/api/shows/${showId}/detail`)
      .then((detail) => setLoadedDetail({ showId, detail }))
      .catch((e) => setError(e.message));
  }, [showId, version]);
  const detail = loadedDetail?.showId === showId ? loadedDetail.detail : null;

  const previewKey = showId && musicianId && !applied ? `${showId}|${musicianId}|${choice}` : null;
  useEffect(() => {
    if (!previewKey) return;
    const [show_id, musician_id, backup_choice] = previewKey.split("|");
    api<CancellationPlan>("/api/cancellations/preview", { method: "POST", body: { show_id, musician_id, backup_choice } })
      .then((plan) => setPreview({ key: previewKey, plan, error: null }))
      .catch((e) => setPreview({ key: previewKey, plan: null, error: e.message }));
  }, [previewKey]);
  const plan = preview?.key === previewKey ? preview.plan : null;
  const previewError = preview?.key === previewKey ? preview.error : null;

  const pick = (next: string) => { setChoice(next); setAddSuggested(false); };

  const reset = (next: { show?: string; musician?: string }) => {
    if (next.show !== undefined) { setShowId(next.show); setMusicianId(""); }
    if (next.musician !== undefined) setMusicianId(next.musician);
    pick("auto");
    setApplied(null);
    setError(null);
  };

  const apply = () => {
    setBusy(true);
    setError(null);
    api<CancellationPlan>("/api/cancellations/apply", {
      method: "POST",
      body: { show_id: showId, musician_id: musicianId, backup_choice: choice,
              accept_extra_songs: acceptSongs, add_suggested_musician: addSuggested },
    }).then((p) => {
      setApplied(p);
      showToast("Cancellation recorded");
      refresh();
    }).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  const autoPick = plan && choice === "auto" ? plan.activated_backup?.musician_id : null;

  // The plan's totals assume the extra songs are accepted and the optional suggestion isn't;
  // recompute from what's actually ticked so the numbers always match what "apply" will do.
  const effective = plan && (() => {
    const extras = plan.extra_song_requests.reduce((sum, r) => sum + r.add, 0);
    const suggested = addSuggested ? plan.suggested_musician : null;
    const songs = plan.songs_covered - (acceptSongs ? 0 : extras) + (suggested?.songs ?? 0);
    const count = plan.musician_count + (suggested ? 1 : 0);
    const pianist = plan.has_pianist || Boolean(suggested?.is_pianist);
    return { songs, count, pianist, short: songs < plan.songs_target || count < plan.min_musicians || !pianist };
  })();

  const cancelledName = detail?.roster.find((m) => m.musician_id === musicianId)?.name;
  const step2Ready = Boolean(detail && musicianId && !applied);
  const step3Ready = Boolean(plan && effective && !applied);

  if (applied) {
    return (
      <div className={inPanel ? "panel-body" : ""}>
        <div className="callout green">
          <strong>Done.</strong> {applied.cancelled.name} is off the show
          {applied.activated_backup ? `, ${applied.activated_backup.name} is on` : ""}. The show's backups were
          re-ranked.
          <div className="panel-footer">
            {inPanel ? (
              <button className="button" onClick={backPanel}>Back to the show</button>
            ) : (
              <>
                <button className="button secondary" onClick={() => openPanel({ kind: "show", id: applied.show_id })}>View the show</button>
                <button className="button secondary" onClick={() => reset({ show: "" })}>Handle another</button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={inPanel ? "panel-body cancellation-flow in-panel" : "cancellation-flow"}>
      {inPanel && (
        <div className="panel-title">
          <h2>Report cancellation</h2>
          {detail && <p className="muted">{detail.facility_name} · {formatDate(detail.date)} · {detail.start_time}</p>}
        </div>
      )}

      <div className="step">
        <span className="step-number">1</span>
        <div className="step-body">
          <h3>Who can't make it</h3>
          <div className="form-row">
            {!inPanel && (
              <label>Show
                <select value={showId} onChange={(e) => reset({ show: e.target.value })}>
                  <option value="">Choose a show…</option>
                  {shows.map((s) => (
                    <option key={s.show_id} value={s.show_id}>{formatDate(s.date)} · {s.start_time} · {s.facility_name}</option>
                  ))}
                </select>
              </label>
            )}
            <label>Who cancelled
              <select value={musicianId} disabled={!detail} onChange={(e) => reset({ musician: e.target.value })}>
                <option value="">Choose a musician…</option>
                {detail?.roster.map((m) => (
                  <option key={m.musician_id} value={m.musician_id}>{m.name} · {m.instrument} · {m.songs} songs</option>
                ))}
              </select>
            </label>
          </div>
          {detail && <p className="small muted">Currently <StatusBadge status={detail.status} /> · {detail.roster.length} playing · {detail.backups.length} backups</p>}
        </div>
      </div>

      {(error || previewError) && <p className="error">{error ?? previewError}</p>}

      <div className={`step ${step2Ready ? "" : "pending"}`}>
        <span className="step-number">2</span>
        <div className="step-body">
          <h3>Who to call{cancelledName ? ` in for ${cancelledName}` : ""}</h3>
          {!step2Ready ? (
            <p className="small muted">Pick {showId || inPanel ? "who cancelled" : "the show and who cancelled"} first — the ranked backups show up here.</p>
          ) : (
            <>
              <p className="small muted">A backup plays their own usual set — not the cancelled person's exact songs — so the song count can change.</p>
              <div className="choice-list">
                {detail!.backups.map((b) => {
                  const selected = choice === b.musician_id || autoPick === b.musician_id;
                  return (
                    <label key={b.musician_id} className={`choice ${selected ? "selected" : ""}`}>
                      <input type="radio" name="backup" checked={selected} onChange={() => pick(b.musician_id)} />
                      <span>
                        <strong>#{b.rank} {b.name}</strong> {b.is_pianist && <span className="tag">pianist</span>}
                        {autoPick === b.musician_id && <span className="tag recommended">recommended</span>}
                        <span className="small muted block">{b.reason}</span>
                      </span>
                    </label>
                  );
                })}
                <label className={`choice ${choice === "none" ? "selected" : ""}`}>
                  <input type="radio" name="backup" checked={choice === "none"} onChange={() => pick("none")} />
                  <span><strong>Don't call a backup</strong>
                    <span className="small muted block">Ask the musicians already on the show to add songs instead.</span></span>
                </label>
              </div>
            </>
          )}
        </div>
      </div>

      <div className={`step ${step3Ready ? "" : "pending"}`}>
        <span className="step-number">3</span>
        <div className="step-body">
          <h3>What that leaves</h3>
          {!step3Ready || !plan || !effective ? (
            <p className="small muted">Songs, headcount and pianist cover for the show once someone's picked to call.</p>
          ) : (
            <>
              {plan.warnings.map((w) => <p key={w} className="callout amber small">{w}</p>)}
              <CoverageBar label="Songs covered" value={effective.songs} target={plan.songs_target}
                           status={effective.songs >= plan.songs_target ? "green" : "red"} />
              <p className="small">
                {effective.count} musicians (minimum {plan.min_musicians}) · {effective.pianist ? "✓ pianist covered" : "✕ no pianist"}
              </p>

              {plan.extra_song_requests.length > 0 && (
                <label className="checkbox-label block">
                  <input type="checkbox" checked={acceptSongs} onChange={(e) => setAcceptSongs(e.target.checked)} />
                  Ask for extra songs (most room first):{" "}
                  {plan.extra_song_requests.map((r) => `${r.name} +${r.add}`).join(", ")}
                </label>
              )}
              {plan.suggested_musician && (
                <label className="checkbox-label block">
                  <input type="checkbox" checked={addSuggested} onChange={(e) => setAddSuggested(e.target.checked)} />
                  Also add {plan.suggested_musician.name} (+{plan.suggested_musician.songs} songs) — free that day but not on the backup list
                </label>
              )}
              {effective.short && (
                <div className="callout red">
                  <strong>Still short after all of that.</strong> This needs a person's call — try someone outside the list,
                  shorten the set, or talk to the location.
                </div>
              )}
              <div className="panel-footer">
                <button className="button" onClick={apply} disabled={busy}>
                  {busy ? "Applying…" : plan.activated_backup ? `Call ${plan.activated_backup.name} in` : "Apply"}
                </button>
                {inPanel && <button className="button secondary" onClick={backPanel}>Never mind</button>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
