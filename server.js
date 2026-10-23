'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'lovemeter.json');
const ENV_FILE = path.join(ROOT, '.env');

function loadDotEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const contents = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, value.endsWith('"') ? -1 : undefined); }
    } else if (value.startsWith("'")) {
      value = value.slice(1, value.endsWith("'") ? -1 : undefined);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 30 * 1024;
const PUBLIC_MEASURE_LIMIT = 40;
const PUBLIC_MEASURE_WINDOW_MS = 60 * 1000;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('\nConfiguration manquante ou insuffisante. Lance d’abord : node setup.js');
  console.error('Le mot de passe admin doit comporter au moins 12 caractères.\n');
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('PORT doit être un nombre entre 1 et 65535.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function phraseInName(normalizedFullName, keyword) {
  const normalizedKeyword = normalizeName(keyword);
  if (!normalizedKeyword) return false;
  return (` ${normalizedFullName} `).includes(` ${normalizedKeyword} `);
}

function createDefaultRules() {
  const rules = [];
  const groupA = ['Oyane', 'Obame', 'Viviane'];
  const groupB = ['Mouchfik', 'Omotoyossi', 'Parfait'];
  for (const leftKeyword of groupA) {
    for (const rightKeyword of groupB) {
      rules.push({
        id: crypto.randomUUID(),
        leftKeyword,
        rightKeyword,
        score: 100,
        enabled: true,
        label: `${leftKeyword} ↔ ${rightKeyword}`,
        createdAt: new Date().toISOString(),
        seeded: true,
      });
    }
  }
  rules.push({
    id: crypto.randomUUID(),
    leftKeyword: 'Obame',
    rightKeyword: 'Esthimée',
    score: 100,
    enabled: true,
    label: 'Tout nom contenant « Obame » ↔ tout nom contenant « Esthimée »',
    createdAt: new Date().toISOString(),
    seeded: true,
  });
  return rules;
}

function writeData(data) {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const fresh = { schemaVersion: 1, tests: [], rules: createDefaultRules() };
    writeData(fresh);
    return fresh;
  }
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.tests) || !Array.isArray(data.rules)) {
      throw new Error('Structure invalide');
    }
    return data;
  } catch (error) {
    console.error(`Impossible de lire ${DATA_FILE}. Le fichier n’a pas été écrasé.`, error.message);
    process.exit(1);
  }
}

let db = loadData();
const sessions = new Map();
const loginAttempts = new Map();
const measureAttempts = new Map();

function canonicalPairKey(nameA, nameB) {
  return [nameA, nameB].sort().join('::');
}

function generateStableScore(nameA, nameB) {
  const key = canonicalPairKey(nameA, nameB);
  const digest = crypto.createHash('sha256').update(key, 'utf8').digest();
  // Les scores 100 sont réservés aux règles spéciales configurées par l’administrateur.
  return (digest.readUInt32BE(0) % 99) + 1;
}

function matchingRule(nameA, nameB) {
  for (const rule of db.rules) {
    if (!rule.enabled) continue;
    const left = normalizeName(rule.leftKeyword);
    const right = normalizeName(rule.rightKeyword);
    const direct = phraseInName(nameA, left) && phraseInName(nameB, right);
    const reverse = phraseInName(nameA, right) && phraseInName(nameB, left);
    if (direct || reverse) return rule;
  }
  return null;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}

