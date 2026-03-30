// ================================================================
// ELEVATE CONSTRUCTION LLC — HQ Backend Server v2
// Persistent storage · Gmail · Outlook · Zapier · Vapi
// Deploy on Railway.app
// ================================================================

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Persistent storage ────────────────────────────────────────
const DATA_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'db.json')
  : path.join(__dirname, 'db.json');

function loadDB(){
  try{ if(fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e){ console.error('[DB] Load error:',e.message); }
  return { leads:[], tasks:[], employees:[], emailLog:[], callLog:[] };
}
function saveDB(db){
  try{ fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2)); }
  catch(e){ console.error('[DB] Save error:',e.message); }
}
function buildLead(data, source){
  return {
    id:           Date.now()+Math.floor(Math.random()*1000),
    name:         data.name||'Unknown',
    email:        data.email||'',
    phone:        data.phone||'',
    address:      data.address||'',
    project_type: data.project_type||data.project||'Inquiry',
    budget:       data.budget||'TBD',
    timeline:     data.timeline||'Flexible',
    source:       source||data.source||'Unknown',
    message:      data.message||'',
    stage:        'new',
    created_at:   new Date().toISOString()
  };
}

let db = loadDB();
console.log(`[DB] Loaded — ${db.leads.length} leads`);

// ── Health / Test ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status:'online', company:'Elevate Construction LLC', version:'2.0.0',
  stats:{ leads:db.leads.length, tasks:db.tasks.length, calls:db.callLog.length }
}));

app.get('/test', (req, res) => res.json({
  success:true, message:'Elevate HQ server is working!',
  time:new Date().toISOString(), leads:db.leads.length, tasks:db.tasks.length,
  storage:fs.existsSync(DATA_FILE)?'persistent':'in-memory'
}));

// ── Lead intake (POST) ────────────────────────────────────────
app.post('/api/lead', (req, res) => {
  const lead = buildLead(req.body, req.body.source||'Website');
  db.leads.push(lead); saveDB(db);
  console.log(`[Lead] ${lead.name} from ${lead.source}`);
  res.json({ success:true, lead_id:lead.id });
});

// ── Lead intake (GET — for URL param webhooks) ────────────────
app.get('/api/lead', (req, res) => {
  if(!req.query.name && !req.query.email && !req.query.phone)
    return res.json({ success:false, message:'No data' });
  const lead = buildLead(req.query, req.query.source||'Website');
  db.leads.push(lead); saveDB(db);
  res.json({ success:true, lead_id:lead.id });
});

// ── Get all leads ─────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  res.json({ success:true, count:db.leads.length, leads:db.leads });
});

// ── Zapier webhook (Houzz leads) ──────────────────────────────
app.post('/webhook/zapier', (req, res) => {
  const d = req.body;
  const lead = buildLead({
    name:         d.name||d.contact_name||d.full_name||'Houzz Lead',
    email:        d.email||d.email_address||'',
    phone:        d.phone||d.phone_number||'',
    address:      d.address||d.location||'',
    project_type: d.project_type||d.service||d.category||'Houzz Inquiry',
    budget:       d.budget||d.project_budget||'TBD',
    message:      d.message||d.description||d.project_details||''
  }, 'Houzz via Zapier');
  db.leads.push(lead); saveDB(db);
  console.log(`[Zapier] ${lead.name}`);
  res.json({ success:true, lead_id:lead.id, name:lead.name });
});

// ── Gmail webhook (Google Pub/Sub) ────────────────────────────
app.post('/webhook/gmail', (req, res) => {
  try{
    const msg = req.body.message;
    if(msg?.data){
      const decoded = Buffer.from(msg.data,'base64').toString('utf-8');
      const parsed  = JSON.parse(decoded);
      db.emailLog.push({ source:'gmail', email:parsed.emailAddress, received_at:new Date().toISOString() });
      saveDB(db);
      console.log('[Gmail] Notification for:', parsed.emailAddress);
    }
    res.status(200).json({ success:true });
  }catch(e){ res.status(200).json({ success:true }); }
});

// ── Outlook webhook (Microsoft Graph) ────────────────────────
app.post('/webhook/outlook', (req, res) => {
  if(req.query.validationToken)
    return res.status(200).type('text/plain').send(req.query.validationToken);
  try{
    (req.body.value||[]).forEach(n=>{
      db.emailLog.push({ source:'outlook', changeType:n.changeType, received_at:new Date().toISOString() });
    });
    saveDB(db);
    res.status(200).json({ success:true });
  }catch(e){ res.status(200).json({ success:true }); }
});

// ── Vapi receptionist webhook ─────────────────────────────────
app.post('/webhook/vapi', (req, res) => {
  const userSaid    = req.body?.message?.content||req.body?.transcript||'';
  const callerPhone = req.body?.call?.customer?.number||'unknown';
  const lower       = userSaid.toLowerCase();

  console.log(`[Vapi] ${callerPhone}: "${userSaid.slice(0,80)}"`);
  db.callLog.push({ phone:callerPhone, message:userSaid, received_at:new Date().toISOString() });

  // Auto-create lead from call
  if(callerPhone!=='unknown' && !db.leads.find(l=>l.phone===callerPhone)){
    db.leads.push(buildLead({ name:'Phone Caller', phone:callerPhone, message:userSaid }, 'Vapi Phone Call'));
  }
  saveDB(db);

  let response = '';
  if(lower.includes('estimate')||lower.includes('quote')||lower.includes('price'))
    response = `Absolutely, I'd love to get you a free estimate! Our team responds within 24 hours. Can I get your name and best callback number?`;
  else if(lower.includes('emergency')||lower.includes('flood')||lower.includes('storm')||lower.includes('damage'))
    response = `I understand this is urgent. Our emergency response team is available now. Please call 404-719-1888 directly or give me your address and we'll dispatch someone immediately.`;
  else if(lower.includes('hours')||lower.includes('open'))
    response = `We're available Monday through Friday 7am to 6pm, Saturday 8am to 4pm, with 24-hour emergency response for storm and water damage.`;
  else if(lower.includes('location')||lower.includes('address')||lower.includes('where'))
    response = `Our office is at 3343 Peachtree Road Northeast Suite 145, Atlanta Georgia 30326. We serve the full Atlanta metro area.`;
  else if(lower.includes('service')||lower.includes('specialize')||lower.includes('what do'))
    response = `Elevate Construction specializes in commercial and residential framing, roofing, concrete and flatwork, welding and steel fabrication, and mitigation and restoration for water, fire, and storm damage. Which service can I help you with?`;
  else
    response = `Thank you for calling Elevate Construction LLC, Atlanta's premier builder. We specialize in framing, roofing, concrete, welding, and restoration. How can I help you today?`;

  res.json({ results:[{ toolCallId:req.body?.toolCallList?.[0]?.id||'response', result:response }] });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Elevate HQ Server v2 — port ${PORT}`);
  console.log(`   ${db.leads.length} leads stored | Storage: ${DATA_FILE}\n`);
});

module.exports = app;
