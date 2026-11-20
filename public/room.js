import { $, $$, api, esc, toast, loadSettings, me, modal } from './common.js';
import { Whiteboard } from './wb.js';
import { SlideViewer } from './slides.js';

const slug = location.pathname.split('/').pop();
const enc = new TextEncoder(), dec = new TextDecoder();
let LK, room, join, wb, viewer, myRole = 'guest', startedAt = 0, recording = null;
let view = null;                  // what the host is showing everyone: 'wb' | 'doc' | null
let docState = null;              // { id, name, page } of the presented file (kept while the whiteboard is shown)
let docLoaded = null, docChain = Promise.resolve();
const tiles = new Map();          // identity -> tile elements (only people whose camera is on)
const screens = new Map();        // identity -> remote screen-share video track
const hands = new Set();          // identities with raised hand
const speaking = new Set();       // identities currently speaking
let focusVideo, wbWrap, docWrap;

await loadSettings();

// ---------- helpers ----------
const meta = (p) => { try { return JSON.parse(p?.metadata || '{}'); } catch { return {}; } };
const roleOf = (p) => (p?.isLocal ? myRole : meta(p).role || 'participant');
const isStaff = (p) => ['host', 'presenter'].includes(roleOf(p));
const isHost = () => myRole === 'host';
const initial = (n) => (String(n || '?').trim()[0] || '?').toUpperCase();
const roleLabel = { host: 'میزبان', presenter: 'ارائه‌دهنده', participant: 'شرکت‌کننده', guest: 'مهمان' };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('load failed: ' + src));
    document.head.append(s);
  });
}
async function loadLivekit() {
  if (window.LivekitClient) return;
  try { await loadScript('/vendor/livekit-client.umd.min.js'); }
  catch { await loadScript('https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js'); }
}

function sendData(obj, topic, to) {
  if (!room) return;
  room.localParticipant.publishData(enc.encode(JSON.stringify(obj)), { reliable: true, topic, destinationIdentities: to }).catch(() => {});
}

// ---------- pre-join ----------
const [info, user] = await Promise.all([api(`/api/rooms/${slug}/info`).catch((e) => ({ error: e.message })), me()]);
if (info.error) {
  $('#pj-title').textContent = 'اتاق پیدا نشد';
  $('#pj-sub').textContent = info.error;
} else if (info.status !== 'open') {
  $('#pj-title').textContent = info.title;
  $('#pj-sub').textContent = 'این اتاق در حال حاضر بسته است.';
} else {
  document.title = info.title;
  $('#pj-title').textContent = info.title;
  $('#pj-sub').textContent = `برگزارکننده: ${info.owner_name} · ${info.mode === 'class' ? 'حالت کلاس (فقط مدرس صحبت می‌کند)' : 'حالت جلسه (همه می‌توانند صحبت کنند)'}`;
  if (!user && !info.allow_guests) {
    $('#pj-sub').innerHTML = '';
    $('#pj-sub').append('برای ورود به این اتاق ابتدا ');
    const a = document.createElement('a');
    a.href = '/login?next=' + encodeURIComponent(location.pathname); a.textContent = 'وارد حساب خود شوید';
    $('#pj-sub').append(a, '.');
  } else {
    $('#pj-form').classList.remove('hidden');
    if (user) { $('#pj-name-wrap').classList.add('hidden'); }
    if (info.has_password) { $('#pj-pw-wrap').classList.remove('hidden'); $('#pj-pw-wrap label').textContent = 'رمز اتاق (برای میزبان لازم نیست)'; }
    if (!user) {
      const a = document.createElement('a');
      a.href = '/login?next=' + encodeURIComponent(location.pathname); a.textContent = 'ورود با حساب کاربری';
      $('#pj-login').append(a);
    }
    $('#pj-go').addEventListener('click', doJoin);
    $('#pj-name').addEventListener('keydown', (e) => e.key === 'Enter' && doJoin());
    $('#pj-pw').addEventListener('keydown', (e) => e.key === 'Enter' && doJoin());
  }
}

