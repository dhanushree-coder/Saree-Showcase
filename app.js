// Website Studio
// Shows your websites ("My works") as cards. The owner signs in with the lock button
// and can add, edit, reorder and delete cards. Everything is stored in Firebase Firestore.
//
// Firestore layout:
//   works/{id}              name, kind, url, theme, tags, order, cover (small picture), pageCount
//   works/{id}/pages/{pid}  label, src (one compressed screenshot), order
//   site/profile            brand, price, insta, wa

import { firebaseConfig, OWNER_EMAIL } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.11.0/';

/* ---------------- limits ---------------- */
const MAX_WORKS = 24;          // websites (cards)
const MAX_PAGES = 12;          // screenshots per website
const PAGE_CHARS = 900000;     // one screenshot must fit in a 1 MiB Firestore document

/* ---------------- look-up tables ---------------- */
const THEMES = [
  { id: 'ruby', n: 'Ruby', bg: '#FF4D6D' },
  { id: 'orchid', n: 'Orchid', bg: '#A66BFF' },
  { id: 'mint', n: 'Mint', bg: '#3DDC97' },
  { id: 'berry', n: 'Berry', bg: '#E0489C' },
  { id: 'plum', n: 'Plum', bg: '#7A3FBF' },
  { id: 'jade', n: 'Jade', bg: '#17B978' }
];
const TAG_PRESETS = [
  { e: '🔥', t: 'Trending design', c: '#FF4D6D' },
  { e: '🛍️', t: 'Sold by many', c: '#3DDC97' },
  { e: '✨', t: 'New launch', c: '#A66BFF' },
  { e: '💖', t: 'Customer favourite', c: '#E0489C' },
  { e: '⭐', t: 'Top rated', c: '#A66BFF' },
  { e: '🎀', t: 'Special pick', c: '#E0489C' },
  { e: '🌸', t: 'Festive pick', c: '#FF4D6D' },
  { e: '👑', t: 'Premium', c: '#A66BFF' }
];
const TAG_EMOJI = ['💖', '🔥', '✨', '🛍️', '🎀', '🌸', '👑', '⭐', '🏆', '🚀', '💎', '🧵'];
const TAG_COLORS = ['#FF4D6D', '#A66BFF', '#3DDC97', '#E0489C'];
const DEFAULTS = { brand: '[Your brand name]', price: '[Your price]', insta: '[@yourhandle]', wa: '[Your number]' };

/* ---------------- state ---------------- */
let app = null, auth = null, db = null, fb = null;
let works = [], profile = {};
let user = null, canEdit = false, editing = false;
let status = 'loading';        // loading | ready | setup | offline | rules
const pagesCache = {};

/* ---------------- small helpers ---------------- */
const $ = (s, r) => (r || document).querySelector(s);

