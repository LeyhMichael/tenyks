from flask import Flask, render_template, request, jsonify, session
from functools import wraps
import pandas as pd
import os
import json
from datetime import datetime, timedelta
from dotenv import load_dotenv
from agent import run_agent
import db

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "changeme")
PASSWORD = os.environ.get("APP_PASSWORD", "changeme")

BACKLOG_FILE = os.path.join(
    os.environ.get("DATA_DIR", os.path.expanduser("~/tenyks-data")), "backlog.xlsx"
)
ACTIVE_STATUSES = ["New", "Work in progress", "Assigned"]
MAX_REQUESTS_PER_WEEK = 14
BACKLOG_COLUMNS = ["Group", "Name", "Lead", "Team", "Status", "Start Date",
                   "End Date", "Priority", "Hours", "Completion Date",
                   "Practice", "Stakeholders", "Allocation %"]

# ── Staffing & PTO — loaded from DB at startup, kept in memory ───────────────
# Writes go to DB immediately (and update the in-memory dict for the current
# worker).  Acceptable for a single-worker / dev deployment.

try:
    staffing_data = db.load_staffing()
except Exception:
    staffing_data = {}

try:
    pto_data = db.load_pto()
except Exception:
    pto_data = {}

# ── Backlog persistence (still file-based) ────────────────────────────────────

def load_backlog():
    if not os.path.exists(BACKLOG_FILE):
        return pd.DataFrame(columns=BACKLOG_COLUMNS)
    try:
        df = pd.read_excel(BACKLOG_FILE)
        for col in BACKLOG_COLUMNS:
            if col not in df.columns:
                df[col] = "" if col not in ("Hours", "Allocation %") else 0
        df["Allocation %"] = pd.to_numeric(df["Allocation %"], errors="coerce").fillna(0).astype(int)
        df["Hours"] = pd.to_numeric(df["Hours"], errors="coerce").fillna(0)
        return df[BACKLOG_COLUMNS].copy()
    except Exception:
        return pd.DataFrame(columns=BACKLOG_COLUMNS)

def save_backlog(df):
    df[BACKLOG_COLUMNS].to_excel(BACKLOG_FILE, index=False)

backlog_df = load_backlog()

def get_backlog_allocation_today(name):
    """Sum Allocation % from active (Working) backlog items where name is Lead or Team member today."""
    today_str = datetime.now().strftime("%Y-%m-%d")
    total = 0
    for _, item in backlog_df.iterrows():
        if str(item.get("Status", "")) != "Working":
            continue
        all_names = []
        for raw in [str(item.get("Team", "") or ""), str(item.get("Lead", "") or "")]:
            all_names += [n.strip() for n in raw.split(",") if n.strip()]
        if name not in all_names:
            continue
        start = str(item.get("Start Date", "") or "")[:10]
        end   = str(item.get("End Date",   "") or "")[:10]
        if start and end and start <= today_str <= end:
            try:
                total += int(item.get("Allocation %", 0) or 0)
            except (ValueError, TypeError):
                pass
    return min(total, 100)

# ── Capacity helpers ──────────────────────────────────────────────────────────

def get_block_reason(name):
    """Return the blocking reason string or None if not blocked."""
    today_str = datetime.now().strftime("%Y-%m-%d")
    staffing_pct = staffing_data.get(name, {}).get(today_str, 0)
    if staffing_pct >= 50:
        return "on case today"
    absence = pto_data.get(name, {}).get(today_str)
    if absence:
        return absence.lower()
    return None

def get_effective_capacity(name):
    """Max requests this person can take, factoring in case staffing, PTO, and backlog allocation."""
    today_str = datetime.now().strftime("%Y-%m-%d")
    staffing_pct = staffing_data.get(name, {}).get(today_str, 0)
    has_absence_today = bool(pto_data.get(name, {}).get(today_str))

    if staffing_pct >= 50 or has_absence_today:
        return 0

    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    monday = today - timedelta(days=today.weekday())
    week_dates = [(monday + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5)]
    absence_days = sum(1 for d in week_dates if pto_data.get(name, {}).get(d))

    backlog_pct = get_backlog_allocation_today(name)

    effective_pct = min(staffing_pct + absence_days * 20 + backlog_pct, 100)
    return max(0, int(MAX_REQUESTS_PER_WEEK * (1 - effective_pct / 100)))

def get_member_active_requests(df, name):
    """Return all active requests assigned to name."""
    mask = (
        (df["Status"].isin(ACTIVE_STATUSES)) &
        (df["Assigned to"] == name)
    )
    return df[mask]

# ── Data helpers ──────────────────────────────────────────────────────────────

def load_data():
    return db.load_requests_df()