function getClientIp(req) {
  // On ignore volontairement X-Forwarded-For par défaut pour éviter qu’un visiteur le falsifie.
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(map, key, max, windowMs) {
  const now = Date.now();
  const old = map.get(key);
  if (!old || now - old.startedAt >= windowMs) {
    map.set(key, { startedAt: now, count: 1 });
    return { allowed: true, remaining: max - 1 };
  }
  old.count += 1;
  if (old.count > max) return { allowed: false, remaining: 0, retryAfter: Math.ceil((windowMs - (now - old.startedAt)) / 1000) };
  return { allowed: true, remaining: max - old.count };
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const pos = part.indexOf('=');
    if (pos < 0) continue;
    const key = part.slice(0, pos).trim();
    const value = part.slice(pos + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function getAdminSession(req) {
  let token;
  try { token = parseCookies(req).lm_session; } catch { return null; }
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, session };
}

function requireAdmin(req, res) {
  if (getAdminSession(req)) return true;
  sendJson(res, 401, { error: 'Connexion administrateur requise.' });
  return false;
}

function validateSameOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  const expectedHttp = `http://${host}`;
  const expectedHttps = `https://${host}`;
  if (origin === expectedHttp || origin === expectedHttps) return true;
  sendJson(res, 403, { error: 'Origine de requête refusée.' });
  return false;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Corps de requête trop volumineux.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON invalide');
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('JSON invalide.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function cleanText(value, maxLength = 100) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function publicMessage(score) {
  if (score === 100) return 'Une compatibilité exceptionnelle ! Le destin a parlé 💘';
  if (score >= 85) return 'Il y a comme une étincelle entre vous ✨';
  if (score >= 65) return 'Une jolie connexion pourrait exister 💗';
  if (score >= 40) return 'Une belle amitié peut aussi commencer ici 😊';
  if (score >= 20) return 'Le mystère reste entier… à vous de voir 😄';
  return 'Les chiffres ne décident pas de tout : surprenez le calculateur 😉';
}

function publicTestResult(req, res, body) {
  const ip = getClientIp(req);
  const limit = checkRateLimit(measureAttempts, ip, PUBLIC_MEASURE_LIMIT, PUBLIC_MEASURE_WINDOW_MS);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return sendJson(res, 429, { error: 'Trop de tests en peu de temps. Réessaie dans un instant.' });
  }

  const name1 = cleanText(body.name1, 80);
  const name2 = cleanText(body.name2, 80);
  const normalized1 = normalizeName(name1);
  const normalized2 = normalizeName(name2);
  const wordCount1 = normalized1 ? normalized1.split(' ').length : 0;
  const wordCount2 = normalized2 ? normalized2.split(' ').length : 0;

  if (name1.length < 3 || name2.length < 3 || !normalized1 || !normalized2) {
    return sendJson(res, 400, { error: 'Entre les noms complets des deux personnes.' });
  }
  if (wordCount1 < 2 || wordCount2 < 2) {
    return sendJson(res, 400, { error: 'Pour ce jeu, chaque champ doit contenir un nom complet (au moins deux mots).' });
  }
  if (normalized1 === normalized2) {
    return sendJson(res, 400, { error: 'Entre deux personnes différentes pour lancer le test.' });
  }

  const pairKey = canonicalPairKey(normalized1, normalized2);
  const existing = db.tests.find((test) => test.pairKey === pairKey);
  if (existing) {
    return sendJson(res, 200, { score: existing.score, message: publicMessage(existing.score), saved: true });
  }

  const rule = matchingRule(normalized1, normalized2);
  const score = rule ? rule.score : generateStableScore(normalized1, normalized2);
  const now = new Date().toISOString();
  const test = {
    id: crypto.randomUUID(),
    name1,
    name2,
    normalized1,
    normalized2,
    pairKey,
    score,
    special: Boolean(rule),
    matchedRuleId: rule ? rule.id : null,
    matchedRuleLabel: rule ? rule.label : null,
    createdAt: now,
  };
  db.tests.push(test);
  writeData(db);
  return sendJson(res, 200, { score, message: publicMessage(score), saved: true });
}

function safeRule(rule) {
  return {
    id: rule.id,
    leftKeyword: rule.leftKeyword,
    rightKeyword: rule.rightKeyword,
    score: rule.score,
    enabled: rule.enabled,
    label: rule.label,
    createdAt: rule.createdAt,
    seeded: Boolean(rule.seeded),
  };
}

function adminStats() {
  return {
    totalTests: db.tests.length,
    specialTests: db.tests.filter((test) => test.special).length,
    normalTests: db.tests.filter((test) => !test.special).length,
    enabledRules: db.rules.filter((rule) => rule.enabled).length,
    totalRules: db.rules.length,
  };
}

function validateRuleInput(body, allowPartial = false) {
  const result = {};
  if (!allowPartial || body.leftKeyword !== undefined) {
    result.leftKeyword = cleanText(body.leftKeyword, 80);
    if (!result.leftKeyword || !normalizeName(result.leftKeyword)) throw Object.assign(new Error('Le premier mot-clé est obligatoire.'), { status: 400 });
  }
  if (!allowPartial || body.rightKeyword !== undefined) {
    result.rightKeyword = cleanText(body.rightKeyword, 80);
    if (!result.rightKeyword || !normalizeName(result.rightKeyword)) throw Object.assign(new Error('Le deuxième mot-clé est obligatoire.'), { status: 400 });
  }
  if (!allowPartial || body.score !== undefined) {
    const score = Number(body.score);
    if (!Number.isInteger(score) || score < 1 || score > 100) throw Object.assign(new Error('Le score doit être un entier de 1 à 100.'), { status: 400 });
    result.score = score;
  }
  if (body.label !== undefined) result.label = cleanText(body.label, 160);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('Le champ activée doit être vrai ou faux.'), { status: 400 });
    result.enabled = body.enabled;
  }
  return result;
}

