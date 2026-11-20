/**
 * MÓDULO LOTES CDC - archivo aparte del backend de Control Clientes.
 *
 * Lotes de CDCs (comprobantes electrónicos) para bajar sus XML. El lote lo
 * crea el recolector de Marangatu en la extensión; la app lo registra acá
 * («Sincronizar desde Marangatu» en Configuración → Lotes CDC) y la pestaña
 * XML / KuDE lo usa para traer los XML.
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "CdcLotes" y pegar
 *      este contenido completo.
 *   2. Pegar también el AppsScript-Avisos.gs nuevo (deriva las acciones cdc*
 *      a este archivo). No hace falta tocar Code.gs.
 *   3. Implementar > Administrar implementaciones > editar > Nueva versión.
 * No pide permisos nuevos de Google: todo se guarda en la planilla de
 * administración (nada en Drive).
 *
 * Hojas (se crean solas en la planilla de administración):
 *   - "CDC Lotes": una fila por lote.
 *   - "CDC Items": una fila por CDC de cada lote. El XML descargado va desde la
 *     columna 8 en trozos de hasta 45.000 caracteres (límite de celda).
 *
 * Acciones (todas con sesión):
 *   cdcCrearLote          { loteLocalId, fuente, cdcs[] }   → { lote }
 *                         Idempotente por loteLocalId: si ya existe, lo devuelve.
 *   cdcListarLotes        → { lotes[] } (más nuevos primero, con avance)
 *   cdcObtenerItems       { loteId } → { items[] }
 *   cdcObtenerXml         { loteId, cdc } → { contenido }
 *   cdcSubirXml           { loteId, cdc, contenido } → marca el CDC descargado
 *   cdcReintentarFallidos { loteId } → lote nuevo En cola con los fallidos
 *   cdcBorrarLote         { loteId } (administrador o quien lo creó)
 *
 * Usa funciones de Code.gs: getAdminSpreadsheet, jsonResponse, errorResponse.
 */

const CDC_LOTES_SHEET = 'CDC Lotes';
const CDC_ITEMS_SHEET = 'CDC Items';
const CDC_LOTES_HEADERS = ['Lote', 'ID local', 'Fuente', 'Total', 'Creado el', 'Creado por', 'Observaciones', 'Reintento de'];
const CDC_ITEMS_HEADERS = ['Lote', 'CDC', 'Estado', 'Intentos', 'Error', 'Actualizado', 'Largo XML'];
const CDC_ITEMS_COL_XML = CDC_ITEMS_HEADERS.length + 1; // 8
const CDC_XML_TROZO = 45000;
const CDC_XML_MAX = 400000;
const CDC_MAX_POR_LOTE = 1000;
const CDC_FUENTES = ['FUENTE_REGISTRO_VIRTUAL', 'FUENTE_CONSULTA_REGISTRADOS'];
const CDC_ESTADOS_ITEM = ['pendiente', 'descargado', 'captcha_fallido', 'error_descarga', 'no_encontrado'];
const CDC_REINTENTABLES = ['captcha_fallido', 'error_descarga'];

function cdcHoja_(nombre, headers) {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(nombre);
  if (!sheet) {
    sheet = ss.insertSheet(nombre);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}
function cdcHojaLotes_() { return cdcHoja_(CDC_LOTES_SHEET, CDC_LOTES_HEADERS); }
function cdcHojaItems_() { return cdcHoja_(CDC_ITEMS_SHEET, CDC_ITEMS_HEADERS); }

function cdcTexto_(v, max) {
  if (v instanceof Date) return v.toISOString();
  return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 200);
}
function cdcLimpio_(v) {
  const c = String(v || '').replace(/\D/g, '');
  return /^\d{44}$/.test(c) ? c : '';
}
function cdcEsAdmin_(rol) {
  return rol === 'SUPERUSUARIO' || rol === 'ADMINISTRADOR';
}

function cdcLeerLotes_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, CDC_LOTES_HEADERS.length).getValues();
  const out = [];
  values.forEach(function (r, i) {
    const loteId = cdcTexto_(r[0], 60);
    if (!loteId) return;
    out.push({
      fila: i + 2, loteId: loteId, loteLocalId: cdcTexto_(r[1], 80), fuente: cdcTexto_(r[2], 40),
      total: Number(r[3]) || 0, creadoEn: cdcTexto_(r[4], 40), creadoPor: cdcTexto_(r[5], 120),
      observaciones: cdcTexto_(r[6], 300), reintentoDe: cdcTexto_(r[7], 60)
    });
  });
  return out;
}

