'use strict';

const APP_VERSION = '2.1.0';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const DB_NAME = 'rakku-db';
const DB_VERSION = 2;
const MAGIC = 'RAKKU2\r\n';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let db;
let deferredInstallPrompt = null;
const urlCache = new Map();

const state = {
  view: 'boot',
  books: [], profiles: [], settings: {}, currentProfile: null,
  progress: new Map(), search: '',
  editingBook: null, editPages: [],
  readerBook: null, readerPages: [], readerIndex: 0, readerSpread: false,
  busy: '', toast: '', modal: null
};

const $ = (q, root=document) => root.querySelector(q);
const $$ = (q, root=document) => [...root.querySelectorAll(q)];
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const now = () => Date.now();
const escapeHtml = (s='') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const escapeAttr = escapeHtml;
const clamp = (n,min,max) => Math.max(min, Math.min(max,n));
const fmtDate = t => new Intl.DateTimeFormat('ms-MY',{day:'numeric',month:'short',year:'numeric'}).format(new Date(t || now()));
const slug = (s='book') => s.normalize('NFKD').replace(/[^\w\s-]/g,'').trim().replace(/[-\s]+/g,'_').slice(0,80) || 'RakKu';
const sleep = ms => new Promise(r=>setTimeout(r,ms));

function objectUrl(key, blob){
  if(!blob) return '';
  if(urlCache.has(key)) return urlCache.get(key);
  const u = URL.createObjectURL(blob); urlCache.set(key,u); return u;
}
function revokePrefix(prefix){ for(const [k,u] of urlCache){ if(k.startsWith(prefix)){URL.revokeObjectURL(u);urlCache.delete(k);} } }

function openDB(){
  return new Promise((resolve,reject)=>{
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if(!d.objectStoreNames.contains('books')) d.createObjectStore('books',{keyPath:'id'});
      if(!d.objectStoreNames.contains('pages')){ const s=d.createObjectStore('pages',{keyPath:'id'}); s.createIndex('bookId','bookId'); }
      else { const s=r.transaction.objectStore('pages'); if(!s.indexNames.contains('bookId')) s.createIndex('bookId','bookId'); }
      if(!d.objectStoreNames.contains('profiles')) d.createObjectStore('profiles',{keyPath:'id'});
      if(!d.objectStoreNames.contains('progress')){ const s=d.createObjectStore('progress',{keyPath:'id'}); s.createIndex('profileId','profileId'); s.createIndex('bookId','bookId'); }
      if(!d.objectStoreNames.contains('settings')) d.createObjectStore('settings',{keyPath:'key'});
    };
    r.onsuccess = () => { db=r.result; resolve(db); };
    r.onerror = () => reject(r.error);
  });
}
function req(r){ return new Promise((res,rej)=>{r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);}); }
function store(name,mode='readonly'){ return db.transaction(name,mode).objectStore(name); }
async function getAll(name){ return req(store(name).getAll()); }
async function put(name,value){ return req(store(name,'readwrite').put(value)); }
async function del(name,key){ return req(store(name,'readwrite').delete(key)); }
async function clearStore(name){ return req(store(name,'readwrite').clear()); }
async function getSetting(key, fallback=null){ const x=await req(store('settings').get(key)); return x ? x.value : fallback; }
async function setSetting(key,value){ await put('settings',{key,value}); state.settings[key]=value; }

async function loadCore(){
  state.books = (await getAll('books')).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  state.profiles = (await getAll('profiles')).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  const sets=await getAll('settings'); state.settings=Object.fromEntries(sets.map(x=>[x.key,x.value]));
}
async function loadProgress(profileId){
  state.progress.clear();
  if(!profileId) return;
  const all=await req(store('progress').index('profileId').getAll(profileId));
  all.forEach(p=>state.progress.set(p.bookId,p));
}
async function getPages(bookId){ const arr=await req(store('pages').index('bookId').getAll(bookId)); return arr.sort((a,b)=>a.order-b.order); }
async function deleteBookData(bookId){
  const t=db.transaction(['books','pages','progress'],'readwrite');
  t.objectStore('books').delete(bookId);
  for(const sn of ['pages','progress']){
    const idx=t.objectStore(sn).index('bookId');
    idx.openCursor(IDBKeyRange.only(bookId)).onsuccess=e=>{const c=e.target.result;if(c){c.delete();c.continue();}};
  }
  await new Promise((res,rej)=>{t.oncomplete=res;t.onerror=()=>rej(t.error);});
  revokePrefix(`cover:${bookId}`); revokePrefix(`page:${bookId}:`);
  await loadCore(); if(state.currentProfile) await loadProgress(state.currentProfile.id);
}
async function saveProgress(bookId, patch={}){
  if(!state.currentProfile) return;
  const old=state.progress.get(bookId)||{id:`${state.currentProfile.id}:${bookId}`,profileId:state.currentProfile.id,bookId,currentPage:0,favourite:false,completed:false,updatedAt:now()};
  const next={...old,...patch,updatedAt:now()}; await put('progress',next); state.progress.set(bookId,next);
}

