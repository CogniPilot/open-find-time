# open-find-time

Find a mutual **recurring weekly** meeting time across a group — using nothing
but GitHub. People paint their availability on a static site hosted on GitHub
Pages, then paste the result as a comment on a GitHub issue. A GitHub Actions
workflow reads the whitelisted respondents' comments, converts every timezone to
a common time, and keeps a **Results** comment updated with the best windows.

No server, no database, no OAuth — a respondent's GitHub username on their
comment **is** their identity.

## How it works

```
GitHub Pages (docs/)            GitHub Issue (Meeting Time template)
  paint your week        ──▶      body: whitelist + config
  "Export to comment"             each respondent pastes 1 comment
        │                                   │
        └──────── copy/paste ───────────────┘
                          │
                          ▼
              GitHub Actions (.github/workflows/collate.yml)
              scripts/collate.py:
                • read whitelist + duration from the issue body
                • take each whitelisted user's latest comment
                • normalize every grid → UTC (zoneinfo, DST-correct)
                • rank mutual windows, post a Results comment
```

### Availability model

The painter has three states. **Unpainted = Preferably available** is the
baseline — you start *fully available* and paint only the times you're
**Completely unavailable** or **Sometimes available**.

A meeting time is proposed only if every responding **host** can make it and at
least the configured **minimum number of attendees** can — people who are
completely unavailable simply aren't counted toward that meeting (and may be
covered by a *different* meeting instead). The solver greedily maximizes how many
people are newly covered, then total preference; a ⭐ next to a person means
*that person* prefers the slot rather than merely tolerating it. See
[Hosts and multi-region meetings](#hosts-and-multi-region-meetings) for the full
model and why it can schedule more than one meeting.

### Why default to *available*?

This is a deliberate design choice, and the opposite of most "paint your free
time" tools.

- **Maximize available time, not unavailable time.** The goal is to surface as
  many workable windows as possible. Defaulting everyone to available means the
  feasible set starts wide and only shrinks where someone marks a *real*
  conflict — instead of starting empty and depending on everyone to
  exhaustively paint every free slot (people forget, and the tool then reports
  false conflicts).
- **Make people mark genuine unavailability.** If the default were "unavailable"
  and you painted preferences on top, it's easy — and tempting — to leave slots
  unpainted (i.e. silently "unavailable") just to steer the meeting toward your
  preferred time, *pretending* you're not available when you actually are. By
  forcing an explicit "Completely unavailable" stroke, opting out of a time
  becomes a deliberate, visible act rather than a passive omission.
- **Low effort for the common case.** Most people have a few hard blocks and are
  otherwise flexible. Defaulting to available means they only paint the
  exceptions, which is faster and less error-prone than painting all their free
  time.

So: unpainted means "I'm available," **Sometimes available** is a soft "I'd
rather not, but I can," and **Completely unavailable** is the only hard block —
and you have to actually paint it.

### Hosts and multi-region meetings

Three issue-form fields shape the result:

- **Meeting host(s)** — usernames who *must* be able to attend **every** meeting
  time. Their availability is a hard gate: no window is ever proposed unless all
  responding hosts can make it. Hosts should paint their week too and mark
  *sometimes available* for the unsociable early/late hours they're willing to
  take — that's what lets the solver reach the other regions.
- **Number of meetings** — how many *complementary* meeting times to schedule so
  that **every person can attend at least one** (not N alternatives that each
  need everyone). The same responses feed all of them.
- **Minimum attendees per meeting** — don't propose a meeting unless at least
  this many whitelisted people (including any host) can attend it. Default 2, so
  the tool never schedules a meeting for a single person.

The solver is a greedy, host-gated max-coverage **with regional spread**: meeting 1
covers the most people; each later meeting first covers the most of whoever is
still uncovered and, among equally-good options, is placed at a *different time of
day* from the meetings already chosen — so asking for N meetings yields N
**complementary regional slots** (APAC / EMEA / AMER) rather than several
near-duplicates of one popular window. Once everyone is already covered, a further
meeting is only added if it lands in a genuinely different part of the day
(≥ 4 h away in UTC **by default**); it will never be a 15-minute or one-hour shift
of a time you already have. If there aren't that many well-separated host-feasible
windows, you simply get fewer meetings rather than padded duplicates. When two
meetings are equally preferred for a given person, they're listed under the one at
the saner local hour.

That 4-hour floor is the issue form's **Minimum hours between regional meetings
(advanced)** field — an optional dropdown that defaults to 4 h and that you should
leave alone unless your group's regions are unusually close (lower it) or you want
to force a wider split (raise it). It only affects extra meetings that add no new
attendees; a meeting needed to cover someone is never blocked by it.

This is the APAC/EMEA/AMER case. With a host in AMER and `Number of meetings = 2`,
you typically get one afternoon-EMEA / late-morning-AMER slot and one
morning-APAC / evening-AMER slot — the host attends both, built from a single set
of responses. Anyone who can't make *any* host-feasible time is listed explicitly
as uncovered, so the trade-off is visible rather than hidden.

## Setup (once)

1. **Create a repo** from these files (named e.g. `open-find-time`) and push.
2. **Enable GitHub Pages:** Settings → Pages → Source = *Deploy from a branch* →
   branch `main`, folder `/docs`. Your painter is then at
   `https://<owner>.github.io/<repo>/` (or a custom domain). **This repo is served
   at <https://findtime.cognipilot.org/>** via a custom domain, with the hostname
   committed in `docs/CNAME` so it survives deploys.
3. The painter link in `.github/ISSUE_TEMPLATE/config.yml` is set to
   `https://findtime.cognipilot.org/`. **If you forked this repo,** change it to
   your own `https://<owner>.github.io/<repo>/`.
4. **Custom domain:** set a repo **variable** `PAGES_URL` to your Pages base URL
   (Settings → Secrets and variables → Actions → Variables) so the bot's painter
   links point straight at it. For this repo it is `https://findtime.cognipilot.org`.
5. Actions are enabled by default; the workflow uses the built-in `GITHUB_TOKEN`
   with `issues: write` — no secrets to add.
6. **Create a `meeting-time` label.** GitHub only auto-applies a template's label
   if it already exists, so without it issues open *unlabelled* and the workflow
   skips them. (The workflow also falls back to the `[meeting-time]` title prefix,
   so it still works if you forget — but the label keeps issues tidy/filterable.)

## Running a meeting

1. **New issue → "Meeting Time".** Fill in the meeting ID, slot size, duration,
   visible hours, the **whitelist** of GitHub usernames, and — if relevant — the
   **host(s)** and the **number of meetings** to schedule.
2. On open, the bot posts a comment with a **prefilled link** to the painter
   (noting the host(s) and how many meetings are being sought).
3. Each whitelisted person opens the link, paints their week (in their own
   timezone), clicks **Export to comment**, and pastes the block as a comment.
   Re-paste anytime to update — only the latest comment per person counts; use
   the painter's **Import** box to keep editing a past response.
4. The bot keeps a **Results** comment updated with the meeting plan — each
   meeting's time in every attendee's local timezone plus UTC, who's assigned to
   it, and anyone left uncovered.

## Live results heatmap

`docs/results.html` is a second page that renders a **live overlap heatmap** for
a meeting issue, in *your own* timezone — handy for eyeballing when the group is
free without re-reading the bot's text. It reads the public issue's comments
straight from the GitHub REST API (no auth, nothing stored) and reuses the exact
same UTC normalization as the workflow, so the picture always matches the
computed plan. Open `…/results.html?repo=<owner>/<name>&issue=<n>`, or just open
`results.html` and type them in.

> Anonymous GitHub API access is rate-limited to 60 requests/hour per IP and only
> works on public repos.

## Notes & limitations

- **Recurring weekly:** only weekday + time matter. DST is resolved against the
  current week at run time via Python's `zoneinfo`. Known edge: during the one
  spring-forward week per year, a slot falling in the non-existent "lost hour"
  can place the browser heatmap and the bot's UTC buckets up to an hour apart for
  that hour only; the bot's posted plan is authoritative. (Tracked for a fix.)
- **Timezone confidence:** the painter auto-detects your browser timezone but
  shows a confirmation line (e.g. "it's *Tue 14:30* there now") next to a full
  timezone picker, so you can fix it if you're on a VPN or travelling **before**
  exporting. The same confirmation appears on the results page.
- **Whitelist is authoritative:** comments from non-whitelisted users are
  ignored. Anyone with a GitHub account can comment, but only the listed
  usernames are counted.
- **Public repo recommended** so respondents can comment freely.
- The painter does no network calls; it only encodes/decodes the comment block.

## Files

| Path | Purpose |
|------|---------|
| `docs/index.html` · `app.js` | Paintable weekly availability grid + export |
| `docs/results.html` · `results.js` | Live overlap heatmap (reads the issue via the GitHub API) |
| `.github/ISSUE_TEMPLATE/meeting-time.yml` | Issue form: meeting, hosts, #meetings, quorum, whitelist |
| `.github/workflows/collate.yml` | Runs on issue / comment events |
| `scripts/collate.py` | Parses comments, normalizes timezones, host-gated coverage solver |