def get_week_dates():
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    monday = today - timedelta(days=today.weekday())
    week_days = [monday + timedelta(days=i) for i in range(5)]
    last_thursday = monday - timedelta(days=4)
    last_friday = monday - timedelta(days=3)
    return today, monday, week_days, last_thursday, last_friday

def is_blocked_today(name):
    today_str = datetime.now().strftime("%Y-%m-%d")
    if staffing_data.get(name, {}).get(today_str, 0) >= 50:
        return True
    return bool(pto_data.get(name, {}).get(today_str))

def get_active_requests(df):
    active = df[df["Status"].isin(ACTIVE_STATUSES)].copy()
    active["is_unassigned"] = active["Assigned to"] == "Unassigned"
    active = active.sort_values("is_unassigned", ascending=False)
    records = active[["Number", "Assigned to", "Status", "Short Description",
                       "Requestor", "Deadline", "Created Date", "Project Code",
                       "is_unassigned"]].to_dict("records")
    for r in records:
        r["Created Date"] = str(r["Created Date"])[:10] if pd.notna(r["Created Date"]) else ""
        r["Deadline"] = str(r["Deadline"])[:10] if pd.notna(r["Deadline"]) else ""
        r["Project Code"] = str(r["Project Code"]) if pd.notna(r["Project Code"]) else ""
        r["Preview"] = str(r["Short Description"])[:60] + ("…" if len(str(r["Short Description"])) > 60 else "")
    return records

def get_team_capacity(df):
    today, monday, week_days, last_thursday, last_friday = get_week_dates()
    window_start = last_thursday
    active = df[
        (df["Status"].isin(ACTIVE_STATUSES)) &
        (df["Assigned to"] != "Unassigned") &
        (df["Created Date"] >= window_start) &
        (df["Created Date"] <= today + timedelta(days=1))
    ]
    team_members = sorted(df[df["Assigned to"] != "Unassigned"]["Assigned to"].unique())
    result = []
    for member in team_members:
        member_data = active[active["Assigned to"] == member]
        daily = {}
        for day in week_days:
            day_end = day + timedelta(days=1)
            count = len(member_data[
                (member_data["Created Date"] >= day) &
                (member_data["Created Date"] < day_end)
            ])
            daily[day.strftime("%a")] = count
        spillover = len(member_data[
            member_data["Created Date"].dt.date.isin([last_thursday.date(), last_friday.date()])
        ])
        total = sum(daily.values()) + spillover
        blocked = is_blocked_today(member)
        effective_cap = get_effective_capacity(member)
        block_reason = get_block_reason(member)
        pct = min(round((total / MAX_REQUESTS_PER_WEEK) * 100), 100)
        if blocked:
            status = "blocked"
        elif total >= effective_cap:
            status = "full"
        elif total >= effective_cap * 0.7:
            status = "warn"
        else:
            status = "ok"
        result.append({
            "name": member, "daily": daily, "spillover": spillover,
            "total": total, "pct": pct, "is_blocked": blocked,
            "block_reason": block_reason,
            "effective_cap": effective_cap,
            "at_capacity": total >= effective_cap or blocked,
            "status": status
        })
    result = [r for r in result if r["total"] > 0 or r["is_blocked"]]
    result.sort(key=lambda x: (x["is_blocked"], x["total"]), reverse=True)
    return result, [d.strftime("%a") for d in week_days]

def get_all_team_members(df):
    """Return sorted list of all team members (DB table takes precedence, requests as fallback)."""
    try:
        return sorted(db.load_team_members().keys())
    except Exception:
        return sorted(df[df["Assigned to"] != "Unassigned"]["Assigned to"].unique().tolist())

# ── Auth ──────────────────────────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        # Auto-login when Azure Easy Auth has already authenticated the user
        if request.headers.get("X-MS-CLIENT-PRINCIPAL"):
            session["logged_in"] = True
        if not session.get("logged_in"):
            return render_template("login.html")
        return f(*args, **kwargs)
    return decorated

# ── Routes ────────────────────────────────────────────────────────────────────

def load_apps():
    path = os.path.join(os.path.dirname(__file__), "apps.json")
    with open(path) as f:
        return json.load(f)

@app.route("/")
@login_required
def home():
    apps = load_apps()
    return render_template("home.html", apps=apps)

