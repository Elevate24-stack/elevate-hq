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

// ── Gmail config + watch registration ────────────────────────
app.post('/api/gmail-config', async (req, res) => {
  const { email, token, client_id, client_secret, refresh_token } = req.body;
  gmailConfig = { email, token, client_id, client_secret, refresh_token, updated:new Date().toISOString() };
  console.log('[Gmail] Config saved for:', email);

  // If we have a token, register Gmail push watch
  if(token || refresh_token){
    try{
      await registerGmailWatch(token);
      res.json({ success:true, message:'Gmail connected! Push notifications registered.', email });
    }catch(e){
      console.error('[Gmail] Watch registration failed:', e.message);
      res.json({ success:true, message:'Config saved. Watch registration: '+e.message, email });
    }
  } else {
    res.json({ success:true, message:'Gmail config saved', email });
  }
});

// ── Register Gmail push watch ─────────────────────────────────
async function registerGmailWatch(accessToken){
  return new Promise((resolve, reject)=>{
    const body = JSON.stringify({
      labelIds: ['INBOX'],
      topicName: 'projects/' + (process.env.GOOGLE_PROJECT_ID||'my-first-project') + '/topics/elevate-gmail'
    });
    const opts = {
      hostname: 'gmail.googleapis.com',
      path:     '/gmail/v1/users/me/watch',
      method:   'POST',
      headers:{
        'Authorization': 'Bearer '+accessToken,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res=>{
      let data=''; res.on('data',c=>data+=c);
      res.on('end',()=>{
        try{
          const d=JSON.parse(data);
          if(d.historyId){
            console.log('[Gmail] Watch registered, historyId:', d.historyId, 'expires:', new Date(Number(d.expiration)).toISOString());
            resolve(d);
          } else {
            reject(new Error(d.error?.message||'Watch failed: '+JSON.stringify(d)));
          }
        }catch(e){ reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Fetch Gmail messages ──────────────────────────────────────
async function fetchGmailMessages(accessToken, max=20){
  // Step 1: list message IDs
  const listData = await new Promise((resolve, reject)=>{
    const opts = {
      hostname: 'gmail.googleapis.com',
      path:     `/gmail/v1/users/me/messages?maxResults=${max}&labelIds=INBOX`,
      method:   'GET',
      headers:  {'Authorization':'Bearer '+accessToken}
    };
    const req = https.request(opts, res=>{
      let data=''; res.on('data',c=>data+=c);
      res.on('end',()=>{ try{ resolve(JSON.parse(data)); }catch(e){ reject(e); } });
    });
    req.on('error',reject); req.end();
  });

  if(!listData.messages || !listData.messages.length) return [];

  // Step 2: fetch first 10 full messages (avoid rate limits)
  const messages = await Promise.allSettled(
    listData.messages.slice(0,10).map(m=>new Promise((resolve, reject)=>{
      const opts = {
        hostname:'gmail.googleapis.com',
        path:`/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        method:'GET',
        headers:{'Authorization':'Bearer '+accessToken}
      };
      const req = https.request(opts, res=>{
        let data=''; res.on('data',c=>data+=c);
        res.on('end',()=>{ try{ resolve(JSON.parse(data)); }catch(e){ reject(e); } });
      });
      req.on('error',reject); req.end();
    }))
  );

  return messages
    .filter(r=>r.status==='fulfilled')
    .map(r=>r.value)
    .map(m=>{
      const headers = m.payload?.headers||[];
      const get = name => headers.find(h=>h.name===name)?.value||'';
      return {
        id:          m.id,
        subject:     get('Subject')||'(no subject)',
        from:        get('From'),
        from_name:   get('From').split('<')[0].trim(),
        preview:     m.snippet||'',
        received_at: new Date(parseInt(m.internalDate)).toISOString(),
        unread:      m.labelIds?.includes('UNREAD'),
        source:      'gmail'
      };
    });
}

// ── Get Gmail emails (called by app) ─────────────────────────
app.get('/api/gmail-emails', async (req, res) => {
  try{
    if(!gmailConfig.token) return res.json({ success:true, emails:[], message:'Gmail not configured' });
    const emails = await fetchGmailMessages(gmailConfig.token, 20);
    const existingIds = new Set(db.emails.map(e=>e.id));
    const newEmails   = emails.filter(e=>!existingIds.has(e.id));
    if(newEmails.length){ db.emails=[...newEmails,...db.emails].slice(0,200); saveDB(db); }
    res.json({ success:true, count:emails.length, emails, new_count:newEmails.length });
  }catch(e){
    res.json({ success:false, error:e.message, emails:db.emails.filter(e=>e.source==='gmail') });
  }
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

// ── Gmail webhook (Pub/Sub push) ─────────────────────────────
app.post('/webhook/gmail', (req, res) => {
  // Always respond 200 immediately so Google doesn't retry
  res.status(200).json({success:true});
  try{
    const msg=req.body.message;
    if(msg?.data){
      const decoded=Buffer.from(msg.data,'base64').toString('utf-8');
      const parsed=JSON.parse(decoded);
      const historyId=parsed.historyId;
      console.log('[Gmail] Push notification — email:', parsed.emailAddress, 'historyId:', historyId);
      db.emailLog.push({source:'gmail',email:parsed.emailAddress,historyId,received_at:new Date().toISOString()});
      saveDB(db);
      // If we have an access token, fetch new messages in background
      if(gmailConfig.token){
        fetchGmailMessages(gmailConfig.token, 10).then(emails=>{
          const existingIds=new Set(db.emails.map(e=>e.id));
          const fresh=emails.filter(e=>!existingIds.has(e.id));
          if(fresh.length){ db.emails=[...fresh,...db.emails].slice(0,200); saveDB(db); console.log(`[Gmail] ${fresh.length} new emails stored`); }
        }).catch(e=>console.error('[Gmail] Background fetch failed:',e.message));
      }
    }
  }catch(e){ console.error('[Gmail] Webhook error:', e.message); }
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

// ── Blocked callers list ─────────────────────────────────────
if(!db.blockedCallers) db.blockedCallers = [];

app.get('/api/blocked-callers', (req, res) => {
  res.json({ success:true, count:db.blockedCallers.length, blocked:db.blockedCallers });
});

app.post('/api/blocked-callers', (req, res) => {
  const { phone, name, company, reason, reference, amount, notes } = req.body;
  if(!phone) return res.json({ success:false, message:'Phone required' });

  const existing = db.blockedCallers.find(b => b.phones.includes(phone));
  if(existing){
    // Add new number to existing record
    if(!existing.phones.includes(phone)) existing.phones.push(phone);
    if(notes) existing.notes = (existing.notes||'') + '\n' + notes;
    saveDB(db);
    return res.json({ success:true, message:'Number added to existing record', id:existing.id });
  }

  const record = {
    id:        Date.now(),
    phones:    [phone],
    name:      name||'Unknown',
    company:   company||'',
    reason:    reason||'bill_collector',
    reference: reference||'',
    amount:    amount||'',
    notes:     notes||'',
    added_at:  new Date().toISOString()
  };
  db.blockedCallers.push(record);
  saveDB(db);
  console.log(`[Blocked] Added: ${record.company||record.name} | ${phone}`);
  res.json({ success:true, id:record.id });
});

// Check if a number is blocked (called by lookup_caller)
app.get('/api/is-blocked', (req, res) => {
  const phone = req.query.phone||'';
  const record = db.blockedCallers.find(b => b.phones.some(p => p===phone || p.replace(/[^0-9]/g,'')===phone.replace(/[^0-9]/g,'')));
  res.json({ blocked: !!record, record: record||null });
});

// ── Ashley Staff Messaging ───────────────────────────────────
// Ashley sends messages to staff after calls
// Staff (AI agents) reply back with context
// CEO sees everything in the Staff Chat view
if(!db.ashleyMessages) db.ashleyMessages = [];

// Ashley posts a message to a staff member
app.post('/api/ashley/message', (req, res) => {
  const { to, subject, body, call_id, caller_name, caller_phone,
          project_type, budget, priority, from } = req.body;

  const msg = {
    id:           Date.now(),
    from:         from || 'Ashley',
    to:           to || 'Michael',
    subject:      subject || 'New Lead',
    body:         body || '',
    call_id:      call_id || '',
    caller_name:  caller_name || '',
    caller_phone: caller_phone || '',
    project_type: project_type || '',
    budget:       budget || '',
    priority:     priority || 'normal',
    read:         false,
    replies:      [],
    sent_at:      new Date().toISOString()
  };

  db.ashleyMessages.unshift(msg);
  if(db.ashleyMessages.length > 200) db.ashleyMessages = db.ashleyMessages.slice(0,200);
  saveDB(db);
  console.log(`[Ashley→${to}] ${subject}`);
  res.json({ success:true, id:msg.id });
});

// Staff replies to Ashley's message
app.post('/api/ashley/reply', (req, res) => {
  const { message_id, from, body } = req.body;
  const msg = db.ashleyMessages.find(m => m.id === Number(message_id));
  if(!msg) return res.json({ success:false, message:'Message not found' });

  msg.replies.push({
    from:     from || 'Staff',
    body:     body || '',
    sent_at:  new Date().toISOString()
  });
  msg.read = false; // flag as updated
  saveDB(db);
  console.log(`[${from}→Ashley] Reply on: ${msg.subject}`);
  res.json({ success:true });
});

// Get all messages (for app)
app.get('/api/ashley/messages', (req, res) => {
  const { to, unread } = req.query;
  let msgs = db.ashleyMessages || [];
  if(to) msgs = msgs.filter(m => m.to === to || m.from === to);
  if(unread === 'true') msgs = msgs.filter(m => !m.read);
  res.json({ success:true, count:msgs.length, messages:msgs.slice(0,50) });
});

// Mark message read
app.post('/api/ashley/read', (req, res) => {
  const { message_id } = req.body;
  const msg = db.ashleyMessages.find(m => m.id === Number(message_id));
  if(msg) { msg.read = true; saveDB(db); }
  res.json({ success:true });
});

// ── Email receipts ────────────────────────────────────────────
app.get('/api/email-receipts', (req, res) => {
  const KEYWORDS=['receipt','invoice','payment','order confirmation','amount charged','home depot','lowes','amazon','grainger'];
  const receipts=db.emails.filter(e=>{ const t=((e.subject||'')+(e.preview||'')).toLowerCase(); return KEYWORDS.some(k=>t.includes(k)); });
  res.json({success:true,count:receipts.length,receipts});
});

// ── Ashley status toggle ─────────────────────────────────────
let ashleyStatus = { active:true, updated_at:new Date().toISOString() };
app.post('/api/ashley/status', (req,res)=>{
  ashleyStatus = { active:!!req.body.active, updated_at:new Date().toISOString() };
  console.log('[Ashley] Status set to:', ashleyStatus.active?'ACTIVE':'INACTIVE');
  res.json({ success:true, ...ashleyStatus });
});
app.get('/api/ashley/status', (req,res)=>res.json(ashleyStatus));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Elevate HQ Server v3 — port ${PORT}`);
  console.log(`   ${db.leads.length} leads | ${db.emails.length} emails\n`);
});

module.exports = app;