async function hashPin(pin){
  const buf=await crypto.subtle.digest('SHA-256', textEncoder.encode(`RakKu:${pin}`));
  return [...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

function showToast(msg){ state.toast=msg; render(); setTimeout(()=>{if(state.toast===msg){state.toast='';render();}},1900); }
function setBusy(msg=''){ state.busy=msg; render(); }
function modal(content){ state.modal=content; render(); }
function closeModal(){ state.modal=null; render(); }

function topbar(){
  const p=state.currentProfile;
  return `<header class="topbar">
    <div class="brandline"><div class="brand">📚 RakKu</div>${p?`<button class="profile-pill" id="switchProfile"><span class="avatar">${escapeHtml(p.avatar||'👤')}</span>${escapeHtml(p.name)}</button>`:''}</div>
    <div class="top-actions">
      ${state.view==='library' && p?.role==='parent' ? '<button class="primary" id="addBook">＋ <span class="label-hide">Buku</span></button><button class="icon-btn" id="settingsBtn" aria-label="Tetapan">⚙️</button>' : ''}
      ${!['library','profiles','setup','pin'].includes(state.view) ? '<button class="ghost" id="backBtn">← Kembali</button>' : ''}
    </div>
  </header>`;
}
function shell(inner){
  return `<main class="app">${topbar()}${inner}${state.toast?`<div class="toast">${escapeHtml(state.toast)}</div>`:''}${state.busy?`<div class="busy-overlay"><div class="busy-card"><div class="spinner"></div><strong>${escapeHtml(state.busy)}</strong></div></div>`:''}${renderModal()}</main>`;
}
function renderModal(){
  if(!state.modal) return '';
  if(state.modal.type==='pin') return `<div class="modal-backdrop"><div class="modal pin-card"><h3>🔐 Parent PIN</h3><p>Masukkan PIN untuk buka Parent Mode.</p><label>PIN<input id="pinInput" inputmode="numeric" type="password" maxlength="6" autocomplete="off" autofocus></label><div id="pinError" class="scan-status"></div><div class="modal-actions"><button class="ghost" id="modalCancel">Batal</button><button class="primary" id="pinSubmit">Buka</button></div></div></div>`;
  if(state.modal.type==='child') return `<div class="modal-backdrop"><div class="modal"><h3>Tambah profil anak</h3><p>Progress membaca akan disimpan berasingan untuk profil ini.</p><div class="field"><label>Nama</label><input id="childName" maxlength="30" placeholder="Contoh: Adam"></div><div class="field" style="margin-top:10px"><label>Avatar</label><select id="childAvatar"><option>👦</option><option>👧</option><option>🧒</option><option>🐯</option><option>🐼</option><option>🦊</option><option>🐰</option><option>🚀</option></select></div><div class="modal-actions"><button class="ghost" id="modalCancel">Batal</button><button class="primary" id="childSave">Tambah</button></div></div></div>`;
  if(state.modal.type==='pinChange') return `<div class="modal-backdrop"><div class="modal"><h3>Tukar Parent PIN</h3><div class="field"><label>PIN baru (4–6 digit)</label><input id="newPin" inputmode="numeric" type="password" maxlength="6"></div><div class="modal-actions"><button class="ghost" id="modalCancel">Batal</button><button class="primary" id="pinChangeSave">Simpan</button></div></div></div>`;
  return '';
}

function setupView(){
  return `<main class="app"><section class="setup-wrap"><div class="setup-card"><div class="setup-logo">📚</div><span class="eyebrow">RAKKU LOCAL FAMILY LIBRARY</span><h1>Sediakan rak keluarga</h1><p>Semua buku disimpan dalam device. Tiada akaun cloud diperlukan.</p><div class="setup-grid"><label>Nama keluarga<input id="familyName" value="Rak Keluarga" maxlength="40"></label><label>Nama Parent<input id="parentName" value="Parent" maxlength="30"></label><label>Parent PIN (4–6 digit)<input id="setupPin" type="password" inputmode="numeric" maxlength="6" placeholder="Contoh: 1234"></label><label>Avatar Parent<select id="parentAvatar"><option>👨</option><option>👩</option><option>🧑</option><option>👨‍👩‍👧‍👦</option></select></label></div><div class="setup-note">🔒 Parent PIN hanya melindungi fungsi edit/delete dalam RakKu. Ia bukan encryption keselamatan tahap tinggi.</div><div style="margin-top:16px"><button class="primary" id="finishSetup">Mula RakKu</button></div></div></section>${state.toast?`<div class="toast">${escapeHtml(state.toast)}</div>`:''}</main>`;
}
function profilesView(){
  const cards=state.profiles.map(p=>`<button class="profile-card" data-profile="${p.id}"><div class="profile-avatar">${escapeHtml(p.avatar||'👤')}</div><strong>${escapeHtml(p.name)}</strong><small>${p.role==='parent'?'Parent Mode':'Kids Mode'}</small></button>`).join('');
  return `<main class="app"><section class="profiles-wrap"><div class="profiles-head"><div style="font-size:3rem">📚</div><h1>${escapeHtml(state.settings.familyName||'RakKu')}</h1><p>Siapa yang nak membaca?</p></div><div class="profile-grid">${cards}</div><div class="notice">Buku kekal pada device ini. Untuk pindah ke Android/iPhone/iPad lain, guna <strong>Share Book (.rakku)</strong> atau <strong>Backup Library</strong> dalam Parent Mode.</div></section>${state.toast?`<div class="toast">${escapeHtml(state.toast)}</div>`:''}${renderModal()}</main>`;
}
function coverHtml(book){
  if(book.coverBlob) return `<img src="${objectUrl(`cover:${book.id}`,book.coverBlob)}" alt="Kulit ${escapeAttr(book.title)}">`;
  if(typeof book.cover==='string' && book.cover.startsWith('data:')) return `<img src="${book.cover}" alt="Kulit ${escapeAttr(book.title)}">`;
  return '<div class="cover-fallback">📖</div>';
}
function libraryView(){
  const q=state.search.trim().toLowerCase();
  const visible=state.books.filter(b=>!q || [b.title,b.author,b.category].some(x=>String(x||'').toLowerCase().includes(q)));
  const parent=state.currentProfile?.role==='parent';
  const cards=visible.map(b=>{
    const pr=state.progress.get(b.id)||{}; const pages=b.pageCount||0; const current=clamp(pr.currentPage||0,0,Math.max(0,pages-1)); const pct=pages?Math.round(((current+(pr.completed?1:0))/pages)*100):0;
    return `<article class="book-card"><button class="cover-btn" data-read="${b.id}">${coverHtml(b)}</button><div class="book-meta"><h3>${escapeHtml(b.title)}</h3><p>${escapeHtml(b.author||b.category||'RakKu')} · ${pages} muka surat</p><div class="progress"><span style="width:${clamp(pct,0,100)}%"></span></div><div class="card-actions"><button class="mini" data-read="${b.id}">📖 Baca</button><button class="mini ${pr.favourite?'fav':''}" data-fav="${b.id}">${pr.favourite?'♥':'♡'}</button>${parent?`<button class="mini" data-edit="${b.id}">✏️</button><button class="mini" data-share="${b.id}">📤</button><button class="mini" data-delete="${b.id}">🗑️</button>`:''}</div></div></article>`;
  }).join('');
  return shell(`<section class="hero"><div><span class="eyebrow">100% LOCAL • OFFLINE-FIRST</span><h1>${state.currentProfile?.role==='parent'?'Rak buku keluarga dalam poket.':'Jom pilih buku dan baca.'}</h1><p>${state.currentProfile?.role==='parent'?'Scan buku, auto-crop, split dua muka surat, kemudian share fail .rakku ke device anak.':'Progress bacaan kamu disimpan dalam profil sendiri.'}</p></div><div class="hero-emoji">${state.currentProfile?.role==='parent'?'📕':'🌟'}</div></section><section class="toolbar"><div><h2>Rak Buku</h2><small>${state.books.length} buku · ${escapeHtml(state.settings.familyName||'RakKu')}</small></div><div class="searchrow"><input id="searchBooks" value="${escapeAttr(state.search)}" placeholder="Cari buku, kategori…" aria-label="Cari buku">${parent?'<button class="ghost" id="importPdfHomeBtn">📄 PDF</button><button class="ghost" id="importBookBtn">📥 .rakku</button>':''}</div></section><section class="books">${cards||`<div class="empty"><div class="big">📚</div><h3>${q?'Tiada buku ditemui':'Rak masih kosong'}</h3><p>${parent?'Tekan “＋ Buku” untuk scan buku pertama.':'Minta Parent masukkan buku dahulu.'}</p></div>`}</section><input class="hidden" id="importBookInput" type="file" accept=".rakku,application/octet-stream"><input class="hidden" id="importPdfHomeInput" type="file" accept="application/pdf,.pdf">`);
}

function editorView(){
  const b=state.editingBook||{};
  const thumbs=state.editPages.map((p,i)=>`<div class="page-thumb"><img src="${p.url}" alt="Muka surat ${i+1}"><span class="page-number">${i+1}</span>${p.autoSplit?'<span class="page-badge">AUTO SPLIT</span>':p.fromPdf?'<span class="page-badge">PDF</span>':''}<div class="thumb-actions"><button data-up="${i}" ${i===0?'disabled':''} title="Naik">↑</button><button data-down="${i}" ${i===state.editPages.length-1?'disabled':''} title="Turun">↓</button><button data-split="${i}" title="Split dua page">↔</button><button data-rm="${i}" title="Padam">✕</button></div></div>`).join('');
  return shell(`<section class="editor"><div class="editor-head"><div><h2>${b.id?'Edit Buku':'Buku Baru'}</h2><p>Camera/Gallery → auto crop + HD clean, atau PDF → terus jadi muka surat RakKu.</p></div><span class="mini">v${APP_VERSION}</span></div><div class="form-grid"><div class="field"><label>Nama buku</label><input id="bookTitle" value="${escapeAttr(b.title||'')}" placeholder="Contoh: Sang Kancil dan Buaya"></div><div class="field"><label>Penulis (optional)</label><input id="bookAuthor" value="${escapeAttr(b.author||'')}" placeholder="Penulis"></div><div class="field"><label>Kategori</label><select id="bookCategory"><option value="Cerita">Cerita</option><option value="Bahasa Melayu">Bahasa Melayu</option><option value="English">English</option><option value="Matematik">Matematik</option><option value="Sains">Sains</option><option value="Agama">Agama</option><option value="Lain-lain">Lain-lain</option></select></div></div><section class="capture-panel"><div class="capture-top"><div class="cam">📷</div><div><h3>Scanner Buku</h3><p>Ambil dengan kamera, pilih gambar dari Gallery, atau import terus buku PDF.</p></div><div class="capture-actions"><label class="primary file-btn">📷 Kamera<input id="cameraInput" type="file" accept="image/*" capture="environment"></label><label class="ghost file-btn">🖼️ Gallery<input id="galleryInput" type="file" accept="image/*" multiple></label><label class="ghost file-btn">📄 Import PDF<input id="pdfInput" type="file" accept="application/pdf,.pdf"></label></div></div><div class="scanner-options"><label class="check"><input id="autoCrop" type="checkbox" ${state.settings.autoCrop!==false?'checked':''}> Auto crop + straighten</label><label class="check"><input id="autoSplit" type="checkbox" ${state.settings.autoSplit!==false?'checked':''}> Auto double-page split</label><label class="check">HD <select id="scanQuality"><option value="1600">Compact</option><option value="2000">HD</option><option value="2600">HD+</option></select></label></div><div class="scan-status">Tip: untuk double-page, buka buku rata dan ambil gambar landscape dengan garisan tengah buku jelas.</div></section><div class="thumbbar"><strong>${state.editPages.length} muka surat</strong><small>↑ ↓ susun · ↔ split manual · ✕ buang</small></div><div class="thumbs">${thumbs||'<div class="empty"><div class="big">📷</div><h3>Belum ada page</h3><p>Mulakan scan dari cover atau muka surat pertama.</p></div>'}</div><div class="savebar"><button class="ghost" id="cancelEdit">Batal</button><button class="primary" id="saveBook">Simpan Buku</button></div></section>`);
}

function readerView(){
  const b=state.readerBook, pages=state.readerPages, i=clamp(state.readerIndex,0,Math.max(0,pages.length-1));
  const pr=state.progress.get(b.id)||{}; const spread=state.readerSpread && pages.length>1;
  const imgs=[]; if(pages[i]) imgs.push(`<img src="${objectUrl(`reader:${b.id}:${pages[i].id}`,pages[i].blob)}" alt="Muka surat ${i+1}">`); if(spread&&pages[i+1]) imgs.push(`<img src="${objectUrl(`reader:${b.id}:${pages[i+1].id}`,pages[i+1].blob)}" alt="Muka surat ${i+2}">`);
  return shell(`<section class="reader"><div class="reader-head"><div><h2>${escapeHtml(b.title)} ${pr.completed?'<span class="done-badge">Selesai ✓</span>':''}</h2><p>Muka surat ${pages.length?i+1:0}${spread&&pages[i+1]?`–${i+2}`:''} / ${pages.length}</p></div><div class="reader-actions"><button class="mini ${pr.favourite?'fav':''}" id="readerFav">${pr.favourite?'♥ Favourite':'♡ Favourite'}</button><button class="mini" id="spreadBtn">${spread?'▯ Satu Page':'▯▯ Buku'}</button>${state.currentProfile?.role==='parent'?'<button class="mini" id="pdfBtn">📄 PDF</button><button class="mini" id="shareReaderBtn">📤 .rakku</button>':''}</div></div><div class="page-stage ${spread?'spread':''}" id="pageStage">${imgs.join('')||'<div class="empty">Tiada muka surat</div>'}</div><div class="reader-controls"><button class="ghost" id="prevPage" ${i<=0?'disabled':''}>← Sebelum</button><input id="pageSlider" type="range" min="1" max="${Math.max(1,pages.length)}" value="${pages.length?i+1:1}" aria-label="Muka surat"><button class="ghost" id="nextPage" ${i>=pages.length-1?'disabled':''}>Seterusnya →</button></div><div class="reader-tip">Swipe kiri/kanan pada page. RakKu simpan page terakhir ikut profil ${escapeHtml(state.currentProfile?.name||'')}.</div></section>`);
}

async function storageInfo(){
  if(!navigator.storage?.estimate) return {usage:0,quota:0,pct:0,label:'Storage info tidak tersedia'};
  const e=await navigator.storage.estimate(); const usage=e.usage||0, quota=e.quota||0, pct=quota?usage/quota*100:0;
  const mb=n=>(n/1024/1024).toFixed(n>1024*1024*1024?0:1);
  return {usage,quota,pct,label:`${mb(usage)} MB digunakan${quota?` / ${mb(quota)} MB quota browser`:''}`};
}
function settingsView(){
  const rows=state.profiles.map(p=>`<div class="profile-row"><div class="left"><span class="av">${escapeHtml(p.avatar)}</span><div><strong>${escapeHtml(p.name)}</strong><small>${p.role==='parent'?'Parent':'Child'}</small></div></div>${p.role==='child'?`<button class="mini" data-rmprofile="${p.id}">Padam</button>`:''}</div>`).join('');
  return shell(`<section class="settings-grid"><div class="panel"><h3>👨‍👩‍👧‍👦 Family Profiles</h3><p>Parent boleh urus buku. Kids Mode hanya membaca dan simpan progress sendiri.</p><div class="profile-manage">${rows}</div><div class="stack" style="margin-top:12px"><button class="primary" id="addChild">＋ Profil Anak</button><button class="ghost" id="changePin">🔐 Tukar PIN</button></div></div><div class="panel"><h3>📷 Scanner Default</h3><p>Setting ini digunakan setiap kali buat buku baru.</p><label class="check"><input id="setAutoCrop" type="checkbox" ${state.settings.autoCrop!==false?'checked':''}> Auto crop + straighten</label><label class="check" style="margin-top:7px"><input id="setAutoSplit" type="checkbox" ${state.settings.autoSplit!==false?'checked':''}> Auto double-page split</label><div class="field" style="margin-top:9px"><label>HD output</label><select id="setQuality"><option value="1600">Compact 1600px</option><option value="2000">HD 2000px</option><option value="2600">HD+ 2600px</option></select></div></div><div class="panel"><h3>📦 Pindah & Backup</h3><p>.rakku ialah format portable RakKu; boleh dipindah melalui Files/Drive/WhatsApp Document/AirDrop/Quick Share.</p><div class="stack"><button class="primary" id="backupLibrary">💾 Backup Library</button><label class="ghost file-btn">♻️ Restore<input id="restoreInput" type="file" accept=".rakku,application/octet-stream"></label>${deferredInstallPrompt?'<button class="ghost" id="installPwa">📲 Install App</button>':''}</div><div class="notice" style="margin-top:12px">Backup Library termasuk buku, profiles, progress dan Parent PIN supaya device baru boleh restore keadaan yang sama.</div></div><div class="panel"><h3>💾 Device Storage</h3><p id="storageLabel">Mengira storage…</p><div class="storage-meter"><span id="storageBar" style="width:0%"></span></div><button class="ghost" id="refreshStorage">Refresh</button></div><div class="panel danger-zone"><h3>🧹 Data</h3><p>RakKu tidak menggunakan cloud. Clear site/browser data akan memadam library local jika tiada backup.</p><button class="danger" id="wipeAll">Padam Semua Data RakKu</button></div><div class="panel"><h3>ℹ️ RakKu v${APP_VERSION}</h3><p>Local-first PWA. Scanner dan PDF import diproses dalam device tanpa upload buku ke server.</p><div class="notice">Kalau lighting kamera susah, guna Import PDF atau Gallery. PDF.js dipin ke versi tetap dan dicache oleh PWA selepas app v2.1 dibuka online sekali.</div></div></section>`);
}

function render(){
  let html='';
  if(state.view==='setup') html=setupView();
  else if(state.view==='profiles') html=profilesView();
  else if(state.view==='library') html=libraryView();
  else if(state.view==='editor') html=editorView();
  else if(state.view==='reader') html=readerView();
  else if(state.view==='settings') html=settingsView();
  else html='<main class="app"><div class="boot">📚 Membuka RakKu…</div></main>';
  $('#app').innerHTML=html; wire();
}

function wire(){
  $('#finishSetup')?.addEventListener('click', finishSetup);
  $$('[data-profile]').forEach(el=>el.addEventListener('click',()=>selectProfile(el.dataset.profile)));
  $('#modalCancel')?.addEventListener('click',closeModal); $('#pinSubmit')?.addEventListener('click',submitPin); $('#pinInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')submitPin();});
  $('#childSave')?.addEventListener('click',saveChild); $('#pinChangeSave')?.addEventListener('click',saveNewPin);
  $('#switchProfile')?.addEventListener('click',()=>{state.currentProfile=null;state.view='profiles';state.progress.clear();render();});
  $('#addBook')?.addEventListener('click',()=>startEditor()); $('#settingsBtn')?.addEventListener('click',()=>{state.view='settings';render(); updateStorageUI();});
  $('#backBtn')?.addEventListener('click',()=>{ if(state.view==='reader') revokePrefix(`reader:`); state.view='library'; render(); });
  $('#searchBooks')?.addEventListener('input',e=>{state.search=e.target.value; const pos=e.target.selectionStart; render(); const inp=$('#searchBooks'); if(inp){inp.focus();inp.setSelectionRange(pos,pos);}});
  $$('[data-read]').forEach(el=>el.addEventListener('click',()=>openReader(el.dataset.read)));
  $$('[data-edit]').forEach(el=>el.addEventListener('click',()=>startEditor(el.dataset.edit)));
  $$('[data-share]').forEach(el=>el.addEventListener('click',()=>exportBook(el.dataset.share,true)));
  $$('[data-delete]').forEach(el=>el.addEventListener('click',()=>confirmDeleteBook(el.dataset.delete)));
  $$('[data-fav]').forEach(el=>el.addEventListener('click',async()=>{const id=el.dataset.fav;const p=state.progress.get(id)||{};await saveProgress(id,{favourite:!p.favourite});render();}));
  $('#importBookBtn')?.addEventListener('click',()=>$('#importBookInput').click()); $('#importBookInput')?.addEventListener('change',e=>importRakkuFile(e.target.files?.[0]));
  $('#importPdfHomeBtn')?.addEventListener('click',()=>$('#importPdfHomeInput').click()); $('#importPdfHomeInput')?.addEventListener('change',e=>importPdfAsBook(e.target.files?.[0],true));
  $('#cameraInput')?.addEventListener('change',handleScanFiles); $('#galleryInput')?.addEventListener('change',handleScanFiles); $('#pdfInput')?.addEventListener('change',e=>importPdfAsBook(e.target.files?.[0],false));
  $('#cancelEdit')?.addEventListener('click',()=>{cleanupEditorUrls();state.view='library';render();}); $('#saveBook')?.addEventListener('click',saveEditor);
  $$('[data-rm]').forEach(el=>el.addEventListener('click',()=>removeEditPage(+el.dataset.rm))); $$('[data-up]').forEach(el=>el.addEventListener('click',()=>movePage(+el.dataset.up,-1))); $$('[data-down]').forEach(el=>el.addEventListener('click',()=>movePage(+el.dataset.down,1))); $$('[data-split]').forEach(el=>el.addEventListener('click',()=>manualSplit(+el.dataset.split)));
  $('#bookTitle')?.addEventListener('input',e=>{ if(state.editingBook) state.editingBook.title=e.target.value; });
  $('#bookAuthor')?.addEventListener('input',e=>{ if(state.editingBook) state.editingBook.author=e.target.value; });
  $('#bookCategory')?.addEventListener('change',e=>{ if(state.editingBook) state.editingBook.category=e.target.value; });
  if($('#bookCategory') && state.editingBook?.category) $('#bookCategory').value=state.editingBook.category;
  if($('#scanQuality')) $('#scanQuality').value=String(state.settings.scanQuality||2000);
  $('#autoCrop')?.addEventListener('change',e=>setSetting('autoCrop',e.target.checked)); $('#autoSplit')?.addEventListener('change',e=>setSetting('autoSplit',e.target.checked)); $('#scanQuality')?.addEventListener('change',e=>setSetting('scanQuality',+e.target.value));
  $('#prevPage')?.addEventListener('click',()=>goPage(state.readerIndex-(state.readerSpread?2:1))); $('#nextPage')?.addEventListener('click',()=>goPage(state.readerIndex+(state.readerSpread?2:1))); $('#pageSlider')?.addEventListener('input',e=>goPage(+e.target.value-1));
  $('#spreadBtn')?.addEventListener('click',()=>{state.readerSpread=!state.readerSpread;render();}); $('#readerFav')?.addEventListener('click',async()=>{const p=state.progress.get(state.readerBook.id)||{};await saveProgress(state.readerBook.id,{favourite:!p.favourite});render();});
  $('#pdfBtn')?.addEventListener('click',exportPdf); $('#shareReaderBtn')?.addEventListener('click',()=>exportBook(state.readerBook.id,true));
  const stage=$('#pageStage'); if(stage){let sx=0;stage.addEventListener('pointerdown',e=>{sx=e.clientX;});stage.addEventListener('pointerup',e=>{const dx=e.clientX-sx;if(Math.abs(dx)>45)goPage(state.readerIndex+(dx<0?(state.readerSpread?2:1):-(state.readerSpread?2:1)));});}
  $('#addChild')?.addEventListener('click',()=>modal({type:'child'})); $('#changePin')?.addEventListener('click',()=>modal({type:'pinChange'})); $$('[data-rmprofile]').forEach(el=>el.addEventListener('click',()=>removeProfile(el.dataset.rmprofile)));
  $('#setAutoCrop')?.addEventListener('change',e=>setSetting('autoCrop',e.target.checked)); $('#setAutoSplit')?.addEventListener('change',e=>setSetting('autoSplit',e.target.checked)); if($('#setQuality')) $('#setQuality').value=String(state.settings.scanQuality||2000); $('#setQuality')?.addEventListener('change',e=>setSetting('scanQuality',+e.target.value));
  $('#backupLibrary')?.addEventListener('click',backupLibrary); $('#restoreInput')?.addEventListener('change',e=>restoreLibrary(e.target.files?.[0])); $('#refreshStorage')?.addEventListener('click',updateStorageUI); $('#wipeAll')?.addEventListener('click',wipeAllData); $('#installPwa')?.addEventListener('click',installPwa);
}

