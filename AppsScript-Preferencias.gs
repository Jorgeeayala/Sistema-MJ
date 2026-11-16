/**
 * MÓDULO PREFERENCIAS - archivo aparte del backend de Control Clientes.
 *
 * Guarda preferencias de cada usuario que lo siguen en cualquier
 * dispositivo. Por ahora: la ambientación por época del año (Navidad,
 * estaciones, etc.) y si se muestra la animación al ingresar.
 *
 * También guarda una preferencia del EQUIPO (igual para todos): quiénes
 * están excluidos de la asignación de clientes (no aparecen para asignar ni
 * entran al reparto automático). La leen todos; sólo ADMINISTRADOR y
 * SUPERUSUARIO la cambian. Vive en Script Properties.
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "Preferencias" y
 *      pegar este contenido completo.
 *   2. No hace falta tocar Code.gs: las acciones preferencias* llegan por
 *      handleAvisosAction (AppsScript-Avisos.gs), que ya está en doPost.
 *   3. Implementar > Administrar implementaciones > editar > Nueva versión.
 *
 * Hoja "Preferencias" en la planilla de administración (se crea sola): una
 * fila por usuario. Usa funciones de Code.gs: getAdminSpreadsheet,
 * canonicalUserName, jsonResponse y errorResponse.
 */

const PREFERENCIAS_SHEET_NAME = 'Preferencias';
const PREFERENCIAS_HEADERS = ['Usuario', 'Ambientación', 'Animación al ingresar', 'Actualizado'];
const PREFERENCIAS_AMBIENTES = [
  'ninguna', 'automatica',
  'navidad', 'anio-nuevo', 'semana-santa', 'independencia', 'san-juan',
  'verano', 'otono', 'invierno', 'primavera'
];
const PREFERENCIAS_DEFAULT = { ambientacion: 'ninguna', animacion: true };

function ensurePreferenciasSheet() {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(PREFERENCIAS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PREFERENCIAS_SHEET_NAME);
    sheet.getRange(1, 1, sheet.getMaxRows(), PREFERENCIAS_HEADERS.length).setNumberFormat('@');
    sheet.getRange(1, 1, 1, PREFERENCIAS_HEADERS.length).setValues([PREFERENCIAS_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function preferenciasLeerFila_(sheet, sessionUser) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const usuario = canonicalUserName(sessionUser);
  const values = sheet.getRange(2, 1, lastRow - 1, PREFERENCIAS_HEADERS.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (canonicalUserName(values[i][0]) === usuario) {
      const ambientacion = String(values[i][1] || '').trim().toLowerCase();
      const animacion = String(values[i][2]).trim().toLowerCase();
      return {
        fila: i + 2,
        ambientacion: PREFERENCIAS_AMBIENTES.indexOf(ambientacion) >= 0 ? ambientacion : PREFERENCIAS_DEFAULT.ambientacion,
        animacion: !(animacion === 'no' || animacion === 'false')
      };
    }
  }
  return null;
}

function handlePreferenciasObtener(sessionUser) {
  const sheet = ensurePreferenciasSheet();
  const fila = preferenciasLeerFila_(sheet, sessionUser);
  return jsonResponse({
    ok: true,
    ambientacion: fila ? fila.ambientacion : PREFERENCIAS_DEFAULT.ambientacion,
    animacion: fila ? fila.animacion : PREFERENCIAS_DEFAULT.animacion
  });
}

// body.ambientacion y/o body.animacion (true/false). Cada usuario sólo
// cambia las suyas.
function handlePreferenciasGuardar(body, sessionUser) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return errorResponse('Las preferencias están ocupadas, intentá de nuevo', 'PREFERENCIAS_LOCK_TIMEOUT');
  }
  try {
    const sheet = ensurePreferenciasSheet();
    const actual = preferenciasLeerFila_(sheet, sessionUser);
    let ambientacion = actual ? actual.ambientacion : PREFERENCIAS_DEFAULT.ambientacion;
    let animacion = actual ? actual.animacion : PREFERENCIAS_DEFAULT.animacion;
    if (body.ambientacion !== undefined) {
      const pedido = String(body.ambientacion || '').trim().toLowerCase();
      if (PREFERENCIAS_AMBIENTES.indexOf(pedido) < 0) {
        return errorResponse('Ambientación no válida', 'PREFERENCIA_AMBIENTACION');
      }
      ambientacion = pedido;
    }
    if (body.animacion !== undefined) animacion = body.animacion === true || body.animacion === 'true';

    const fila = [String(sessionUser), ambientacion, animacion ? 'Sí' : 'No', new Date().toISOString()];
    const destino = sheet.getRange(actual ? actual.fila : sheet.getLastRow() + 1, 1, 1, PREFERENCIAS_HEADERS.length);
    destino.setNumberFormat('@');
    destino.setValues([fila]);
    return jsonResponse({ ok: true, ambientacion: ambientacion, animacion: animacion });
  } finally {
    lock.releaseLock();
  }
}

