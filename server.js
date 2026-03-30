// ================================================================
// ELEVATE CONSTRUCTION LLC — HQ Backend Server
// Handles: Lead intake, Gmail webhook, Outlook webhook,
//          Zapier integration, Vapi receptionist
// Deploy on Railway.app
// ================================================================

const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── In-memory store (replace with database later) ─────────────
let leads     = [];
let tasks     = [];
let employees = [];
let emailLog  = [];

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/', (req, res) => {
  res.json({
    status:  'online',
    company: 'Elevate Construction LLC',
    version: '1.0.0',
    message: 'Elevate HQ Backend is running',
    endpoints: {
      leads:          'POST /api/lead',
      getLeads:       'GET  /api/leads',
      zapier:         'POST /webhook/zapier',
      gmail:          'POST /webhook/gmail',
      outlook:        'POST /webhook/outlook',
      vapi:           'POST /webhook/vapi',
      test:           'GET  /test'
    }
  });
});

// ================================================================
// TEST ENDPOINT — verify server is working
// ================================================================
app.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Elevate HQ server is working!',
    time:    new Date().toISOString(),
    leads:   leads.length,
    tasks:   tasks.length
  });
});

// ================================================================
// LEAD INTAKE — from website contact form
// Accepts POST from your GaElevate.com contact form
// ================================================================
app.post('/api/lead', (req, res) => {
  const {
    name, first_name, last_name,
    email, phone, address,
    project_type, budget, timeline,
    source, message
  } = req.body;

  const lead = {
    id:           Date.now(),
    name:         name || `${first_name || ''} ${last_name || ''}`.trim() || 'Unknown',
    email:        email   || '',
    phone:        phone   || '',
    address:      address || '',
    project_type: project_type || 'Website Inquiry',
    budget:       budget   || 'Not specified',
    timeline:     timeline || 'Flexible',
    source:       source   || 'Website',
    message:      message  || '',
    stage:        'new',
    created_at:   new Date().toISOString()
  };

  leads.push(lead);
  console.log(`[Lead] New lead from ${lead.source}: ${lead.name} — ${lead.phone}`);

  res.json({ success: true, message: 'Lead received', lead_id: lead.id });
});

// ── Also accept GET (for URL-based webhook from contact form) ──
app.get('/api/lead', (req, res) => {
  const {
    name, email, phone, address,
    project, budget, timeline, source, message
  } = req.query;

  if(!name && !email && !phone) {
    return res.json({ success: false, message: 'No lead data provided' });
  }

  const lead = {
    id:           Date.now(),
    name:         name    || 'Website Visitor',
    email:        email   || '',
    phone:        phone   || '',
    address:      address || '',
    project_type: project || 'Website Inquiry',
    budget:       budget  || 'Not specified',
    timeline:     timeline|| 'Flexible',
    source:       source  || 'Website',
    message:      message || '',
    stage:        'new',
    created_at:   new Date().toISOString()
  };

  leads.push(lead);
  console.log(`[Lead] GET lead from ${lead.source}: ${lead.name}`);
  res.json({ success: true, message: 'Lead received', lead_id: lead.id });
});

// ================================================================
// GET ALL LEADS — for your Elevate HQ app to fetch
// ================================================================
app.get('/api/leads', (req, res) => {
  res.json({
    success: true,
    count:   leads.length,
    leads:   leads
  });
});

// ================================================================
// ZAPIER WEBHOOK — receives Houzz leads via Zapier
// In Zapier: Action = Webhooks by Zapier → POST → this URL
// ================================================================
app.post('/webhook/zapier', (req, res) => {
  const data = req.body;
  console.log('[Zapier] Incoming webhook:', JSON.stringify(data).slice(0, 200));

  const lead = {
    id:           Date.now(),
    name:         data.name         || data.contact_name || data.full_name || 'Houzz Lead',
    email:        data.email        || '',
    phone:        data.phone        || data.phone_number || '',
    address:      data.address      || data.location || '',
    project_type: data.project_type || data.service || data.category || 'Houzz Inquiry',
    budget:       data.budget       || data.project_budget || 'Not specified',
    source:       data.source       || 'Houzz via Zapier',
    message:      data.message      || data.description || data.project_details || '',
    stage:        'new',
    raw:          data,
    created_at:   new Date().toISOString()
  };

  leads.push(lead);
  console.log(`[Zapier] Lead created: ${lead.name} from ${lead.source}`);
  res.json({ success: true, lead_id: lead.id });
});

