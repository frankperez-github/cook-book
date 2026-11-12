// Reads a photo of a handwritten recipe with Gemini and returns structured data.
const PROMPT = `Eres un asistente para una dulcería. La imagen es una receta escrita a mano o impresa, normalmente en español.
Extrae la receta y devuélvela en JSON según el esquema.
Reglas:
- "name": nombre de la receta (si no aparece, inventa uno corto y descriptivo).
- "yield" y "yieldUnit": cuánto rinde la receta. "yieldUnit" es SOLO una de: porciones (rebanadas, personas, raciones), unidades (galletas, cupcakes, panes, piezas), g, kg, ml, l (cuando la receta indica un peso o volumen total, por ejemplo "rinde 1 kg de masa"). Si no se indica nada, usa yield 1 y yieldUnit "porciones".
- "ingredients": un elemento por ingrediente, con "name" en singular y minúsculas, "quantity" numérica y "unit" SOLO uno de: g, kg, ml, l, u.
- Convierte medidas caseras a esas unidades con valores aproximados estándar (1 taza de harina = 120 g, 1 taza de azúcar = 200 g, 1 taza de líquido = 240 ml, 1 cucharada = 15 ml o 15 g según el ingrediente, 1 cucharadita = 5 ml o 5 g, 1 libra = 454 g, 1 onza = 28 g). Los ingredientes que se cuentan (huevos, etc.) van en "u".
- Si un ingrediente no tiene cantidad legible, usa quantity 0.
- "steps": los pasos de preparación en orden, cada uno como una frase clara. Si la receta no tiene pasos, devuelve una lista vacía.
- No inventes ingredientes ni pasos que no estén en la imagen.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    yield: { type: 'NUMBER' },
    yieldUnit: { type: 'STRING', enum: ['porciones', 'unidades', 'g', 'kg', 'ml', 'l'] },
    ingredients: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          quantity: { type: 'NUMBER' },
          unit: { type: 'STRING', enum: ['g', 'kg', 'ml', 'l', 'u'] },
        },
        required: ['name', 'quantity', 'unit'],
      },
    },
    steps: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['name', 'yield', 'yieldUnit', 'ingredients', 'steps'],
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function scanRecipe(buf, mime) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  if (!apiKey) throw new HttpError(503, 'La lectura con IA no está configurada en el servidor.');
  const body = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.1 },
  };
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new HttpError(504, 'Gemini no respondió. Inténtalo de nuevo.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Gemini error', res.status, json?.error?.message);
    if (res.status === 429) throw new HttpError(429, 'Se alcanzó el límite de uso de Gemini. Espera un momento.');
    if (res.status === 503) throw new HttpError(503, 'Gemini está saturado en este momento. Inténtalo de nuevo en unos segundos.');
    if (res.status === 404) throw new HttpError(502, `El modelo "${model}" no existe. Cambia GEMINI_MODEL en el servidor.`);
    throw new HttpError(502, 'Gemini rechazó la solicitud (revisa la clave en el servidor).');
  }
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(422, 'No pude leer la receta de esa foto. Prueba con una foto más clara y de frente.');
  }
}