async function finishSetup(){
  const family=$('#familyName').value.trim()||'Rak Keluarga', parent=$('#parentName').value.trim()||'Parent', pin=$('#setupPin').value.trim(), avatar=$('#parentAvatar').value;
  if(!/^\d{4,6}$/.test(pin)){showToast('PIN mesti 4–6 digit');return;}
  setBusy('Menyediakan RakKu…');
  const ph=await hashPin(pin), id=uid(); await setSetting('familyName',family); await setSetting('parentPinHash',ph); await setSetting('autoCrop',true); await setSetting('autoSplit',true); await setSetting('scanQuality',2000); await put('profiles',{id,name:parent,avatar,role:'parent',createdAt:now()});
  await loadCore(); state.currentProfile=state.profiles.find(x=>x.id===id)||state.profiles[0]; await loadProgress(state.currentProfile.id); state.view='library'; state.busy=''; render();
}
async function selectProfile(id){
  const p=state.profiles.find(x=>x.id===id); if(!p)return;
  if(p.role==='parent'){ state.modal={type:'pin',profileId:id}; render(); setTimeout(()=>$('#pinInput')?.focus(),20); }
  else { state.currentProfile=p; await loadProgress(p.id); state.view='library'; render(); }
}
async function submitPin(){
  const pin=$('#pinInput')?.value||''; const h=await hashPin(pin); if(h!==state.settings.parentPinHash){const e=$('#pinError');if(e)e.textContent='PIN tidak betul.';return;}
  const id=state.modal.profileId; state.modal=null; state.currentProfile=state.profiles.find(x=>x.id===id); await loadProgress(id); state.view='library'; render();
}
async function saveChild(){ const name=$('#childName').value.trim(); if(!name){showToast('Masukkan nama anak');return;} await put('profiles',{id:uid(),name,avatar:$('#childAvatar').value,role:'child',createdAt:now()}); await loadCore(); closeModal(); showToast('Profil anak ditambah'); }
async function removeProfile(id){ if(!confirm('Padam profil anak ini? Progress bacaan profil ini juga akan dipadam.'))return; const t=db.transaction(['profiles','progress'],'readwrite');t.objectStore('profiles').delete(id);const idx=t.objectStore('progress').index('profileId');idx.openCursor(IDBKeyRange.only(id)).onsuccess=e=>{const c=e.target.result;if(c){c.delete();c.continue();}}; await new Promise((r,j)=>{t.oncomplete=r;t.onerror=()=>j(t.error)}); await loadCore(); render(); }
async function saveNewPin(){ const pin=$('#newPin').value.trim(); if(!/^\d{4,6}$/.test(pin)){showToast('PIN mesti 4–6 digit');return;} await setSetting('parentPinHash',await hashPin(pin));closeModal();showToast('Parent PIN ditukar'); }

