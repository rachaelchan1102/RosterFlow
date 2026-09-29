"""Solve the sample dataset once and save the result next to it, so the playground starts
instantly instead of every fresh copy of the backend spending 15-20s on the same solve.

    python -m backend.build_playground_draft

Re-run after changing anything in sample_data/. Until you do, the backend notices the saved solve
no longer matches the CSVs (see sample_data_fingerprint) and falls back to solving at startup.
"""
import json

from backend.main import SAMPLE_DATA_DIR
from backend.registry import PLAYGROUND_DRAFT_FILE, sample_data_fingerprint
from backend.workspace import Workspace
from optimizer.data import load_from_csv


def main() -> None:
    ws = Workspace(load_from_csv(SAMPLE_DATA_DIR))
    ws.solve()
    out = SAMPLE_DATA_DIR / PLAYGROUND_DRAFT_FILE
    out.write_text(json.dumps({
        "fingerprint": sample_data_fingerprint(SAMPLE_DATA_DIR),
        "assignments": ws.draft.assignments.to_dict(orient="records"),
        "backups": ws.draft.backups.to_dict(orient="records"),
    }, default=int))
    print(f"Saved {len(ws.draft.assignments)} assignments and {len(ws.draft.backups)} backups to {out}.")


if __name__ == "__main__":
    main()