// Índice de ítems (sin leer los XML, que son pesados).
function cdcLeerItems_(sheet, loteId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, CDC_ITEMS_HEADERS.length).getValues();
  const out = [];
  values.forEach(function (r, i) {
    const lote = cdcTexto_(r[0], 60);
    if (!lote || (loteId && lote !== loteId)) return;
    out.push({
      fila: i + 2, loteId: lote, cdc: cdcTexto_(r[1], 44), estado: cdcTexto_(r[2], 30) || 'pendiente',
      intentos: Number(r[3]) || 0, error: cdcTexto_(r[4], 300), actualizado: cdcTexto_(r[5], 40),
      tieneXml: (Number(r[6]) || 0) > 0
    });
  });
  return out;
}

// Estado y avance del lote a partir de sus ítems.
function cdcResumen_(lote, items) {
  let descargados = 0, pendientes = 0, conError = 0, reintentables = 0;
  items.forEach(function (it) {
    if (it.estado === 'descargado') descargados++;
    else if (it.estado === 'pendiente') pendientes++;
    else {
      conError++;
      if (CDC_REINTENTABLES.indexOf(it.estado) !== -1) reintentables++;
    }
  });
  const totalItems = items.length;
  let estado = 'en_cola';
  if (totalItems > 0 && pendientes === 0) estado = conError ? 'completado_con_errores' : 'completado';
  return {
    loteId: lote.loteId, loteLocalId: lote.loteLocalId, fuente: lote.fuente, estado: estado,
    total: lote.total || totalItems, totalItems: totalItems, descargados: descargados,
    pendientes: pendientes, conError: conError, reintentables: reintentables,
    creadoEn: lote.creadoEn, creadoPor: lote.creadoPor, observaciones: lote.observaciones,
    reintentoDe: lote.reintentoDe
  };
}

function cdcNuevoId_() {
  const tz = Session.getScriptTimeZone() || 'America/Asuncion';
  const sello = Utilities.formatDate(new Date(), tz, 'yyyyMMdd-HHmmss');
  return 'L' + sello + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
}

function cdcAgregarLote_(lotesSheet, itemsSheet, datos, cdcs, sessionUser) {
  const loteId = cdcNuevoId_();
  const ahora = new Date().toISOString();
  lotesSheet.appendRow([
    loteId, datos.loteLocalId || '', datos.fuente, cdcs.length, ahora,
    cdcTexto_(sessionUser, 120), datos.observaciones || '', datos.reintentoDe || ''
  ]);
  const filas = cdcs.map(function (c) { return [loteId, "'" + c, 'pendiente', 0, '', ahora, 0]; });
  if (filas.length) {
    itemsSheet.getRange(itemsSheet.getLastRow() + 1, 1, filas.length, CDC_ITEMS_HEADERS.length).setValues(filas);
  }
  return {
    loteId: loteId, loteLocalId: datos.loteLocalId || '', fuente: datos.fuente, total: cdcs.length,
    creadoEn: ahora, creadoPor: cdcTexto_(sessionUser, 120), observaciones: datos.observaciones || '',
    reintentoDe: datos.reintentoDe || ''
  };
}

function cdcConLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return errorResponse('Los lotes están ocupados, intentá de nuevo', 'CDC_LOCK_TIMEOUT');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ── Acciones ────────────────────────────────────────────────────────────
function handleCdcCrearLote(body, sessionUser) {
  const loteLocalId = cdcTexto_(body.loteLocalId, 80);
  const fuente = cdcTexto_(body.fuente, 40);
  if (!loteLocalId) return errorResponse('Falta el identificador del lote', 'CDC_DATOS');
  if (CDC_FUENTES.indexOf(fuente) === -1) return errorResponse('Fuente del lote no válida', 'CDC_DATOS');
  if (!Array.isArray(body.cdcs)) return errorResponse('El lote no trae CDCs', 'CDC_DATOS');
  const vistos = {};
  const cdcs = [];
  for (let i = 0; i < body.cdcs.length; i++) {
    const c = cdcLimpio_(body.cdcs[i]);
    if (!c) return errorResponse('Hay un CDC que no tiene 44 dígitos', 'CDC_INVALIDO');
    if (!vistos[c]) { vistos[c] = true; cdcs.push(c); }
  }
  if (!cdcs.length || cdcs.length > CDC_MAX_POR_LOTE) return errorResponse('El lote debe tener entre 1 y ' + CDC_MAX_POR_LOTE + ' CDCs', 'CDC_DATOS');

  return cdcConLock_(function () {
    const lotesSheet = cdcHojaLotes_();
    const itemsSheet = cdcHojaItems_();
    const existente = cdcLeerLotes_(lotesSheet).find(function (l) { return l.loteLocalId === loteLocalId; });
    if (existente) {
      return jsonResponse({ ok: true, duplicado: true, lote: cdcResumen_(existente, cdcLeerItems_(itemsSheet, existente.loteId)) });
    }
    const lote = cdcAgregarLote_(lotesSheet, itemsSheet, { loteLocalId: loteLocalId, fuente: fuente }, cdcs, sessionUser);
    return jsonResponse({ ok: true, lote: cdcResumen_(lote, cdcLeerItems_(itemsSheet, lote.loteId)) });
  });
}