async function startEditor(bookId=null){
  cleanupEditorUrls(); state.editPages=[];
  if(bookId){ const b=state.books.find(x=>x.id===bookId); state.editingBook={...b}; const ps=await getPages(bookId); state.editPages=ps.map(p=>({...p,url:URL.createObjectURL(p.blob),existing:true})); }
  else state.editingBook={id:null,title:'',author:'',category:'Cerita'};
  state.view='editor'; render();
}
function cleanupEditorUrls(){ for(const p of state.editPages) if(p.url?.startsWith('blob:')) URL.revokeObjectURL(p.url); }
function movePage(i,d){const j=i+d;if(j<0||j>=state.editPages.length)return;[state.editPages[i],state.editPages[j]]=[state.editPages[j],state.editPages[i]];render();}
function removeEditPage(i){const [p]=state.editPages.splice(i,1);if(p?.url?.startsWith('blob:'))URL.revokeObjectURL(p.url);render();}

async function handleScanFiles(e){
  const files=[...(e.target.files||[])]; if(!files.length)return;
  const autoCrop=$('#autoCrop')?.checked!==false, autoSplit=$('#autoSplit')?.checked!==false, quality=+($('#scanQuality')?.value||state.settings.scanQuality||2000);
  await setSetting('autoCrop',autoCrop); await setSetting('autoSplit',autoSplit); await setSetting('scanQuality',quality);
  for(let n=0;n<files.length;n++){
    setBusy(`Memproses scan ${n+1}/${files.length}…`);
    try{
      const results=await processScan(files[n],{autoCrop,autoSplit,quality});
      for(const r of results) state.editPages.push({id:uid(),blob:r.blob,width:r.width,height:r.height,url:URL.createObjectURL(r.blob),existing:false,autoSplit:r.autoSplit||false});
    }catch(err){console.error(err);showToast(`Gagal proses ${files[n].name||'gambar'}`);}
    await sleep(20);
  }
  state.busy=''; render(); e.target.value='';
}


