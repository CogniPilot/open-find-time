// Results view: read a public GitHub issue's availability comments and render an
// overlap heatmap in the viewer's own timezone. Mirrors scripts/collate.py's
// UTC-bucket normalization so the picture matches the bot's computed plan.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const RES_MIN = 15;
const WEEK_BUCKETS = (7 * 24 * 60) / RES_MIN; // 672
const RESULTS_MARKER = "<!-- MEETING-RESULTS -->";
const PAYLOAD_MARKER = "AVAILABILITY:v1";

const repoEl = document.getElementById("repo");
const issueEl = document.getElementById("issue");
const viewerTzEl = document.getElementById("viewer-tz");
const viewerTzNoteEl = document.getElementById("viewer-tz-note");
const statusEl = document.getElementById("status");
const respEl = document.getElementById("responders");
const heatWrap = document.getElementById("heatmap-wrap");
const planEl = document.getElementById("plan");

const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// ---- timezone math (same model as collate.py) ----
function anchorMondayUTC() {
  const now = new Date();
  const dow = (now.getUTCDay() + 6) % 7; // 0 = Monday
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - dow * 86400000;
}
const ANCHOR = anchorMondayUTC();

function tzOffsetMin(tz, ms) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - ms) / 60000;
}

// wall-clock time in `tz` -> UTC milliseconds (two-pass to settle DST boundaries)
function wallToUTC(tz, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let utc = guess - tzOffsetMin(tz, guess) * 60000;
  utc = guess - tzOffsetMin(tz, utc) * 60000;
  return utc;
}

function utcDateParts(ms) {
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

function bucketOf(utcMs) {
  let b = Math.floor((utcMs - ANCHOR) / 60000 / RES_MIN) % WEEK_BUCKETS;
  return b < 0 ? b + WEEK_BUCKETS : b;
}

// ---- parsing (mirror of collate.py helpers) ----
function parseIssueForm(body) {
  const f = {};
  let h = null, buf = [];
  for (const line of (body || "").split("\n")) {
    if (line.startsWith("### ")) {
      if (h !== null) f[h.toLowerCase()] = buf.join("\n").trim();
      h = line.slice(4).trim(); buf = [];
    } else buf.push(line);
  }
  if (h !== null) f[h.toLowerCase()] = buf.join("\n").trim();
  return f;
}
function field(f, label, def = "") {
  const v = f[label.toLowerCase()];
  return !v || v === "_No response_" ? def : v;
}
function parseUsers(text) {
  // Line-by-line so prose ("@a and friends") can't harvest phantom usernames:
  // take @-mentions from any line containing '@', else a sole bare username.
  const out = [];
  const add = (t) => { if (t && !out.some((u) => u.toLowerCase() === t.toLowerCase())) out.push(t); };
  for (let line of (text || "").split("\n")) {
    line = line.trim();
    if (!line) continue;
    if (line.includes("@")) {
      for (const m of line.matchAll(/@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/g)) add(m[1]);
    } else if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(line)) {
      add(line);
    }
  }
  return out;
}
function clampInt(v, def, lo, hi) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
}
function extractPayload(body) {
  const m = (body || "").match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]);
    return d.kind === "availability" ? d : null;
  } catch {
    return null;
  }
}
function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}
function isValidTz(tz) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

function normalizePayload(p) {
  const tz = p.tz || "UTC";
  if (!isValidTz(tz)) return null; // mirror collate.py dropping unknown zones as errored
  const slot = Number.isFinite(+p.slotMinutes) ? +p.slotMinutes : 30;
  const startHour = Number.isFinite(+p.startHour) ? +p.startHour : 0;
  const grid = p.grid || {};
  const steps = Math.max(1, Math.floor(slot / RES_MIN));
  const map = new Map();
  for (let di = 0; di < 7; di++) {
    const s = grid[DAYS[di]] || "";
    const [Y, Mo, D] = utcDateParts(ANCHOR + di * 86400000);
    for (let i = 0; i < s.length; i++) {
      const st = +s[i];
      if (!(st >= 1)) continue;
      const mins = startHour * 60 + i * slot;
      const base = wallToUTC(tz, Y, Mo, D, Math.floor(mins / 60), mins % 60);
      for (let k = 0; k < steps; k++) {
        const b = bucketOf(base + k * RES_MIN * 60000);
        map.set(b, Math.max(map.get(b) || 0, st));
      }
    }
  }
  return map;
}