async function doJoin() {
  const btn = $('#pj-go');
  btn.disabled = true; $('#pj-err').textContent = '';
  try {
    join = await api(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: $('#pj-name').value, password: $('#pj-pw').value } });
    await loadLivekit();
    await start({ mic: $('#pj-mic').checked, cam: $('#pj-cam').checked });
  } catch (e) {
    console.error('join failed:', e);
    const errEl = $('#pj-err');
    if (errEl) errEl.textContent = e.message;       // the prejoin box may already be replaced by the "ended" screen
    if (btn) btn.disabled = false;
  }
}

// ---------- room ----------
async function start({ mic, cam }) {
  LK = window.LivekitClient;
  const { Room, RoomEvent, Track } = LK;
  myRole = join.role;
  room = new Room({ adaptiveStream: true, dynacast: true, videoCaptureDefaults: { resolution: LK.VideoPresets.h540.resolution } });

  buildStage();
  const on = (ev, fn) => room.on(ev, fn);

  on(RoomEvent.ParticipantConnected, (p) => { refreshTile(p); renderPeople(); sys(`${p.name || 'کاربر'} وارد شد`); });
  on(RoomEvent.ParticipantDisconnected, (p) => {
    tiles.get(p.identity)?.el.remove(); tiles.delete(p.identity);
    hands.delete(p.identity); screens.delete(p.identity); speaking.delete(p.identity);
    renderFocus(); renderPeople(); sys(`${p.name || 'کاربر'} خارج شد`);
  });
  on(RoomEvent.TrackSubscribed, (track, pub, p) => {
    if (track.kind === 'audio') {
      const el = track.attach(); el.style.display = 'none'; document.body.append(el);
      recording?.addTrack(track.mediaStreamTrack);
    } else if (pub.source === Track.Source.ScreenShare) { screens.set(p.identity, track); renderFocus(); }
    refreshTile(p);
  });
  on(RoomEvent.TrackUnsubscribed, (track, pub, p) => {
    track.detach().forEach((el) => el.remove());
    if (pub.source === Track.Source.ScreenShare) { screens.delete(p.identity); renderFocus(); }
    refreshTile(p);
  });
  for (const ev of [RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished]) {
    on(ev, (a, b) => { const p = b?.identity ? b : a?.identity ? a : room.localParticipant; refreshTile(p); updateControls(); renderPeople(); });
  }
  on(RoomEvent.ActiveSpeakersChanged, (sp) => {
    const ids = new Set(sp.map((s) => s.identity));
    speaking.clear(); ids.forEach((i) => speaking.add(i));
    for (const [id, t] of tiles) t.el.classList.toggle('speaking', ids.has(id));
    $$('#plist .pitem').forEach((row) => row.classList.toggle('speaking', ids.has(row.dataset.id)));
  });
  on(RoomEvent.ParticipantMetadataChanged, (_old, p) => {
    if (p?.isLocal) {
      const r = meta(p).role; if (r) { const was = myRole; myRole = r; applyDrawPerm(); if (was !== r) toast(`نقش شما: ${roleLabel[r] || r}`); }
    }
    renderPeople(); if (p) refreshTile(p);
  });
  on(RoomEvent.ParticipantPermissionsChanged, async (_prev, p) => {
    if (!p?.isLocal) return;
    updateControls();
    if (p.permissions?.canPublish && !p.isMicrophoneEnabled && join.room.mode === 'class') {
      toast('اجازه صحبت به شما داده شد');
      try { await p.setMicrophoneEnabled(true); } catch { /* user denied */ }
    }
  });
  on(RoomEvent.DataReceived, onData);
  on(RoomEvent.Reconnecting, () => toast('اتصال ناپایدار است؛ در حال اتصال مجدد...'));
  on(RoomEvent.Reconnected, () => toast('اتصال برقرار شد'));
  on(RoomEvent.Disconnected, (reason) => {
    const R = LK.DisconnectReason || {};
    showEnded(reason === R.PARTICIPANT_REMOVED ? 'میزبان شما را از جلسه حذف کرد.' : reason === R.ROOM_DELETED ? 'جلسه توسط میزبان پایان یافت.' : 'ارتباط شما با جلسه قطع شد.');
  });

  await room.connect(join.url, join.token);
  startedAt = Date.now();
  $('#prejoin').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#r-title').textContent = join.room.title;
  if (join.role === 'host') { $('#b-muteall').classList.remove('hidden'); $('#b-end').classList.remove('hidden'); $('#b-doc').classList.remove('hidden'); if (join.can_record) $('#b-rec').classList.remove('hidden'); }
  $('#b-wb').classList.toggle('hidden', join.role !== 'host');   // only the host chooses what everyone sees
  wb = new Whiteboard(wbWrap, { send: (m) => sendData(m, 'wb'), canDraw: isStaff(room.localParticipant) });
  viewer = new SlideViewer(docWrap, { sendAnn: (m) => sendData(m, 'ann'), canDraw: join.role === 'host', canNav: join.role === 'host', onNav: docNav });
  applyDrawPerm();

  try { await room.startAudio(); } catch { /* needs gesture — handled below */ }
  document.addEventListener('click', () => { if (!room.canPlaybackAudio) room.startAudio().catch(() => {}); });

  const canPub = room.localParticipant.permissions?.canPublish;
  if (canPub) {
    if (mic) await room.localParticipant.setMicrophoneEnabled(true).catch(() => toast('دسترسی به میکروفن ممکن نشد', true));
    if (cam) await room.localParticipant.setCameraEnabled(true).catch(() => toast('دسترسی به دوربین ممکن نشد', true));
  } else sys('این کلاس در حالت سخنرانی است. برای درخواست صحبت از دکمه «✋ دست» استفاده کنید.');

  refreshTile(room.localParticipant);
  room.remoteParticipants.forEach(refreshTile);
  updateControls(); renderPeople(); bindControls();
  setInterval(tick, 1000); tick();

  // ask a host for the current whiteboard / recording state
  setTimeout(() => {
    const hostIds = [...room.remoteParticipants.values()].filter((p) => roleOf(p) === 'host').map((p) => p.identity);
    if (hostIds.length) sendData({ t: 'sync-req' }, 'ctl', hostIds);
  }, 800);

  window.addEventListener('pagehide', () => navigator.sendBeacon(`/api/rooms/${slug}/leave`, new Blob([JSON.stringify({ leaveToken: join.leaveToken })], { type: 'application/json' })));
}

