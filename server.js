const express = require('express');
const path = require('path');
const { db, init } = require('./db');
const {
  getAuthContext,
  handlePatientQuery,
  handleAshaQuery,
  cleanTextForSpeech,
  detectLanguage
} = require('./assistant');

const fs = require('fs');

// Load simple .env file without adding another dependency.
const envPath = path.join(__dirname, '.env');
function loadEnv() {
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && value !== '') {
        process.env[key] = value;
      }
    });
  }
}
loadEnv();

init();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AVG_CONSULT_MINUTES = 6;

// ---------- Helpers ----------
function predictWait(facility) {
  // Simple, explainable AI decision-support formula (documented, not a black box):
  // wait = (patients waiting / doctors available) * avg consultation time, with crowd adjustment
  const doctors = Math.max(facility.doctors_available, 1);
  const base = (facility.queue_waiting / doctors) * AVG_CONSULT_MINUTES;
  const crowdFactor = facility.crowd_status === 'High' ? 1.15 : facility.crowd_status === 'Medium' ? 1.05 : 1.0;
  return Math.round(base * crowdFactor);
}

function crowdForecast(facility) {
  // Simple heuristic forecast for likely high-demand hours (demo/decision-support only)
  const slots = ['9:00-10:00 AM', '10:00-11:00 AM', '12:00-1:00 PM', '4:00-5:00 PM'];
  const idx = facility.id % slots.length;
  const level = facility.crowd_status;
  return { window: slots[idx], expectedLevel: level === 'High' ? 'High' : level === 'Medium' ? 'Medium' : 'Low' };
}

function serialize(row) { return row; }

// ---------- Auth (demo only, not production-grade) ----------
app.post('/api/login', (req, res) => {
  const { phone, password, role } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE phone = ? AND role = ?').get(phone, role);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials for selected role.' });
  }
  let patient = null;
  if (role === 'patient') {
    patient = db.prepare('SELECT * FROM patients WHERE user_id = ?').get(user.id);
  }
  let facility = null;
  if (role === 'facility' && user.facility_id) {
    facility = db.prepare('SELECT * FROM facilities WHERE id = ?').get(user.facility_id);
  }
  res.json({ user: { id: user.id, name: user.name, role: user.role, language: user.language, facility_id: user.facility_id }, patient, facility });
});

app.get('/api/demo-accounts', (req, res) => {
  const rows = db.prepare('SELECT name, role, phone, facility_id FROM users ORDER BY role').all();
  res.json(rows);
});