function h(tag, a, kids) {
  const e = document.createElement(tag);
  Object.entries(a || {}).forEach(([k, v]) => {
    if (v === false || v == null) return;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  });
  (kids || []).forEach(c => { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return e;
}
function svg(path, size) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', size || 20); s.setAttribute('height', size || 20); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = path;
  return s;
}
const I_L = '<path d="m15 18-6-6 6-6"/>';
const I_R = '<path d="m9 6 6 6-6 6"/>';
const I_X = '<path d="M6 6l12 12M18 6 6 18"/>';
const I_OUT = '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>';
const I_LOCK = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
const I_UNLOCK = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>';

const theme = id => THEMES.find(t => t.id === id) || THEMES[0];
const host = u => { try { return new URL(u).host; } catch (e) { return ''; } };
const kb = chars => Math.round(chars * 0.75 / 1024);
const sizeText = chars => { const k = kb(chars); return k >= 1024 ? (k / 1024).toFixed(1) + ' MB' : k + ' KB'; };

function toast(msg, ms) {
  const old = $('.toast'); if (old) old.remove();
  const t = h('div', { class: 'toast', role: 'status', text: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms || 3200);
}
function dbMsg(e) {
  console.error('Website Studio:', e);
  const c = e && e.code;
  if (c === 'permission-denied') return 'Firebase refused this for ' + ((auth && auth.currentUser && auth.currentUser.email) || 'a signed-out visitor') + '. Publish the rules from firestore.rules (Firestore Database, Rules tab) and sign in as ' + OWNER_EMAIL + '.';
  if (c === 'unavailable' || c === 'failed-precondition' || /network/i.test((e && e.message) || '')) return 'Could not reach Firebase. Check your internet and try again.';
  return 'Could not save. ' + ((e && e.message) || '');
}

/* ---------------- dialogs ---------------- */
function lockScroll(on) { document.body.style.overflow = on ? 'hidden' : ''; }
function trap(e, root) {
  const f = root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]');
  if (!f.length) return;
  const a = f[0], z = f[f.length - 1];
  if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
  else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
}
// o: title, sub, label, narrow, sticky (no close on backdrop click), extraHead, body[], foot[], onKey, onClose, focus
function modal(o) {
  const opener = document.activeElement;
  let closed = false;
  const closeBtn = h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: done }, [svg(I_X, 22)]);
  const dlg = h('div', { class: 'dlg' + (o.narrow ? ' narrow' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': o.label || o.title }, [
    h('div', { class: 'dh' }, [h('h2', {}, [o.title, o.sub ? h('span', { class: 'sub', text: o.sub }) : null]), o.extraHead || null, closeBtn]),
    h('div', { class: 'db' }, o.body || []),
    o.foot ? h('div', { class: 'df' }, o.foot) : null
  ]);
  const shade = h('div', { class: 'shade', onclick: e => { if (e.target === shade && !o.sticky) done(); } }, [dlg]);
  function key(e) {
    if (e.key === 'Escape') done();
    else if (e.key === 'Tab') trap(e, dlg);
    else if (o.onKey) o.onKey(e);
  }
  function done() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', key);
    shade.remove(); lockScroll(false);
    if (o.onClose) o.onClose();
    if (opener && opener.focus) opener.focus();
  }
  document.addEventListener('keydown', key);
  document.body.appendChild(shade); lockScroll(true);
  (o.focus || closeBtn).focus();
  return { close: done, dlg, isClosed: () => closed };
}

/* ---------------- pictures ---------------- */
function loadImage(file) {
  return new Promise((res, rej) => {
    if (!/^image\//.test(file.type) || /svg/.test(file.type)) return rej(new Error('type'));
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('read')); };
    im.src = url;
  });
}
function encode(im, maxW, q) {
  const s = Math.min(1, maxW / im.naturalWidth, 4000 / im.naturalHeight);
  const w = Math.max(1, Math.round(im.naturalWidth * s)), hh = Math.max(1, Math.round(im.naturalHeight * s));
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, hh); x.drawImage(im, 0, 0, w, hh);
  let out = c.toDataURL('image/webp', q);
  if (out.indexOf('data:image/webp') !== 0) out = c.toDataURL('image/jpeg', q);
  return out;
}
// Shrinks a screenshot until it fits in one Firestore document.
async function shrink(file) {
  const im = await loadImage(file);
  for (const w of [1000, 800, 640, 520]) {
    for (const q of [0.76, 0.6]) {
      const out = encode(im, w, q);
      if (out.length <= PAGE_CHARS) return out;
    }
  }
  throw new Error('big');
}
// A small 4:3 picture of the top of the first page, used on the card.
function makeCover(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      const sh = Math.min(im.naturalHeight, im.naturalWidth * 3 / 4);
      const w = Math.min(640, im.naturalWidth), hh = Math.max(1, Math.round(w * sh / im.naturalWidth));
      const c = document.createElement('canvas'); c.width = w; c.height = hh;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, hh);
      x.drawImage(im, 0, 0, im.naturalWidth, sh, 0, 0, w, hh);
      let out = c.toDataURL('image/webp', 0.72);
      if (out.indexOf('data:image/webp') !== 0) out = c.toDataURL('image/jpeg', 0.74);
      res(out);
    };
    im.onerror = () => rej(new Error('cover'));
    im.src = src;
  });
}

/* ---------------- text from "My details" ---------------- */
function renderProfile() {
  document.querySelectorAll('[data-f]').forEach(e => { e.textContent = profile[e.dataset.f] || DEFAULTS[e.dataset.f]; });
}

/* ---------------- tags ---------------- */
function tagChip(t, extra) {
  const c = /^#[0-9a-f]{6}$/i.test(t.c || '') ? t.c : '#A66BFF';
  return h('span', { class: 'tag' + (extra || ''), style: '--tg:' + c }, [h('span', { class: 'em', 'aria-hidden': 'true', text: t.e || '' }), h('span', { text: t.t })]);
}

