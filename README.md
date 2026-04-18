# PREPPED backend starter

This is a low-cost starter backend for your prototype.

## What it includes
- `GET /api/health`
- `GET /api/address-search`
- `POST /api/profile-save`
- `GET /api/profile-load`
- `POST /api/recommendation-run`

## Why this is the right first backend
It matches the minimum useful Phase 1 path you already outlined: address search, profile save/load, and recommendation handoff before building deeper lifecycle features.

## Run locally
1. Open a terminal in this folder.
2. Run `npm install`
3. Copy `.env.example` to `.env`
4. Run `npm run dev`

## Frontend env
Use this in your frontend:

```bash
VITE_API_BASE_URL=http://localhost:3001
```

When you deploy later, change it to your live backend URL, for example:

```bash
VITE_API_BASE_URL=https://api.prepped.nz
```

## Cheapest practical deployment path
- Frontend: Vercel
- Backend: Railway or Render
- Database later: Neon or Supabase Postgres

## Recommended order
1. Get `/api/address-search` working.
2. Save a profile payload with `/api/profile-save`.
3. Load saved profile data into the dashboard with `/api/profile-load`.
4. Move recommendation logic from frontend into `/api/recommendation-run` once the first three are stable.

## Notes
- The address endpoint currently includes a demo fallback so the prototype does not break while you wire LINZ.
- The saved profiles are in-memory only for now. Add Postgres when you want persistence.
