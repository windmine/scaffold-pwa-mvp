# Scaffold Field App PWA Starter

This is a **frontend-only localhost PWA prototype** for a scaffolding company.

It includes:

- worker login
- check in / check out with GPS capture
- daily task log
- optional photos
- offline draft saving with IndexedDB
- simple offline queue
- supervisor approval screen
- service worker, manifest, and offline fallback page

## Demo accounts

- **Worker:** `worker@example.com` / `Passw0rd!`
- **Supervisor:** `supervisor@example.com` / `Passw0rd!`

## Important note

This version has **no real backend**.
Everything is stored in the browser on the current device for demo purposes.

That means:

- data is local to the browser profile
- worker data and supervisor approvals are only shared if you use the same browser storage
- this is for MVP structure and UI testing only

## Run on localhost

### Option 1: Python

```bash
cd scaffold-pwa-mvp
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

### Option 2: VS Code Live Server

Open the folder in VS Code and run **Live Server**.

## How offline mode works in this prototype

- if the browser is online, new entries are saved immediately with `synced` status
- if the browser is offline, new entries are saved locally with `queued` status
- when the browser comes back online, the queue is flushed and those records become `synced`

## Suggested next step for a real system

Replace the mock browser storage layer with:

- a real API
- real authentication
- server-side database
- proper supervisor / worker separation across devices

## Folder structure

```text
scaffold-pwa-mvp/
  index.html
  offline.html
  manifest.webmanifest
  sw.js
  README.md
  assets/
    css/
      styles.css
    js/
      app.js
      db.js
      mock-api.js
      utils.js
    icons/
      icon-192.png
      icon-512.png
      maskable-512.png
      apple-touch-icon.png
```
