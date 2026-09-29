// Запити до сервера. Кожен підписаний initData (заголовок X-Init-Data).
import { initData } from './tg.js';

export class ApiError extends Error {
  constructor(code, data, status) { super(code); this.code = code; this.data = data || {}; this.status = status; }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Init-Data': initData() },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch (e) {
    throw new ApiError('network', {}, 0);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok || !data || data.ok === false) {
    throw new ApiError((data && data.error) || (res.status === 401 ? 'unauthorized' : 'server_error'), data, res.status);
  }
  return data;
}

export const get = (path) => call('GET', path);
export const post = (path, body) => call('POST', path, body || {});