/* ---------------- owner toolbar + cards ---------------- */
function renderTools() {
  const m = $('#tools-mount'); m.replaceChildren();
  if (!canEdit) return;
  if (!editing) {
    m.appendChild(h('button', { class: 'btn btn-dark btn-sm', type: 'button', onclick: () => { editing = true; renderTools(); renderWorks(); } }, ['Edit my works']));
    m.appendChild(h('span', { class: 'note', text: 'Only you see this button.' }));
  } else {
    m.appendChild(h('button', { class: 'btn btn-dark btn-sm', type: 'button', onclick: () => openEditor(-1) }, ['Add a website']));
    m.appendChild(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: openProfile }, ['My details']));
    m.appendChild(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { editing = false; renderTools(); renderWorks(); } }, ['Done']));
    m.appendChild(h('span', { class: 'note', text: works.length + ' of ' + MAX_WORKS + ' websites' }));
  }
}

function renderWorks() {
  const m = $('#works-mount'); m.replaceChildren();
  const note = txt => m.appendChild(h('div', { class: 'empty' }, [h('p', { text: txt })]));
  if (status === 'setup') return note('To show my works, add your Firebase details to firebase-config.js and reload this page.');
  if (status === 'loading') return note('Loading my works…');
  if (status === 'rules') return note('My works cannot be read yet. Publish the rules from firestore.rules in your Firebase console (Firestore Database, Rules tab).');
  if (status === 'offline') return note('Could not load my works. Check your internet and reload.');
  if (!works.length) return note(canEdit ? 'No websites here yet. Press "Edit my works", then "Add a website", to show your first project.' : 'My projects will appear here soon.');

  const grid = h('div', { class: 'wk' });
  works.forEach((w, i) => {
    const t = theme(w.theme);
    const card = h('article', { class: 'card', style: '--bg:' + t.bg });
    const count = w.pageCount || 0;
    card.appendChild(h('button', { class: 'open', type: 'button', 'aria-label': 'View all ' + count + ' pages of ' + w.name, onclick: ev => openViewer(i, ev.currentTarget) }, [
      h('span', { class: 'frame' }, [
        h('span', { class: 'bar' }, [h('i'), h('i'), h('i'), h('span', { class: 'url', text: host(w.url) || w.name })]),
        h('img', { src: w.cover || '', alt: 'Home page of ' + w.name, loading: 'lazy' })
      ]),
      h('span', { class: 'meta' }, [
        h('span', { class: 'nm', text: w.name }),
        w.kind ? h('span', { class: 'kind', text: w.kind }) : null,
        h('span', { class: 'cnt', text: count + (count === 1 ? ' page' : ' pages') + ' · View' })
      ])
    ]));
    if (w.tags && w.tags.length) card.appendChild(h('div', { class: 'tags' }, w.tags.slice(0, 3).map(t2 => tagChip(t2))));
    if (canEdit && editing) card.appendChild(controls(i, w));
    grid.appendChild(card);
  });
  m.appendChild(grid);
}

function controls(i, w) {
  const box = h('div', { class: 'ctl' });
  function plain() {
    box.replaceChildren();
    box.appendChild(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'Move ' + w.name + ' earlier', disabled: i === 0, onclick: () => move(i, -1) }, [svg(I_L, 16)]));
    box.appendChild(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': 'Move ' + w.name + ' later', disabled: i === works.length - 1, onclick: () => move(i, 1) }, [svg(I_R, 16)]));
    box.appendChild(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openEditor(i) }, ['Edit']));
    box.appendChild(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: ask }, ['Delete']));
  }
  function ask() {
    box.replaceChildren();
    box.appendChild(h('p', { class: 'q', text: 'Delete ' + w.name + ' and all its pages?' }));
    const yes = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => remove(i, box, plain) }, ['Yes, delete']);
    box.appendChild(yes);
    box.appendChild(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: plain }, ['Keep it']));
    yes.focus();
  }
  plain();
  return box;
}

async function move(i, d) {
  const a = works[i], b = works[i + d];
  if (!a || !b) return;
  try {
    const batch = fb.writeBatch(db);
    batch.update(fb.doc(db, 'works', a.id), { order: b.order });
    batch.update(fb.doc(db, 'works', b.id), { order: a.order });
    await batch.commit();
    const oa = a.order; a.order = b.order; b.order = oa;
    works.sort((x, y) => x.order - y.order);
    renderWorks();
  } catch (e) { toast(dbMsg(e), 5000); }
}

