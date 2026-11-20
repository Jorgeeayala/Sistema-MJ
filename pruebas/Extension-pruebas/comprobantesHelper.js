// ============================================================================
// Botón flotante «Comprobantes» (de Marangatu Helper, integrado en la 2.16)
// ----------------------------------------------------------------------------
// En Marangatu muestra un botón 📅 que se puede arrastrar. Hace dos cosas:
//   1. «Ir a Comprobantes»: menú principal → Declaraciones Informativas →
//      Gestión de Comprobantes Informativos → Obtener Comprob. Elect. y
//      Virtuales. Marangatu abre ventanas nuevas en el camino: cada pestaña
//      retoma el paso pendiente (localStorage de Marangatu, 1 minuto).
//   2. En «Obtener Comprob.» (registroComprobantesVirtuales.do): elegir mes y
//      año y buscar con un clic. El último año queda recordado.
// Los CDCs se marcan con la columna «XML» del recolector (recolectorCdcUi.js);
// por eso este botón ya no extrae ni procesa CDCs.
// Guarda en el localStorage de Marangatu sólo posición, tamaño, último
// mes/año y el paso de navegación. Nada de claves ni datos de clientes.
// ============================================================================
(function () {
  'use strict';
  if (window !== window.top) return;
  if (document.getElementById('mara-widget')) return;

  var TAB_ID = sessionStorage.getItem('mara_tab_id');
  if (!TAB_ID) {
    TAB_ID = Math.random().toString(36).slice(2);
    sessionStorage.setItem('mara_tab_id', TAB_ID);
  }

  // Datos viejos del helper original (lista de CDCs con el proceso de KuDE).
  try {
    localStorage.removeItem('mara_current_cdc');
    localStorage.removeItem('mara_cdc_action');
    var viejo = JSON.parse(localStorage.getItem('mara_state') || 'null');
    if (viejo && viejo.cdcList) localStorage.setItem('mara_state', JSON.stringify({ lastMonth: viejo.lastMonth || null, lastYear: viejo.lastYear || null }));
    var oldPos = localStorage.getItem('mara_position');
    if (oldPos) {
      var p = JSON.parse(oldPos);
      if (p.x < 0 || p.y < 0 || p.x > window.innerWidth || p.y > window.innerHeight) localStorage.removeItem('mara_position');
    }
  } catch { localStorage.removeItem('mara_config'); localStorage.removeItem('mara_position'); }

  var PAGE = detectPage();

  function detectPage() {
    var url = window.location.href;
    if (url.indexOf('/eset/gdi/registroComprobantesVirtuales.do') !== -1)
      return { id: 'comprobantes', label: 'Comprobantes Electr.', step: 3, color: '#10b981' };
    if (url.indexOf('/eset/gestionComprobantesVirtuales') !== -1 ||
        (url.indexOf('/eset/gdi/') !== -1 && url.indexOf('registroComprobantesVirtuales') === -1))
      return { id: 'gestion', label: 'Gestión Comprobantes', step: 2, color: '#6366f1' };
    if (url.indexOf('/eset/main.do') !== -1 || url.indexOf('/eset/inicio') !== -1 || /\/eset\/?(\?|#|$)/.test(url))
      return { id: 'main', label: 'Menú Principal', step: 0, color: '#f59e0b' };
    return { id: 'other', label: 'Marangatu', step: -1, color: '#64748b' };
  }

  // En el acceso no hace falta el botón.
  if (/\/eset\/login/i.test(location.pathname)) return;

  var MONTHS = [
    { label: 'Ene', value: '1', full: 'Enero' }, { label: 'Feb', value: '2', full: 'Febrero' },
    { label: 'Mar', value: '3', full: 'Marzo' }, { label: 'Abr', value: '4', full: 'Abril' },
    { label: 'May', value: '5', full: 'Mayo' }, { label: 'Jun', value: '6', full: 'Junio' },
    { label: 'Jul', value: '7', full: 'Julio' }, { label: 'Ago', value: '8', full: 'Agosto' },
    { label: 'Sep', value: '9', full: 'Septiembre' }, { label: 'Oct', value: '10', full: 'Octubre' },
    { label: 'Nov', value: '11', full: 'Noviembre' }, { label: 'Dic', value: '12', full: 'Diciembre' },
  ];
  var currentYear = new Date().getFullYear();
  var YEARS = Array.from({ length: 10 }, function (_, i) { return currentYear - i; });

  var SIZES = {
    small: { width: 260, fontSize: 11, btnSize: 36 },
    medium: { width: 320, fontSize: 12, btnSize: 44 },
    large: { width: 380, fontSize: 13, btnSize: 52 },
  };
  function loadConfig() {
    try {
      var c = JSON.parse(localStorage.getItem('mara_config') || 'null');
      if (c) return { locked: !!c.locked, size: SIZES[c.size] ? c.size : 'medium' };
    } catch { /* por defecto */ }
    return { locked: false, size: 'medium' };
  }
  function saveConfig() { localStorage.setItem('mara_config', JSON.stringify(config)); applySize(); }
  var config = loadConfig();

  function applySize() {
    var s = SIZES[config.size] || SIZES.medium;
    var w = document.getElementById('mara-widget');
    var t = document.getElementById('mara-widget-toggle');
    if (w) { w.style.width = s.width + 'px'; w.style.fontSize = s.fontSize + 'px'; }
    if (t) { t.style.width = s.btnSize + 'px'; t.style.height = s.btnSize + 'px'; t.style.fontSize = (s.btnSize * 0.45) + 'px'; }
  }

  function loadState() {
    try { var s = JSON.parse(localStorage.getItem('mara_state') || 'null'); if (s) return s; } catch { /* vacío */ }
    return { lastMonth: null, lastYear: null };
  }
  function saveState() { localStorage.setItem('mara_state', JSON.stringify({ lastMonth: state.lastMonth, lastYear: state.lastYear })); }
  function loadNav() {
    try { var n = JSON.parse(localStorage.getItem('mara_nav') || 'null'); if (n) return n; } catch { /* vacío */ }
    return { active: false, step: 0 };
  }
  function saveNav(step) {
    localStorage.setItem('mara_nav', JSON.stringify({ active: true, step: step, ts: Date.now(), tabId: TAB_ID, url: window.location.href }));
  }
  function clearNav() { localStorage.removeItem('mara_nav'); }

  var persisted = loadState();
  var state = { lastMonth: persisted.lastMonth, lastYear: persisted.lastYear, open: false };

  function loadPosition() {
    try { var p = JSON.parse(localStorage.getItem('mara_position') || 'null'); if (p) return p; } catch { /* por defecto */ }
    // Abajo a la derecha: arriba está el panel de la extensión.
    return { x: window.innerWidth - 64, y: window.innerHeight - 64 };
  }
  function savePosition(x, y) { localStorage.setItem('mara_position', JSON.stringify({ x: x, y: y })); }

  function xpathEl(path) {
    return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  }
  function triggerChange(el) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function getMonthObj(val) { return MONTHS.find(function (x) { return x.value === val; }); }
  function closeWidget() { state.open = false; document.getElementById('mara-widget').classList.remove('mara-open'); }

  function waitFor(fn, timeout) {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      var check = setInterval(function () {
        var el = fn();
        if (el) { clearInterval(check); resolve(el); }
        else if (Date.now() - start > (timeout || 5000)) { clearInterval(check); reject(); }
      }, 100);
    });
  }

  function findMenuCards(text) {
    var results = [], seen = [], i, inner, el;
    function push(e) { if (e && seen.indexOf(e) === -1) { seen.push(e); results.push(e); } }
    var ngClicks = document.querySelectorAll('[data-ng-click]');
    for (i = 0; i < ngClicks.length; i++) {
      inner = (ngClicks[i].textContent || '').trim().replace(/\s+/g, ' ');
      if (inner.indexOf(text) !== -1) push(ngClicks[i]);
    }
    var cursors = document.querySelectorAll('.cursor-pointer');
    for (i = 0; i < cursors.length; i++) {
      inner = (cursors[i].textContent || '').trim().replace(/\s+/g, ' ');
      if (inner.indexOf(text) !== -1) push(cursors[i]);
    }
    var tags = document.querySelectorAll('h4, h3, h2, div.ng-binding, span.ng-binding');
    for (i = 0; i < tags.length; i++) {
      inner = (tags[i].textContent || '').trim().replace(/\s+/g, ' ');
      if (inner.indexOf(text) !== -1) {
        el = tags[i].closest('[data-ng-click]') || tags[i].closest('.cursor-pointer');
        push(el);
      }
    }
    return results;
  }
  function findMenuCard(text, occurrence) {
    var m = findMenuCards(text);
    return m[Math.max(0, (occurrence || 1) - 1)] || m[0] || null;
  }
  function clickElement(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }

  function body() { return document.getElementById('mara-body'); }
  function navStatus(step, text) {
    body().innerHTML = '<div class="mara-nav-status"><div class="mara-nav-spinner"></div><span>Paso ' + step + '/3: ' + text + '</span></div>';
  }
  function navError(text) {
    body().innerHTML = '<div class="mara-status error">' + text + '</div>';
    clearNav();
    setTimeout(showNavMenu, 2000);
  }
  function navDone(text) {
    body().innerHTML = '<div class="mara-status success">' + text + '</div>';
    setTimeout(closeWidget, 800);
  }

  function navigateToComprobantes(autoTriggered) {
    if (autoTriggered && !state.open) {
      state.open = true;
      document.getElementById('mara-widget').classList.add('mara-open');
      positionWidget();
    }
    if (!body()) return;

    if (PAGE.id === 'main' || PAGE.id === 'other') {
      saveNav(1);
      navStatus(1, 'Declaraciones Informativas...');
      setTimeout(function () {
        var el1 = findMenuCard('Declaraciones Informativas', 2);
        if (!el1) {
          var dx = xpathEl('/html/body/div[1]/div/div/div/div[2]/div/div[1]/div/div/div/div/section/div/div/div[2]/div/div/div[9]/div/div[1]');
          if (dx) el1 = dx.closest('[data-ng-click]') || dx.closest('.cursor-pointer') || dx;
        }
        if (!el1) { navError('No encontré Declaraciones Informativas. Abrí el menú principal.'); return; }
        clickElement(el1);
        saveNav(2);
        navStatus(2, 'Gestión de Comprobantes...');
        waitFor(function () { return findMenuCard('Comprobantes Informativos'); }, 5000)
          .then(function (el2) {
            saveNav(3);
            clickElement(el2);
            navDone('✔ Abriendo Gestión...');
          })
          .catch(function () { navError('No encontré Gestión de Comprobantes'); });
      }, 200);
      return;
    }

    if (PAGE.id === 'gestion') {
      saveNav(3);
      navStatus(3, 'Obtener Comprobantes...');
      waitFor(function () {
        var cards = document.querySelectorAll('.card-action-green');
        for (var i = 0; i < cards.length; i++) {
          var h4 = cards[i].querySelector('h4');
          if (h4 && h4.textContent.trim() === 'Obtener Comprob. Elect. y Virtuales') return cards[i];
        }
        return null;
      }, 10000)
        .then(function (target) {
          clearNav();
          target.click();
          navDone('✔ Abriendo Comprobantes...');
        })
        .catch(function () { navError('No encontré Obtener Comprobantes'); });
      return;
    }

    if (PAGE.id === 'comprobantes') { clearNav(); showMain(); return; }
    navError('Navegá al menú principal');
  }

  function buildWidget() {
    var w = document.createElement('div');
    w.id = 'mara-widget';
    w.innerHTML =
      '<div class="mara-header">' +
        '<div class="mara-header-left">' +
          '<svg width="14" height="14" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>' +
          '<span class="mara-header-title">Comprobantes</span>' +
        '</div>' +
        '<div class="mara-header-right">' +
          '<button class="mara-config-btn" id="mara-config-btn" title="Configuración">&#9881;</button>' +
          '<button class="mara-close-btn" id="mara-close" title="Cerrar">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="mara-context-bar" id="mara-context-bar"></div>' +
      '<div class="mara-body" id="mara-body"></div>';
    return w;
  }

  function updateContextBar() {
    var bar = document.getElementById('mara-context-bar');
    if (!bar) return;
    bar.innerHTML = '<span class="mara-ctx-dot" style="background:' + PAGE.color + '"></span><span class="mara-ctx-label">' + PAGE.label + '</span>';
  }

  function showNavMenu() {
    updateContextBar();
    var navState = loadNav();
    var recentlyNavigated = navState.active && Date.now() - (navState.ts || 0) < 60000;
    var stepsHtml =
      '<div class="mara-nav-steps">' +
        '<div class="mara-nav-step ' + (PAGE.step >= 1 ? 'done' : '') + '">1. Declaraciones Informativas</div>' +
        '<div class="mara-nav-step ' + (PAGE.step >= 2 ? 'done' : '') + '">2. Gestión de Comprobantes</div>' +
        '<div class="mara-nav-step ' + (PAGE.step >= 3 ? 'done' : '') + '">3. Obtener Comprobantes</div>' +
      '</div>';

    if (recentlyNavigated && PAGE.id === 'main') {
      body().innerHTML =
        '<div class="mara-status success">✔ Ya se navegó</div>' +
        '<div class="mara-nav-info"><span class="mara-nav-icon">&#128073;</span><span>Andá a la pestaña que se abrió</span></div>' +
        stepsHtml +
        '<button class="mara-back-btn" id="mara-force-nav">↻ Navegar de nuevo</button>';
      document.getElementById('mara-force-nav').addEventListener('click', function (e) {
        e.stopPropagation(); clearNav(); navigateToComprobantes(false);
      });
    } else {
      body().innerHTML =
        '<button class="mara-nav-btn" id="mara-go-comprobantes">' +
          '<span class="mara-nav-btn-icon">&#128640;</span>' +
          '<div class="mara-nav-btn-text"><strong>Ir a Comprobantes</strong><small>Navega automáticamente</small></div>' +
        '</button>' +
        stepsHtml;
      document.getElementById('mara-go-comprobantes').addEventListener('click', function (e) {
        e.stopPropagation(); navigateToComprobantes(false);
      });
    }
  }

  function showConfig() {
    updateContextBar();
    body().innerHTML =
      '<p class="mara-step-label">Configuración</p>' +
      '<div class="mara-config-item"><span class="mara-config-label">Bloquear posición</span>' +
        '<button class="mara-toggle ' + (config.locked ? 'active' : '') + '" id="mara-toggle-lock">' + (config.locked ? '&#128274; Bloqueado' : '&#128275; Libre') + '</button></div>' +
      '<div class="mara-config-item"><span class="mara-config-label">Tamaño</span><div class="mara-size-btns">' +
        '<button class="mara-size-btn ' + (config.size === 'small' ? 'active' : '') + '" data-size="small">S</button>' +
        '<button class="mara-size-btn ' + (config.size === 'medium' ? 'active' : '') + '" data-size="medium">M</button>' +
        '<button class="mara-size-btn ' + (config.size === 'large' ? 'active' : '') + '" data-size="large">L</button>' +
      '</div></div>' +
      '<div class="mara-config-item"><span class="mara-config-label">Posición</span><button class="mara-reset-btn" id="mara-reset-pos">&#8634; Reset</button></div>' +
      '<button class="mara-back-btn" id="mara-back">← Volver</button>';

    document.getElementById('mara-toggle-lock').addEventListener('click', function (e) {
      e.stopPropagation(); config.locked = !config.locked; saveConfig(); showConfig();
    });
    document.querySelectorAll('.mara-size-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) { e.stopPropagation(); config.size = btn.dataset.size; saveConfig(); showConfig(); });
    });
    document.getElementById('mara-reset-pos').addEventListener('click', function (e) {
      e.stopPropagation(); localStorage.removeItem('mara_position'); syncPosition();
    });
    document.getElementById('mara-back').addEventListener('click', function (e) {
      e.stopPropagation();
      if (PAGE.id === 'comprobantes') showMain(); else showNavMenu();
    });
  }

  function showMain() {
    updateContextBar();
    var hasYear = state.lastYear !== null && state.lastYear !== undefined;
    var html = '';
    if (hasYear) {
      html += '<button class="mara-year-bar" id="mara-change-year">' +
        '<span class="mara-year-bar-text">Año: <strong>' + state.lastYear + '</strong></span>' +
        '<span class="mara-year-bar-arrow">cambiar ›</span></button>';
    }
    html += '<p class="mara-step-label">Elegí el mes</p><div class="mara-month-grid" id="mara-months"></div>' +
      '<div class="mara-divider"></div>' +
      '<p class="mara-hint">Para bajar XML, marcá los CDC en la columna <b>XML</b> de la tabla («Marcar todas las páginas» y «Crear lote»).</p>';
    body().innerHTML = html;

    var container = document.getElementById('mara-months');
    MONTHS.forEach(function (m) {
      var btn = document.createElement('button');
      btn.className = 'mara-month-btn' + (state.lastMonth === m.value ? ' last-used' : '');
      btn.textContent = m.label;
      btn.addEventListener('click', function (e) {
        e.stopPropagation(); state.lastMonth = m.value; saveState();
        if (hasYear) executeQuick(m.value, state.lastYear); else showYears();
      });
      container.appendChild(btn);
    });
    var cb = document.getElementById('mara-change-year');
    if (cb) cb.addEventListener('click', function (e) { e.stopPropagation(); showYearsChange(); });
  }

  function yearGrid(title, onPick, intro) {
    updateContextBar();
    body().innerHTML = (intro || '') + '<p class="mara-step-label">' + title + '</p><div class="mara-year-grid" id="mara-years"></div>';
    var c = document.getElementById('mara-years');
    YEARS.forEach(function (y) {
      var btn = document.createElement('button');
      btn.className = 'mara-year-item' + (state.lastYear === y ? ' selected' : '');
      btn.textContent = y;
      btn.addEventListener('click', function (e) { e.stopPropagation(); state.lastYear = y; saveState(); onPick(y); });
      c.appendChild(btn);
    });
  }
  function showYears() {
    var m = getMonthObj(state.lastMonth);
    yearGrid('Elegí el año', function (y) { executeFirst(state.lastMonth, y); },
      '<div class="mara-chosen"><span class="mara-chosen-label">Mes:</span><span class="mara-chosen-value">' + m.full + '</span></div>');
  }
  function showYearsChange() { yearGrid('Cambiar año', function () { showMain(); }); }

  function selectPeriod(month, year) {
    var ys = document.querySelector('#periodo > div > div:nth-child(1) > select') || xpathEl('//*[@id="periodo"]/div/div[1]/select');
    if (ys) { ys.value = String(year); triggerChange(ys); }
    var ms = document.querySelector('#periodo > div > div:nth-child(2) > select') || xpathEl('//*[@id="periodo"]/div/div[2]/select');
    if (ms) { ms.value = month; triggerChange(ms); }
    return !!(ys && ms);
  }
  function clickBuscar(m, year) {
    var label = xpathEl('//*[@id="imputaciones"]/div[2]/div[1]/div/div[1]/div[1]/label/span');
    if (label) label.click();
    setTimeout(function () {
      var btn = xpathEl('//*[@id="botones"]/div/div[2]/button');
      if (btn) { btn.click(); showStatusInBody(m.full + ' ' + year + ' ✔', 'success'); setTimeout(closeWidget, 800); }
      else { showStatusInBody('Botón de búsqueda no encontrado', 'error'); setTimeout(showMain, 1500); }
    }, 300);
  }

  function executeFirst(month, year) {
    var m = getMonthObj(month);
    showStatusInBody(m.full + ' ' + year + '...', 'loading');
    try {
      if (!selectPeriod(month, year)) { showStatusInBody('No encontré el período en esta página', 'error'); setTimeout(showMain, 1500); return; }
      setTimeout(function () { clickBuscar(m, year); }, 300);
    } catch (err) { showStatusInBody(err.message, 'error'); setTimeout(showMain, 1500); }
  }

  function executeQuick(month, year) {
    var m = getMonthObj(month);
    showStatusInBody(m.full + ' ' + year + '...', 'loading');
    try {
      // Si ya hay un resultado en pantalla, se vuelve a las opciones de búsqueda.
      var opcionesLink = xpathEl('//*[@id="opciones"]/div/div[1]/div/div[1]/div/a[1]');
      if (opcionesLink) opcionesLink.click();
      setTimeout(function () {
        if (!selectPeriod(month, year)) { showStatusInBody('No encontré el período en esta página', 'error'); setTimeout(showMain, 1500); return; }
        setTimeout(function () { clickBuscar(m, year); }, 300);
      }, 400);
    } catch (err) { showStatusInBody(err.message, 'error'); setTimeout(showMain, 1500); }
  }

  function showStatusInBody(msg, type) {
    body().innerHTML = '<div class="mara-status ' + type + '">' + msg + '</div>';
  }

  function buildToggle() {
    var btn = document.createElement('button');
    btn.id = 'mara-widget-toggle';
    btn.title = config.locked ? 'Comprobantes' : 'Comprobantes (arrastrá para mover)';
    btn.innerHTML = '&#128197;';
    var pos = loadPosition();
    btn.style.left = pos.x + 'px'; btn.style.top = pos.y + 'px';
    var dragging = false, wasDragged = false, ox = 0, oy = 0;
    btn.addEventListener('mousedown', function (e) {
      if (config.locked) return;
      e.stopPropagation(); dragging = true; wasDragged = false;
      ox = e.clientX - btn.getBoundingClientRect().left;
      oy = e.clientY - btn.getBoundingClientRect().top;
      btn.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return; wasDragged = true;
      btn.style.left = Math.max(0, Math.min(e.clientX - ox, window.innerWidth - 44)) + 'px';
      btn.style.top = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - 44)) + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return; dragging = false;
      btn.style.cursor = config.locked ? 'pointer' : 'grab';
      savePosition(parseInt(btn.style.left, 10), parseInt(btn.style.top, 10));
      if (!wasDragged) toggleWidget();
    });
    btn.addEventListener('click', function (e) { if (config.locked) { e.stopPropagation(); toggleWidget(); } });
    return btn;
  }

  function toggleWidget() {
    state.open = !state.open;
    document.getElementById('mara-widget').classList.toggle('mara-open', state.open);
    positionWidget();
    if (state.open) {
      PAGE = detectPage();
      updateContextBar();
      if (PAGE.id === 'comprobantes') showMain(); else showNavMenu();
    }
  }

  function positionWidget() {
    var w = document.getElementById('mara-widget'), t = document.getElementById('mara-widget-toggle');
    if (!w || !t) return;
    var r = t.getBoundingClientRect(), s = SIZES[config.size] || SIZES.medium;
    var top = r.bottom + 4, left = r.right - s.width;
    if (left < 8) left = 8;
    if (left + s.width > window.innerWidth - 8) left = window.innerWidth - s.width - 8;
    if (top + 420 > window.innerHeight - 8) top = r.top - 420 - 4;
    if (top < 8) top = 8;
    w.style.top = top + 'px'; w.style.left = left + 'px';
  }

  function syncPosition() {
    var btn = document.getElementById('mara-widget-toggle'); if (!btn) return;
    var pos = loadPosition(); btn.style.left = pos.x + 'px'; btn.style.top = pos.y + 'px';
  }

  function init() {
    if (!document.body || document.getElementById('mara-widget')) return;
    document.body.appendChild(buildWidget());
    document.body.appendChild(buildToggle());
    applySize();

    document.getElementById('mara-close').addEventListener('click', function (e) { e.stopPropagation(); closeWidget(); });
    document.getElementById('mara-config-btn').addEventListener('click', function (e) { e.stopPropagation(); showConfig(); });

    document.addEventListener('mousedown', function (e) {
      if (!state.open) return;
      var w = document.getElementById('mara-widget'), t = document.getElementById('mara-widget-toggle');
      if (w && t && !w.contains(e.target) && !t.contains(e.target)) closeWidget();
    });

    window.addEventListener('storage', function (e) {
      if (e.key === 'mara_position') syncPosition();
      if (e.key === 'mara_config') { config = loadConfig(); applySize(); }
      if (e.key === 'mara_state') { var p = loadState(); state.lastMonth = p.lastMonth; state.lastYear = p.lastYear; }
      if (e.key === 'mara_nav' && !e.newValue && state.open) closeWidget();
    });

    // Al imprimir, el botón no sale en el papel.
    var st = document.createElement('style');
    st.textContent = '@media print { #mara-widget, #mara-widget-toggle { display: none !important; } }';
    document.head.appendChild(st);

    var lastUrl = window.location.href;
    new MutationObserver(function () {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        PAGE = detectPage();
        updateContextBar();
      }
    }).observe(document.body, { childList: true, subtree: true });

    // Retomar «Ir a Comprobantes» en la ventana que abrió Marangatu (hereda el
    // sessionStorage de la que la abrió, así que comparte TAB_ID).
    var nav = loadNav();
    var navEsDeEstaUrl = nav.url && nav.url === window.location.href;
    if (nav.active && !navEsDeEstaUrl && Date.now() - (nav.ts || 0) < 60000 && nav.tabId === TAB_ID) {
      if (PAGE.id === 'comprobantes') { clearNav(); }
      else if (PAGE.id === 'gestion') { setTimeout(function () { navigateToComprobantes(true); }, 700); }
      else if (PAGE.id !== 'main') {
        setTimeout(function () {
          PAGE = detectPage();
          if (PAGE.id === 'gestion') navigateToComprobantes(true);
          else clearNav();
        }, 1500);
      }
    } else if (nav.active) { clearNav(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
