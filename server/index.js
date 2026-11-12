import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Op } from 'sequelize';
import { initDb } from './models.js';
import { login, logout, requireAuth } from './auth.js';
import { scanRecipe, HttpError } from './gemini.js';

for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[k]) {
    console.error(`Falta la variable de entorno ${k}`);
    process.exit(1);
  }
}

if (process.env.APP_PASSWORD && !process.env.SESSION_SECRET) {
  console.error('Con APP_PASSWORD también hace falta SESSION_SECRET');
  process.exit(1);
}
if (!process.env.APP_PASSWORD) console.warn('APP_PASSWORD vacío: la app es accesible SIN contraseña');

const M = await initDb();
const { sequelize, Ingredient, Photo, Recipe, RecipeItem, RecipeStep, Setting } = M;

const UNITS = new Set(['g', 'kg', 'ml', 'l', 'u']);
const YIELD_UNITS = new Set(['porciones', 'unidades', 'g', 'kg', 'ml', 'l']);
const ID_RE = /^[a-z0-9]{1,32}$/;
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const num = (v) => (Number.isFinite(+v) && +v >= 0 ? +v : 0);
const bad = (msg) => new HttpError(400, msg);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '1mb' }));
const rawImage = express.raw({ type: 'image/*', limit: '10mb' });

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  });

app.get('/healthz', (req, res) => res.send('ok'));

/* ---- auth ---- */
app.post('/api/login', login);
app.post('/api/logout', logout);
app.use('/api', requireAuth);

/* ---- serializers ---- */
const recipeOut = (r) => ({
  id: r.id,
  name: r.name,
  cover: r.coverId,
  yield: r.yield,
  yieldUnit: r.yieldUnit,
  salePrice: r.salePrice,
  other: r.other,
  created: +r.createdAt,
  updated: +r.updatedAt,
  items: [...r.items].sort((a, b) => a.position - b.position).map((i) => ({ ingId: i.ingredientId, qty: i.qty, unit: i.unit })),
  steps: [...r.steps].sort((a, b) => a.position - b.position).map((s) => ({ text: s.text, photo: s.photoId })),
});
const ingOut = (i) => ({ id: i.id, name: i.name, price: i.price, qty: i.qty, unit: i.unit });
const withParts = { include: [{ model: RecipeItem, as: 'items' }, { model: RecipeStep, as: 'steps' }] };

async function getSettings() {
  const row = await Setting.findByPk('main');
  return { currency: '$', ...(row ? JSON.parse(row.value) : {}) };
}

/* ---- data ---- */
app.get(
  '/api/data',
  wrap(async (req, res) => {
    const [ings, recipes, set] = await Promise.all([Ingredient.findAll(), Recipe.findAll(withParts), getSettings()]);
    res.json({
      ings: ings.map(ingOut),
      recipes: recipes.map(recipeOut),
      set: { ...set, geminiReady: !!process.env.GEMINI_API_KEY, authRequired: !!process.env.APP_PASSWORD },
    });
  })
);

app.put(
  '/api/settings',
  wrap(async (req, res) => {
    const currency = String(req.body?.currency ?? '$').trim().slice(0, 4) || '$';
    await Setting.upsert({ key: 'main', value: JSON.stringify({ currency }) });
    res.json({ currency });
  })
);

/* ---- ingredients ---- */
app.put(
  '/api/ingredients/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    const b = req.body || {};
    if (!ID_RE.test(id)) throw bad('Id inválido');
    if (!String(b.name || '').trim()) throw bad('Falta el nombre');
    if (!UNITS.has(b.unit)) throw bad('Unidad inválida');
    const vals = { name: String(b.name).trim().slice(0, 120), price: num(b.price), qty: num(b.qty) || 1, unit: b.unit };
    await Ingredient.upsert({ id, ...vals });
    res.json(ingOut({ id, ...vals }));
  })
);

app.delete(
  '/api/ingredients/:id',
  wrap(async (req, res) => {
    const used = await RecipeItem.count({ where: { ingredientId: req.params.id } });
    if (used) throw new HttpError(409, `Está en uso en ${used} receta(s)`);
    await Ingredient.destroy({ where: { id: req.params.id } });
    res.json({ ok: true });
  })
);