async function remove(i, box, plain) {
  const w = works[i];
  box.replaceChildren(h('p', { class: 'q', text: 'Deleting…' }));
  try {
    const pages = await fb.getDocs(fb.collection(db, 'works', w.id, 'pages'));
    for (const p of pages.docs) await fb.deleteDoc(p.ref);
    await fb.deleteDoc(fb.doc(db, 'works', w.id));
    delete pagesCache[w.id];
    works.splice(i, 1);
    renderTools(); renderWorks(); toast('Deleted');
  } catch (e) { toast(dbMsg(e), 5000); plain(); }
}

/* ---------------- viewer (every page of one website) ---------------- */
async function loadPages(id) {
  if (pagesCache[id]) return pagesCache[id];
  const snap = await fb.getDocs(fb.query(fb.collection(db, 'works', id, 'pages'), fb.orderBy('order')));
  pagesCache[id] = snap.docs.map(d => ({ id: d.id, label: d.data().label || '', src: d.data().src }));
  return pagesCache[id];
}

function openViewer(wi) {
  const w = works[wi];
  let pages = [], pi = 0;
  const img = h('img', { alt: '' });
  const shot = h('div', { class: 'shot', tabindex: '0', role: 'region', 'aria-label': 'Page screenshot, scrollable' }, [img]);
  const prev = h('button', { class: 'nav-b', type: 'button', 'aria-label': 'Previous page', disabled: true, onclick: () => go(pi - 1) }, [svg(I_L)]);
  const next = h('button', { class: 'nav-b', type: 'button', 'aria-label': 'Next page', disabled: true, onclick: () => go(pi + 1) }, [svg(I_R)]);
  const cap = h('b', { text: 'Loading pages…' }), cnt = h('span');
  const thumbs = h('div', { class: 'thumbs' });
  const link = /^https?:\/\//.test(w.url || '') ? h('a', { class: 'btn btn-ghost btn-sm', href: w.url, target: '_blank', rel: 'noopener noreferrer' }, ['Visit site', svg(I_OUT, 16)]) : null;
  const m = modal({
    title: w.name, sub: w.kind || '', label: w.name + ' pages', extraHead: link,
    body: [
      w.tags && w.tags.length ? h('div', { class: 'trow' }, w.tags.slice(0, 3).map(t => tagChip(t, ' static'))) : null,
      h('div', { class: 'stage' }, [prev, shot, next]),
      h('div', { class: 'cap' }, [cap, cnt]),
      thumbs
    ],
    onKey: e => {
      if (document.activeElement === shot) return;
      if (e.key === 'ArrowLeft') go(pi - 1);
      else if (e.key === 'ArrowRight') go(pi + 1);
    }
  });
  function go(k) {
    if (k < 0 || k >= pages.length) return;
    pi = k;
    const p = pages[k];
    img.src = p.src; img.alt = (p.label || 'Page ' + (k + 1)) + ' of ' + w.name;
    cap.textContent = p.label || 'Page ' + (k + 1); cnt.textContent = (k + 1) + ' / ' + pages.length;
    prev.disabled = k === 0; next.disabled = k === pages.length - 1; shot.scrollTop = 0;
    Array.from(thumbs.children).forEach((b, j) => { b.setAttribute('aria-current', j === k ? 'true' : 'false'); });
  }
  loadPages(w.id).then(list => {
    if (m.isClosed()) return;
    pages = list;
    if (!pages.length) { cap.textContent = 'This website has no pages yet.'; return; }
    pages.forEach((p, k) => thumbs.appendChild(h('button', { class: 'th', type: 'button', 'aria-label': 'Go to ' + (p.label || 'page ' + (k + 1)), onclick: () => go(k) }, [h('img', { src: p.src, alt: '' })])));
    go(0);
  }, e => { if (!m.isClosed()) cap.textContent = 'Could not load the pages. Check your internet and try again.'; console.error(e); });
}