function handleCdcListarLotes() {
  const lotes = cdcLeerLotes_(cdcHojaLotes_());
  const items = cdcLeerItems_(cdcHojaItems_(), '');
  const porLote = {};
  items.forEach(function (it) { (porLote[it.loteId] = porLote[it.loteId] || []).push(it); });
  const lista = lotes.map(function (l) { return cdcResumen_(l, porLote[l.loteId] || []); });
  lista.sort(function (a, b) { return String(b.creadoEn).localeCompare(String(a.creadoEn)); });
  return jsonResponse({ ok: true, lotes: lista });
}

function handleCdcObtenerItems(body) {
  const loteId = cdcTexto_(body.loteId, 60);
  if (!loteId) return errorResponse('Falta el lote', 'CDC_DATOS');
  const items = cdcLeerItems_(cdcHojaItems_(), loteId).map(function (it) {
    return { cdc: it.cdc, estado: it.estado, intentos: it.intentos, error: it.error, tieneXml: it.tieneXml, actualizado: it.actualizado };
  });
  return jsonResponse({ ok: true, items: items });
}

function handleCdcObtenerXml(body) {
  const loteId = cdcTexto_(body.loteId, 60);
  const cdc = cdcLimpio_(body.cdc);
  if (!loteId || !cdc) return errorResponse('Lote o CDC no válido', 'CDC_DATOS');
  const sheet = cdcHojaItems_();
  const it = cdcLeerItems_(sheet, loteId).find(function (x) { return x.cdc === cdc; });
  if (!it) return errorResponse('Ese CDC no está en el lote', 'CDC_NO_ENCONTRADO');
  if (!it.tieneXml) return jsonResponse({ ok: true, contenido: '' });
  const lastCol = sheet.getLastColumn();
  if (lastCol < CDC_ITEMS_COL_XML) return jsonResponse({ ok: true, contenido: '' });
  const trozos = sheet.getRange(it.fila, CDC_ITEMS_COL_XML, 1, lastCol - CDC_ITEMS_COL_XML + 1).getValues()[0];
  return jsonResponse({ ok: true, contenido: trozos.map(function (t) { return String(t || ''); }).join('') });
}

function handleCdcSubirXml(body) {
  const loteId = cdcTexto_(body.loteId, 60);
  const cdc = cdcLimpio_(body.cdc);
  const contenido = String(body.contenido || '');
  if (!loteId || !cdc) return errorResponse('Lote o CDC no válido', 'CDC_DATOS');
  if (!contenido || contenido.length > CDC_XML_MAX) return errorResponse('El XML está vacío o es demasiado grande', 'CDC_XML_INVALIDO');
  if (contenido.indexOf(cdc) === -1) return errorResponse('El XML no corresponde a ese CDC', 'CDC_XML_INVALIDO');

  return cdcConLock_(function () {
    const sheet = cdcHojaItems_();
    const it = cdcLeerItems_(sheet, loteId).find(function (x) { return x.cdc === cdc; });
    if (!it) return errorResponse('Ese CDC no está en el lote', 'CDC_NO_ENCONTRADO');
    const trozos = [];
    for (let i = 0; i < contenido.length; i += CDC_XML_TROZO) trozos.push(contenido.slice(i, i + CDC_XML_TROZO));
    // Limpia trozos de un XML anterior más largo.
    const lastCol = sheet.getLastColumn();
    if (lastCol >= CDC_ITEMS_COL_XML) sheet.getRange(it.fila, CDC_ITEMS_COL_XML, 1, lastCol - CDC_ITEMS_COL_XML + 1).clearContent();
    sheet.getRange(it.fila, CDC_ITEMS_COL_XML, 1, trozos.length).setValues([trozos]);
    sheet.getRange(it.fila, 3, 1, 5).setValues([['descargado', it.intentos + 1, '', new Date().toISOString(), contenido.length]]);
    return jsonResponse({ ok: true, cdc: cdc, estado: 'descargado' });
  });
}

