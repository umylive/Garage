# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Garage** is a self-hosted vehicle maintenance tracker PWA, designed to run on Unraid via Docker. Users track service schedules, fuel fills, and costs for multiple cars. All data stays on the server.

## Running the App

There is no local dev server setup — the app runs inside Docker:

```bash
cd garage-build/garage-app
docker-compose up -d --build   # build and start
docker-compose down            # stop
docker logs garage             # check logs
docker restart garage          # restart (fixes SQLite WAL locks)
```

App is accessible at `http://localhost:8765` (host port mapped to internal 3000).

For local backend-only development without Docker:
```bash
cd garage-build/garage-app/backend
DATA_DIR=../../../garage node server.js
```
The frontend has no build step — it's a single `frontend/index.html` served as static files.

## Deployment (Production)

The app is deployed to Unraid by pulling the pre-built image from GHCR:
```
ghcr.io/umylive/garage:latest
```
Every push to `main` that touches `garage-build/**` triggers `.github/workflows/docker-build.yml`, which builds and pushes a new image tagged `latest`, by SHA, and by timestamp. The Unraid instance pulls the new image to update.

The `garage/` directory at the repo root holds the **live runtime database and uploads** — it is excluded from git via `.gitignore` and must never be committed.

## Architecture

```
garage-build/garage-app/
├── backend/
│   ├── server.js      # All Express routes (~970 lines)
│   ├── database.js    # SQLite schema, inline migrations, Audi A6 seed data
│   └── auth.js        # bcrypt, session cookies, rate limiting middleware
├── frontend/
│   ├── index.html     # Entire SPA — all UI in one vanilla JS file (~2400 lines)
│   ├── sw.js          # Service worker (offline read-only caching)
│   └── manifest.json  # PWA manifest
├── Dockerfile         # node:20-alpine, builds backend + copies frontend
└── docker-compose.yml # port 8765→3000, volume /mnt/user/appdata/garage:/data
```

**Data flow**: SQLite at `$DATA_DIR/garage.db` (default `/data/garage.db`). Uploaded photos/receipts go to `$DATA_DIR/uploads/`.

## Key Architectural Patterns

**Auth**: Cookie-based sessions (30-day, httpOnly). First user to `/api/auth/register` becomes admin; registration is then closed. Subsequent users must be created by an admin via `/api/users`. Rate limiting: 5 failed attempts → 15-min lockout per username+IP.

**Authorization**: Every protected route checks ownership through join queries — `userOwnsCar(carId, userId)`, `userOwnsItem(itemId, userId)`, `userOwnsLog(logId, userId)`. All return 404 (not 403) to avoid leaking resource existence. For resources that don't have a dedicated helper (e.g. `DELETE /api/parts/:altId`), the same pattern is done inline with a 3-table join.

**Service item status logic** (`server.js` — `GET /api/cars/:carId/items`): Computed at query time, not stored. Status is the worst of two independent checks — KM-based (`ok`/`never`/`due_soon`/`overdue`) and time-based (same). Thresholds: due_soon within 1500 km or 30 days; condition-based items always show `condition` status.

**DB migrations**: Inline `migrate()` function in `database.js` runs on every startup using `PRAGMA table_info` to detect missing columns and `ALTER TABLE ADD COLUMN`. No migration framework. New tables use `CREATE TABLE IF NOT EXISTS` directly in the schema block — they are created automatically on first run.

**Audi A6 seed**: `seedAudiA6(carId)` inserts a full OEM maintenance schedule for the 2023 Audi A6 C8 45 TFSI. `refreshAudiA6Schedule(carId)` updates intervals/part numbers on an existing car by matching `name_en`, with a rename map for items that changed names.

**Frontend event handling**: A single delegated `document.addEventListener('click')` handles all UI actions via `data-action` attributes on elements. Adding a new action requires: (1) a `data-action="my-action"` on the HTML element, (2) an `else if (action === 'my-action')` branch in the handler, and (3) the corresponding async function. Extra data beyond `data-id` is passed via additional `data-*` attributes (e.g. `data-item-id`).

**Sheet pattern**: Bottom-sheet UI is rendered by calling `openSheet(htmlString)`. Sheets that need server data call `openSheet('<div class="loading">…</div>')` first, then fetch in parallel with `Promise.all`, then call `openSheet(fullHtml)`. Re-opening a sheet (e.g. after add/delete) is done by calling the open function again with the same id.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Internal server port |
| `DATA_DIR` | `/data` | SQLite DB + uploads root |
| `TZ` | — | Timezone (docker-compose sets `Asia/Riyadh`) |

## Database Schema (tables)

`users` → `cars` (user_id FK) → `service_items` (car_id FK) → `service_log` (service_item_id FK) → `attachments` (log_id FK)

`service_items` → `part_alternatives` (service_item_id FK) — stores OEM/aftermarket part options per item (brand, part_number, type)

`cars` → `fuel_log` (car_id FK)

`cars` → `templates` (car_id FK) → `template_items` (template_id + service_item_id FKs)

`sessions` and `login_attempts` are auth-only, not linked to business data.

## API Surface

All routes under `/api/`. Public: `GET /api/auth/status`, `POST /api/auth/register|login|logout`. Admin-only: `GET|POST /api/users`, `DELETE /api/users/:id`, `POST /api/users/:id/reset-password`. Everything else requires `requireAuth` middleware.

**Service items**: `GET|POST /api/cars/:carId/items`, `PUT|DELETE /api/items/:id`, `PATCH /api/items/:id/part` (quick part-number/interval update)

**Part alternatives**: `GET|POST /api/items/:id/parts`, `DELETE /api/parts/:altId`

**Logs**: `GET|POST /api/items/:id/logs`, `DELETE /api/logs/:id`, `POST /api/logs/:id/attachments`

**Fuel**: `GET|POST /api/cars/:carId/fuel`, `DELETE /api/fuel/:id`

**Templates**: `GET|POST /api/cars/:carId/templates`, `DELETE /api/templates/:id`, `POST /api/templates/:id/apply`

File uploads served at `/uploads/:filename` — auth-gated, ownership-checked before serving.

Exports: `GET /api/cars/:carId/export.xlsx` and `export.pdf` — generated on-the-fly using ExcelJS and PDFKit.