function buildStage() {
  focusVideo = document.createElement('video');
  focusVideo.autoplay = true; focusVideo.playsInline = true; focusVideo.muted = true;
  wbWrap = document.createElement('div');
  wbWrap.className = 'wb-wrap hidden';
  docWrap = document.createElement('div');
  docWrap.className = 'doc-wrap hidden';
  $('#focus').append(focusVideo, wbWrap, docWrap);
}

// Whiteboard: host + presenters may draw. Annotations on a presented file: the host (teacher) only.
const applyDrawPerm = () => { wb?.setCanDraw(isStaff(room.localParticipant)); viewer?.setCanDraw(isHost()); };

// A tile exists only while the person's camera is on. Everybody else is listed in the people tab only.
function tileFor(p) {
  let t = tiles.get(p.identity);
  if (t) return t;
  const el = document.createElement('div');
  el.className = 'tile';
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.muted = true;
  const label = document.createElement('div'); label.className = 'label';
  const nameEl = document.createElement('span'), stateEl = document.createElement('span');
  label.append(nameEl, stateEl);
  el.append(video, label);
  $('#tiles').append(el);
  t = { el, video, nameEl, stateEl };
  tiles.set(p.identity, t);
  return t;
}

function updateStageEmpty() {
  $('#stage-empty').classList.toggle('hidden', tiles.size > 0 || $('#focus').classList.contains('on'));
}

