import os
import json
import pandas as pd
from datetime import datetime, timedelta
from dotenv import load_dotenv
import anthropic

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"), override=True)

DATA_DIR = os.path.expanduser("~/tenyks-data")
DATA_FILE = os.path.join(DATA_DIR, "x_tbng3_vantage_activities.pkl")
MEMBERS_FILE = os.path.join(DATA_DIR, "team_members.xlsx")
STAFFING_FILE = os.path.join(DATA_DIR, "staffing_data.csv")
PTO_FILE = os.path.join(DATA_DIR, "pto_data.csv")
ACTIVE_STATUSES = ["New", "Work in progress", "Assigned"]
MAX_REQUESTS_PER_WEEK = 14


def load_requests():
    df = pd.read_pickle(DATA_FILE)
    df["Assigned to"] = df["Assigned to"].fillna("Unassigned")
    df["Country"] = df["Country"].fillna("Unknown")
    df["Project Code"] = df["Project Code"].fillna("").astype(str)
    df["Created Date"] = pd.to_datetime(df["Created Date"], errors="coerce")
    return df


def load_team_members():
    df = pd.read_excel(MEMBERS_FILE)
    return {row["Name"]: row["Country"] for _, row in df.iterrows()}


def load_staffing():
    if not os.path.exists(STAFFING_FILE):
        return {}
    try:
        df = pd.read_csv(STAFFING_FILE, sep=',')
        data = {}
        for _, row in df.iterrows():
            name = str(row["Name"])
            date = str(row["Date"])[:10]
            pct = int(row["Percentage"])
            if name not in data:
                data[name] = {}
            data[name][date] = pct
        return data
    except Exception:
        return {}


def load_pto():
    if not os.path.exists(PTO_FILE):
        return {}
    try:
        df = pd.read_csv(PTO_FILE)
        data = {}
        for _, row in df.iterrows():
            name = str(row["Name"])
            date = str(row["Date"])[:10]
            pto_type = str(row["Type"])
            if name not in data:
                data[name] = {}
            data[name][date] = pto_type
        return data
    except Exception:
        return {}


def get_current_load(df, member):
    """Count active requests assigned to member in current + spillover window."""
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    monday = today - timedelta(days=today.weekday())
    last_thursday = monday - timedelta(days=4)
    active = df[
        (df["Status"].isin(ACTIVE_STATUSES)) &
        (df["Assigned to"] == member) &
        (df["Created Date"] >= last_thursday) &
        (df["Created Date"] <= today + timedelta(days=1))
    ]
    return len(active)


def is_blocked_today(name, staffing, pto):
    today_str = datetime.now().strftime("%Y-%m-%d")
    if staffing.get(name, {}).get(today_str, 0) >= 50:
        return True
    return bool(pto.get(name, {}).get(today_str))


def get_effective_capacity(name, staffing, pto):
    """Mirrors app.py: blocked at >=50% staffing or any PTO/absence today."""
    today_str = datetime.now().strftime("%Y-%m-%d")
    staffing_pct = staffing.get(name, {}).get(today_str, 0)
    has_absence_today = bool(pto.get(name, {}).get(today_str))
    if staffing_pct >= 50 or has_absence_today:
        return 0
    # Count absence days in current Mon–Fri week (each ≈ 20% reduction)
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    monday = today - timedelta(days=today.weekday())
    week_dates = [(monday + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5)]
    absence_days = sum(1 for d in week_dates if pto.get(name, {}).get(d))
    effective_pct = min(staffing_pct + absence_days * 20, 100)
    return max(0, int(MAX_REQUESTS_PER_WEEK * (1 - effective_pct / 100)))


def get_member_requests(df, name):
    """Return active requests assigned to a member in the current week window."""
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    monday = today - timedelta(days=today.weekday())
    last_thursday = monday - timedelta(days=4)
    active = df[
        (df["Status"].isin(ACTIVE_STATUSES)) &
        (df["Assigned to"] == name) &
        (df["Created Date"] >= last_thursday) &
        (df["Created Date"] <= today + timedelta(days=1))
    ][["Number", "Short Description", "Country", "Project Code"]].copy()
    active["Short Description"] = active["Short Description"].astype(str).str[:60]
    return active.to_dict("records")


def build_context(df, team_members, staffing, pto):
    """Build a summary of unassigned requests and team capacity for Claude."""

    # Only active unassigned requests (same filter as the dashboard)
    unassigned_df = df[
        (df["Assigned to"] == "Unassigned") &
        (df["Status"].isin(ACTIVE_STATUSES))
    ][["Number", "Short Description", "Country", "Project Code", "Requestor", "Status"]].copy()
    unassigned_df["Short Description"] = unassigned_df["Short Description"].astype(str).str[:60]
    unassigned = unassigned_df

    today_str = datetime.now().strftime("%Y-%m-%d")
    # Team capacity — effective_capacity accounts for staffing % AND PTO/absences
    capacity = []
    for name, country in team_members.items():
        load = get_current_load(df, name)
        blocked = is_blocked_today(name, staffing, pto)
        today_staffing = staffing.get(name, {}).get(today_str, 0)
        today_absence = pto.get(name, {}).get(today_str, "")
        effective_cap = get_effective_capacity(name, staffing, pto)
        entry = {
            "name": name,
            "country": country,
            "current_requests": load,
            "effective_capacity": effective_cap,
            "remaining_capacity": max(0, effective_cap - load),
            "staffing_pct": today_staffing,
            "blocked": blocked
        }
        if today_absence:
            entry["absence_today"] = today_absence
        capacity.append(entry)

    return unassigned.to_dict("records"), capacity


