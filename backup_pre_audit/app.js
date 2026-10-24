// =========================================================
// CareNexus — Frontend Application (vanilla JS, talks to REST API)
// =========================================================

const state = {
  user: null,        // {id, name, role, language, facility_id}
  patient: null,      // patient row if role === patient
  facility: null,     // facility row if role === facility
  tab: null,
  facilitiesCache: null,
  drillPatientId: null, // when ASHA/facility opens a specific patient profile
};

const app = document.getElementById('app');

// ---------- API helper ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.user && state.user.id) {
    headers['X-User-Id'] = String(state.user.id);
  }
  const res = await fetch('/api' + path, {
    ...opts,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg) {
  const wrap = document.getElementById('toastWrap');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return d; }
}
function fmtDateTime(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return d; }
}
function initials(name) {
  return (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function badge(text, kind) { return `<span class="badge badge-${kind}">${text}</span>`; }

function statusBadge(status) {
  const map = {
    'Waiting': 'amber', 'In Consultation': 'blue', 'Completed': 'green', 'Cancelled': 'grey',
    'Due': 'amber', 'Missed': 'red',
    'Created': 'grey', 'Accepted': 'blue', 'In Progress': 'amber',
    'Available': 'green', 'Low Stock': 'amber', 'Unavailable': 'red', 'Busy': 'amber',
    'High': 'red', 'Medium': 'amber', 'Normal': 'green',
  };
  return badge(status, map[status] || 'grey');
}

// =========================================================
// AUTH / LOGIN
// =========================================================

let selectedRole = 'patient';

function renderLogin() {
  document.getElementById('voiceFab')?.remove();
  document.getElementById('voicePanel')?.remove();
  app.innerHTML = `
  <div class="login-shell">
    <div class="login-hero">
      <div class="brand">
        <div class="brand-mark">CN</div>
        <div>
          <div style="font-family:var(--font-head);font-weight:800;font-size:18px;">CareNexus</div>
          <div style="font-size:12px;color:#B9D6CC;">Connect &middot; Care &middot; Better Health</div>
        </div>
      </div>
      <div>
        <h1>Smarter healthcare access for rural &amp; underserved communities.</h1>
        <p class="tag">One connected platform for patients, ASHA/frontline health workers, PHC/CHC/hospital staff and administrators — appointments, referrals, follow-up and AI-powered facility insights in one place.</p>
        <div class="hero-stats">
          <div><strong>128</strong><span>Facilities connected</span></div>
          <div><strong>18,420</strong><span>Patients served today</span></div>
          <div><strong>35s</strong><span>Avg. time to book care</span></div>
        </div>
      </div>
      <div class="hero-flow">Patient &nbsp;↔&nbsp; ASHA / Frontline Worker &nbsp;↔&nbsp; PHC &nbsp;↔&nbsp; CHC &nbsp;↔&nbsp; Hospital</div>
    </div>
    <div class="login-panel">
      <div class="login-card">
        <h2>Sign in to CareNexus</h2>
        <p class="sub">Select your role to continue</p>
        <div class="role-grid" id="roleGrid"></div>
        <div class="field">
          <label>Phone number</label>
          <input type="text" id="loginPhone" placeholder="e.g. 9000000001" />
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" id="loginPassword" placeholder="Demo password: 1234" value="1234" />
        </div>
        <button class="btn btn-primary" id="loginBtn">Sign in</button>
        <p class="error-msg hidden" id="loginError"></p>
        <div class="demo-note" id="demoNote">Loading demo accounts…</div>
      </div>
    </div>
  </div>`;

  const roles = [
    { id: 'patient', label: 'Patient', emoji: '🧑‍🤝‍🧑' },
    { id: 'asha', label: 'ASHA / Frontline Worker', emoji: '🩺' },
    { id: 'facility', label: 'PHC / CHC / Hospital Staff', emoji: '🏥' },
    { id: 'admin', label: 'Administrator', emoji: '📊' },
  ];
  const grid = document.getElementById('roleGrid');
  grid.innerHTML = roles.map(r => `
    <button class="role-btn ${r.id === selectedRole ? 'active' : ''}" data-role="${r.id}">
      <span class="emoji">${r.emoji}</span>${r.label}
    </button>`).join('');
  grid.querySelectorAll('.role-btn').forEach(btn => {
    btn.onclick = () => { selectedRole = btn.dataset.role; renderLogin(); };
  });

  document.getElementById('loginBtn').onclick = doLogin;
  document.getElementById('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  api('/demo-accounts').then(rows => {
    const byRole = {};
    rows.forEach(r => { (byRole[r.role] = byRole[r.role] || []).push(r); });
    document.getElementById('demoNote').innerHTML = `
      <b>Demo accounts</b> (password: 1234)<br>
      Patient: 9000000001 &nbsp;|&nbsp; ASHA: 9000000002 &nbsp;|&nbsp; Facility: 9000000003 &nbsp;|&nbsp; Admin: 9000000004`;
  }).catch(() => {});
}

async function doLogin() {
  const phone = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');
  if (!phone) { errEl.textContent = 'Enter a phone number.'; errEl.classList.remove('hidden'); return; }
  try {
    const data = await api('/login', { method: 'POST', body: JSON.stringify({ phone, password, role: selectedRole }) });
    state.user = data.user;
    state.patient = data.patient;
    state.facility = data.facility;
    state.tab = null;
    renderApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

function logout() {
  state.user = null; state.patient = null; state.facility = null; state.tab = null; state.drillPatientId = null;
  if (typeof assistantState !== 'undefined') {
    assistantState.messages = [];
    if (typeof stopAssistantAudio === 'function') stopAssistantAudio();
  }
  renderLogin();
}

// =========================================================
// APP SHELL / ROUTER
// =========================================================

const NAV = {
  patient: [
    ['home', '🏠', 'Home'],
    ['assistant', '🎙️', 'Voice Assistant'],
    ['findcare', '📍', 'Find Care'],
    ['sos', '🚨', 'Emergency SOS'],
    ['queue', '🎫', 'Appointments & Queue'],
    ['records', '📋', 'Health Records'],
    ['care', '💊', 'Instructions & Medicines'],
    ['referral', '🔁', 'Referral Status'],
    ['followup', '🔔', 'Follow-up & Alerts'],
  ],
  asha: [
    ['dashboard', '🏠', 'Dashboard'],
    ['patients', '👥', 'My Patients'],
    ['followups', '📅', 'Follow-Up Management'],
    ['referrals', '🔁', 'Referral Tracking'],
    ['supplies', '💊', 'Medicine & Diagnostics'],
  ],
  facility: [
    ['overview', '🏠', "Today's Overview"],
    ['opd', '🎫', 'OPD Module'],
    ['diagnostics', '🧪', 'Diagnostics'],
    ['medicine', '💊', 'Medicine / Pharmacy'],
    ['emergency', '🚨', 'Emergency'],
    ['referral', '🔁', 'Referral Module'],
    ['followup', '📅', 'Follow-up Module'],
    ['ai', '🤖', 'AI Insights'],
  ],
  admin: [
    ['overview', '🏠', 'Network Overview'],
    ['facilities', '🏥', 'Facility Monitoring'],
    ['referrals', '🔁', 'Referral Monitoring'],
    ['followups', '📅', 'Follow-up Monitoring'],
    ['quality', '📈', 'Quality & AI Insights'],
    ['emergencypartners', '🛡️', 'Emergency Partners'],
  ],
};

const ROLE_LABEL = { patient: 'Patient', asha: 'ASHA / Frontline Worker', facility: 'Facility Staff', admin: 'Administrator' };

function renderApp() {
  const role = state.user.role;
  if (!state.tab) state.tab = NAV[role][0][0];
  const navItems = NAV[role];

  app.innerHTML = `
  <div class="dash-shell">
    <div class="sidebar">
      <div class="brand">
        <div class="brand-mark">CN</div>
        <span class="name">CareNexus</span>
      </div>
      <div id="navItems"></div>
      <div class="sidebar-foot">
        <div class="sidebar-user">
          <b>${state.user.name}</b>
          ${ROLE_LABEL[role]}${state.facility ? ' · ' + state.facility.name : ''}
        </div>
        <button class="btn btn-signout" onclick="logout()" type="button" aria-label="Sign out">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
            <polyline points="16 17 21 12 16 7"></polyline>
            <line x1="21" y1="12" x2="9" y2="12"></line>
          </svg>
          <span>Sign out</span>
        </button>
      </div>
    </div>
    <div class="main-area">
      <div class="topbar">
        <h2 id="topbarTitle"></h2>
        <div id="topbarRight" style="font-size:13px;color:var(--ink-soft);"></div>
      </div>
      <div class="content" id="content"></div>
    </div>
  </div>`;

  if (role !== 'patient') {
    document.getElementById('voiceFab')?.remove();
    document.getElementById('voicePanel')?.remove();
  } else if (!document.getElementById('voiceFab')) {
    document.body.insertAdjacentHTML('beforeend', `<button id="voiceFab" class="voice-fab" type="button">🎙 CareNexus Voice</button><div id="voicePanel" class="voice-panel" hidden><h3>CareNexus Voice Assistant</h3><p>Ask for help navigating CareNexus or understanding available services. It is not an emergency service and cannot diagnose or prescribe. For immediate danger, call 112.</p><div id="voiceStatus" class="mini-note" style="margin-bottom:12px;">Voice assistant ready when configured.</div><div style="display:flex;gap:8px;"><button id="voiceStart" class="btn btn-primary btn-small">Start voice</button><button id="voiceStop" class="btn btn-outline btn-small">End session</button><button id="voiceClose" class="btn btn-outline btn-small">Close</button></div></div>`);
    document.getElementById('voiceFab').onclick = () => {
      if (state.user && state.user.role === 'patient') {
        state.tab = 'assistant';
        renderApp();
      } else {
        document.getElementById('voicePanel').hidden = !document.getElementById('voicePanel').hidden;
      }
    };
    document.getElementById('voiceClose').onclick = () => { document.getElementById('voicePanel').hidden = true; };
    let voiceSession = null;
    document.getElementById('voiceStart').onclick = async () => {
      const status = document.getElementById('voiceStatus');
      status.textContent = 'Connecting to voice assistant…';
      try {
        const { signed_url } = await api('/voice/signed-url');
        const { Conversation } = await import('https://esm.sh/@elevenlabs/client@0.12.0');
        voiceSession = await Conversation.startSession({ signedUrl: signed_url, onConnect: () => status.textContent = 'Connected. Speak naturally; avoid sharing unnecessary sensitive details.', onDisconnect: () => status.textContent = 'Voice session ended.', onError: () => status.textContent = 'Voice session error. Check microphone permission and ElevenLabs agent settings.' });
      } catch (e) { status.textContent = e.message || 'Could not start voice assistant.'; }
    };
    document.getElementById('voiceStop').onclick = async () => { try { if (voiceSession) await voiceSession.endSession(); } catch (_) {} voiceSession = null; document.getElementById('voiceStatus').textContent = 'Voice session ended.'; };
  }
  const navWrap = document.getElementById('navItems');
  navWrap.innerHTML = navItems.map(([key, emoji, label]) => `
    <div class="nav-item ${state.tab === key ? 'active' : ''}" data-tab="${key}">
      <span>${emoji}</span><span>${label}</span>
    </div>`).join('');
  navWrap.querySelectorAll('.nav-item').forEach(item => {
    item.onclick = () => { state.tab = item.dataset.tab; state.drillPatientId = null; renderApp(); };
  });

  const activeLabel = navItems.find(n => n[0] === state.tab)[2];
  document.getElementById('topbarTitle').textContent = activeLabel;
  document.getElementById('topbarRight').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  renderTabContent();
}

function renderTabContent() {
  const content = document.getElementById('content');
  content.innerHTML = `<div class="empty-state">Loading…</div>`;
  const role = state.user.role;
  const routes = {
    patient: renderPatientTab,
    asha: renderAshaTab,
    facility: renderFacilityTab,
    admin: renderAdminTab,
  };
  routes[role](content, state.tab).catch(err => {
    content.innerHTML = `<div class="empty-state">Could not load this section: ${err.message}</div>`;
  });
}

// kick off
renderLogin();

// =========================================================
// PATIENT DASHBOARD
// =========================================================

async function renderPatientTab(content, tab) {
  const patient = state.patient;
  if (!patient) {
    content.innerHTML = `<div class="empty-state">No patient profile linked to this account.</div>`;
    return;
  }
  if (tab === 'home') return renderPatientHome(content, patient);
  if (tab === 'assistant') return renderAssistantTab(content, 'patient');
  if (tab === 'findcare') return renderPatientFindCare(content, patient);
  if (tab === 'sos') return renderPatientSOS(content, patient);
  if (tab === 'queue') return renderPatientQueue(content, patient);
  if (tab === 'records') return renderPatientRecords(content, patient);
  if (tab === 'care') return renderPatientCare(content, patient);
  if (tab === 'referral') return renderPatientReferral(content, patient);
  if (tab === 'followup') return renderPatientFollowup(content, patient);
}

async function renderPatientHome(content, patient) {
  const [appts, notifs] = await Promise.all([
    api(`/appointments?patient_id=${patient.id}`),
    api(`/notifications?patient_id=${patient.id}`),
  ]);
  const active = appts.find(a => a.status === 'Waiting' || a.status === 'In Consultation');

  content.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div class="card-label">Welcome</div>
      <h3 style="font-size:20px;">Hello, ${patient.name.split(' ')[0]} 👋</h3>
      <p style="color:var(--ink-soft);font-size:13.5px;margin:6px 0 0;">
        ${patient.category !== 'General' ? `${patient.category} care patient` : 'General care'}
        ${patient.high_risk ? ' · ' + badge('High-risk — monitored', 'red') : ''}
        &middot; Village: ${patient.village || '—'}
      </p>
    </div>

    <div class="grid grid-2" style="align-items:start;">
      ${active ? `
      <div class="card">
        <div class="section-title"><h3>Live token &amp; queue</h3>${statusBadge(active.status)}</div>
        <div style="display:flex;gap:20px;align-items:center;">
          <div>
            <div style="font-family:var(--font-head);font-size:34px;font-weight:800;color:var(--teal);">${active.token}</div>
            <div class="mini-note">${active.facility_name}</div>
          </div>
          <div class="divider" style="height:auto;width:1px;align-self:stretch;margin:0;background:var(--line);"></div>
          <div>
            <div style="font-family:var(--font-head);font-size:22px;font-weight:800;">${active.est_wait_minutes} min</div>
            <div class="mini-note">Estimated waiting time</div>
          </div>
        </div>
      </div>` : `
      <div class="card">
        <div class="section-title"><h3>No active appointment</h3></div>
        <p style="font-size:13.5px;color:var(--ink-soft);">Book an appointment or join a queue from Find Care.</p>
        <button class="btn btn-primary btn-small" onclick="state.tab='findcare';renderApp();">Find Care</button>
      </div>`}

      <div class="card">
        <div class="section-title"><h3>Recent updates</h3></div>
        ${notifs.length ? `<div>${notifs.slice(0,5).map(n => `
          <div class="list-row">
            <div style="font-size:13.5px;">${n.message}</div>
            <div class="mini-note" style="flex-shrink:0;margin-left:12px;">${fmtDateTime(n.created_at)}</div>
          </div>`).join('')}</div>` : `<div class="empty-state">No updates yet.</div>`}
      </div>
    </div>`;
}

async function renderPatientFindCare(content, patient) {
  const facilities = await api('/facilities');
  content.innerHTML = `
    <div class="card" style="margin-bottom:18px;">
      <div class="section-title">
        <h3>🔎 Live Health Discovery</h3>
        <span class="mini-note">OpenStreetMap · public map data</span>
      </div>
      <p class="mini-note" style="margin-bottom:12px;">
        Search hospitals, clinics, pharmacies and diagnostic services around a town or city. Public map listings may be incomplete and are not facility verification.
      </p>
      <div style="display:grid;grid-template-columns:2fr 1fr auto;gap:8px;align-items:end;">
        <div class="field" style="margin:0;">
          <label>What do you need?</label>
          <input id="liveSearchQuery" type="text" placeholder="e.g. diagnostic centre, hospital, pharmacy" />
        </div>
        <div class="field" style="margin:0;">
          <label>Location</label>
          <input id="liveSearchLocation" type="text" placeholder="e.g. Kolhapur, Maharashtra" />
        </div>
        <button class="btn btn-primary" id="liveSearchBtn">Search</button>
      </div>
      <div id="liveSearchResults" style="margin-top:14px;"></div>
    </div>

    <div class="section-title"><h3>CareNexus Connected Facilities</h3><span class="mini-note">Live crowd status &amp; AI wait-time prediction</span></div>
    <div class="grid grid-3" id="facilityCards"></div>
  `;

  const wrap = document.getElementById('facilityCards');
  wrap.innerHTML = facilities.map(f => `
    <div class="card">
      <div class="section-title" style="margin-bottom:8px;">
        <h3>${f.name}</h3>${badge(f.type, 'blue')}
      </div>
      <div class="mini-note">${f.area}</div>
      <div style="display:flex;gap:16px;margin:12px 0;">
        <div><div style="font-weight:800;font-family:var(--font-head);">${f.predicted_wait}m</div><div class="mini-note">Est. wait</div></div>
        <div><div style="font-weight:800;font-family:var(--font-head);">${f.doctors_available}/${f.doctors_total}</div><div class="mini-note">Doctors available</div></div>
        <div>${statusBadge(f.crowd_status)}<div class="mini-note">Crowd</div></div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary btn-small" style="flex:1;" onclick="openBookingModal(${f.id}, 'In-person')">Book appointment</button>
        <button class="btn btn-outline btn-small" onclick="openBookingModal(${f.id}, 'Teleconsultation')">Tele</button>
      </div>
    </div>`).join('');

  document.getElementById('liveSearchBtn').onclick = async () => {
    const q = document.getElementById('liveSearchQuery').value.trim();
    const location = document.getElementById('liveSearchLocation').value.trim();
    const resultEl = document.getElementById('liveSearchResults');

    if (!q) {
      resultEl.innerHTML = `<div class="empty-state">Enter a hospital, diagnostic centre, pharmacy or healthcare service.</div>`;
      return;
    }

    resultEl.innerHTML = `<div class="empty-state">Searching live healthcare results…</div>`;
    try {
      const data = await api(`/live-search?q=${encodeURIComponent(q)}&location=${encodeURIComponent(location)}`);
      if (!data.results.length) {
        resultEl.innerHTML = `<div class="empty-state">No local results found. Try a broader search or different location.</div>`;
        return;
      }

      resultEl.innerHTML = `
        <div class="mini-note" style="margin-bottom:8px;">Live results via ${data.source}. ${data.note || ''}</div>
        <div style="display:grid;gap:10px;">
          ${data.results.map(r => `
            <div class="list-row" style="align-items:flex-start;">
              <div>
                <div style="font-weight:700;font-size:14px;">${r.title}</div>
                <div class="mini-note">${r.address || 'Address not available'}</div>
                ${r.type ? `<div class="mini-note">${r.type}</div>` : ''}
                <div class="mini-note">
                  ${r.phone ? `📞 ${r.phone}` : 'Phone not listed'}
                </div>
              </div>
              ${r.maps_link ? `<a class="btn btn-outline btn-small" href="${r.maps_link}" target="_blank" rel="noopener">View on Maps</a>` : ''}
            </div>`).join('')}
        </div>`;
    } catch (e) {
      resultEl.innerHTML = `<div class="empty-state">${e.message}</div>`;
    }
  };
}

function openBookingModal(facilityId, mode) {
  const modalHtml = `
  <div class="modal-backdrop" id="modalBackdrop">
    <div class="modal">
      <button class="modal-close" onclick="closeModal()">&times;</button>
      <h3>${mode === 'Teleconsultation' ? 'Book teleconsultation' : 'Book appointment / digital token'}</h3>
      <div class="field">
        <label>Reason for visit</label>
        <input type="text" id="bookReason" placeholder="e.g. Fever, antenatal checkup" />
      </div>
      <div class="field">
        <label>Triage priority</label>
        <select id="bookPriority">
          <option value="Routine">Routine</option>
          <option value="Priority">Priority</option>
          <option value="Emergency">Emergency</option>
        </select>
      </div>
      <button class="btn btn-primary" onclick="submitBooking(${facilityId}, '${mode}')">Confirm booking</button>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}
function closeModal() { document.getElementById('modalBackdrop')?.remove(); }

async function submitBooking(facilityId, mode) {
  const reason = document.getElementById('bookReason').value || 'General consultation';
  const triage_priority = document.getElementById('bookPriority').value;
  try {
    const appt = await api('/appointments', { method: 'POST', body: JSON.stringify({
      patient_id: state.patient.id, facility_id: facilityId, reason, mode, triage_priority,
    })});
    closeModal();
    toast(`Booked! Your token is ${appt.token}, est. wait ${appt.est_wait_minutes} min.`);
    state.tab = 'queue';
    renderApp();
  } catch (e) { toast('Booking failed: ' + e.message); }
}

async function renderPatientSOS(content, patient) {
  let history = [];
  try { history = await api(`/sos?patient_id=${patient.id}`); } catch (_) {}
  content.innerHTML = `
    <div class="card" style="border:1px solid #fecaca;background:linear-gradient(135deg,#fff7f7,#fff);margin-bottom:18px;">
      <div class="section-title"><h3 style="color:#991b1b;">🚨 Emergency SOS</h3><span class="badge badge-red">Emergency support</span></div>
      <p style="line-height:1.6;color:var(--ink-soft);">If someone is in immediate danger, call <b>112</b> now. CareNexus SOS is a coordination prototype and does not dispatch an ambulance automatically.</p>
      <a class="btn btn-danger" href="tel:112" style="display:inline-flex;text-decoration:none;margin:4px 0 18px;">Call 112 now</a>
      <div class="grid grid-2" style="align-items:start;">
        <div class="field"><label>Emergency type</label><select id="sosType"><option value="Medical emergency">Medical emergency</option><option value="Accident / injury">Accident / injury</option><option value="Pregnancy / childbirth">Pregnancy / childbirth</option><option value="Breathing difficulty">Breathing difficulty</option><option value="Other urgent help">Other urgent help</option></select></div>
        <div class="field"><label>Location / landmark (required if GPS unavailable)</label><input id="sosLocation" placeholder="Village, road, nearby landmark" /></div>
      </div>
      <div class="field"><label>What happened? (optional)</label><textarea id="sosDescription" rows="3" placeholder="Short description of the emergency"></textarea></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;"><button class="btn btn-outline" id="sosGps">Use my current location</button><span id="sosGpsStatus" class="mini-note">GPS is optional; permission is requested only when you tap the button.</span></div>
      <div style="margin-top:16px;"><button class="btn btn-danger" id="sosSubmit">Send SOS request</button></div>
      <div class="mini-note" style="margin-top:12px;">Only separately verified and active CareNexus participating facilities with configured coordinates can receive requests within 15 km. Public OpenStreetMap listings are never used for emergency dispatch.</div>
      <div id="sosResult" style="margin-top:12px;"></div>
    </div>
    <div class="section-title"><h3>My SOS activity</h3><span class="mini-note">Status timeline</span></div>
    <div class="card" id="sosHistory">${history.length ? history.map(sosHistoryCard).join('') : '<div class="empty-state">No SOS requests yet.</div>'}</div>`;
  let coords = null;
  document.getElementById('sosGps').onclick = () => {
    const status = document.getElementById('sosGpsStatus');
    if (!navigator.geolocation) { status.textContent = 'GPS is not available in this browser. Enter your location manually.'; return; }
    status.textContent = 'Requesting location permission…';
    navigator.geolocation.getCurrentPosition(pos => { coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude }; status.textContent = 'Location captured for this request.'; }, () => { status.textContent = 'Could not access GPS. Enter your location manually.'; }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  };
  document.getElementById('sosSubmit').onclick = async () => {
    const result = document.getElementById('sosResult');
    const location_text = document.getElementById('sosLocation').value.trim();
    if (!coords && !location_text) { result.innerHTML = '<div class="empty-state">Tap “Use my current location” or enter a location/landmark. Call 112 if this is urgent.</div>'; return; }
    const btn = document.getElementById('sosSubmit'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const data = await api('/sos', { method: 'POST', body: JSON.stringify({ patient_id: patient.id, ...(coords || {}), location_text, emergency_type: document.getElementById('sosType').value, description: document.getElementById('sosDescription').value.trim() }) });
      result.innerHTML = `<div class="ai-box"><h3>SOS request #${data.id} created</h3><p>${data.message}</p><p><b>Status:</b> ${data.status}</p><p class="disclaimer">This does not confirm an ambulance, bed availability, or emergency response. If immediate help is needed, call 112.</p></div>`;
      const latest = await api(`/sos?patient_id=${patient.id}`); document.getElementById('sosHistory').innerHTML = latest.map(sosHistoryCard).join('');
    } catch (e) { result.innerHTML = `<div class="empty-state">${e.message}</div>`; }
    finally { btn.disabled = false; btn.textContent = 'Send SOS request'; }
  };
}
function sosHistoryCard(r) {
  const status = String(r.status || 'Searching');
  return `<div class="list-row"><div><b>SOS #${r.id} · ${r.emergency_type}</b><div class="mini-note">${fmtDateTime(r.created_at)} · ${r.location_text || 'GPS location submitted'}</div><div class="mini-note">${r.accepted_facility_name ? 'Accepted by ' + r.accepted_facility_name : 'No accepting facility recorded'}</div></div><div><span class="badge ${status.includes('confirmed') ? 'badge-green' : 'badge-red'}">${status}</span>${status === 'Accepted' || status === 'Contacting patient' ? `<div style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;"><button class="btn btn-small btn-primary" onclick="confirmSOS(${r.id},'confirmed')">Confirm</button><button class="btn btn-small btn-outline" onclick="confirmSOS(${r.id},'denied')">Not me</button><button class="btn btn-small btn-outline" onclick="confirmSOS(${r.id},'unable')">Can't verify</button></div>` : ''}</div></div>`;
}
async function confirmSOS(id, confirmation) {
  try { await api(`/sos/${id}/confirmation`, { method: 'PATCH', body: JSON.stringify({ patient_id: state.patient.id, confirmation }) }); toast('SOS status updated.'); renderApp(); }
  catch (e) { toast(e.message); }
}

async function renderPatientQueue(content, patient) {
  const appts = await api(`/appointments?patient_id=${patient.id}`);
  content.innerHTML = `
    <div class="section-title"><h3>My appointments &amp; queue status</h3></div>
    <div class="card">
      ${appts.length ? `<table>
        <tr><th>Token</th><th>Facility</th><th>Reason</th><th>Mode</th><th>Priority</th><th>Wait</th><th>Status</th></tr>
        ${appts.map(a => `
          <tr>
            <td><b>${a.token}</b></td>
            <td>${a.facility_name}</td>
            <td>${a.reason}</td>
            <td>${a.mode}</td>
            <td>${statusBadge(a.triage_priority === 'Emergency' ? 'High' : a.triage_priority === 'Priority' ? 'Medium' : 'Normal')}</td>
            <td>${a.status === 'Waiting' ? a.est_wait_minutes + ' min' : '—'}</td>
            <td>${statusBadge(a.status)}</td>
          </tr>`).join('')}
      </table>` : `<div class="empty-state">No appointments yet. Visit Find Care to book one.</div>`}
    </div>`;
}

async function renderPatientRecords(content, patient) {
  const records = await api(`/health-records?patient_id=${patient.id}`);
  content.innerHTML = `
    <div class="section-title"><h3>My Health Records</h3><span class="mini-note">Digital, longitudinal record — view only</span></div>
    <div class="card">
      ${records.length ? records.map(r => `
        <div class="list-row" style="align-items:flex-start;">
          <div>
            <div style="font-weight:700;font-size:13.5px;">${r.title} ${badge(r.record_type, 'blue')}</div>
            <div class="mini-note" style="margin-top:4px;">${r.details || ''}</div>
            <div class="mini-note">${r.doctor_name ? 'By ' + r.doctor_name + ' · ' : ''}${fmtDate(r.created_at)}</div>
          </div>
        </div>`).join('') : `<div class="empty-state">No health records yet.</div>`}
    </div>`;
}

async function renderPatientCare(content, patient) {
  const [instr, appts] = await Promise.all([
    api(`/instructions?patient_id=${patient.id}`),
    api(`/appointments?patient_id=${patient.id}`),
  ]);
  const facilityIds = [...new Set(appts.map(a => a.facility_id))];
  let medHtml = '';
  for (const fid of facilityIds.slice(0,1)) {
    const meds = await api(`/medicines?facility_id=${fid}`);
    medHtml = meds.map(m => `<tr><td>${m.name}</td><td>${statusBadge(m.status)}</td></tr>`).join('');
  }
  content.innerHTML = `
    <div class="section-title"><h3>Doctor / PHC Instructions</h3></div>
    <div class="card" style="margin-bottom:18px;">
      ${instr.length ? instr.map(i => `
        <div class="list-row" style="align-items:flex-start;">
          <div>
            <div style="font-weight:700;font-size:13.5px;">${i.doctor_name || 'Doctor'} &middot; ${fmtDate(i.created_at)}</div>
            <div class="mini-note" style="margin-top:4px;">${i.instruction_text}</div>
            ${i.medication_info ? `<div class="mini-note"><b>Medication:</b> ${i.medication_info}</div>` : ''}
            ${i.next_visit ? `<div class="mini-note"><b>Next visit:</b> ${fmtDate(i.next_visit)}</div>` : ''}
          </div>
        </div>`).join('') : `<div class="empty-state">No instructions recorded yet.</div>`}
    </div>
    <div class="section-title"><h3>Medicine availability at your last visited facility</h3></div>
    <div class="card">
      ${medHtml ? `<table><tr><th>Medicine</th><th>Status</th></tr>${medHtml}</table>` : `<div class="empty-state">No facility visits recorded yet.</div>`}
    </div>`;
}

async function renderPatientReferral(content, patient) {
  const refs = await api(`/referrals?patient_id=${patient.id}`);
  content.innerHTML = `
    <div class="section-title"><h3>Referral Status</h3></div>
    ${refs.length ? refs.map(r => `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-title" style="margin-bottom:14px;"><h3>${r.from_name || 'Facility'} → ${r.to_name}</h3>${statusBadge(r.status)}</div>
        <div class="pill-flow">
          ${['Created','Accepted','In Progress','Completed'].map((s,i,arr) => {
            const order = ['Created','Accepted','In Progress','Completed'];
            const curIdx = order.indexOf(r.status);
            const cls = i < curIdx ? 'done' : i === curIdx ? 'current' : '';
            return `<span class="pill ${cls}">${s}</span>` + (i < arr.length-1 ? `<span class="pill-arrow">→</span>` : '');
          }).join('')}
        </div>
        <p class="mini-note" style="margin-top:12px;">${r.reason || ''}</p>
      </div>`).join('') : `<div class="card"><div class="empty-state">No referrals on record. Care is continuing at your local facility.</div></div>`}`;
}

async function renderPatientFollowup(content, patient) {
  const [followups, notifs] = await Promise.all([
    api(`/follow-ups?patient_id=${patient.id}`),
    api(`/notifications?patient_id=${patient.id}`),
  ]);
  content.innerHTML = `
    <div class="section-title"><h3>Follow-up &amp; ASHA Support</h3></div>
    <div class="card" style="margin-bottom:18px;">
      ${followups.length ? `<table><tr><th>Type</th><th>Due</th><th>Status</th><th>Notes</th></tr>
        ${followups.map(f => `<tr><td>${f.type}</td><td>${fmtDate(f.due_date)}</td><td>${statusBadge(f.status)}</td><td>${f.notes||''}</td></tr>`).join('')}
      </table>` : `<div class="empty-state">No follow-ups scheduled.</div>`}
    </div>
    <div class="section-title"><h3>Notifications</h3></div>
    <div class="card">
      ${notifs.length ? notifs.map(n => `<div class="list-row"><div style="font-size:13.5px;">${n.message}</div><div class="mini-note">${fmtDateTime(n.created_at)}</div></div>`).join('') : `<div class="empty-state">No notifications.</div>`}
    </div>`;
}

// =========================================================
// ASHA / FRONTLINE WORKER DASHBOARD
// =========================================================

async function renderAshaTab(content, tab) {
  const ashaId = state.user.id;
  if (state.drillPatientId && tab === 'patients') return renderAshaPatientProfile(content, state.drillPatientId);
  if (tab === 'dashboard') return renderAshaDashboard(content, ashaId);
  if (tab === 'patients') return renderAshaPatients(content, ashaId);
  if (tab === 'followups') return renderAshaFollowups(content, ashaId);
  if (tab === 'referrals') return renderAshaReferrals(content, ashaId);
  if (tab === 'supplies') return renderAshaSupplies(content);
}

async function renderAshaDashboard(content, ashaId) {
  const [patients, followups, referrals] = await Promise.all([
    api(`/patients?asha_id=${ashaId}`),
    api(`/follow-ups?asha_id=${ashaId}`),
    api(`/referrals`),
  ]);
  const highRisk = patients.filter(p => p.high_risk);
  const dueFollowups = followups.filter(f => f.status === 'Due');
  const myPatientIds = new Set(patients.map(p => p.id));
  const myReferrals = referrals.filter(r => myPatientIds.has(r.patient_id) && r.status !== 'Completed');

  content.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:18px;">
      <div class="card stat-card"><div class="num">${patients.length}</div><div class="lbl">Total patients</div></div>
      <div class="card stat-card"><div class="num">${dueFollowups.length}</div><div class="lbl">Pending follow-ups</div></div>
      <div class="card stat-card"><div class="num">${highRisk.length}</div><div class="lbl">High-risk patients</div></div>
      <div class="card stat-card"><div class="num">${myReferrals.length}</div><div class="lbl">Pending referrals</div></div>
    </div>
    <div class="grid grid-2" style="align-items:start;">
      <div class="card">
        <div class="section-title"><h3>Today's priority follow-ups</h3></div>
        ${dueFollowups.length ? dueFollowups.slice(0,6).map(f => `
          <div class="list-row">
            <div style="display:flex;align-items:center;gap:10px;">
              <div class="avatar">${initials(f.patient_name)}</div>
              <div>
                <div style="font-weight:700;font-size:13.5px;">${f.patient_name}</div>
                <div class="mini-note">${f.type} follow-up &middot; due ${fmtDate(f.due_date)}</div>
              </div>
            </div>
            <button class="btn btn-outline btn-small" onclick="completeFollowup(${f.id})">Mark done</button>
          </div>`).join('') : `<div class="empty-state">All caught up — no pending follow-ups.</div>`}
      </div>
      <div class="card">
        <div class="section-title"><h3>High-risk patients</h3></div>
        ${highRisk.length ? highRisk.map(p => `
          <div class="list-row">
            <div style="display:flex;align-items:center;gap:10px;">
              <div class="avatar">${initials(p.name)}</div>
              <div>
                <div style="font-weight:700;font-size:13.5px;">${p.name}</div>
                <div class="mini-note">${p.category} &middot; ${p.age}y &middot; ${p.village||''}</div>
              </div>
            </div>
            <button class="btn btn-ghost btn-small" onclick="openAshaPatient(${p.id})">View →</button>
          </div>`).join('') : `<div class="empty-state">No high-risk patients currently flagged.</div>`}
      </div>
    </div>`;
}

async function renderAshaPatients(content, ashaId) {
  const patients = await api(`/patients?asha_id=${ashaId}`);
  content.innerHTML = `
    <div class="section-title">
      <h3>My Patients</h3>
      <button class="btn btn-primary btn-small" onclick="openAddPatientModal(${ashaId})">+ Register new patient</button>
    </div>
    <div class="card">
      <div class="field" style="max-width:280px;margin-bottom:14px;">
        <input type="text" id="patientSearch" placeholder="Search patient by name…" oninput="filterAshaPatients()" />
      </div>
      <table id="patientTable">
        <tr><th>Patient</th><th>Age/Gender</th><th>Category</th><th>Village</th><th>Risk</th><th></th></tr>
        ${patients.map(p => `
          <tr class="patient-row" data-name="${p.name.toLowerCase()}">
            <td><div style="display:flex;align-items:center;gap:8px;"><div class="avatar">${initials(p.name)}</div>${p.name}</div></td>
            <td>${p.age||'—'} / ${p.gender||'—'}</td>
            <td>${badge(p.category, 'blue')}</td>
            <td>${p.village||'—'}</td>
            <td>${p.high_risk ? badge('High-risk','red') : badge('Stable','green')}</td>
            <td><button class="btn btn-ghost btn-small" onclick="openAshaPatient(${p.id})">Open profile →</button></td>
          </tr>`).join('')}
      </table>
      ${!patients.length ? `<div class="empty-state">No patients registered yet.</div>` : ''}
    </div>`;
}

function filterAshaPatients() {
  const term = document.getElementById('patientSearch').value.toLowerCase();
  document.querySelectorAll('.patient-row').forEach(row => {
    row.style.display = row.dataset.name.includes(term) ? '' : 'none';
  });
}

function openAshaPatient(id) { state.drillPatientId = id; renderApp(); }

function openAddPatientModal(ashaId) {
  document.body.insertAdjacentHTML('beforeend', `
  <div class="modal-backdrop" id="modalBackdrop">
    <div class="modal">
      <button class="modal-close" onclick="closeModal()">&times;</button>
      <h3>Register new patient</h3>
      <div class="field"><label>Full name</label><input id="npName" type="text" /></div>
      <div class="grid grid-2">
        <div class="field"><label>Age</label><input id="npAge" type="number" /></div>
        <div class="field"><label>Gender</label>
          <select id="npGender"><option>Female</option><option>Male</option><option>Other</option></select>
        </div>
      </div>
      <div class="field"><label>Category</label>
        <select id="npCategory"><option>General</option><option>Maternal</option><option>Child</option><option>Chronic</option></select>
      </div>
      <div class="field"><label>Village</label><input id="npVillage" type="text" /></div>
      <div class="field"><label>Phone</label><input id="npPhone" type="text" /></div>
      <div class="field">
        <label><input type="checkbox" id="npHighRisk" style="width:auto;margin-right:6px;" />Flag as high-risk</label>
      </div>
      <button class="btn btn-primary" onclick="submitAddPatient(${ashaId})">Register patient</button>
    </div>
  </div>`);
}

async function submitAddPatient(ashaId) {
  const name = document.getElementById('npName').value.trim();
  if (!name) { toast('Name is required'); return; }
  const payload = {
    name,
    age: Number(document.getElementById('npAge').value) || null,
    gender: document.getElementById('npGender').value,
    category: document.getElementById('npCategory').value,
    village: document.getElementById('npVillage').value,
    phone: document.getElementById('npPhone').value,
    high_risk: document.getElementById('npHighRisk').checked,
    asha_id: ashaId,
  };
  try {
    await api('/patients', { method: 'POST', body: JSON.stringify(payload) });
    closeModal();
    toast('Patient registered.');
    renderTabContent();
  } catch (e) { toast('Failed: ' + e.message); }
}

async function renderAshaPatientProfile(content, patientId) {
  const [patient, records, instr, followups, referrals, facilities] = await Promise.all([
    api(`/patients/${patientId}`),
    api(`/health-records?patient_id=${patientId}`),
    api(`/instructions?patient_id=${patientId}`),
    api(`/follow-ups?patient_id=${patientId}`),
    api(`/referrals?patient_id=${patientId}`),
    api(`/facilities`),
  ]);
  content.innerHTML = `
    <button class="btn btn-ghost btn-small" style="margin-bottom:10px;padding-left:0;" onclick="state.drillPatientId=null;renderApp();">&larr; Back to My Patients</button>
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:14px;">
        <div class="avatar" style="width:52px;height:52px;font-size:18px;">${initials(patient.name)}</div>
        <div>
          <h3 style="font-size:18px;margin:0;">${patient.name} ${patient.high_risk ? badge('High-risk','red') : ''}</h3>
          <div class="mini-note">${patient.age}y &middot; ${patient.gender} &middot; ${badge(patient.category,'blue')} &middot; ${patient.village||'—'}</div>
        </div>
      </div>
    </div>

    <div class="grid grid-2" style="align-items:start;">
      <div>
        <div class="card" style="margin-bottom:16px;">
          <div class="section-title"><h3>Digital Health Records</h3></div>
          ${records.length ? records.map(r => `
            <div class="list-row" style="align-items:flex-start;">
              <div><div style="font-weight:700;font-size:13px;">${r.title}</div><div class="mini-note">${r.details||''} &middot; ${fmtDate(r.created_at)}</div></div>
            </div>`).join('') : `<div class="empty-state">No records yet.</div>`}
        </div>
        <div class="card">
          <div class="section-title"><h3>Doctor / PHC Instructions</h3></div>
          ${instr.length ? instr.map(i => `
            <div class="list-row" style="align-items:flex-start;">
              <div><div style="font-weight:700;font-size:13px;">${i.doctor_name||'Doctor'}</div>
              <div class="mini-note">${i.instruction_text}</div>
              ${i.medication_info ? `<div class="mini-note"><b>Medication:</b> ${i.medication_info}</div>` : ''}</div>
            </div>`).join('') : `<div class="empty-state">No instructions recorded.</div>`}
        </div>
      </div>

      <div>
        <div class="card" style="margin-bottom:16px;">
          <div class="section-title"><h3>Follow-Up Tracking</h3>
            <button class="btn btn-outline btn-small" onclick="openAddFollowupModal(${patient.id}, ${state.user.id})">+ Add</button>
          </div>
          ${followups.length ? followups.map(f => `
            <div class="list-row">
              <div><div style="font-weight:700;font-size:13px;">${f.type} follow-up</div><div class="mini-note">Due ${fmtDate(f.due_date)} &middot; ${f.notes||''}</div></div>
              ${f.status === 'Due' ? `<button class="btn btn-outline btn-small" onclick="completeFollowup(${f.id})">Mark done</button>` : statusBadge(f.status)}
            </div>`).join('') : `<div class="empty-state">No follow-ups scheduled.</div>`}
        </div>

        <div class="card" style="margin-bottom:16px;">
          <div class="section-title"><h3>Referral Tracking</h3>
            <button class="btn btn-outline btn-small" onclick="openCreateReferralModal(${patient.id}, ${facilities.map(f=>f.id)[0]})">+ Refer</button>
          </div>
          ${referrals.length ? referrals.map(r => `
            <div class="list-row">
              <div><div style="font-weight:700;font-size:13px;">${r.from_name||'—'} → ${r.to_name}</div><div class="mini-note">${r.reason||''}</div></div>
              ${statusBadge(r.status)}
            </div>`).join('') : `<div class="empty-state">No referrals for this patient.</div>`}
        </div>

        <div class="card">
          <div class="section-title"><h3>Appointment Assistance</h3></div>
          <p class="mini-note" style="margin-bottom:10px;">Assist this patient in booking a PHC/CHC/Hospital appointment.</p>
          <select class="field" id="ashaFacilitySelect" style="width:100%;padding:10px;border:1.5px solid var(--line);border-radius:8px;margin-bottom:10px;">
            ${facilities.map(f => `<option value="${f.id}">${f.name} (${f.type}) — ${f.predicted_wait}m wait</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-small" style="width:100%;" onclick="ashaBookAppointment(${patient.id})">Book appointment for patient</button>
        </div>
      </div>
    </div>`;
}

async function ashaBookAppointment(patientId) {
  const facilityId = Number(document.getElementById('ashaFacilitySelect').value);
  try {
    const appt = await api('/appointments', { method: 'POST', body: JSON.stringify({
      patient_id: patientId, facility_id: facilityId, reason: 'ASHA-assisted appointment', mode: 'In-person', triage_priority: 'Routine',
    })});
    toast(`Appointment booked. Token ${appt.token}.`);
    renderTabContent();
  } catch (e) { toast('Failed: ' + e.message); }
}

function openAddFollowupModal(patientId, ashaId) {
  document.body.insertAdjacentHTML('beforeend', `
  <div class="modal-backdrop" id="modalBackdrop">
    <div class="modal">
      <button class="modal-close" onclick="closeModal()">&times;</button>
      <h3>Schedule follow-up</h3>
      <div class="field"><label>Type</label>
        <select id="fuType"><option>General</option><option>Maternal</option><option>Child</option><option>Chronic</option><option>High-Risk</option></select>
      </div>
      <div class="field"><label>Due date</label><input id="fuDate" type="date" /></div>
      <div class="field"><label>Notes</label><textarea id="fuNotes"></textarea></div>
      <button class="btn btn-primary" onclick="submitFollowup(${patientId}, ${ashaId})">Save follow-up</button>
    </div>
  </div>`);
}

async function submitFollowup(patientId, ashaId) {
  const due_date = document.getElementById('fuDate').value;
  if (!due_date) { toast('Pick a due date'); return; }
  try {
    await api('/follow-ups', { method: 'POST', body: JSON.stringify({
      patient_id: patientId, asha_id: ashaId, type: document.getElementById('fuType').value,
      due_date, notes: document.getElementById('fuNotes').value,
    })});
    closeModal(); toast('Follow-up scheduled.'); renderTabContent();
  } catch (e) { toast('Failed: ' + e.message); }
}

async function completeFollowup(id) {
  try { await api(`/follow-ups/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'Completed' }) }); toast('Follow-up marked complete.'); renderTabContent(); }
  catch (e) { toast('Failed: ' + e.message); }
}

function openCreateReferralModal(patientId, defaultToId) {
  api('/facilities').then(facilities => {
    document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal">
        <button class="modal-close" onclick="closeModal()">&times;</button>
        <h3>Create referral</h3>
        <div class="field"><label>Refer to</label>
          <select id="refTo">${facilities.map(f => `<option value="${f.id}">${f.name} (${f.type})</option>`).join('')}</select>
        </div>
        <div class="field"><label>Reason</label><textarea id="refReason"></textarea></div>
        <button class="btn btn-primary" onclick="submitReferral(${patientId})">Create referral</button>
      </div>
    </div>`);
  });
}

async function submitReferral(patientId) {
  const to_facility_id = Number(document.getElementById('refTo').value);
  const reason = document.getElementById('refReason').value;
  try {
    await api('/referrals', { method: 'POST', body: JSON.stringify({ patient_id: patientId, to_facility_id, reason }) });
    closeModal(); toast('Referral created and tracking started.'); renderTabContent();
  } catch (e) { toast('Failed: ' + e.message); }
}

async function renderAshaFollowups(content, ashaId) {
  const followups = await api(`/follow-ups?asha_id=${ashaId}`);
  const groups = ['Due', 'Completed', 'Missed'];
  content.innerHTML = `
    <div class="section-title"><h3>Follow-Up Management</h3></div>
    <div class="tabs">${groups.map((g,i) => `<button class="tab-btn ${i===0?'active':''}" data-g="${g}" onclick="switchFuGroup('${g}')">${g}</button>`).join('')}</div>
    <div id="fuGroupContent"></div>`;
  window.__fuData = followups;
  renderFuGroup('Due');
}
function switchFuGroup(g) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.g === g));
  renderFuGroup(g);
}
function renderFuGroup(g) {
  const rows = window.__fuData.filter(f => f.status === g);
  const wrap = document.getElementById('fuGroupContent');
  wrap.innerHTML = `<div class="card">
    ${rows.length ? `<table><tr><th>Patient</th><th>Type</th><th>Due</th><th>Notes</th><th></th></tr>
      ${rows.map(f => `<tr>
        <td>${f.patient_name}</td><td>${badge(f.type,'blue')}</td><td>${fmtDate(f.due_date)}</td><td>${f.notes||''}</td>
        <td>${f.status === 'Due' ? `<button class="btn btn-outline btn-small" onclick="completeFollowup(${f.id})">Mark done</button>` : ''}</td>
      </tr>`).join('')}
    </table>` : `<div class="empty-state">No ${g.toLowerCase()} follow-ups.</div>`}
  </div>`;
}

async function renderAshaReferrals(content, ashaId) {
  const patients = await api(`/patients?asha_id=${ashaId}`);
  const patientIds = new Set(patients.map(p => p.id));
  const allRefs = await api('/referrals');
  const refs = allRefs.filter(r => patientIds.has(r.patient_id));
  content.innerHTML = `
    <div class="section-title"><h3>Referral Network — Seamless care continuum</h3></div>
    <div class="card" style="margin-bottom:16px;">
      <div class="pill-flow" style="justify-content:center;">
        <span class="pill done">PHC (Primary)</span><span class="pill-arrow">→</span>
        <span class="pill current">CHC (Secondary)</span><span class="pill-arrow">→</span>
        <span class="pill">Hospital (Tertiary)</span>
      </div>
      <p class="mini-note" style="text-align:center;margin-top:10px;">Every referral is tracked until care is completed.</p>
    </div>
    ${refs.length ? refs.map(r => `
      <div class="card" style="margin-bottom:12px;">
        <div class="section-title" style="margin-bottom:10px;"><h3>${r.patient_name}: ${r.from_name||'—'} → ${r.to_name}</h3>${statusBadge(r.status)}</div>
        <p class="mini-note">${r.reason||''}</p>
        <div style="display:flex;gap:8px;margin-top:10px;">
          ${['Created','Accepted','In Progress','Completed'].map(s => `<button class="btn btn-outline btn-small" ${r.status===s?'disabled':''} onclick="updateReferralStatus(${r.id}, '${s}')">${s}</button>`).join('')}
        </div>
      </div>`).join('') : `<div class="card"><div class="empty-state">No referrals for your patients.</div></div>`}`;
}

async function updateReferralStatus(id, status) {
  try { await api(`/referrals/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); toast('Referral status updated: ' + status); renderTabContent(); }
  catch (e) { toast('Failed: ' + e.message); }
}

async function renderAshaSupplies(content) {
  const facilities = await api('/facilities');
  content.innerHTML = `
    <div class="section-title"><h3>Medicine &amp; Diagnostic Availability</h3><span class="mini-note">Know what's available before patients travel</span></div>
    <div class="field" style="max-width:320px;margin-bottom:14px;">
      <select id="ashaFacPicker" onchange="loadAshaSupplies()">
        ${facilities.map(f => `<option value="${f.id}">${f.name} (${f.type})</option>`).join('')}
      </select>
    </div>
    <div class="grid grid-2" id="suppliesGrid"></div>`;
  window.__firstFacility = facilities[0].id;
  loadAshaSupplies();
}
async function loadAshaSupplies() {
  const fid = document.getElementById('ashaFacPicker')?.value || window.__firstFacility;
  const [meds, diags] = await Promise.all([api(`/medicines?facility_id=${fid}`), api(`/diagnostics?facility_id=${fid}`)]);
  document.getElementById('suppliesGrid').innerHTML = `
    <div class="card"><h3>Medicine Availability</h3>
      <table><tr><th>Medicine</th><th>Status</th></tr>${meds.map(m=>`<tr><td>${m.name}</td><td>${statusBadge(m.status)}</td></tr>`).join('')}</table>
    </div>
    <div class="card"><h3>Diagnostics</h3>
      <table><tr><th>Test</th><th>Status</th></tr>${diags.map(d=>`<tr><td>${d.name}</td><td>${statusBadge(d.status)}</td></tr>`).join('')}</table>
    </div>`;
}

// =========================================================
// FACILITY (PHC / CHC / HOSPITAL) DASHBOARD
// =========================================================

async function renderFacilityTab(content, tab) {
  const facility = state.facility;
  if (!facility) { content.innerHTML = `<div class="empty-state">No facility linked to this account.</div>`; return; }
  const fresh = await api(`/facilities/${facility.id}`);
  state.facility = fresh;
  if (tab === 'overview') return renderFacilityOverview(content, fresh);
  if (tab === 'opd') return renderFacilityOPD(content, fresh);
  if (tab === 'diagnostics') return renderFacilityDiagnostics(content, fresh);
  if (tab === 'medicine') return renderFacilityMedicine(content, fresh);
  if (tab === 'emergency') return renderFacilityEmergency(content, fresh);
  if (tab === 'referral') return renderFacilityReferral(content, fresh);
  if (tab === 'followup') return renderFacilityFollowup(content, fresh);
  if (tab === 'ai') return renderFacilityAI(content, fresh);
}

async function renderFacilityOverview(content, f) {
  const appts = await api(`/appointments?facility_id=${f.id}`);
  const referrals = await api(`/referrals?facility_id=${f.id}`);
  const waiting = appts.filter(a => a.status === 'Waiting').length;
  const emergency = appts.filter(a => a.triage_priority === 'Emergency' && a.status !== 'Completed').length;
  const pendingRefs = referrals.filter(r => r.status !== 'Completed').length;

  content.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:18px;">
      <div class="card stat-card"><div class="num">${appts.length}</div><div class="lbl">OPD patients today</div></div>
      <div class="card stat-card"><div class="num">${f.queue_waiting}</div><div class="lbl">Queue waiting</div></div>
      <div class="card stat-card"><div class="num">${f.doctors_available}/${f.doctors_total}</div><div class="lbl">Doctors available</div></div>
      <div class="card stat-card"><div class="num">${emergency}</div><div class="lbl">Emergency / priority cases</div></div>
    </div>
    <div class="grid grid-2" style="align-items:start;">
      <div class="card">
        <div class="section-title"><h3>Department status</h3></div>
        <div class="list-row"><span>OPD</span>${statusBadge(f.opd_status)}</div>
        <div class="list-row"><span>Crowd</span>${statusBadge(f.crowd_status)}</div>
        <div class="list-row"><span>Pending referrals</span>${badge(pendingRefs, 'amber')}</div>
        <div class="divider"></div>
        <div class="field"><label>Update doctors available</label>
          <input type="number" id="docAvail" value="${f.doctors_available}" min="0" max="${f.doctors_total}" />
        </div>
        <button class="btn btn-outline btn-small" onclick="updateDoctorsAvailable(${f.id})">Save</button>
      </div>
      <div class="card">
        <div class="section-title"><h3>Live queue snapshot</h3></div>
        ${appts.filter(a=>a.status==='Waiting').slice(0,6).map(a => `
          <div class="list-row"><div><b>${a.token}</b> — ${a.patient_name}</div>${statusBadge(a.triage_priority==='Emergency'?'High':a.triage_priority==='Priority'?'Medium':'Normal')}</div>
        `).join('') || `<div class="empty-state">No patients currently waiting.</div>`}
      </div>
    </div>`;
}

async function updateDoctorsAvailable(facilityId) {
  const val = Number(document.getElementById('docAvail').value);
  try { await api(`/facilities/${facilityId}`, { method: 'PATCH', body: JSON.stringify({ doctors_available: val }) }); toast('Updated doctor availability.'); renderTabContent(); }
  catch (e) { toast('Failed: ' + e.message); }
}

async function renderFacilityOPD(content, f) {
  const appts = await api(`/appointments?facility_id=${f.id}`);
  content.innerHTML = `
    <div class="section-title"><h3>OPD Module — Appointments, Token &amp; Queue</h3></div>
    <div class="card">
      ${appts.length ? `<table>
        <tr><th>Token</th><th>Patient</th><th>Reason</th><th>Mode</th><th>Priority</th><th>Status</th><th></th></tr>
        ${appts.map(a => `
          <tr>
            <td><b>${a.token}</b></td><td>${a.patient_name}</td><td>${a.reason}</td><td>${a.mode}</td>
            <td>${statusBadge(a.triage_priority === 'Emergency' ? 'High' : a.triage_priority === 'Priority' ? 'Medium' : 'Normal')} ${a.triage_priority}</td>
            <td>${statusBadge(a.status)}</td>
            <td>
              ${a.status === 'Waiting' ? `<button class="btn btn-outline btn-small" onclick="setApptStatus(${a.id},'In Consultation')">Start</button>` : ''}
              ${a.status === 'In Consultation' ? `<button class="btn btn-outline btn-small" onclick="setApptStatus(${a.id},'Completed')">Complete</button>` : ''}
            </td>
          </tr>`).join('')}
      </table>` : `<div class="empty-state">No appointments yet today.</div>`}
    </div>`;
}
async function setApptStatus(id, status) {
  try { await api(`/appointments/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); toast('Status updated: ' + status); renderTabContent(); }
  catch (e) { toast('Failed: ' + e.message); }
}

async function renderFacilityDiagnostics(content, f) {
  const diags = await api(`/diagnostics?facility_id=${f.id}`);
  content.innerHTML = `
    <div class="section-title"><h3>Diagnostics Coordination</h3></div>
    <div class="card">
      <table><tr><th>Test</th><th>Status</th><th>Update</th></tr>
        ${diags.map(d => `<tr><td>${d.name}</td><td>${statusBadge(d.status)}</td>
          <td><select onchange="updateDiagStatus(${d.id}, this.value)">
            ${['Available','Busy','Unavailable'].map(s => `<option value="${s}" ${s===d.status?'selected':''}>${s}</option>`).join('')}
          </select></td></tr>`).join('')}
      </table>
    </div>`;
}
async function updateDiagStatus(id, status) {
  try { await api(`/diagnostics/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); toast('Diagnostic status updated.'); }
  catch (e) { toast('Failed: ' + e.message); }
}

async function renderFacilityMedicine(content, f) {
  const meds = await api(`/medicines?facility_id=${f.id}`);
  content.innerHTML = `
    <div class="section-title"><h3>Medicine / Pharmacy Module</h3></div>
    <div class="card">
      <table><tr><th>Medicine</th><th>Status</th><th>Update</th></tr>
        ${meds.map(m => `<tr><td>${m.name}</td><td>${statusBadge(m.status)}</td>
          <td><select onchange="updateMedStatus(${m.id}, this.value)">
            ${['Available','Low Stock','Unavailable'].map(s => `<option value="${s}" ${s===m.status?'selected':''}>${s}</option>`).join('')}
          </select></td></tr>`).join('')}
      </table>
    </div>`;
}
async function updateMedStatus(id, status) {
  try { await api(`/medicines/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); toast('Medicine status updated.'); }
  catch (e) { toast('Failed: ' + e.message); }
}

async function renderFacilityEmergency(content, f) {
  const [appts, sosRequests] = await Promise.all([api(`/appointments?facility_id=${f.id}`), api(`/sos?facility_id=${f.id}`)]);
  const emergencies = appts.filter(a => a.triage_priority === 'Emergency');
  content.innerHTML = `
    <div class="section-title"><h3>Emergency Monitoring &amp; Escalation</h3><span class="mini-note">SOS is delivered only to verified participating facilities</span></div>
    <div class="card" style="margin-bottom:18px;"><h3>Incoming CareNexus SOS requests</h3>
      ${sosRequests.filter(r => ['Pending','Accepted'].includes(r.recipient_status)).length ? sosRequests.filter(r => ['Pending','Accepted'].includes(r.recipient_status)).map(r => `
        <div class="list-row"><div><b>SOS #${r.id} · ${r.patient_name}</b><div class="mini-note">${r.emergency_type} · ${r.location_text || 'GPS coordinates available'} · ${Number(r.distance_km).toFixed(1)} km</div><div class="mini-note">${r.description || 'No additional description'} · Patient phone: ${r.patient_phone || 'Not listed'}</div><span class="badge">${r.status}</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">${r.recipient_status === 'Pending' && r.status === 'Searching' ? `<button class="btn btn-primary btn-small" onclick="acceptSOS(${r.id},${f.id})">Accept request</button>` : ''}${r.recipient_status === 'Accepted' ? `<button class="btn btn-outline btn-small" onclick="recordSOSContact(${r.id},${f.id},'Reached patient')">Reached patient</button><button class="btn btn-outline btn-small" onclick="recordSOSContact(${r.id},${f.id},'No answer')">No answer</button><button class="btn btn-outline btn-small" onclick="recordSOSContact(${r.id},${f.id},'Needs further coordination')">Needs coordination</button>` : ''}</div></div>`).join('') : '<div class="empty-state">No eligible incoming SOS requests. Only verified/active facilities receive SOS requests.</div>'}
    </div>
    <div class="card"><h3>Emergency-priority appointments</h3>
      ${emergencies.length ? emergencies.map(a => `<div class="list-row"><div><b>${a.patient_name}</b><div class="mini-note">${a.reason} · Token ${a.token}</div></div><div style="display:flex;gap:8px;align-items:center;">${statusBadge(a.status)}${a.status !== 'Completed' ? `<button class="btn btn-primary btn-small" onclick="setApptStatus(${a.id},'In Consultation')">Escalate to doctor</button>` : ''}</div></div>`).join('') : '<div class="empty-state">No emergency-priority appointments currently.</div>'}
    </div>`;
}
async function acceptSOS(id, facilityId) { try { await api(`/sos/${id}/accept`, { method:'POST', body:JSON.stringify({facility_id:facilityId}) }); toast('SOS accepted. Contact the patient immediately.'); renderApp(); } catch(e) { toast(e.message); renderApp(); } }
async function recordSOSContact(id, facilityId, outcome) { try { await api(`/sos/${id}/contact`, { method:'PATCH', body:JSON.stringify({facility_id:facilityId,contact_outcome:outcome}) }); toast('Contact outcome saved.'); renderApp(); } catch(e) { toast(e.message); } }

async function renderFacilityReferral(content, f) {
  const refs = await api(`/referrals?facility_id=${f.id}`);
  const incoming = refs.filter(r => r.to_facility_id === f.id);
  const outgoing = refs.filter(r => r.from_facility_id === f.id);
  content.innerHTML = `
    <div class="section-title"><h3>Referral Module</h3></div>
    <div class="grid grid-2" style="align-items:start;">
      <div class="card">
        <h3>Incoming referrals</h3>
        ${incoming.length ? incoming.map(r => `
          <div class="list-row"><div><b>${r.patient_name}</b><div class="mini-note">from ${r.from_name||'—'}</div></div>
          <div style="display:flex;gap:6px;">
            ${['Accepted','In Progress','Completed'].map(s => `<button class="btn btn-outline btn-small" ${r.status===s?'disabled':''} onclick="updateReferralStatus(${r.id}, '${s}')">${s}</button>`).join('')}
          </div></div>`).join('') : `<div class="empty-state">No incoming referrals.</div>`}
      </div>
      <div class="card">
        <h3>Outgoing referrals</h3>
        ${outgoing.length ? outgoing.map(r => `
          <div class="list-row"><div><b>${r.patient_name}</b><div class="mini-note">to ${r.to_name}</div></div>${statusBadge(r.status)}</div>`).join('') : `<div class="empty-state">No outgoing referrals.</div>`}
      </div>
    </div>`;
}

async function renderFacilityFollowup(content, f) {
  const followups = await api('/follow-ups');
  content.innerHTML = `
    <div class="section-title"><h3>Follow-up Monitoring</h3><span class="mini-note">System-wide visibility, coordinated with ASHA workers</span></div>
    <div class="card">
      <table><tr><th>Patient</th><th>Type</th><th>Due</th><th>Status</th></tr>
        ${followups.map(fu => `<tr><td>${fu.patient_name}</td><td>${badge(fu.type,'blue')}</td><td>${fmtDate(fu.due_date)}</td><td>${statusBadge(fu.status)}</td></tr>`).join('')}
      </table>
    </div>`;
}

async function renderFacilityAI(content, f) {
  const insights = await api(`/ai/insights/${f.id}`);
  content.innerHTML = `
    <div class="section-title"><h3>AI-Powered Operational Insights</h3></div>
    <div class="grid grid-2">
      <div class="ai-box">
        <h3>Waiting-time prediction</h3>
        <div class="ai-metric">${insights.predicted_wait_minutes} min</div>
        <div class="ai-lbl">Based on queue size, doctors available &amp; avg. consultation time</div>
        <p class="rec">${insights.recommendation}</p>
        <p class="disclaimer">${insights.disclaimer}</p>
      </div>
      <div class="ai-box">
        <h3>Crowd forecast</h3>
        <div class="ai-metric">${insights.crowd_forecast.expectedLevel}</div>
        <div class="ai-lbl">Expected during ${insights.crowd_forecast.window}</div>
        <p class="rec">Pending referrals in: ${insights.pending_referrals_in} · System-wide follow-ups due: ${insights.system_wide_due_follow_ups}</p>
      </div>
    </div>`;
}

// =========================================================
// ADMIN DASHBOARD
// =========================================================

async function renderAdminTab(content, tab) {
  if (tab === 'overview') return renderAdminOverview(content);
  if (tab === 'facilities') return renderAdminFacilities(content);
  if (tab === 'referrals') return renderAdminReferrals(content);
  if (tab === 'followups') return renderAdminFollowups(content);
  if (tab === 'quality') return renderAdminQuality(content);
  if (tab === 'emergencypartners') return renderAdminEmergencyPartners(content);
}

async function renderAdminEmergencyPartners(content) {
  const rows = await api('/admin/emergency-participants');
  content.innerHTML = `<div class="section-title"><h3>Verified Emergency Partners</h3><span class="mini-note">Public map listings are never auto-approved</span></div>
  <div class="ai-box" style="margin-bottom:16px;"><p class="disclaimer">Only activate a facility after offline verification of its identity, consent, emergency contact and coordinates. This demo uses administrative attestation, not independent verification. Do not enable real emergency dispatch without production security, audit logs and a staffed response process.</p></div>
  <div class="grid grid-2">${rows.map(f => `<div class="card"><h3>${f.name}</h3><div class="mini-note">${f.type} · ${f.area || 'Area not listed'}</div><div class="mini-note" style="margin:8px 0;">Current: ${f.verified ? 'Verified' : 'Not verified'} · ${f.active ? 'Active' : 'Inactive'}</div>
    <div class="field"><label>Latitude</label><input id="epLat${f.facility_id}" type="number" step="any" value="${f.latitude ?? ''}" placeholder="e.g. 16.7050" /></div>
    <div class="field"><label>Longitude</label><input id="epLon${f.facility_id}" type="number" step="any" value="${f.longitude ?? ''}" placeholder="e.g. 74.2433" /></div>
    <div class="field"><label>Emergency contact phone</label><input id="epPhone${f.facility_id}" value="${f.contact_phone || ''}" placeholder="Verified facility contact" /></div>
    <div class="field"><label>Verified by / notes</label><input id="epBy${f.facility_id}" value="${f.verified_by || state.user.name}" /></div>
    <label style="display:block;margin:8px 0;"><input type="checkbox" id="epVerified${f.facility_id}" ${f.verified ? 'checked' : ''}/> Offline verification completed</label>
    <label style="display:block;margin:8px 0 14px;"><input type="checkbox" id="epActive${f.facility_id}" ${f.active ? 'checked' : ''}/> Eligible to receive SOS requests</label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-small" onclick="saveEmergencyPartner(${f.facility_id})">Save partner status</button><button class="btn btn-outline btn-small" onclick="researchEmergencyPartner(${f.facility_id})">Research with Browser Use</button></div><div id="epResearch${f.facility_id}" class="mini-note" style="margin-top:10px;"></div></div>`).join('')}</div>`;
}
async function researchEmergencyPartner(id) {
  const out = document.getElementById(`epResearch${id}`); out.textContent = 'Starting public-source research…';
  try {
    const started = await api('/admin/verification/research', { method:'POST', body:JSON.stringify({facility_id:id}) });
    if (!started.run_id) { out.textContent = started.message || 'Task submitted but no run ID was returned.'; return; }
    out.textContent = `Browser Use run: ${started.run_id}. Checking result…`;
    let finalData = null;
    for (let i=0;i<8;i++) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const result = await api(`/admin/verification/research/${encodeURIComponent(started.run_id)}`);
      finalData = result;
      const status = String(result.status || result.state || '').toLowerCase();
      if (result.result || result.output || ['completed','succeeded','finished','failed','error'].includes(status)) break;
    }
    const textResult = finalData && (finalData.result || finalData.output || finalData);
    out.innerHTML = `<div class="ai-box"><b>Browser Use research result</b><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:260px;overflow:auto;"></pre><p class="disclaimer">Research is not verification. Review source URLs and confirm directly with the facility before activating SOS participation.</p></div>`;
    out.querySelector('pre').textContent = typeof textResult === 'string' ? textResult : JSON.stringify(textResult, null, 2);
  } catch(e) { out.textContent = e.message; }
}
async function saveEmergencyPartner(id) {
  try {
    const data = { latitude: document.getElementById(`epLat${id}`).value, longitude: document.getElementById(`epLon${id}`).value, contact_phone: document.getElementById(`epPhone${id}`).value, verified_by: document.getElementById(`epBy${id}`).value, verified: document.getElementById(`epVerified${id}`).checked, active: document.getElementById(`epActive${id}`).checked };
    await api(`/admin/emergency-participants/${id}`, { method:'PUT', body:JSON.stringify(data) }); toast('Emergency partner registry saved.'); renderApp();
  } catch(e) { toast(e.message); }
}

async function renderAdminOverview(content) {
  const ov = await api('/admin/overview');
  content.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:18px;">
      <div class="card stat-card"><div class="num">${ov.total_facilities}</div><div class="lbl">Total facilities</div></div>
      <div class="card stat-card"><div class="num">${ov.total_patients}</div><div class="lbl">Registered patients</div></div>
      <div class="card stat-card"><div class="num">${ov.appointments_today}</div><div class="lbl">Appointments today</div></div>
      <div class="card stat-card"><div class="num">${ov.total_queue_waiting}</div><div class="lbl">Patients waiting network-wide</div></div>
    </div>
    <div class="grid grid-2" style="align-items:start;margin-bottom:18px;">
      <div class="card">
        <div class="section-title"><h3>Referral completion</h3></div>
        <div style="display:flex;gap:24px;">
          <div><div class="num" style="font-size:26px;font-family:var(--font-head);font-weight:800;">${ov.pending_referrals}</div><div class="mini-note">Pending</div></div>
          <div><div class="num" style="font-size:26px;font-family:var(--font-head);font-weight:800;">${ov.completed_referrals}</div><div class="mini-note">Completed</div></div>
        </div>
      </div>
      <div class="card">
        <div class="section-title"><h3>Follow-up completion</h3></div>
        <div style="display:flex;gap:24px;">
          <div><div class="num" style="font-size:26px;font-family:var(--font-head);font-weight:800;">${ov.due_follow_ups}</div><div class="mini-note">Due</div></div>
          <div><div class="num" style="font-size:26px;font-family:var(--font-head);font-weight:800;">${ov.completed_follow_ups}</div><div class="mini-note">Completed</div></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="section-title"><h3>High-crowd facilities</h3></div>
      ${ov.high_crowd_facilities.length ? ov.high_crowd_facilities.map(f => `<div class="list-row"><span>${f.name}</span>${badge(f.type,'blue')}</div>`).join('') : `<div class="empty-state">No facilities under high crowd right now.</div>`}
    </div>`;
}

async function renderAdminFacilities(content) {
  const ov = await api('/admin/overview');
  content.innerHTML = `
    <div class="section-title"><h3>Facility Monitoring</h3></div>
    <div class="card">
      <table>
        <tr><th>Facility</th><th>Type</th><th>Area</th><th>Doctors</th><th>Queue</th><th>OPD</th><th>Crowd</th><th>AI wait</th></tr>
        ${ov.facilities.map(f => `<tr>
          <td>${f.name}</td><td>${badge(f.type,'blue')}</td><td>${f.area}</td>
          <td>${f.doctors_available}/${f.doctors_total}</td><td>${f.queue_waiting}</td>
          <td>${statusBadge(f.opd_status)}</td><td>${statusBadge(f.crowd_status)}</td><td>${f.predicted_wait} min</td>
        </tr>`).join('')}
      </table>
    </div>
    <div class="section-title" style="margin-top:20px;"><h3>Medicine availability alerts</h3></div>
    <div class="card">
      ${ov.medicine_alerts.length ? `<table><tr><th>Medicine</th><th>Facility</th><th>Status</th></tr>
        ${ov.medicine_alerts.map(m => `<tr><td>${m.name}</td><td>${m.facility_name}</td><td>${statusBadge(m.status)}</td></tr>`).join('')}
      </table>` : `<div class="empty-state">No medicine shortages reported.</div>`}
    </div>`;
}

async function renderAdminReferrals(content) {
  const refs = await api('/referrals');
  content.innerHTML = `
    <div class="section-title"><h3>Referral Monitoring — Network-wide</h3></div>
    <div class="card">
      <table><tr><th>Patient</th><th>From</th><th>To</th><th>Reason</th><th>Status</th><th>Updated</th></tr>
        ${refs.map(r => `<tr><td>${r.patient_name}</td><td>${r.from_name||'—'}</td><td>${r.to_name}</td><td>${r.reason||''}</td><td>${statusBadge(r.status)}</td><td>${fmtDateTime(r.updated_at)}</td></tr>`).join('')}
      </table>
      ${!refs.length ? `<div class="empty-state">No referrals recorded.</div>` : ''}
    </div>`;
}

async function renderAdminFollowups(content) {
  const followups = await api('/follow-ups');
  const summary = { Due: 0, Completed: 0, Missed: 0 };
  followups.forEach(f => summary[f.status] = (summary[f.status]||0) + 1);
  content.innerHTML = `
    <div class="section-title"><h3>Follow-up Monitoring — Maternal / Child / Chronic / High-Risk</h3></div>
    <div class="grid grid-3" style="margin-bottom:16px;">
      <div class="card stat-card"><div class="num">${summary.Due||0}</div><div class="lbl">Due</div></div>
      <div class="card stat-card"><div class="num">${summary.Completed||0}</div><div class="lbl">Completed</div></div>
      <div class="card stat-card"><div class="num">${summary.Missed||0}</div><div class="lbl">Missed</div></div>
    </div>
    <div class="card">
      <table><tr><th>Patient</th><th>Category</th><th>Type</th><th>Due</th><th>Status</th></tr>
        ${followups.map(f => `<tr><td>${f.patient_name}</td><td>${badge(f.patient_category,'grey')}</td><td>${badge(f.type,'blue')}</td><td>${fmtDate(f.due_date)}</td><td>${statusBadge(f.status)}</td></tr>`).join('')}
      </table>
    </div>`;
}

async function renderAdminQuality(content) {
  const ov = await api('/admin/overview');
  const busiest = [...ov.facilities].sort((a,b) => b.predicted_wait - a.predicted_wait)[0];
  content.innerHTML = `
    <div class="section-title"><h3>Quality &amp; AI Operational Insights</h3></div>
    <div class="grid grid-2">
      <div class="ai-box">
        <h3>Network wait-time leader</h3>
        <div class="ai-metric">${busiest ? busiest.predicted_wait + ' min' : '—'}</div>
        <div class="ai-lbl">${busiest ? busiest.name : ''} currently has the longest predicted wait</div>
        <p class="rec">${busiest && busiest.predicted_wait > 30 ? 'Recommend redirecting routine cases or deploying additional OPD staff.' : 'All facilities operating within normal wait-time range.'}</p>
        <p class="disclaimer">AI provides operational decision support only — it does not diagnose or prescribe.</p>
      </div>
      <div class="ai-box">
        <h3>Service quality snapshot</h3>
        <div class="ai-metric">${ov.completed_referrals}/${ov.completed_referrals + ov.pending_referrals}</div>
        <div class="ai-lbl">Referrals completed vs. total</div>
        <p class="rec">${ov.medicine_alerts.length} medicine availability alert(s) across the network.</p>
      </div>
    </div>
    <div class="section-title" style="margin-top:20px;"><h3>Facility load comparison</h3></div>
    <div class="card">
      <table><tr><th>Facility</th><th>Queue waiting</th><th>Predicted wait</th><th>Crowd</th></tr>
        ${ov.facilities.map(f => `<tr><td>${f.name}</td><td>${f.queue_waiting}</td><td>${f.predicted_wait} min</td><td>${statusBadge(f.crowd_status)}</td></tr>`).join('')}
      </table>
    </div>`;
}

// =========================================================
// VOICE AI ASSISTANT FRONTEND (Patient & ASHA Worker)
// =========================================================

const assistantState = {
  lang: 'en',
  messages: [],
  isListening: false,
  playingMsgId: null,
  currentAudio: null,
  rec: null,
  nextMsgId: 1
};

function cleanSpeechText(text) {
  if (!text) return '';
  return text
    .replace(/[*#_`~>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function initAssistantSession() {
  if (assistantState.messages.length > 0) return;

  const isMr = assistantState.lang === 'mr';
  const name = state.user?.name ? state.user.name.split(' ')[0] : 'there';

  assistantState.messages.push({
    id: assistantState.nextMsgId++,
    sender: 'assistant',
    text: isMr
      ? `नमस्कार ${name}! मी तुमचा केअरनेक्सस व्हॉइस असिस्टंट आहे. तुम्ही मला बोलून किंवा लिहून प्रश्न विचारू शकता.\n\nतुम्ही विचारू शकता:\n• "माझी पुढील भेट कधी आहे?"\n• "माझ्या आगामी भेटी दाखवा"\n• "माझ्या रेफरलची स्थिती काय आहे?"\n• "आरोग्य कर्मचाऱ्यांनी दिलेल्या सूचना सांगा"\n• "माझ्या औषधांची माहिती समजावून सांगा"\n• "माझे प्रलंबित फॉलो-अप दाखवा"\n• "जवळचे रुग्णालय शोधा"\n\n⚠️ सुरक्षा सूचना: मी तुमच्या नोंदवलेल्या आरोग्य सूचना समजावून सांगू शकतो, परंतु औषधे बदलू शकत नाही. आणीबाणीच्या प्रसंगी लगेच 112 वर कॉल करा.`
      : `Hello ${name}! I am your CareNexus Voice Assistant. You can speak or type in English or मराठी.\n\nFeel free to ask:\n• "When is my next appointment?"\n• "Show my upcoming appointments"\n• "What is the status of my referral?"\n• "Explain the instructions provided by my healthcare worker"\n• "Explain the medicine instructions recorded for me"\n• "Show my pending follow-ups"\n• "Help me find a nearby healthcare facility"\n\n⚠️ Safety Notice: I can navigate and explain your recorded care instructions, but I cannot diagnose illnesses or change medications. In an emergency, please call 112 immediately.`,
    actions: [
      { label: isMr ? '🎫 माझ्या भेटी व रांग' : '🎫 My Appointments & Queue', type: 'navigate', tab: 'queue' },
      { label: isMr ? '💊 सूचना व औषधे' : '💊 Instructions & Medicines', type: 'navigate', tab: 'care' },
      { label: isMr ? '📍 आरोग्य केंद्र शोधा' : '📍 Find Healthcare Facility', type: 'navigate', tab: 'findcare' }
    ],
    timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  });
}

async function renderAssistantTab(content, role) {
  if (role !== 'patient') {
    content.innerHTML = `<div class="empty-state">The Voice Assistant is only available for Patient accounts.</div>`;
    return;
  }

  if (state.user?.language === 'Marathi' && assistantState.messages.length === 0) {
    assistantState.lang = 'mr';
  }

  initAssistantSession();
  const isMr = assistantState.lang === 'mr';

  const chips = isMr ? [
    'माझी पुढील भेट कधी आहे?',
    'माझ्या आगामी भेटी दाखवा',
    'माझ्या रेफरलची स्थिती काय आहे?',
    'आरोग्य कर्मचाऱ्यांनी दिलेल्या सूचना सांगा',
    'माझ्या औषधांची माहिती सांगा',
    'माझे प्रलंबित फॉलो-अप दाखवा',
    'जवळचे रुग्णालय शोधा',
    'माझे आरोग्य रेकॉर्ड दाखवा'
  ] : [
    'When is my next appointment?',
    'Show my upcoming appointments',
    'What is the status of my referral?',
    'Explain the instructions provided by my healthcare worker',
    'Explain the medicine instructions recorded for me',
    'Show my pending follow-ups',
    'Help me find a nearby healthcare facility',
    'Show my health records'
  ];

  content.innerHTML = `
    <div class="assistant-card">
      <div class="assistant-header">
        <h3>
          <span>🎙️</span>
          <span>CareNexus Voice Assistant</span>
          <span class="badge badge-blue" style="margin-left:8px;font-size:11px;">
            ${isMr ? 'रुग्ण मोड' : 'Patient Mode'}
          </span>
        </h3>
        <div class="assistant-header-controls">
          <select id="assistantLangSelect" class="lang-select" onchange="changeAssistantLang(this.value)">
            <option value="en" ${assistantState.lang === 'en' ? 'selected' : ''}>English</option>
            <option value="mr" ${assistantState.lang === 'mr' ? 'selected' : ''}>मराठी (Marathi)</option>
          </select>
          <button class="btn btn-outline btn-small" onclick="clearAssistantChat()" style="color:white;border-color:rgba(255,255,255,0.3);background:transparent;" title="Clear conversation history">
            🗑️ ${isMr ? 'साफ करा' : 'Clear'}
          </button>
        </div>
      </div>

      <div class="assistant-chips-container">
        ${chips.map(c => `<button class="chip-btn" onclick="sendAssistantQuery('${c.replace(/'/g, "\\'")}')">${c}</button>`).join('')}
      </div>

      <div class="assistant-body" id="assistantMessages">
        ${renderAssistantMessagesHtml()}
      </div>

      <div class="assistant-status-indicator hidden" id="assistantStatusBar"></div>

      <div class="assistant-input-bar">
        <button id="micBtn" class="mic-btn" onclick="toggleAssistantMic()" title="Click to speak (English or मराठी)">
          🎙️
        </button>
        <div class="assistant-input-wrap">
          <input
            type="text"
            id="assistantInput"
            class="assistant-input"
            placeholder="${isMr ? 'मराठी किंवा इंग्रजीत विचारा, किंवा बोला...' : 'Ask in English or मराठी, or tap the microphone to speak...'}"
            autocomplete="off"
          />
        </div>
        <button id="sendBtn" class="btn btn-primary" style="width:auto;padding:10px 18px;" onclick="submitAssistantInput()">
          ${isMr ? 'पाठवा' : 'Send'} ➤
        </button>
      </div>
    </div>
  `;

  const inputEl = document.getElementById('assistantInput');
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submitAssistantInput();
    }
  });

  scrollAssistantToBottom();
}

function renderAssistantMessagesHtml() {
  const isMr = assistantState.lang === 'mr';
  return assistantState.messages.map(m => {
    const isUser = m.sender === 'user';
    return `
      <div class="chat-msg ${isUser ? 'user' : 'assistant'}" id="msg-${m.id}">
        <div class="chat-avatar ${isUser ? 'user' : 'assistant'}">
          ${isUser ? initials(state.user?.name) : 'CN'}
        </div>
        <div class="chat-bubble ${isUser ? 'user' : 'assistant'}">
          <div style="white-space:pre-wrap;">${escapeHtml(m.text)}</div>

          ${m.pending_action ? `
            <div class="assistant-confirm-box" id="confirmBox-${m.id}">
              <div style="font-weight:700;margin-bottom:6px;">⚠️ ${isMr ? 'कृती पुष्टीकरण' : 'Action Confirmation'}</div>
              <div style="font-size:13px;margin-bottom:12px;">${m.pending_action.prompt || (isMr ? 'तुम्ही ही कृती करू इच्छिता का?' : 'Do you want to confirm this action?')}</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-primary btn-small" onclick="executeAssistantAction('${m.pending_action.action}', ${m.pending_action.followup_id}, ${m.id})">✓ ${isMr ? 'होय, पूर्ण करा' : 'Confirm & Complete'}</button>
                <button class="btn btn-outline btn-small" onclick="cancelAssistantAction(${m.id})">✕ ${isMr ? 'रद्द करा' : 'Cancel'}</button>
              </div>
            </div>` : ''}

          ${m.actions && m.actions.length ? `
            <div class="chat-actions">
              ${m.actions.map(act => {
                if (act.type === 'tel') {
                  return `<a class="btn btn-danger btn-small" href="${act.href}" style="text-decoration:none;">${act.label}</a>`;
                }
                return `<button class="btn btn-outline btn-small" onclick="handleAssistantNav('${act.tab}')">${act.label}</button>`;
              }).join('')}
            </div>` : ''}

          ${!isUser ? `
            <div class="chat-voice-bar">
              <button class="btn btn-outline btn-small" id="listenBtn-${m.id}" onclick="speakAssistantMessage(${m.id})">
                🔊 ${isMr ? 'ऐका (Listen)' : 'Listen'}
              </button>
              <button class="btn btn-outline btn-small" id="stopBtn-${m.id}" onclick="stopAssistantAudio()" style="display:none;color:var(--red);border-color:var(--red);">
                ⏹️ ${isMr ? 'थांबवा (Stop)' : 'Stop'}
              </button>
              <span id="audioStatus-${m.id}" style="font-size:11.5px;color:var(--ink-soft);"></span>
            </div>` : ''}

          <div style="font-size:10.5px;color:${isUser ? 'rgba(255,255,255,0.7)' : 'var(--ink-soft)'};margin-top:6px;text-align:${isUser ? 'right' : 'left'};">
            ${m.timestamp || ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

function handleAssistantNav(tab) {
  state.tab = tab;
  renderApp();
}

function changeAssistantLang(newLang) {
  assistantState.lang = newLang;
  stopAssistantAudio();
  if (assistantState.messages.length <= 1) {
    assistantState.messages = [];
    initAssistantSession();
  }
  renderAssistantTab(document.getElementById('content'), state.user.role);
}

function clearAssistantChat() {
  stopAssistantAudio();
  assistantState.messages = [];
  initAssistantSession();
  renderAssistantTab(document.getElementById('content'), state.user.role);
  toast('Conversation history cleared.');
}

function scrollAssistantToBottom() {
  const container = document.getElementById('assistantMessages');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

function setAssistantStatus(msg, type = 'info') {
  const bar = document.getElementById('assistantStatusBar');
  if (!bar) return;
  if (!msg) {
    bar.classList.add('hidden');
    bar.textContent = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.className = `assistant-status-indicator ${type === 'error' ? 'error' : ''}`;
  bar.textContent = msg;
}

function updateAssistantMicUI(listening) {
  const btn = document.getElementById('micBtn');
  if (!btn) return;
  if (listening) {
    btn.classList.add('listening');
    btn.innerHTML = '⏹️';
  } else {
    btn.classList.remove('listening');
    btn.innerHTML = '🎙️';
  }
}

function submitAssistantInput() {
  const input = document.getElementById('assistantInput');
  if (!input) return;
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  sendAssistantQuery(q);
}

async function sendAssistantQuery(text) {
  if (!text) return;

  stopAssistantAudio();
  setAssistantStatus('');

  const userMsg = {
    id: assistantState.nextMsgId++,
    sender: 'user',
    text,
    timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  };
  assistantState.messages.push(userMsg);

  const container = document.getElementById('assistantMessages');
  if (container) {
    container.innerHTML = renderAssistantMessagesHtml();
    scrollAssistantToBottom();
  }

  setAssistantStatus('CareNexus Assistant is thinking...', 'info');

  try {
    const data = await api('/assistant/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text, language: assistantState.lang })
    });

    const assistantMsg = {
      id: assistantState.nextMsgId++,
      sender: 'assistant',
      text: data.reply,
      data: data.data || null,
      actions: data.actions || [],
      pending_action: data.pending_action || null,
      timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    };
    assistantState.messages.push(assistantMsg);

    setAssistantStatus('');
    if (container) {
      container.innerHTML = renderAssistantMessagesHtml();
      scrollAssistantToBottom();
    }
  } catch (err) {
    setAssistantStatus('Error: ' + err.message, 'error');
    const errMsg = {
      id: assistantState.nextMsgId++,
      sender: 'assistant',
      text: 'Sorry, I encountered an issue retrieving your information: ' + err.message,
      actions: [],
      timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    };
    assistantState.messages.push(errMsg);
    if (container) {
      container.innerHTML = renderAssistantMessagesHtml();
      scrollAssistantToBottom();
    }
  }
}

async function executeAssistantAction(action, followupId, msgId) {
  try {
    const res = await api('/assistant/action', {
      method: 'POST',
      body: JSON.stringify({ action, followup_id: followupId, confirm: true })
    });

    const confirmBox = document.getElementById(`confirmBox-${msgId}`);
    if (confirmBox) {
      confirmBox.innerHTML = `<div style="color:var(--teal);font-weight:700;">✓ ${res.message}</div>`;
    }
    toast(res.message);

    assistantState.messages.push({
      id: assistantState.nextMsgId++,
      sender: 'assistant',
      text: `✓ ${res.message}`,
      actions: [{ label: '📅 View Follow-Ups', type: 'navigate', tab: 'followups' }],
      timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    });

    const container = document.getElementById('assistantMessages');
    if (container) {
      container.innerHTML = renderAssistantMessagesHtml();
      scrollAssistantToBottom();
    }
  } catch (err) {
    toast('Action failed: ' + err.message);
  }
}

function cancelAssistantAction(msgId) {
  const confirmBox = document.getElementById(`confirmBox-${msgId}`);
  if (confirmBox) {
    confirmBox.innerHTML = `<div style="color:var(--ink-soft);font-size:12.5px;">✕ Action cancelled. No changes were made.</div>`;
  }
}

function stopAssistantAudio() {
  if (assistantState.currentAudio) {
    try {
      assistantState.currentAudio.pause();
      assistantState.currentAudio.currentTime = 0;
    } catch (_) {}
    assistantState.currentAudio = null;
  }
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (_) {}
  }

  if (assistantState.playingMsgId) {
    const listenBtn = document.getElementById(`listenBtn-${assistantState.playingMsgId}`);
    const stopBtn = document.getElementById(`stopBtn-${assistantState.playingMsgId}`);
    const statusSpan = document.getElementById(`audioStatus-${assistantState.playingMsgId}`);
    if (listenBtn) {
      listenBtn.style.display = 'inline-flex';
      listenBtn.textContent = `🔊 ${assistantState.lang === 'mr' ? 'ऐका (Listen)' : 'Listen'}`;
    }
    if (stopBtn) stopBtn.style.display = 'none';
    if (statusSpan) statusSpan.textContent = '';
    assistantState.playingMsgId = null;
  }
}

async function speakAssistantMessage(msgId) {
  const msg = assistantState.messages.find(m => m.id === msgId);
  if (!msg) return;

  stopAssistantAudio();

  const listenBtn = document.getElementById(`listenBtn-${msgId}`);
  const stopBtn = document.getElementById(`stopBtn-${msgId}`);
  const statusSpan = document.getElementById(`audioStatus-${msgId}`);

  if (listenBtn) listenBtn.textContent = '⏳ Loading audio…';

  try {
    const res = await fetch('/api/voice/synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': String(state.user.id)
      },
      body: JSON.stringify({ text: msg.text, language: assistantState.lang })
    });

    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('audio')) {
      const blob = await res.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      assistantState.currentAudio = audio;
      assistantState.playingMsgId = msgId;

      if (listenBtn) listenBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'inline-flex';
      if (statusSpan) statusSpan.textContent = '🔊 ElevenLabs Voice';

      audio.onended = () => {
        stopAssistantAudio();
      };
      audio.onerror = () => {
        stopAssistantAudio();
        toast('Audio playback error.');
      };
      await audio.play();
      return;
    }

    const data = await res.json().catch(() => ({}));
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(cleanSpeechText(msg.text));
      utterance.lang = assistantState.lang === 'mr' ? 'mr-IN' : 'en-IN';
      utterance.rate = 0.95;

      assistantState.playingMsgId = msgId;
      if (listenBtn) listenBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'inline-flex';
      if (statusSpan) statusSpan.textContent = 'Device speech (ElevenLabs key not configured in .env)';

      utterance.onend = () => {
        stopAssistantAudio();
      };
      utterance.onerror = () => {
        stopAssistantAudio();
      };

      window.speechSynthesis.speak(utterance);
      if (data.error) {
        toast(data.error);
      }
    } else {
      stopAssistantAudio();
      toast(data.error || 'Voice synthesis unavailable in this browser.');
    }
  } catch (err) {
    stopAssistantAudio();
    toast('Audio synthesis error: ' + err.message);
  }
}

function toggleAssistantMic() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    setAssistantStatus('Live speech recognition is not supported in this browser. Please type your question in the text box.', 'error');
    document.getElementById('assistantInput')?.focus();
    return;
  }

  if (assistantState.isListening) {
    assistantState.rec?.stop();
    assistantState.isListening = false;
    updateAssistantMicUI(false);
    return;
  }

  try {
    const rec = new SpeechRec();
    rec.lang = assistantState.lang === 'mr' ? 'mr-IN' : 'en-IN';
    rec.continuous = false;
    rec.interimResults = false;

    rec.onstart = () => {
      assistantState.isListening = true;
      updateAssistantMicUI(true);
      setAssistantStatus('🎙️ Listening... speak clearly into your microphone.', 'info');
    };

    rec.onresult = (evt) => {
      const transcript = evt.results[0][0].transcript;
      setAssistantStatus(`Heard: "${transcript}"`, 'info');
      const input = document.getElementById('assistantInput');
      if (input) input.value = transcript;
      sendAssistantQuery(transcript);
    };

    rec.onerror = (evt) => {
      assistantState.isListening = false;
      updateAssistantMicUI(false);
      if (evt.error === 'not-allowed' || evt.error === 'service-not-allowed') {
        setAssistantStatus('Microphone permission was blocked. Please enable microphone permissions in your browser or type below.', 'error');
      } else if (evt.error === 'no-speech') {
        setAssistantStatus('No speech was detected. Tap the mic to try again or type below.', 'info');
      } else {
        setAssistantStatus(`Speech recognition note: ${evt.error}. You can type your query below.`, 'error');
      }
    };

    rec.onend = () => {
      assistantState.isListening = false;
      updateAssistantMicUI(false);
    };

    assistantState.rec = rec;
    rec.start();
  } catch (e) {
    setAssistantStatus('Microphone initialization error: ' + e.message, 'error');
    document.getElementById('assistantInput')?.focus();
  }
}
