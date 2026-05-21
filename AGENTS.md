# AGENTS.md

## Final Aim for Codex

The final aim of this project is to build a clean, mobile-first Geo-Management / Geo-Attendance System that can be used by staff in the field and managers in an admin portal.

The system should help an organisation manage attendance, location-based check-ins, simple staff records, and job/site activity in one practical web application. The first target is a working MVP that is easy to test on both desktop and phone before adding more advanced HR or workflow features.

## Product Vision

Create a practical geo-based management platform with two main user groups:

1. **Staff / field users**
   - Log in securely.
   - Check in and check out from a phone.
   - Allow the system to capture their current location.
   - View simple attendance or job/site information.
   - Use a simple interface that works well on mobile screens.

2. **Managers / admin users**
   - Log in securely.
   - View staff attendance records.
   - Review check-in and check-out location data.
   - Manage basic staff/user information.
   - Use the system from desktop or tablet with a clear dashboard-style layout.

## MVP Scope

Codex should focus on completing a stable MVP before expanding the system.

The MVP should include:

- User authentication.
- Role-based behaviour for staff and admin users.
- Staff registration and login.
- Mobile-friendly check-in/check-out flow.
- Location capture using browser geolocation.
- Backend API endpoints for attendance and user data.
- Database storage for users, attendance records, timestamps, and location coordinates.
- Admin page or dashboard to view attendance records.
- Clear error handling for login, registration, location permission, and API failures.
- README instructions that explain setup, environment variables, backend startup, frontend startup, and phone testing.

## Preferred Technical Direction

Use the existing project structure where possible.

Expected stack:

- **Frontend:** Vite / React / PWA-style mobile-friendly UI.
- **Backend:** Python FastAPI.
- **Database:** SQLAlchemy-compatible database.
- **Testing target:** local desktop browser and phone browser on the same network.
- **Development startup example:**
  - Backend: `python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`
  - Frontend: `npm run dev:phone` or equivalent Vite command using `--host 0.0.0.0`.

Do not replace the whole stack unless the current implementation clearly requires it.

## Implementation Priorities

Codex should prioritise the work in this order:

1. Make the project run locally without errors.
2. Make login and registration reliable.
3. Make phone testing work on the same local network.
4. Implement or stabilise geolocation check-in/check-out.
5. Store attendance records correctly in the backend database.
6. Display attendance records clearly for admin users.
7. Improve UI clarity and mobile responsiveness.
8. Clean up README and setup instructions.
9. Add validation and basic tests where useful.
10. Only then add extra features such as reports, maps, exports, or advanced HR functions.

## Important Behaviour Rules

- Do not hardcode API secrets, database passwords, OAuth client secrets, or production credentials.
- Use `.env` files for local configuration.
- Keep sample environment values in `.env.example`.
- Do not break existing working routes or UI flows.
- Keep the UI simple and practical.
- Prefer small, safe changes over large rewrites.
- After changing backend code, check that API routes still start correctly.
- After changing frontend code, check that the Vite app still builds or runs.
- When adding a feature, also update the README if setup or usage changes.
- Use clear naming for files, functions, routes, and components.

## Suggested Core Data Model

The exact schema can follow the current project, but the MVP should support these concepts:

### User

- id
- username or email
- password hash
- role: staff or admin
- optional staff profile fields

### Attendance Record

- id
- user id
- check-in timestamp
- check-in latitude
- check-in longitude
- check-out timestamp
- check-out latitude
- check-out longitude
- optional status or note

### Site / Job Location

Optional for the first MVP, but useful later:

- id
- name
- address
- latitude
- longitude
- allowed radius

## Acceptance Criteria

The project can be considered successful when:

- A new user can register or be created.
- A staff user can log in from a phone.
- The phone can open the frontend using the local network IP.
- The staff user can check in with location permission enabled.
- The backend stores the check-in time and coordinates.
- The staff user can check out later.
- An admin user can view attendance records.
- The app does not crash when location permission is denied.
- Setup instructions are clear enough for another developer to run the project.

## Future Features After MVP

After the MVP works, possible future features include:

- Map view of attendance locations.
- Site geofencing with allowed check-in radius.
- Export attendance records to CSV or Excel.
- Manager approval workflow.
- Staff schedule or shift management.
- Leave request management.
- Photo upload during check-in.
- Offline-first PWA support.
- Push notifications.
- Integration with external HR or form systems.

## Codex Working Style

When modifying this repository, Codex should:

- First inspect the existing files and structure.
- Explain the intended change briefly.
- Make the smallest reasonable code change.
- Preserve the current project style.
- Avoid unnecessary new dependencies.
- Run or suggest the most relevant validation command.
- Summarise what changed and what still needs testing.

## One-Sentence Final Aim

Build a working mobile-first geo-attendance management MVP where staff can check in and out by phone with location data, and managers can review those attendance records through a simple admin interface.
