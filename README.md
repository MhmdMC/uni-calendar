# Semester Planner

A Flask timetable with a password-protected admin panel and an offline-capable student app. This package replaces the earlier single HTML version; it must be served by Flask.

## First-time setup

Requires Python 3.11 or newer. From this folder:

```sh
python -m venv .venv
```

Activate the environment:

- Windows PowerShell: `.venv\Scripts\Activate.ps1`
- macOS/Linux: `source .venv/bin/activate`

Then install and choose your admin password:

```sh
python -m pip install -r requirements.txt
python -m flask --app app:create_app set-admin-password
```

Use at least 12 characters. There is **no built-in password**. Passwords are stored as hashes. Running the same command later changes the password and invalidates old admin sessions.

## Run locally

Windows PowerShell:

```powershell
$env:APP_ENV = "development"
python -m flask --app app:create_app run --host 127.0.0.1 --port 8765
```

macOS/Linux:

```sh
APP_ENV=development python -m flask --app app:create_app run --host 127.0.0.1 --port 8765
```

Student page: http://127.0.0.1:8765/ · Admin: http://127.0.0.1:8765/admin

The old `/semester-one.html` URL also opens the new app. The Flask development server is only for local testing.

## Hosting

Use a Python/Flask host with **HTTPS and a persistent writable disk**. Static HTML hosting alone cannot run this package. Run one app instance, or multiple workers on the same machine sharing the same SQLite database and secret; this package is not a multi-server deployment.

Production command after installing dependencies:

```sh
waitress-serve --host=0.0.0.0 --port=8080 --call app:create_app
```

Terminate HTTPS at your host's reverse proxy. Leave `APP_ENV` unset in production: admin session cookies are then HTTPS-only. Set `TRUST_PROXY=1` **only** when exactly one trusted proxy sits in front of the app and direct access to the app port is blocked. Otherwise leave it unset.

Useful environment variables:

| Variable | Purpose |
|---|---|
| `PLANNER_INSTANCE` | Absolute path to your persistent data directory. Default: `instance/` beside the app. |
| `SECRET_KEY` | Optional persistent random secret, at least 32 characters. If omitted, the app creates `instance/secret.key` once. |
| `ADMIN_PASSWORD_HASH` | Optional Werkzeug password hash supplied as a host secret. Overrides the database password. |
| `APP_ENV=development` | Allows HTTP admin cookies for local use only. |
| `TRUST_PROXY=1` | Trust exactly one controlled reverse proxy. |

Keep `instance/` across restarts and deployments. It contains the published data, version history, password hash, and signing secret. Do not serve this directory publicly or include it in a public repository. Back it up while the app is stopped, or use SQLite's backup API for the database. Do not copy only a live SQLite main file while its WAL is active.

The seed `data/semester-5.json` is used only when the database is empty. Replacing that file does not change an already initialized site: use the admin import flow.

## Publish a new semester or correction

1. Open `/admin` and sign in.
2. Download the current JSON to retain existing semesters.
3. Send that JSON plus the new calendar and timetable to your assistant and ask for an updated import file matching `schema.json`.
4. Upload or paste the returned JSON. Select **Validate & preview**.
5. Review the semester summary, then **Publish this version**.

An import replaces the entire shared dataset. Keep old semesters in the `semesters` list if you want them in the selector. Set `active_semester_id` to the default semester students should see when opening the app. Semester names, start/end dates, groups, courses, class times, lab assignments, recurrence, and calendar entries all come from JSON.

Malformed files, unknown groups/courses, invalid dates/times, and same-group overlapping sessions are rejected without changing live data. Every successful import creates a revision. **Preview restore** lets you publish an earlier revision again without deleting history. A preview expires after one hour and cannot overwrite a newer revision published in the meantime.

## How updates and offline use work

- Every opening, return to the foreground, and reconnection fetches the current published dataset with HTTP caching disabled.
- A service worker stores only the public app shell. The latest successful dataset is saved separately on the device. A full offline reload uses both saved copies.
- App code changes get an automatic content-based build ID. Reopening online gets the new files. Returning to an already open app checks the server build and reloads when needed.
- Incoming data updates or reloads wait until an open calendar/settings editor is closed, so unfinished input is not discarded.
- Failed requests leave the last usable dataset intact. The status tells the student when the page is offline.
- Admin pages, passwords, sessions, and admin/API responses are never put in service-worker caches. The admin panel requires a connection.
- Personal calendar entries and default group choices are local, per semester. Shared schedule updates do not overwrite personal entries. A student's deliberate edits/removals of shared calendar entries stay as local overrides while those shared entry IDs exist. They do not edit the server's schedule.

For iPhone: use the HTTPS site in Safari, choose **Add to Home Screen**, open the resulting app while connected, and wait for **Ready offline**. This is different from opening a downloaded HTML file in Files. Clearing website data, removing stored app data, or browser storage eviction may remove personal edits and the offline copy. No cross-device synchronization is included.

## Calendar coverage and initial dates

The month selector includes the selected semester's date range plus months containing its calendar entries, shared entries, or personal entries. It skips empty gaps and does not render an unlimited sequence of empty months. Week view supports classes on any day, including weekends.

The initial dataset uses **Calendrier ULFG 2026-2027.pdf**, supplied by the user:

- Semester 5: **14 September 2026–29 January 2027**, including finals.
- Partials: **2–13 November 2026**, weekdays.
- Last teaching day: **15 January 2027**.
- Finals: **18–29 January 2027**, weekdays.
- Between-semester break: **1–5 February 2027**.
- Later academic-year events are shared calendar entries; no Semester 6 courses have been invented.
- Exam days and holidays suppress classes. Dates are copied from the university calendar, including its exceptions and named holidays. The university's future religious holiday dates may be revised; importing an updated JSON applies corrections.

The phone's local date/time drives the day view and now marker. Semester boundaries are inclusive; “days left” includes today. Exam periods do not imply individual exam appointment times. Personal exam details can be added to a day.

## Import format and tests

See `IMPORT-FORMAT.md` for field meanings and a minimal example. `schema.json` is machine-readable. The initial full import is `data/semester-5.json`.

```sh
python -m flask --app app:create_app validate-import data/semester-5.json
python -m unittest discover -s tests -v
```

Security and server tests cover login protection, CSRF, password changes, throttling, validation, atomic publishing, stale previews, and restoration. Browser checks performed during delivery covered offline full reload, current-data refresh, personal entry retention, future-semester groups, alternating-week weekend sessions, mobile layout, and cache isolation. Actual iPhone hardware has not been tested.
