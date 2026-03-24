// AgentLaunchpad — Cloudflare Worker API
// Handles POST /api/waitlist and GET /api/admin/signups
// Connects to Neon Postgres via HTTP (serverless driver)

const NEON_CONNECTION_STRING = 'postgresql://neondb_owner:npg_5aZu8FAtksBX@ep-polished-tooth-alxdyjd7-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const ADMIN_TOKEN = 'alp-admin-2026-xK9m'; // Simple bearer token for admin endpoint
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 5; // max signups per IP per minute

// In-memory rate limiter (resets on worker restart — acceptable for MVP)
const rateLimits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

async function neonQuery(sql, params = []) {
  const url = `https://ep-polished-tooth-alxdyjd7-pooler.c-3.eu-central-1.aws.neon.tech/sql`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': NEON_CONNECTION_STRING,
    },
    body: JSON.stringify({ query: sql, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Neon query failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function handleWaitlistPost(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    });
  }

  const { email, building_what, honeypot } = body;

  // Honeypot check
  if (honeypot) {
    // Silently accept to not reveal the trap
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    });
  }

  // Validation
  if (!email || typeof email !== 'string') {
    return new Response(JSON.stringify({ error: 'Email is required.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return new Response(JSON.stringify({ error: 'Invalid email address.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    });
  }

  if (!building_what || typeof building_what !== 'string' || building_what.trim().length < 5) {
    return new Response(JSON.stringify({ error: 'Please tell us what you are building (min 5 characters).' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    });
  }

  try {
    await neonQuery(
      'INSERT INTO waitlist (email, building_what) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [email.trim().toLowerCase(), building_what.trim()]
    );

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request.headers.get('Origin')) },
    });
  }
}

async function handleAdminSignups(request) {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${ADMIN_TOKEN}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await neonQuery('SELECT id, email, building_what, created_at FROM waitlist ORDER BY created_at DESC');
    return new Response(JSON.stringify({ signups: result.rows || [], count: (result.rows || []).length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Database error.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers.get('Origin')),
      });
    }

    // Route: POST /api/waitlist
    if (url.pathname === '/api/waitlist' && request.method === 'POST') {
      return handleWaitlistPost(request);
    }

    // Route: GET /api/admin/signups
    if (url.pathname === '/api/admin/signups' && request.method === 'GET') {
      return handleAdminSignups(request);
    }

    // 404 for unknown API routes
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // For non-API routes, let Cloudflare Pages serve static files
    return new Response('Not found', { status: 404 });
  },
};