function refreshTile(p) {
  if (!p) return;
  const { Track } = LK;
  const cam = p.getTrackPublication(Track.Source.Camera);
  const mic = p.getTrackPublication(Track.Source.Microphone);
  const camOn = !!(cam && cam.track && !cam.isMuted);
  if (!camOn) {
    const old = tiles.get(p.identity);
    if (old) { try { cam?.track?.detach(old.video); } catch { /* ignore */ } old.el.remove(); tiles.delete(p.identity); }
    updateStageEmpty();
    return;
  }
  const t = tileFor(p);
  cam.track.attach(t.video);
  t.video.classList.toggle('mirror', !!p.isLocal);
  t.el.classList.toggle('speaking', speaking.has(p.identity));
  t.nameEl.textContent = (p.name || 'کاربر') + (p.isLocal ? ' (شما)' : '');
  t.stateEl.textContent = (hands.has(p.identity) ? '✋ ' : '') + (mic && !mic.isMuted ? '🎙️' : '🔇');
  updateStageEmpty();
}

function renderFocus() {
  const f = $('#focus');
  let on = false;
  focusVideo.classList.add('hidden'); wbWrap.classList.add('hidden'); docWrap.classList.add('hidden');
  if (view === 'wb') { wbWrap.classList.remove('hidden'); on = true; }
  else if (view === 'doc') { docWrap.classList.remove('hidden'); on = true; }
  else if (screens.size) {
    const [, track] = [...screens.entries()][0];
    track.attach(focusVideo);
    focusVideo.classList.remove('hidden'); on = true;
  }
  f.classList.toggle('on', on);
  $('#stage').classList.toggle('has-focus', on);
  updateStageEmpty();
}

// ---------- shared view: whiteboard / presented file (host decides, everyone follows) ----------
const fileUrl = (id) => `/api/files/${id}?t=${encodeURIComponent(join.fileToken)}`;
const clampPage = (n) => Math.max(1, Math.min(5000, Math.round(Number(n)) || 1));

function sendView(to) { sendData({ a: 'view', v: view, doc: docState }, 'ctl', to); }

/** Make the viewer match docState. Serialised so quick page flips never race a download. */
function syncDoc() {
  docChain = docChain.then(async () => {
    const st = docState;
    if (!st || view !== 'doc') return;
    try {
      if (docLoaded !== st.id) {
        docLoaded = null;
        viewer.setName(st.name);
        await viewer.load(fileUrl(st.id));
        docLoaded = st.id;
      }
      if (docState) await viewer.show(docState.page);
    } catch (e) { if (e.message !== 'superseded') toast('نمایش فایل ناموفق بود', true); }
  });
}

function dropDoc() { docState = null; docLoaded = null; viewer?.release(); }

function applyView(m) {
  view = m.v === 'wb' || m.v === 'doc' ? m.v : null;
  const d = m.doc;
  if (d && Number.isInteger(d.id)) docState = { id: d.id, name: String(d.name || '').slice(0, 120), page: clampPage(d.page) };
  else if (!d) dropDoc();
  renderFocus(); updateControls();
  if (view === 'doc') syncDoc();
}

function hostSetView(v) {
  view = v;
  renderFocus(); updateControls(); sendView();
  if (v === 'doc') syncDoc();
}

function docNav({ a }) {
  if (!isHost() || !docState) return;
  if (a === 'close') { dropDoc(); hostSetView(null); return; }
  const page = clampPage(docState.page + (a === 'next' ? 1 : -1));
  if (page === docState.page || (viewer.num && page > viewer.num)) return;
  docState.page = page;
  sendData({ a: 'page', page }, 'ctl');
  syncDoc();
}

