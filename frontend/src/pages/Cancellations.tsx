import { useSearchParams } from "react-router-dom";
import CancellationFlow from "../components/CancellationFlow";

export default function Cancellations() {
  // ?show=&musician= still pre-fills the flow, so a link straight to a cancellation keeps working.
  const [params] = useSearchParams();
  return (
    <div className="cancellation-page">
      <h1>Handle a cancellation</h1>
      <p className="subtitle">Someone can't make it. Pick the show and who dropped out — you'll see who to call and what's left to cover.</p>
      <CancellationFlow initialShowId={params.get("show") ?? ""} initialMusicianId={params.get("musician") ?? ""} />
    </div>
  );
}