function handleCdcReintentarFallidos(body, sessionUser) {
  const loteId = cdcTexto_(body.loteId, 60);
  if (!loteId) return errorResponse('Falta el lote', 'CDC_DATOS');
  return cdcConLock_(function () {
    const lotesSheet = cdcHojaLotes_();
    const itemsSheet = cdcHojaItems_();
    const lotes = cdcLeerLotes_(lotesSheet);
    const origen = lotes.find(function (l) { return l.loteId === loteId; });
    if (!origen) return errorResponse('No existe ese lote', 'CDC_NO_ENCONTRADO');
    const todos = cdcLeerItems_(itemsSheet, '');
    // Si ya hay un reintento de este lote con CDCs pendientes, no se crea otro.
    const activo = lotes.find(function (l) {
      if (l.reintentoDe !== loteId) return false;
      return todos.some(function (it) { return it.loteId === l.loteId && it.estado === 'pendiente'; });
    });
    if (activo) {
      return jsonResponse({ ok: true, duplicado: true, lote: cdcResumen_(activo, todos.filter(function (it) { return it.loteId === activo.loteId; })) });
    }
    const fallidos = todos.filter(function (it) {
      return it.loteId === loteId && CDC_REINTENTABLES.indexOf(it.estado) !== -1;
    }).map(function (it) { return it.cdc; });
    if (!fallidos.length) return jsonResponse({ ok: true, lote: null, reintentados: 0 });
    const lote = cdcAgregarLote_(lotesSheet, itemsSheet, {
      fuente: origen.fuente, reintentoDe: loteId, observaciones: 'Reintento de ' + loteId
    }, fallidos, sessionUser);
    return jsonResponse({ ok: true, lote: cdcResumen_(lote, cdcLeerItems_(itemsSheet, lote.loteId)), reintentados: fallidos.length });
  });
}

function handleCdcBorrarLote(body, sessionUser, sessionRole) {
  const loteId = cdcTexto_(body.loteId, 60);
  if (!loteId) return errorResponse('Falta el lote', 'CDC_DATOS');
  return cdcConLock_(function () {
    const lotesSheet = cdcHojaLotes_();
    const lote = cdcLeerLotes_(lotesSheet).find(function (l) { return l.loteId === loteId; });
    if (!lote) return jsonResponse({ ok: true, borrado: false });
    if (!cdcEsAdmin_(sessionRole) && lote.creadoPor !== cdcTexto_(sessionUser, 120)) {
      return errorResponse('Sólo un administrador o quien creó el lote puede borrarlo', 'CDC_SIN_PERMISO');
    }
    const itemsSheet = cdcHojaItems_();
    // De abajo hacia arriba para que no se corran las filas.
    const filas = cdcLeerItems_(itemsSheet, loteId).map(function (it) { return it.fila; }).sort(function (a, b) { return b - a; });
    filas.forEach(function (f) { itemsSheet.deleteRow(f); });
    lotesSheet.deleteRow(lote.fila);
    return jsonResponse({ ok: true, borrado: true, items: filas.length });
  });
}

function handleCdcAction(action, body, sessionUser, sessionRole) {
  const routes = {
    cdcCrearLote: [function () { return handleCdcCrearLote(body, sessionUser); }, 'CDC_CREAR_ERROR'],
    cdcListarLotes: [function () { return handleCdcListarLotes(); }, 'CDC_LISTAR_ERROR'],
    cdcObtenerItems: [function () { return handleCdcObtenerItems(body); }, 'CDC_ITEMS_ERROR'],
    cdcObtenerXml: [function () { return handleCdcObtenerXml(body); }, 'CDC_XML_ERROR'],
    cdcSubirXml: [function () { return handleCdcSubirXml(body); }, 'CDC_SUBIR_ERROR'],
    cdcReintentarFallidos: [function () { return handleCdcReintentarFallidos(body, sessionUser); }, 'CDC_REINTENTO_ERROR'],
    cdcBorrarLote: [function () { return handleCdcBorrarLote(body, sessionUser, sessionRole); }, 'CDC_BORRAR_ERROR']
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route[0]();
  } catch (err) {
    return errorResponse(err.message, route[1]);
  }
}