function aggregate(maps) {
  const agg = Array.from({ length: WEEK_BUCKETS }, () => ({ pref: 0, some: 0 }));
  for (const m of maps) {
    for (const [b, st] of m) {
      if (st === 2) agg[b].pref++;
      else if (st === 1) agg[b].some++;
    }
  }
  return agg;
}

// ---- GitHub API (anonymous, public repos only) ----
async function gh(path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (r.status === 403)
    throw new Error("GitHub API rate limit reached (60/hour for anonymous use). Try again later, or read the issue directly.");
  if (r.status === 404) throw new Error("Issue or repo not found — is the repo public?");
  if (!r.ok) throw new Error(`GitHub API error ${r.status}`);
  return r.json();
}
async function loadComments(repo, issue) {
  // Uncapped (mirrors collate.py) so the newest comments — which are authoritative
  // under "latest wins" — are never silently dropped on a busy recurring issue.
  let out = [], page = 1;
  for (;;) {
    const chunk = await gh(`/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`);
    out = out.concat(chunk);
    if (chunk.length < 100) break;
    page++;
  }
  return out;
}

// ---- rendering ----
function pad(n) { return String(n).padStart(2, "0"); }

function renderResponders(responders, hosts, errored) {
  const hostSet = new Set(hosts.map((h) => h.toLowerCase()));
  if (!responders.length && !(errored && errored.size)) { respEl.innerHTML = ""; return; }
  const chips = responders.map(([login, p]) => {
    const host = hostSet.has(login.toLowerCase()) ? " 👑" : "";
    return `<span class="chip">@${esc(login)}${host} <small>${esc(p.tz || "?")}</small></span>`;
  });
  let html = `<p class="hint">Responses (${responders.length}):</p>` + chips.join(" ");
  if (errored && errored.size) {
    html += `<p class="hint tz-warn">⚠️ Couldn't parse a block from: ` +
      [...errored].map((u) => `@${esc(u)}`).join(" ") + `</p>`;
  }
  respEl.innerHTML = html;
}

function renderHeatmap(agg, total, viewerTz, startHour, endHour) {
  const step = 30, subs = step / RES_MIN;
  const table = document.createElement("table");
  table.className = "grid heat";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  htr.appendChild(document.createElement("th")).className = "time";
  for (const d of DAYS) { const th = document.createElement("th"); th.textContent = d; htr.appendChild(th); }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let t = startHour * 60; t < endHour * 60; t += step) {
    const tr = document.createElement("tr");
    if (t % 60 === 0) tr.className = "hourline";
    const th = document.createElement("th");
    th.className = "time";
    th.textContent = t % 60 === 0 ? `${pad(t / 60)}:00` : "";
    tr.appendChild(th);
    for (let d = 0; d < 7; d++) {
      const [Y, Mo, D] = utcDateParts(ANCHOR + d * 86400000);
      let avail = Infinity, pref = Infinity;
      for (let sub = 0; sub < subs; sub++) {
        const mins = t + sub * RES_MIN;
        const b = bucketOf(wallToUTC(viewerTz, Y, Mo, D, Math.floor(mins / 60), mins % 60));
        avail = Math.min(avail, agg[b].pref + agg[b].some);
        pref = Math.min(pref, agg[b].pref);
      }
      const td = document.createElement("td");
      const frac = total ? avail / total : 0;
      td.style.background = frac > 0 ? `rgba(16,185,129,${(0.15 + 0.85 * frac).toFixed(3)})` : "";
      if (total && avail === total) td.classList.add("full");
      td.textContent = total ? String(avail) : "";
      td.title = `${DAYS[d]} ${pad(Math.floor(t / 60))}:${pad(t % 60)} — ${avail}/${total} available` +
        (pref ? ` (${pref} prefer)` : "");
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  heatWrap.innerHTML = `<p class="hint">Numbers = how many of ${total} can meet (darker = more). 🟩 full = everyone. Times in <strong>${viewerTz}</strong>.</p>`;
  heatWrap.appendChild(table);
}

function renderPlan(comments) {
  const c = comments.find((x) => (x.body || "").includes(RESULTS_MARKER));
  if (!c) { planEl.innerHTML = ""; return; }
  const body = c.body.replace(RESULTS_MARKER, "").trim();
  planEl.innerHTML =
    `<details open><summary>Bot's computed plan (authoritative)</summary>` +
    `<pre class="plan">${body.replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]))}</pre>` +
    `<p class="hint"><a href="${c.html_url}">Open on GitHub →</a></p></details>`;
}

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#b91c1c" : "";
}

