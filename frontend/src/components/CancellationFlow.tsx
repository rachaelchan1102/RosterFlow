import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp, usePanelTitle } from "../AppState";
import { formatDate } from "../format";
import { backupAskMessage, copyToClipboard } from "../messageTemplates";
import type { CancellationPlan, Musician, MusicianProfile, ScheduleView, ShowDetail, ShowSummary } from "../types";
import Combobox from "./Combobox";
import { GuardianContact } from "./ShowPanel";
import { CoverageBar, StatusBadge } from "./Status";

/** The three-step "someone can't make it" flow. Used as a stacked panel — on top of a show (a
 *  show is already picked) or opened fresh from the top bar's "Report cancellation" quick action
 *  (nothing picked yet, so the Show dropdown shows too) — and as the whole Cancellations page.
 *  All three steps are visible from the start so the shape of the flow is clear; later ones stay
 *  greyed until reached. */
/** "+3" / "−3" with a real minus sign, and "+$7.68" / "−$7.68" rather than "$-7.68". */
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;
const signedDollars = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;

export default function CancellationFlow({ initialShowId = "", initialMusicianId = "", inPanel = false }: {
  initialShowId?: string; initialMusicianId?: string; inPanel?: boolean;
}) {
  const { version, refresh, openPanel, backPanel, showToast, confirm } = useApp();
  usePanelTitle(inPanel ? "Report cancellation" : null);
  const [showId, setShowId] = useState(initialShowId);
  const [musicianId, setMusicianId] = useState(initialMusicianId);
  const showPicker = !initialShowId;   // no show handed to us — show the dropdown, wherever this renders
  // From opening this flow to pressing Apply — a real, honestly-measured "time to fill" (see
  // UI_Supply_Chain2.md Part 1 item 7), sent along with the apply request.
  const openedAt = useRef(0);
  useEffect(() => { openedAt.current = Date.now(); }, []);

  const [shows, setShows] = useState<ShowSummary[]>([]);
  const [allMusicians, setAllMusicians] = useState<Musician[]>([]);
  // Set only when a musician was picked BEFORE a show — narrows the Show dropdown down to just
  // their own upcoming shows (usually 1-2), instead of leaving it as a scroll through all of them.
  const [musicianShows, setMusicianShows] = useState<{ musician_id: string; shows: MusicianProfile["playing"] } | null>(null);
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
    if (!showPicker) return;
    api<ScheduleView>("/api/schedule").then((v) => setShows(v.shows));
  }, [version, showPicker]);

  useEffect(() => {
    api<Musician[]>("/api/musicians").then(setAllMusicians);
  }, [version]);

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

  const copyAskMessage = (backupName: string) => {
    if (!detail) return;
    copyToClipboard(backupAskMessage(backupName, detail.facility_name, detail.date, detail.start_time))
      .then((ok) => showToast(ok ? "Message copied" : "Couldn't copy — try again"));
  };

  const reset = (next: { show?: string; musician?: string }) => {
    if (next.show !== undefined) { setShowId(next.show); setMusicianId(""); setMusicianShows(null); }
    if (next.musician !== undefined) setMusicianId(next.musician);
    pick("auto");
    setApplied(null);
    setError(null);
  };

  // Starting from the person instead of the show — a musician saying "I can't make Saturday" is
  // the more natural direction than picking the show first and hunting them in its roster.
  const pickMusicianFirst = (id: string) => {
    setError(null);
    api<MusicianProfile>(`/api/musicians/${id}/profile`).then((p) => {
      setMusicianShows({ musician_id: id, shows: p.playing });
      setMusicianId(id);
      setShowId(p.playing.length === 1 ? p.playing[0].show_id : "");
      pick("auto");
      setApplied(null);
    }).catch((e) => setError(e.message));
  };

  const apply = async () => {
    if (effective?.short) {
      const ok = await confirm({
        title: "Coverage will still be short",
        body: effective.pianist
          ? "This show will still be below the minimum musician count after this change."
          : "This show will have no pianist after this change.",
        confirmLabel: "Apply anyway",
        hint: "You can still fix it another way afterward.",
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    api<CancellationPlan>("/api/cancellations/apply", {
      method: "POST",
      body: { show_id: showId, musician_id: musicianId, backup_choice: choice,
              accept_extra_songs: acceptSongs, add_suggested_musician: addSuggested,
              fill_seconds: (Date.now() - openedAt.current) / 1000 },
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
          {applied.activated_backup ? `, ${applied.activated_backup.name} has been asked — waiting to hear back` : ""}.
          The show's backups were re-ranked.
          {applied.activated_backup && (
            <p className="small muted block" style={{ marginTop: 6 }}>
              They won't count toward the show until you confirm they've said yes — do that from the show's panel.
            </p>
          )}
          <div className="panel-footer">
            {inPanel ? (
              // Only actually a "back" if we arrived from the show's own panel (it's under us
              // in the stack); opened fresh from the top bar's quick action, there's nothing to
              // go back TO, so backPanel would just close everything with the show never shown.
              initialShowId ? (
                <button className="button" onClick={backPanel}>Back to the show</button>
              ) : (
                <button className="button" onClick={() => openPanel({ kind: "show", id: applied.show_id })}>View the show</button>
              )
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
            {showPicker && (
              <label>Show
                <Combobox value={showId} onChange={(v) => reset({ show: v })} placeholder="Search shows…"
                          options={(musicianShows ? shows.filter((s) => musicianShows.shows.some((p) => p.show_id === s.show_id)) : shows)
                            .map((s) => ({ value: s.show_id, label: `${s.facility_name}`,
                                          sublabel: `${formatDate(s.date)} · ${s.start_time}` }))} />
                {musicianShows && (
                  <span className="small muted">
                    {musicianShows.shows.length === 0 ? "Not on any upcoming show."
                      : `Showing just their ${musicianShows.shows.length} upcoming show${musicianShows.shows.length !== 1 ? "s" : ""}.`}
                  </span>
                )}
              </label>
            )}
            <label>Who cancelled
              <Combobox value={musicianId} onChange={(v) => (detail ? reset({ musician: v }) : pickMusicianFirst(v))}
                        placeholder="Search musicians…"
                        options={detail
                          ? detail.roster.map((m) => ({ value: m.musician_id, label: m.name,
                                                        sublabel: `${m.instrument} · ${m.songs} songs` }))
                          : allMusicians.map((m) => ({ value: m.musician_id, label: m.display_name,
                                                       sublabel: m.instrument }))} />
            </label>
          </div>
          {detail && <p className="small muted">Currently <StatusBadge status={detail.status} label={detail.status_label} /> · {detail.roster.length} playing · {detail.backups.length} backups</p>}
        </div>
      </div>

      {(error || previewError) && <p className="error">{error ?? previewError}</p>}

      <div className={`step ${step2Ready ? "" : "pending"}`}>
        <span className="step-number">2</span>
        <div className="step-body">
          <h3>Who to call{cancelledName ? ` in for ${cancelledName}` : ""}</h3>
          {!step2Ready ? (
            <p className="small muted">Pick {showId ? "who cancelled" : "the show and who cancelled"} first — the ranked backups show up here.</p>
          ) : (
            <>
              {autoPick && (
                <div className="callout" style={{ marginBottom: 10 }}>
                  <strong>Recommended: {detail!.backups.find((b) => b.musician_id === autoPick)?.name}</strong>
                  <span className="small muted block">{detail!.backups.find((b) => b.musician_id === autoPick)?.reason}</span>
                </div>
              )}
              <p className="small muted">A backup plays their usual songs, not the cancelled musician's set.</p>
              <div className="choice-list">
                {detail!.backups.map((b) => {
                  const selected = choice === b.musician_id || autoPick === b.musician_id;
                  return (
                    <label key={b.musician_id} className={`choice ${selected ? "selected" : ""}`}>
                      <input type="radio" name="backup" checked={selected} onChange={() => pick(b.musician_id)} />
                      <span>
                        <strong>#{b.rank} {b.name}</strong> {b.is_pianist && <span className="tag">pianist</span>}
                        {autoPick === b.musician_id && <span className="tag recommended">recommended</span>}
                        {(b.phone || b.email) && (
                          <span className="small muted block contact-links" onClick={(e) => e.stopPropagation()}>
                            {b.phone && <a href={`tel:${b.phone}`}>{b.phone}</a>}
                            {b.phone && b.email && " · "}
                            {b.email && <a href={`mailto:${b.email}`}>{b.email}</a>}
                          </span>
                        )}
                        <span onClick={(e) => e.stopPropagation()}>
                          <GuardianContact age={b.age} guardianName={b.guardian_name} guardianPhone={b.guardian_phone} />
                        </span>
                        <span className="small muted block">{b.reason}</span>
                        <button className="link-button small" onClick={(e) => { e.stopPropagation(); e.preventDefault(); copyAskMessage(b.name); }}>
                          Copy a message to ask them
                        </button>
                      </span>
                    </label>
                  );
                })}
                <label className={`choice ${choice === "none" ? "selected" : ""}`}>
                  <input type="radio" name="backup" checked={choice === "none"} onChange={() => pick("none")} />
                  <span><strong>Don't call a backup</strong>
                    <span className="small muted block">Ask the musicians already on the show to add songs instead.</span></span>
                </label>
                {(() => {
                  const excluded = new Set([...detail!.roster.map((m) => m.musician_id), ...detail!.backups.map((b) => b.musician_id)]);
                  const candidates = allMusicians.filter((m) => !excluded.has(m.musician_id));
                  const manualPick = candidates.find((m) => m.musician_id === choice);
                  return (
                    <label className={`choice ${manualPick ? "selected" : ""}`}>
                      <input type="radio" name="backup" checked={Boolean(manualPick)} readOnly />
                      <span>
                        <strong>Someone else</strong>
                        <span className="small muted block">Not on the ranked list — still checked for availability that day.</span>
                        <Combobox value={manualPick?.musician_id ?? ""} onChange={(v) => { if (v) pick(v); }}
                                  placeholder="Search the full roster…"
                                  options={candidates.map((m) => ({ value: m.musician_id, label: m.display_name,
                                                                     sublabel: `${m.instrument} · ${m.home_region}` }))} />
                      </span>
                    </label>
                  );
                })()}
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
            <p className="small muted">
              {previewKey && preview?.key !== previewKey
                ? "Checking coverage for this pick…"
                : "Songs, headcount and pianist cover for the show once someone's picked to call."}
            </p>
          ) : (
            <>
              {plan.warnings.map((w) => <p key={w} className="callout amber small">{w}</p>)}
              {plan.activated_backup && (
                <>
                  <p className="small muted">Assumes {plan.activated_backup.name} says yes — the show stays short until they confirm.</p>
                  <p className="small">
                    {plan.cancelled.name} ({plan.cancelled.distance_km} km) replaced by {plan.activated_backup.name} ({plan.activated_backup.distance_km} km)
                    {" — "}
                    <span className={plan.activated_backup.km_delta > 0 ? "error" : ""}>
                      {signed(plan.activated_backup.km_delta)} km, {signedDollars(plan.activated_backup.cost_delta)}
                    </span>
                  </p>
                  {plan.activated_backup.pooled_with.length > 0 && (
                    <p className="small muted">Could pool with {plan.activated_backup.pooled_with.join(", ")} — both live within 5 km of each other.</p>
                  )}
                </>
              )}
              <CoverageBar label="Songs covered" value={effective.songs} target={plan.songs_target}
                           status={effective.songs >= plan.songs_target ? "green" : "red"} />
              <p className="small">
                {effective.count} musicians (minimum {plan.min_musicians}) · {effective.pianist ? "✓ pianist covered" : "✕ no pianist"}
              </p>

              {plan.extra_song_requests.length > 0 && (
                <label className="checkbox-label block">
                  <input type="checkbox" checked={acceptSongs} onChange={(e) => setAcceptSongs(e.target.checked)} />
                  {"Songs covered above already counts on this — uncheck if you haven't actually asked yet. "}
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
                  {busy ? "Applying…" : plan.activated_backup ? `Call ${plan.activated_backup.name} in, record cancellation` : "Record cancellation, no backup"}
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
