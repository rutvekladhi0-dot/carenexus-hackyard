// =========================================================
// CareNexus Voice AI Assistant Service
// Role-based, grounded in local CareNexus SQLite database.
// Supports Patients & ASHA Workers in English & Marathi.
// Integrates with ElevenLabs Text-to-Speech & Speech-to-Text.
// =========================================================

const { db } = require('./db');

// ---------- Authentication Helper ----------
function getAuthContext(req) {
  const userId = req.headers['x-user-id'] || req.body?.user_id || req.query?.user_id;
  if (!userId) return null;

  const user = db.prepare('SELECT id, name, role, language, facility_id FROM users WHERE id = ?').get(Number(userId));
  if (!user) return null;

  let patient = null;
  if (user.role === 'patient') {
    patient = db.prepare('SELECT * FROM patients WHERE user_id = ?').get(user.id);
  }

  return { user, patient };
}

// ---------- Text Cleaner for ElevenLabs TTS ----------
function cleanTextForSpeech(text) {
  if (!text) return '';
  return text
    .replace(/[*#_`~>]/g, '')               // remove markdown formatting
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // replace links with anchor text
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '') // remove emojis
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Intent Matchers & Handlers ----------

function detectLanguage(text, preferred) {
  if (preferred === 'mr') return 'mr';
  if (preferred === 'en') return 'en';
  // Check for Devanagari script (Marathi/Hindi)
  if (/[\u0900-\u097F]/.test(text)) return 'mr';
  return 'en';
}

function handlePatientQuery(text, patient, user, lang) {
  const t = text.toLowerCase();
  const isMr = lang === 'mr';

  // 1. Emergency detection (Safety First!)
  if (/(emergency|ambulance|112|chest pain|bleeding|accident|unconscious|heart attack|तातडी|रुग्णवाहिका|अपघात|छातीत दुखणे|रक्तस्राव)/i.test(t)) {
    return {
      intent: 'emergency',
      reply: isMr
        ? '🚨 तातडीची मदत: जर तुम्ही किंवा कोणीही तात्काळ धोक्यात असेल, तर कृपया लगेच 112 वर कॉल करा. केअरनेक्सस इमर्जन्सी एसओएस (SOS) समन्वय प्रणाली देखील उपलब्ध आहे.'
        : '🚨 IMMEDIATE EMERGENCY: If you or someone else is in immediate danger, please call 112 right now. You can also use the CareNexus Emergency SOS coordination feature.',
      actions: [
        { label: isMr ? '📞 112 वर कॉल करा' : '📞 Call 112 Now', type: 'tel', href: 'tel:112' },
        { label: isMr ? '🚨 इमर्जन्सी SOS उघडा' : '🚨 Open Emergency SOS', type: 'navigate', tab: 'sos' }
      ]
    };
  }

  // 2. Medical Advice / Diagnosis refusal (Safety Guardrail - evaluate before routine instruction lookup!)
  if (/(what (medicine|tablet|drug|dose) should i take|can i stop (taking|my)|diagnos|prescribe|cure for|remedy for|what disease|fever|cough|headache|pain|symptom|illness|औषध सुचवा|रोग|ताप|खोकला|डोकेदुखी|लक्षणे)/i.test(t)) {
    return {
      intent: 'medical_safety',
      reply: isMr
        ? '⚠️ वैद्यकीय सुरक्षा सूचना: एक AI सहाय्यक म्हणून मी रोगांचे निदान करू शकत नाही किंवा औषधे सुचवू/बदलू शकत नाही. योग्य उपचारांसाठी कृपया तुमच्या जवळच्या प्राथमिक आरोग्य केंद्राला (PHC) भेट द्या किंवा आशा कार्यकर्त्याशी संपर्क साधा.'
        : '⚠️ Medical Safety Note: As an AI assistant, I cannot diagnose illnesses or recommend changing medications. Please book an appointment with a qualified doctor at your nearest PHC/hospital or speak with your ASHA worker.',
      actions: [
        { label: isMr ? '📍 आरोग्य केंद्र शोधा' : '📍 Find Nearby PHC', type: 'navigate', tab: 'findcare' },
        { label: isMr ? '🚨 तातडीची अडचण (SOS)' : '🚨 Emergency SOS', type: 'navigate', tab: 'sos' }
      ]
    };
  }

  // 3. Appointments & Queue Status (Next appointment, active token, wait time)
  if (/(appointment|next appointment|upcoming appointment|token|queue|wait|consultation|भेट|पुढील भेट|अपॉइंटमेंट|टोकन|रांग|प्रतीक्षा)/i.test(t) && !/(instruction|doctor advice|सूचना)/i.test(t)) {
    const appts = db.prepare(`SELECT a.*, f.name AS facility_name, f.type AS facility_type 
      FROM appointments a JOIN facilities f ON f.id = a.facility_id 
      WHERE a.patient_id = ? ORDER BY a.created_at DESC`).all(patient.id);

    const active = appts.find(a => a.status === 'Waiting' || a.status === 'In Consultation');

    if (active) {
      const reply = isMr
        ? `तुमची सक्रिय भेट ${active.facility_name} येथे आहे.\n• टोकन क्रमांक: ${active.token}\n• स्थिती: ${active.status}\n• अंदाजे प्रतीक्षा वेळ: ${active.est_wait_minutes} मिनिटे\n• तपासणी प्रकार: ${active.mode}`
        : `You have an active appointment at ${active.facility_name}.\n• Token: ${active.token}\n• Status: ${active.status}\n• Estimated wait: ${active.est_wait_minutes} minutes\n• Mode: ${active.mode}`;
      return {
        intent: 'appointment',
        reply,
        data: [active],
        actions: [{ label: isMr ? '🎫 रांग व टोकन पहा' : '🎫 View Appointments & Queue', type: 'navigate', tab: 'queue' }]
      };
    } else if (appts.length) {
      const latest = appts[0];
      const reply = isMr
        ? `तुमच्याकडे सध्या कोणतीही चालू रांग नाही. तुमची शेवटची भेट ${latest.facility_name} येथे होती (स्थिती: ${latest.status}, कारण: ${latest.reason}). नवीन भेट घेण्यासाठी फाइंड केअर वापरा.`
        : `You have no waiting queue token right now. Your most recent appointment was at ${latest.facility_name} (Status: ${latest.status}, Reason: ${latest.reason}). You can book a new appointment via Find Care.`;
      return {
        intent: 'appointment',
        reply,
        data: [latest],
        actions: [
          { label: isMr ? '📍 नवीन भेट बुक करा' : '📍 Find Care & Book', type: 'navigate', tab: 'findcare' },
          { label: isMr ? '🎫 इतिहास पहा' : '🎫 View History', type: 'navigate', tab: 'queue' }
        ]
      };
    } else {
      return {
        intent: 'appointment',
        reply: isMr
          ? 'तुमची कोणतीही नोंदवलेली भेट सापडली नाही. जवळच्या आरोग्य केंद्रात भेट बुक करण्यासाठी फाइंड केअर वापरा.'
          : 'No appointments found for your account. You can search facilities and book an appointment using Find Care.',
        actions: [{ label: isMr ? '📍 आरोग्य केंद्र शोधा' : '📍 Find Care', type: 'navigate', tab: 'findcare' }]
      };
    }
  }

  // 4. Doctor Instructions & Recorded Medicines
  if (/(instruction|medicine|medication|prescription|doctor say|dose|tablet|औषध|गोळ्या|सूचना|डॉक्टर)/i.test(t)) {
    const instrs = db.prepare('SELECT * FROM instructions WHERE patient_id = ? ORDER BY created_at DESC LIMIT 3').all(patient.id);
    if (!instrs.length) {
      return {
        intent: 'instructions',
        reply: isMr
          ? 'तुमच्यासाठी अद्याप कोणतीही वैद्यकीय सूचना नोंदवलेली नाही. अधिक माहितीसाठी कृपया तुमच्या आरोग्य केंद्राशी संपर्क साधा.'
          : 'No healthcare instructions or medicines have been recorded for you yet. Please consult your PHC doctor or ASHA worker.',
        actions: [{ label: isMr ? '💊 सूचना व औषधे' : '💊 Instructions & Medicines', type: 'navigate', tab: 'care' }]
      };
    }

    const latest = instrs[0];
    let reply = '';
    if (isMr) {
      reply = `तुमचे डॉक्टर ${latest.doctor_name || 'वैद्यकीय अधिकारी'} यांनी खालील सूचना दिल्या आहेत:\n• सूचना: ${latest.instruction_text}`;
      if (latest.medication_info) reply += `\n• औषधे: ${latest.medication_info}`;
      if (latest.next_visit) reply += `\n• पुढील भेट: ${latest.next_visit}`;
      reply += '\n\nकृपया औषधे डॉक्टरांच्या सल्ल्यानुसारच घ्या. डोस स्वतः बदलू नका.';
    } else {
      reply = `Your doctor (${latest.doctor_name || 'Medical Officer'}) recorded these instructions:\n• Instructions: ${latest.instruction_text}`;
      if (latest.medication_info) reply += `\n• Medicines: ${latest.medication_info}`;
      if (latest.next_visit) reply += `\n• Next Visit Date: ${latest.next_visit}`;
      reply += '\n\nAlways follow your doctor’s prescribed dosage. Do not modify medications independently.';
    }

    return {
      intent: 'instructions',
      reply,
      data: instrs,
      actions: [{ label: isMr ? '💊 सविस्तर औषध माहिती पहा' : '💊 View Instructions & Medicines', type: 'navigate', tab: 'care' }]
    };
  }

  // 5. Referral Status
  if (/(referral|refer|हस्तांतरण|रेफरल|रेफर)/i.test(t)) {
    const refs = db.prepare(`SELECT r.*, f1.name AS from_facility, f2.name AS to_facility 
      FROM referrals r 
      LEFT JOIN facilities f1 ON f1.id = r.from_facility_id 
      JOIN facilities f2 ON f2.id = r.to_facility_id 
      WHERE r.patient_id = ? ORDER BY r.created_at DESC`).all(patient.id);

    if (!refs.length) {
      return {
        intent: 'referral',
        reply: isMr
          ? 'तुमच्या खात्यावर कोणताही रेफरल नोंदवलेला नाही.'
          : 'No referrals have been recorded for your account.',
        actions: [{ label: isMr ? '🔁 रेफरल विभाग' : '🔁 Referral Status', type: 'navigate', tab: 'referral' }]
      };
    }

    const r = refs[0];
    const reply = isMr
      ? `तुमचा रेफरल तपशील:\n• कुठून: ${r.from_facility || 'आरोग्य केंद्र'}\n• कुठे: ${r.to_facility}\n• कारण: ${r.reason || 'विशेष तपासणी'}\n• सद्यस्थिती: ${r.status}`
      : `Your referral details:\n• From: ${r.from_facility || 'Primary Facility'}\n• To: ${r.to_facility}\n• Reason: ${r.reason || 'Specialist Care'}\n• Status: ${r.status}`;

    return {
      intent: 'referral',
      reply,
      data: refs,
      actions: [{ label: isMr ? '🔁 रेफरल स्थिती पहा' : '🔁 View Referral Status', type: 'navigate', tab: 'referral' }]
    };
  }

  // 6. Follow-ups & Alerts
  if (/(follow|follow-up|followup|alert|reminder|फॉलो-अप|स्मरणपत्र)/i.test(t)) {
    const follows = db.prepare(`SELECT * FROM follow_ups WHERE patient_id = ? ORDER BY due_date ASC`).all(patient.id);
    const due = follows.filter(f => f.status === 'Due');

    if (due.length) {
      const f = due[0];
      const reply = isMr
        ? `तुमचा प्रलंबित फॉलो-अप:\n• प्रकार: ${f.type} केअर\n• तारीख: ${f.due_date}\n• टीप: ${f.notes || 'वेळेवर तपासणी करा'}\n• स्थिती: प्रलंबित (Due)`
        : `You have an upcoming follow-up due:\n• Type: ${f.type} Care\n• Due Date: ${f.due_date}\n• Notes: ${f.notes || 'Routine follow-up'}\n• Status: Due`;
      return {
        intent: 'followup',
        reply,
        data: due,
        actions: [{ label: isMr ? '🔔 फॉलो-अप व अलर्ट' : '🔔 Follow-up & Alerts', type: 'navigate', tab: 'followup' }]
      };
    } else {
      return {
        intent: 'followup',
        reply: isMr
          ? 'तुमचा कोणताही प्रलंबित फॉलो-अप बाकी नाही. सर्व तपासण्या अद्ययावत आहेत.'
          : 'You have no pending follow-ups due at this time. All follow-ups are up to date.',
        actions: [{ label: isMr ? '🔔 फॉलो-अप इतिहास' : '🔔 Follow-up History', type: 'navigate', tab: 'followup' }]
      };
    }
  }

  // 7. Find Nearby Healthcare Facilities
  if (/(facility|hospital|phc|chc|clinic|doctor near|find care|रुग्णालय|दवाखाना|आरोग्य केंद्र|डॉक्टर कुठे)/i.test(t)) {
    const facs = db.prepare(`SELECT name, type, area, crowd_status, doctors_available, doctors_total, queue_waiting FROM facilities LIMIT 4`).all();
    let reply = isMr
      ? 'केअरनेक्सस नेटवर्कमधील काही जवळची आरोग्य केंद्रे:\n'
      : 'Here are nearby healthcare facilities in the CareNexus network:\n';

    facs.forEach(f => {
      reply += `\n• ${f.name} (${f.type}, ${f.area}) — गर्दी: ${f.crowd_status}, उपलब्ध डॉक्टर: ${f.doctors_available}/${f.doctors_total}`;
    });

    return {
      intent: 'facilities',
      reply,
      data: facs,
      actions: [{ label: isMr ? '📍 नकाशावर शोधा (Find Care)' : '📍 Search Map & Facilities', type: 'navigate', tab: 'findcare' }]
    };
  }

  // 8. Health Records
  if (/(record|report|history|test|तपासणी|रेकॉर्ड|अहवाल|इतिहास)/i.test(t)) {
    const records = db.prepare(`SELECT * FROM health_records WHERE patient_id = ? ORDER BY created_at DESC LIMIT 3`).all(patient.id);
    if (!records.length) {
      return {
        intent: 'records',
        reply: isMr ? 'तुमचे कोणतेही डिजिटल आरोग्य रेकॉर्ड अद्याप जोडलेले नाही.' : 'No digital health records have been uploaded for your account yet.',
        actions: [{ label: isMr ? '📋 आरोग्य रेकॉर्ड' : '📋 Health Records', type: 'navigate', tab: 'records' }]
      };
    }

    let reply = isMr ? 'तुमचे अलीकडील आरोग्य रेकॉर्ड:\n' : 'Here are your recent health records:\n';
    records.forEach(r => {
      reply += `\n• ${r.title} (${r.record_type}) — ${r.doctor_name || 'वैद्यकीय अधिकारी'}\n  ${r.details || ''}`;
    });

    return {
      intent: 'records',
      reply,
      data: records,
      actions: [{ label: isMr ? '📋 सर्व रेकॉर्ड पहा' : '📋 View All Records', type: 'navigate', tab: 'records' }]
    };
  }

  // Default Fallback
  return {
    intent: 'general',
    reply: isMr
      ? `नमस्कार ${patient.name.split(' ')[0]}! मी केअरनेक्सस व्हॉइस असिस्टंट आहे. तुम्ही मला विचारू शकता:\n• "माझी पुढील भेट कधी आहे?"\n• "माझ्या रेफरलची स्थिती काय आहे?"\n• "माझे औषधोपचार समजावून सांगा"\n• "माझे प्रलंबित फॉलो-अप दाखवा"\n• "जवळचे रुग्णालय शोधा"`
      : `Hello ${patient.name.split(' ')[0]}! I am your CareNexus Voice Assistant. You can ask me:\n• "When is my next appointment?"\n• "What is the status of my referral?"\n• "Explain the medicine instructions recorded for me"\n• "Show my pending follow-ups"\n• "Help me find a nearby healthcare facility"`,
    actions: [
      { label: isMr ? '🎫 रांग व टोकन' : '🎫 My Queue', type: 'navigate', tab: 'queue' },
      { label: isMr ? '💊 सूचना व औषधे' : '💊 Instructions', type: 'navigate', tab: 'care' },
      { label: isMr ? '🔁 रेफरल स्थिती' : '🔁 Referrals', type: 'navigate', tab: 'referral' }
    ]
  };
}

function handleAshaQuery(text, user, lang) {
  const t = text.toLowerCase();
  const isMr = lang === 'mr';
  const ashaId = user.id;

  // 1. Action Command: Mark Complete (Check before general queries!)
  if (/(mark|complete|पूर्ण)/i.test(t) && /(follow|followup|follow-up|फॉलो-अप)/i.test(t)) {
    const markMatch = text.match(/#?(\d+)/);
    const targetId = markMatch ? Number(markMatch[1]) : null;
    let followup = null;
    if (targetId) {
      followup = db.prepare(`SELECT fu.*, p.name AS patient_name FROM follow_ups fu JOIN patients p ON p.id=fu.patient_id WHERE fu.id=? AND fu.asha_id=?`).get(targetId, ashaId);
    } else {
      followup = db.prepare(`SELECT fu.*, p.name AS patient_name FROM follow_ups fu JOIN patients p ON p.id=fu.patient_id WHERE fu.asha_id=? AND fu.status='Due' LIMIT 1`).get(ashaId);
    }

    if (!followup) {
      return {
        intent: 'asha_action_prompt',
        reply: isMr
          ? 'पूर्ण करण्यासाठी योग्य फॉलो-अप सापडला नाही किंवा तुम्हाला तो बदलण्याची परवानगी नाही.'
          : 'Could not find a pending follow-up assigned to you to mark as completed.',
        actions: [{ label: isMr ? '📅 फॉलो-अप यादी' : '📅 View Follow-ups', type: 'navigate', tab: 'followups' }]
      };
    }

    return {
      intent: 'asha_action_prompt',
      reply: isMr
        ? `⚠️ कृपया पुष्टी करा: तुम्ही ${followup.patient_name} यांचा ${followup.type} फॉलो-अप (#${followup.id}) 'पूर्ण' (Completed) म्हणून नोंदवू इच्छिता का?`
        : `⚠️ Confirmation required: Are you sure you want to mark follow-up #${followup.id} for ${followup.patient_name} (${followup.type} Care) as Completed?`,
      pending_action: {
        action: 'complete_followup',
        followup_id: followup.id,
        patient_name: followup.patient_name,
        prompt: isMr ? `फॉलो-अप #${followup.id} पूर्ण करा` : `Confirm completing follow-up #${followup.id}`
      }
    };
  }

  // 2. High-Risk Patients / Which Patients Need Follow-up (Check before generic follow-up list!)
  if (/(high risk|high-risk|which patient|need follow|priority|patients? (needing|need) attention|हाय-रिस्क|गंभीर रुग्ण|कोणाला गरज|प्राधान्य)/i.test(t) && !/(referral|refer|हस्तांतरण|रेफर)/i.test(t)) {
    const patients = db.prepare(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM follow_ups WHERE patient_id = p.id AND status = 'Due') AS due_count
      FROM patients p
      WHERE p.asha_id = ? AND (p.high_risk = 1 OR p.id IN (SELECT patient_id FROM follow_ups WHERE status = 'Due'))
      ORDER BY p.high_risk DESC, due_count DESC
    `).all(ashaId);

    if (!patients.length) {
      return {
        intent: 'asha_patients_priority',
        reply: isMr
          ? 'सध्या तुमच्या देखरेखीखाली कोणतीही हाय-रिस्क किंवा त्वरित लक्ष देण्याची गरज असलेली रुग्ण प्रकरणे नाहीत.'
          : 'No high-risk patients or urgent follow-up cases currently flagged in your area.',
        actions: [{ label: isMr ? '👥 रुग्ण यादी' : '👥 Patient List', type: 'navigate', tab: 'patients' }]
      };
    }

    let reply = isMr
      ? `लक्ष देण्याची गरज असलेले रुग्ण (${patients.length} रुग्ण):\n`
      : `Patients needing close attention (${patients.length} patients):\n`;

    patients.forEach(p => {
      const tag = p.high_risk ? (isMr ? '[हाय-रिस्क]' : '[High-Risk]') : '';
      reply += `\n• ${p.name} (${p.category}, ${p.age} वर्षे, ${p.village}) ${tag}\n  प्रलंबित फॉलो-अप: ${p.due_count}`;
    });

    return {
      intent: 'asha_patients_priority',
      reply,
      data: patients,
      actions: [{ label: isMr ? '👥 रुग्ण प्रोफाइल पहा' : '👥 Manage Patients', type: 'navigate', tab: 'patients' }]
    };
  }

  // 3. Search Patient by Name in Assigned Patients
  // Look up if any of the words in the query matches an assigned patient's name
  const words = text.replace(/[^a-zA-Z\u0900-\u097F\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const assignedPatients = db.prepare('SELECT * FROM patients WHERE asha_id = ?').all(ashaId);
  const matchedPatient = assignedPatients.find(p => words.some(w => p.name.toLowerCase().includes(w.toLowerCase())));

  if (matchedPatient && /(record|patient|profile|details|माहिती|तपासा|रेकॉर्ड)/i.test(t)) {
    return {
      intent: 'asha_search',
      reply: isMr
        ? `अधिकृत रुग्ण नोंद (${matchedPatient.name}):\n• वय: ${matchedPatient.age} वर्षे, लिंग: ${matchedPatient.gender}\n• श्रेणी: ${matchedPatient.category} केअर ${matchedPatient.high_risk ? '[हाय-रिस्क]' : ''}\n• गाव: ${matchedPatient.village || 'नोंद नाही'}\n• फोन: ${matchedPatient.phone || 'नोंद नाही'}`
        : `Authorized patient record for ${matchedPatient.name}:\n• Age: ${matchedPatient.age}, Gender: ${matchedPatient.gender}\n• Category: ${matchedPatient.category} Care ${matchedPatient.high_risk ? '[High-Risk]' : ''}\n• Village: ${matchedPatient.village || 'N/A'}\n• Phone: ${matchedPatient.phone || 'N/A'}`,
      data: [matchedPatient],
      actions: [{ label: isMr ? '👥 रुग्ण प्रोफाइल उघडा' : '👥 View Patient Profile', type: 'navigate', tab: 'patients' }]
    };
  }

  // 4. Follow-ups for Today / Due Follow-ups
  if (/(follow|follow-up|followup|due today|pending follow|फॉलो-अप|आजचे काम|प्रलंबित)/i.test(t)) {
    const due = db.prepare(`
      SELECT fu.*, p.name AS patient_name, p.village, p.high_risk, p.category, p.age
      FROM follow_ups fu
      JOIN patients p ON p.id = fu.patient_id
      WHERE fu.asha_id = ? AND fu.status = 'Due'
      ORDER BY fu.due_date ASC
    `).all(ashaId);

    if (!due.length) {
      return {
        intent: 'asha_followups',
        reply: isMr
          ? 'उत्कृष्ट! तुमच्या कार्यक्षेत्रातील सर्व फॉलो-अप पूर्ण झाले आहेत. आज कोणताही प्रलंबित फॉलो-अप नाही.'
          : 'Great job! All assigned follow-ups are up to date. You have no pending follow-ups due today.',
        actions: [{ label: isMr ? '📅 फॉलो-अप व्यवस्थापन' : '📅 Follow-Up Management', type: 'navigate', tab: 'followups' }]
      };
    }

    let reply = isMr
      ? `तुमच्याकडे ${due.length} प्रलंबित फॉलो-अप आहेत:\n`
      : `You have ${due.length} pending follow-ups:\n`;

    due.slice(0, 5).forEach((f, idx) => {
      reply += `\n${idx + 1}. ${f.patient_name} (${f.type} केअर, ${f.village || 'गाव'}) — देय: ${f.due_date}\n   टीप: ${f.notes || 'नियमित पाठपुरावा'}`;
    });

    return {
      intent: 'asha_followups',
      reply,
      data: due,
      actions: [
        { label: isMr ? '📅 फॉलो-अप व्यवस्थापन उघडा' : '📅 Open Follow-Up Module', type: 'navigate', tab: 'followups' },
        { label: isMr ? '👥 माझे रुग्ण' : '👥 View My Patients', type: 'navigate', tab: 'patients' }
      ]
    };
  }

  // 5. Referral Tracking for Authorized Patients
  if (/(referral|refer|attention|हस्तांतरण|रेफरल|रेफर)/i.test(t)) {
    const refs = db.prepare(`
      SELECT r.*, p.name AS patient_name, p.village, f1.name AS from_facility, f2.name AS to_facility
      FROM referrals r
      JOIN patients p ON p.id = r.patient_id
      LEFT JOIN facilities f1 ON f1.id = r.from_facility_id
      JOIN facilities f2 ON f2.id = r.to_facility_id
      WHERE p.asha_id = ?
      ORDER BY r.updated_at DESC
    `).all(ashaId);

    if (!refs.length) {
      return {
        intent: 'asha_referrals',
        reply: isMr
          ? 'तुमच्या रुग्णांसाठी कोणताही सक्रिय रेफरल सापडला नाही.'
          : 'No referrals currently recorded for patients under your care.',
        actions: [{ label: isMr ? '🔁 रेफरल ट्रॅकिंग' : '🔁 Referral Tracking', type: 'navigate', tab: 'referrals' }]
      };
    }

    let reply = isMr
      ? `तुमच्या रुग्णांचे रेफरल ट्रॅकिंग (${refs.length} नोंदी):\n`
      : `Referrals for your authorized patients (${refs.length} records):\n`;

    refs.forEach(r => {
      reply += `\n• ${r.patient_name}: ${r.from_facility || 'PHC'} ➔ ${r.to_facility}\n  स्थिती: ${r.status} | कारण: ${r.reason || 'विशेष तपासणी'}`;
    });

    return {
      intent: 'asha_referrals',
      reply,
      data: refs,
      actions: [{ label: isMr ? '🔁 रेफरल ट्रॅकिंग उघडा' : '🔁 Open Referral Tracking', type: 'navigate', tab: 'referrals' }]
    };
  }

  // 6. Today's Appointments for Assigned Patients
  if (/(appointment|queue|today|भेट|अपॉइंटमेंट|टोकन)/i.test(t)) {
    const appts = db.prepare(`
      SELECT a.*, p.name AS patient_name, p.village, f.name AS facility_name
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      JOIN facilities f ON f.id = a.facility_id
      WHERE p.asha_id = ?
      ORDER BY a.created_at DESC LIMIT 5
    `).all(ashaId);

    if (!appts.length) {
      return {
        intent: 'asha_appointments',
        reply: isMr
          ? 'तुमच्या कोणत्याही रुग्णाची आज नवीन भेट नोंदवलेली नाही.'
          : 'None of your authorized patients have active appointments recorded today.',
        actions: [{ label: isMr ? '👥 रुग्ण यादी' : '👥 My Patients', type: 'navigate', tab: 'patients' }]
      };
    }

    let reply = isMr
      ? `रुग्णांच्या भेटीची माहिती:\n`
      : `Appointments for your patients:\n`;

    appts.forEach(a => {
      reply += `\n• ${a.patient_name} (${a.village}): ${a.facility_name}\n  टोकन: ${a.token} | स्थिती: ${a.status} | वेळ: ${a.est_wait_minutes} मि.`;
    });

    return {
      intent: 'asha_appointments',
      reply,
      data: appts,
      actions: [{ label: isMr ? '👥 रुग्ण व्यवस्थापन' : '👥 My Patients', type: 'navigate', tab: 'patients' }]
    };
  }

  // 7. Follow-up Instructions for Assigned Patients
  if (/(instruction|doctor advice|सूचना|डॉक्टरांच्या सूचना)/i.test(t)) {
    const instrs = db.prepare(`
      SELECT i.*, p.name AS patient_name, p.village
      FROM instructions i
      JOIN patients p ON p.id = i.patient_id
      WHERE p.asha_id = ?
      ORDER BY i.created_at DESC LIMIT 4
    `).all(ashaId);

    if (!instrs.length) {
      return {
        intent: 'asha_instructions',
        reply: isMr
          ? 'तुमच्या रुग्णांसाठी कोणतीही नवीन वैद्यकीय सूचना उपलब्ध नाही.'
          : 'No recent doctor instructions recorded for your patients.',
        actions: [{ label: isMr ? '👥 रुग्ण यादी' : '👥 My Patients', type: 'navigate', tab: 'patients' }]
      };
    }

    let reply = isMr ? 'डॉक्टरांनी रुग्णांसाठी दिलेल्या सूचना:\n' : 'Recent instructions from PHC doctors for your patients:\n';
    instrs.forEach(i => {
      reply += `\n• ${i.patient_name}: ${i.instruction_text}\n  औषध: ${i.medication_info || 'लागू नाही'} (डॉ. ${i.doctor_name || 'PHC'})`;
    });

    return {
      intent: 'asha_instructions',
      reply,
      data: instrs,
      actions: [{ label: isMr ? '👥 रुग्ण व्यवस्थापन' : '👥 My Patients', type: 'navigate', tab: 'patients' }]
    };
  }

  // 8. General Patient Search (if specific name not matched)
  if (/(search patient|find patient|authorized record|रुग्ण शोधा|माहिती)/i.test(t)) {
    return {
      intent: 'asha_search',
      reply: isMr
        ? 'तुम्ही फक्त तुमच्या अधिकारक्षेत्रातील अधिकृत रुग्णांची माहिती पाहू शकता. रुग्णाचे नाव सांगा, उदा. "सुषमा पाटील माहिती दाखवा".'
        : 'You may only access authorized patient records assigned to you. Please state the patient name, for example: "Find record for Sushma Patil".',
      actions: [{ label: isMr ? '👥 अधिकृत रुग्ण यादी' : '👥 View Authorized Patients', type: 'navigate', tab: 'patients' }]
    };
  }

  // Default ASHA Assistant Menu
  return {
    intent: 'asha_general',
    reply: isMr
      ? `नमस्कार ${user.name.split(' ')[0]} ताई! मी केअरनेक्सस आशा व्हॉइस असिस्टंट आहे. तुम्ही खालील आज्ञा वापरू शकता:\n• "आजचे फॉलो-अप दाखवा"\n• "कोणत्या रुग्णांना फॉलो-अपची गरज आहे?"\n• "रुग्णांचा रेफरल स्टेटस शोधा"\n• "आजच्या भेटी दाखवा"\n• "फॉलो-अप सूचना समजून सांगा"`
      : `Hello ${user.name.split(' ')[0]}! I am your CareNexus ASHA Assistant. You can speak or ask:\n• "Show my follow-ups for today"\n• "Which patients need follow-up?"\n• "Find the referral status for this patient"\n• "Show today's appointments"\n• "Help me understand the follow-up instructions"`,
    actions: [
      { label: isMr ? '📅 फॉलो-अप व्यवस्थापन' : '📅 Follow-Up Module', type: 'navigate', tab: 'followups' },
      { label: isMr ? '👥 माझे रुग्ण' : '👥 My Patients', type: 'navigate', tab: 'patients' },
      { label: isMr ? '🔁 रेफरल ट्रॅकिंग' : '🔁 Referral Tracking', type: 'navigate', tab: 'referrals' }
    ]
  };
}

module.exports = {
  getAuthContext,
  handlePatientQuery,
  handleAshaQuery,
  cleanTextForSpeech,
  detectLanguage
};
