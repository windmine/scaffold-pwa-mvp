# Geo Attendance PWA MVP

A Progressive Web App (PWA) MVP for field-worker attendance and task tracking.

The app supports worker login, GPS check-in/check-out, daily task logs, optional photos, offline draft saving, a simple offline queue, and supervisor approval. The project started as a frontend-only PWA prototype and now includes a basic FastAPI backend for real multi-device testing.

---

## Current Status

This project currently has two parts:

```text
Frontend: Vite PWA
Backend: FastAPI REST API
Database: SQLite for local development
Auth: JWT bearer token login
```

The frontend can still use browser storage and IndexedDB for offline behaviour. The backend is used to store real attendance records and allow worker/supervisor data to be shared across devices.

---

## Features

### Worker

- Login with demo worker account
- Capture GPS location
- Check in
- Check out
- Submit task logs
- Add optional notes/photos
- Save drafts offline
- Sync queued records when online
- View own records

### Supervisor

- Login with demo supervisor account
- View pending attendance records
- Approve records
- Reject records

### Backend

- FastAPI REST API
- SQLite local database
- JWT bearer token authentication
- Worker/supervisor role separation
- Swagger API documentation
- Phone testing over local Wi-Fi

---

## Demo Accounts

```text
Worker
Email: worker@example.com
Password: Passw0rd!

Supervisor
Email: supervisor@example.com
Password: Passw0rd!
```

Demo accounts are created by running the backend seed endpoint:

```text
POST /dev/seed
```

---

## Project Structure

```text
scaffold-pwa-mvp/
  index.html
  offline.html
  manifest.webmanifest
  sw.js
  README.md
  package.json
  vite.config.js

  assets/
    css/
      styles.css
    js/
      app.js
      db.js
      mock-api.js
      utils.js
      api-client.js
    icons/
      icon-192.png
      icon-512.png
      maskable-512.png
      apple-touch-icon.png

  backend/
    app/
      __init__.py
      main.py
      database.py
      models.py
      auth.py
    geo_management.db
    requirements.txt
```

`geo_management.db` is generated automatically when the backend starts.

---

## Requirements

### Frontend

- Node.js
- npm

### Backend

- Python 3.11 recommended
- Conda recommended
- FastAPI
- Uvicorn
- SQLModel
- Passlib
- bcrypt
- python-jose
- python-multipart

---

## Frontend Setup

From the project root:

```powershell
cd C:\Users\12273\Documents\GitHub\scaffold-pwa-mvp
npm install
```

Run the frontend on the computer:

```powershell
npm run dev
```

Run the frontend for phone testing:

```powershell
npm run dev:phone
```

The frontend normally runs at:

```text
http://127.0.0.1:5173
```

For phone testing, use your computer's local IP address:

```text
http://YOUR_COMPUTER_IP:5173
```

Example:

```text
http://192.168.1.25:5173
```

---

## Backend Setup

Go to the backend folder:

```powershell
cd C:\Users\12273\Documents\GitHub\scaffold-pwa-mvp\backend
```

Create and activate the conda environment:

```powershell
conda create -n geo-backend python=3.11
conda activate geo-backend
```

Install backend packages:

```powershell
pip install fastapi uvicorn sqlmodel passlib[bcrypt] python-jose[cryptography] python-multipart
```

If you get bcrypt/passlib errors, use pinned versions:

```powershell
python -m pip uninstall -y bcrypt passlib
python -m pip install "passlib[bcrypt]==1.7.4" "bcrypt==4.0.1"
```

Save dependencies:

```powershell
pip freeze > requirements.txt
```

---

## Run the Backend

From the `backend` folder:

```powershell
conda activate geo-backend
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Backend health check:

```text
http://127.0.0.1:8000/health
```

API documentation:

```text
http://127.0.0.1:8000/docs
```

If the backend starts correctly, the health endpoint should return:

```json
{
  "status": "ok",
  "message": "Geo backend is running"
}
```

---

## Create Demo Data

Open the Swagger API docs:

```text
http://127.0.0.1:8000/docs
```

Run:

```text
POST /dev/seed
```

This creates:

```text
worker@example.com / Passw0rd!
supervisor@example.com / Passw0rd!
```

---

## Login Test

In Swagger UI, run:

```text
POST /auth/login
```

Example request:

```json
{
  "email": "worker@example.com",
  "password": "Passw0rd!"
}
```

Example response:

```json
{
  "access_token": "your_token_here",
  "token_type": "bearer",
  "user": {
    "id": 1,
    "email": "worker@example.com",
    "name": "Demo Worker",
    "role": "worker"
  }
}
```

Copy the `access_token`.

Then click **Authorize** in Swagger UI and paste the token.

If the authorization popup uses bearer authentication, paste only the token:

```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

If your Swagger UI still asks for username/password/client ID/client secret, use `POST /auth/login` manually and copy the token from the response instead.

---

## Attendance API Test

After logging in as a worker, test:

```text
POST /attendance
```

Example request:

