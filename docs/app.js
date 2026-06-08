// Paint-your-week availability tool — pure client side, no network calls.
// Output is a self-describing comment block parsed by the GitHub Actions workflow.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATE_NAMES = ["Completely unavailable", "Sometimes available", "Preferably available"];
const MARKER = "AVAILABILITY:v1";
const VERSION = 1;

// ---- config from URL params (so an issue can link a preconfigured grid) ----
const params = new URLSearchParams(location.search);
const clampInt = (v, def, lo, hi) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
};
const cfg = {
  meeting: params.get("meeting") || "",
  slotMinutes: [15, 30, 60].includes(parseInt(params.get("slot"), 10)) ? parseInt(params.get("slot"), 10) : 30,
  startHour: clampInt(params.get("start"), 0, 0, 23),
  endHour: clampInt(params.get("end"), 24, 1, 24),
};
if (cfg.endHour <= cfg.startHour) { cfg.startHour = 0; cfg.endHour = 24; }

// A shared link can carry a full painted grid (`g`) + timezone to reopen the exact selection.
const sharedGrid = params.get("g");
const sharedTz = params.get("tz");

// ---- DOM refs ----
const meetingEl = document.getElementById("meeting");
const tzEl = document.getElementById("tz");
const tzNoteEl = document.getElementById("tz-note");
const gridWrap = document.getElementById("grid-wrap");
const exportEl = document.getElementById("export");
const importEl = document.getElementById("import");

meetingEl.value = cfg.meeting;

const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
function ensureTzOption(tz) {
  if (!tz) return;
  if (![...tzEl.options].some((o) => o.value === tz)) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = tz;
    tzEl.appendChild(opt);
  }
}
function populateTimezones() {
  let zones = [];
  try {
    zones = (Intl.supportedValuesOf && Intl.supportedValuesOf("timeZone")) || [];
  } catch {
    zones = [];
  }
  if (!zones.length) zones = ["UTC"]; // fallback for older browsers
  for (const z of zones) {
    const opt = document.createElement("option");
    opt.value = opt.textContent = z;
    tzEl.appendChild(opt);
  }
  ensureTzOption(detectedTz); // make sure the detected zone is selectable
  tzEl.value = detectedTz;
}
populateTimezones();
if (sharedTz && isValidTz(sharedTz)) { ensureTzOption(sharedTz); tzEl.value = sharedTz; }

// Confirmation line so people can sanity-check the zone — browser auto-detect
// can be wrong on a VPN or while travelling.
function nowInTz(tz) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(new Date());
  } catch {
    return "?";
  }
}
function isValidTz(tz) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}
function updateTzNote() {
  const tz = tzEl.value;
  const origin = tz === detectedTz
    ? "auto-detected from your browser"
    : `you changed this from your browser's ${detectedTz}`;
  tzNoteEl.innerHTML =
    `You're painting in <strong>${tz}</strong> — it's <strong>${nowInTz(tz)}</strong> there right now ` +
    `(${origin}). <span class="tz-warn">If that time looks off — e.g. you're travelling or on a VPN — ` +
    `pick your real timezone above before exporting.</span>`;
}
updateTzNote();
tzEl.addEventListener("change", updateTzNote);
setInterval(updateTzNote, 30000);

// ---- state ----
let rows = ((cfg.endHour - cfg.startHour) * 60) / cfg.slotMinutes;
// Default is 2 (preferably available): everyone starts fully available and
// paints only their genuine unavailability. See README "Why default to available".
let state = DAYS.map(() => new Array(rows).fill(2)); // 0=unavailable, 1=sometimes, 2=preferably
// reopen an exact selection carried in a shared link
if (sharedGrid && /^[0-2]+$/.test(sharedGrid) && sharedGrid.length === DAYS.length * rows) {
  state = DAYS.map((_, d) => Array.from(sharedGrid.slice(d * rows, (d + 1) * rows), (ch) => +ch));
}
let currentBrush = 0;
let painting = false;

function minuteLabel(rowIndex) {
  const mins = cfg.startHour * 60 + rowIndex * cfg.slotMinutes;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function buildGrid() {
  rows = ((cfg.endHour - cfg.startHour) * 60) / cfg.slotMinutes;
  const table = document.createElement("table");
  table.className = "grid";

  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  htr.appendChild(document.createElement("th")).className = "time";
  for (const d of DAYS) {
    const th = document.createElement("th");
    th.textContent = d;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let r = 0; r < rows; r++) {
    const tr = document.createElement("tr");
    const mins = cfg.startHour * 60 + r * cfg.slotMinutes;
    if (mins % 60 === 0) tr.className = "hourline";
    const th = document.createElement("th");
    th.className = "time";
    th.textContent = mins % 60 === 0 ? minuteLabel(r) : "";
    tr.appendChild(th);
    for (let d = 0; d < DAYS.length; d++) {
      const td = document.createElement("td");
      td.dataset.day = String(d);
      td.dataset.row = String(r);
      td.dataset.state = String(state[d][r]);
      td.title = `${DAYS[d]} ${minuteLabel(r)}`;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  gridWrap.replaceChildren(table);
  wirePainting(table);
}

function applyBrush(td) {
  if (!td || td.tagName !== "TD") return;
  const d = +td.dataset.day, r = +td.dataset.row;
  state[d][r] = currentBrush;
  td.dataset.state = String(currentBrush);
}

function wirePainting(table) {
  table.addEventListener("pointerdown", (e) => {
    const td = e.target.closest("td");
    if (!td) return;
    e.preventDefault();
    painting = true;
    applyBrush(td);
    // pointer capture lets us keep painting even if pointer leaves the cell
    if (table.setPointerCapture) table.setPointerCapture(e.pointerId);
  });
  table.addEventListener("pointermove", (e) => {
    if (!painting) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const td = el && el.closest ? el.closest("td") : null;
    if (td && table.contains(td)) applyBrush(td);
  });
  const stop = () => { painting = false; };
  table.addEventListener("pointerup", stop);
  table.addEventListener("pointercancel", stop);
  // window-level "stop painting" is registered once at module init (below), not
  // here, so repeated buildGrid() calls (reset/import) don't leak listeners.
}

// ---- brush selection ----
document.querySelectorAll(".brush").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentBrush = +btn.dataset.brush;
    document.querySelectorAll(".brush").forEach((b) => b.classList.toggle("active", b === btn));
  });
});
document.querySelector('.brush[data-brush="0"]').classList.add("active");