/* ---------------- editor: add or edit one website ---------------- */
function openEditor(wi) {
  const isNew = wi < 0;
  if (isNew && works.length >= MAX_WORKS) { toast('You can keep up to ' + MAX_WORKS + ' websites. Delete one to add another.', 5000); return; }
  const src = isNew ? null : works[wi];
  const d = isNew
    ? { id: '', name: '', kind: '', url: '', theme: 'ruby', tags: [], pages: [], origIds: [] }
    : { id: src.id, name: src.name, kind: src.kind || '', url: src.url || '', theme: src.theme || 'ruby', tags: (src.tags || []).map(t => ({ ...t })), pages: [], origIds: [] };
  let loaded = isNew, busy = false;

  const name = h('input', { class: 'in-t', id: 'e-name', type: 'text', maxlength: '60', value: d.name, autocomplete: 'off' });
  const kind = h('input', { class: 'in-t', id: 'e-kind', type: 'text', maxlength: '80', value: d.kind, placeholder: 'For example: Bakery, Chennai', autocomplete: 'off' });
  const url = h('input', { class: 'in-t', id: 'e-url', type: 'url', value: d.url, placeholder: 'https://', autocomplete: 'off' });
  const err = h('p', { class: 'err', role: 'alert', hidden: true });
  const meter = h('p', { class: 'meter' });
  const list = h('div', { class: 'pg' });
  const stat = h('p', { class: 'meter', 'aria-live': 'polite' });
  const fail = msg => { err.textContent = msg; err.hidden = !msg; };

  const themes = h('fieldset', { class: 'themes' }, [h('legend', { text: 'Card theme' })].concat(THEMES.map(t => {
    const r = h('input', { type: 'radio', name: 'e-theme', value: t.id, id: 'th-' + t.id, checked: d.theme === t.id });
    r.addEventListener('change', () => { d.theme = t.id; });
    return h('label', { for: 'th-' + t.id }, [r, h('span', { class: 'tsw' }, [h('i', { style: 'background:' + t.bg }), t.n])]);
  })));

  /* tags */
  const tagBox = h('div', { class: 'f' });
  function tagUI() {
    tagBox.replaceChildren();
    tagBox.appendChild(h('span', { style: 'font-weight:700;font-size:14px', text: 'Hang tags (up to 3)' }));
    tagBox.appendChild(h('small', { text: 'They hang from the top of the card, like a shop tag.' }));
    const cur = h('div', { class: 'tagpick' });
    d.tags.forEach((t, i) => {
      const chip = tagChip(t, ' static');
      chip.appendChild(h('button', { class: 'tx', type: 'button', 'aria-label': 'Remove tag ' + t.t, onclick: () => { d.tags.splice(i, 1); fail(''); tagUI(); } }, [svg(I_X, 12)]));
      cur.appendChild(chip);
    });
    if (!d.tags.length) cur.appendChild(h('small', { text: 'No tags yet. Pick one below.' }));
    tagBox.appendChild(cur);
    const pre = h('div', { class: 'tagpick' });
    TAG_PRESETS.forEach(p => {
      const on = d.tags.some(t => t.t === p.t);
      pre.appendChild(h('button', { class: 'tp', type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: () => {
        fail('');
        if (on) d.tags = d.tags.filter(t => t.t !== p.t);
        else if (d.tags.length >= 3) { fail('You can hang up to 3 tags. Remove one first.'); return; }
        else d.tags.push({ e: p.e, t: p.t, c: p.c });
        tagUI();
      } }, [h('span', { 'aria-hidden': 'true', text: p.e }), h('span', { text: p.t })]));
    });
    tagBox.appendChild(pre);
    const sel = h('select', { class: 'in-t', 'aria-label': 'Emoji for your own tag' }, TAG_EMOJI.map(x => h('option', { value: x, text: x })));
    const txt = h('input', { class: 'in-t', type: 'text', maxlength: '24', placeholder: 'Or write your own tag', 'aria-label': 'Your own tag text', autocomplete: 'off' });
    const addb = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, ['Add my tag']);
    function addCustom() {
      const v = txt.value.trim(); fail('');
      if (!v) { fail('Type the tag text first.'); txt.focus(); return; }
      if (d.tags.length >= 3) { fail('You can hang up to 3 tags. Remove one first.'); return; }
      if (d.tags.some(t => t.t.toLowerCase() === v.toLowerCase())) { fail('That tag is already on this card.'); return; }
      d.tags.push({ e: sel.value, t: v, c: TAG_COLORS[d.tags.length % TAG_COLORS.length] });
      tagUI();
    }
    addb.addEventListener('click', addCustom);
    txt.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });
    tagBox.appendChild(h('div', { class: 'tagadd' }, [sel, txt, addb]));
  }

  /* pages */
  function rows() {
    list.replaceChildren();
    d.pages.forEach((p, k) => {
      const lab = h('input', { class: 'in-t', type: 'text', maxlength: '60', value: p.label, 'aria-label': 'Name of page ' + (k + 1), placeholder: 'Page ' + (k + 1) });
      lab.addEventListener('input', () => { p.label = lab.value; });
      const rep = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Replace picture for page ' + (k + 1) });
      rep.addEventListener('change', () => {
        const f = rep.files[0]; if (!f) return;
        stat.textContent = 'Replacing…'; fail('');
        shrink(f).then(s => { p.src = s; p.changed = true; stat.textContent = ''; rows(); },
          () => { stat.textContent = ''; fail('That file is not a picture I can read. Use a PNG, JPG or WebP screenshot.'); });
      });
      list.appendChild(h('div', { class: 'pr' }, [
        h('img', { src: p.src, alt: '' }), lab,
        h('div', { class: 'acts' }, [
          h('button', { class: 'ib', type: 'button', 'aria-label': 'Move page ' + (k + 1) + ' up', disabled: k === 0, onclick: () => swap(k, -1) }, [svg(I_L, 16)]),
          h('button', { class: 'ib', type: 'button', 'aria-label': 'Move page ' + (k + 1) + ' down', disabled: k === d.pages.length - 1, onclick: () => swap(k, 1) }, [svg(I_R, 16)]),
          h('span', { class: 'ib fileb' }, ['Replace', rep]),
          h('button', { class: 'ib bad', type: 'button', 'aria-label': 'Delete page ' + (k + 1), onclick: () => { d.pages.splice(k, 1); rows(); } }, ['Delete'])
        ])
      ]));
    });
    const total = d.pages.reduce((a, p) => a + p.src.length, 0);
    meter.textContent = d.pages.length + ' of ' + MAX_PAGES + ' pages · about ' + sizeText(total) + ' · each picture is kept under 1 MB';
  }
  function swap(k, dir) { const x = d.pages.splice(k, 1)[0]; d.pages.splice(k + dir, 0, x); rows(); }

  const add = h('input', { type: 'file', accept: 'image/*', multiple: true, id: 'e-files', 'aria-label': 'Add page screenshots' });
  add.addEventListener('change', async () => {
    let files = Array.from(add.files); add.value = ''; fail('');
    if (!files.length) return;
    const room = MAX_PAGES - d.pages.length;
    let note = '';
    if (files.length > room) { files = files.slice(0, Math.max(room, 0)); note = 'Only ' + MAX_PAGES + ' pages fit on one website, so extra pictures were skipped. '; }
    let bad = 0;
    for (let i = 0; i < files.length; i++) {
      stat.textContent = 'Adding ' + (i + 1) + ' of ' + files.length + '…';
      try { d.pages.push({ id: '', label: 'Page ' + (d.pages.length + 1), src: await shrink(files[i]), changed: true }); rows(); }
      catch (e) { bad++; }
    }
    stat.textContent = '';
    if (bad) note += bad + (bad === 1 ? ' file was' : ' files were') + ' skipped. Only picture files (PNG, JPG, WebP) can be added.';
    if (note) fail(note.trim());
  });

  const saveBtn = h('button', { class: 'btn btn-dark', type: 'button', disabled: !isNew }, ['Save website']);
  const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, ['Cancel']);

  saveBtn.addEventListener('click', async () => {
    if (busy || !loaded) return;
    fail('');
    const nm = name.value.trim(); if (!nm) { fail('Give the website a name.'); name.focus(); return; }
    const u = url.value.trim();
    if (u) { try { const pu = new URL(u); if (pu.protocol !== 'http:' && pu.protocol !== 'https:') throw 0; } catch (e) { fail('The live link must start with http:// or https://, or be left empty.'); url.focus(); return; } }
    if (!d.pages.length) { fail('Add at least one page screenshot.'); return; }
    d.name = nm; d.kind = kind.value.trim(); d.url = u;
    busy = true; saveBtn.disabled = true; cancel.disabled = true;
    try {
      const saved = await saveWork(d, isNew, txt => { saveBtn.textContent = txt; });
      if (isNew) works.push(saved); else works[wi] = saved;
      works.sort((a, b) => a.order - b.order);
      renderTools(); renderWorks(); toast('Saved');
      m.close();
    } catch (e) {
      busy = false; saveBtn.disabled = false; cancel.disabled = false; saveBtn.textContent = 'Save website';
      fail(dbMsg(e));
    }
  });

  const m = modal({
    title: isNew ? 'Add a website' : 'Edit website', sticky: true, focus: name,
    body: [
      h('label', { class: 'f', for: 'e-name' }, ['Website name', name]),
      h('label', { class: 'f', for: 'e-kind' }, ['What it is', kind]),
      h('label', { class: 'f', for: 'e-url' }, [h('span', {}, ['Live link ', h('small', { text: '(optional)' })]), url]),
      themes, tagBox,
      h('div', { class: 'f' }, [
        h('span', { style: 'font-weight:700;font-size:14px', text: 'Pages, in the order visitors see them' }),
        h('small', { text: 'Add one screenshot for every page of the website. The first page becomes the card picture.' })
      ]),
      list, stat,
      h('span', { class: 'btn btn-ghost btn-sm fileb', style: 'align-self:flex-start' }, ['Add page screenshots', add]),
      meter, err
    ],
    foot: [cancel, saveBtn]
  });
  tagUI(); rows();

  if (!isNew) {
    stat.textContent = 'Loading pages…';
    loadPages(d.id).then(list2 => {
      if (m.isClosed()) return;
      d.pages = list2.map((p, i) => ({ id: p.id, label: p.label, src: p.src, changed: false, oLabel: p.label, oOrder: i }));
      d.origIds = list2.map(p => p.id);
      loaded = true; saveBtn.disabled = false; stat.textContent = ''; rows();
    }, e => { stat.textContent = ''; fail('Could not load this website\'s pages. Close and try again.'); console.error(e); });
  }
}