/* ---- photos ---- */
app.post(
  '/api/photos',
  rawImage,
  wrap(async (req, res) => {
    const mime = req.headers['content-type']?.split(';')[0];
    if (!MIMES.has(mime) || !Buffer.isBuffer(req.body) || !req.body.length) throw bad('Imagen inválida');
    const id = crypto.randomBytes(12).toString('hex');
    await Photo.create({ id, mime, data: req.body });
    res.json({ id });
  })
);

app.get(
  '/api/photos/:id',
  wrap(async (req, res) => {
    const p = await Photo.findByPk(req.params.id);
    if (!p) return res.status(404).end();
    res.setHeader('Content-Type', p.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(p.data);
  })
);

/* ---- recipes ---- */
app.put(
  '/api/recipes/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    const b = req.body || {};
    if (!ID_RE.test(id)) throw bad('Id inválido');
    if (!String(b.name || '').trim()) throw bad('Falta el nombre');
    const items = (b.items || []).map((i, position) => {
      if (!ID_RE.test(i.ingId) || !UNITS.has(i.unit)) throw bad('Ingrediente inválido');
      return { ingredientId: i.ingId, qty: num(i.qty), unit: i.unit, position };
    });
    const steps = (b.steps || []).map((s, position) => ({
      text: String(s.text || '').slice(0, 5000),
      photoId: s.photo && ID_RE.test(s.photo) ? s.photo : null,
      position,
    }));
    const coverId = b.cover && ID_RE.test(b.cover) ? b.cover : null;
    const photoIds = [coverId, ...steps.map((s) => s.photoId)].filter(Boolean);
    const fields = { name: String(b.name).trim().slice(0, 160), coverId, yield: num(b.yield) || 1, yieldUnit: YIELD_UNITS.has(b.yieldUnit) ? b.yieldUnit : 'porciones', salePrice: num(b.salePrice), other: num(b.other) };

    try {
      await sequelize.transaction(async (t) => {
        const existing = await Recipe.findByPk(id, { transaction: t });
        if (existing) await existing.update(fields, { transaction: t });
        else await Recipe.create({ id, ...fields }, { transaction: t });
        await RecipeItem.destroy({ where: { recipeId: id }, transaction: t });
        await RecipeStep.destroy({ where: { recipeId: id }, transaction: t });
        await RecipeItem.bulkCreate(items.map((i) => ({ ...i, recipeId: id })), { transaction: t });
        await RecipeStep.bulkCreate(steps.map((s) => ({ ...s, recipeId: id })), { transaction: t });
        await Photo.update({ recipeId: id }, { where: { id: { [Op.in]: photoIds }, recipeId: { [Op.or]: [null, id] } }, transaction: t });
        await Photo.destroy({ where: { recipeId: id, id: { [Op.notIn]: photoIds.length ? photoIds : [''] } }, transaction: t });
      });
    } catch (e) {
      if (e.name === 'SequelizeForeignKeyConstraintError') throw bad('Un ingrediente de la receta ya no existe');
      throw e;
    }
    res.json(recipeOut(await Recipe.findByPk(id, withParts)));
  })
);

app.delete(
  '/api/recipes/:id',
  wrap(async (req, res) => {
    await sequelize.transaction(async (t) => {
      await Photo.destroy({ where: { recipeId: req.params.id }, transaction: t });
      await Recipe.destroy({ where: { id: req.params.id }, transaction: t });
    });
    res.json({ ok: true });
  })
);

/* ---- scan with Gemini ---- */
app.post(
  '/api/scan',
  rawImage,
  wrap(async (req, res) => {
    const mime = req.headers['content-type']?.split(';')[0];
    if (!MIMES.has(mime) || !Buffer.isBuffer(req.body) || !req.body.length) throw bad('Imagen inválida');
    res.json(await scanRecipe(req.body, mime));
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

/* ---- static PWA ---- */
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(
  express.static(pub, {
    setHeaders: (res, file) => {
      if (/(sw\.js|index\.html|\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

/* ---- housekeeping: drop photos uploaded but never attached to a recipe ---- */
const sweep = () =>
  Photo.destroy({ where: { recipeId: null, createdAt: { [Op.lt]: new Date(Date.now() - 24 * 3600_000) } } }).catch((e) => console.error('sweep', e.message));
sweep();
setInterval(sweep, 6 * 3600_000).unref();

const port = +process.env.PORT || 3000;
app.listen(port, () => console.log(`Recetario escuchando en :${port}`));