function updateControls() {
  if (!room) return;
  const lp = room.localParticipant;
  const canPub = !!lp.permissions?.canPublish;
  const set = (id, active, label, offLabel, enabled = true) => {
    const b = $(id);
    b.textContent = active ? label : offLabel;
    b.classList.toggle('off', !active && /mic|cam/.test(id));
    b.classList.toggle('on', active && /screen|wb|doc|hand/.test(id));
    b.disabled = !enabled;
  };
  set('#b-mic', lp.isMicrophoneEnabled, '🎙️ میکروفن', '🔇 میکروفن', canPub);
  set('#b-cam', lp.isCameraEnabled, '📷 دوربین', '🚫 دوربین', canPub);
  set('#b-screen', lp.isScreenShareEnabled, '⏹ توقف اشتراک', '🖥️ اشتراک صفحه', canPub && !!navigator.mediaDevices?.getDisplayMedia);
  set('#b-wb', view === 'wb', '✏️ بستن وایت‌بورد', '✏️ وایت‌بورد');
  set('#b-doc', view === 'doc', '📄 ارائه فایل', '📄 ارائه فایل');
  set('#b-hand', hands.has(lp.identity), '✋ پایین آوردن دست', '✋ دست', !canPub || join.room.mode === 'class');
  $('#b-hand').classList.toggle('hidden', isHost() || (canPub && join.room.mode !== 'class'));
  set('#b-rec', !!recording, '⏹ توقف ضبط', '⏺ ضبط');
}

function bindControls() {
  const lp = room.localParticipant;
  const guard = (fn) => async () => { try { await fn(); } catch (e) { if (e?.name !== 'NotAllowedError') toast(e.message || 'خطا', true); } updateControls(); };
  $('#b-mic').onclick = guard(() => lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled));
  $('#b-cam').onclick = guard(() => lp.setCameraEnabled(!lp.isCameraEnabled));
  $('#b-screen').onclick = guard(() => lp.setScreenShareEnabled(!lp.isScreenShareEnabled, { audio: true }));
  $('#b-hand').onclick = () => {
    const up = !hands.has(lp.identity);
    up ? hands.add(lp.identity) : hands.delete(lp.identity);
    sendData({ up }, 'hand');
    refreshTile(lp); renderPeople(); updateControls();
  };
  $('#b-wb').onclick = () => { if (isHost()) hostSetView(view === 'wb' ? null : 'wb'); };
  $('#b-doc').onclick = () => { if (isHost()) openFilesModal(); };
  document.addEventListener('keydown', (e) => {          // PowerPoint-style keys for the host while a file is shown
    if (!isHost() || view !== 'doc' || /^(input|textarea|select)$/i.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); docNav({ a: 'next' }); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); docNav({ a: 'prev' }); }
  });
  $('#b-side').onclick = () => $('#main').classList.toggle('no-side');
  $('#b-muteall').onclick = () => { sendData({ a: 'mute-all' }, 'ctl'); toast('درخواست بی‌صدا کردن برای همه ارسال شد'); };
  $('#b-rec').onclick = guard(() => (recording ? stopRecording() : startRecording()));
  $('#b-leave').onclick = async () => { await stopRecording(); await room.disconnect(); };
  $('#b-end').onclick = async () => {
    if (!confirm('جلسه برای همه پایان یابد؟')) return;
    await stopRecording();
    try { await api(`/api/rooms/${slug}/host`, { method: 'POST', body: { action: 'end' } }); } catch (e) { toast(e.message, true); }
  };
  $('#r-copy').onclick = () => navigator.clipboard?.writeText(location.href).then(() => toast('لینک اتاق کپی شد'), () => toast('کپی نشد', true));

  $$('.sidebar .tab').forEach((t) => (t.onclick = () => {
    $$('.sidebar .tab').forEach((x) => x.classList.toggle('active', x === t));
    $('#p-chat').classList.toggle('hidden', t.dataset.p !== 'chat');
    $('#p-people').classList.toggle('hidden', t.dataset.p !== 'people');
  }));
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chat-in').value.trim().slice(0, 500);
    if (!text) return;
    sendData({ text }, 'chat');
    addMsg(lp.name, text, true);
    $('#chat-in').value = '';
  };
  $('#plist').onclick = (e) => {
    const b = e.target.closest('button[data-a]');
    if (b) hostAction(b.dataset.a, b.dataset.id);
  };
}

