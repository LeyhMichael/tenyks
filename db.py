"""Database connection and data-access layer for the Vantage Quarterback Dashboard."""
import os
import time
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

# ── Simple in-memory cache for the requests DataFrame ────────────────────────
# Avoids a full DB round-trip (Canada Central!) on every page load.
# The cache is invalidated on any write so the UI always reflects live data.
_requests_cache: pd.DataFrame | None = None
_requests_cache_ts: float = 0.0
_CACHE_TTL = 30  # seconds

_members_cache: dict | None = None
_members_cache_ts: float = 0.0
_MEMBERS_TTL = 300  # 5 minutes — team members rarely change


def _invalidate_cache() -> None:
    global _requests_cache
    _requests_cache = None


def get_connection():
    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "tenyks1.postgres.database.azure.com"),
        database=os.environ.get("DB_NAME", "tenyks"),
        user=os.environ.get("DB_USER", "MichaelLeyh"),
        password=os.environ.get("DB_PASSWORD"),
        sslmode="require",
        port=int(os.environ.get("DB_PORT", 5432)),
    )


def load_requests_df():
    """Return all requests as a DataFrame matching the old pickle structure.
    Results are cached for _CACHE_TTL seconds to avoid repeated DB round-trips."""
    global _requests_cache, _requests_cache_ts
    now = time.time()
    if _requests_cache is not None and (now - _requests_cache_ts) < _CACHE_TTL:
        return _requests_cache.copy()

    conn = get_connection()
    try:
        df = pd.read_sql(
            """
            SELECT
                number            AS "Number",
                short_description AS "Short Description",
                country           AS "Country",
                project_code      AS "Project Code",
                requestor         AS "Requestor",
                status            AS "Status",
                assigned_to       AS "Assigned to",
                created_date      AS "Created Date",
                deadline          AS "Deadline"
            FROM requests
            """,
            conn,
        )
    finally:
        conn.close()
    df["Assigned to"] = df["Assigned to"].fillna("Unassigned")
    df["Country"] = df["Country"].fillna("Unknown")
    df["Project Code"] = df["Project Code"].fillna("").astype(str)
    df["Created Date"] = pd.to_datetime(df["Created Date"], errors="coerce")
    df["Deadline"] = pd.to_datetime(df["Deadline"], errors="coerce")
    df["Short Description"] = df["Short Description"].astype(str).str[:80]
    _requests_cache = df
    _requests_cache_ts = now
    return df.copy()


def load_team_members():
    """Return {name: country} dict from the team_members table (cached 5 min)."""
    global _members_cache, _members_cache_ts
    now = time.time()
    if _members_cache is not None and (now - _members_cache_ts) < _MEMBERS_TTL:
        return _members_cache.copy()
    conn = get_connection()
    try:
        df = pd.read_sql("SELECT name, country FROM team_members ORDER BY name", conn)
    finally:
        conn.close()
    _members_cache = {row["name"]: row["country"] for _, row in df.iterrows()}
    _members_cache_ts = now
    return _members_cache.copy()


def load_staffing():
    """Return {name: {date_str: pct}} dict."""
    conn = get_connection()
    try:
        df = pd.read_sql(
            "SELECT name, date::text AS date, percentage FROM staffing", conn
        )
    finally:
        conn.close()
    data: dict = {}
    for _, row in df.iterrows():
        name = str(row["name"])
        date = str(row["date"])[:10]
        data.setdefault(name, {})[date] = int(row["percentage"])
    return data


def load_pto():
    """Return {name: {date_str: type}} dict."""
    conn = get_connection()
    try:
        df = pd.read_sql(
            "SELECT name, date::text AS date, type FROM pto", conn
        )
    finally:
        conn.close()
    data: dict = {}
    for _, row in df.iterrows():
        name = str(row["name"])
        date = str(row["date"])[:10]
        data.setdefault(name, {})[date] = str(row["type"])
    return data


# ── Write helpers ─────────────────────────────────────────────────────────────

def upsert_staffing(name: str, date: str, pct: int) -> None:
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO staffing (name, date, percentage) VALUES (%s, %s, %s)
            ON CONFLICT (name, date) DO UPDATE SET percentage = EXCLUDED.percentage
            """,
            (name, date, pct),
        )
        conn.commit()
    finally:
        conn.close()


def upsert_pto(name: str, date: str, pto_type: str) -> None:
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO pto (name, date, type) VALUES (%s, %s, %s)
            ON CONFLICT (name, date) DO UPDATE SET type = EXCLUDED.type
            """,
            (name, date, pto_type),
        )
        conn.commit()
    finally:
        conn.close()


def delete_pto(name: str, date: str) -> None:
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM pto WHERE name = %s AND date = %s", (name, date))
        conn.commit()
    finally:
        conn.close()


def update_request(number: str, assigned_to: str, status: str) -> None:
    """Update a single request's assignee and status."""
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE requests SET assigned_to = %s, status = %s WHERE number = %s",
            (assigned_to, status, number),
        )
        conn.commit()
    finally:
        conn.close()
    _invalidate_cache()


def unassign_requests(numbers: list) -> None:
    """Reset a list of request numbers to Unassigned / New."""
    if not numbers:
        return
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE requests SET assigned_to = 'Unassigned', status = 'New' WHERE number = ANY(%s)",
            (numbers,),
        )
        conn.commit()
    finally:
        conn.close()
    _invalidate_cache()
