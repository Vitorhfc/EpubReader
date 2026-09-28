(function(){
'use strict';

/* ---------- estado ---------- */
const state = { settings: defaultSettings(), library: [], pageWidth: 0 };
let currentBook = null;
let currentChapterIndex = 0;
let currentPageIndex = 0;
let totalPagesInChapter = 1;
let shadowRoot = null;
let pagerEl = null;
let resizeTimer = null;
let persistTimer = null;
const blobUrlCache = new Map();

function defaultSettings(){
  return { theme:'paper', fontSize:100, fontFamily:'serif' };
}

/* ---------- storage ---------- */
async function loadSettings(){
  try{ const r = await window.storage.get('settings'); return r ? JSON.parse(r.value) : defaultSettings(); }
  catch(e){ return defaultSettings(); }
}
async function saveSettings(s){
  try{ await window.storage.set('settings', JSON.stringify(s)); }
  catch(e){ console.error('Falha ao salvar preferências de aparência', e); }
}
async function loadLibrary(){
  try{ const r = await window.storage.get('library'); return r ? JSON.parse(r.value) : []; }
  catch(e){ return []; }
}
async function saveLibrary(lib){
  try{ await window.storage.set('library', JSON.stringify(lib)); }
  catch(e){ console.error('Falha ao salvar progresso de leitura', e); }
}

/* ---------- utilidades ---------- */
function hashStr(str){
  let h = 5381;
  for (let i=0;i<str.length;i++){ h = ((h<<5)+h) + str.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}
function hueFromStr(str){
  let h = 0;
  for (let i=0;i<str.length;i++){ h = (h*31 + str.charCodeAt(i)) >>> 0; }
  return h % 360;
}
function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function guessMime(path){
  const ext = (path.split('.').pop()||'').toLowerCase();
  const map = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', svg:'image/svg+xml', webp:'image/webp', css:'text/css', otf:'font/otf', ttf:'font/ttf', woff:'font/woff', woff2:'font/woff2' };
  return map[ext] || '';
}
function resolvePath(baseDir, relPath){
  if (!relPath) return relPath;
  if (/^([a-z]+:)?\/\//i.test(relPath) || /^data:/i.test(relPath)) return relPath;
  let decoded = relPath;
  try{ decoded = decodeURIComponent(relPath); }catch(e){}
  const pathPart = decoded.split('#')[0];
  const combined = (baseDir||'') + pathPart;
  const parts = combined.split('/');
  const out = [];
  for (const p of parts){
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>el.classList.remove('show'), 3200);
}
function showLoading(on){ document.getElementById('loading-overlay').hidden = !on; }

/* ---------- parsing do epub ---------- */
async function parseEpub(file){
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('container.xml ausente');
  const containerXml = await containerFile.async('string');
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const rootfileEl = containerDoc.querySelector('rootfile');
  if (!rootfileEl) throw new Error('rootfile ausente');
  const rootfilePath = rootfileEl.getAttribute('full-path');
  const opfDir = rootfilePath.includes('/') ? rootfilePath.slice(0, rootfilePath.lastIndexOf('/')+1) : '';

  const opfFile = zip.file(rootfilePath);
  if (!opfFile) throw new Error('arquivo OPF ausente');
  const opfXml = await opfFile.async('string');
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

  const getText = (sel) => { const el = opfDoc.querySelector(sel); return el ? el.textContent.trim() : ''; };
  const title = getText('metadata > title, title') || file.name.replace(/\.epub$/i,'');
  const creator = getText('metadata > creator, creator');
  let identifier = getText('metadata > identifier, identifier');

  const manifest = {};
  opfDoc.querySelectorAll('manifest > item').forEach(item=>{
    manifest[item.getAttribute('id')] = {
      href: resolvePath(opfDir, item.getAttribute('href')),
      type: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || ''
    };
  });

  const spineEl = opfDoc.querySelector('spine');
  const tocId = spineEl ? spineEl.getAttribute('toc') : null;
  const spineItems = [];
  opfDoc.querySelectorAll('spine > itemref').forEach(ref=>{
    const item = manifest[ref.getAttribute('idref')];
    if (item) spineItems.push(item.href);
  });

  let toc = [];
  const navItem = Object.values(manifest).find(m=>m.properties.includes('nav'));
  if (navItem){
    try{
      const navXml = await zip.file(navItem.href).async('string');
      let navDoc = new DOMParser().parseFromString(navXml, 'application/xhtml+xml');
      if (navDoc.querySelector('parsererror')) navDoc = new DOMParser().parseFromString(navXml, 'text/html');
      const navs = Array.from(navDoc.querySelectorAll('nav'));
      const navEl = navs.find(n => (n.getAttributeNS('http://www.idpf.org/2007/ops','type')||n.getAttribute('epub:type')||'').includes('toc')) || navs[0];
      const navDir = navItem.href.includes('/') ? navItem.href.slice(0, navItem.href.lastIndexOf('/')+1) : '';
      if (navEl){
        navEl.querySelectorAll('a[href]').forEach(a=>{
          toc.push({ title: a.textContent.trim(), href: resolvePath(navDir, a.getAttribute('href')) });
        });
      }
    }catch(e){ /* sumário nav ausente ou inválido */ }
  }
  if (!toc.length && tocId && manifest[tocId]){
    try{
      const ncxXml = await zip.file(manifest[tocId].href).async('string');
      const ncxDoc = new DOMParser().parseFromString(ncxXml, 'application/xml');
      const ncxDir = manifest[tocId].href.includes('/') ? manifest[tocId].href.slice(0, manifest[tocId].href.lastIndexOf('/')+1) : '';
      ncxDoc.querySelectorAll('navMap > navPoint').forEach(np=>{
        const label = np.querySelector('navLabel > text');
        const content = np.querySelector('content');
        if (label && content){
          toc.push({ title: label.textContent.trim(), href: resolvePath(ncxDir, content.getAttribute('src')) });
        }
      });
    }catch(e){ /* NCX ausente ou inválido */ }
  }

  if (!identifier) identifier = title + '|' + creator;
  const id = hashStr(identifier);

  return { zip, id, title, creator, spineItems, toc };
}

/* ---------- recursos do capítulo (imagens, css) ---------- */
async function getResourceBlobUrl(zip, path, mimeType){
  if (blobUrlCache.has(path)) return blobUrlCache.get(path);
  const zf = zip.file(path);
  if (!zf) return null;
  const raw = await zf.async('blob');
  const typed = mimeType ? new Blob([raw], {type:mimeType}) : raw;
  const url = URL.createObjectURL(typed);
  blobUrlCache.set(path, url);
  return url;
}
function clearBlobCache(){
  for (const url of blobUrlCache.values()) URL.revokeObjectURL(url);
  blobUrlCache.clear();
}
async function inlineCssUrls(zip, cssText, baseDir){
  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const matches = [...cssText.matchAll(urlRegex)];
  for (const m of matches){
    const original = m[2];
    if (/^(data:|https?:|blob:)/i.test(original)) continue;
    const resolved = resolvePath(baseDir, original);
    const url = await getResourceBlobUrl(zip, resolved, guessMime(resolved));
    if (url) cssText = cssText.split(m[0]).join('url("'+url+'")');
  }
  return cssText;
}
async function renderChapterHtml(book, chapterHref){
  const zip = book.zip;
  const raw = await zip.file(chapterHref).async('string');
  let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(raw, 'text/html');
  const chapterDir = chapterHref.includes('/') ? chapterHref.slice(0, chapterHref.lastIndexOf('/')+1) : '';

  const imgs = doc.querySelectorAll('img, image');
  for (const img of imgs){
    let attr = null, ns = null;
    if (img.hasAttribute('src')) attr = 'src';
    else if (img.getAttributeNS('http://www.w3.org/1999/xlink','href')) { attr='href'; ns='http://www.w3.org/1999/xlink'; }
    if (!attr) continue;
    const relSrc = ns ? img.getAttributeNS(ns, attr) : img.getAttribute(attr);
    if (!relSrc || /^(data:|https?:|blob:)/i.test(relSrc)) continue;
    const resolved = resolvePath(chapterDir, relSrc);
    const url = await getResourceBlobUrl(zip, resolved, guessMime(resolved));
    if (url){ ns ? img.setAttributeNS(ns, attr, url) : img.setAttribute(attr, url); }
  }

  let inlineCss = '';
  const links = doc.querySelectorAll('link[rel="stylesheet"]');
  for (const link of links){
    const href = link.getAttribute('href');
    if (href){
      const resolved = resolvePath(chapterDir, href);
      try{
        const cssZf = zip.file(resolved);
        if (cssZf){
          let cssText = await cssZf.async('string');
          const cssDir = resolved.includes('/') ? resolved.slice(0, resolved.lastIndexOf('/')+1) : '';
          cssText = await inlineCssUrls(zip, cssText, cssDir);
          inlineCss += cssText + '\n';
        }
      }catch(e){ /* css ausente, ignora */ }
    }
    link.remove();
  }
  const styleEls = doc.querySelectorAll('style');
  for (const styleEl of styleEls){
    styleEl.textContent = await inlineCssUrls(zip, styleEl.textContent||'', chapterDir);
  }

  const bodyHtml = doc.body ? doc.body.innerHTML : raw;
  return { bodyHtml, css: inlineCss };
}

/* ---------- paginação ---------- */
function ensureShadow(){
  if (!shadowRoot) shadowRoot = document.getElementById('book-host').attachShadow({mode:'open'});
  return shadowRoot;
}
function themeColors(theme){
  const themes = {
    paper:{ bg:'#FAF6EE', fg:'#2B2620' },
    sepia:{ bg:'#F0E4CC', fg:'#4B3B23' },
    night:{ bg:'#1B1B1F', fg:'#D8D5CC' }
  };
  return themes[theme] || themes.paper;
}
function themeCss(settings){
  const t = themeColors(settings.theme);
  const fontStack = settings.fontFamily === 'sans'
    ? '-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif'
    : 'Georgia,"Iowan Old Style","Palatino Linotype","Book Antiqua",serif';
  return ':host{ display:block; width:100%; height:100%; }' +
    '*{ box-sizing:border-box; }' +
    '.page-surface{ background:'+t.bg+'; color:'+t.fg+'; font-family:'+fontStack+'; font-size:'+settings.fontSize+'%; line-height:1.65; }' +
    '.pager, .pager p, .pager div, .pager span, .pager li, .pager td, .pager h1, .pager h2, .pager h3, .pager h4, .pager blockquote { color:'+t.fg+' !important; background-color:transparent !important; }' +
    '.pager img, .pager svg{ max-width:100%; height:auto; break-inside:avoid; }' +
    '.pager h1, .pager h2, .pager h3{ break-inside:avoid; }' +
    '.pager a{ color:inherit; }';
}
function getViewportWidth(){ return document.getElementById('book-host').clientWidth; }
function getViewportHeight(){ return document.getElementById('book-host').clientHeight; }
function layoutColumns(){
  const outerW = getViewportWidth();
  const outerH = getViewportHeight();
  const padX = Math.round(outerW * 0.08);
  const padY = Math.round(outerH * 0.07);
  const innerW = Math.max(50, outerW - padX*2);
  const innerH = Math.max(50, outerH - padY*2);

  const surface = shadowRoot.querySelector('.page-surface');
  surface.style.width = outerW + 'px';
  surface.style.height = outerH + 'px';
  surface.style.padding = padY + 'px ' + padX + 'px';
  surface.style.overflow = 'hidden';
  surface.style.boxSizing = 'border-box';

  pagerEl.style.columnWidth = innerW + 'px';
  pagerEl.style.columnGap = '0px';
  pagerEl.style.columnFill = 'auto';
  pagerEl.style.height = innerH + 'px';
  pagerEl.style.width = innerW + 'px';
  pagerEl.style.transition = 'transform .28s ease';

  state.pageWidth = innerW;
}
async function renderChapter(book, chapterIndex, targetPageFraction){
  currentChapterIndex = Math.max(0, Math.min(chapterIndex, book.spineItems.length-1));
  const chapterHref = book.spineItems[currentChapterIndex];
  const { bodyHtml, css } = await renderChapterHtml(book, chapterHref);
  const root = ensureShadow();
  root.innerHTML = '<style>'+themeCss(state.settings)+'</style><style>'+css+'</style>' +
    '<div class="page-surface"><div class="pager" id="pager">'+bodyHtml+'</div></div>';
  pagerEl = root.getElementById('pager');
  layoutColumns();

  totalPagesInChapter = Math.max(1, Math.round(pagerEl.scrollWidth / state.pageWidth));
  let pageIndex = 0;
  if (typeof targetPageFraction === 'number'){
    pageIndex = Math.min(totalPagesInChapter - 1, Math.round(targetPageFraction * totalPagesInChapter));
  }
  goToPage(pageIndex, false);
}
function goToPage(pageIndex, animate){
  currentPageIndex = Math.max(0, Math.min(totalPagesInChapter - 1, pageIndex));
  if (animate === false) pagerEl.style.transition = 'none';
  pagerEl.style.transform = 'translateX(-' + (currentPageIndex * state.pageWidth) + 'px)';
  if (animate === false){
    const el = pagerEl;
    requestAnimationFrame(()=>{ el.style.transition = 'transform .28s ease'; });
  }
  updateStatusBar();
  persistPositionDebounced();
}
async function nextPage(){
  if (!currentBook) return;
  if (currentPageIndex < totalPagesInChapter - 1) goToPage(currentPageIndex + 1);
  else if (currentChapterIndex < currentBook.spineItems.length - 1) await renderChapter(currentBook, currentChapterIndex + 1, 0);
}
async function prevPage(){
  if (!currentBook) return;
  if (currentPageIndex > 0) goToPage(currentPageIndex - 1);
  else if (currentChapterIndex > 0) await renderChapter(currentBook, currentChapterIndex - 1, 0.999);
}
function findChapterIndexForHref(book, href){
  const pathOnly = href.split('#')[0];
  let idx = book.spineItems.indexOf(pathOnly);
  if (idx === -1){
    const fname = pathOnly.split('/').pop();
    idx = book.spineItems.findIndex(sp => sp.split('/').pop() === fname);
  }
  return idx === -1 ? 0 : idx;
}

/* ---------- persistência de progresso ---------- */
function persistPositionDebounced(){
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistPosition, 500);
}
async function persistPosition(){
  if (!currentBook) return;
  const pageFraction = totalPagesInChapter > 0 ? currentPageIndex / totalPagesInChapter : 0;
  const totalChapters = currentBook.spineItems.length;
  const progressPercent = Math.round(((currentChapterIndex + pageFraction) / totalChapters) * 100);
  const entry = {
    id: currentBook.id, title: currentBook.title, author: currentBook.creator,
    chapterIndex: currentChapterIndex, pageFraction, totalChapters, progressPercent,
    lastReadAt: Date.now(), hue: hueFromStr(currentBook.title + currentBook.creator)
  };
  const idx = state.library.findIndex(b=>b.id===currentBook.id);
  if (idx >= 0) state.library[idx] = Object.assign({}, state.library[idx], entry);
  else { entry.addedAt = Date.now(); state.library.push(entry); }
  await saveLibrary(state.library);
}

/* ---------- UI: status, toc, ajustes ---------- */
function updateStatusBar(){
  if (!currentBook) return;
  let label = 'Capítulo ' + (currentChapterIndex+1) + ' de ' + currentBook.spineItems.length;
  const match = currentBook.toc.find(t => findChapterIndexForHref(currentBook, t.href) === currentChapterIndex);
  if (match) label = match.title;
  document.getElementById('status-chapter').textContent = label;
  document.getElementById('status-page').textContent = (currentPageIndex+1) + ' / ' + totalPagesInChapter;
  const pct = Math.round(((currentChapterIndex + (currentPageIndex/totalPagesInChapter)) / currentBook.spineItems.length) * 100);
  document.getElementById('status-progress-fill').style.width = pct + '%';
}
function renderToc(book){
  const wrap = document.getElementById('toc-list');
  if (!book.toc.length){
    wrap.innerHTML = '<p style="color:var(--paper-dim);font-size:13px;">Sumário não disponível para este livro.</p>';
    return;
  }
  wrap.innerHTML = book.toc.map(t => '<button class="toc-item" data-href="'+escapeHtml(t.href)+'">'+escapeHtml(t.title)+'</button>').join('');
  wrap.querySelectorAll('.toc-item').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const idx = findChapterIndexForHref(currentBook, btn.dataset.href);
      closeAllPanels();
      await renderChapter(currentBook, idx, 0);
    });
  });
}
function updateSettingsPanelUI(){
  document.querySelectorAll('.theme-swatch').forEach(b=>b.classList.toggle('active', b.dataset.theme===state.settings.theme));
  document.getElementById('font-size-label').textContent = state.settings.fontSize+'%';
  document.querySelectorAll('.font-toggle button').forEach(b=>b.classList.toggle('active', b.dataset.font===state.settings.fontFamily));
}
async function applySettingsChange(){
  await saveSettings(state.settings);
  if (currentBook && pagerEl){
    const oldFraction = totalPagesInChapter > 0 ? currentPageIndex/totalPagesInChapter : 0;
    await renderChapter(currentBook, currentChapterIndex, oldFraction);
  }
}
function openPanel(id){
  document.getElementById('backdrop').classList.add('show');
  document.getElementById(id).classList.add('show');
}
function closeAllPanels(){
  document.getElementById('backdrop').classList.remove('show');
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('show'));
}
function toggleChrome(){ document.getElementById('view-reader').classList.toggle('chrome-hidden'); }