def run_agent():
    """Run the assignment agent and return recommendations."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}

    df = load_requests()
    team_members = load_team_members()
    staffing = load_staffing()
    pto = load_pto()
    unassigned, capacity = build_context(df, team_members, staffing, pto)

    # Detect members who are over their effective capacity
    overcapacity = []
    for member in capacity:
        excess = member["current_requests"] - member["effective_capacity"]
        if excess > 0:
            reqs = get_member_requests(df, member["name"])  # noqa: uses df-level filter
            overcapacity.append({
                "name": member["name"],
                "country": member["country"],
                "staffing_pct": member["staffing_pct"],
                "blocked": member["blocked"],
                "current_requests": member["current_requests"],
                "effective_capacity": member["effective_capacity"],
                "excess_to_move": excess,
                "requests": reqs
            })

    has_unassigned = bool(unassigned)
    has_overcapacity = bool(overcapacity)

    if not has_unassigned and not has_overcapacity:
        return {"recommendations": [], "summary": "All requests are assigned and team capacity is within limits."}

    # Members available to receive (re)assignments
    available = [m for m in capacity if not m["blocked"] and m["remaining_capacity"] > 0]

    # ── Mode: capacity overrun only ───────────────────────────────────────────
    if has_overcapacity and not has_unassigned:
        oc_names = ", ".join(m["name"] for m in overcapacity)
        total_excess = sum(m["excess_to_move"] for m in overcapacity)
        prompt = f"""You are a quarterback agent for a BCG Vantage team.
All requests are currently assigned, but the following team members are OVER CAPACITY and their excess requests must be redistributed.

OVER-CAPACITY MEMBERS:
{json.dumps(overcapacity, indent=2)}

AVAILABLE TEAM MEMBERS (can receive redistributed requests):
{json.dumps(available, indent=2)}

Redistribution rules (in priority order):
1. Only move the EXCESS requests for each over-capacity member (the "excess_to_move" count — prioritise their most recently created requests).
2. Country match — prefer members in the same country as the request.
3. Never assign to a member with blocked=true or remaining_capacity=0.
4. Spread load as evenly as possible among available members.

Return ONLY a valid JSON array:
[
  {{
    "number": "ACT0469094",
    "assignee": "Alice Smith",
    "reason": "Redistributed from {overcapacity[0]['name'] if overcapacity else 'blocked member'} · Country match (DEU) · 8 slots remaining"
  }}
]

Only include requests that need to move. Do not include any text outside the JSON array."""

        summary_prefix = f"⚠️ Capacity overrun — {oc_names} ha{'ve' if len(overcapacity) > 1 else 's'} {total_excess} excess request(s) that need redistribution."

    # ── Mode: unassigned requests (normal) or combined ───────────────────────
    else:
        prompt = f"""You are a quarterback agent for a BCG Vantage team. Your job is to assign ALL unassigned requests to team members.

Assignment rules (in priority order):
1. Country match — prefer team members in the same country as the request
2. Capacity — do not exceed each member's effective_capacity (already accounts for staffing %)
3. Availability — members with blocked=true CANNOT take requests
4. Fallback — if no country match, assign to any available member with remaining_capacity > 0 (lowest load first)

UNASSIGNED REQUESTS:
{json.dumps(unassigned, indent=2)}

TEAM CAPACITY:
{json.dumps(capacity, indent=2)}

Assign EVERY request if possible. Return ONLY a valid JSON array:
[
  {{
    "number": "ACT0469094",
    "assignee": "Leyh Michael",
    "reason": "Country match (DEU) · 8 slots remaining"
  }}
]

Use short, factual reasons. Only skip a request if ALL team members are at capacity or blocked.
Do not include any text outside the JSON array."""

        summary_prefix = None

    client = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}]
    )

    raw = message.content[0].text.strip()

    # Strip markdown code fences if present
    clean = raw
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[-1]
        if clean.endswith("```"):
            clean = clean.rsplit("```", 1)[0].strip()

    try:
        recommendations = json.loads(clean)
        if summary_prefix:
            summary = f"{summary_prefix} Agent made {len(recommendations)} redistribution recommendation(s)."
        else:
            summary = f"Agent reviewed {len(unassigned)} unassigned request(s) and made {len(recommendations)} recommendation(s)."
        return {"recommendations": recommendations, "summary": summary}
    except json.JSONDecodeError:
        return {"error": "Agent returned invalid response", "raw": raw}


if __name__ == "__main__":
    result = run_agent()
    print(json.dumps(result, indent=2))
