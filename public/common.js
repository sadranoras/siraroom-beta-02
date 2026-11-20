export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data.error || 'خطا در ارتباط با سرور');
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(msg, isErr = false) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), 4000);
}

export const fa = (n) => Number(n ?? 0).toLocaleString('fa-IR');
export const money = (n) => (Number(n) === 0 ? 'رایگان' : fa(n) + ' تومان');
export function fdate(s) {
  if (!s) return '—';
  const d = new Date(/Z|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '—' : d.toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' });
}
export const fsize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');

export async function loadSettings() {
  const s = await api('/api/settings/public').catch(() => ({}));
  if (s.primary_color) {
    document.documentElement.style.setProperty('--primary', s.primary_color);
    document.documentElement.style.setProperty('--primary-d', `color-mix(in srgb, ${s.primary_color} 82%, black)`);
  }
  if (s.site_name) document.title = document.title.replace('{site}', s.site_name);
  for (const el of $$('[data-site-name]')) el.textContent = s.site_name || '';
  return s;
}

export async function me() {
  const u = await api('/api/me').catch(() => ({ guest: true }));
  return u.guest ? null : u;
}

export function modal(html, { onClose } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  const close = () => { bg.remove(); onClose?.(); };
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  document.body.append(bg);
  const first = $('input,select,textarea', bg);
  first?.focus();
  return { el: $('.modal', bg), close };
}

export const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[\w\-/?=&.%]*$/.test(n) ? n : '/dashboard');
