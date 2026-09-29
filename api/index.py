"""Vercel's entry point for the backend: every /api/* request is routed here (see vercel.json)
and handed to the FastAPI app, which still sees the original path."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # so `backend` and `optimizer` import

from backend.main import app  # noqa: E402,F401
