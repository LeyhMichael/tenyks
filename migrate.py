"""
One-time migration: load pickle / Excel / CSV data files into PostgreSQL.

Usage (from the project root, with venv active):
    python migrate.py

The script is idempotent — it uses ON CONFLICT DO UPDATE, so it is safe to
run multiple times.
"""
import os
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"), override=True)

DATA_DIR      = os.environ.get("DATA_DIR", os.path.expanduser("~/tenyks-data"))
DATA_FILE     = os.path.join(DATA_DIR, "x_tbng3_vantage_activities.pkl")
MEMBERS_FILE  = os.path.join(DATA_DIR, "team_members.xlsx")
STAFFING_FILE = os.path.join(DATA_DIR, "staffing_data.csv")
PTO_FILE      = os.path.join(DATA_DIR, "pto_data.csv")


def get_connection():
    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "tenyks1.postgres.database.azure.com"),
        database=os.environ.get("DB_NAME", "tenyks"),
        user=os.environ.get("DB_USER", "MichaelLeyh"),
        password=os.environ.get("DB_PASSWORD"),
        sslmode="require",
        port=5432,
    )


def run():
    conn = get_connection()
    cur = conn.cursor()

    # Ensure the deadline column exists (safe if already present)
    cur.execute("ALTER TABLE requests ADD COLUMN IF NOT EXISTS deadline TIMESTAMP;")

    # ── Requests ──────────────────────────────────────────────────────────────
    print("Migrating requests ...", end=" ", flush=True)
    df = pd.read_pickle(DATA_FILE)
    df["Assigned to"]  = df["Assigned to"].fillna("Unassigned")
    df["Country"]      = df["Country"].fillna("Unknown")
    df["Project Code"] = df["Project Code"].fillna("").astype(str)
    df["Created Date"] = pd.to_datetime(df["Created Date"], errors="coerce")
    if "Deadline" not in df.columns:
        df["Deadline"] = None
    else:
        df["Deadline"] = pd.to_datetime(df["Deadline"], errors="coerce")

    records = [
        (
            str(row.get("Number", "")),
            str(row.get("Short Description", ""))[:500],
            str(row.get("Country", "Unknown")),
            str(row.get("Project Code", "")),
            str(row.get("Requestor", "")),
            str(row.get("Status", "")),
            str(row.get("Assigned to", "Unassigned")),
            row["Created Date"] if pd.notna(row["Created Date"]) else None,
            row["Deadline"]     if pd.notna(row["Deadline"])     else None,
        )
        for _, row in df.iterrows()
    ]
    execute_values(
        cur,
        """
        INSERT INTO requests
            (number, short_description, country, project_code, requestor,
             status, assigned_to, created_date, deadline)
        VALUES %s
        ON CONFLICT (number) DO UPDATE SET
            short_description = EXCLUDED.short_description,
            country           = EXCLUDED.country,
            project_code      = EXCLUDED.project_code,
            requestor         = EXCLUDED.requestor,
            status            = EXCLUDED.status,
            assigned_to       = EXCLUDED.assigned_to,
            created_date      = EXCLUDED.created_date,
            deadline          = EXCLUDED.deadline
        """,
        records,
    )
    print(f"{len(records)} rows")

    # ── Team members ──────────────────────────────────────────────────────────
    if os.path.exists(MEMBERS_FILE):
        print("Migrating team members ...", end=" ", flush=True)
        mdf = pd.read_excel(MEMBERS_FILE)
        rows = [(str(r["Name"]), str(r["Country"])) for _, r in mdf.iterrows()]
        if rows:
            execute_values(
                cur,
                """
                INSERT INTO team_members (name, country) VALUES %s
                ON CONFLICT (name) DO UPDATE SET country = EXCLUDED.country
                """,
                rows,
            )
        print(f"{len(rows)} rows")
    else:
        print(f"Skipping team members — {MEMBERS_FILE} not found")

    # ── Staffing ──────────────────────────────────────────────────────────────
    if os.path.exists(STAFFING_FILE):
        print("Migrating staffing ...", end=" ", flush=True)
        sdf = pd.read_csv(STAFFING_FILE)
        rows = [
            (str(r["Name"]), str(r["Date"])[:10], int(r["Percentage"]))
            for _, r in sdf.iterrows()
        ]
        if rows:
            execute_values(
                cur,
                """
                INSERT INTO staffing (name, date, percentage) VALUES %s
                ON CONFLICT (name, date) DO UPDATE SET percentage = EXCLUDED.percentage
                """,
                rows,
            )
        print(f"{len(rows)} rows")
    else:
        print(f"Skipping staffing — {STAFFING_FILE} not found")

    # ── PTO ───────────────────────────────────────────────────────────────────
    if os.path.exists(PTO_FILE):
        print("Migrating PTO ...", end=" ", flush=True)
        pdf = pd.read_csv(PTO_FILE)
        rows = [
            (str(r["Name"]), str(r["Date"])[:10], str(r["Type"]))
            for _, r in pdf.iterrows()
        ]
        if rows:
            execute_values(
                cur,
                """
                INSERT INTO pto (name, date, type) VALUES %s
                ON CONFLICT (name, date) DO UPDATE SET type = EXCLUDED.type
                """,
                rows,
            )
        print(f"{len(rows)} rows")
    else:
        print(f"Skipping PTO — {PTO_FILE} not found")

    conn.commit()
    cur.close()
    conn.close()
    print("Migration complete!")


if __name__ == "__main__":
    run()