/* ---------- biblioteca ---------- */
function renderLibraryView(){
  const section = document.getElementById('library-section');
  const wrap = document.getElementById('library-list');
  if (!state.library.length){ section.hidden = true; return; }
  section.hidden = false;
  const sorted = state.library.slice().sort((a,b)=>b.lastReadAt-a.lastReadAt);
  wrap.innerHTML = sorted.map(b =>
    '<div class="spine" style="--hue:'+b.hue+'" data-id="'+b.id+'" role="button" tabindex="0">' +
      '<button class="spine-remove" data-remove="'+b.id+'" aria-label="Remover">×</button>' +
      '<span class="spine-title">'+escapeHtml(b.title)+'</span>' +
      '<span class="spine-author">'+escapeHtml(b.author||'')+'</span>' +
      '<span class="spine-progress"><span style="width:'+(b.progressPercent||0)+'%"></span></span>' +
    '</div>'
  ).join('');
  wrap.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      state.library = state.library.filter(b=>b.id!==btn.dataset.remove);
      await saveLibrary(state.library);
      renderLibraryView();
    });
  });
  wrap.querySelectorAll('.spine').forEach(el=>{
    const open = ()=>{ toast('Selecione o arquivo desse livro para continuar de onde parou.'); document.getElementById('file-input').click(); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e)=>{ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); open(); } });
  });
}
function switchToReaderView(){
  document.getElementById('view-library').hidden = true;
  document.getElementById('view-reader').hidden = false;
}
function switchToLibraryView(){
  document.getElementById('view-reader').hidden = true;
  document.getElementById('view-library').hidden = false;
  document.getElementById('view-reader').classList.remove('chrome-hidden');
  currentBook = null;
  if (shadowRoot) shadowRoot.innerHTML = '';
  renderLibraryView();
}

