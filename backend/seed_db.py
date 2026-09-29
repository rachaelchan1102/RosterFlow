"""Load a roster from CSVs into the coordinator database (NEON_DSN).

    python -m backend.seed_db --csv-dir path/to/real_csvs

Refuses to touch a database that already has a roster unless --replace is given, since that
would wipe the real one.
"""
import argparse
import os
import sys

from backend import persistence
from backend.env import load_env_file
from optimizer.data import load_from_csv, save_to_db


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv-dir", required=True, help="directory with the 8 roster CSVs (same layout as sample_data/)")
    parser.add_argument("--replace", action="store_true", help="overwrite a roster that's already in the database")
    args = parser.parse_args()

    load_env_file()
    dsn = os.environ.get("NEON_DSN")
    if not dsn:
        sys.exit("Set NEON_DSN in .env (or the shell) to the database connection string first.")

    persistence.apply_schema(dsn)
    if not persistence.roster_is_empty(dsn) and not args.replace:
        sys.exit("That database already has a roster. Re-run with --replace to overwrite it.")

    data = load_from_csv(args.csv_dir)
    save_to_db(data, dsn)
    persistence.clear_state(dsn)   # any saved schedule pointed at the old roster
    print(f"Loaded {len(data.musicians)} musicians, {len(data.shows)} shows, {len(data.facilities)} facilities.")


if __name__ == "__main__":
    main()