@app.route("/quarterback")
@login_required
def index():
    df = load_data()
    requests_list = get_active_requests(df)
    team, week_labels = get_team_capacity(df)
    team_names = get_all_team_members(df)
    blocked_names = {m["name"] for m in team if m["is_blocked"]}
    blocked_reasons = {m["name"]: (m.get("block_reason") or "on case today") for m in team if m["is_blocked"]}
    at_capacity_names = {m["name"] for m in team if m["at_capacity"]}
    unassigned_count = sum(1 for r in requests_list if r["is_unassigned"])
    today_label = datetime.now().strftime("%a")
    return render_template("index.html",
        tab="requests",
        requests=requests_list,
        team=team,
        team_names=team_names,
        blocked_names=blocked_names,
        blocked_reasons=blocked_reasons,
        at_capacity_names=at_capacity_names,
        unassigned_count=unassigned_count,
        MAX_REQUESTS=MAX_REQUESTS_PER_WEEK,
        week_labels=week_labels,
        today_label=today_label
    )

@app.route("/staffing-tab")
@login_required
def staffing_tab():
    df = load_data()
    team_names = get_all_team_members(df)
    return render_template("staffing.html", team_names=team_names)

@app.route("/pto-tab")
@login_required
def pto_tab():
    df = load_data()
    team_names = get_all_team_members(df)
    return render_template("pto.html", team_names=team_names)

@app.route("/api/staffing-data")
@login_required
def get_staffing_api():
    month = request.args.get("month")
    result = {}
    for name, days in staffing_data.items():
        month_days = {d: v for d, v in days.items() if d.startswith(month)}
        if month_days:
            result[name] = month_days
    return jsonify(result)

@app.route("/api/pto-data")
@login_required
def get_pto_api():
    month = request.args.get("month")
    result = {}
    for name, days in pto_data.items():
        month_days = {d: v for d, v in days.items() if d.startswith(month)}
        if month_days:
            result[name] = month_days
    return jsonify(result)

@app.route("/login", methods=["POST"])
def login():
    if request.form.get("password", "") == PASSWORD:
        session["logged_in"] = True
        return "", 200
    return "", 401

@app.route("/logout")
def logout():
    session.clear()
    return render_template("login.html")

@app.route("/assign", methods=["POST"])
@login_required
def assign():
    data = request.get_json()
    number = str(data.get("number", "")).strip()
    assignee = str(data.get("assignee", "")).strip()
    if not number or not assignee:
        return jsonify({"error": "Invalid input"}), 400
    try:
        df = db.load_requests_df()

        effective_cap = get_effective_capacity(assignee)
        current_load = len(get_member_active_requests(df, assignee))
        block_reason = get_block_reason(assignee)
        if effective_cap == 0:
            reason_label = block_reason or "blocked today"
            return jsonify({"error": f"{assignee} is blocked ({reason_label})"}), 400
        if current_load >= effective_cap:
            return jsonify({"error": f"{assignee} is at capacity ({current_load}/{effective_cap} requests this week)"}), 400

        db.update_request(number, assignee, "Assigned")
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/update-staffing", methods=["POST"])
@login_required
def update_staffing():
    data = request.get_json()
    name = str(data.get("name", "")).strip()
    date = str(data.get("date", "")).strip()
    pct = data.get("pct", 0)
    if not name or not date:
        return jsonify({"error": "Invalid input"}), 400
    try:
        pct = int(pct)
        if pct < 0 or pct > 100:
            raise ValueError
        datetime.strptime(date, "%Y-%m-%d")
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid data"}), 400

    # Update in-memory dict and persist to DB
    if name not in staffing_data:
        staffing_data[name] = {}
    staffing_data[name][date] = pct
    db.upsert_staffing(name, date, pct)

    # Spillover trigger — only fires when setting today's staffing
    today_str = datetime.now().strftime("%Y-%m-%d")
    reassigned = 0
    if date == today_str:
        df = db.load_requests_df()
        effective_cap = get_effective_capacity(name)
        member_reqs = get_member_active_requests(df, name)
        spillover_count = max(0, len(member_reqs) - effective_cap)
        if spillover_count > 0:
            to_reassign = member_reqs.sort_values("Created Date", ascending=False).head(spillover_count)
            db.unassign_requests(to_reassign["Number"].tolist())
            reassigned = spillover_count

    return jsonify({"success": True, "is_blocked": pct >= 50, "reassigned": reassigned})

@app.route("/update-pto", methods=["POST"])
@login_required
def update_pto():
    data = request.get_json()
    name = str(data.get("name", "")).strip()
    date = str(data.get("date", "")).strip()
    pto_type = str(data.get("type", "")).strip()
    if not name or not date:
        return jsonify({"error": "Invalid input"}), 400
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "Invalid date"}), 400

    if pto_type:
        if name not in pto_data:
            pto_data[name] = {}
        pto_data[name][date] = pto_type
        db.upsert_pto(name, date, pto_type)
    else:
        if name in pto_data and date in pto_data[name]:
            del pto_data[name][date]
        db.delete_pto(name, date)

    # Spillover trigger — only fires when setting today
    today_str = datetime.now().strftime("%Y-%m-%d")
    reassigned = 0
    if date == today_str:
        df = db.load_requests_df()
        effective_cap = get_effective_capacity(name)
        member_reqs = get_member_active_requests(df, name)
        spillover_count = max(0, len(member_reqs) - effective_cap)
        if spillover_count > 0:
            to_reassign = member_reqs.sort_values("Created Date", ascending=False).head(spillover_count)
            db.unassign_requests(to_reassign["Number"].tolist())
            reassigned = spillover_count

    return jsonify({"success": True, "is_blocked": is_blocked_today(name), "reassigned": reassigned})

