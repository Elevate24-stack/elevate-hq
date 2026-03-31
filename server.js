// ================================================================
// ELEVATE CONSTRUCTION LLC — HQ Backend Server v3
// Full Outlook email fetching via Microsoft Graph
// ================================================================

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
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
  return { leads:[], tasks:[], employees:[], emailLog:[], emails:[], callLog:[] };
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
if(!db.emails) db.emails = [];
console.log(`[DB] Loaded — ${db.leads.length} leads, ${db.emails.length} emails`);

// ── Outlook / Microsoft Graph state ──────────────────────────
let outlookConfig = {};
let outlookToken  = null;
let tokenExpiry   = 0;
let gmailConfig   = {};

// ── Get Microsoft Graph OAuth token ──────────────────────────
async function getMSToken(){
  if(outlookToken && Date.now() < tokenExpiry - 60000) return outlookToken;
  const cfg = outlookConfig;
  if(!cfg.tenant_id || !cfg.client_id || !cfg.client_secret)
    throw new Error('Outlook credentials not configured yet');

  return new Promise((resolve, reject)=>{
    const body = new URLSearchParams({
      grant_type:'client_credentials', client_id:cfg.client_id,
      client_secret:cfg.client_secret, scope:'https://graph.microsoft.com/.default'
    }).toString();
    const opts = {
      hostname:'login.microsoftonline.com',
      path:`/${cfg.tenant_id}/oauth2/v2.0/token`,
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':body.length}
    };
    const req = https.request(opts, res=>{
      let data=''; res.on('data',c=>data+=c);
      res.on('end',()=>{
        try{
          const d=JSON.parse(data);
          if(d.access_token){ outlookToken=d.access_token; tokenExpiry=Date.now()+(d.expires_in||3599)*1000; resolve(outlookToken); }
          else reject(new Error(d.error_description||'Token failed: '+JSON.stringify(d)));
        }catch(e){ reject(e); }
      });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}

// ── Fetch emails from Microsoft Graph ────────────────────────
async function fetchOutlookEmails(max=20){
  const token  = await getMSToken();
  const userId = outlookConfig.email;
  return new Promise((resolve, reject)=>{
    const opts = {
      hostname:'graph.microsoft.com',
      path:`/v1.0/users/${encodeURIComponent(userId)}/messages?$top=${max}&$select=id,subject,from,receivedDateTime,bodyPreview,isRead&$orderby=receivedDateTime desc`,
      method:'GET',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}
    };
    const req = https.request(opts, res=>{
      let data=''; res.on('data',c=>data+=c);
      res.on('end',()=>{
        try{
          const d=JSON.parse(data);
          if(d.value){ resolve(d.value); }
          else reject(new Error(d.error?.message||'Graph error: '+JSON.stringify(d)));
        }catch(e){ reject(e); }
      });
    });
    req.on('error',reject); req.end();
  });
}

// ── Register Microsoft Graph subscription ────────────────────
async function registerGraphSubscription(){
  try{
    const token   = await getMSToken();
    const userId  = outlookConfig.email;
    const expiry  = new Date(Date.now()+3*24*60*60*1000).toISOString();
    const body    = JSON.stringify({
      changeType:'created,updated',
      notificationUrl:'https://elevate-hq-production.up.railway.app/webhook/outlook',
      resource:`/users/${userId}/messages`,
      expirationDateTime:expiry,
      clientState:'ElevateHQ-2026'
    });
    return new Promise((resolve)=>{
      const opts = {
        hostname:'graph.microsoft.com', path:'/v1.0/subscriptions', method:'POST',
        headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
      };
      const req = https.request(opts, res=>{
        let data=''; res.on('data',c=>data+=c);
        res.on('end',()=>{
          try{ const d=JSON.parse(data); if(d.id){ console.log('[Outlook] Subscription registered:', d.id); resolve(d); } else { console.error('[Outlook] Sub error:',JSON.stringify(d)); resolve(null); } }
          catch(e){ resolve(null); }
        });
      });
      req.on('error',e=>{ console.error('[Outlook] Sub req error:',e.message); resolve(null); });
      req.write(body); req.end();
    });
  }catch(e){ console.error('[Outlook] Sub failed:',e.message); return null; }
}

// ── Health ────────────────────────────────────────────────────
app.get('/test', (req, res) => res.json({
  success:true, message:'Elevate HQ server is working!',
  time:new Date().toISOString(), leads:db.leads.length,
  emails:db.emails.length, storage:fs.existsSync(DATA_FILE)?'persistent':'in-memory',
  outlook_connected:!!outlookConfig.client_id
}));

app.get('/', (req, res) => res.json({
  status:'online', company:'Elevate Construction LLC', version:'3.0.0',
  stats:{ leads:db.leads.length, emails:db.emails.length, calls:db.callLog.length }
}));

// ── Leads ─────────────────────────────────────────────────────
app.post('/api/lead', (req, res) => {
  const lead = buildLead(req.body, req.body.source||'Website');
  db.leads.push(lead); saveDB(db);
  res.json({ success:true, lead_id:lead.id });
});
app.get('/api/lead', (req, res) => {
  if(!req.query.name && !req.query.email && !req.query.phone)
    return res.json({ success:false, message:'No data' });
  const lead = buildLead(req.query, req.query.source||'Website');
  db.leads.push(lead); saveDB(db);
  res.json({ success:true, lead_id:lead.id });
});
app.get('/api/leads', (req, res) => res.json({ success:true, count:db.leads.length, leads:db.leads }));

// ── Gmail config ──────────────────────────────────────────────
app.post('/api/gmail-config', (req, res) => {
  const { email, token } = req.body;
  gmailConfig = { email, token, updated:new Date().toISOString() };
  console.log('[Gmail] Config saved for:', email);
  res.json({ success:true, message:'Gmail config saved', email });
});

// ── Outlook config ────────────────────────────────────────────
app.post('/api/outlook-config', async (req, res) => {
  const { email, tenant_id, client_id, client_secret } = req.body;
  outlookConfig = { email, tenant_id, client_id, client_secret, updated:new Date().toISOString() };
  outlookToken  = null;
  console.log('[Outlook] Config saved for:', email);
  try{
    await getMSToken();
    console.log('[Outlook] Credentials verified ✅');
    const sub = await registerGraphSubscription();
    res.json({ success:true, message:'Outlook connected! Credentials verified.', email, subscription:sub?{id:sub.id}:'pending' });
  }catch(e){
    console.error('[Outlook] Credential test failed:', e.message);
    res.json({ success:false, message:'Config saved but credentials failed: '+e.message, hint:'Check Client Secret Value (not ID) and that Mail.Read has admin consent.' });
  }
});

// ── Fetch emails (called by app) ──────────────────────────────
app.get('/api/emails', async (req, res) => {
  try{
    if(!outlookConfig.client_id) return res.json({ success:true, emails:db.emails, source:'cache' });
    const raw    = await fetchOutlookEmails(30);
    const emails = raw.map(m=>({
      id:m.id, subject:m.subject||'(no subject)',
      from:m.from?.emailAddress?.address||'',
      from_name:m.from?.emailAddress?.name||'',
      preview:m.bodyPreview||'',
      received_at:m.receivedDateTime,
      unread:!m.isRead, source:'outlook'
    }));
    const existingIds = new Set(db.emails.map(e=>e.id));
    const newEmails   = emails.filter(e=>!existingIds.has(e.id));
    if(newEmails.length){ db.emails=[...newEmails,...db.emails].slice(0,200); saveDB(db); }
    res.json({ success:true, count:emails.length, emails, new_count:newEmails.length });
  }catch(e){
    res.json({ success:true, emails:db.emails, source:'cache', error:e.message });
  }
});

// ── Zapier webhook ────────────────────────────────────────────
app.post('/webhook/zapier', (req, res) => {
  const d=req.body;
  const lead=buildLead({ name:d.name||d.contact_name||d.full_name||'Houzz Lead', email:d.email||d.email_address||'', phone:d.phone||d.phone_number||'', project_type:d.project_type||d.service||'Houzz Inquiry', budget:d.budget||'TBD', message:d.message||d.description||'' },'Houzz via Zapier');
  db.leads.push(lead); saveDB(db);
  console.log(`[Zapier] ${lead.name}`);
  res.json({ success:true, lead_id:lead.id });
});

// ── Gmail webhook ─────────────────────────────────────────────
app.post('/webhook/gmail', (req, res) => {
  try{
    const msg=req.body.message;
    if(msg?.data){ const decoded=Buffer.from(msg.data,'base64').toString('utf-8'); const parsed=JSON.parse(decoded); db.emailLog.push({source:'gmail',email:parsed.emailAddress,received_at:new Date().toISOString()}); saveDB(db); }
    res.status(200).json({success:true});
  }catch(e){ res.status(200).json({success:true}); }
});

// ── Outlook webhook ───────────────────────────────────────────
app.post('/webhook/outlook', async (req, res) => {
  if(req.query.validationToken){
    console.log('[Outlook] Validation handshake');
    return res.status(200).type('text/plain').send(req.query.validationToken);
  }
  try{
    const notifications=req.body.value||[];
    notifications.forEach(n=>db.emailLog.push({source:'outlook',changeType:n.changeType,received_at:new Date().toISOString()}));
    saveDB(db);
    // Fetch new emails in background
    if(notifications.length && outlookConfig.client_id){
      fetchOutlookEmails(10).then(raw=>{
        const emails=raw.map(m=>({id:m.id,subject:m.subject||'(no subject)',from:m.from?.emailAddress?.address||'',from_name:m.from?.emailAddress?.name||'',preview:m.bodyPreview||'',received_at:m.receivedDateTime,unread:!m.isRead,source:'outlook'}));
        const existing=new Set(db.emails.map(e=>e.id));
        const fresh=emails.filter(e=>!existing.has(e.id));
        if(fresh.length){ db.emails=[...fresh,...db.emails].slice(0,200); saveDB(db); console.log(`[Outlook] ${fresh.length} new emails stored`); }
      }).catch(e=>console.error('[Outlook] Background fetch failed:',e.message));
    }
    res.status(202).json({success:true});
  }catch(e){ res.status(202).json({success:true}); }
});

// ── Vapi receptionist ─────────────────────────────────────────
app.post('/webhook/vapi', (req, res) => {
  const userSaid=req.body?.message?.content||req.body?.transcript||'';
  const callerPhone=req.body?.call?.customer?.number||'unknown';
  const lower=userSaid.toLowerCase();
  db.callLog.push({phone:callerPhone,message:userSaid,received_at:new Date().toISOString()});
  if(callerPhone!=='unknown'&&!db.leads.find(l=>l.phone===callerPhone)) db.leads.push(buildLead({name:'Phone Caller',phone:callerPhone,message:userSaid},'Vapi Phone Call'));
  saveDB(db);
  let response='Thank you for calling Elevate Construction LLC, Atlanta\'s premier builder. We specialize in framing, roofing, concrete, welding, and restoration. How can I help you today?';
  if(lower.includes('estimate')||lower.includes('quote')) response='Absolutely! Our team responds within 24 hours. Can I get your name and best callback number?';
  else if(lower.includes('emergency')||lower.includes('flood')||lower.includes('damage')) response='I understand this is urgent. Please call 404-719-1888 directly for immediate response.';
  else if(lower.includes('hours')) response="We're available Monday through Friday 7am to 6pm, Saturday 8am to 4pm, with 24-hour emergency response.";
  res.json({results:[{toolCallId:req.body?.toolCallList?.[0]?.id||'response',result:response}]});
});

// ── Email receipts ────────────────────────────────────────────
app.get('/api/email-receipts', (req, res) => {
  const KEYWORDS=['receipt','invoice','payment','order confirmation','amount charged','home depot','lowes','amazon','grainger'];
  const receipts=db.emails.filter(e=>{ const t=((e.subject||'')+(e.preview||'')).toLowerCase(); return KEYWORDS.some(k=>t.includes(k)); });
  res.json({success:true,count:receipts.length,receipts});
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Elevate HQ Server v3 — port ${PORT}`);
  console.log(`   ${db.leads.length} leads | ${db.emails.length} emails\n`);
});

module.exports = app;