// ── PREFERENCIAS DEL EQUIPO ─────────────────────────────────────────────
const EQUIPO_EXCLUIDOS_PROPERTY = 'EQUIPO_EXCLUIDOS_ASIGNACION';
const EQUIPO_MAX_EXCLUIDOS = 50;

function equipoLeerExcluidos_() {
  try {
    const lista = JSON.parse(PropertiesService.getScriptProperties().getProperty(EQUIPO_EXCLUIDOS_PROPERTY) || '[]');
    return Array.isArray(lista) ? lista.filter(function (n) { return typeof n === 'string' && n.trim(); }) : [];
  } catch (err) {
    return [];
  }
}

function handlePreferenciasEquipoObtener() {
  return jsonResponse({ ok: true, excluidosAsignacion: equipoLeerExcluidos_() });
}

// body.excluidosAsignacion: lista completa de nombres excluidos.
function handlePreferenciasEquipoGuardar(body, sessionUser, sessionRole) {
  const rol = String(sessionRole || '').toUpperCase();
  if (rol !== 'ADMINISTRADOR' && rol !== 'SUPERUSUARIO') {
    return errorResponse('Sólo un ADMINISTRADOR o SUPERUSUARIO puede excluir personas de la asignación.', 'EQUIPO_SIN_PERMISO');
  }
  if (!Array.isArray(body.excluidosAsignacion) || body.excluidosAsignacion.length > EQUIPO_MAX_EXCLUIDOS) {
    return errorResponse('Lista de excluidos inválida.', 'EQUIPO_LISTA_INVALIDA');
  }
  const vistos = {};
  const lista = [];
  body.excluidosAsignacion.forEach(function (n) {
    const nombre = String(n || '').trim().slice(0, 80);
    const clave = canonicalUserName(nombre);
    if (nombre && !vistos[clave]) {
      vistos[clave] = true;
      lista.push(nombre);
    }
  });
  PropertiesService.getScriptProperties().setProperty(EQUIPO_EXCLUIDOS_PROPERTY, JSON.stringify(lista));
  return jsonResponse({ ok: true, excluidosAsignacion: lista });
}

function handlePreferenciasAction(action, body, sessionUser, sessionRole) {
  const routes = {
    preferenciasObtener: [function () { return handlePreferenciasObtener(sessionUser); }, 'PREFERENCIAS_OBTENER_ERROR'],
    preferenciasGuardar: [function () { return handlePreferenciasGuardar(body, sessionUser); }, 'PREFERENCIAS_GUARDAR_ERROR'],
    preferenciasEquipoObtener: [function () { return handlePreferenciasEquipoObtener(); }, 'EQUIPO_OBTENER_ERROR'],
    preferenciasEquipoGuardar: [function () { return handlePreferenciasEquipoGuardar(body, sessionUser, sessionRole); }, 'EQUIPO_GUARDAR_ERROR']
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route[0]();
  } catch (err) {
    return errorResponse(err.message, route[1]);
  }
}