function pdfTitleFromFilename(name='Buku PDF'){
  return String(name).replace(/\.pdf$/i,'').replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim() || 'Buku PDF';
}
function updateBusyText(msg){
  state.busy=msg;
  const el=$('.busy-card strong');
  if(el) el.textContent=msg;
}
async function importPdfAsBook(file,fromLibrary=false){
  if(!file)return;
  if(file.type && file.type!=='application/pdf' && !/\.pdf$/i.test(file.name||'')){showToast('Pilih fail PDF');return;}
  if(typeof window.pdfjsLib==='undefined'){
    alert('PDF engine belum tersedia. Pastikan RakKu dibuka sekurang-kurangnya sekali dengan internet selepas update v2.1, kemudian ia boleh digunakan offline.');
    return;
  }
  const previousView=state.view;
  try{
    if(fromLibrary){
      cleanupEditorUrls();
      state.editPages=[];
      state.editingBook={id:null,title:pdfTitleFromFilename(file.name),author:'',category:'Cerita'};
      state.view='editor';
      render();
    }else if(state.editingBook && !String(state.editingBook.title||'').trim()){
      state.editingBook.title=pdfTitleFromFilename(file.name);
      const t=$('#bookTitle'); if(t)t.value=state.editingBook.title;
    }
    setBusy('Membuka PDF…');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc=PDFJS_WORKER_URL;
    const data=new Uint8Array(await file.arrayBuffer());
    const loadingTask=window.pdfjsLib.getDocument({data});
    const pdf=await loadingTask.promise;
    const total=pdf.numPages||0;
    if(!total) throw new Error('PDF tidak mempunyai muka surat');
    if(total>300 && !confirm(`PDF ini mempunyai ${total} muka surat dan mungkin menggunakan storage yang banyak. Teruskan import?`)){
      state.busy=''; render(); return;
    }
    const quality=Number(state.settings.scanQuality||2000);
    for(let pageNo=1;pageNo<=total;pageNo++){
      updateBusyText(`Import PDF ${pageNo}/${total}…`);
      const page=await pdf.getPage(pageNo);
      const base=page.getViewport({scale:1});
      const long=Math.max(base.width,base.height)||1;
      const scale=clamp(quality/long,0.5,4);
      const viewport=page.getViewport({scale});
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(viewport.width));
      canvas.height=Math.max(1,Math.round(viewport.height));
      const ctx=canvas.getContext('2d',{alpha:false});
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      await page.render({canvasContext:ctx,viewport,background:'rgb(255,255,255)'}).promise;
      const out=await canvasToJpeg(canvas,quality);
      state.editPages.push({id:uid(),blob:out.blob,width:out.width,height:out.height,url:URL.createObjectURL(out.blob),existing:false,fromPdf:true});
      page.cleanup?.();
      canvas.width=1; canvas.height=1;
      if(pageNo%3===0) await sleep(0);
    }
    await pdf.destroy?.();
    state.busy=''; render();
    showToast(`${total} muka surat PDF siap diimport`);
  }catch(err){
    console.error(err);
    state.busy=''; render();
    alert(`Import PDF gagal: ${err.message||err}`);
    if(fromLibrary && !state.editPages.length){state.view=previousView==='library'?'library':'editor';render();}
  }finally{
    const a=$('#pdfInput');if(a)a.value='';
    const b=$('#importPdfHomeInput');if(b)b.value='';
  }
}