// ---------- data channel ----------
function onData(payload, p, _kind, topic) {
  let m;
  try { m = JSON.parse(dec.decode(payload)); } catch { return; }
  if (!m || typeof m !== 'object') return;
  const name = p?.name || 'کاربر';
  if (topic === 'chat' && typeof m.text === 'string') addMsg(name, m.text.slice(0, 500), false);
  else if (topic === 'hand' && p) {
    m.up ? hands.add(p.identity) : hands.delete(p.identity);
    if (m.up && isHost()) toast(`✋ ${name} دستش را بالا برد`);
    refreshTile(p); renderPeople();
  } else if (topic === 'wb' && p && isStaff(p)) wb?.apply(m);
  else if (topic === 'ann' && p && roleOf(p) === 'host') viewer?.apply(m);
  else if (topic === 'ctl' && p) {
    if (m.t === 'sync-req') {   // a joiner asks for current state; only hosts answer
      if (!isHost()) return;
      const to = [p.identity];
      sendView(to);
      if (recording) sendData({ a: 'rec', on: true }, 'ctl', to);
      (async () => {
        const msgs = [...wb.snapshotMessages().map((x) => ['wb', x]), ...viewer.snapshotMessages().map((x) => ['ann', x])];
        for (const [topicName, msg] of msgs) { sendData(msg, topicName, to); await new Promise((r) => setTimeout(r, 15)); }
      })();
      return;
    }
    if (roleOf(p) !== 'host') return;   // everything below is host-only
    if (m.a === 'view') applyView(m);
    else if (m.a === 'page') { if (docState) { docState.page = clampPage(m.page); if (view === 'doc') syncDoc(); } }
    else if (m.a === 'rec') $('#r-rec').classList.toggle('hidden', !m.on);
    else if (m.a === 'mute-all' && !isHost() && room.localParticipant.isMicrophoneEnabled) {
      room.localParticipant.setMicrophoneEnabled(false).then(updateControls);
      toast('میزبان همه را بی‌صدا کرد');
    }
  }
}

// ---------- chat / people ----------
function addMsg(who, text, mine) {
  const box = $('#msgs');
  const d = document.createElement('div');
  d.className = 'msg' + (mine ? ' me' : '');
  const w = document.createElement('span'); w.className = 'who'; w.textContent = mine ? 'شما' : who;
  d.append(w, document.createTextNode(text));
  box.append(d); box.scrollTop = box.scrollHeight;
}
function sys(text) {
  const box = $('#msgs');
  if (!box) return;
  const d = document.createElement('div'); d.className = 'msg sys'; d.textContent = text;
  box.append(d); box.scrollTop = box.scrollHeight;
}

function renderPeople() {
  if (!room) return;
  const { Track } = LK;
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  all.sort((a, b) => (hands.has(b.identity) - hands.has(a.identity)) || (roleOf(a) === 'host' ? -1 : 0));
  $('#pc').textContent = all.length;
  $('#r-count').textContent = `${all.length} نفر`;
  const list = $('#plist');
  list.textContent = '';
  for (const p of all) {
    const r = roleOf(p);
    const row = document.createElement('div'); row.className = 'pitem' + (speaking.has(p.identity) ? ' speaking' : ''); row.dataset.id = p.identity;
    const left = document.createElement('div'); left.className = 'who';
    const nameEl = document.createElement('span');
    nameEl.textContent = `${hands.has(p.identity) ? '✋ ' : ''}${p.name || 'کاربر'}${p.isLocal ? ' (شما)' : ''}`;
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = roleLabel[r] || r;
    const camP = p.getTrackPublication(Track.Source.Camera), micP = p.getTrackPublication(Track.Source.Microphone);
    const st = document.createElement('span'); st.className = 'st';
    st.textContent = `${camP && !camP.isMuted ? '📷' : ''}${micP && !micP.isMuted ? '🎙️' : '🔇'}`;
    left.append(nameEl, badge, st);
    row.append(left);
    if (isHost() && !p.isLocal && r !== 'host') {
      const acts = document.createElement('div'); acts.className = 'acts';
      const mk = (a, text) => { const b = document.createElement('button'); b.dataset.a = a; b.dataset.id = p.identity; b.textContent = text; acts.append(b); };
      const mic = p.getTrackPublication(Track.Source.Microphone);
      if (mic && !mic.isMuted) mk('mute', 'بی‌صدا');
      r === 'presenter' ? mk('demote', 'لغو ارائه') : mk('promote', join.room.mode === 'class' ? 'اجازه صحبت' : 'ارائه‌دهنده');
      mk('remove', 'حذف');
      row.append(acts);
    }
    list.append(row);
  }
}

