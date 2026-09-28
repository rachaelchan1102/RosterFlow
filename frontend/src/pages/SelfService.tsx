import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { formatDate } from "../format";
import type { SelfServiceView } from "../types";

/** A musician's own page for their self-service link — no login, no nav, no coordinator tools.
 *  Deliberately outside AppProvider/Layout: this is the one screen in the app a musician opens
 *  directly, so it can't depend on any coordinator or playground session state. */
export default function SelfService() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<SelfServiceView | null>(null);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!token) return;
    api<SelfServiceView>(`/api/respond/${token}`)
      .then((v) => { setView(v); setAnswers(Object.fromEntries(v.shows.map((s) => [s.show_id, s.available]))); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load this page."));
  }, [token]);

  const byDate = useMemo(() => {
    if (!view) return [];
    const groups = new Map<string, typeof view.shows>();
    for (const s of view.shows) groups.set(s.date, [...(groups.get(s.date) ?? []), s]);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [view]);

  const changed = view ? view.shows.filter((s) => answers[s.show_id] !== s.available) : [];

  const save = () => {
    if (!token || changed.length === 0) return;
    setSaving(true);
    setError(null);
    api(`/api/respond/${token}`, {
      method: "POST",
      body: { responses: changed.map((s) => ({ show_id: s.show_id, available: answers[s.show_id] })) },
    }).then(() => {
      setView((v) => v && { ...v, shows: v.shows.map((s) => ({ ...s, available: answers[s.show_id] })) });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }).catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't save — try again."))
      .finally(() => setSaving(false));
  };

  if (error) return <div className="self-service"><p className="error">{error}</p></div>;
  if (!view) return <div className="self-service"><p className="muted">Loading…</p></div>;

  return (
    <div className="self-service">
      <h1>Hi {view.name.split(" ")[0]}</h1>
      <p className="muted">
        Mark which of these you can play. Anything left as-is keeps whatever's on file already —
        your usual weekly pattern, or an answer you gave before.
      </p>
      {view.shows.length === 0 && <p className="muted">Nothing on the calendar for you to answer right now.</p>}
      {byDate.map(([date, shows]) => (
        <section key={date} className="self-service-day">
          <h3>{formatDate(date)}</h3>
          {shows.map((s) => (
            <label key={s.show_id} className="self-service-row">
              <input type="checkbox" checked={answers[s.show_id] ?? s.available}
                     onChange={(e) => setAnswers({ ...answers, [s.show_id]: e.target.checked })} />
              <span>{s.facility_name} · {s.start_time}</span>
            </label>
          ))}
        </section>
      ))}
      {view.shows.length > 0 && (
        <div className="self-service-footer">
          <button className="button" onClick={save} disabled={changed.length === 0 || saving}>
            {saving ? "Saving…" : changed.length > 0 ? `Save ${changed.length} change${changed.length !== 1 ? "s" : ""}` : "Saved"}
          </button>
          {saved && <span className="self-service-saved">Got it — thanks!</span>}
        </div>
      )}
    </div>
  );
}