```json
{
  "record_type": "check_in",
  "latitude": -36.8485,
  "longitude": 174.7633,
  "accuracy": 12,
  "site_id": 1,
  "note": "Test check-in from backend",
  "photo_url": null
}
```

Then check the worker's records:

```text
GET /my-records
```

---

## Supervisor Approval Test

Login as supervisor:

```json
{
  "email": "supervisor@example.com",
  "password": "Passw0rd!"
}
```

Use the supervisor token in Swagger UI.

View pending records:

```text
GET /supervisor/pending-records
```

Approve or reject a record:

```text
POST /supervisor/records/{record_id}/decision
```

Approve example:

```json
{
  "status": "approved",
  "comment": "Approved"
}
```

Reject example:

```json
{
  "status": "rejected",
  "comment": "Location is unclear"
}
```

---

## Phone Testing

Phone testing needs two terminals.

### Terminal 1: Backend

```powershell
cd C:\Users\12273\Documents\GitHub\scaffold-pwa-mvp\backend
conda activate geo-backend
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Terminal 2: Frontend

```powershell
cd C:\Users\12273\Documents\GitHub\scaffold-pwa-mvp
npm run dev:phone
```

Find your computer IP address:

```powershell
ipconfig
```

Look for:

```text
IPv4 Address
```

Open the frontend on your phone:

```text
http://YOUR_COMPUTER_IP:5173
```

Example:

```text
http://192.168.1.25:5173
```

The phone and computer must be connected to the same Wi-Fi network.

---

## Frontend API Base URL

When testing on your computer, the frontend can call:

```js
const API_BASE = "http://127.0.0.1:8000";
```

When testing on your phone, do not use `127.0.0.1` or `localhost`. Use your computer's Wi-Fi IP address:

```js
const API_BASE = "http://192.168.1.25:8000";
```

Replace `192.168.1.25` with your actual computer IP.

---

## CORS Setup

If the phone frontend cannot call the backend, update the CORS origins in:

```text
backend/app/main.py
```

Example:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://192.168.1.25:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Replace `192.168.1.25` with your actual computer IP.

---

## Offline Mode Design

The frontend should keep IndexedDB for offline use.

Recommended behaviour:

```text
Online:
  Send check-in/check-out/task-log records directly to FastAPI.

Offline:
  Save records into IndexedDB with queued status.

Back online:
  Send queued records to FastAPI.
  If the backend accepts them, mark them as synced.
```

This allows the PWA to continue working even when field workers have weak or no internet connection.

---

## Main API Endpoints

### General

```text
GET /health
POST /dev/seed
```

### Authentication

```text
POST /auth/login
GET /auth/me
```

### Worker

```text
POST /attendance
GET /my-records
POST /task-logs
```

### Supervisor

```text
GET /supervisor/pending-records
POST /supervisor/records/{record_id}/decision
```

---

## Common Problems

### `vite not recognized`

Run this from the project root:

```powershell
npm install
```

If it still fails:

```powershell
npm install -D vite @vitejs/plugin-react
```

Then run:

```powershell
npm run dev:phone
```

---

### Backend uses the wrong Python version

Check Python path:

```powershell
where python
python --version
python -m pip -V
```

It should point to the `geo-backend` conda environment and use Python 3.11.

If not, activate the environment:

```powershell
conda activate geo-backend
```

Or run Uvicorn through conda:

```powershell
conda run -n geo-backend python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

---

### bcrypt / passlib error

If you see errors such as:

```text
module 'bcrypt' has no attribute '__about__'
password cannot be longer than 72 bytes
```

Use the pinned versions:

```powershell
python -m pip uninstall -y bcrypt passlib
python -m pip install "passlib[bcrypt]==1.7.4" "bcrypt==4.0.1"
```

Restart the backend after reinstalling.

---

### Phone cannot access frontend or backend

Check these points:

1. Phone and computer are on the same Wi-Fi.
2. Frontend is running with `npm run dev:phone`.
3. Backend is running with `--host 0.0.0.0`.
4. Windows Firewall allows Node.js and Python.
5. Frontend uses the computer IP, not `localhost`.
6. CORS includes the phone testing frontend URL.

Wrong for phone testing:

```js
const API_BASE = "http://127.0.0.1:8000";
```

Correct for phone testing:

```js
const API_BASE = "http://192.168.1.25:8000";
```

---

## Development Roadmap

Recommended next steps:

1. Connect frontend login to the real backend.
2. Connect check-in/check-out to the backend.
3. Keep IndexedDB as the offline queue.
4. Add real photo upload API.
5. Move from SQLite to PostgreSQL.
6. Add admin management for users and sites.
7. Deploy backend to a cloud service.
8. Deploy frontend as a production PWA.
9. Add stronger production security.
10. Add reporting/export features.

---

## Production Notes

Before using this as a real production system, improve:

- Secret key management with environment variables
- HTTPS deployment
- PostgreSQL database
- Password policy
- Refresh tokens or safer session handling
- File/photo storage
- User management
- Permission checks
- Audit logs
- Backup strategy
- Error logging
- Rate limiting

---

## License

This project is currently an MVP/prototype. Add a license before public or production use.