async function hostAction(action, identity) {
  try {
    const body = { action, identity };
    if (action === 'mute') {
      const pub = room.remoteParticipants.get(identity)?.getTrackPublication(LK.Track.Source.Microphone);
      if (!pub) return toast('میکروفن این فرد خاموش است');
      body.trackSid = pub.trackSid;
    }
    if (action === 'remove' && !confirm('این فرد از جلسه حذف شود؟')) return;
    await api(`/api/rooms/${slug}/host`, { method: 'POST', body });
  } catch (e) { toast(e.message, true); }
}

// ---------- presentation files (host) ----------
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');

async function openFilesModal() {
  const m = modal(`<div class="files-modal">
    <h3>ارائهٔ فایل</h3>
    <div class="upload-box">
      <input type="file" id="f-in" accept=".pdf,.ppt,.pptx,.pps,.ppsx,.odp" class="hidden">
      <button class="btn primary" id="f-pick">بارگذاری PDF یا پاورپوینت</button>
      <p class="muted" id="f-hint" style="margin:.5rem 0 0"></p>
    </div>
    <div id="f-list"><p class="muted">در حال بارگیری...</p></div>
    <div class="actions"><button class="btn" data-close>بستن</button></div></div>`);
  const $m = (s) => m.el.querySelector(s);
  $m('[data-close]').onclick = m.close;
  let info = { items: [], max_mb: 50, office: false };

  async function refresh() {
    try { info = await api(`/api/rooms/${slug}/files`); } catch (e) { toast(e.message, true); return; }
    $m('#f-hint').textContent = `حداکثر ${info.max_mb} مگابایت. ` + (info.office ? 'پاورپوینت به‌صورت خودکار به PDF تبدیل می‌شود.' : 'تبدیل پاورپوینت روی این سرور فعال نیست؛ فایل را از PowerPoint با Save as ← PDF ذخیره کنید.');
    $m('#f-list').innerHTML = info.items.length ? `<div class="table-wrap"><table>
      <tr><th>نام فایل</th><th>حجم</th><th></th></tr>
      ${info.items.map((f) => `<tr><td>${esc(f.name)}</td><td>${fmtSize(f.size)}</td>
        <td class="row"><button class="btn sm primary" data-show="${f.id}">ارائه</button><button class="btn sm danger" data-del="${f.id}">حذف</button></td></tr>`).join('')}
      </table></div>` : '<p class="muted" style="margin-top:.75rem">هنوز فایلی بارگذاری نشده است.</p>';
  }

  $m('#f-pick').onclick = () => $m('#f-in').click();
  $m('#f-in').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const isOffice = !/\.pdf$/i.test(file.name);
    if (file.size > info.max_mb * 1048576) return toast(`حجم فایل بیشتر از ${info.max_mb} مگابایت است`, true);
    if (isOffice && !info.office) return toast('تبدیل پاورپوینت روی این سرور فعال نیست؛ آن را به PDF تبدیل کنید', true);
    const btn = $m('#f-pick');
    btn.disabled = true; btn.textContent = isOffice ? 'در حال بارگذاری و تبدیل به PDF...' : 'در حال بارگذاری...';
    try {
      const res = await fetch(`/api/rooms/${slug}/files?name=${encodeURIComponent(file.name)}`, { method: 'PUT', body: file, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'بارگذاری ناموفق بود');
      toast('فایل آماده است');
      await refresh();
    } catch (err) { toast(err.message || 'بارگذاری ناموفق بود', true); }
    btn.disabled = false; btn.textContent = 'بارگذاری PDF یا پاورپوینت';
  };

  m.el.onclick = async (e) => {
    const show = e.target.closest('[data-show]'), del = e.target.closest('[data-del]');
    if (show) {
      const f = info.items.find((x) => x.id === Number(show.dataset.show));
      docState = { id: f.id, name: f.name, page: 1 };
      docLoaded = null;
      m.close();
      hostSetView('doc');
    } else if (del && confirm('این فایل حذف شود؟')) {
      const id = Number(del.dataset.del);
      try {
        await api('/api/files/' + id, { method: 'DELETE' });
        if (docState?.id === id) { dropDoc(); hostSetView(null); }
        await refresh();
      } catch (err) { toast(err.message, true); }
    }
  };
  refresh();
}