@app.route("/backlog-tab")
@login_required
def backlog_tab():
    df = load_data()
    team_names = get_all_team_members(df)
    return render_template("backlog.html", team_names=team_names)

@app.route("/api/backlog")
@login_required
def get_backlog_api():
    items = []
    for i, row in backlog_df.iterrows():
        item = {col: (row[col] if pd.notna(row[col]) else "") for col in BACKLOG_COLUMNS}
        item["id"] = i
        item["Hours"] = float(item["Hours"]) if item["Hours"] != "" else 0
        item["Allocation %"] = int(item["Allocation %"]) if item["Allocation %"] != "" else 0
        for date_col in ["Start Date", "End Date", "Completion Date"]:
            item[date_col] = str(item[date_col])[:10] if item[date_col] else ""
        items.append(item)
    return jsonify(items)

@app.route("/api/backlog/save", methods=["POST"])
@login_required
def save_backlog_item():
    global backlog_df
    data = request.get_json()
    item_id = data.get("id", -1)
    row = {}
    for col in BACKLOG_COLUMNS:
        val = data.get(col, "")
        if col == "Allocation %":
            try: val = int(val)
            except: val = 0
        elif col == "Hours":
            try: val = float(val)
            except: val = 0.0
        row[col] = val
    if item_id == -1:
        backlog_df = pd.concat([backlog_df, pd.DataFrame([row])], ignore_index=True)
        new_id = len(backlog_df) - 1
    else:
        for col in BACKLOG_COLUMNS:
            backlog_df.at[item_id, col] = row[col]
        new_id = item_id
    save_backlog(backlog_df)
    return jsonify({"success": True, "id": new_id})

@app.route("/api/backlog/delete", methods=["POST"])
@login_required
def delete_backlog_item():
    global backlog_df
    item_id = request.get_json().get("id")
    if item_id is None or item_id < 0 or item_id >= len(backlog_df):
        return jsonify({"error": "Invalid id"}), 400
    backlog_df = backlog_df.drop(index=item_id).reset_index(drop=True)
    save_backlog(backlog_df)
    return jsonify({"success": True})

@app.route("/run-agent", methods=["POST"])
@login_required
def run_agent_route():
    result = run_agent()
    if "recommendations" in result:
        df = load_data()
        try:
            member_countries = db.load_team_members()
        except Exception:
            member_countries = {}
        for rec in result["recommendations"]:
            row = df[df["Number"] == rec["number"]]
            if not row.empty:
                r = row.iloc[0]
                rec["short_description"] = str(r.get("Short Description", ""))[:80]
                rec["country"] = str(r.get("Country", "")) if pd.notna(r.get("Country")) else ""
                rec["requestor"] = str(r.get("Requestor", "")) if pd.notna(r.get("Requestor")) else ""
            rec["assignee_country"] = member_countries.get(rec.get("assignee", ""), "")
    return jsonify(result)

@app.route("/apply-recommendations", methods=["POST"])
@login_required
def apply_recommendations():
    """Batch apply with capacity enforcement."""
    data = request.get_json()
    recommendations = data.get("recommendations", [])
    if not recommendations:
        return jsonify({"applied": 0, "skipped": [], "errors": []})
    try:
        df = db.load_requests_df()
        applied = []
        skipped = []
        load_tracker = {}

        for rec in recommendations:
            number = str(rec.get("number", "")).strip()
            assignee = str(rec.get("assignee", "")).strip()
            if not number or not assignee:
                continue
            if assignee not in load_tracker:
                load_tracker[assignee] = len(get_member_active_requests(df, assignee))
            effective_cap = get_effective_capacity(assignee)
            if load_tracker[assignee] >= effective_cap:
                skipped.append(number)
                continue
            db.update_request(number, assignee, "Assigned")
            applied.append(number)
            load_tracker[assignee] += 1

        print(f"[assign] {len(applied)} applied, {len(skipped)} skipped (capacity)")
        return jsonify({"applied": len(applied), "skipped": skipped, "errors": []})
    except Exception as e:
        print(f"[assign] ERROR: {e}")
        return jsonify({"applied": 0, "skipped": [], "errors": [str(e)]}), 500

if __name__ == "__main__":
    app.run(debug=True)