async function bitmapFromBlob(blob){ try{return await createImageBitmap(blob,{imageOrientation:'from-image'});}catch{return createImageBitmap(blob);} }
function canvasFromBitmap(bmp,maxLong=2000){ const scale=Math.min(1,maxLong/Math.max(bmp.width,bmp.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(bmp.width*scale));c.height=Math.max(1,Math.round(bmp.height*scale));c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);return c; }
function grayscaleData(canvas,maxLong=700){ const scale=Math.min(1,maxLong/Math.max(canvas.width,canvas.height)), w=Math.max(40,Math.round(canvas.width*scale)),h=Math.max(40,Math.round(canvas.height*scale));const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(canvas,0,0,w,h);const d=x.getImageData(0,0,w,h).data,g=new Uint8Array(w*h);for(let i=0,j=0;i<d.length;i+=4,j++)g[j]=(d[i]*77+d[i+1]*150+d[i+2]*29)>>8;return {g,w,h,scale}; }
function smooth(arr,r=3){const out=new Float32Array(arr.length);for(let i=0;i<arr.length;i++){let s=0,n=0;for(let k=Math.max(0,i-r);k<=Math.min(arr.length-1,i+r);k++){s+=arr[k];n++;}out[i]=s/n;}return out;}
function median(arr){const a=[...arr].sort((x,y)=>x-y);return a[Math.floor(a.length/2)]||0;}
function peakIn(a,start,end){let bi=start,bv=-1;for(let i=start;i<=end;i++){if(a[i]>bv){bv=a[i];bi=i;}}return {i:bi,v:bv};}
function linearFit(points,swap=false){if(points.length<2)return {a:0,b:0};let sx=0,sy=0,sxx=0,sxy=0,n=0;for(const p of points){const x=swap?p[1]:p[0],y=swap?p[0]:p[1];sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;n++;}const den=n*sxx-sx*sx;if(Math.abs(den)<1e-6)return {a:0,b:sy/n};const a=(n*sxy-sx*sy)/den,b=(sy-a*sx)/n;return {a,b};}
function intersectXofYWithYofX(xLine,yLine){const den=1-xLine.a*yLine.a;if(Math.abs(den)<1e-5)return null;const x=(xLine.a*yLine.b+xLine.b)/den;const y=yLine.a*x+yLine.b;return {x,y};}
function estimateDocumentQuad(canvas){
  const {g,w,h,scale}=grayscaleData(canvas,720); const col=new Float32Array(w),row=new Float32Array(h);
  for(let y=1;y<h-1;y+=2){for(let x=1;x<w-1;x++){col[x]+=Math.abs(g[y*w+x+1]-g[y*w+x-1]);}}
  for(let x=1;x<w-1;x+=2){for(let y=1;y<h-1;y++){row[y]+=Math.abs(g[(y+1)*w+x]-g[(y-1)*w+x]);}}
  const cs=smooth(col,4),rs=smooth(row,4); const lp=peakIn(cs,Math.floor(w*.02),Math.floor(w*.38)),rp=peakIn(cs,Math.floor(w*.62),Math.floor(w*.98)),tp=peakIn(rs,Math.floor(h*.02),Math.floor(h*.38)),bp=peakIn(rs,Math.floor(h*.62),Math.floor(h*.98));
  const baseC=median(cs),baseR=median(rs); const confident=rp.i-lp.i>w*.48 && bp.i-tp.i>h*.48 && (lp.v+rp.v)>baseC*2.15 && (tp.v+bp.v)>baseR*2.15;
  if(!confident) return {confidence:0,quad:[{x:0,y:0},{x:canvas.width,y:0},{x:canvas.width,y:canvas.height},{x:0,y:canvas.height}]};
  const lpts=[],rpts=[],tpts=[],bpts=[]; const xr=Math.max(5,Math.round(w*.07)),yr=Math.max(5,Math.round(h*.07));
  for(let y=tp.i;y<=bp.i;y+=Math.max(4,Math.floor(h/70))){let bl=lp.i,bv=-1;for(let x=Math.max(2,lp.i-xr);x<=Math.min(w-3,lp.i+xr);x++){const v=Math.abs(g[y*w+x+2]-g[y*w+x-2]);if(v>bv){bv=v;bl=x;}}lpts.push([y,bl]);let br=rp.i;bv=-1;for(let x=Math.max(2,rp.i-xr);x<=Math.min(w-3,rp.i+xr);x++){const v=Math.abs(g[y*w+x+2]-g[y*w+x-2]);if(v>bv){bv=v;br=x;}}rpts.push([y,br]);}
  for(let x=lp.i;x<=rp.i;x+=Math.max(4,Math.floor(w/70))){let bt=tp.i,bv=-1;for(let y=Math.max(2,tp.i-yr);y<=Math.min(h-3,tp.i+yr);y++){const v=Math.abs(g[(y+2)*w+x]-g[(y-2)*w+x]);if(v>bv){bv=v;bt=y;}}tpts.push([x,bt]);let bb=bp.i;bv=-1;for(let y=Math.max(2,bp.i-yr);y<=Math.min(h-3,bp.i+yr);y++){const v=Math.abs(g[(y+2)*w+x]-g[(y-2)*w+x]);if(v>bv){bv=v;bb=y;}}bpts.push([x,bb]);}
  const left=linearFit(lpts),right=linearFit(rpts),top=linearFit(tpts),bottom=linearFit(bpts); let tl=intersectXofYWithYofX(left,top),tr=intersectXofYWithYofX(right,top),br=intersectXofYWithYofX(right,bottom),bl=intersectXofYWithYofX(left,bottom);
  if(!tl||!tr||!br||!bl) return {confidence:0,quad:[]}; const pts=[tl,tr,br,bl].map(p=>({x:clamp(p.x/scale,0,canvas.width-1),y:clamp(p.y/scale,0,canvas.height-1)}));
  const topW=Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y),botW=Math.hypot(pts[2].x-pts[3].x,pts[2].y-pts[3].y),leftH=Math.hypot(pts[3].x-pts[0].x,pts[3].y-pts[0].y),rightH=Math.hypot(pts[2].x-pts[1].x,pts[2].y-pts[1].y); if(Math.min(topW,botW)<canvas.width*.42||Math.min(leftH,rightH)<canvas.height*.42)return {confidence:0,quad:[]};
  return {confidence:1,quad:pts};
}
function warpQuad(canvas,quad,maxLong=1900){
  if(!quad?.length)return canvas; const [tl,tr,br,bl]=quad; const outW=Math.round((Math.hypot(tr.x-tl.x,tr.y-tl.y)+Math.hypot(br.x-bl.x,br.y-bl.y))/2),outH=Math.round((Math.hypot(bl.x-tl.x,bl.y-tl.y)+Math.hypot(br.x-tr.x,br.y-tr.y))/2); const scale=Math.min(1,maxLong/Math.max(outW,outH)),W=Math.max(40,Math.round(outW*scale)),H=Math.max(40,Math.round(outH*scale));
  const src=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height), dst=new ImageData(W,H),sd=src.data,dd=dst.data,sw=canvas.width,sh=canvas.height;
  for(let y=0;y<H;y++){const v=H===1?0:y/(H-1),lx=tl.x+(bl.x-tl.x)*v,ly=tl.y+(bl.y-tl.y)*v,rx=tr.x+(br.x-tr.x)*v,ry=tr.y+(br.y-tr.y)*v;for(let x=0;x<W;x++){const u=W===1?0:x/(W-1),sx=clamp(Math.round(lx+(rx-lx)*u),0,sw-1),sy=clamp(Math.round(ly+(ry-ly)*u),0,sh-1),si=(sy*sw+sx)*4,di=(y*W+x)*4;dd[di]=sd[si];dd[di+1]=sd[si+1];dd[di+2]=sd[si+2];dd[di+3]=255;}}
  const out=document.createElement('canvas');out.width=W;out.height=H;out.getContext('2d').putImageData(dst,0,0);return out;
}
function enhanceCanvas(canvas){
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),im=ctx.getImageData(0,0,canvas.width,canvas.height),d=im.data,hist=new Uint32Array(256); let count=0;
  for(let i=0;i<d.length;i+=16){const l=(d[i]*77+d[i+1]*150+d[i+2]*29)>>8;hist[l]++;count++;}
  let cum=0,lo=0,hi=255;for(let i=0;i<256;i++){cum+=hist[i];if(cum>=count*.015){lo=i;break;}}cum=0;for(let i=255;i>=0;i--){cum+=hist[i];if(cum>=count*.015){hi=i;break;}} if(hi-lo<70){lo=0;hi=255;} const span=Math.max(1,hi-lo);
  for(let i=0;i<d.length;i+=4){for(let k=0;k<3;k++){const norm=clamp((d[i+k]-lo)*255/span,0,255),mix=d[i+k]*.68+norm*.32;d[i+k]=clamp((mix-128)*1.025+130,0,255);}}
  ctx.putImageData(im,0,0);return canvas;
}
function findGutter(canvas){
  const {g,w,h}=grayscaleData(canvas,800);let best=Math.round(w/2),bestScore=Infinity;for(let x=Math.floor(w*.42);x<=Math.ceil(w*.58);x++){let edge=0;for(let y=2;y<h-2;y+=2)edge+=Math.abs(g[y*w+x+1]-g[y*w+x-1]);edge/=h;const dist=Math.abs(x-w/2)/(w*.08);const score=edge+dist*2.2;if(score<bestScore){bestScore=score;best=x;}}return best/w;
}
function cropCanvas(canvas,x0,y0,x1,y1){const w=Math.max(1,Math.round(x1-x0)),h=Math.max(1,Math.round(y1-y0)),c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(canvas,x0,y0,w,h,0,0,w,h);return c;}
async function canvasToJpeg(canvas,quality=2000){
  let out=canvas;const scale=Math.min(1,quality/Math.max(canvas.width,canvas.height));if(scale<.999){out=document.createElement('canvas');out.width=Math.round(canvas.width*scale);out.height=Math.round(canvas.height*scale);out.getContext('2d').drawImage(canvas,0,0,out.width,out.height);} const blob=await new Promise((res,rej)=>out.toBlob(b=>b?res(b):rej(new Error('JPEG encode gagal')),'image/jpeg',0.9));return {blob,width:out.width,height:out.height};
}
async function processScan(file,{autoCrop=true,autoSplit=true,quality=2000}={}){
  const bmp=await bitmapFromBlob(file); let canvas=canvasFromBitmap(bmp,1900); if(bmp.close)bmp.close();
  if(autoCrop){const det=estimateDocumentQuad(canvas);if(det.confidence)canvas=warpQuad(canvas,det.quad,1900);}
  const ratio=canvas.width/canvas.height; const shouldSplit=autoSplit && ratio>=1.45 && ratio<=2.35;
  if(shouldSplit){const f=findGutter(canvas),gap=Math.round(canvas.width*.006),sx=Math.round(canvas.width*f),left=cropCanvas(canvas,0,0,Math.max(1,sx-gap),canvas.height),right=cropCanvas(canvas,Math.min(canvas.width-1,sx+gap),0,canvas.width,canvas.height);enhanceCanvas(left);enhanceCanvas(right);const a=await canvasToJpeg(left,quality),b=await canvasToJpeg(right,quality);return [{...a,autoSplit:true},{...b,autoSplit:true}];}
  enhanceCanvas(canvas); return [await canvasToJpeg(canvas,quality)];
}
async function manualSplit(i){
  const p=state.editPages[i];if(!p)return;setBusy('Split dua muka surat…');try{const bmp=await bitmapFromBlob(p.blob),c=canvasFromBitmap(bmp,2200);if(bmp.close)bmp.close();const f=findGutter(c),gap=Math.round(c.width*.006),sx=Math.round(c.width*f),left=cropCanvas(c,0,0,Math.max(1,sx-gap),c.height),right=cropCanvas(c,Math.min(c.width-1,sx+gap),0,c.width,c.height),quality=state.settings.scanQuality||2000;const a=await canvasToJpeg(left,quality),b=await canvasToJpeg(right,quality);if(p.url?.startsWith('blob:'))URL.revokeObjectURL(p.url);state.editPages.splice(i,1,{id:uid(),...a,url:URL.createObjectURL(a.blob),existing:false,autoSplit:true},{id:uid(),...b,url:URL.createObjectURL(b.blob),existing:false,autoSplit:true});}catch(err){console.error(err);showToast('Split gagal');}state.busy='';render();
}
async function makeThumbnail(blob){const bmp=await bitmapFromBlob(blob),scale=Math.min(1,480/Math.max(bmp.width,bmp.height)),c=document.createElement('canvas');c.width=Math.round(bmp.width*scale);c.height=Math.round(bmp.height*scale);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);if(bmp.close)bmp.close();return new Promise((r,j)=>c.toBlob(b=>b?r(b):j(new Error('thumbnail')),'image/jpeg',.76));}
async function saveEditor(){
  const title=$('#bookTitle').value.trim(); if(!title){showToast('Masukkan nama buku');return;} if(!state.editPages.length){showToast('Tambah sekurang-kurangnya satu muka surat');return;}
  setBusy('Menyimpan buku…'); const id=state.editingBook?.id||uid(), oldPages=state.editingBook?.id?await getPages(id):[]; const oldIds=new Set(oldPages.map(p=>p.id)), keep=new Set();
  for(let i=0;i<state.editPages.length;i++){const p=state.editPages[i],pid=p.id||uid();keep.add(pid);await put('pages',{id:pid,bookId:id,order:i,blob:p.blob,width:p.width||0,height:p.height||0});}
  for(const p of oldPages) if(!keep.has(p.id)) await del('pages',p.id);
  const coverBlob=await makeThumbnail(state.editPages[0].blob); const book={...(state.editingBook||{}),id,title,author:$('#bookAuthor').value.trim(),category:$('#bookCategory').value,pageCount:state.editPages.length,coverBlob,createdAt:state.editingBook?.createdAt||now(),updatedAt:now()}; delete book.cover; await put('books',book); revokePrefix(`cover:${id}`); await loadCore(); cleanupEditorUrls();state.busy='';state.view='library';render();showToast('Buku disimpan');
}
async function confirmDeleteBook(id){const b=state.books.find(x=>x.id===id);if(b&&confirm(`Padam “${b.title}” daripada device ini?`)){setBusy('Memadam buku…');await deleteBookData(id);state.busy='';render();showToast('Buku dipadam');}}