// Writes the pictures first, then the card itself.
async function saveWork(d, isNew, progress) {
  const id = isNew ? fb.doc(fb.collection(db, 'works')).id : d.id;
  const pagesCol = fb.collection(db, 'works', id, 'pages');
  const keep = new Set();
  for (let i = 0; i < d.pages.length; i++) {
    const p = d.pages[i];
    progress('Saving page ' + (i + 1) + ' of ' + d.pages.length + '…');
    if (!p.id) {
      p.id = fb.doc(pagesCol).id;
      await fb.setDoc(fb.doc(pagesCol, p.id), { label: p.label || '', src: p.src, order: i });
    } else if (p.changed) {
      await fb.setDoc(fb.doc(pagesCol, p.id), { label: p.label || '', src: p.src, order: i });
    } else if ((p.label || '') !== (p.oLabel || '') || i !== p.oOrder) {
      await fb.updateDoc(fb.doc(pagesCol, p.id), { label: p.label || '', order: i });
    }
    keep.add(p.id);
  }
  for (const old of d.origIds) if (!keep.has(old)) await fb.deleteDoc(fb.doc(pagesCol, old));
  progress('Saving card…');
  const cover = await makeCover(d.pages[0].src);
  const existing = isNew ? null : works.find(w => w.id === id);
  const order = existing ? existing.order : (works.length ? Math.max(...works.map(w => w.order || 0)) + 1 : 0);
  const data = { name: d.name, kind: d.kind, url: d.url, theme: d.theme, tags: d.tags, order, cover, pageCount: d.pages.length };
  await fb.setDoc(fb.doc(db, 'works', id), data);
  pagesCache[id] = d.pages.map(p => ({ id: p.id, label: p.label || '', src: p.src }));
  return { id, ...data };
}

