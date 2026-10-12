/* Предпросмотр файлов без открытия: миниатюра первой страницы и крупный просмотр по клику.
 *  - картинки (jpg, png, gif, webp, bmp) показываются как есть;
 *  - PDF: первая страница рисуется в браузере (pdf.js из /vendor/pdfjs), в крупном просмотре можно листать;
 *  - остальное (Word, Excel и т.д.): значок типа файла — для них нужна серверная конвертация.
 * Источник — URL (скачивание файла с сервера) или объект File/Blob (файл, который только выбрали).
 *
 *   FilePreview.thumb(контейнер, источник, 'имя.pdf', { href: 'ссылка для скачивания' })
 *   FilePreview.open(источник, 'имя.pdf', 'ссылка для скачивания')
 */
(function () {
  var IMG = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  var ICONS = { doc: '📝', docx: '📝', odt: '📝', rtf: '📝', xls: '📊', xlsx: '📊', csv: '📊', ods: '📊', ppt: '📽', pptx: '📽',
    txt: '📃', zip: '🗜', rar: '🗜', '7z': '🗜' };

  function ext(name) { var m = /\.([^.\\/]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  function kindOf(name) { var e = ext(name); return IMG[e] ? 'image' : e === 'pdf' ? 'pdf' : 'other'; }
  function iconOf(name) { return ICONS[ext(name)] || '📄'; }

  var cssDone = false;
  function css() {
    if (cssDone) return; cssDone = true;
    var st = document.createElement('style');
    st.textContent =
      '.fp-thumb{width:44px;height:56px;flex:none;border:1px solid var(--border2,#d9c6a3);border-radius:6px;background:var(--card,#fff);display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;font-size:1.3rem;color:var(--muted,#888);padding:0}' +
      '.fp-thumb:hover{border-color:var(--acc,#9c1a22)}.fp-thumb canvas,.fp-thumb img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}' +
      '.fp-dlg{border:1px solid var(--border,#e7d9c0);border-radius:14px;padding:0;width:min(820px,96vw);max-height:94vh;background:var(--card,#fff);color:var(--txt,#222);margin:auto;overflow:hidden}' +
      '.fp-dlg::backdrop{background:rgba(20,8,6,.65)}.fp-head{display:flex;align-items:center;gap:.7rem;padding:.7rem 1rem;border-bottom:1px solid var(--border,#e7d9c0)}' +
      '.fp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9rem}.fp-pages{color:var(--muted,#888);font-size:.8rem;white-space:nowrap}' +
      '.fp-btn{border:1px solid var(--border2,#d9c6a3);background:var(--card,#fff);color:var(--txt,#222);border-radius:8px;padding:.3rem .7rem;font:inherit;font-size:.8rem;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}' +
      '.fp-btn:disabled{opacity:.4;cursor:default}.fp-body{padding:1rem;overflow:auto;max-height:calc(94vh - 60px);display:flex;justify-content:center;background:var(--bg2,#f3ead9)}' +
      '.fp-body canvas,.fp-body img{max-width:100%;height:auto;box-shadow:0 4px 18px rgba(0,0,0,.25);background:#fff}.fp-msg{padding:2rem 1rem;text-align:center;color:var(--txt2,#666);font-size:.9rem}' +
      '.fp-strip{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.5rem}.fp-item{display:flex;flex-direction:column;align-items:center;gap:.2rem;width:64px;font-size:.68rem;color:var(--muted,#888);text-align:center}.fp-item span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
    document.head.appendChild(st);
  }

  // ---- загрузка байтов и pdf.js ----
  function bytes(src) {
    if (typeof Blob !== 'undefined' && src instanceof Blob) return src.arrayBuffer();
    return fetch(src).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
  }
  var pdfjsP = null;
  function pdfjs() {
    if (!pdfjsP) pdfjsP = import('/vendor/pdfjs/pdf.min.mjs').then(function (m) { m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs'; return m; });
    return pdfjsP;
  }
  var docs = typeof Map !== 'undefined' ? new Map() : null;     // ключ (URL или File) -> promise документа
  function pdfDoc(src) {
    if (docs.has(src)) return docs.get(src);
    var p = Promise.all([pdfjs(), bytes(src)]).then(function (r) {
      return r[0].getDocument({ data: r[1], cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' }).promise;
    });
    p.catch(function () { docs.delete(src); });
    docs.set(src, p);
    return p;
  }
  function renderPage(doc, n, canvas, cssWidth) {
    return doc.getPage(n).then(function (page) {
      var v0 = page.getViewport({ scale: 1 }), dpr = window.devicePixelRatio || 1;
      var vp = page.getViewport({ scale: (cssWidth / v0.width) * dpr });
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      canvas.style.width = Math.floor(vp.width / dpr) + 'px';
      return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    });
  }
  var urls = typeof Map !== 'undefined' ? new Map() : null;      // ключ -> promise blob-URL картинки
  function imageUrl(src, name) {
    if (urls.has(src)) return urls.get(src);
    var p = bytes(src).then(function (buf) { return URL.createObjectURL(new Blob([buf], { type: IMG[ext(name)] || 'image/*' })); });
    p.catch(function () { urls.delete(src); });
    urls.set(src, p);
    return p;
  }

  // ---- миниатюра ----
  function thumb(el, src, name, opts) {
    css();
    opts = opts || {};
    var kind = kindOf(name);
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'fp-thumb'; b.title = 'Предпросмотр: ' + name; b.setAttribute('aria-label', 'Предпросмотр ' + name);
    b.textContent = kind === 'other' ? iconOf(name) : '…';
    b.addEventListener('click', function (e) { e.stopPropagation(); open(src, name, opts.href); });
    el.innerHTML = ''; el.appendChild(b);
    if (kind === 'image') {
      imageUrl(src, name).then(function (u) { var im = new Image(); im.alt = ''; im.onload = function () { b.textContent = ''; b.appendChild(im); }; im.onerror = function () { b.textContent = '🖼'; }; im.src = u; })
        .catch(function () { b.textContent = '⚠'; });
    } else if (kind === 'pdf') {
      pdfDoc(src).then(function (doc) { var c = document.createElement('canvas'); return renderPage(doc, 1, c, 120).then(function () { c.style.width = ''; b.textContent = ''; b.appendChild(c); }); })
        .catch(function () { b.textContent = '📕'; b.title = 'Не удалось построить предпросмотр: ' + name; });
    }
    return b;
  }

  // ---- крупный просмотр ----
  var dlg = null, state = null;
  function ensureDialog() {
    if (dlg) return dlg;
    css();
    dlg = document.createElement('dialog'); dlg.className = 'fp-dlg';
    dlg.innerHTML = '<div class="fp-head"><b class="fp-name"></b><span class="fp-pages"></span>' +
      '<button type="button" class="fp-btn fp-prev" aria-label="Предыдущая страница">‹</button><button type="button" class="fp-btn fp-next" aria-label="Следующая страница">›</button>' +
      '<a class="fp-btn fp-dl" href="#" download>⬇ Скачать</a><button type="button" class="fp-btn fp-x" aria-label="Закрыть">✕</button></div><div class="fp-body"></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    dlg.querySelector('.fp-x').onclick = function () { dlg.close(); };
    dlg.querySelector('.fp-prev').onclick = function () { go(-1); };
    dlg.querySelector('.fp-next').onclick = function () { go(1); };
    dlg.addEventListener('keydown', function (e) { if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); });
    return dlg;
  }
  function go(d) {
    if (!state || !state.doc) return;
    var n = state.page + d; if (n < 1 || n > state.doc.numPages) return;
    state.page = n; drawPdf();
  }
  function drawPdf() {
    var body = dlg.querySelector('.fp-body'), my = state;
    var c = document.createElement('canvas');
    renderPage(my.doc, my.page, c, Math.min(760, Math.max(280, window.innerWidth - 80))).then(function () {
      if (state !== my) return;
      body.innerHTML = ''; body.appendChild(c);
      dlg.querySelector('.fp-pages').textContent = 'стр. ' + my.page + ' из ' + my.doc.numPages;
      dlg.querySelector('.fp-prev').disabled = my.page <= 1; dlg.querySelector('.fp-next').disabled = my.page >= my.doc.numPages;
    }).catch(function () { if (state === my) body.innerHTML = '<div class="fp-msg">Не удалось построить предпросмотр этой страницы.</div>'; });
  }
  function open(src, name, href) {
    var d = ensureDialog(), body = d.querySelector('.fp-body'), kind = kindOf(name);
    state = { src: src, page: 1, doc: null };
    d.querySelector('.fp-name').textContent = name;
    d.querySelector('.fp-pages').textContent = '';
    var link = d.querySelector('.fp-dl');
    if (typeof Blob !== 'undefined' && src instanceof Blob) { link.href = URL.createObjectURL(src); } else { link.href = href || src; }
    link.setAttribute('download', name);
    var pager = d.querySelectorAll('.fp-prev,.fp-next');
    Array.prototype.forEach.call(pager, function (b) { b.hidden = kind !== 'pdf'; b.disabled = true; });
    body.innerHTML = '<div class="fp-msg">Загрузка…</div>';
    if (!d.open) d.showModal();
    var my = state;
    if (kind === 'image') {
      imageUrl(src, name).then(function (u) { if (state !== my) return; body.innerHTML = ''; var im = new Image(); im.alt = name; im.src = u; body.appendChild(im); })
        .catch(function () { body.innerHTML = '<div class="fp-msg">Не удалось загрузить изображение.</div>'; });
    } else if (kind === 'pdf') {
      pdfDoc(src).then(function (doc) { if (state !== my) return; my.doc = doc; drawPdf(); })
        .catch(function () { if (state === my) body.innerHTML = '<div class="fp-msg">Не удалось построить предпросмотр. Возможно, файл повреждён или защищён паролем — скачайте его и откройте на компьютере.</div>'; });
    } else {
      body.innerHTML = '<div class="fp-msg"><div style="font-size:2.4rem">' + iconOf(name) + '</div>Предпросмотр для этого формата недоступен.<br>Скачайте файл, чтобы открыть его.</div>';
    }
  }

  // ---- полоска миниатюр для только что выбранных файлов (input type=file) ----
  function strip(el, files) {
    css();
    el.innerHTML = '';
    Array.prototype.forEach.call(files, function (f) {
      var item = document.createElement('div'); item.className = 'fp-item';
      var slot = document.createElement('div'), cap = document.createElement('span'); cap.textContent = f.name; cap.title = f.name;
      item.appendChild(slot); item.appendChild(cap); el.appendChild(item);
      thumb(slot, f, f.name);
    });
  }

  window.FilePreview = { thumb: thumb, open: open, strip: strip, kindOf: kindOf };
})();
