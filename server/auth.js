import crypto from 'node:crypto';

const COOKIE = 'rs';
const MAX_AGE = 30 * 24 * 3600; // seconds

const sign = (payload) => crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`));
  return m?.[1];
}

export function isAuthed(req) {
  if (!process.env.APP_PASSWORD) return true; // sin contraseña configurada: acceso abierto
  const v = readCookie(req);
  if (!v) return false;
  const [exp, sig] = v.split('.');
  if (!exp || !sig || +exp < Date.now() / 1000) return false;
  return safeEqual(sig, sign(exp));
}

export const requireAuth = (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'No autorizado' }));

const attempts = new Map(); // ip -> {n, reset}

export function login(req, res) {
  const ip = req.ip;
  const now = Date.now();
  const a = attempts.get(ip) && attempts.get(ip).reset > now ? attempts.get(ip) : { n: 0, reset: now + 15 * 60_000 };
  if (a.n >= 10) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  a.n++;
  attempts.set(ip, a);
  if (!safeEqual(req.body?.password ?? '', process.env.APP_PASSWORD)) return res.status(401).json({ error: 'Contraseña incorrecta' });
  attempts.delete(ip);
  const exp = Math.floor(now / 1000) + MAX_AGE;
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(String(exp))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}${secure}`);
  res.json({ ok: true });
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}
