# CareNexus — Working Prototype (SIH Hackathon)

Connect · Care · Better Health — an integrated healthcare access & quality-support platform
connecting Patients, ASHA/Frontline Health Workers, PHC/CHC/Hospital staff and Administrators.

This is a **real full-stack app**: Node.js + Express backend, SQLite database, REST API, and a
role-based web frontend. No mock data lives only in the browser — everything is read from and
written to the database through the API, so actions in one role are reflected for other roles
(e.g. a patient booking an appointment updates the facility's live queue).

## 1. Requirements
- Node.js 18+ (comes with `npm`)

## 2. Run it
```bash
cd carenexus
npm install
# No API key is required for the current OpenStreetMap facility search.
npm start
```
Then open **http://localhost:3000** in your browser.

The database (`carenexus.db`, SQLite) is created automatically on first run and seeded with
demo data (facilities, patients, appointments, referrals, follow-ups, medicine/diagnostic
availability). Delete `carenexus.db*` and restart to reset to a clean demo state at any time.

## 3. Demo accounts (password for all: `1234`)

| Role                     | Phone       | Notes                                   |
|--------------------------|-------------|------------------------------------------|
| Patient                  | 9000000001  | Sushma Patil — maternal, high-risk       |
| ASHA / Frontline Worker  | 9000000002  | Anjali Kadam — manages 6 patients        |
| Facility Staff (PHC)     | 9000000003  | Dr. R. Mehta, Wardha PHC                 |
| Facility Staff (CHC)     | 9000000005  | Dr. S. Rao, Deoli CHC                    |
| Facility Staff (Hospital)| 9000000006  | Dr. A. Verma, Nagpur General Hospital    |
| Administrator            | 9000000004  | State Health Admin                       |

## 4. What's implemented (all live, backed by the database)

**Patient**: find nearby PHC/CHC/Hospital with live crowd + AI wait prediction, book
appointment/digital token or teleconsultation, live queue tracking, digital health records,
doctor/PHC instructions + medication info, medicine availability, referral status tracker,
follow-up reminders & notifications.

**ASHA / Frontline Worker**: dashboard with priority follow-ups & high-risk patients, patient
registry (search + register new patients), full patient profile (records, instructions,
follow-ups, referrals), appointment assistance (books on the patient's behalf), referral
tracking (PHC→CHC→Hospital pipeline with status updates), medicine & diagnostic availability
lookup.

**Facility Staff (PHC/CHC/Hospital)**: today's overview, OPD module (token/queue management,
start/complete consultations), diagnostics module (update test status), medicine/pharmacy
module (update stock status), emergency escalation, referral module (incoming/outgoing),
follow-up monitoring, AI operational insights (wait-time prediction + crowd forecast, with an
explicit disclaimer that AI is decision support only).

**Administrator**: network overview (facilities, patients, appointments, queue), referral
monitoring across the whole network, follow-up monitoring (maternal/child/chronic/high-risk),
medicine availability alerts, facility load comparison, and quality/AI insights.

## 5. Architecture
```
carenexus/
  server.js        Express server + REST API + simple AI wait-time/crowd model
  db.js             SQLite schema + demo data seeding (better-sqlite3)
  public/
    index.html      App shell
    styles.css       Design system
    app.js           Role-based SPA (vanilla JS, fetch-based)
  carenexus.db       SQLite database file (auto-created)
```

The "AI" layer is a transparent, explainable formula (queue size ÷ doctors available × average
consultation time, adjusted for crowd level) plus a simple forecast heuristic — intentionally
kept interpretable for a judge Q&A, and clearly scoped as **decision support**, not autonomous
diagnosis or prescription, per the SIH problem statement's boundary requirements.

## 6. Presenting to judges
- Open four browser windows/tabs (or use incognito for each) logged in as Patient, ASHA,
  Facility, and Admin simultaneously to show live cross-role updates: book an appointment as
  the patient → watch the queue update on the Facility OPD screen → mark it complete as
  facility staff → see it reflected in the patient's appointment history.
- Create a referral as the ASHA worker for a patient → show it appear in the receiving
  facility's "Incoming referrals" → progress it to Completed → show the Admin dashboard's
  referral-completion count update.


## 7. OpenStreetMap Live Health Discovery
The Patient → Find Care screen uses public OpenStreetMap data. The backend geocodes the entered location with Nominatim and searches nearby healthcare-related map listings through Overpass (up to 15 km around the searched location).

Important limitations:
- Public map listings may be incomplete, outdated, or missing phone/address details.
- A listing is **not verified by CareNexus** and does not mean the facility is participating, open, accepting patients, or has beds available.
- Emergency SOS must only dispatch requests to separately registered and verified participating facilities; public map results must never be treated as emergency dispatch recipients.
- OpenStreetMap services have usage limits. If a search fails, retry after a short wait.

## 8. Emergency SOS coordination (prototype)
The Patient navigation now includes Emergency SOS. The patient can use browser GPS permission or enter a landmark/town, choose an emergency type, add a short description, and review request status. The app keeps a direct `tel:112` action available. Manual location is geocoded when possible.

Only facilities explicitly added to the separate emergency partner registry and marked both **verified** and **active**, with configured coordinates and contact phone, can receive requests within 15 km. The Admin → Emergency Partners screen supports registry management and public-source research via Browser Use. Research results do not auto-verify facilities. The Facility → Emergency screen can accept a request (first acceptance wins) and record patient contact outcomes.

**This is not an ambulance-dispatch system.** It does not confirm emergency validity, bed availability, ambulance allocation or a guaranteed response. No facility is automatically enabled as a real emergency partner. Call 112 in an immediate emergency.

## 9. Optional integrations
- **ElevenLabs**: set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` in private `.env` to enable the voice assistant session. Never put the API key in frontend code.
- **Browser Use Cloud**: set `BROWSER_USE_API_KEY` in private `.env` to enable Admin → Emergency Partners → Research with Browser Use. Human review is required.
- **FlutterFlow**: `openapi.yaml` is the starting API reference; `INTEGRATIONS_SETUP.md` contains screen/API guidance.
- **Render**: `render.yaml` uses a persistent disk and `DB_PATH=/var/data/carenexus.db`. The service has not been deployed by this code-editing pass.

