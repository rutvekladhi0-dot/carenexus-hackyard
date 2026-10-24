# CareNexus integrations and rollout notes

## Current code included in this delivery
- Live facility discovery uses OpenStreetMap Nominatim + Overpass; SerpApi is no longer used.
- Patient Emergency SOS flow with optional browser GPS permission/manual landmark, emergency type and notes, request history/status, patient confirmation outcomes, facility-side accept/contact workflow, and a 15 km recipient filter.
- SOS recipients are sourced only from the separate `emergency_participating_facilities` registry when both `verified=1` and `active=1`, with configured coordinates. Public map listings are never SOS recipients.
- First acceptance is guarded by a SQLite transaction. The UI explicitly says this prototype does not dispatch ambulances and does not guarantee beds or a response.
- Admin can manage the emergency partner registry and trigger Browser Use public-source research. Browser Use research does not auto-verify or update a facility; a human must review evidence and confirm details directly.
- ElevenLabs signed-URL backend route and voice UI are wired. API key remains server-side.
- SQLite path can be set using `DB_PATH` to support persistent deployment storage.

## 1. ElevenLabs Creator
1. In ElevenLabs, create/configure a Conversational AI agent for CareNexus.
2. Configure the agent instructions to support navigation and general service information only. It must not diagnose, prescribe, claim emergency dispatch, or replace a clinician. Tell users to call India's emergency number 112 when there is immediate danger.
3. Enable agent authentication with signed URLs (not a client-side API key). The server requests the signed URL at `/api/voice/signed-url`.
4. Copy the API key and agent ID into your private `.env` file as `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID`. Never commit `.env` or paste the key into frontend files.
5. Run the app on HTTPS for deployed microphone access. Browser microphone permission is required. Test the exact agent in English and Marathi before demoing.

## 2. Browser Use Cloud
1. Create/copy a Browser Use Cloud API key from the Browser Use dashboard.
2. Add it to the private `.env` as `BROWSER_USE_API_KEY`.
3. Sign in to CareNexus as Admin → Emergency Partners → Research with Browser Use. It asks the hosted browser agent to research public/official sources for a selected facility and return candidate contact/location data and uncertainty.
4. Review all URLs and evidence yourself; independently call the facility. Browser Use findings are candidates only. They never turn on SOS eligibility automatically.
5. If the task fails, check key validity, Browser Use credits, and the service response. Do not share the key in a browser/client app.

## 3. FlutterFlow companion app
The web backend remains the single source of truth. In FlutterFlow create a new mobile project and add API Calls pointing to the deployed CareNexus base URL. `openapi.yaml` is provided as an import/reference starting point.

Suggested first screens:
- Login / role selection (demo login only until production auth is implemented)
- Patient Home and Find Care
- Emergency SOS with a prominent `tel:112` action, location permission, manual landmark fallback, request status history
- Appointments/Queue and Health Records
- ASHA patient list / follow-up screen
- Facility Emergency screen

Important FlutterFlow API calls:
- `POST /api/login`
- `GET /api/facilities`
- `GET /api/live-search?q=...&location=...`
- `POST /api/sos`
- `GET /api/sos?patient_id={id}`
- `PATCH /api/sos/{id}/confirmation`
- `GET /api/appointments?patient_id={id}`

Use API Calls → Add API Call, set JSON body/variables, then Response & Test. Do not embed ElevenLabs or Browser Use secrets in FlutterFlow. Do not use real patient data in this prototype.

## 4. Render deployment preparation
`render.yaml` defines a Node web service and a persistent disk mounted at `/var/data`. `DB_PATH=/var/data/carenexus.db` keeps SQLite data on that disk. Before a real public launch, connect the repository to Render, set private environment variables in Render dashboard, and verify disk availability and backups. Deployment is not performed from this archive.

## Safety / production blockers
- Current login is demo authentication with simple passwords and is not safe for real patient records.
- Admin/partner endpoints need production-grade authorization, audit trails, abuse prevention and rate limits before public use.
- SOS partner verification here is an admin attestation. A production emergency workflow needs signed participation agreements, staffed contact procedures, monitoring, retries/escalation, and explicit integration with a real dispatch/response organization.
- SQLite WAL plus a persistent disk is acceptable for a prototype/small demo, not a substitute for a production multi-instance database plan.
- Voice and Browser Use integrations require private service credentials and account/agent configuration; code returns a clear setup error until configured.