async function openReader(id){
  const b=state.books.find(x=>x.id===id);if(!b)return;setBusy('Membuka buku…');state.readerBook=b;state.readerPages=await getPages(id);const p=state.progress.get(id);state.readerIndex=clamp(p?.currentPage||0,0,Math.max(0,state.readerPages.length-1));state.readerSpread=window.matchMedia('(min-width: 850px)').matches;state.busy='';state.view='reader';render();
}
async function goPage(index){
  const max=Math.max(0,state.readerPages.length-1);state.readerIndex=clamp(index,0,max);await saveProgress(state.readerBook.id,{currentPage:state.readerIndex,completed:state.readerIndex>=max&&max>=0});render();
}

function u32le(n){const a=new Uint8Array(4);new DataView(a.buffer).setUint32(0,n,true);return a;}
async function packRakku(manifest,blobs){
  const mbytes=textEncoder.encode(JSON.stringify(manifest)); return new Blob([textEncoder.encode(MAGIC),u32le(mbytes.length),mbytes,...blobs],{type:'application/octet-stream'});
}
async function parseRakku(file){
  const head=new Uint8Array(await file.slice(0,12).arrayBuffer()); if(textDecoder.decode(head.slice(0,8))!==MAGIC) throw new Error('Bukan fail RakKu v2'); const len=new DataView(head.buffer).getUint32(8,true); if(len<2||len>20_000_000)throw new Error('Manifest rosak'); const manifest=JSON.parse(await file.slice(12,12+len).text()); let off=12+len; const blobs=[]; for(const f of manifest.files||[]){const size=Number(f.size)||0;blobs.push(file.slice(off,off+size,f.mime||'image/jpeg'));off+=size;} return {manifest,blobs};
}
function fileFromBlob(blob,name){try{return new File([blob],name,{type:blob.type||'application/octet-stream'});}catch{blob.name=name;return blob;}}
async function shareOrDownload(blob,name){
  const file=fileFromBlob(blob,name); if(navigator.share && navigator.canShare?.({files:[file]})){try{await navigator.share({title:name,files:[file]});return;}catch(err){if(err?.name==='AbortError')return;}}
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),2000);showToast('Fail disediakan');
}
async function exportBook(bookId,useShare=false){
  const b=state.books.find(x=>x.id===bookId);if(!b)return;setBusy('Membina fail .rakku…');const pages=await getPages(bookId),files=[],blobs=[];for(const p of pages){files.push({id:p.id,order:p.order,width:p.width||0,height:p.height||0,mime:p.blob.type||'image/jpeg',size:p.blob.size});blobs.push(p.blob);}const clean={id:b.id,title:b.title,author:b.author||'',category:b.category||'',pageCount:pages.length,createdAt:b.createdAt||now(),updatedAt:b.updatedAt||now()};const manifest={format:'RakKu',version:2,appVersion:APP_VERSION,kind:'book',exportedAt:now(),book:clean,files};const blob=await packRakku(manifest,blobs);state.busy='';render();await shareOrDownload(blob,`${slug(b.title)}.rakku`);
}
async function importRakkuFile(file){
  if(!file)return;setBusy('Import fail RakKu…');try{const {manifest,blobs}=await parseRakku(file);if(manifest.kind!=='book')throw new Error('Fail ini ialah backup library. Guna Restore di Settings.');let b={...manifest.book};const exists=state.books.some(x=>x.id===b.id);if(exists){const replace=confirm(`“${b.title}” sudah ada.\n\nOK = ganti buku sedia ada\nCancel = simpan sebagai copy baru`);if(replace)await deleteBookData(b.id);else b={...b,id:uid(),title:`${b.title} (Copy)`,createdAt:now(),updatedAt:now()};}for(let i=0;i<(manifest.files||[]).length;i++){const f=manifest.files[i],id=exists&&b.id===manifest.book.id?f.id:uid();await put('pages',{id,bookId:b.id,order:f.order??i,blob:blobs[i],width:f.width||0,height:f.height||0});}b.pageCount=blobs.length;b.coverBlob=blobs[0]?await makeThumbnail(blobs[0]):null;b.updatedAt=now();await put('books',b);await loadCore();state.busy='';render();showToast('Buku berjaya diimport');}catch(err){console.error(err);state.busy='';render();alert(`Import gagal: ${err.message}`);}finally{const input=$('#importBookInput');if(input)input.value='';}
}
async function backupLibrary(){
  setBusy('Membina backup library…');try{const books=state.books.map(({coverBlob,cover,...b})=>b),profiles=await getAll('profiles'),progress=await getAll('progress'),settings=await getAll('settings'),files=[],blobs=[];for(const b of books){const ps=await getPages(b.id);for(const p of ps){files.push({id:p.id,bookId:b.id,order:p.order,width:p.width||0,height:p.height||0,mime:p.blob.type||'image/jpeg',size:p.blob.size});blobs.push(p.blob);}}const manifest={format:'RakKu',version:2,appVersion:APP_VERSION,kind:'library',exportedAt:now(),books,profiles,progress,settings,files};const blob=await packRakku(manifest,blobs);state.busy='';render();await shareOrDownload(blob,`RakKu_Library_${new Date().toISOString().slice(0,10)}.rakku`);}catch(err){console.error(err);state.busy='';render();alert('Backup gagal: '+err.message);}
}
async function restoreLibrary(file){
  if(!file)return;if(!confirm('Restore akan menggantikan SEMUA data RakKu pada device ini. Pastikan backup semasa sudah dibuat. Teruskan?')){$('#restoreInput').value='';return;}setBusy('Restore library…');try{const {manifest,blobs}=await parseRakku(file);if(manifest.kind!=='library')throw new Error('Ini fail buku tunggal. Guna Import di Rak Buku.');for(const s of ['books','pages','profiles','progress','settings'])await clearStore(s);for(const x of manifest.settings||[])await put('settings',x);for(const x of manifest.profiles||[])await put('profiles',x);for(const x of manifest.progress||[])await put('progress',x);for(let i=0;i<(manifest.files||[]).length;i++){const f=manifest.files[i];await put('pages',{id:f.id||uid(),bookId:f.bookId,order:f.order??i,blob:blobs[i],width:f.width||0,height:f.height||0});}for(const raw of manifest.books||[]){const ps=(manifest.files||[]).map((f,i)=>({f,blob:blobs[i]})).filter(x=>x.f.bookId===raw.id).sort((a,b)=>a.f.order-b.f.order);await put('books',{...raw,pageCount:ps.length,coverBlob:ps[0]?await makeThumbnail(ps[0].blob):null});}urlCache.forEach(u=>URL.revokeObjectURL(u));urlCache.clear();await loadCore();state.currentProfile=null;state.progress.clear();state.busy='';state.view='profiles';render();showToast('Library berjaya direstore');}catch(err){console.error(err);state.busy='';render();alert('Restore gagal: '+err.message);}finally{const x=$('#restoreInput');if(x)x.value='';}
}

