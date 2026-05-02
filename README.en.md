<p align="center">
  <img src="logo-transparent.png" alt="Team Time" width="156">
</p>

<h1 align="center">Team Time</h1>

<p align="center">
  A mobile-first trip scheduling app for small groups, with automatic availability heatmaps and best-time recommendations.
</p>

<p align="center">
  <img alt="Node.js v24+" src="https://img.shields.io/badge/Node.js-v24%2B-118a45?style=flat-square">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-node%3Asqlite-1d6fb8?style=flat-square">
  <img alt="No runtime dependencies" src="https://img.shields.io/badge/runtime-0_dependencies-0f766e?style=flat-square">
</p>

<p align="center">
  <a href="README.md">简体中文</a>
  <span> · </span>
  <strong>English</strong>
</p>

## Overview

Team Time is a mobile-first trip scheduling web app for small groups. An organizer creates a trip, sets candidate dates, expected duration, and the recommended daily time range. Members join with a short trip code, mark their availability by date, and the app automatically produces a group heatmap, the best continuous time window, and an `.ics` calendar export.

## Features

- Create or join a trip with a short shareable code.
- Let the organizer manage the trip name, candidate dates, expected duration, and daily recommendation range.
- Let each member edit availability in 30-minute slots for every candidate date, with slots free by default and tap-to-mark busy.
- Sync edits from the local browser session and show a group heatmap after multiple members join.
- Calculate the best continuous time window across all candidate dates and export it as a calendar file.

## Screenshots

| Availability | Heatmap | Summary |
| --- | --- | --- |
| <img src="docs/screenshots/availability-mobile.png" alt="Availability editor on mobile" width="240"> | <img src="docs/screenshots/heatmap-mobile.png" alt="Group heatmap on mobile" width="240"> | <img src="docs/screenshots/summary-desktop.png" alt="Recommended time summary on desktop" width="360"> |

## Tech Stack

- Frontend: plain `index.html`, `app.js`, and `styles.css`
- Backend: plain Node.js HTTP server in `server.js`
- Database: built-in Node.js `node:sqlite` with the file database `team-time.db`
- Runtime dependencies: no third-party runtime dependencies

## Local Development

Node.js `v24+` is required because the project uses the built-in `node:sqlite` module.

```bash
npm install
npm run dev
```

Default URLs:

- Web: `http://localhost:4173`
- Health check: `http://localhost:4173/api/health`

Optional environment variables:

- `HOST`: listen address, default `0.0.0.0`
- `PORT`: server port, default `4173`
- `DATA_DIR`: database directory, default `data`

## Verification

```bash
npm run check
npm run smoke:api
npm run test:e2e
```

You can also run the full verification suite at once:

```bash
npm run verify
```

What the checks cover:

- `check`: validates the syntax of `server.js`, `app.js`, and the test scripts.
- `smoke:api`: starts a temporary server and verifies health checks, trip creation, joining a trip, multi-date availability, organizer permissions, non-default ports, temporary `DATA_DIR`, and data persistence after restart.
- `test:e2e`: runs the mobile-first Playwright flow for creation, joining, date switching, busy-slot marking, heatmap, summary page, and the `.ics` download entry, then writes screenshots to `test-results/e2e/`.

Before the first Playwright run, install a browser if the machine does not already have Chrome or Edge available:

```bash
npm run browsers:install
```

To use a specific browser executable, set:

```bash
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome-or-edge
```

Test data is written to `.tmp-smoke-data/`. The scripts clean that directory, and it is already listed in `.gitignore`.

## Docker Deployment

Build the production image:

```bash
docker build -t team-time:local .
```

Run the container directly:

```bash
docker run -d --name team-time -p 4173:4173 -v team-time-data:/app/data team-time:local
```

Docker Compose is the recommended way to start the service:

```bash
docker compose up -d --build
```

Use a custom host port:

```bash
HOST_PORT=8080 docker compose up -d --build
```

Common operations:

```bash
docker compose logs -f
docker compose down
```

The default URL is `http://localhost:4173`, and the health check is `http://localhost:4173/api/health`. Inside the container, the service port is fixed at `4173` and the data directory is fixed at `/app/data`.

Compose persists the database in the named volume `team-time-data`. Removing the container or running `docker compose down` does not delete trip data. If that volume is deleted, `team-time.db` and all trip data are deleted with it.

## Public Deployment

Deploy to a platform that can run Node.js 24+ and provide persistent disk storage, such as Render, Railway, Fly.io, or a VPS. Do not deploy to static-only hosting because the app needs a backend API and a SQLite database.

Recommended environment variables:

```bash
HOST=0.0.0.0
PORT=<platform-assigned-port>
DATA_DIR=/persistent/team-time-data
```

Deployment notes:

- `DATA_DIR` must point to a persistent disk or volume, otherwise trip data is lost after service restarts.
- The database file is created automatically at `${DATA_DIR}/team-time.db`.
- Use `npm start` as the start command.
- After deployment, visit `/api/health`, then run through one create-and-join trip flow.

## API Contract

Reserved public endpoints:

- `GET /api/health`
- `POST /api/teams`
- `POST /api/teams/join`
- `GET /api/teams/:code`
- `PATCH /api/teams/:code?memberId=...`
- `PUT /api/teams/:code/members/:id/availability`

The `team` response includes `tripDates`, `durationMinutes`, `dayStartMinutes`, and `dayEndMinutes`. Member responses include `availabilityByDate`. Only members with `role === "发起人"` can update trip settings through `PATCH /api/teams/:code?memberId=...`.

## Database

- Default data directory: `data`
- Default database path: `data/team-time.db`
- Tables: `teams`, `members`, `availabilities`
- On startup, the server automatically creates missing tables and migrates legacy single-date availability data to the multi-date structure.