let lastData = null; // {agg, total, startHour, endHour} so the TZ picker can re-render
async function run() {
  const repo = repoEl.value.trim().replace(/^https?:\/\/github\.com\//, "");
  const issue = issueEl.value.trim().replace(/[^0-9]/g, "");
  if (!repo.includes("/") || !issue) { setStatus("Enter a repo (owner/name) and issue number.", true); return; }
  setStatus("Loading…");
  respEl.innerHTML = heatWrap.innerHTML = planEl.innerHTML = "";
  try {
    const issueData = await gh(`/repos/${repo}/issues/${issue}`);
    const f = parseIssueForm(issueData.body || "");
    const whitelist = parseUsers(field(f, "Whitelisted respondents"));
    const hosts = parseUsers(field(f, "Meeting host(s)"));
    for (const h of hosts)
      if (!whitelist.some((w) => w.toLowerCase() === h.toLowerCase())) whitelist.push(h);
    let startHour = clampInt(field(f, "Earliest hour shown (0-24)", "0"), 0, 0, 23);
    let endHour = clampInt(field(f, "Latest hour shown (0-24)", "24"), 24, 1, 24);
    if (endHour <= startHour) { startHour = 0; endHour = 24; }

    const comments = await loadComments(repo, issue);
    const wl = new Map(whitelist.map((u) => [u.toLowerCase(), u]));
    const latest = new Map();
    const errored = new Set();
    for (const c of comments) {
      const login = (c.user && c.user.login) || "";
      if (!wl.has(login.toLowerCase())) continue;
      const canonical = wl.get(login.toLowerCase());
      const p = extractPayload(c.body);
      if (p) { latest.set(canonical, p); errored.delete(canonical); }
      // a newer broken submission shadows an older valid one (latest wins)
      else if ((c.body || "").includes(PAYLOAD_MARKER)) { latest.delete(canonical); errored.add(canonical); }
    }
    const maps = [], responders = [];
    for (const [login, p] of latest) {
      const m = normalizePayload(p);
      if (m === null) { errored.add(login); continue; } // bad timezone -> errored, like the bot
      maps.push(m);
      responders.push([login, p]);
    }
    const agg = aggregate(maps);
    lastData = { agg, total: responders.length, startHour, endHour };

    renderResponders(responders, hosts, errored);
    renderHeatmap(agg, responders.length, viewerTzEl.value, startHour, endHour);
    renderPlan(comments);
    const extra = errored.size ? `, ${errored.size} unparseable` : "";
    setStatus(`${responders.length}/${whitelist.length} responded${extra}.`);
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
}

// ---- timezone picker ----
function populateTimezones() {
  let zones = [];
  try { zones = (Intl.supportedValuesOf && Intl.supportedValuesOf("timeZone")) || []; } catch { zones = []; }
  if (!zones.length) zones = ["UTC"];
  for (const z of zones) {
    const o = document.createElement("option");
    o.value = o.textContent = z;
    viewerTzEl.appendChild(o);
  }
  if (![...viewerTzEl.options].some((o) => o.value === detectedTz)) {
    const o = document.createElement("option");
    o.value = o.textContent = detectedTz;
    viewerTzEl.appendChild(o);
  }
  viewerTzEl.value = detectedTz;
}

function nowInTz(tz) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date());
  } catch {
    return "?";
  }
}
function updateViewerTzNote() {
  const tz = viewerTzEl.value;
  const origin = tz === detectedTz
    ? "auto-detected from your browser"
    : `you changed this from your browser's ${detectedTz}`;
  viewerTzNoteEl.innerHTML =
    `Heatmap shown in <strong>${tz}</strong> — it's <strong>${nowInTz(tz)}</strong> there now ` +
    `(${origin}). <span class="tz-warn">On a VPN or travelling? Pick the timezone you want to read times in.</span>`;
}

// ---- init ----
populateTimezones();
updateViewerTzNote();
setInterval(updateViewerTzNote, 30000);
const params = new URLSearchParams(location.search);
if (params.get("repo")) repoEl.value = params.get("repo");
if (params.get("issue")) issueEl.value = params.get("issue");
document.getElementById("load").addEventListener("click", run);
viewerTzEl.addEventListener("change", () => {
  updateViewerTzNote();
  if (lastData) renderHeatmap(lastData.agg, lastData.total, viewerTzEl.value, lastData.startHour, lastData.endHour);
});
if (repoEl.value && issueEl.value) run();
