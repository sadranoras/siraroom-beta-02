import crypto from 'node:crypto';

const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function jwt(payload, secret) {
  const head = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Minimal LiveKit server SDK: access tokens + RoomService (Twirp/JSON) calls. No dependencies. */
export function createLivekit({ apiKey, apiSecret, wsUrl, httpUrl }) {
  function accessToken({ identity, name, metadata, grants, ttl = 6 * 3600 }) {
    const now = Math.floor(Date.now() / 1000);
    return jwt({ iss: apiKey, sub: identity, name, metadata, nbf: now, exp: now + ttl, video: grants }, apiSecret);
  }

  async function rpc(method, body = {}) {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt(
      { iss: apiKey, nbf: now, exp: now + 60, video: { roomCreate: true, roomList: true, roomAdmin: true, room: body.room || body.name } },
      apiSecret
    );
    const res = await fetch(`${httpUrl}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
    if (!res.ok) throw new Error(data.msg || `LiveKit ${method} failed (${res.status})`);
    return data;
  }

  return { wsUrl, httpUrl, accessToken, rpc };
}