async function exportPdf(){
  if(!state.readerBook)return;setBusy('Menjana PDF…');try{const pages=state.readerPages,items=[];for(const p of pages){const bytes=new Uint8Array(await p.blob.arrayBuffer());let w=p.width,h=p.height;if(!w||!h){const bmp=await bitmapFromBlob(p.blob);w=bmp.width;h=bmp.height;if(bmp.close)bmp.close();}items.push({bytes,w,h});}const pdf=buildJpegPdf(items);state.busy='';render();const blob=new Blob([pdf],{type:'application/pdf'});await shareOrDownload(blob,`${slug(state.readerBook.title)}.pdf`);}catch(err){console.error(err);state.busy='';render();alert('PDF gagal dijana: '+err.message);}
}
function buildJpegPdf(pages){
  const chunks=[],offsets=[0];let pos=0;const addText=t=>{const b=textEncoder.encode(t);chunks.push(b);pos+=b.length;},addBytes=b=>{chunks.push(b);pos+=b.length;};addText('%PDF-1.4\n%RakKu\n');const catalog=1,pagesObj=2;let next=3;const refs=pages.map(()=>({page:next++,content:next++,img:next++})),total=next-1;const obj=(n,fn)=>{offsets[n]=pos;addText(`${n} 0 obj\n`);fn();addText('\nendobj\n');};obj(catalog,()=>addText('<< /Type /Catalog /Pages 2 0 R >>'));obj(pagesObj,()=>addText(`<< /Type /Pages /Count ${pages.length} /Kids [${refs.map(r=>`${r.page} 0 R`).join(' ')}] >>`));pages.forEach((p,i)=>{const r=refs[i],portrait=p.h>=p.w,pw=portrait?595.28:841.89,ph=portrait?841.89:595.28,scale=Math.min(pw/p.w,ph/p.h),dw=p.w*scale,dh=p.h*scale,x=(pw-dw)/2,y=(ph-dh)/2,content=`q\n${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im${i+1} Do\nQ\n`;obj(r.page,()=>addText(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i+1} ${r.img} 0 R >> >> /Contents ${r.content} 0 R >>`));obj(r.content,()=>{const b=textEncoder.encode(content);addText(`<< /Length ${b.length} >>\nstream\n`);addBytes(b);addText('endstream');});obj(r.img,()=>{addText(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);addBytes(p.bytes);addText('\nendstream');});});const xref=pos;addText(`xref\n0 ${total+1}\n0000000000 65535 f \n`);for(let i=1;i<=total;i++)addText(`${String(offsets[i]).padStart(10,'0')} 00000 n \n`);addText(`trailer\n<< /Size ${total+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);const len=chunks.reduce((n,c)=>n+c.length,0),out=new Uint8Array(len);let o=0;for(const c of chunks){out.set(c,o);o+=c.length;}return out;
}

async function updateStorageUI(){const info=await storageInfo();const l=$('#storageLabel'),b=$('#storageBar');if(l)l.textContent=info.label;if(b)b.style.width=`${clamp(info.pct,0,100)}%`;}
async function wipeAllData(){if(!confirm('Ini akan PADAM semua buku, profiles dan progress pada device ini. Teruskan?'))return;if(!confirm('Pengesahan terakhir: data local tidak boleh dipulihkan tanpa backup. Padam semua?'))return;setBusy('Memadam semua data…');for(const s of ['books','pages','profiles','progress','settings'])await clearStore(s);urlCache.forEach(u=>URL.revokeObjectURL(u));urlCache.clear();state.currentProfile=null;state.progress.clear();await loadCore();state.busy='';state.view='setup';render();}
async function installPwa(){if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;render();}

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;if(state.view==='settings')render();});
window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;showToast('RakKu berjaya diinstall');});

(async function init(){
  try{
    await openDB(); await loadCore();
    if(!state.settings.parentPinHash || !state.profiles.some(p=>p.role==='parent')) state.view='setup'; else state.view='profiles';
    render();
    if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.error));
    if(navigator.storage?.persist) navigator.storage.persist().catch(()=>{});
  }catch(err){console.error(err);$('#app').innerHTML=`<main class="app"><div class="empty"><div class="big">⚠️</div><h3>RakKu gagal dibuka</h3><p>${escapeHtml(err.message||String(err))}</p></div></main>`;}
})();
