const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'carenexus.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function tableEmpty(name) {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get();
  return row.c === 0;
}

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('patient','asha','facility','admin')),
    phone TEXT UNIQUE,
    password TEXT NOT NULL DEFAULT '1234',
    facility_id INTEGER,
    language TEXT DEFAULT 'English',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS facilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('PHC','CHC','Hospital')),
    area TEXT,
    doctors_total INTEGER DEFAULT 5,
    doctors_available INTEGER DEFAULT 3,
    opd_status TEXT DEFAULT 'Normal',
    crowd_status TEXT DEFAULT 'Normal',
    queue_waiting INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    age INTEGER,
    gender TEXT,
    phone TEXT,
    category TEXT DEFAULT 'General' CHECK(category IN ('General','Maternal','Child','Chronic')),
    high_risk INTEGER DEFAULT 0,
    asha_id INTEGER,
    village TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(asha_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    facility_id INTEGER NOT NULL,
    token TEXT,
    reason TEXT,
    mode TEXT DEFAULT 'In-person' CHECK(mode IN ('In-person','Teleconsultation')),
    triage_priority TEXT DEFAULT 'Routine' CHECK(triage_priority IN ('Emergency','Priority','Routine')),
    status TEXT DEFAULT 'Waiting' CHECK(status IN ('Waiting','In Consultation','Completed','Cancelled')),
    est_wait_minutes INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(facility_id) REFERENCES facilities(id)
  );

  CREATE TABLE IF NOT EXISTS health_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    facility_id INTEGER,
    record_type TEXT,
    title TEXT,
    details TEXT,
    doctor_name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id)
  );

  CREATE TABLE IF NOT EXISTS instructions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    facility_id INTEGER,
    doctor_name TEXT,
    instruction_text TEXT,
    medication_info TEXT,
    next_visit TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id)
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    from_facility_id INTEGER,
    to_facility_id INTEGER,
    reason TEXT,
    status TEXT DEFAULT 'Created' CHECK(status IN ('Created','Accepted','In Progress','Completed')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id)
  );

  CREATE TABLE IF NOT EXISTS follow_ups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    asha_id INTEGER,
    type TEXT DEFAULT 'General' CHECK(type IN ('General','Maternal','Child','Chronic','High-Risk')),
    due_date TEXT,
    status TEXT DEFAULT 'Due' CHECK(status IN ('Due','Completed','Missed')),
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id)
  );

  CREATE TABLE IF NOT EXISTS medicines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facility_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'Available' CHECK(status IN ('Available','Low Stock','Unavailable')),
    FOREIGN KEY(facility_id) REFERENCES facilities(id)
  );

  CREATE TABLE IF NOT EXISTS diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facility_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'Available' CHECK(status IN ('Available','Busy','Unavailable')),
    FOREIGN KEY(facility_id) REFERENCES facilities(id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_role TEXT,
    patient_id INTEGER,
    message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Emergency SOS coordination. Public map listings are never dispatch recipients.
  CREATE TABLE IF NOT EXISTS emergency_participating_facilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facility_id INTEGER NOT NULL UNIQUE,
    verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
    latitude REAL,
    longitude REAL,
    contact_phone TEXT,
    verified_by TEXT,
    verified_at TEXT,
    FOREIGN KEY(facility_id) REFERENCES facilities(id)
  );
  CREATE TABLE IF NOT EXISTS emergency_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL,
    latitude REAL,
    longitude REAL,
    location_text TEXT,
    emergency_type TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'Searching' CHECK(status IN ('Searching','Accepted','Contacting patient','Patient confirmed','Patient denied','Unable to verify','Escalated','Closed','No participating facility nearby')),
    accepted_facility_id INTEGER,
    patient_confirmation TEXT,
    contact_outcome TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(patient_id) REFERENCES patients(id),
    FOREIGN KEY(accepted_facility_id) REFERENCES facilities(id)
  );
  CREATE TABLE IF NOT EXISTS emergency_request_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    facility_id INTEGER NOT NULL,
    distance_km REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Accepted','Declined','Superseded')),
    responded_at TEXT,
    UNIQUE(request_id, facility_id),
    FOREIGN KEY(request_id) REFERENCES emergency_requests(id),
    FOREIGN KEY(facility_id) REFERENCES facilities(id)
  );
  `);

  seed();
}

function seed() {
  if (!tableEmpty('facilities')) return;

  const insertFacility = db.prepare(`INSERT INTO facilities
    (name, type, area, doctors_total, doctors_available, opd_status, crowd_status, queue_waiting)
    VALUES (?,?,?,?,?,?,?,?)`);

  const facilities = [
    ['Wardha PHC', 'PHC', 'Wardha Rural', 3, 2, 'High', 'High', 28],
    ['Deoli CHC', 'CHC', 'Deoli Block', 6, 4, 'Medium', 'Medium', 15],
    ['Nagpur General Hospital', 'Hospital', 'Nagpur Urban', 20, 12, 'High', 'High', 63],
    ['Kalmeshwar PHC', 'PHC', 'Kalmeshwar', 3, 3, 'Normal', 'Normal', 6],
    ['Butibori CHC', 'CHC', 'Butibori', 5, 3, 'Normal', 'Medium', 11],
  ];
  const facilityIds = facilities.map(f => insertFacility.run(...f).lastInsertRowid);

  const insertUser = db.prepare(`INSERT INTO users (name, role, phone, password, facility_id, language) VALUES (?,?,?,?,?,?)`);
  const patientUserId = insertUser.run('Sushma Patil', 'patient', '9000000001', '1234', null, 'Marathi').lastInsertRowid;
  const ashaUserId = insertUser.run('Anjali Kadam (ASHA)', 'asha', '9000000002', '1234', null, 'Marathi').lastInsertRowid;
  const facilityUserId = insertUser.run('Dr. R. Mehta', 'facility', '9000000003', '1234', facilityIds[0], 'English').lastInsertRowid;
  insertUser.run('State Health Admin', 'admin', '9000000004', '1234', null, 'English');
  // Extra facility staff logins for the other demo facilities
  insertUser.run('Dr. S. Rao (Deoli CHC)', 'facility', '9000000005', '1234', facilityIds[1], 'English');
  insertUser.run('Dr. A. Verma (Nagpur Hosp.)', 'facility', '9000000006', '1234', facilityIds[2], 'English');

  const insertPatient = db.prepare(`INSERT INTO patients
    (user_id, name, age, gender, phone, category, high_risk, asha_id, village) VALUES (?,?,?,?,?,?,?,?,?)`);

  const patients = [
    [patientUserId, 'Sushma Patil', 27, 'Female', '9000000001', 'Maternal', 1, ashaUserId, 'Salod'],
    [null, 'Ramesh Gaikwad', 58, 'Male', '9000000010', 'Chronic', 1, ashaUserId, 'Salod'],
    [null, 'Aarav Kadam', 4, 'Male', '9000000011', 'Child', 0, ashaUserId, 'Hingana'],
    [null, 'Meera Joshi', 32, 'Female', '9000000012', 'Maternal', 0, ashaUserId, 'Hingana'],
    [null, 'Vitthal Shinde', 65, 'Male', '9000000013', 'Chronic', 1, ashaUserId, 'Salod'],
    [null, 'Priya Deshmukh', 2, 'Female', '9000000014', 'Child', 1, ashaUserId, 'Butibori'],
  ];
  const patientIds = patients.map(p => insertPatient.run(...p).lastInsertRowid);

  const insertAppt = db.prepare(`INSERT INTO appointments
    (patient_id, facility_id, token, reason, mode, triage_priority, status, est_wait_minutes) VALUES (?,?,?,?,?,?,?,?)`);
  insertAppt.run(patientIds[0], facilityIds[0], 'P-102', 'Antenatal checkup', 'In-person', 'Priority', 'Waiting', 25);
  insertAppt.run(patientIds[1], facilityIds[0], 'P-098', 'Blood sugar follow-up', 'In-person', 'Routine', 'Waiting', 40);
  insertAppt.run(patientIds[3], facilityIds[1], 'P-045', 'Teleconsultation - fever', 'Teleconsultation', 'Routine', 'Completed', 0);

  const insertRecord = db.prepare(`INSERT INTO health_records
    (patient_id, facility_id, record_type, title, details, doctor_name) VALUES (?,?,?,?,?,?)`);
  insertRecord.run(patientIds[0], facilityIds[0], 'Consultation', 'Antenatal Visit - 2nd Trimester', 'BP 118/76, Hb 11.2 g/dL, weight gain normal.', 'Dr. R. Mehta');
  insertRecord.run(patientIds[0], facilityIds[0], 'Immunization', 'TT-2 administered', 'Tetanus toxoid second dose given.', 'Dr. R. Mehta');
  insertRecord.run(patientIds[1], facilityIds[0], 'Consultation', 'Diabetes Review', 'Fasting sugar 168 mg/dL, medication adjusted.', 'Dr. R. Mehta');

  const insertInstr = db.prepare(`INSERT INTO instructions
    (patient_id, facility_id, doctor_name, instruction_text, medication_info, next_visit) VALUES (?,?,?,?,?,?)`);
  insertInstr.run(patientIds[0], facilityIds[0], 'Dr. R. Mehta', 'Continue iron & calcium supplements. Rest well, light activity only.', 'Iron-Folic Acid 1 tablet/day, Calcium 500mg twice daily.', '2026-09-21');
  insertInstr.run(patientIds[1], facilityIds[0], 'Dr. R. Mehta', 'Monitor sugar levels twice daily, reduce sugar intake.', 'Metformin 500mg twice daily after food.', '2026-09-14');

  const insertReferral = db.prepare(`INSERT INTO referrals
    (patient_id, from_facility_id, to_facility_id, reason, status) VALUES (?,?,?,?,?)`);
  insertReferral.run(patientIds[4], facilityIds[0], facilityIds[1], 'Suspected cardiac complication - needs specialist review', 'In Progress');
  insertReferral.run(patientIds[5], facilityIds[1], facilityIds[2], 'Severe malnutrition - needs pediatric ICU', 'Accepted');

  const insertFollow = db.prepare(`INSERT INTO follow_ups
    (patient_id, asha_id, type, due_date, status, notes) VALUES (?,?,?,?,?,?)`);
  insertFollow.run(patientIds[0], ashaUserId, 'Maternal', '2026-09-10', 'Due', 'Check BP and iron intake compliance.');
  insertFollow.run(patientIds[1], ashaUserId, 'Chronic', '2026-09-08', 'Due', 'Verify sugar log and medicine adherence.');
  insertFollow.run(patientIds[2], ashaUserId, 'Child', '2026-09-15', 'Due', 'Growth monitoring and immunization check.');
  insertFollow.run(patientIds[4], ashaUserId, 'High-Risk', '2026-09-09', 'Due', 'Post-referral cardiac follow-up.');
  insertFollow.run(patientIds[3], ashaUserId, 'Maternal', '2026-08-28', 'Completed', 'Antenatal follow-up done, all normal.');

  const insertMed = db.prepare(`INSERT INTO medicines (facility_id, name, status) VALUES (?,?,?)`);
  const medSets = {
    [facilityIds[0]]: [['Paracetamol','Available'],['Amoxicillin','Low Stock'],['ORS','Available'],['Vitamin D3','Available'],['Iron-Folic Acid','Available'],['Metformin','Low Stock']],
    [facilityIds[1]]: [['Paracetamol','Available'],['Amoxicillin','Available'],['ORS','Available'],['Insulin','Low Stock'],['Metformin','Available']],
    [facilityIds[2]]: [['Paracetamol','Available'],['Amoxicillin','Available'],['ORS','Available'],['Insulin','Available'],['Antibiotics (IV)','Available'],['Vitamin D3','Available']],
    [facilityIds[3]]: [['Paracetamol','Available'],['ORS','Available'],['Vitamin D3','Unavailable']],
    [facilityIds[4]]: [['Paracetamol','Available'],['Amoxicillin','Available'],['ORS','Low Stock']],
  };
  for (const [fid, meds] of Object.entries(medSets)) {
    meds.forEach(m => insertMed.run(Number(fid), m[0], m[1]));
  }

  const insertDiag = db.prepare(`INSERT INTO diagnostics (facility_id, name, status) VALUES (?,?,?)`);
  const diagSets = {
    [facilityIds[0]]: [['CBC','Available'],['X-Ray','Busy'],['Blood Sugar','Available'],['Ultrasound','Unavailable']],
    [facilityIds[1]]: [['CBC','Available'],['X-Ray','Available'],['Ultrasound','Available'],['Blood Sugar','Available']],
    [facilityIds[2]]: [['CBC','Available'],['X-Ray','Available'],['Ultrasound','Available'],['CT Scan','Busy'],['Blood Sugar','Available']],
    [facilityIds[3]]: [['CBC','Available'],['Blood Sugar','Available']],
    [facilityIds[4]]: [['CBC','Available'],['X-Ray','Busy']],
  };
  for (const [fid, diags] of Object.entries(diagSets)) {
    diags.forEach(d => insertDiag.run(Number(fid), d[0], d[1]));
  }

  const insertNotif = db.prepare(`INSERT INTO notifications (user_role, patient_id, message) VALUES (?,?,?)`);
  insertNotif.run('patient', patientIds[0], 'Your token P-102 at Wardha PHC — estimated wait 25 min.');
  insertNotif.run('patient', patientIds[0], 'Follow-up reminder: antenatal check-up due on 10 Sep.');
  insertNotif.run('asha', null, 'High-risk follow-up due today for Ramesh Gaikwad.');
}

module.exports = { db, init };
