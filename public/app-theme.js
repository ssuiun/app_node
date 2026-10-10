/* Цветовые темы оформления (те же, что в «Визы и договоры»).
 * Подключение: <script src="/app-theme.js" data-key="ключ_в_localStorage"></script> в <head>,
 * кнопка настроек вызывает AppTheme.renderGrid(), клики по .theme-opt[data-theme] — AppTheme.apply(key). */
(function () {
  var KEY = (document.currentScript && document.currentScript.getAttribute('data-key')) || 'app_theme';
  const THEMES = {
    red: {name:'Красно-золотой', vars:{'--bg':'#faf6ef','--bg2':'#f3ead9','--card':'#fffdf8','--card2':'#f3ead9','--border':'#e7d9c0','--border2':'#d9c6a3','--acc':'#9c1a22','--acc2':'#c9a353','--acc3':'#2e8b57','--txt':'#2b1c14','--txt2':'#6b5644','--muted':'#8a7561','--hdr1':'#8c1220','--hdr2':'#5c0f14','--glow':'0 0 18px rgba(156,26,34,.22)','--glow2':'0 0 10px rgba(156,26,34,.25)','--logo-txt':'#2b1c14'}},
    blue: {name:'Тёмно-синий', vars:{'--bg':'#0d1420','--bg2':'#13202f','--card':'#16283a','--card2':'#1a3245','--border':'#22415c','--border2':'#2b5170','--acc':'#2a7fc8','--acc2':'#d4af37','--acc3':'#2e8b57','--txt':'#e9f0f5','--txt2':'#a9c0c9','--muted':'#77939e','--hdr1':'#0a121c','--hdr2':'#0f1c2a','--glow':'0 0 18px rgba(42,127,200,.35)','--glow2':'0 0 10px rgba(42,127,200,.4)','--logo-txt':'#e9f0f5'}},
    green: {name:'Изумрудный', vars:{'--bg':'#0d1a12','--bg2':'#13241a','--card':'#162b1e','--card2':'#1a3524','--border':'#224a30','--border2':'#2b5c3c','--acc':'#2e8b57','--acc2':'#d4af37','--acc3':'#3498db','--txt':'#e9f5ee','--txt2':'#a9c9b3','--muted':'#6f977f','--hdr1':'#0a140f','--hdr2':'#0f1e16','--glow':'0 0 18px rgba(46,139,87,.35)','--glow2':'0 0 10px rgba(46,139,87,.4)','--logo-txt':'#e9f5ee'}},
    purple: {name:'Фиолетовый', vars:{'--bg':'#160d20','--bg2':'#20132f','--card':'#28163a','--card2':'#331a45','--border':'#48225c','--border2':'#5a2b70','--acc':'#8e3fc8','--acc2':'#d4af37','--acc3':'#2e8b57','--txt':'#f0e9f5','--txt2':'#c0a9c9','--muted':'#987ea2','--hdr1':'#120a1a','--hdr2':'#1a1128','--glow':'0 0 18px rgba(142,63,200,.35)','--glow2':'0 0 10px rgba(142,63,200,.4)','--logo-txt':'#f0e9f5'}},
    slate: {name:'Графитовый', vars:{'--bg':'#15171a','--bg2':'#1d2024','--card':'#22262b','--card2':'#282d33','--border':'#383e46','--border2':'#454c56','--acc':'#5c7cfa','--acc2':'#d4af37','--acc3':'#2e8b57','--txt':'#eceef0','--txt2':'#a9b1bb','--muted':'#878e98','--hdr1':'#111317','--hdr2':'#181b1f','--glow':'0 0 18px rgba(92,124,250,.35)','--glow2':'0 0 10px rgba(92,124,250,.4)','--logo-txt':'#eceef0'}},
    light: {name:'Светлая', vars:{'--bg':'#f5f2ec','--bg2':'#ffffff','--card':'#ffffff','--card2':'#f0ece2','--border':'#ddd3c2','--border2':'#c9bba0','--acc':'#c8282a','--acc2':'#a8862a','--acc3':'#2e8b57','--txt':'#2b1a1a','--txt2':'#5c4530','--muted':'#82735b','--hdr1':'#ffffff','--hdr2':'#f2ece0','--glow':'0 0 12px rgba(200,40,42,.25)','--glow2':'0 0 8px rgba(200,40,42,.3)','--logo-txt':'#2b1c14'}}
  };
  var current = 'red';
  function apply(key, save) {
    var t = THEMES[key]; if (!t) return;
    var root = document.documentElement.style;
    Object.keys(t.vars).forEach(function (k) { root.setProperty(k, t.vars[k]); });
    root.setProperty('--hdr-txt', key === 'light' ? '#2b1c14' : '#fff');
    // Для оболочки (index.ejs) с переменными --bsp-*: переносим палитру темы на них.
    var map = { '--bsp-cream': '--bg', '--bsp-cream-2': '--bg2', '--bsp-paper': '--card', '--bsp-border': '--border',
      '--bsp-ink': '--txt', '--bsp-ink-soft': '--txt2', '--bsp-muted': '--muted', '--bsp-red-1': '--acc', '--bsp-gold': '--acc2' };
    Object.keys(map).forEach(function (k) { root.setProperty(k, t.vars[map[k]]); });
    document.documentElement.setAttribute('data-app-theme', key);
    root.colorScheme = key === 'light' || key === 'red' ? 'light' : 'dark';
    current = key;
    if (save !== false) { try { localStorage.setItem(KEY, key); } catch (e) {} }
    renderGrid();
  }
  function renderGrid() {
    var g = document.getElementById('theme-grid'); if (!g) return;
    g.innerHTML = Object.keys(THEMES).map(function (k) {
      var t = THEMES[k];
      return '<button type="button" class="theme-opt' + (k === current ? ' sel' : '') + '" data-theme="' + k + '">' +
        '<span class="theme-sw" style="background:linear-gradient(135deg,' + t.vars['--acc'] + ',' + t.vars['--acc2'] + ')"></span><span>' + t.name + '</span></button>';
    }).join('');
  }
  var saved = null; try { saved = localStorage.getItem(KEY); } catch (e) {}
  apply(saved && THEMES[saved] ? saved : 'red', false);
  window.AppTheme = { apply: apply, renderGrid: renderGrid };
})();