/* ---------------- My details ---------------- */
function openProfile() {
  const fields = [['brand', 'Brand name'], ['price', 'Monthly price'], ['insta', 'Instagram handle'], ['wa', 'WhatsApp number']];
  const inputs = {}, err = h('p', { class: 'err', role: 'alert', hidden: true });
  const body = fields.map(([k, label]) => {
    inputs[k] = h('input', { class: 'in-t', id: 'p-' + k, type: 'text', maxlength: '60', value: profile[k] || '', placeholder: DEFAULTS[k], autocomplete: 'off' });
    return h('label', { class: 'f', for: 'p-' + k }, [label, inputs[k]]);
  });
  const save = h('button', { class: 'btn btn-dark', type: 'button' }, ['Save details']);
  save.addEventListener('click', async () => {
    const next = {};
    fields.forEach(([k]) => { const v = inputs[k].value.trim(); if (v) next[k] = v; });
    save.disabled = true; save.textContent = 'Saving…';
    try {
      await fb.setDoc(fb.doc(db, 'site', 'profile'), next);
      profile = next; renderProfile(); toast('Saved'); m.close();
    } catch (e) { save.disabled = false; save.textContent = 'Save details'; err.textContent = dbMsg(e); err.hidden = false; }
  });
  const m = modal({
    title: 'My details', narrow: true, focus: inputs.brand, body: body.concat([err]),
    foot: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => m.close() }, ['Cancel']), save]
  });
}