// ================================================================
// GMAIL WEBHOOK — receives emails via Google Cloud Pub/Sub
// ================================================================
app.post('/webhook/gmail', (req, res) => {
  try {
    // Google sends base64-encoded message data
    const message = req.body.message;
    if(!message || !message.data) {
      return res.status(200).json({ success: true }); // Always 200 to Gmail
    }

    const decoded  = Buffer.from(message.data, 'base64').toString('utf-8');
    const parsed   = JSON.parse(decoded);
    const emailId  = parsed.emailAddress || 'unknown';

    console.log('[Gmail] Pub/Sub notification for:', emailId);
    emailLog.push({ source: 'gmail', data: parsed, received_at: new Date().toISOString() });

    // TODO: Use Gmail API to fetch full email content and create lead
    // For now we log receipt and acknowledge
    res.status(200).json({ success: true });
  } catch(err) {
    console.error('[Gmail] Error:', err.message);
    res.status(200).json({ success: true }); // Always 200 to prevent retries
  }
});

// ================================================================
// OUTLOOK/MICROSOFT GRAPH WEBHOOK
// ================================================================
app.post('/webhook/outlook', (req, res) => {
  // Microsoft Graph sends a validationToken on first setup
  const validationToken = req.query.validationToken;
  if(validationToken) {
    console.log('[Outlook] Validation request received');
    return res.status(200).type('text/plain').send(validationToken);
  }

  try {
    const notifications = req.body.value || [];
    notifications.forEach(n => {
      console.log('[Outlook] Notification:', n.changeType, n.resourceData?.id);
      emailLog.push({ source: 'outlook', data: n, received_at: new Date().toISOString() });
    });
    res.status(200).json({ success: true });
  } catch(err) {
    console.error('[Outlook] Error:', err.message);
    res.status(200).json({ success: true });
  }
});

// ================================================================
// VAPI RECEPTIONIST WEBHOOK
// Vapi calls this when the AI receptionist needs info
// ================================================================
app.post('/webhook/vapi', (req, res) => {
  const { message, call } = req.body;
  const userSaid = message?.content || '';

  console.log('[Vapi] Call received. Caller said:', userSaid.slice(0, 100));

  // Smart response logic based on what caller asked
  let responseText = '';

  const lower = userSaid.toLowerCase();

  if(lower.includes('estimate') || lower.includes('quote') || lower.includes('price') || lower.includes('cost')) {
    responseText = `I'd be happy to get you a free estimate! Our estimating specialist Marcus can review your project. Can I get your name and phone number so we can call you back within 24 hours? We serve the entire Atlanta metro area for framing, roofing, concrete, welding, and restoration.`;

  } else if(lower.includes('emergency') || lower.includes('urgent') || lower.includes('flooding') || lower.includes('storm') || lower.includes('damage')) {
    responseText = `This sounds like an urgent situation. Let me connect you with our operations team right away. Our emergency response line is available and we can typically have someone on-site within hours. Please hold while I transfer you, or call 404-719-1888 directly for the fastest response.`;

  } else if(lower.includes('hours') || lower.includes('open') || lower.includes('available')) {
    responseText = `Elevate Construction is available Monday through Friday 7am to 6pm, and Saturday 8am to 4pm for estimates. We offer 24-hour emergency response for storm damage and restoration. Is there something specific I can help you with today?`;

  } else if(lower.includes('location') || lower.includes('address') || lower.includes('where')) {
    responseText = `Elevate Construction LLC is based at 3343 Peachtree Road Northeast, Suite 145, Atlanta Georgia 30326. We serve the entire Atlanta metropolitan area including Buckhead, Midtown, Decatur, Marietta, and surrounding areas. Can I help you with anything else?`;

  } else if(lower.includes('lead') || lower.includes('status') || lower.includes('project') || lower.includes('update')) {
    const recentLeads = leads.slice(-3).map(l => `${l.name} — ${l.project_type}`).join(', ');
    responseText = `I can see recent inquiries in our system. ${recentLeads ? 'Recent contacts include: ' + recentLeads + '.' : ''} For a specific project update, our project manager David Thompson can give you a full status report. Shall I have him call you back?`;

  } else {
    responseText = `Thank you for calling Elevate Construction LLC, Atlanta's premier commercial and residential construction company. We specialize in framing, roofing, welding, concrete work, and mitigation and restoration. How can I help you today? I can schedule a free estimate, connect you with a specialist, or answer questions about our services.`;
  }

  // Vapi expects this response format
  res.json({
    results: [{
      toolCallId: req.body.toolCallList?.[0]?.id || 'response',
      result:     responseText
    }]
  });
});

// ================================================================
// START SERVER
// ================================================================
app.listen(PORT, () => {
  console.log(`\n✅ Elevate Construction HQ Server running on port ${PORT}`);
  console.log(`   Company: Elevate Construction LLC`);
  console.log(`   Website: GaElevate.com | 404-719-1888`);
  console.log(`   Endpoints ready: /api/lead, /webhook/zapier, /webhook/gmail, /webhook/outlook, /webhook/vapi\n`);
});

module.exports = app;