function findRuleOrThrow(id) {
  const rule = db.rules.find((item) => item.id === id);
  if (!rule) throw Object.assign(new Error('Règle introuvable.'), { status: 404 });
  return rule;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function serveStatic(req, res, pathname) {
  let filename;
  if (pathname === '/' || pathname === '/index.html') filename = 'index.html';
  else if (pathname === '/admin.html') filename = 'admin.html';
  else return sendJson(res, 404, { error: 'Page introuvable.' });
  const fullPath = path.join(PUBLIC_DIR, filename);
  fs.readFile(fullPath, (err, content) => {
    if (err) return sendJson(res, 500, { error: 'Impossible de lire la page.' });
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(fullPath)] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  });
}

async function handleRequest(req, res) {
  setSecurityHeaders(res);
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return sendJson(res, 400, { error: 'Adresse de requête invalide.' }); }
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  if (method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  if (pathname === '/api/measure' && method === 'POST') {
    if (!validateSameOrigin(req, res)) return;
    let body;
    try { body = await readJsonBody(req); }
    catch (error) { return sendJson(res, error.status || 400, { error: error.message || 'Requête invalide.' }); }
    return publicTestResult(req, res, body);
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    if (!validateSameOrigin(req, res)) return;
    const ip = getClientIp(req);
    const limit = checkRateLimit(loginAttempts, ip, LOGIN_LIMIT, LOGIN_WINDOW_MS);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      return sendJson(res, 429, { error: 'Trop de tentatives. Attends quelques minutes avant de réessayer.' });
    }
    let body;
    try { body = await readJsonBody(req); }
    catch (error) { return sendJson(res, error.status || 400, { error: error.message || 'Requête invalide.' }); }
    const provided = String(body.password ?? '');
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(ADMIN_PASSWORD);
    const match = providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
    if (!match) return sendJson(res, 401, { error: 'Mot de passe incorrect.' });

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(token, { expiresAt });
    loginAttempts.delete(ip);
    const cookieParts = [`lm_session=${encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
    if (req.socket.encrypted) cookieParts.push('Secure');
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieParts.join('; ') });
  }

  if (pathname === '/api/admin/me' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    return sendJson(res, 200, { ok: true, stats: adminStats() });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!requireAdmin(req, res)) return;
    if (method !== 'GET' && !validateSameOrigin(req, res)) return;

    if (pathname === '/api/admin/logout' && method === 'POST') {
      const found = getAdminSession(req);
      if (found) sessions.delete(found.token);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'lm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    if (pathname === '/api/admin/stats' && method === 'GET') {
      return sendJson(res, 200, adminStats());
    }

    if (pathname === '/api/admin/tests' && method === 'GET') {
      const q = normalizeName(url.searchParams.get('q') || '');
      const matches = db.tests
        .filter((test) => !q || test.normalized1.includes(q) || test.normalized2.includes(q))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const total = matches.length;
      const tests = matches.slice(0, 200).map((test) => ({
        id: test.id,
        name1: test.name1,
        name2: test.name2,
        score: test.score,
        special: Boolean(test.special),
        matchedRuleLabel: test.matchedRuleLabel || null,
        createdAt: test.createdAt,
      }));
      return sendJson(res, 200, { total, shown: tests.length, tests });
    }

    const testDeleteMatch = pathname.match(/^\/api\/admin\/tests\/([0-9a-f-]+)$/i);
    if (testDeleteMatch && method === 'DELETE') {
      const before = db.tests.length;
      db.tests = db.tests.filter((test) => test.id !== testDeleteMatch[1]);
      if (db.tests.length === before) return sendJson(res, 404, { error: 'Test introuvable.' });
      writeData(db);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/rules' && method === 'GET') {
      return sendJson(res, 200, db.rules.map(safeRule));
    }

    if (pathname === '/api/admin/rules' && method === 'POST') {
      let body;
      try { body = await readJsonBody(req); }
      catch (error) { return sendJson(res, error.status || 400, { error: error.message || 'Requête invalide.' }); }
      try {
        const input = validateRuleInput(body);
        if (normalizeName(input.leftKeyword) === normalizeName(input.rightKeyword)) {
          return sendJson(res, 400, { error: 'Les deux mots-clés doivent être différents.' });
        }
        const rule = {
          id: crypto.randomUUID(),
          leftKeyword: input.leftKeyword,
          rightKeyword: input.rightKeyword,
          score: input.score,
          enabled: input.enabled ?? true,
          label: input.label || `${input.leftKeyword} ↔ ${input.rightKeyword}`,
          createdAt: new Date().toISOString(),
          seeded: false,
        };
        db.rules.push(rule);
        writeData(db);
        return sendJson(res, 201, safeRule(rule));
      } catch (error) {
        return sendJson(res, error.status || 400, { error: error.message || 'Règle invalide.' });
      }
    }

    const ruleRouteMatch = pathname.match(/^\/api\/admin\/rules\/([0-9a-f-]+)$/i);
    if (ruleRouteMatch) {
      const id = ruleRouteMatch[1];
      if (method === 'PATCH') {
        let body;
        try { body = await readJsonBody(req); }
        catch (error) { return sendJson(res, error.status || 400, { error: error.message || 'Requête invalide.' }); }
        try {
          const rule = findRuleOrThrow(id);
          const input = validateRuleInput(body, true);
          if (input.leftKeyword !== undefined) rule.leftKeyword = input.leftKeyword;
          if (input.rightKeyword !== undefined) rule.rightKeyword = input.rightKeyword;
          if (input.score !== undefined) rule.score = input.score;
          if (input.enabled !== undefined) rule.enabled = input.enabled;
          if (input.label !== undefined) rule.label = input.label || `${rule.leftKeyword} ↔ ${rule.rightKeyword}`;
          if (normalizeName(rule.leftKeyword) === normalizeName(rule.rightKeyword)) {
            return sendJson(res, 400, { error: 'Les deux mots-clés doivent être différents.' });
          }
          if (!body.label && (body.leftKeyword !== undefined || body.rightKeyword !== undefined)) {
            rule.label = `${rule.leftKeyword} ↔ ${rule.rightKeyword}`;
          }
          writeData(db);
          return sendJson(res, 200, safeRule(rule));
        } catch (error) {
          return sendJson(res, error.status || 400, { error: error.message || 'Modification impossible.' });
        }
      }
      if (method === 'DELETE') {
        const before = db.rules.length;
        db.rules = db.rules.filter((rule) => rule.id !== id);
        if (db.rules.length === before) return sendJson(res, 404, { error: 'Règle introuvable.' });
        writeData(db);
        return sendJson(res, 200, { ok: true });
      }
    }

    return sendJson(res, 404, { error: 'Route admin introuvable.' });
  }

  return sendJson(res, 404, { error: 'Route introuvable.' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('Erreur serveur :', error.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'Erreur interne du serveur.' });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\nLove Meter est lancé : http://${HOST}:${PORT}`);
  console.log(`Jeu : http://${HOST}:${PORT}/`);
  console.log(`Administration : http://${HOST}:${PORT}/admin.html`);
  console.log('Arrêt : Ctrl+C\n');
});

function closeServer() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);