// ---------- recording (host's browser → server, streamed in chunks) ----------
async function startRecording() {
  if (recording) return;
  const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: true });
  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const seen = new Set();
  const addTrack = (mst) => {
    if (!mst || seen.has(mst.id)) return;
    seen.add(mst.id);
    try { ac.createMediaStreamSource(new MediaStream([mst])).connect(dest); } catch { /* ignore */ }
  };
  display.getAudioTracks().forEach(addTrack);
  const { Track } = LK;
  addTrack(room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack);
  for (const p of room.remoteParticipants.values()) for (const pub of p.audioTrackPublications.values()) addTrack(pub.track?.mediaStreamTrack);

  let id;
  try { ({ id } = await api(`/api/rooms/${slug}/recordings`, { method: 'POST', body: {} })); }
  catch (e) { display.getTracks().forEach((t) => t.stop()); ac.close(); throw e; }

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const mr = new MediaRecorder(new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]), { mimeType: mime, videoBitsPerSecond: 1500000 });
  let chain = Promise.resolve();
  mr.ondataavailable = (e) => {
    if (!e.data.size) return;
    chain = chain
      .then(() => fetch(`/api/recordings/${id}/chunk`, { method: 'PUT', body: e.data, credentials: 'same-origin' }))
      .then((r) => { if (!r.ok) throw new Error('upload'); })
      .catch(() => { toast('ارسال ضبط به سرور با خطا مواجه شد؛ ضبط متوقف شد', true); stopRecording(); });
  };
  mr.onstop = async () => {
    await chain;
    await api(`/api/recordings/${id}/finish`, { method: 'POST', body: {} }).catch(() => {});
    toast('ضبط ذخیره شد؛ از داشبورد قابل مشاهده است');
  };
  display.getVideoTracks()[0].addEventListener('ended', () => stopRecording());
  mr.start(5000);
  recording = { mr, display, ac, addTrack };
  sendData({ a: 'rec', on: true }, 'ctl');
  $('#r-rec').classList.remove('hidden');
  toast('ضبط شروع شد. همه شرکت‌کنندگان نشانگر «در حال ضبط» را می‌بینند.');
  updateControls();
}

async function stopRecording() {
  if (!recording) return;
  const r = recording;
  recording = null;
  try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch { /* ignore */ }
  r.display.getTracks().forEach((t) => t.stop());
  setTimeout(() => r.ac.close().catch(() => {}), 1000);
  sendData({ a: 'rec', on: false }, 'ctl');
  $('#r-rec').classList.add('hidden');
  updateControls();
}

// ---------- misc ----------
function tick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const f = (n) => String(n).padStart(2, '0');
  $('#r-timer').textContent = `${f(Math.floor(s / 3600))}:${f(Math.floor((s % 3600) / 60))}:${f(s % 60)}`;
}

function showEnded(msg) {
  stopRecording();
  $('#app').classList.add('hidden');
  const box = $('#prejoin');
  box.classList.remove('hidden');
  box.textContent = '';
  const h = document.createElement('h2'); h.textContent = 'جلسه به پایان رسید';
  const p = document.createElement('p'); p.className = 'muted'; p.textContent = msg;
  const b = document.createElement('button'); b.className = 'btn primary'; b.textContent = 'ورود دوباره'; b.onclick = () => location.reload();
  const a = document.createElement('a'); a.href = '/'; a.className = 'btn'; a.textContent = 'صفحه اصلی'; a.style.marginInlineStart = '.5rem';
  box.append(h, p, b, a);
}