// ---------- OpenStreetMap Live Health Discovery ----------
// Uses Nominatim for geocoding and Overpass for public OpenStreetMap listings.
// These results are public map data, not verified/participating emergency facilities.
app.get('/api/live-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const location = String(req.query.location || '').trim();
  if (!q) return res.status(400).json({ error: 'Search query is required.' });
  if (!location) return res.status(400).json({ error: 'Enter a town, city, district or address to search nearby facilities.' });

  try {
    const geoUrl = new URL('https://nominatim.openstreetmap.org/search');
    geoUrl.searchParams.set('format', 'jsonv2');
    geoUrl.searchParams.set('limit', '1');
    geoUrl.searchParams.set('q', location);
    const geoResponse = await fetch(geoUrl, {
      headers: { 'User-Agent': 'CareNexus-Hackathon-Prototype/1.0 (healthcare facility discovery)' },
      signal: AbortSignal.timeout(12000)
    });
    if (!geoResponse.ok) return res.status(502).json({ error: 'Map location lookup is temporarily unavailable. Please try again.' });
    const geoRows = await geoResponse.json();
    if (!Array.isArray(geoRows) || !geoRows.length) {
      return res.json({ query: q, location, results: [], source: 'OpenStreetMap', note: 'Location not found.' });
    }
    const lat = Number(geoRows[0].lat);
    const lon = Number(geoRows[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(502).json({ error: 'Could not determine map coordinates for this location.' });
    }

    const overpassQuery = `[out:json][timeout:20];(nwr(around:15000,${lat},${lon})["amenity"~"hospital|clinic|doctors|pharmacy|dentist|laboratory"];nwr(around:15000,${lat},${lon})["healthcare"~"hospital|clinic|doctor|pharmacy|laboratory|centre|center|urgent_care"];);out center tags;`;
    const overpassResponse = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': 'CareNexus-Hackathon-Prototype/1.0 (healthcare facility discovery)'
      },
      body: new URLSearchParams({ data: overpassQuery }),
      signal: AbortSignal.timeout(25000)
    });
    if (!overpassResponse.ok) return res.status(502).json({ error: 'OpenStreetMap search is busy right now. Please retry in a few seconds.' });
    const osm = await overpassResponse.json();
    const queryText = q.toLowerCase();
    const typeMap = {
      hospital: ['hospital'], 'medical center': ['hospital', 'clinic'], 'medical centre': ['hospital', 'clinic'],
      clinic: ['clinic', 'doctors'], doctor: ['doctors', 'doctor', 'clinic'], doctors: ['doctors', 'doctor', 'clinic'],
      pharmacy: ['pharmacy'], chemist: ['pharmacy'], medicine: ['pharmacy'],
      diagnostic: ['laboratory', 'diagnostic'], laboratory: ['laboratory'], lab: ['laboratory'],
      dentist: ['dentist'], dental: ['dentist'], emergency: ['hospital', 'urgent_care']
    };
    const requestedTypes = Object.entries(typeMap).filter(([word]) => queryText.includes(word)).flatMap(([, values]) => values);
    const elements = Array.isArray(osm.elements) ? osm.elements : [];
    const results = elements.map(el => {
      const tags = el.tags || {};
      const title = tags.name || tags['name:en'] || tags.operator || '';
      const kind = tags.amenity || tags.healthcare || 'healthcare facility';
      const point = el.center || { lat: el.lat, lon: el.lon };
      const rlat = Number(point.lat), rlon = Number(point.lon);
      const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'], tags['addr:city'] || tags['addr:town'] || tags['addr:village']].filter(Boolean).join(', ');
      return {
        title, type: String(kind).replaceAll('_', ' '), address: address || tags['addr:full'] || '',
        phone: tags.phone || tags['contact:phone'] || '', website: tags.website || tags['contact:website'] || '',
        lat: Number.isFinite(rlat) ? rlat : null, lon: Number.isFinite(rlon) ? rlon : null,
        maps_link: Number.isFinite(rlat) && Number.isFinite(rlon) ? `https://www.openstreetmap.org/?mlat=${rlat}&mlon=${rlon}#map=17/${rlat}/${rlon}` : ''
      };
    }).filter(r => {
      if (!r.title && !r.type) return false;
      if (requestedTypes.length) return requestedTypes.some(t => r.type.toLowerCase().includes(t));
      if (/health|medical|care|centre|center|facility|service/.test(queryText)) return true;
      return `${r.title} ${r.type}`.toLowerCase().includes(queryText);
    });
    const seen = new Set();
    const unique = results.filter(r => {
      const key = `${r.title.toLowerCase()}|${r.lat}|${r.lon}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 15);
    res.json({
      query: q, location, results: unique, source: 'OpenStreetMap',
      note: 'Public map listings may be incomplete. Listings are not verified by CareNexus and do not indicate current availability or emergency participation.'
    });
  } catch (err) {
    // If external map lookup fails or network is sandboxed, match local facilities
    const local = db.prepare("SELECT name as title, type, area as address FROM facilities WHERE name LIKE ? OR area LIKE ? OR type LIKE ?")
      .all(`%${q}%`, `%${location || q}%`, `%${q}%`);
    if (local.length) {
      return res.json({
        query: q, location, results: local.map(f => ({ ...f, maps_link: '', phone: '' })),
        source: 'CareNexus Connected Facilities (Local Registry)',
        note: 'Live OpenStreetMap search was unreachable; displaying matching facilities from local CareNexus network.'
      });
    }
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    res.status(502).json({ error: timedOut ? 'Map search timed out. Please try again.' : 'Could not reach OpenStreetMap services right now.' });
  }
});

// ---------- Emergency SOS coordination (prototype; no automatic ambulance dispatch) ----------
function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(lat2-lat1), dLon = rad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
app.post('/api/sos', async (req, res) => {
  const { patient_id, latitude, longitude, location_text, emergency_type, description } = req.body || {};
  const patient = db.prepare('SELECT id FROM patients WHERE id = ?').get(Number(patient_id));
  if (!patient) return res.status(400).json({ error: 'A valid patient profile is required.' });
  if (!emergency_type || !String(emergency_type).trim()) return res.status(400).json({ error: 'Choose an emergency type.' });
  let hasCoords = latitude !== undefined && latitude !== null && latitude !== '' && longitude !== undefined && longitude !== null && longitude !== '' && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude)) && Number(latitude) >= -90 && Number(latitude) <= 90 && Number(longitude) >= -180 && Number(longitude) <= 180;
  let lat = hasCoords ? Number(latitude) : null, lon = hasCoords ? Number(longitude) : null;
  // Manual location fallback: geocode the landmark/town before matching partners.
  if (!hasCoords && String(location_text || '').trim()) {
    try {
      const geoUrl = new URL('https://nominatim.openstreetmap.org/search');
      geoUrl.searchParams.set('format', 'jsonv2'); geoUrl.searchParams.set('limit', '1'); geoUrl.searchParams.set('q', String(location_text).slice(0, 500));
      const geoResponse = await fetch(geoUrl, { headers: { 'User-Agent': 'CareNexus-Hackathon-Prototype/1.0 (emergency location lookup)' }, signal: AbortSignal.timeout(8000) });
      if (geoResponse.ok) {
        const geoRows = await geoResponse.json();
        if (Array.isArray(geoRows) && geoRows.length) {
          const candidateLat = Number(geoRows[0].lat), candidateLon = Number(geoRows[0].lon);
          if (Number.isFinite(candidateLat) && Number.isFinite(candidateLon)) { lat = candidateLat; lon = candidateLon; hasCoords = true; }
        }
      }
    } catch (_) { /* Keep the request record; never block access to the emergency phone action. */ }
  }
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO emergency_requests (patient_id,latitude,longitude,location_text,emergency_type,description,status)
      VALUES (?,?,?,?,?,?,?)`).run(patient.id, lat, lon, String(location_text || '').slice(0,500), String(emergency_type).slice(0,100), String(description || '').slice(0,1000), hasCoords ? 'Searching' : 'No participating facility nearby');
    const requestId = Number(info.lastInsertRowid);
    let recipients = [];
    if (hasCoords) {
      const participants = db.prepare(`SELECT ep.facility_id, ep.latitude, ep.longitude FROM emergency_participating_facilities ep
        WHERE ep.verified=1 AND ep.active=1 AND ep.latitude IS NOT NULL AND ep.longitude IS NOT NULL`).all();
      recipients = participants.map(f => ({ ...f, distance_km: distanceKm(lat, lon, f.latitude, f.longitude) }))
        .filter(f => f.distance_km <= 15).sort((a,b) => a.distance_km-b.distance_km);
      const insert = db.prepare('INSERT INTO emergency_request_recipients (request_id,facility_id,distance_km) VALUES (?,?,?)');
      recipients.forEach(f => insert.run(requestId, f.facility_id, Number(f.distance_km.toFixed(2))));
      if (!recipients.length) {
        db.prepare("UPDATE emergency_requests SET status='No participating facility nearby',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(requestId);
      } else {
        db.prepare("INSERT INTO notifications (user_role, patient_id, message) VALUES (?,?,?)").run('patient', patient.id, `Emergency SOS #${requestId} (${emergency_type}): Dispatched to ${recipients.length} nearby verified facility partner(s).`);
        recipients.forEach(f => db.prepare("INSERT INTO notifications (user_role, patient_id, message) VALUES (?,?,?)").run('facility', patient.id, `🚨 Incoming Emergency SOS #${requestId} (${emergency_type}) within ${f.distance_km.toFixed(1)} km.`));
      }
    }
    return { requestId, recipients: recipients.length };
  });
  const result = tx();
  res.status(201).json({ id: result.requestId, recipients: result.recipients, status: result.recipients ? 'Searching' : 'No participating facility nearby', message: result.recipients ? 'Request queued only for verified, active participating facilities within 15 km.' : 'No verified participating facility with configured coordinates was found within 15 km. Call 112 for immediate help.' });
});

