# CareNexus Project Audit — Updated Working Copy

## Existing architecture preserved
- Node.js + Express REST API
- SQLite through `better-sqlite3`
- Vanilla JavaScript single-page frontend
- Patient, ASHA/frontline worker, facility staff, and administrator role areas
- Existing appointments, queues, health records, instructions, referrals, follow-ups, medicines, diagnostics, and dashboards

## Changes in this delivery
1. Replaced SerpApi live facility search with OpenStreetMap Nominatim + Overpass. Public listings are labelled unverified.
2. Added patient Emergency SOS form with optional browser geolocation, manual location/landmark, emergency type, description, request history and patient confirmation choices.
3. Added a separate emergency partner registry; only verified + active partners with coordinates and contact phone are eligible for SOS matching within 15 km. Public map search results are never dispatch recipients.
4. Added first-acceptance-wins transactional logic, facility incoming SOS list, contact outcome capture, and admin partner registry UI.
5. Added ElevenLabs signed-URL backend route and a frontend voice-assistant launcher. It remains disabled until private API key + agent ID are configured.
6. Added Browser Use Cloud research endpoint and Admin research action. Research is evidence gathering only; it does not automatically verify or activate a facility.
7. Added `openapi.yaml` as a FlutterFlow API integration starting point, integration setup instructions, and Render deployment configuration with persistent SQLite disk path.
8. Added responsive SOS/voice styles and retained the existing application workflows.

## Important limitations
- Login is demo-only and not production-grade authentication.
- Admin and emergency partner endpoints need proper authorization/audit logs before any public production use.
- No actual ambulance dispatch is implemented. SOS is a coordination prototype; immediate emergencies should call 112.
- No participating facility is automatically seeded as verified/active. Admin must verify and onboard real partners first.
- External integrations need the user's private credentials and agent configuration; those credentials were not present in the project archive and have not been invented.
- Browser Use research requires human review and independent confirmation. It does not prove a facility is operational or available.
- Do not use real patient data until authentication, authorization, privacy, security, and operational reviews are complete.
