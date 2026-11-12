export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let onAuthLost = () => {};
export const setAuthHandler = (fn) => (onAuthLost = fn);

async function req(method, url, { json, blob } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (blob) {
    opts.body = blob;
    opts.headers['Content-Type'] = blob.type || 'image/jpeg';
  } else if (json !== undefined) {
    opts.body = JSON.stringify(json);
    opts.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('Sin conexión con el servidor');
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    onAuthLost();
    throw new Error('Sesión expirada');
  }
  if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
  return body;
}

export const loadAll = () => req('GET', '/api/data');
export const login = (password) => req('POST', '/api/login', { json: { password } });
export const logout = () => req('POST', '/api/logout');
export const saveSettings = (s) => req('PUT', '/api/settings', { json: s });
export const putIngredient = (i) => req('PUT', `/api/ingredients/${i.id}`, { json: i });
export const delIngredient = (id) => req('DELETE', `/api/ingredients/${id}`);
export const putRecipe = (r) => req('PUT', `/api/recipes/${r.id}`, { json: r });
export const delRecipe = (id) => req('DELETE', `/api/recipes/${id}`);
export const uploadPhoto = async (blob) => (await req('POST', '/api/photos', { blob })).id;
export const scan = (blob) => req('POST', '/api/scan', { blob });
