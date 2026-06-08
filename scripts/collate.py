#!/usr/bin/env python3
"""Collate weekly-availability comments on a Meeting Time issue and post the
best mutual meeting times.

Runs in GitHub Actions. No third-party deps — stdlib only (urllib + zoneinfo).

Model
-----
The painter exports, per respondent, a grid of 15/30/60-min slots in their own
IANA timezone. Baseline (unpainted) = "preferably available" (state 2): everyone
starts fully available and paints only genuine unavailability. Painted slots are
state 0 (completely unavailable) or 1 (sometimes available).

We resample every respondent to a common 15-minute weekly lattice (672 buckets,
Mon 00:00 .. Sun 23:45) in absolute UTC, anchored to the current week so DST is
applied correctly via zoneinfo.

Hosts & multiple meetings
-------------------------
Optional *hosts* are required attendees: every proposed meeting must be a time
the hosts can make (state >= 1), no matter what. "Number of meetings" then asks
for N complementary meeting times that together *cover* the group — each person
only needs one meeting that works for them. We pick them greedily: meeting 1
covers the most people, meeting 2 covers the most of whoever is left, and so on
(once everyone is covered, extra meetings become high-quality alternatives).
This is how one host can span APAC/EMEA/AMER with, say, an early-morning and a
late-evening slot built from a single set of responses.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
RES_MIN = 15                      # collation resolution
WEEK_BUCKETS = 7 * 24 * 60 // RES_MIN   # 672
UTC = timezone.utc

RESULTS_MARKER = "<!-- MEETING-RESULTS -->"
LINK_MARKER = "<!-- MEETING-LINK -->"
PAYLOAD_MARKER = "AVAILABILITY:v1"

API = "https://api.github.com"
TOKEN = os.environ["GITHUB_TOKEN"]
REPO = os.environ["GITHUB_REPOSITORY"]            # owner/repo
OWNER, REPONAME = REPO.split("/", 1)


# --------------------------------------------------------------------------- #
# GitHub REST helpers
# --------------------------------------------------------------------------- #
def _req(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def get_issue(num):
    return _req("GET", f"{API}/repos/{REPO}/issues/{num}")


def get_comments(num):
    out, page = [], 1
    while True:
        chunk = _req(
            "GET",
            f"{API}/repos/{REPO}/issues/{num}/comments?per_page=100&page={page}",
        )
        if not chunk:
            break
        out.extend(chunk)
        if len(chunk) < 100:
            break
        page += 1
    return out


def upsert_marker_comment(num, existing_comments, marker, body):
    """Create or edit the single bot comment carrying `marker`."""
    full = f"{marker}\n{body}"
    for c in existing_comments:
        if marker in (c.get("body") or ""):
            _req("PATCH", f"{API}/repos/{REPO}/issues/comments/{c['id']}",
                 {"body": full})
            return
    _req("POST", f"{API}/repos/{REPO}/issues/{num}/comments", {"body": full})


# --------------------------------------------------------------------------- #
# Parsing the issue form + the availability payloads
# --------------------------------------------------------------------------- #
def parse_issue_form(body):
    """Map '### Heading' -> value for a rendered GitHub issue form."""
    fields, heading, buf = {}, None, []
    for line in (body or "").splitlines():
        if line.startswith("### "):
            if heading is not None:
                fields[heading.lower()] = "\n".join(buf).strip()
            heading, buf = line[4:].strip(), []
        else:
            buf.append(line)
    if heading is not None:
        fields[heading.lower()] = "\n".join(buf).strip()
    return fields


def _field(fields, label, default=""):
    v = fields.get(label.lower(), "")
    if not v or v == "_No response_":
        return default
    return v


def _parse_users(text):
    """Parse usernames line-by-line so free-form prose can't harvest phantom
    logins: take @-mentions from any line containing '@', else a sole bare
    username on its own line."""
    users = []
    name = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?"
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        toks = re.findall(r"@(" + name + r")", line)
        if not toks and re.fullmatch(name, line):
            toks = [line]
        for tok in toks:
            if tok.lower() not in (u.lower() for u in users):
                users.append(tok)
    return users


def parse_config(issue):
    f = parse_issue_form(issue.get("body", ""))

    def as_int(label, default):
        # first integer token; preserves sign so the clamps below work, and
        # ignores trailing units instead of concatenating all digits
        m = re.search(r"-?\d+", _field(f, label, str(default)))
        return int(m.group()) if m else default

    hosts = _parse_users(_field(f, "Meeting host(s)"))
    whitelist = _parse_users(_field(f, "Whitelisted respondents"))
    # hosts are always counted, even if omitted from the respondent list
    for h in hosts:
        if h.lower() not in (w.lower() for w in whitelist):
            whitelist.append(h)

    return {
        "meeting": _field(f, "Meeting ID", f"issue-{issue['number']}"),
        "slot": as_int("Slot size (minutes)", 30),
        "duration": max(RES_MIN, as_int("Meeting duration (minutes)", 60)),
        "start": min(23, max(0, as_int("Earliest hour shown (0-24)", 0))),
        "end": min(24, max(1, as_int("Latest hour shown (0-24)", 24))),
        "num_meetings": min(6, max(1, as_int("Number of meetings", 1))),
        "min_attendees": max(1, as_int("Minimum attendees per meeting", 2)),
        "hosts": hosts,
        "whitelist": whitelist,
    }


def extract_payload(comment_body):
    if PAYLOAD_MARKER not in (comment_body or ""):
        # still try a bare json block, but require kind=availability below
        pass
    m = re.search(r"```json\s*([\s\S]*?)```", comment_body or "")
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return None
    return data if data.get("kind") == "availability" else None


# --------------------------------------------------------------------------- #
# Timezone normalisation -> 15-min UTC weekly lattice
# --------------------------------------------------------------------------- #
def reference_monday():
    today = datetime.now(UTC).date()
    return today - timedelta(days=today.weekday())  # Monday of the current week


ANCHOR_DATE = reference_monday()
ANCHOR_UTC = datetime.combine(ANCHOR_DATE, time(0, 0), tzinfo=UTC)


def normalize(payload):
    """Return {bucket_index: state} for buckets the respondent is available in
    (state >= 1), keyed on the shared 15-min UTC weekly lattice. None on error."""
    try:
        tz = ZoneInfo(payload.get("tz", "UTC"))
    except (ZoneInfoNotFoundError, KeyError, ValueError):
        return None
    slot = int(payload.get("slotMinutes", 30))
    start_hour = int(payload.get("startHour", 0))
    grid = payload.get("grid", {})
    steps_per_slot = max(1, slot // RES_MIN)

    out = {}
    for d, day in enumerate(DAYS):
        s = grid.get(day, "")
        for i, ch in enumerate(s):
            try:
                st = int(ch)
            except ValueError:
                continue
            if st < 1:
                continue  # completely unavailable -> blocks this bucket (not recorded)
            mins = start_hour * 60 + i * slot
            local_dt = datetime.combine(
                ANCHOR_DATE + timedelta(days=d), time(0, 0), tzinfo=tz
            ) + timedelta(minutes=mins)
            base = local_dt.astimezone(UTC)
            for k in range(steps_per_slot):  # expand slot to 15-min buckets
                utc_dt = base + timedelta(minutes=k * RES_MIN)
                offset = int((utc_dt - ANCHOR_UTC).total_seconds() // 60)
                b = (offset // RES_MIN) % WEEK_BUCKETS
                out[b] = max(out.get(b, 0), st)
    return out


def bucket_to_utc(b):
    return ANCHOR_UTC + timedelta(minutes=b * RES_MIN)


def fmt_in_tz(utc_dt, tzname):
    try:
        local = utc_dt.astimezone(ZoneInfo(tzname))
    except Exception:
        local = utc_dt
        tzname = "UTC"
    return f"{DAYS[local.weekday()]} {local:%H:%M}"


# --------------------------------------------------------------------------- #
# Solving: host-gated max-coverage over N meetings
# --------------------------------------------------------------------------- #
def attend_sets(responders, length):
    """For each start bucket, {login: effective_state} for everyone who is
    available for the whole window (state >= 1 in all its buckets). Effective
    state = min across the window (a 'sometimes' anywhere downgrades it)."""
    out = []
    for start in range(WEEK_BUCKETS):
        window = [(start + k) % WEEK_BUCKETS for k in range(length)]
        att = {}
        for login, _tz, amap in responders:
            states = [amap.get(b) for b in window]
            if all(s is not None and s >= 1 for s in states):
                att[login] = min(states)
        out.append(att)
    return out


def solve_meetings(responders, host_logins, num_meetings, duration_min, min_attendees=1):
    """Greedy, host-gated max-coverage. Every meeting must work for all hosts who
    have responded, and have at least `min_attendees` people (including hosts);
    meetings are chosen to cover the most still-uncovered people.

    Returns (meetings, covered) where each meeting is
    (start_bucket, attend_dict, marginal_new_count)."""
    if not responders:
        return [], set()
    length = max(1, -(-duration_min // RES_MIN))  # ceil: cover the full booked duration
    att = attend_sets(responders, length)
    present = {r[0] for r in responders}
    hosts_present = [h for h in host_logins if h in present]

    def host_ok(start):
        return all(h in att[start] for h in hosts_present)

    covered, meetings = set(), []
    used_starts, used_buckets = set(), set()
    for _ in range(num_meetings):
        best = None  # ((marginal, score, -start), start)
        for start in range(WEEK_BUCKETS):
            if start in used_starts:
                continue
            if len(att[start]) < min_attendees or not host_ok(start):
                continue
            window = [(start + k) % WEEK_BUCKETS for k in range(length)]
            marginal = len(set(att[start]) - covered)
            # Complementary meetings MAY overlap — that's how two cohorts whose
            # only feasible windows partly overlap each still get covered. Only a
            # window that adds NO new coverage must be a genuinely distinct time
            # (no overlap), so a zero-gain "alternative" isn't a 15-min shift.
            if marginal == 0 and any(b in used_buckets for b in window):
                continue
            score = sum(att[start].values())
            key = (marginal, score, -start)
            if best is None or key > best[0]:
                best = (key, start)
        if best is None:
            break
        start, marginal = best[1], best[0][0]
        meetings.append((start, att[start], marginal))
        covered |= set(att[start])
        used_starts.add(start)
        used_buckets |= {(start + k) % WEEK_BUCKETS for k in range(length)}
    return meetings, covered


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def render_link(cfg, pages_url):
    q = (f"?meeting={cfg['meeting']}&slot={cfg['slot']}"
         f"&start={cfg['start']}&end={cfg['end']}")
    url = pages_url.rstrip("/") + "/" + q
    names = " ".join(f"@{u}" for u in cfg["whitelist"])
    extra = ""
    if cfg["hosts"]:
        hl = " ".join(f"@{u}" for u in cfg["hosts"])
        extra += (f"**Host(s) (always accommodated):** {hl} — hosts, please paint "
                  f"your week too and mark *sometimes available* for any unsociable "
                  f"hours you'd be willing to take.\n\n")
    if cfg["num_meetings"] > 1:
        extra += (f"Looking for **{cfg['num_meetings']} complementary meeting times** "
                  f"so everyone can attend at least one.\n\n")
    return (
        f"### 🎨 Paint your availability\n\n"
        f"**[Open the availability painter →]({url})**\n\n"
        f"{extra}"
        f"Whitelisted respondents: {names or '(none listed)'}\n\n"
        f"Paint your week, click **Export to comment**, and paste the block as a "
        f"comment below. Re-paste anytime to update — only your latest comment counts."
    )


def render_results(cfg, responders, missing, errored, meetings, covered):
    duration = cfg["duration"]
    host_set = {h.lower() for h in cfg["hosts"]}
    by_login = {login: (login, tz, amap) for login, tz, amap in responders}
    length = max(1, -(-duration // RES_MIN))  # ceil, matches solve_meetings
    lines = [f"## ⏰ Meeting plan — `{cfg['meeting']}`", ""]

    got = " ".join(f"@{r[0]}" for r in responders) or "_none yet_"
    lines.append(f"**Responded ({len(responders)}/{len(cfg['whitelist'])}):** {got}")
    if cfg["hosts"]:
        present = {r[0].lower() for r in responders}
        disp = [f"@{h}" + ("" if h.lower() in present else " ⚠️(not responded)")
                for h in cfg["hosts"]]
        lines.append("**Host(s) — required at every meeting:** " + " ".join(disp))
    if missing:
        lines.append("**Waiting on:** " + " ".join(f"@{u}" for u in missing))
    if errored:
        lines.append("**⚠️ Couldn't parse a block from:** " + " ".join(f"@{u}" for u in errored))
    lines.append("")

    if not responders:
        lines.append("_No availability comments yet._")
        return "\n".join(lines)
    if not meetings:
        lines.append(
            f"_No host-feasible {duration}-min window found yet. As more people "
            f"paint their availability — and hosts mark only when they truly can't "
            f"meet — options will appear._"
        )
        return "\n".join(lines)

    # assign each person to one meeting (their most-preferred); hosts attend all
    assigned = {i: [] for i in range(len(meetings))}
    for login, _tz, _amap in responders:
        opts = [(i, m[1][login]) for i, m in enumerate(meetings) if login in m[1]]
        if not opts:
            continue
        if login.lower() in host_set:
            for i, _ in opts:
                assigned[i].append(login)
        else:
            assigned[max(opts, key=lambda o: (o[1], -o[0]))[0]].append(login)

    n, total = len(meetings), len(responders)
    quorum = cfg.get("min_attendees", 1)
    head = (f"### Plan: {n} meeting{'s' if n > 1 else ''} × {duration} min "
            f"— covers {len(covered)}/{total}")
    if quorum > 1:
        head += f" (≥{quorum} per meeting)"
    lines.append(head)
    for i, (start, att, marginal) in enumerate(meetings, 1):
        start_utc = bucket_to_utc(start)
        end_utc = start_utc + timedelta(minutes=duration)
        end_lbl = (f"{end_utc:%H:%M}" if end_utc.weekday() == start_utc.weekday()
                   else f"{DAYS[end_utc.weekday()]} {end_utc:%H:%M}")  # show end day if it crosses midnight
        note = f"{len(att)} can attend"
        if i > 1:
            note += f" · +{marginal} new" if marginal else " · alternative time"
        lines.append(f"\n**Meeting {i} — {DAYS[start_utc.weekday()]} "
                     f"{start_utc:%H:%M}–{end_lbl} UTC**  ·  {note}")
        window = [(start + k) % WEEK_BUCKETS for k in range(length)]
        people = sorted(assigned[i - 1],
                        key=lambda l: (l.lower() not in host_set, l.lower()))
        if not people:
            lines.append("   - _(same people as another meeting — an alternative time)_")
        for login in people:
            _l, tzname, amap = by_login[login]
            eff = min((amap.get(b, 0) for b in window), default=0)
            mark = " ⭐" if eff == 2 else (" ~sometimes" if eff == 1 else "")
            htag = " **(host)**" if login.lower() in host_set else ""
            s = fmt_in_tz(start_utc, tzname)           # "Day HH:MM"
            e_full = fmt_in_tz(end_utc, tzname)
            e = e_full if e_full.split(" ")[0] != s.split(" ")[0] else e_full.split(" ")[-1]
            lines.append(f"   - @{login}{htag} ({tzname}): {s}–{e}{mark}")

    uncovered = [r for r in responders if r[0] not in covered]
    if uncovered:
        fix = "Add a meeting or relax a host block"
        if cfg.get("min_attendees", 1) > 1:
            fix += " or lower the minimum attendees"
        lines.append("\n**⚠️ Not covered by any meeting:** " +
                     " ".join(f"@{r[0]} ({r[1]})" for r in uncovered) +
                     f" — no host-feasible time fits them. {fix}.")
    lines.append("")
    lines.append("<sub>⭐ preferred · ~ sometimes. Computed against the week of "
                 f"{ANCHOR_DATE} (UTC) for DST. Recurring weekly — only weekday + time matter.</sub>")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
def main():
    with open(os.environ["GITHUB_EVENT_PATH"]) as fh:
        event = json.load(fh)
    issue_number = event["issue"]["number"]

    issue = get_issue(issue_number)
    cfg = parse_config(issue)
    comments = get_comments(issue_number)

    pages_url = os.environ.get("PAGES_URL") or f"https://{OWNER}.github.io/{REPONAME}"

    # one bot comment with the prefilled painter link
    upsert_marker_comment(issue_number, comments, LINK_MARKER,
                          render_link(cfg, pages_url))

    # latest valid payload per whitelisted user (comments are in chronological order)
    wl_lower = {u.lower(): u for u in cfg["whitelist"]}
    latest, errored_logins = {}, set()
    for c in comments:
        login = (c.get("user") or {}).get("login", "")
        if login.lower() not in wl_lower:
            continue
        payload = extract_payload(c.get("body"))
        canonical = wl_lower[login.lower()]
        if payload is None:
            if PAYLOAD_MARKER in (c.get("body") or ""):
                # a newer broken submission shadows the older valid one, so the
                # most recent comment truly wins instead of reusing stale data
                errored_logins.add(canonical)
                latest.pop(canonical, None)
            continue
        latest[canonical] = payload
        errored_logins.discard(canonical)

    responders = []
    for login, payload in latest.items():
        amap = normalize(payload)
        if amap is None:
            errored_logins.add(login)
            continue
        responders.append((login, payload.get("tz", "UTC"), amap))

    responded = {r[0].lower() for r in responders}
    missing = [u for u in cfg["whitelist"] if u.lower() not in responded]
    errored = [u for u in cfg["whitelist"] if u in errored_logins and u.lower() not in responded]

    meetings, covered = solve_meetings(
        responders, cfg["hosts"], cfg["num_meetings"], cfg["duration"],
        cfg["min_attendees"])
    body = render_results(cfg, responders, missing, errored, meetings, covered)
    upsert_marker_comment(issue_number, get_comments(issue_number),
                          RESULTS_MARKER, body)
    print(f"Collated {len(responders)} responders; planned {len(meetings)} "
          f"meeting(s) covering {len(covered)}.")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        print(f"GitHub API error {e.code}: {e.read().decode()[:500]}", file=sys.stderr)
        sys.exit(1)