app.get('/api/sos', (req, res) => {
  const { patient_id, facility_id } = req.query;
  if (patient_id) {
    return res.json(db.prepare(`SELECT er.*, f.name AS accepted_facility_name FROM emergency_requests er LEFT JOIN facilities f ON f.id=er.accepted_facility_id WHERE er.patient_id=? ORDER BY er.created_at DESC LIMIT 20`).all(patient_id));
  }
  if (facility_id) {
    return res.json(db.prepare(`SELECT er.*, p.name AS patient_name, p.phone AS patient_phone, rr.distance_km, rr.status AS recipient_status
      FROM emergency_request_recipients rr JOIN emergency_requests er ON er.id=rr.request_id JOIN patients p ON p.id=er.patient_id
      WHERE rr.facility_id=? ORDER BY er.created_at DESC LIMIT 50`).all(facility_id));
  }
  return res.status(400).json({ error: 'patient_id or facility_id is required.' });
});

// First acceptance wins: a transaction guards the status update and rejects all later accepts.
app.post('/api/sos/:id/accept', (req, res) => {
  const facilityId = Number(req.body && req.body.facility_id);
  const tx = db.transaction(() => {
    const request = db.prepare('SELECT * FROM emergency_requests WHERE id=?').get(req.params.id);
    if (!request) return { error: 'SOS request not found.', status: 404 };
    const participant = db.prepare(`SELECT 1 FROM emergency_request_recipients rr JOIN emergency_participating_facilities ep ON ep.facility_id=rr.facility_id
      WHERE rr.request_id=? AND rr.facility_id=? AND rr.status='Pending' AND ep.verified=1 AND ep.active=1`).get(request.id, facilityId);
    if (!participant) return { error: 'This facility is not an eligible recipient for this request.', status: 403 };
    if (request.status !== 'Searching') return { error: 'Another facility may already have accepted this request.', status: 409 };
    const changed = db.prepare("UPDATE emergency_requests SET status='Accepted',accepted_facility_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='Searching'").run(facilityId, request.id);
    if (!changed.changes) return { error: 'Another facility accepted first. Refresh the request.', status: 409 };
    db.prepare("UPDATE emergency_request_recipients SET status=CASE WHEN facility_id=? THEN 'Accepted' ELSE 'Superseded' END, responded_at=CURRENT_TIMESTAMP WHERE request_id=?").run(facilityId, request.id);
    const fac = db.prepare('SELECT name FROM facilities WHERE id=?').get(facilityId);
    db.prepare("INSERT INTO notifications (user_role, patient_id, message) VALUES (?,?,?)").run('patient', request.patient_id, `Emergency SOS #${request.id} accepted by ${fac ? fac.name : 'facility'}. They will contact you shortly.`);
    return { ok: true, status: 'Accepted' };
  });
  const result = tx();
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

app.patch('/api/sos/:id/contact', (req, res) => {
  const { facility_id, contact_outcome } = req.body || {};
  const allowed = ['Reached patient', 'No answer', 'Wrong number', 'Needs further coordination'];
  if (!allowed.includes(contact_outcome)) return res.status(400).json({ error: 'Choose a valid contact outcome.' });
  const request = db.prepare('SELECT * FROM emergency_requests WHERE id=?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'SOS request not found.' });
  if (Number(request.accepted_facility_id) !== Number(facility_id)) return res.status(403).json({ error: 'Only the accepting facility can update contact outcome.' });
  db.prepare("UPDATE emergency_requests SET status='Contacting patient',contact_outcome=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(contact_outcome, request.id);
  db.prepare("INSERT INTO notifications (user_role, patient_id, message) VALUES (?,?,?)").run('patient', request.patient_id, `Emergency SOS #${request.id}: Contact status updated to "${contact_outcome}".`);
  res.json({ ok: true, status: 'Contacting patient', contact_outcome });
});

app.patch('/api/sos/:id/confirmation', (req, res) => {
  const { patient_id, confirmation } = req.body || {};
  const map = { confirmed: 'Patient confirmed', denied: 'Patient denied', unable: 'Unable to verify' };
  if (!map[confirmation]) return res.status(400).json({ error: 'Choose confirmed, denied, or unable.' });
  const request = db.prepare('SELECT * FROM emergency_requests WHERE id=? AND patient_id=?').get(req.params.id, patient_id);
  if (!request) return res.status(404).json({ error: 'SOS request not found for this patient.' });
  db.prepare('UPDATE emergency_requests SET status=?,patient_confirmation=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(map[confirmation], confirmation, request.id);
  if (request.accepted_facility_id) {
    db.prepare("INSERT INTO notifications (user_role, patient_id, message) VALUES (?,?,?)").run('facility', request.patient_id, `Emergency SOS #${request.id}: Patient outcome updated to "${map[confirmation]}".`);
  }
  res.json({ ok: true, status: map[confirmation] });
});

// Admin-managed emergency partner registry. In production this must be protected by real role auth + audit controls.
app.get('/api/admin/emergency-participants', (req, res) => {
  res.json(db.prepare(`SELECT f.id AS facility_id, f.name, f.type, f.area, ep.verified, ep.active, ep.latitude, ep.longitude, ep.contact_phone, ep.verified_by, ep.verified_at
    FROM facilities f LEFT JOIN emergency_participating_facilities ep ON ep.facility_id=f.id ORDER BY f.name`).all());
});
app.put('/api/admin/emergency-participants/:facilityId', (req, res) => {
  const facilityId = Number(req.params.facilityId);
  const facility = db.prepare('SELECT id FROM facilities WHERE id=?').get(facilityId);
  if (!facility) return res.status(404).json({ error: 'Facility not found.' });
  const { verified, active, latitude, longitude, contact_phone, verified_by } = req.body || {};
  const lat = latitude === '' || latitude == null ? null : Number(latitude);
  const lon = longitude === '' || longitude == null ? null : Number(longitude);
  if ((lat == null) !== (lon == null) || (lat != null && (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180))) return res.status(400).json({ error: 'Enter valid latitude and longitude together.' });
  if (active && (!verified || lat == null || lon == null || !String(contact_phone || '').trim())) return res.status(400).json({ error: 'To activate dispatch eligibility, verify the facility and provide coordinates plus a contact phone.' });
  db.prepare(`INSERT INTO emergency_participating_facilities (facility_id,verified,active,latitude,longitude,contact_phone,verified_by,verified_at)
    VALUES (?,?,?,?,?,?,?,CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END)
    ON CONFLICT(facility_id) DO UPDATE SET verified=excluded.verified, active=excluded.active, latitude=excluded.latitude, longitude=excluded.longitude,
    contact_phone=excluded.contact_phone, verified_by=excluded.verified_by, verified_at=CASE WHEN excluded.verified=1 THEN CURRENT_TIMESTAMP ELSE NULL END`).run(
      facilityId, verified ? 1 : 0, active ? 1 : 0, lat, lon, String(contact_phone || '').slice(0,80), String(verified_by || 'Admin review').slice(0,120), verified ? 1 : 0);
  res.json({ ok: true, message: 'Partner registry updated. Verification is an administrative attestation and should be confirmed offline before enabling.' });
});

// Browser Use Cloud v4: research only; a human must approve before registry data changes.
app.post('/api/admin/verification/research', async (req, res) => {
  const facilityId = Number(req.body && req.body.facility_id);
  const facility = db.prepare('SELECT * FROM facilities WHERE id=?').get(facilityId);
  if (!facility) return res.status(404).json({ error: 'Facility not found.' });
  if (!process.env.BROWSER_USE_API_KEY) loadEnv();
  if (!process.env.BROWSER_USE_API_KEY) return res.status(503).json({ error: 'Browser Use is not configured. Add BROWSER_USE_API_KEY to your private .env file.' });
  const task = `Research the healthcare facility named "${facility.name}" in "${facility.area || 'location not known'}". Search only public sources. Prefer the facility's official website and official government/health department listings. Return concise JSON with fields: candidate_name, candidate_address, candidate_phone, candidate_website, official_or_government_sources (array of URLs), evidence_summary, confidence (low/medium/high), conflicts_or_uncertainties (array). Do not invent missing data. Clearly mark anything unverified. Do not contact the facility, log in, submit forms, or change any CareNexus data. This is research for human review only.`;
  try {
    const response = await fetch('https://api.browser-use.com/api/v4/runs', { method: 'POST', headers: { 'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ task }), signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(502).json({ error: 'Browser Use could not start the research task. Check the API key and available credits.' });
    res.status(202).json({ run_id: data.id || data.run_id, session_id: data.sessionId || data.session_id || null, status: data.status || 'submitted', message: 'Research started. Results must be reviewed by a human and do not automatically verify or activate a facility.' });
  } catch (e) { res.status(502).json({ error: 'Browser Use is temporarily unavailable.' }); }
});
app.get('/api/admin/verification/research/:runId', async (req, res) => {
  if (!process.env.BROWSER_USE_API_KEY) loadEnv();
  if (!process.env.BROWSER_USE_API_KEY) return res.status(503).json({ error: 'Browser Use is not configured.' });
  if (!/^[a-zA-Z0-9_-]{4,160}$/.test(req.params.runId)) return res.status(400).json({ error: 'Invalid Browser Use run ID.' });
  try {
    const response = await fetch(`https://api.browser-use.com/api/v4/runs/${encodeURIComponent(req.params.runId)}`, { headers: { 'X-Browser-Use-API-Key': process.env.BROWSER_USE_API_KEY }, signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(502).json({ error: 'Could not retrieve Browser Use results. Try again later.' });
    res.json(data);
  } catch (e) { res.status(502).json({ error: 'Browser Use is temporarily unavailable.' }); }
});

// ElevenLabs Conversational AI: credentials stay on the server. Configure both values to enable.
app.get('/api/voice/signed-url', async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_AGENT_ID) loadEnv();
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_AGENT_ID) {
    return res.status(503).json({ error: 'Voice assistant is not configured yet. Add ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID to your private .env file.' });
  }
  try {
    const url = new URL('https://api.elevenlabs.io/v1/convai/conversation/get_signed_url');
    url.searchParams.set('agent_id', process.env.ELEVENLABS_AGENT_ID);
    const response = await fetch(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(10000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(502).json({ error: 'ElevenLabs could not create a voice session. Check the server-side credentials and agent configuration.' });
    res.json({ signed_url: data.signed_url });
  } catch (e) { res.status(502).json({ error: 'Voice session service is temporarily unavailable.' }); }
});

// ---------- CareNexus Voice Assistant API (Patient Only) ----------

// Process user voice/text question
app.post('/api/assistant/chat', async (req, res) => {
  const auth = getAuthContext(req);
  if (!auth) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }

  const { user, patient } = auth;
  if (user.role !== 'patient' || !patient) {
    return res.status(403).json({ error: 'The Voice Assistant is only available for authenticated Patient accounts.' });
  }

  const message = String(req.body?.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  if (!process.env.AGENT37_API_KEY) loadEnv();

  const lang = detectLanguage(message, req.body?.language || user.language);

  try {
    const result = await handlePatientQuery(message, patient, user, lang);
    return res.json({
      ...result,
      user_name: user.name,
      role: user.role,
      language: lang,
      powered_by: result.powered_by || (process.env.AGENT37_API_KEY ? 'Agent 37 AI' : 'CareNexus Core')
    });
  } catch (err) {
    console.error('Assistant error:', err);
    return res.status(500).json({ error: 'Assistant encountered an error processing your request.' });
  }
});

// Assistant action endpoint
app.post('/api/assistant/action', (req, res) => {
  const auth = getAuthContext(req);
  if (!auth) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { user } = auth;
  if (user.role !== 'patient') {
    return res.status(403).json({ error: 'The Voice Assistant is only available for authenticated Patient accounts.' });
  }

  return res.status(400).json({ error: 'No permitted actions for this operation.' });
});

// Agent 37 Cloud AI Status endpoint
app.get('/api/agent37/status', (req, res) => {
  if (!process.env.AGENT37_API_KEY) loadEnv();
  const configured = Boolean(process.env.AGENT37_API_KEY);
  res.json({
    configured,
    platform: 'Agent 37 Cloud AI',
    status: configured ? 'active' : 'not_configured',
    message: configured
      ? 'Agent 37 Cloud AI is active and powering CareNexus Assistant.'
      : 'Agent 37 is not configured. Add AGENT37_API_KEY to server .env.'
  });
});

// ElevenLabs Voice Status endpoint
app.get('/api/voice/status', (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) loadEnv();
  const hasKey = Boolean(process.env.ELEVENLABS_API_KEY);
  const hasAgent = Boolean(process.env.ELEVENLABS_AGENT_ID);
  res.json({
    configured: hasKey,
    has_api_key: hasKey,
    has_agent_id: hasAgent,
    supported_languages: ['en-US', 'hi-IN'],
    default_model: 'eleven_multilingual_v2',
    default_voice_id: process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL',
    instructions: hasKey
      ? 'ElevenLabs Voice Technology is configured and active for US English (en-US) and Hindi (hi-IN).'
      : 'ElevenLabs Voice Technology is not configured yet. Add ELEVENLABS_API_KEY to your server-side .env file to enable ElevenLabs Text-to-Speech synthesis.'
  });
});

// Text-to-Speech synthesis via ElevenLabs (Patient Only)
app.post('/api/voice/synthesize', async (req, res) => {
  const auth = getAuthContext(req);
  if (!auth) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }

  if (auth.user.role !== 'patient') {
    return res.status(403).json({ error: 'Voice synthesis is restricted to authenticated Patient accounts.' });
  }

  const text = String(req.body?.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Text is required for speech synthesis.' });
  }

  const lang = (req.body?.language === 'hi-IN' || req.body?.language === 'mr-IN') ? req.body.language : 'en-US';

  if (!process.env.ELEVENLABS_API_KEY) {
    loadEnv();
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(503).json({
      error: 'ElevenLabs Voice Technology is not configured yet. Add ELEVENLABS_API_KEY to your server-side .env file to enable ElevenLabs Text-to-Speech synthesis.',
      missing_credential: 'ELEVENLABS_API_KEY'
    });
  }

  const cleaned = cleanTextForSpeech(text).slice(0, 1000);
  const voiceId = (lang === 'hi-IN' ? process.env.ELEVENLABS_VOICE_ID_HI : (lang === 'mr-IN' ? process.env.ELEVENLABS_VOICE_ID_MR : process.env.ELEVENLABS_VOICE_ID_EN)) || process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Multilingual v2

  try {
    const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: cleaned,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!elRes.ok) {
      const errText = await elRes.text().catch(() => '');
      console.warn('ElevenLabs API returned status:', elRes.status, errText);
      let errMsg = 'ElevenLabs speech generation could not complete. Check API key and account credits.';
      try {
        const parsed = JSON.parse(errText);
        if (parsed?.detail?.message) errMsg = parsed.detail.message;
        else if (typeof parsed?.detail === 'string') errMsg = parsed.detail;
        else if (parsed?.message) errMsg = parsed.message;
      } catch (_) {}
      return res.status(502).json({
        error: errMsg,
        details: errText
      });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    const arrayBuffer = await elRes.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('ElevenLabs TTS error:', err.message);
    return res.status(502).json({
      error: 'ElevenLabs TTS service temporarily unavailable: ' + err.message
    });
  }
});

// ---------- Facilities ----------
app.get('/api/facilities', (req, res) => {
  const rows = db.prepare('SELECT * FROM facilities ORDER BY type').all();
  const withAI = rows.map(f => ({ ...f, predicted_wait: predictWait(f), forecast: crowdForecast(f) }));
  res.json(withAI);
});

app.get('/api/facilities/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM facilities WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Facility not found' });
  res.json({ ...f, predicted_wait: predictWait(f), forecast: crowdForecast(f) });
});

app.patch('/api/facilities/:id', (req, res) => {
  const allowed = ['doctors_available', 'opd_status', 'crowd_status', 'queue_waiting'];
  const updates = [];
  const vals = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { updates.push(`${key} = ?`); vals.push(req.body[key]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' });
  vals.push(req.params.id);
  db.prepare(`UPDATE facilities SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  const f = db.prepare('SELECT * FROM facilities WHERE id = ?').get(req.params.id);
  res.json({ ...f, predicted_wait: predictWait(f), forecast: crowdForecast(f) });
});

// ---------- Patients ----------
app.get('/api/patients', (req, res) => {
  const { asha_id, q } = req.query;
  let rows;
  if (asha_id) {
    rows = db.prepare('SELECT * FROM patients WHERE asha_id = ?').all(asha_id);
  } else {
    rows = db.prepare('SELECT * FROM patients').all();
  }
  if (q) {
    const term = q.toLowerCase();
    rows = rows.filter(p => p.name.toLowerCase().includes(term));
  }
  res.json(rows);
});

app.get('/api/patients/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Patient not found' });
  res.json(p);
});

app.post('/api/patients', (req, res) => {
  const { name, age, gender, phone, category, high_risk, asha_id, village } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const info = db.prepare(`INSERT INTO patients (name, age, gender, phone, category, high_risk, asha_id, village)
    VALUES (?,?,?,?,?,?,?,?)`).run(name, age || null, gender || null, phone || null, category || 'General', high_risk ? 1 : 0, asha_id || null, village || null);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(patient);
});

// ---------- Appointments / Queue / Digital Token ----------
app.get('/api/appointments', (req, res) => {
  const { patient_id, facility_id, status } = req.query;
  let sql = `SELECT a.*, p.name as patient_name, f.name as facility_name FROM appointments a
             JOIN patients p ON p.id = a.patient_id
             JOIN facilities f ON f.id = a.facility_id WHERE 1=1`;
  const params = [];
  if (patient_id) { sql += ' AND a.patient_id = ?'; params.push(patient_id); }
  if (facility_id) { sql += ' AND a.facility_id = ?'; params.push(facility_id); }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  sql += ' ORDER BY a.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/appointments', (req, res) => {
  const { patient_id, facility_id, reason, mode, triage_priority } = req.body;
  if (!patient_id || !facility_id) return res.status(400).json({ error: 'patient_id and facility_id required' });
  const facility = db.prepare('SELECT * FROM facilities WHERE id = ?').get(facility_id);
  if (!facility) return res.status(404).json({ error: 'Facility not found' });

  const existingTokens = db.prepare(`SELECT token FROM appointments WHERE facility_id = ?`).all(facility_id);
  let maxNum = 100;
  existingTokens.forEach(row => {
    const n = parseInt((row.token || '').split('-')[1], 10);
    if (!isNaN(n) && n >= maxNum) maxNum = n + 1;
  });
  const token = `${facility.type[0]}-${maxNum}`;

  db.prepare('UPDATE facilities SET queue_waiting = queue_waiting + 1 WHERE id = ?').run(facility_id);
  const updatedFacility = db.prepare('SELECT * FROM facilities WHERE id = ?').get(facility_id);
  const estWait = predictWait(updatedFacility);

  const info = db.prepare(`INSERT INTO appointments (patient_id, facility_id, token, reason, mode, triage_priority, status, est_wait_minutes)
    VALUES (?,?,?,?,?,?,?,?)`).run(patient_id, facility_id, token, reason || 'General consultation', mode || 'In-person', triage_priority || 'Routine', 'Waiting', estWait);

  db.prepare('INSERT INTO notifications (user_role, patient_id, message) VALUES (?,?,?)')
    .run('patient', patient_id, `Appointment booked at ${facility.name}. Token ${token}, estimated wait ${estWait} min.`);

  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(appt);
});

app.patch('/api/appointments/:id', (req, res) => {
  const { status, triage_priority } = req.body;
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  const updates = [];
  const vals = [];
  if (status) { updates.push('status = ?'); vals.push(status); }
  if (triage_priority) { updates.push('triage_priority = ?'); vals.push(triage_priority); }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' });
  vals.push(req.params.id);
  db.prepare(`UPDATE appointments SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  if (status === 'Completed' || status === 'Cancelled') {
    db.prepare('UPDATE facilities SET queue_waiting = MAX(queue_waiting - 1, 0) WHERE id = ?').run(appt.facility_id);
  }
  res.json(db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id));
});

// ---------- Health Records ----------
app.get('/api/health-records', (req, res) => {
  const { patient_id } = req.query;
  if (!patient_id) return res.status(400).json({ error: 'patient_id required' });
  res.json(db.prepare('SELECT * FROM health_records WHERE patient_id = ? ORDER BY created_at DESC').all(patient_id));
});

app.post('/api/health-records', (req, res) => {
  const { patient_id, facility_id, record_type, title, details, doctor_name } = req.body;
  if (!patient_id || !title) return res.status(400).json({ error: 'patient_id and title required' });
  const info = db.prepare(`INSERT INTO health_records (patient_id, facility_id, record_type, title, details, doctor_name)
    VALUES (?,?,?,?,?,?)`).run(patient_id, facility_id || null, record_type || 'Consultation', title, details || '', doctor_name || '');
  res.status(201).json(db.prepare('SELECT * FROM health_records WHERE id = ?').get(info.lastInsertRowid));
});

// ---------- Doctor / PHC Instructions ----------
app.get('/api/instructions', (req, res) => {
  const { patient_id } = req.query;
  if (!patient_id) return res.status(400).json({ error: 'patient_id required' });
  res.json(db.prepare('SELECT * FROM instructions WHERE patient_id = ? ORDER BY created_at DESC').all(patient_id));
});

app.post('/api/instructions', (req, res) => {
  const { patient_id, facility_id, doctor_name, instruction_text, medication_info, next_visit } = req.body;
  if (!patient_id || !instruction_text) return res.status(400).json({ error: 'patient_id and instruction_text required' });
  const info = db.prepare(`INSERT INTO instructions (patient_id, facility_id, doctor_name, instruction_text, medication_info, next_visit)
    VALUES (?,?,?,?,?,?)`).run(patient_id, facility_id || null, doctor_name || '', instruction_text, medication_info || '', next_visit || null);
  db.prepare('INSERT INTO notifications (user_role, patient_id, message) VALUES (?,?,?)')
    .run('patient', patient_id, `New doctor instructions added by ${doctor_name || 'your doctor'}.`);
  res.status(201).json(db.prepare('SELECT * FROM instructions WHERE id = ?').get(info.lastInsertRowid));
});

// ---------- Referral Tracking ----------
app.get('/api/referrals', (req, res) => {
  const { patient_id, facility_id } = req.query;
  let sql = `SELECT r.*, p.name as patient_name, f1.name as from_name, f2.name as to_name
             FROM referrals r JOIN patients p ON p.id = r.patient_id
             LEFT JOIN facilities f1 ON f1.id = r.from_facility_id
             LEFT JOIN facilities f2 ON f2.id = r.to_facility_id WHERE 1=1`;
  const params = [];
  if (patient_id) { sql += ' AND r.patient_id = ?'; params.push(patient_id); }
  if (facility_id) { sql += ' AND (r.from_facility_id = ? OR r.to_facility_id = ?)'; params.push(facility_id, facility_id); }
  sql += ' ORDER BY r.updated_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/referrals', (req, res) => {
  const { patient_id, from_facility_id, to_facility_id, reason } = req.body;
  if (!patient_id || !to_facility_id) return res.status(400).json({ error: 'patient_id and to_facility_id required' });
  const info = db.prepare(`INSERT INTO referrals (patient_id, from_facility_id, to_facility_id, reason, status)
    VALUES (?,?,?,?, 'Created')`).run(patient_id, from_facility_id || null, to_facility_id, reason || '');
  res.status(201).json(db.prepare('SELECT * FROM referrals WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/referrals/:id', (req, res) => {
  const { status } = req.body;
  const valid = ['Created', 'Accepted', 'In Progress', 'Completed'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE referrals SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, req.params.id);
  const r = db.prepare('SELECT * FROM referrals WHERE id = ?').get(req.params.id);
  if (status === 'Completed') {
    db.prepare('INSERT INTO notifications (user_role, patient_id, message) VALUES (?,?,?)')
      .run('patient', r.patient_id, 'Your referral has been completed. Continue follow-up as advised.');
  }
  res.json(r);
});

// ---------- Follow-ups ----------
app.get('/api/follow-ups', (req, res) => {
  const { asha_id, patient_id, status } = req.query;
  let sql = `SELECT fu.*, p.name as patient_name, p.category as patient_category FROM follow_ups fu
             JOIN patients p ON p.id = fu.patient_id WHERE 1=1`;
  const params = [];
  if (asha_id) { sql += ' AND fu.asha_id = ?'; params.push(asha_id); }
  if (patient_id) { sql += ' AND fu.patient_id = ?'; params.push(patient_id); }
  if (status) { sql += ' AND fu.status = ?'; params.push(status); }
  sql += ' ORDER BY fu.due_date ASC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/follow-ups', (req, res) => {
  const { patient_id, asha_id, type, due_date, notes } = req.body;
  if (!patient_id || !due_date) return res.status(400).json({ error: 'patient_id and due_date required' });
  const info = db.prepare(`INSERT INTO follow_ups (patient_id, asha_id, type, due_date, status, notes)
    VALUES (?,?,?,?, 'Due', ?)`).run(patient_id, asha_id || null, type || 'General', due_date, notes || '');
  res.status(201).json(db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/follow-ups/:id', (req, res) => {
  const { status, notes } = req.body;
  const updates = [];
  const vals = [];
  if (status) { updates.push('status = ?'); vals.push(status); }
  if (notes !== undefined) { updates.push('notes = ?'); vals.push(notes); }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' });
  vals.push(req.params.id);
  db.prepare(`UPDATE follow_ups SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  res.json(db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(req.params.id));
});

// ---------- Medicines & Diagnostics ----------
app.get('/api/medicines', (req, res) => {
  const { facility_id } = req.query;
  if (!facility_id) return res.status(400).json({ error: 'facility_id required' });
  res.json(db.prepare('SELECT * FROM medicines WHERE facility_id = ?').all(facility_id));
});

app.patch('/api/medicines/:id', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE medicines SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json(db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id));
});

app.get('/api/diagnostics', (req, res) => {
  const { facility_id } = req.query;
  if (!facility_id) return res.status(400).json({ error: 'facility_id required' });
  res.json(db.prepare('SELECT * FROM diagnostics WHERE facility_id = ?').all(facility_id));
});

app.patch('/api/diagnostics/:id', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE diagnostics SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json(db.prepare('SELECT * FROM diagnostics WHERE id = ?').get(req.params.id));
});

// ---------- Notifications ----------
app.get('/api/notifications', (req, res) => {
  const { patient_id, user_role } = req.query;
  let sql = 'SELECT * FROM notifications WHERE 1=1';
  const params = [];
  if (patient_id) { sql += ' AND patient_id = ?'; params.push(patient_id); }
  if (user_role) { sql += ' AND user_role = ?'; params.push(user_role); }
  sql += ' ORDER BY created_at DESC LIMIT 20';
  res.json(db.prepare(sql).all(...params));
});

// ---------- AI Insights ----------
app.get('/api/ai/insights/:facility_id', (req, res) => {
  const f = db.prepare('SELECT * FROM facilities WHERE id = ?').get(req.params.facility_id);
  if (!f) return res.status(404).json({ error: 'Facility not found' });
  const pendingReferrals = db.prepare(`SELECT COUNT(*) c FROM referrals WHERE to_facility_id = ? AND status != 'Completed'`).get(f.id).c;
  const dueFollowUps = db.prepare(`SELECT COUNT(*) c FROM follow_ups fu JOIN patients p ON p.id = fu.patient_id WHERE fu.status = 'Due'`).get().c;
  res.json({
    facility: f.name,
    predicted_wait_minutes: predictWait(f),
    crowd_forecast: crowdForecast(f),
    pending_referrals_in: pendingReferrals,
    system_wide_due_follow_ups: dueFollowUps,
    recommendation: predictWait(f) > 30
      ? 'Wait time is high — consider opening an additional OPD counter or redirecting routine cases to a nearby CHC.'
      : 'Wait time is within normal range — no action needed.',
    disclaimer: 'AI provides operational decision support only. It does not diagnose or prescribe.'
  });
});

// ---------- Admin Overview ----------
app.get('/api/admin/overview', (req, res) => {
  const facilities = db.prepare('SELECT * FROM facilities').all();
  const totalPatients = db.prepare('SELECT COUNT(*) c FROM patients').get().c;
  const totalAppointmentsToday = db.prepare(`SELECT COUNT(*) c FROM appointments WHERE date(created_at) = date('now')`).get().c;
  const totalQueueWaiting = facilities.reduce((s, f) => s + f.queue_waiting, 0);
  const pendingReferrals = db.prepare(`SELECT COUNT(*) c FROM referrals WHERE status != 'Completed'`).get().c;
  const completedReferrals = db.prepare(`SELECT COUNT(*) c FROM referrals WHERE status = 'Completed'`).get().c;
  const dueFollowUps = db.prepare(`SELECT COUNT(*) c FROM follow_ups WHERE status = 'Due'`).get().c;
  const completedFollowUps = db.prepare(`SELECT COUNT(*) c FROM follow_ups WHERE status = 'Completed'`).get().c;
  const highCrowd = facilities.filter(f => f.crowd_status === 'High');
  const lowStockMeds = db.prepare(`SELECT m.name, f.name as facility_name, m.status FROM medicines m JOIN facilities f ON f.id = m.facility_id WHERE m.status != 'Available'`).all();

  res.json({
    total_facilities: facilities.length,
    active_facilities: facilities.length,
    total_patients: totalPatients,
    appointments_today: totalAppointmentsToday,
    total_queue_waiting: totalQueueWaiting,
    pending_referrals: pendingReferrals,
    completed_referrals: completedReferrals,
    due_follow_ups: dueFollowUps,
    completed_follow_ups: completedFollowUps,
    high_crowd_facilities: highCrowd.map(f => ({ id: f.id, name: f.name, type: f.type })),
    medicine_alerts: lowStockMeds,
    facilities: facilities.map(f => ({ ...f, predicted_wait: predictWait(f) }))
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  CareNexus server running → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