/* ---------------- lock button: sign in and account ---------------- */
function updateLock() {
  const b = $('#lock');
  b.classList.toggle('on', canEdit);
  b.setAttribute('aria-label', user ? 'Account' : 'Owner login');
  b.replaceChildren(svg(canEdit ? I_UNLOCK : I_LOCK, 22));
}
function onLock() {
  if (!auth) {
    modal({ title: 'Owner login', narrow: true, body: [h('p', { text: status === 'setup' ? 'Firebase is not set up yet. Add your details to firebase-config.js, then reload.' : 'Could not reach Firebase. Check your internet and reload.' })] });
    return;
  }
  if (user) openAccount(); else openSignIn();
}
function openSignIn() {
  const email = h('input', { class: 'in-t', id: 's-email', type: 'email', autocomplete: 'username', required: true, placeholder: 'you@example.com' });
  const pw = h('input', { class: 'in-t', id: 's-pw', type: 'password', autocomplete: 'current-password', required: true });
  const err = h('p', { class: 'err', role: 'alert', hidden: true });
  const go = h('button', { class: 'btn btn-dark', type: 'submit' }, ['Sign in']);
  const form = h('form', { class: 'db', style: 'padding:0', novalidate: true }, [
    h('label', { class: 'f', for: 's-email' }, ['Email', email]),
    h('label', { class: 'f', for: 's-pw' }, ['Password', pw]),
    err,
    h('p', { class: 'hint', text: 'Only the site owner can sign in here.' }),
    h('div', { class: 'df', style: 'padding:0;border:0' }, [go])
  ]);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    if (!email.value.trim() || !pw.value) { err.textContent = 'Enter your email and password.'; err.hidden = false; return; }
    go.disabled = true; go.textContent = 'Signing in…';
    try {
      await fb.signInWithEmailAndPassword(auth, email.value.trim(), pw.value);
      m.close();
    } catch (ex) {
      go.disabled = false; go.textContent = 'Sign in';
      const c = ex && ex.code;
      err.textContent = c === 'auth/too-many-requests' ? 'Too many tries. Wait a few minutes and try again.'
        : c === 'auth/network-request-failed' ? 'Could not reach Firebase. Check your internet.'
        : 'Wrong email or password.';
      err.hidden = false;
    }
  });
  const m = modal({ title: 'Owner login', narrow: true, focus: email, body: [form] });
}
function openAccount() {
  const mail = user.email || '';
  const out = h('button', { class: 'btn btn-ghost', type: 'button' }, ['Log out']);
  out.addEventListener('click', async () => { try { await fb.signOut(auth); m.close(); toast('Logged out'); } catch (e) { toast('Could not log out. Try again.'); } });
  const m = modal({
    title: 'Account', narrow: true,
    body: [
      h('div', { class: 'who' }, [h('small', { class: 'hint', text: 'Signed in as' }), h('b', { text: mail }),
        canEdit ? h('span', { class: 'badge ok', text: 'Owner' }) : h('span', { class: 'badge', text: 'Not the owner' })]),
      canEdit ? null : h('p', { class: 'hint', text: 'Only ' + OWNER_EMAIL + ' can edit this site.' })
    ],
    foot: [out]
  });
}

/* ---------------- start ---------------- */
async function loadAll() {
  status = 'loading'; renderWorks();
  try {
    const snap = await fb.getDocs(fb.query(fb.collection(db, 'works'), fb.orderBy('order')));
    works = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const p = await fb.getDoc(fb.doc(db, 'site', 'profile'));
    profile = p.exists() ? p.data() : {};
    status = 'ready';
  } catch (e) {
    console.error(e);
    status = e && e.code === 'permission-denied' ? 'rules' : 'offline';
  }
  renderProfile(); renderTools(); renderWorks();
}

async function start() {
  $('#lock').addEventListener('click', onLock);
  updateLock(); renderProfile(); renderTools();
  const ok = firebaseConfig && firebaseConfig.apiKey && !/PASTE/i.test(firebaseConfig.apiKey);
  if (!ok) { status = 'setup'; renderWorks(); return; }
  try {
    const [A, Au, F] = await Promise.all([
      import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')
    ]);
    app = A.initializeApp(firebaseConfig);
    auth = Au.getAuth(app);
    db = F.getFirestore(app);
    fb = { ...Au, ...F };
  } catch (e) {
    console.error(e); status = 'offline'; renderWorks(); return;
  }
  fb.onAuthStateChanged(auth, u => {
    user = u;
    canEdit = !!u && (u.email || '').toLowerCase() === OWNER_EMAIL.toLowerCase();
    if (!canEdit) editing = false;
    updateLock(); renderTools(); renderWorks();
  });
  await loadAll();
}

start();