/* ---------- abrir arquivo ---------- */
async function openFile(file){
  if (!file) return;
  if (!/\.epub$/i.test(file.name) && file.type !== 'application/epub+zip'){
    toast('Selecione um arquivo .epub válido.');
    return;
  }
  showLoading(true);
  clearBlobCache();
  try{
    const book = await parseEpub(file);
    if (!book.spineItems.length) throw new Error('spine vazio');
    currentBook = book;
    switchToReaderView();
    document.getElementById('reader-title').textContent = book.title;
    renderToc(book);
    const existing = state.library.find(b=>b.id===book.id);
    if (existing){
      await renderChapter(book, existing.chapterIndex, existing.pageFraction);
      toast('Retomando "'+book.title+'" de onde você parou.');
    } else {
      await renderChapter(book, 0, 0);
    }
  }catch(err){
    console.error(err);
    toast('Não foi possível abrir esse EPUB. Verifique se o arquivo não está corrompido ou protegido por DRM.');
  }finally{
    showLoading(false);
  }
}

/* ---------- eventos ---------- */
function wireEvents(){
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  ['dragenter','dragover'].forEach(evt => dropzone.addEventListener(evt, e=>{ e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, e=>{ e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', e=>{ const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) openFile(f); });
  dropzone.addEventListener('click', ()=>fileInput.click());
  dropzone.addEventListener('keydown', e=>{ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', e=>{ const f = e.target.files[0]; if (f) openFile(f); e.target.value=''; });

  document.getElementById('back-to-library').addEventListener('click', switchToLibraryView);
  document.getElementById('open-settings').addEventListener('click', ()=>openPanel('panel-settings'));
  document.getElementById('open-toc').addEventListener('click', ()=>openPanel('panel-toc'));
  document.getElementById('backdrop').addEventListener('click', closeAllPanels);

  document.querySelectorAll('.theme-swatch').forEach(btn=>{
    btn.addEventListener('click', async ()=>{ state.settings.theme = btn.dataset.theme; updateSettingsPanelUI(); await applySettingsChange(); });
  });
  document.getElementById('font-inc').addEventListener('click', async ()=>{ state.settings.fontSize = Math.min(160, state.settings.fontSize+10); updateSettingsPanelUI(); await applySettingsChange(); });
  document.getElementById('font-dec').addEventListener('click', async ()=>{ state.settings.fontSize = Math.max(80, state.settings.fontSize-10); updateSettingsPanelUI(); await applySettingsChange(); });
  document.querySelectorAll('.font-toggle button').forEach(btn=>{
    btn.addEventListener('click', async ()=>{ state.settings.fontFamily = btn.dataset.font; updateSettingsPanelUI(); await applySettingsChange(); });
  });

  document.getElementById('book-host').addEventListener('click', (e)=>{
    const path = e.composedPath ? e.composedPath() : [e.target];
    const link = path.find(el => el.tagName === 'A');
    if (link && link.getAttribute('href')){
      e.preventDefault();
      const href = link.getAttribute('href');
      if (/^https?:/i.test(href)){ toast('Links externos não são abertos no leitor.'); return; }
      const chapterHref = currentBook.spineItems[currentChapterIndex];
      const chapterDir = chapterHref.includes('/') ? chapterHref.slice(0, chapterHref.lastIndexOf('/')+1) : '';
      const resolved = resolvePath(chapterDir, href);
      const idx = findChapterIndexForHref(currentBook, resolved);
      renderChapter(currentBook, idx, 0);
      return;
    }
    const rect = document.getElementById('book-host').getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    if (relX < 0.3) prevPage();
    else if (relX > 0.7) nextPage();
    else toggleChrome();
  });

  let touchStartX = null;
  const hostEl = document.getElementById('book-host');
  hostEl.addEventListener('touchstart', e=>{ touchStartX = e.touches[0].clientX; }, {passive:true});
  hostEl.addEventListener('touchend', e=>{
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50){ dx < 0 ? nextPage() : prevPage(); }
    touchStartX = null;
  }, {passive:true});

  document.addEventListener('keydown', e=>{
    if (document.getElementById('view-reader').hidden) return;
    if (e.key === 'ArrowRight') nextPage();
    else if (e.key === 'ArrowLeft') prevPage();
    else if (e.key === 'Escape') closeAllPanels();
  });

  window.addEventListener('resize', ()=>{
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(()=>{
      if (!currentBook || !pagerEl) return;
      const oldFraction = totalPagesInChapter > 0 ? currentPageIndex/totalPagesInChapter : 0;
      layoutColumns();
      totalPagesInChapter = Math.max(1, Math.round(pagerEl.scrollWidth / state.pageWidth));
      goToPage(Math.round(oldFraction * totalPagesInChapter), false);
    }, 200);
  });
}

/* ---------- inicialização ---------- */
(async function init(){
  state.settings = await loadSettings();
  state.library = await loadLibrary();
  updateSettingsPanelUI();
  renderLibraryView();
  wireEvents();
})();

})();