document.getElementById("clear").addEventListener("click", () => {
  state = DAYS.map(() => new Array(rows).fill(2)); // reset to all-available
  buildGrid();
  updateExport();
});

// ---- export / import ----
function buildPayload() {
  const grid = {};
  for (let d = 0; d < DAYS.length; d++) grid[DAYS[d]] = state[d].join("");
  return {
    kind: "availability",
    version: VERSION,
    meeting: meetingEl.value.trim(),
    tz: tzEl.value.trim() || "UTC",
    slotMinutes: cfg.slotMinutes,
    startHour: cfg.startHour,
    endHour: cfg.endHour,
    days: DAYS,
    grid,
  };
}

function selfLink(payload) {
  const grid = DAYS.map((d) => payload.grid[d]).join("");
  const qs = new URLSearchParams({
    meeting: payload.meeting, tz: payload.tz, slot: String(payload.slotMinutes),
    start: String(payload.startHour), end: String(payload.endHour), g: grid,
  }).toString();
  return `${location.origin}${location.pathname}?${qs}`;
}

function updateExport() {
  const payload = buildPayload();
  const json = JSON.stringify(payload, null, 2);
  exportEl.value =
    `**Availability** for \`${payload.meeting || "(set a Meeting ID)"}\` — timezone \`${payload.tz}\`\n` +
    `[🔗 Reopen this exact selection](${selfLink(payload)})\n` +
    `<!-- ${MARKER} -->\n` +
    "```json\n" + json + "\n```\n";
}

["input", "change"].forEach((ev) => {
  meetingEl.addEventListener(ev, updateExport);
  tzEl.addEventListener(ev, updateExport);
});
// keep export fresh as you paint; this single window listener also stops painting
gridWrap.addEventListener("pointerup", updateExport);
window.addEventListener("pointerup", () => { painting = false; updateExport(); });

document.getElementById("copy").addEventListener("click", async () => {
  updateExport();
  try {
    await navigator.clipboard.writeText(exportEl.value);
    flash(document.getElementById("copy"), "Copied!");
  } catch {
    exportEl.select();
    document.execCommand("copy");
    flash(document.getElementById("copy"), "Copied!");
  }
});

function flash(btn, msg) {
  const old = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => (btn.textContent = old), 1200);
}

document.getElementById("import-btn").addEventListener("click", () => {
  const text = importEl.value;
  const m = text.match(/```json\s*([\s\S]*?)```/);
  let payload;
  try {
    payload = JSON.parse(m ? m[1] : text);
  } catch {
    alert("Couldn't find a valid availability block in that text.");
    return;
  }
  if (payload.kind !== "availability") {
    alert("That doesn't look like an availability block.");
    return;
  }
  // adopt the imported grid shape, validating the same way as URL-param config
  cfg.slotMinutes = [15, 30, 60].includes(+payload.slotMinutes) ? +payload.slotMinutes : cfg.slotMinutes;
  cfg.startHour = clampInt(payload.startHour, cfg.startHour, 0, 23);
  cfg.endHour = clampInt(payload.endHour, cfg.endHour, 1, 24);
  if (cfg.endHour <= cfg.startHour) { cfg.startHour = 0; cfg.endHour = 24; }
  rows = ((cfg.endHour - cfg.startHour) * 60) / cfg.slotMinutes;
  state = DAYS.map((d) => {
    const s = (payload.grid && payload.grid[d]) || "";
    const arr = new Array(rows).fill(2); // unspecified/invalid cells default to available
    for (let i = 0; i < rows; i++) {
      const v = parseInt(s[i], 10);
      arr[i] = Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : 2;
    }
    return arr;
  });
  if (payload.meeting) meetingEl.value = payload.meeting;
  if (payload.tz && isValidTz(payload.tz)) { ensureTzOption(payload.tz); tzEl.value = payload.tz; }
  buildGrid();
  updateExport();
  updateTzNote();
  flash(document.getElementById("import-btn"), "Loaded!");
});

// ---- init ----
buildGrid();
updateExport();
