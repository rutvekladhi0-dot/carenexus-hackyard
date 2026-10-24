// =========================================================
// CareNexus Voice AI Assistant Service
// Role-based, grounded in local CareNexus SQLite database.
// Supports Patients in US English (en-US) & Hindi (hi-IN).
// Integrates with ElevenLabs Text-to-Speech technology.
// =========================================================

const { db } = require('./db');

// ---------- Authentication Helper ----------
const authUserStmt = db.prepare('SELECT id, name, role, language, facility_id FROM users WHERE id = ?');
const authPatientStmt = db.prepare('SELECT * FROM patients WHERE user_id = ?');

function getAuthContext(req) {
  const userId = req.headers['x-user-id'] || req.body?.user_id || req.query?.user_id;
  if (!userId) return null;

  const user = authUserStmt.get(Number(userId));
  if (!user) return null;

  let patient = null;
  if (user.role === 'patient') {
    patient = authPatientStmt.get(user.id);
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

// ---------- Intent Matchers & Language Detection ----------

function detectLanguage(text, preferred) {
  if (preferred === 'mr-IN' || preferred === 'mr') return 'mr-IN';
  if (preferred === 'hi-IN' || preferred === 'hi') return 'hi-IN';
  if (preferred === 'en-US' || preferred === 'en') return 'en-US';

  // Marathi script / vocabulary detection
  if (/(आहे|नाही|कसे|कधी|काय|माझे|माझी|करावे|होते|येथे|कुठे|सांगा|मला|तुम्ही|औषध|तपासणी|रुग्ण)/i.test(text)) return 'mr-IN';

  // Devanagari script defaults to Hindi (hi-IN)
  if (/[\u0900-\u097F]/.test(text)) return 'hi-IN';
  return 'en-US';
}

// ---------- Agent 37 Cloud LLM Integration ----------
async function callAgent37(text, patient, user, lang) {
  const apiKey = process.env.AGENT37_API_KEY;
  if (!apiKey) return null;

  const isMr = (lang === 'mr-IN' || lang === 'mr' || /(मराठी|आहे|नाही|काय|कसे|सांगा|माझे|माझी|मला)/i.test(text));
  const isHi = (lang === 'hi-IN' || lang === 'hi' || /[\u0900-\u097F]/.test(text));
  const targetLang = isMr ? 'Marathi (मराठी)' : (isHi ? 'Hindi (हिंदी)' : 'English');

  // Grounding context from DB
  let context = `Patient: ${patient?.name || user?.name || 'Patient'}, ID: ${patient?.id || user?.id || ''}.`;
  try {
    if (patient?.id) {
      const activeAppt = db.prepare(`SELECT a.token, a.status, f.name AS facility_name FROM appointments a JOIN facilities f ON f.id = a.facility_id WHERE a.patient_id = ? AND a.status IN ('Waiting', 'In Consultation') LIMIT 1`).get(patient.id);
      if (activeAppt) context += ` Active Appointment: Token #${activeAppt.token} at ${activeAppt.facility_name} (Status: ${activeAppt.status}).`;
      const instr = db.prepare(`SELECT doctor_name, advice FROM instructions WHERE patient_id = ? ORDER BY created_at DESC LIMIT 1`).get(patient.id);
      if (instr) context += ` Recent Doctor Advice: by Dr. ${instr.doctor_name || 'Medical Officer'} (${instr.advice || ''}).`;
    }
  } catch (_) {}

  const systemPrompt = `You are CareNexus AI Health Assistant, powered by Agent 37. You assist patients in Indian public healthcare (PHC/CHC/Hospitals) with empathetic guidance, appointment workflows, and wellness information.
Patient Medical Profile: ${context}
Target Response Language: ${targetLang}.
Guidelines:
1. Respond concisely (2-4 clear sentences) in ${targetLang}. Keep tone warm, respectful, and reassuring.
2. Do NOT prescribe medications, adjust doses, or claim definitive diagnosis.
3. For life-threatening symptoms, immediately advise calling 112 emergency.
4. Suitable for direct reading and voice Text-to-Speech playback.`;

  try {
    const res = await fetch('https://api.agent37.com/llm/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-API-Key': apiKey
      },
      body: JSON.stringify({
        model: 'default',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: 0.4,
        max_tokens: 300
      }),
      signal: AbortSignal.timeout(9000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn('Agent 37 API returned status:', res.status, errText);
      return null;
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (reply) {
      return {
        intent: 'agent37_response',
        reply: reply,
        powered_by: 'Agent 37 AI',
        actions: [
          { label: isMr ? '🎫 माझ्या अपॉइंटमेंट्स' : (isHi ? '🎫 अपॉइंटमेंट्स और कतार' : '🎫 My Queue'), type: 'navigate', tab: 'queue' },
          { label: isMr ? '📍 जवळचे केंद्र शोधा' : (isHi ? '📍 स्वास्थ्य केंद्र खोजें' : '📍 Find Care'), type: 'navigate', tab: 'findcare' },
          { label: isMr ? '💊 औषधे व निर्देश' : (isHi ? '💊 निर्देश और दवाइयां' : '💊 Instructions'), type: 'navigate', tab: 'care' }
        ]
      };
    }
  } catch (err) {
    console.warn('Agent 37 query failed, falling back:', err.message);
  }
  return null;
}

async function handlePatientQuery(text, patient, user, lang) {
  const t = text.toLowerCase();
  const isHi = (lang === 'hi-IN' || lang === 'hi');

  // 1. Emergency detection (Safety First!)
  if (/(emergency|ambulance|112|chest pain|bleeding|accident|unconscious|heart attack|आपातकाल|आपातकालीन|एम्बुलेंस|दुर्घटना|छाती में दर्द|खून बहना|बेहोश)/i.test(t)) {
    return {
      intent: 'emergency',
      reply: isHi
        ? '🚨 आपातकालीन सूचना (Immediate Emergency): यदि आप या कोई अन्य व्यक्ति तत्काल खतरे में है, तो कृपया तुरंत 112 पर कॉल करें। आप केयरनेक्सस इमरजेंसी एसओएस (Emergency SOS) सुविधा का भी उपयोग कर सकते हैं।'
        : '🚨 IMMEDIATE EMERGENCY: If you or someone else is in immediate danger, please call 112 right now. You can also use the CareNexus Emergency SOS coordination feature.',
      actions: [
        { label: isHi ? '📞 तुरंत 112 पर कॉल करें' : '📞 Call 112 Now', type: 'tel', href: 'tel:112' },
        { label: isHi ? '🚨 इमरजेंसी SOS खोलें' : '🚨 Open Emergency SOS', type: 'navigate', tab: 'sos' }
      ]
    };
  }

  // 2. Medical Advice / Diagnosis refusal (Safety Guardrail - evaluate before routine instruction lookup!)
  if (/(what (medicine|tablet|drug|dose) should i take|can i stop (taking|my)|diagnos|prescribe|cure for|remedy for|what disease|fever|cough|headache|pain|symptom|illness|दवा बताओ|दवाई बताओ|इलाज|बीमारी|बुखार|खांसी|सिरदर्द|दर्द|लक्षण)/i.test(t)) {
    return {
      intent: 'medical_safety',
      reply: isHi
        ? '⚠️ चिकित्सा सुरक्षा सूचना: एक AI सहायक के रूप में, मैं बीमारियों का निदान नहीं कर सकता और न ही दवाइयां लिख या बदल सकता हूँ। उचित जांच व उपचार के लिए कृपया अपने नजदीकी प्राथमिक स्वास्थ्य केंद्र (PHC) या अस्पताल में डॉक्टर से परामर्श लें, या अपनी आशा कार्यकर्ता से संपर्क करें।'
        : '⚠️ Medical Safety Note: As an AI assistant, I cannot diagnose illnesses or recommend changing medications. Please book an appointment with a qualified doctor at your nearest PHC/hospital or speak with your ASHA worker.',
      actions: [
        { label: isHi ? '📍 स्वास्थ्य केंद्र खोजें' : '📍 Find Nearby PHC', type: 'navigate', tab: 'findcare' },
        { label: isHi ? '🚨 इमरजेंसी SOS' : '🚨 Emergency SOS', type: 'navigate', tab: 'sos' }
      ]
    };
  }

  // 3. Appointments & Queue Status (Next appointment, active token, wait time)
  if (/(appointment|next appointment|upcoming appointment|token|queue|wait|consultation|अपॉइंटमेंट|मुलाकात|तारीख|टोकन|कतार|प्रतीक्षा|कब है)/i.test(t) && !/(instruction|doctor advice|निर्देश)/i.test(t)) {
    const appts = db.prepare(`SELECT a.*, f.name AS facility_name, f.type AS facility_type 
      FROM appointments a JOIN facilities f ON f.id = a.facility_id 
      WHERE a.patient_id = ? ORDER BY a.created_at DESC`).all(patient.id);

    const active = appts.find(a => a.status === 'Waiting' || a.status === 'In Consultation');

    if (active) {
      const reply = isHi
        ? `आपकी सक्रिय अपॉइंटमेंट ${active.facility_name} में है:\n• टोकन नंबर: ${active.token}\n• स्थिति: ${active.status}\n• अनुमानित प्रतीक्षा समय: ${active.est_wait_minutes} मिनट\n• प्रकार: ${active.mode}`
        : `You have an active appointment at ${active.facility_name}.\n• Token: ${active.token}\n• Status: ${active.status}\n• Estimated wait: ${active.est_wait_minutes} minutes\n• Mode: ${active.mode}`;
      return {
        intent: 'appointment',
        reply,
        data: [active],
        actions: [{ label: isHi ? '🎫 अपॉइंटमेंट्स और कतार देखें' : '🎫 View Appointments & Queue', type: 'navigate', tab: 'queue' }]
      };
    } else if (appts.length) {
      const latest = appts[0];
      const reply = isHi
        ? `वर्तमान में आपका कोई प्रतीक्षा टोकन नहीं है। आपकी पिछली अपॉइंटमेंट ${latest.facility_name} में थी (स्थिति: ${latest.status}, कारण: ${latest.reason})। नई अपॉइंटमेंट बुक करने के लिए Find Care का उपयोग करें।`
        : `You have no waiting queue token right now. Your most recent appointment was at ${latest.facility_name} (Status: ${latest.status}, Reason: ${latest.reason}). You can book a new appointment via Find Care.`;
      return {
        intent: 'appointment',
        reply,
        data: [latest],
        actions: [
          { label: isHi ? '📍 अपॉइंटमेंट बुक करें' : '📍 Find Care & Book', type: 'navigate', tab: 'findcare' },
          { label: isHi ? '🎫 इतिहास देखें' : '🎫 View History', type: 'navigate', tab: 'queue' }
        ]
      };
    } else {
      return {
        intent: 'appointment',
        reply: isHi
          ? 'आपके खाते के लिए कोई अपॉइंटमेंट दर्ज नहीं है। आप Find Care का उपयोग करके स्वास्थ्य केंद्र खोज सकते हैं और अपॉइंटमेंट बुक कर सकते हैं।'
          : 'No appointments found for your account. You can search facilities and book an appointment using Find Care.',
        actions: [{ label: isHi ? '📍 स्वास्थ्य केंद्र खोजें' : '📍 Find Care', type: 'navigate', tab: 'findcare' }]
      };
    }
  }

  // 4. Doctor Instructions & Recorded Medicines
  if (/(instruction|medicine|medication|prescription|doctor say|dose|tablet|निर्देश|दवा|दवाई|गोली|खुराक|डॉक्टर ने क्या कहा)/i.test(t)) {
    const instrs = db.prepare('SELECT * FROM instructions WHERE patient_id = ? ORDER BY created_at DESC LIMIT 3').all(patient.id);
    if (!instrs.length) {
      return {
        intent: 'instructions',
        reply: isHi
          ? 'आपके लिए अभी तक कोई चिकित्सा निर्देश या दवाइयां दर्ज नहीं की गई हैं। कृपया अपने प्राथमिक स्वास्थ्य केंद्र के डॉक्टर या आशा कार्यकर्ता से संपर्क करें।'
          : 'No healthcare instructions or medicines have been recorded for you yet. Please consult your PHC doctor or ASHA worker.',
        actions: [{ label: isHi ? '💊 निर्देश और दवाइयां' : '💊 Instructions & Medicines', type: 'navigate', tab: 'care' }]
      };
    }

    const latest = instrs[0];
    let reply = '';
    if (isHi) {
      reply = `आपके डॉक्टर (${latest.doctor_name || 'चिकित्सा अधिकारी'}) ने निम्नलिखित निर्देश दर्ज किए हैं:\n• निर्देश: ${latest.instruction_text}`;
      if (latest.medication_info) reply += `\n• दवाइयां: ${latest.medication_info}`;
      if (latest.next_visit) reply += `\n• अगली मुलाकात: ${latest.next_visit}`;
      reply += '\n\nकृपया दवाइयां हमेशा डॉक्टर की सलाह के अनुसार ही लें। अपनी मर्जी से खुराक न बदलें।';
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
      actions: [{ label: isHi ? '💊 निर्देश और दवाइयां देखें' : '💊 View Instructions & Medicines', type: 'navigate', tab: 'care' }]
    };
  }

  // 5. Referral Status
  if (/(referral|refer|रेफरल|रेफर|स्थानांतरण)/i.test(t)) {
    const refs = db.prepare(`SELECT r.*, f1.name AS from_facility, f2.name AS to_facility 
      FROM referrals r 
      LEFT JOIN facilities f1 ON f1.id = r.from_facility_id 
      JOIN facilities f2 ON f2.id = r.to_facility_id 
      WHERE r.patient_id = ? ORDER BY r.created_at DESC`).all(patient.id);

    if (!refs.length) {
      return {
        intent: 'referral',
        reply: isHi
          ? 'आपके खाते में कोई रेफरल दर्ज नहीं है। आपकी देखभाल स्थानीय स्वास्थ्य केंद्र में जारी है।'
          : 'No referrals have been recorded for your account.',
        actions: [{ label: isHi ? '🔁 रेफरल स्थिति' : '🔁 Referral Status', type: 'navigate', tab: 'referral' }]
      };
    }

    const r = refs[0];
    const reply = isHi
      ? `आपके रेफरल का विवरण:\n• कहाँ से: ${r.from_facility || 'स्वास्थ्य केंद्र'}\n• कहाँ के लिए: ${r.to_facility}\n• कारण: ${r.reason || 'विशेषज्ञ जांच'}\n• स्थिति: ${r.status}`
      : `Your referral details:\n• From: ${r.from_facility || 'Primary Facility'}\n• To: ${r.to_facility}\n• Reason: ${r.reason || 'Specialist Care'}\n• Status: ${r.status}`;

    return {
      intent: 'referral',
      reply,
      data: refs,
      actions: [{ label: isHi ? '🔁 रेफरल स्थिति देखें' : '🔁 View Referral Status', type: 'navigate', tab: 'referral' }]
    };
  }

  // 6. Follow-ups & Alerts
  if (/(follow|follow-up|followup|alert|reminder|फॉलो-अप|फॉलोअप|रिमाइंडर|सूचना)/i.test(t)) {
    const follows = db.prepare(`SELECT * FROM follow_ups WHERE patient_id = ? ORDER BY due_date ASC`).all(patient.id);
    const due = follows.filter(f => f.status === 'Due');

    if (due.length) {
      const f = due[0];
      const reply = isHi
        ? `आपका आगामी फॉलो-अप लंबित है:\n• प्रकार: ${f.type} देखभाल\n• देय तिथि: ${f.due_date}\n• विवरण: ${f.notes || 'नियमित फॉलो-अप'}\n• स्थिति: लंबित (Due)`
        : `You have an upcoming follow-up due:\n• Type: ${f.type} Care\n• Due Date: ${f.due_date}\n• Notes: ${f.notes || 'Routine follow-up'}\n• Status: Due`;
      return {
        intent: 'followup',
        reply,
        data: due,
        actions: [{ label: isHi ? '🔔 फॉलो-अप और अलर्ट देखें' : '🔔 Follow-up & Alerts', type: 'navigate', tab: 'followup' }]
      };
    } else {
      return {
        intent: 'followup',
        reply: isHi
          ? 'वर्तमान में आपका कोई लंबित फॉलो-अप नहीं है। सभी फॉलो-अप पूर्ण हैं।'
          : 'You have no pending follow-ups due at this time. All follow-ups are up to date.',
        actions: [{ label: isHi ? '🔔 फॉलो-अप इतिहास' : '🔔 Follow-up History', type: 'navigate', tab: 'followup' }]
      };
    }
  }

  // 7. Find Nearby Healthcare Facilities
  if (/(facility|hospital|phc|chc|clinic|doctor near|find care|अस्पताल|दवाखाना|स्वास्थ्य केंद्र|क्लिनिक|डॉक्टर कहां)/i.test(t)) {
    const facs = db.prepare(`SELECT name, type, area, crowd_status, doctors_available, doctors_total, queue_waiting FROM facilities LIMIT 4`).all();
    let reply = isHi
      ? 'केयरनेक्सस नेटवर्क के नजदीकी स्वास्थ्य केंद्र:\n'
      : 'Here are nearby healthcare facilities in the CareNexus network:\n';

    facs.forEach(f => {
      reply += isHi
        ? `\n• ${f.name} (${f.type}, ${f.area}) — भीड़: ${f.crowd_status}, उपलब्ध डॉक्टर: ${f.doctors_available}/${f.doctors_total}`
        : `\n• ${f.name} (${f.type}, ${f.area}) — Crowd: ${f.crowd_status}, Doctors available: ${f.doctors_available}/${f.doctors_total}`;
    });

    return {
      intent: 'facilities',
      reply,
      data: facs,
      actions: [{ label: isHi ? '📍 स्वास्थ्य केंद्र खोजें (Find Care)' : '📍 Search Map & Facilities', type: 'navigate', tab: 'findcare' }]
    };
  }

  // 8. Health Records
  if (/(record|report|history|test|रिकॉर्ड|रिपोर्ट|इतिहास|जांच)/i.test(t)) {
    const records = db.prepare(`SELECT * FROM health_records WHERE patient_id = ? ORDER BY created_at DESC LIMIT 3`).all(patient.id);
    if (!records.length) {
      return {
        intent: 'records',
        reply: isHi
          ? 'आपके खाते के लिए अभी तक कोई डिजिटल स्वास्थ्य रिकॉर्ड अपलोड नहीं किया गया है।'
          : 'No digital health records have been uploaded for your account yet.',
        actions: [{ label: isHi ? '📋 स्वास्थ्य रिकॉर्ड' : '📋 Health Records', type: 'navigate', tab: 'records' }]
      };
    }

    let reply = isHi ? 'आपके हालिया डिजिटल स्वास्थ्य रिकॉर्ड:\n' : 'Here are your recent health records:\n';
    records.forEach(r => {
      reply += `\n• ${r.title} (${r.record_type}) — ${r.doctor_name || (isHi ? 'चिकित्सा अधिकारी' : 'Medical Officer')}\n  ${r.details || ''}`;
    });

    return {
      intent: 'records',
      reply,
      data: records,
      actions: [{ label: isHi ? '📋 सभी रिकॉर्ड देखें' : '📋 View All Records', type: 'navigate', tab: 'records' }]
    };
  }

  // Try Agent 37 LLM for intelligent guidance and general queries
  if (process.env.AGENT37_API_KEY) {
    const aiResp = await callAgent37(text, patient, user, lang);
    if (aiResp) return aiResp;
  }

  // Default Fallback
  const isMr = (lang === 'mr-IN' || lang === 'mr' || /(मराठी|आहे|नाही|काय|कसे|सांगा|माझे|माझी|मला)/i.test(text));
  return {
    intent: 'general',
    reply: isMr
      ? `नमस्कार ${patient.name.split(' ')[0]}! मी तुमचा CareNexus Voice Assistant आहे. तुम्ही मला विचारू शकता:\n• "माझी पुढील अपॉइंटमेंट कधी आहे?"\n• "माझ्या रेफरलची स्थिती काय आहे?"\n• "माझ्या औषधांचे निर्देश सांगा"\n• "जवळचे आरोग्य केंद्र शोधा"`
      : (isHi
        ? `नमस्ते ${patient.name.split(' ')[0]}! मैं आपका CareNexus Voice Assistant हूँ। आप मुझसे पूछ सकते हैं:\n• "मेरी अगली अपॉइंटमेंट कब है?"\n• "मेरे रेफरल की स्थिति क्या है?"\n• "मेरी दवाइयों के निर्देश बताएं"\n• "पास का अस्पताल खोजें"`
        : `Hello ${patient.name.split(' ')[0]}! I am your CareNexus Voice Assistant. You can ask me:\n• "When is my next appointment?"\n• "What is the status of my referral?"\n• "Explain the medicine instructions recorded for me"\n• "Help me find a nearby healthcare facility"`),
    actions: [
      { label: isMr ? '🎫 माझ्या अपॉइंटमेंट्स' : (isHi ? '🎫 अपॉइंटमेंट्स और कतार' : '🎫 My Queue'), type: 'navigate', tab: 'queue' },
      { label: isMr ? '💊 औषधे व निर्देश' : (isHi ? '💊 निर्देश और दवाइयां' : '💊 Instructions'), type: 'navigate', tab: 'care' },
      { label: isMr ? '🔁 रेफरल स्थिती' : (isHi ? '🔁 रेफरल स्थिति' : '🔁 Referrals'), type: 'navigate', tab: 'referral' }
    ]
  };
}

module.exports = {
  getAuthContext,
  handlePatientQuery,
  cleanTextForSpeech,
  detectLanguage
};
