// BACKEND DE PRUEBAS — archivo generado por pruebas/generar-backend.mjs.
// No editar acá: cambiar los AppsScript-*.gs y volver a generar.
// Pegar TODO este contenido en el único archivo (Código.gs) del proyecto
// de Apps Script de pruebas. Primera vez: ejecutar instalarEntornoPruebas().

// ===== AppsScript-Code-auth-PROPUESTA.gs =====
/**
 * BACKEND - Control Remoto de Google Sheets
 *
 * IMPORTANTE:
 * - Reemplazá ADMIN_SPREADSHEET_ID por el ID que ya usa tu implementación.
 * - API_TOKEN, PIN_PEPPER, ALLOW_PINLESS_LOGIN y ALLOW_SELF_PIN_SETUP viven
 *   en Script Properties.
 * - Durante el alta inicial, ALLOW_SELF_PIN_SETUP=true permite que una cuenta
 *   con PIN_HASH vacío reclame su primer PIN. Es una excepción reversible con
 *   riesgo de usurpación aceptado: debe desactivarse al terminar el alta.
 * - ALLOW_PINLESS_LOGIN=true queda sólo para pruebas sin autoalta. Antes de
 *   producción ambas excepciones deben estar en false y todos deben tener PIN.
 */

// ── CONFIG ──────────────────────────────────────────────────────────────
const ADMIN_SPREADSHEET_ID = 'REEMPLAZAR_POR_TU_ID_ACTUAL';

const USERS_SHEET_NAME = 'Usuarios';
const HISTORIAL_SHEET_NAME = 'Historial';
const PLANILLAS_SHEET_NAME = 'Planillas';

const PIN_HASH_COLUMN = 3;
const PIN_HASH_HEADER = 'PIN_HASH';
const USER_STATUS_COLUMN = 4;
const USER_STATUS_HEADER = 'ESTADO';

const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
const MAX_PIN_ATTEMPTS = 5;
const PIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const PIN_LOCK_MS = 15 * 60 * 1000;

const SESSION_PROPERTY_PREFIX = 'AUTH_SESSION_';
const ATTEMPT_PROPERTY_PREFIX = 'AUTH_ATTEMPT_';

function getAdminSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('ADMIN_SPREADSHEET_ID');
  if (!id) throw new Error('Entorno de pruebas sin instalar: ejecutá instalarEntornoPruebas().');
  return SpreadsheetApp.openById(id);
}

// ── HOJA "PLANILLAS" (mapea año -> ID de planilla de ese año) ───────────
function ensurePlanillasSheet() {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(PLANILLAS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PLANILLAS_SHEET_NAME);
    sheet.getRange(1, 1, 1, 3).setValues([['Año', 'ID Planilla', 'Nombre']]);
    sheet.getRange(2, 1, 1, 3).setValues([
      ['2026', 'PEGA_ACA_EL_ID_DE_LA_PLANILLA_2026', 'Clientes 2026']
    ]);
  }
  return sheet;
}

function getYearMappings() {
  const sheet = ensurePlanillasSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  return values
    .filter(function (r) { return String(r[0]).trim().length > 0; })
    .map(function (r) {
      return {
        anio: String(r[0]).trim(),
        id: String(r[1]).trim()
      };
    });
}

function getAvailableYears() {
  return getYearMappings().map(function (m) { return m.anio; });
}

function getClientSpreadsheet(year) {
  const normalizedYear = String(year || '').trim();
  const mapping = getYearMappings().find(function (m) {
    return m.anio === normalizedYear;
  });

  if (!mapping || !mapping.id) return null;
  try {
    return SpreadsheetApp.openById(mapping.id);
  } catch (err) {
    return null;
  }
}

// ── MESES DENTRO DE UN AÑO ──────────────────────────────────────────────
function getAvailableSheets(year) {
  const ss = getClientSpreadsheet(year);
  if (!ss) return [];
  return ss.getSheets().map(function (s) { return s.getName(); });
}

function getMonthSheet(year, sheetName) {
  const ss = getClientSpreadsheet(year);
  if (!ss || !sheetName) return null;
  if (getAvailableSheets(year).indexOf(sheetName) === -1) return null;
  return ss.getSheetByName(sheetName);
}

// ── HOJA DE USUARIOS ────────────────────────────────────────────────────
function ensureUsersSheet() {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(USERS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET_NAME);
    sheet.getRange(1, 1, 1, 3).setValues([['Nombre', 'Rol', PIN_HASH_HEADER]]);
    sheet.getRange(2, 1, 2, 3).setValues([
      ['Ejemplo Persona 1', 'usuario', ''],
      ['Ejemplo Persona 2', 'admin', '']
    ]);
    return sheet;
  }

  const currentPinHeader = String(sheet.getRange(1, PIN_HASH_COLUMN).getValue() || '').trim();
  if (!currentPinHeader) {
    sheet.getRange(1, PIN_HASH_COLUMN).setValue(PIN_HASH_HEADER);
  } else if (normalizeKey(currentPinHeader) !== normalizeKey(PIN_HASH_HEADER)) {
    throw new Error(
      'La columna C de Usuarios debe llamarse "' + PIN_HASH_HEADER +
      '"; actualmente contiene "' + currentPinHeader + '"'
    );
  }

  return sheet;
}

function isActiveUserStatus(value) {
  const compact = normalizeKey(value);
  if (!compact) return true;
  return (
    compact !== 'inactivo' &&
    compact !== 'inactiva' &&
    compact !== 'baja' &&
    compact !== 'desactivado' &&
    compact !== 'desactivada' &&
    compact !== 'suspendido' &&
    compact !== 'suspendida' &&
    compact !== 'no' &&
    compact !== 'false' &&
    compact !== '0'
  );
}

function isTemporaryPinHash(pinHash) {
  return String(pinHash || '').trim().indexOf('v1-temp:') === 0;
}

function getAllUsers() {
  const sheet = ensureUsersSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, USER_STATUS_COLUMN).getValues();
  return values
    .map(function (r, idx) {
      const pinHash = String(r[2] || '').trim();
      return {
        row: idx + 2,
        nombre: String(r[0] || '').trim(),
        rol: normalizeRole(r[1]),
        pinHash: pinHash,
        activo: isActiveUserStatus(r[3]),
        mustChangePin: isTemporaryPinHash(pinHash)
      };
    })
    .filter(function (u) { return u.nombre.length > 0; });
}

function getAllowedUsers() {
  return getAllUsers().filter(function (u) { return u.activo; });
}

function findAnyUser(userName) {
  const wanted = canonicalUserName(userName);
  if (!wanted) return null;
  return getAllUsers().find(function (u) {
    return canonicalUserName(u.nombre) === wanted;
  }) || null;
}

function findAllowedUser(userName) {
  const wanted = canonicalUserName(userName);
  if (!wanted) return null;
  return getAllowedUsers().find(function (u) {
    return canonicalUserName(u.nombre) === wanted;
  }) || null;
}

function normalizeRole(value) {
  const compact = normalizeKey(value);

  if (
    compact === 'superusuario' ||
    compact === 'superusuaria' ||
    compact === 'superadmin' ||
    compact === 'superadministrador' ||
    compact === 'superadministradora'
  ) {
    return 'SUPERUSUARIO';
  }

  if (
    compact === 'admin' ||
    compact === 'administrador' ||
    compact === 'administradora'
  ) {
    return 'ADMINISTRADOR';
  }

  return 'USUARIO';
}

function isPrivilegedRole(role) {
  const normalized = normalizeRole(role);
  return normalized === 'ADMINISTRADOR' || normalized === 'SUPERUSUARIO';
}

function isAdmin(userName) {
  const user = findAllowedUser(userName);
  return !!user && isPrivilegedRole(user.rol);
}

function canonicalUserName(value) {
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function normalizeText(value) {
  let result = String(value || '').trim().toLowerCase();
  if (typeof result.normalize === 'function') {
    result = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  return result;
}

function normalizeKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, '');
}

// ── HOJA DE HISTORIAL ───────────────────────────────────────────────────
function ensureHistorialSheet() {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(HISTORIAL_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(HISTORIAL_SHEET_NAME);
    sheet.getRange(1, 1, 1, 8).setValues([[
      'Fecha', 'Usuario', 'Año', 'Mes', 'Fila', 'Columna',
      'Valor anterior', 'Valor nuevo'
    ]]);
  }
  return sheet;
}

function logChange(user, year, monthSheetName, row, column, oldValue, newValue) {
  const sheet = ensureHistorialSheet();
  sheet.appendRow([
    new Date(), user, year, monthSheetName, row, column, oldValue, newValue
  ]);
}

// ── CELDAS COMBINADAS ───────────────────────────────────────────────────
function fillMergedValues(range) {
  const values = range.getValues();
  const merges = range.getMergedRanges();
  const rangeStartRow = range.getRow();
  const rangeStartCol = range.getColumn();

  merges.forEach(function (merge) {
    const topRow = merge.getRow();
    const topCol = merge.getColumn();
    const numRows = merge.getNumRows();
    const numCols = merge.getNumColumns();

    const topRowIdx = topRow - rangeStartRow;
    const topColIdx = topCol - rangeStartCol;
    if (topRowIdx < 0 || topColIdx < 0 || !values[topRowIdx]) return;

    const topValue = values[topRowIdx][topColIdx];

    for (let r = 0; r < numRows; r++) {
      const rowIdx = topRowIdx + r;
      if (rowIdx < 0 || rowIdx >= values.length || !values[rowIdx]) continue;
      for (let c = 0; c < numCols; c++) {
        const colIdx = topColIdx + c;
        if (colIdx < 0 || colIdx >= values[rowIdx].length) continue;
        values[rowIdx][colIdx] = topValue;
      }
    }
  });

  return values;
}

// ── TOKEN GENERAL DE LA API ─────────────────────────────────────────────
function isAuthorized(token) {
  const validToken = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!validToken) return false;
  return constantTimeEquals(String(token || ''), validToken);
}

function unauthorizedResponse() {
  return errorResponse('No autorizado', 'API_TOKEN_INVALID');
}

// ── CONFIGURACIÓN DE AUTENTICACIÓN ──────────────────────────────────────
// Ejecutar UNA vez durante testing. Crea PIN_PEPPER sin mostrarlo y habilita
// temporalmente el acceso de usuarios cuya columna PIN_HASH esté vacía.
function configurarAutenticacionParaPruebas() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PIN_PEPPER')) {
    props.setProperty('PIN_PEPPER', createRandomToken());
  }
  props.setProperty('ALLOW_PINLESS_LOGIN', 'true');
  ensureUsersSheet();
  Logger.log('Autenticación de pruebas configurada. ALLOW_PINLESS_LOGIN=true');
}

// Abre temporalmente el alta directa del primer PIN y desactiva el bypass
// pinless. También revoca sus sesiones anteriores: una cuenta vacía debe
// configurar su PIN antes de poder leer datos. La primera persona que reclame
// el nombre quedará como dueña.
function habilitarConfiguracionInicialPin() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PIN_PEPPER')) {
    props.setProperty('PIN_PEPPER', createRandomToken());
  }
  props.setProperty('ALLOW_SELF_PIN_SETUP', 'true');
  props.setProperty('ALLOW_PINLESS_LOGIN', 'false');
  ensureUsersSheet();
  revokePinlessSessions();
  Logger.log('Configuración inicial de PIN habilitada y acceso pinless desactivado.');
}

// Cierra únicamente el alta directa. Los usuarios que ya tienen PIN conservan
// su acceso; las cuentas vacías deberán ser configuradas por el administrador.
function desactivarConfiguracionInicialPin() {
  PropertiesService
    .getScriptProperties()
    .setProperty('ALLOW_SELF_PIN_SETUP', 'false');
  Logger.log('Configuración inicial de PIN desactivada.');
}

// Ejecutar antes de producción, después de configurar PIN para todos. Cierra
// ambas excepciones temporales y revoca las sesiones creadas sin PIN.
function desactivarAccesoSinPin() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('ALLOW_PINLESS_LOGIN', 'false');
  props.setProperty('ALLOW_SELF_PIN_SETUP', 'false');
  revokePinlessSessions();
  Logger.log('Acceso sin PIN y configuración inicial directa desactivados.');
}

function isPinlessLoginAllowed() {
  const value = PropertiesService
    .getScriptProperties()
    .getProperty('ALLOW_PINLESS_LOGIN');
  return String(value || '').toLowerCase() === 'true';
}

function isSelfPinSetupAllowed() {
  const value = PropertiesService
    .getScriptProperties()
    .getProperty('ALLOW_SELF_PIN_SETUP');
  return String(value || '').toLowerCase() === 'true';
}

function requirePinPepper() {
  const pepper = PropertiesService.getScriptProperties().getProperty('PIN_PEPPER');
  if (!pepper) {
    throw new Error(
      'Falta PIN_PEPPER en Script Properties. Ejecutá configurarAutenticacionParaPruebas().'
    );
  }
  return pepper;
}

// Para asignar/restablecer un PIN sin escribirlo en el código:
// 1. En Script Properties crear PIN_SETUP_USER y PIN_SETUP_VALUE.
// 2. Ejecutar esta función.
// 3. Ambas propiedades temporales se eliminan incluso si ocurre un error.
function aplicarPinPendienteDesdeProperties() {
  const props = PropertiesService.getScriptProperties();
  const userName = String(props.getProperty('PIN_SETUP_USER') || '').trim();
  const pin = String(props.getProperty('PIN_SETUP_VALUE') || '').trim();

  try {
    if (!userName) throw new Error('Falta PIN_SETUP_USER en Script Properties');
    if (!/^\d{4}$/.test(pin)) {
      throw new Error('PIN_SETUP_VALUE debe contener exactamente 4 dígitos');
    }
    setUserPinHash(userName, pin);
    Logger.log('PIN configurado para el usuario indicado y sesiones anteriores revocadas.');
  } finally {
    props.deleteProperty('PIN_SETUP_USER');
    props.deleteProperty('PIN_SETUP_VALUE');
  }
}

function setUserPinHash(userName, pin, isTemp) {
  const user = findAnyUser(userName);
  if (!user) throw new Error('Usuario no encontrado: ' + userName);
  if (!/^\d{4}$/.test(String(pin || ''))) {
    throw new Error('El PIN debe contener exactamente 4 dígitos');
  }

  const sheet = ensureUsersSheet();
  const targetRow = user.row;
  if (targetRow < 2) throw new Error('No se encontró la fila del usuario');
  sheet
    .getRange(targetRow, PIN_HASH_COLUMN)
    .setValue(computePinHash(user.nombre, pin, Boolean(isTemp)));
  revokeSessionsForUser(user.nombre);
}

function setUserActiveStatus(userName, active) {
  const user = findAnyUser(userName);
  if (!user) throw new Error('Usuario no encontrado: ' + userName);

  const sheet = ensureUsersSheet();
  const currentStatusHeader = String(sheet.getRange(1, USER_STATUS_COLUMN).getValue() || '').trim();
  if (!currentStatusHeader) {
    sheet.getRange(1, USER_STATUS_COLUMN).setValue(USER_STATUS_HEADER);
  }
  sheet
    .getRange(user.row, USER_STATUS_COLUMN)
    .setValue(active ? 'ACTIVO' : 'INACTIVO');
  revokeSessionsForUser(user.nombre);
}

// ── PIN Y LÍMITE DE INTENTOS ────────────────────────────────────────────
function computePinHash(userName, pin, isTemp) {
  const signature = Utilities.computeHmacSha256Signature(
    canonicalUserName(userName) + '\n' + String(pin),
    requirePinPepper(),
    Utilities.Charset.UTF_8
  );
  return (isTemp ? 'v1-temp:' : 'v1:') + base64Url(signature);
}

function verifyUserPin(user, pin) {
  if (!user || !user.pinHash || !/^\d{4}$/.test(String(pin || ''))) return false;
  const expected = computePinHash(user.nombre, pin, Boolean(user.mustChangePin));
  return constantTimeEquals(expected, user.pinHash);
}

function constantTimeEquals(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i++) {
    difference |= (a.charCodeAt(i % Math.max(a.length, 1)) || 0) ^
      (b.charCodeAt(i % Math.max(b.length, 1)) || 0);
  }
  return difference === 0;
}

function getAttemptPropertyKey(userName) {
  return ATTEMPT_PROPERTY_PREFIX + sha256(canonicalUserName(userName));
}

function readAttemptState(userName, now) {
  const props = PropertiesService.getScriptProperties();
  const key = getAttemptPropertyKey(userName);
  const raw = props.getProperty(key);
  if (!raw) return { count: 0, firstFailedAt: 0, lockedUntil: 0 };

  try {
    const state = JSON.parse(raw);
    if (Number(state.lockedUntil || 0) > now) return state;

    if (
      Number(state.lockedUntil || 0) > 0 ||
      !Number(state.firstFailedAt || 0) ||
      now - Number(state.firstFailedAt) > PIN_ATTEMPT_WINDOW_MS
    ) {
      props.deleteProperty(key);
      return { count: 0, firstFailedAt: 0, lockedUntil: 0 };
    }

    return state;
  } catch (err) {
    props.deleteProperty(key);
    return { count: 0, firstFailedAt: 0, lockedUntil: 0 };
  }
}

function registerFailedPin(userName) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error('No se pudo validar el intento. Probá nuevamente.');
  }

  try {
    const now = Date.now();
    const props = PropertiesService.getScriptProperties();
    const key = getAttemptPropertyKey(userName);
    const state = readAttemptState(userName, now);

    if (Number(state.lockedUntil || 0) > now) {
      return {
        locked: true,
        lockedUntil: Number(state.lockedUntil),
        attemptsRemaining: 0
      };
    }

    const count = Number(state.count || 0) + 1;
    const firstFailedAt = Number(state.firstFailedAt || 0) || now;

    if (count >= MAX_PIN_ATTEMPTS) {
      const lockedUntil = now + PIN_LOCK_MS;
      props.setProperty(key, JSON.stringify({
        count: count,
        firstFailedAt: firstFailedAt,
        lockedUntil: lockedUntil
      }));
      return { locked: true, lockedUntil: lockedUntil, attemptsRemaining: 0 };
    }

    props.setProperty(key, JSON.stringify({
      count: count,
      firstFailedAt: firstFailedAt,
      lockedUntil: 0
    }));

    return {
      locked: false,
      lockedUntil: 0,
      attemptsRemaining: MAX_PIN_ATTEMPTS - count
    };
  } finally {
    lock.releaseLock();
  }
}

function clearFailedPins(userName) {
  PropertiesService
    .getScriptProperties()
    .deleteProperty(getAttemptPropertyKey(userName));
}

// ── SESIONES ────────────────────────────────────────────────────────────
function createRandomToken() {
  return [
    Utilities.getUuid(),
    Utilities.getUuid(),
    Utilities.getUuid()
  ].join('').replace(/-/g, '');
}

function sha256(value) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value || ''),
    Utilities.Charset.UTF_8
  );
  return base64Url(digest);
}

function base64Url(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function getSessionPropertyKey(sessionToken) {
  return SESSION_PROPERTY_PREFIX + sha256(sessionToken);
}

function getPinVersion(pinHash) {
  return sha256(String(pinHash || ''));
}

function cleanupExpiredSessions() {
  const now = Date.now();
  const pinlessAllowed = isPinlessLoginAllowed();
  const selfPinSetupAllowed = isSelfPinSetupAllowed();
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  Object.keys(all).forEach(function (key) {
    if (key.indexOf(SESSION_PROPERTY_PREFIX) !== 0) return;
    try {
      const session = JSON.parse(all[key]);
      const expired =
        now >= Number(session.expiresAt || 0) ||
        now - Number(session.lastActivityAt || 0) >= SESSION_IDLE_MS;
      if (
        expired ||
        (session.pinless && (!pinlessAllowed || selfPinSetupAllowed))
      ) {
        props.deleteProperty(key);
      }
    } catch (err) {
      props.deleteProperty(key);
    }
  });
}

function issueSession(user, pinless) {
  cleanupExpiredSessions();

  const now = Date.now();
  const token = createRandomToken();
  const session = {
    user: user.nombre,
    role: normalizeRole(user.rol),
    pinless: !!pinless,
    mustChangePin: !!user.mustChangePin,
    pinVersion: getPinVersion(user.pinHash),
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + SESSION_MAX_AGE_MS
  };

  PropertiesService
    .getScriptProperties()
    .setProperty(getSessionPropertyKey(token), JSON.stringify(session));

  return {
    token: token,
    session: session
  };
}

function validateSession(sessionToken, touch) {
  const token = String(sessionToken || '');
  if (!token || token.length > 512) {
    return { ok: false, code: 'SESSION_REQUIRED', error: 'Sesión requerida' };
  }

  const props = PropertiesService.getScriptProperties();
  const key = getSessionPropertyKey(token);
  const raw = props.getProperty(key);
  if (!raw) {
    return { ok: false, code: 'SESSION_EXPIRED', error: 'La sesión expiró' };
  }

  let session;
  try {
    session = JSON.parse(raw);
  } catch (err) {
    props.deleteProperty(key);
    return { ok: false, code: 'SESSION_EXPIRED', error: 'La sesión expiró' };
  }

  const now = Date.now();
  if (
    now >= Number(session.expiresAt || 0) ||
    now - Number(session.lastActivityAt || 0) >= SESSION_IDLE_MS
  ) {
    props.deleteProperty(key);
    return { ok: false, code: 'SESSION_EXPIRED', error: 'La sesión expiró' };
  }

  if (session.pinless && isSelfPinSetupAllowed()) {
    props.deleteProperty(key);
    return {
      ok: false,
      code: 'PIN_SETUP_REQUIRED',
      error: 'Configurá tu PIN para volver a ingresar'
    };
  }

  if (session.pinless && !isPinlessLoginAllowed()) {
    props.deleteProperty(key);
    return {
      ok: false,
      code: 'PIN_REQUIRED',
      error: 'El acceso sin PIN fue desactivado'
    };
  }

  const currentUser = findAllowedUser(session.user);
  if (!currentUser) {
    props.deleteProperty(key);
    return {
      ok: false,
      code: 'SESSION_REVOKED',
      error: 'El usuario ya no está autorizado'
    };
  }

  if (getPinVersion(currentUser.pinHash) !== String(session.pinVersion || '')) {
    props.deleteProperty(key);
    return {
      ok: false,
      code: 'SESSION_REVOKED',
      error: 'El PIN cambió; ingresá nuevamente'
    };
  }

  const currentRole = normalizeRole(currentUser.rol);
  let changed = currentRole !== session.role;
  session.role = currentRole;

  if (touch && now - Number(session.lastActivityAt || 0) >= SESSION_TOUCH_INTERVAL_MS) {
    session.lastActivityAt = now;
    changed = true;
  }

  if (changed) props.setProperty(key, JSON.stringify(session));

  return {
    ok: true,
    token: token,
    propertyKey: key,
    session: session,
    user: currentUser
  };
}

function revokeSession(sessionToken) {
  const token = String(sessionToken || '');
  if (!token || token.length > 512) return;
  PropertiesService
    .getScriptProperties()
    .deleteProperty(getSessionPropertyKey(token));
}

function revokeSessionsForUser(userName) {
  const wanted = canonicalUserName(userName);
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  Object.keys(all).forEach(function (key) {
    if (key.indexOf(SESSION_PROPERTY_PREFIX) !== 0) return;
    try {
      const session = JSON.parse(all[key]);
      if (canonicalUserName(session.user) === wanted) props.deleteProperty(key);
    } catch (err) {
      props.deleteProperty(key);
    }
  });
}

function revokePinlessSessions() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  Object.keys(all).forEach(function (key) {
    if (key.indexOf(SESSION_PROPERTY_PREFIX) !== 0) return;
    try {
      const session = JSON.parse(all[key]);
      if (session.pinless) props.deleteProperty(key);
    } catch (err) {
      props.deleteProperty(key);
    }
  });
}

function sessionResponse(issued) {
  return jsonResponse({
    ok: true,
    sessionToken: issued.token,
    user: {
      name: issued.session.user,
      role: issued.session.role
    },
    pinless: issued.session.pinless,
    mustChangePin: !!issued.session.mustChangePin,
    expiresAt: issued.session.expiresAt,
    idleTimeoutMs: SESSION_IDLE_MS
  });
}

function handleInitialPinSetup(body) {
  if (!isSelfPinSetupAllowed()) {
    return errorResponse(
      'La configuración inicial de PIN está desactivada',
      'PIN_SETUP_DISABLED'
    );
  }

  const userName = String(body.user || '').trim();
  const pin = String(body.pin || '').trim();
  if (!userName) {
    return errorResponse('Falta indicar el usuario', 'USER_REQUIRED');
  }
  if (!/^\d{4}$/.test(pin)) {
    return errorResponse(
      'El PIN debe contener exactamente 4 dígitos',
      'PIN_INVALID_FORMAT'
    );
  }

  // El lock hace atómica la regla "el primero que reclama la cuenta gana".
  // Dentro del lock se vuelve a leer PIN_HASH para impedir dos altas paralelas.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return errorResponse(
      'No se pudo reservar la configuración del PIN. Probá nuevamente.',
      'PIN_SETUP_LOCK_TIMEOUT'
    );
  }

  try {
    if (!isSelfPinSetupAllowed()) {
      return errorResponse(
        'La configuración inicial de PIN fue desactivada',
        'PIN_SETUP_DISABLED'
      );
    }

    const user = findAllowedUser(userName);
    if (!user) {
      return errorResponse('Usuario no autorizado', 'USER_NOT_FOUND');
    }
    if (user.pinHash) {
      return errorResponse(
        'Este usuario ya tiene un PIN configurado',
        'PIN_ALREADY_CONFIGURED'
      );
    }

    setUserPinHash(user.nombre, pin);
    clearFailedPins(user.nombre);

    const configuredUser = findAllowedUser(user.nombre);
    if (!configuredUser || !configuredUser.pinHash) {
      throw new Error('No se pudo confirmar el PIN recién configurado');
    }

    Logger.log('PIN inicial configurado para el usuario: ' + configuredUser.nombre);
    return sessionResponse(issueSession(configuredUser, false));
  } finally {
    lock.releaseLock();
  }
}

function handleLogin(body) {
  const user = findAllowedUser(body.user);
  if (!user) {
    return errorResponse('Usuario no autorizado', 'USER_NOT_FOUND');
  }

  if (!user.pinHash) {
    // El alta directa tiene prioridad sobre el bypass de testing: si está
    // habilitada, ninguna cuenta vacía puede ver datos antes de elegir su PIN.
    if (isSelfPinSetupAllowed()) {
      return errorResponse(
        'Configurá tu PIN de 4 dígitos para habilitar la cuenta',
        'PIN_SETUP_REQUIRED'
      );
    }

    if (!isPinlessLoginAllowed()) {
      return errorResponse(
        'Este usuario todavía no tiene un PIN configurado',
        'PIN_NOT_CONFIGURED'
      );
    }

    clearFailedPins(user.nombre);
    return sessionResponse(issueSession(user, true));
  }

  const pin = String(body.pin || '').trim();
  if (!pin) {
    return errorResponse('Ingresá tu PIN', 'PIN_REQUIRED');
  }

  const now = Date.now();
  const attemptState = readAttemptState(user.nombre, now);
  if (Number(attemptState.lockedUntil || 0) > now) {
    return errorResponse('Demasiados intentos. Esperá antes de volver a probar.', 'PIN_LOCKED', {
      lockedUntil: Number(attemptState.lockedUntil)
    });
  }

  if (!/^\d{4}$/.test(pin) || !verifyUserPin(user, pin)) {
    const failed = registerFailedPin(user.nombre);
    if (failed.locked) {
      return errorResponse('Demasiados intentos. Acceso bloqueado temporalmente.', 'PIN_LOCKED', {
        lockedUntil: failed.lockedUntil,
        attemptsRemaining: 0
      });
    }

    return errorResponse('PIN incorrecto', 'PIN_INVALID', {
      attemptsRemaining: failed.attemptsRemaining
    });
  }

  clearFailedPins(user.nombre);
  return sessionResponse(issueSession(user, false));
}

function handleSessionCheck(body) {
  const result = validateSession(body.sessionToken, true);
  if (!result.ok) return errorResponse(result.error, result.code);

  return jsonResponse({
    ok: true,
    user: {
      name: result.session.user,
      role: result.session.role
    },
    pinless: !!result.session.pinless,
    mustChangePin: !!result.user.mustChangePin,
    expiresAt: result.session.expiresAt,
    idleTimeoutMs: SESSION_IDLE_MS
  });
}

// Cambiar el PIN propio ya autenticado. Exige el PIN actual salvo que la
// cuenta todavía no tenga PIN (pinless de prueba) y el autoalta siga
// habilitado: en ese caso se comporta como el alta inicial, con la
// diferencia de que ya hay una sesión válida.
function handleChangePin(body, sessionUser) {
  const currentPin = String(body.currentPin || '').trim();
  const newPin = String(body.newPin || '').trim();

  if (!/^\d{4}$/.test(currentPin) && !/^\d{4}$/.test(newPin)) {
    return errorResponse(
      'El PIN debe contener exactamente 4 dígitos',
      'PIN_INVALID_FORMAT'
    );
  }
  if (!/^\d{4}$/.test(newPin)) {
    return errorResponse(
      'El PIN nuevo debe contener exactamente 4 dígitos',
      'PIN_INVALID_FORMAT'
    );
  }

  const user = findAllowedUser(sessionUser);
  if (!user) {
    return errorResponse('Usuario no autorizado', 'USER_NOT_FOUND');
  }

  if (user.pinHash) {
    if (!/^\d{4}$/.test(currentPin)) {
      return errorResponse(
        'Ingresá tu PIN actual de 4 dígitos',
        'PIN_INVALID_FORMAT'
      );
    }

    if (!verifyUserPin(user, currentPin)) {
      const failed = registerFailedPin(user.nombre);
      if (failed.locked) {
        return errorResponse(
          'Demasiados intentos. Cambio de PIN bloqueado temporalmente.',
          'PIN_LOCKED',
          { lockedUntil: failed.lockedUntil, attemptsRemaining: 0 }
        );
      }
      return errorResponse(
        'El PIN actual es incorrecto',
        'PIN_INVALID',
        { attemptsRemaining: failed.attemptsRemaining }
      );
    }
  } else if (!isSelfPinSetupAllowed()) {
    return errorResponse(
      'Este usuario todavía no tiene un PIN configurado',
      'PIN_NOT_CONFIGURED'
    );
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return errorResponse(
      'No se pudo reservar el cambio de PIN. Probá nuevamente.',
      'PIN_CHANGE_LOCK_TIMEOUT'
    );
  }

  try {
    const freshUser = findAllowedUser(sessionUser);
    if (!freshUser) {
      return errorResponse('Usuario no autorizado', 'USER_NOT_FOUND');
    }

    // Evita que dos cambios paralelos sobre la misma cuenta se pisen.
    if (
      freshUser.pinHash &&
      !constantTimeEquals(String(freshUser.pinHash || ''), String(user.pinHash || ''))
    ) {
      return errorResponse(
        'El PIN cambió mientras tanto. Volvé a intentarlo.',
        'PIN_CHANGE_RACE'
      );
    }

    setUserPinHash(freshUser.nombre, newPin, false);
    clearFailedPins(freshUser.nombre);

    const configuredUser = findAllowedUser(freshUser.nombre);
    if (!configuredUser || !configuredUser.pinHash) {
      throw new Error('No se pudo confirmar el PIN recién configurado');
    }

    Logger.log('PIN actualizado por el usuario: ' + configuredUser.nombre);
    return sessionResponse(issueSession(configuredUser, false));
  } finally {
    lock.releaseLock();
  }
}

// ── GESTIÓN EXCLUSIVA DE SUPERUSUARIO ───────────────────────────────────
function serializeAdminUser(user) {
  return {
    name: user.nombre,
    role: user.rol,
    active: Boolean(user.activo),
    hasPin: Boolean(user.pinHash),
    mustChangePin: Boolean(user.mustChangePin)
  };
}

function assertSuperuserRole(sessionRole) {
  if (normalizeRole(sessionRole) !== 'SUPERUSUARIO') {
    throw new Error('Esta operación requiere permisos de SUPERUSUARIO');
  }
}

function handleAdminListUsers(sessionRole) {
  assertSuperuserRole(sessionRole);
  return jsonResponse({
    ok: true,
    users: getAllUsers().map(serializeAdminUser)
  });
}

function handleAdminResetPin(body, sessionUser, sessionRole) {
  assertSuperuserRole(sessionRole);
  const targetName = String(body.targetUser || '').trim();
  const tempPin = String(body.tempPin || '').trim();

  if (!targetName) {
    return errorResponse('Falta indicar el usuario', 'USER_REQUIRED');
  }
  if (!/^\d{4}$/.test(tempPin)) {
    return errorResponse(
      'El PIN temporal debe contener exactamente 4 dígitos',
      'PIN_INVALID_FORMAT'
    );
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return errorResponse(
      'No se pudo reservar el cambio de PIN. Probá nuevamente.',
      'PIN_CHANGE_LOCK_TIMEOUT'
    );
  }

  try {
    const target = findAnyUser(targetName);
    if (!target) {
      return errorResponse('Usuario no encontrado', 'USER_NOT_FOUND');
    }

    setUserPinHash(target.nombre, tempPin, true);
    clearFailedPins(target.nombre);
    logChange(
      sessionUser,
      'ADMIN',
      USERS_SHEET_NAME,
      target.row,
      PIN_HASH_HEADER,
      target.pinHash ? '[HASH]' : '',
      '[HASH_TEMP]'
    );

    const updated = findAnyUser(target.nombre);
    return jsonResponse({
      ok: true,
      user: serializeAdminUser(updated)
    });
  } finally {
    lock.releaseLock();
  }
}

function handleAdminSetUserActive(body, sessionUser, sessionRole) {
  assertSuperuserRole(sessionRole);
  const targetName = String(body.targetUser || '').trim();
  const nextActive = Boolean(body.active);

  if (!targetName) {
    return errorResponse('Falta indicar el usuario', 'USER_REQUIRED');
  }

  if (!nextActive && canonicalUserName(targetName) === canonicalUserName(sessionUser)) {
    return errorResponse(
      'No podés dar de baja tu propio usuario activo',
      'SELF_DEACTIVATION_FORBIDDEN'
    );
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return errorResponse(
      'No se pudo reservar la actualización del usuario. Probá nuevamente.',
      'USER_UPDATE_LOCK_TIMEOUT'
    );
  }

  try {
    const target = findAnyUser(targetName);
    if (!target) {
      return errorResponse('Usuario no encontrado', 'USER_NOT_FOUND');
    }

    setUserActiveStatus(target.nombre, nextActive);
    logChange(
      sessionUser,
      'ADMIN',
      USERS_SHEET_NAME,
      target.row,
      USER_STATUS_HEADER,
      target.activo ? 'ACTIVO' : 'INACTIVO',
      nextActive ? 'ACTIVO' : 'INACTIVO'
    );

    const updated = findAnyUser(target.nombre);
    return jsonResponse({
      ok: true,
      user: serializeAdminUser(updated)
    });
  } finally {
    lock.releaseLock();
  }
}

function handleAdminRevokeUserSessions(body, sessionUser, sessionRole) {
  assertSuperuserRole(sessionRole);
  const targetName = String(body.targetUser || '').trim();
  if (!targetName) {
    return errorResponse('Falta indicar el usuario', 'USER_REQUIRED');
  }

  const target = findAnyUser(targetName);
  if (!target) {
    return errorResponse('Usuario no encontrado', 'USER_NOT_FOUND');
  }

  revokeSessionsForUser(target.nombre);
  clearFailedPins(target.nombre);
  logChange(
    sessionUser,
    'ADMIN',
    USERS_SHEET_NAME,
    target.row,
    'SESIONES',
    'ACTIVAS',
    'REVOCADAS'
  );

  return jsonResponse({
    ok: true,
    user: serializeAdminUser(target)
  });
}

// ── AUTORIZACIÓN DE COLUMNAS ────────────────────────────────────────────
function isAssignmentColumn(column) {
  const key = normalizeKey(column);
  const exactNames = [
    'encargado',
    'encargada',
    'responsable',
    'asignado',
    'asignada',
    'asignadoa',
    'operador',
    'asignacion',
    'usuarioresponsable'
  ];

  if (exactNames.indexOf(key) !== -1) return true;

  // Misma búsqueda flexible que utiliza el frontend. Se excluyen sellos como
  // "Presentado por" y "Archivado por", que USUARIO sí puede modificar.
  if (
    key.indexOf('present') !== -1 ||
    key.indexOf('archiv') !== -1 ||
    key.indexOf('liquid') !== -1 ||
    key.indexOf('enviad') !== -1
  ) {
    return false;
  }

  return key.indexOf('encargad') !== -1 ||
    key.indexOf('responsable') !== -1 ||
    key.indexOf('asignad') !== -1;
}

function assertCanEditColumn(role, column) {
  if (!isPrivilegedRole(role) && isAssignmentColumn(column)) {
    throw new Error('Tu rol no permite cambiar el Encargado de un cliente');
  }
}

// ── RESPUESTAS ──────────────────────────────────────────────────────────
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(message, code, extra) {
  const payload = {
    ok: false,
    error: String(message || 'Error desconocido'),
    code: code || 'UNKNOWN_ERROR'
  };

  if (extra) {
    Object.keys(extra).forEach(function (key) {
      payload[key] = extra[key];
    });
  }

  return jsonResponse(payload);
}

// ── GET DESACTIVADO ─────────────────────────────────────────────────────
// El token nunca debe enviarse por URL. Todas las operaciones usan POST.
function doGet() {
  return errorResponse(
    'Método no permitido. Usá POST con JSON.',
    'POST_REQUIRED'
  );
}

// ── ESCRITURA DE UNA CELDA YA VALIDADA ──────────────────────────────────
function writeSingleCell(sheet, headers, user, year, sheetName, row, column, value) {
  const colIndex = headers.indexOf(column);
  if (colIndex === -1) throw new Error('Columna "' + column + '" no existe');
  if (!row || Number(row) < 2) throw new Error('Fila inválida');

  const rowNumber = Number(row);
  const cell = sheet.getRange(rowNumber, colIndex + 1);
  const oldValue = cell.getValue();
  cell.setValue(value);
  logChange(user, year, sheetName, rowNumber, column, oldValue, value);
}

// ── POST: LECTURA Y ESCRITURA ───────────────────────────────────────────
function doPost(e) {
  let body;

  try {
    if (!e || !e.postData || typeof e.postData.contents !== 'string') {
      throw new Error('Sin body');
    }
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return errorResponse('Body inválido, se esperaba JSON', 'INVALID_BODY');
  }

  if (!isAuthorized(body.token)) return unauthorizedResponse();

  const action = String(body.action || 'ping');

  // Acciones permitidas antes de iniciar sesión.
  if (action === 'ping') {
    return jsonResponse({
      ok: true,
      message: 'Conexión establecida correctamente',
      authMode: isSelfPinSetupAllowed()
        ? 'self-pin-setup'
        : (isPinlessLoginAllowed() ? 'testing' : 'enforced'),
      timestamp: new Date().toISOString()
    });
  }

  if (action === 'users') {
    try {
      return jsonResponse({
        ok: true,
        users: getAllowedUsers().map(function (u) {
          return { name: u.nombre };
        })
      });
    } catch (err) {
      return errorResponse(err.message, 'USERS_ERROR');
    }
  }

  if (action === 'setupPin') {
    try {
      return handleInitialPinSetup(body);
    } catch (err) {
      return errorResponse(err.message, 'PIN_SETUP_ERROR');
    }
  }

  if (action === 'login') {
    try {
      return handleLogin(body);
    } catch (err) {
      return errorResponse(err.message, 'LOGIN_ERROR');
    }
  }

  if (action === 'session') {
    try {
      return handleSessionCheck(body);
    } catch (err) {
      return errorResponse(err.message, 'SESSION_ERROR');
    }
  }

  if (action === 'logout') {
    revokeSession(body.sessionToken);
    return jsonResponse({ ok: true });
  }

  // Desde acá toda operación debe tener una sesión individual válida.
  const auth = validateSession(body.sessionToken, true);
  if (!auth.ok) return errorResponse(auth.error, auth.code);

  const sessionUser = auth.session.user;
  const sessionRole = auth.session.role;

  if (action === 'changePin') {
    try {
      return handleChangePin(body, sessionUser);
    } catch (err) {
      return errorResponse(err.message, 'PIN_CHANGE_ERROR');
    }
  }

  if (action === 'adminListUsers') {
    try {
      return handleAdminListUsers(sessionRole);
    } catch (err) {
      return errorResponse(err.message, 'FORBIDDEN');
    }
  }

  if (action === 'adminResetPin') {
    try {
      return handleAdminResetPin(body, sessionUser, sessionRole);
    } catch (err) {
      return errorResponse(err.message, 'ADMIN_RESET_PIN_ERROR');
    }
  }

  if (action === 'adminSetUserActive') {
    try {
      return handleAdminSetUserActive(body, sessionUser, sessionRole);
    } catch (err) {
      return errorResponse(err.message, 'ADMIN_USER_STATUS_ERROR');
    }
  }

  if (action === 'adminRevokeUserSessions') {
    try {
      return handleAdminRevokeUserSessions(body, sessionUser, sessionRole);
    } catch (err) {
      return errorResponse(err.message, 'ADMIN_REVOKE_SESSIONS_ERROR');
    }
  }

  if (action === 'years') {
    try {
      return jsonResponse({ ok: true, years: getAvailableYears() });
    } catch (err) {
      return errorResponse(err.message, 'YEARS_ERROR');
    }
  }

  if (action === 'months') {
    try {
      if (!body.year) {
        return errorResponse('Falta indicar el año', 'YEAR_REQUIRED');
      }
      return jsonResponse({
        ok: true,
        months: getAvailableSheets(body.year)
      });
    } catch (err) {
      return errorResponse(err.message, 'MONTHS_ERROR');
    }
  }

  if (action === 'read') {
    try {
      const sheet = getMonthSheet(body.year, body.sheet);
      if (!sheet) {
        return errorResponse(
          'Año/mes "' + body.year + ' / ' + body.sheet + '" no válido',
          'SHEET_NOT_FOUND'
        );
      }

      const data = fillMergedValues(sheet.getDataRange());
      if (data.length === 0) {
        return jsonResponse({ ok: true, headers: [], rows: [] });
      }

      const headers = data[0];
      const rows = data.slice(1).map(function (row, idx) {
        const obj = {};
        headers.forEach(function (h, i) { obj[h] = row[i]; });
        obj._row = idx + 2;
        return obj;
      });

      return jsonResponse({ ok: true, headers: headers, rows: rows });
    } catch (err) {
      return errorResponse(err.message, 'READ_ERROR');
    }
  }

  if (action === 'create') {
    try {
      const sheet = getMonthSheet(body.year, body.sheet);
      if (!sheet) {
        return errorResponse(
          'Año/mes "' + body.year + ' / ' + body.sheet + '" no válido',
          'SHEET_NOT_FOUND'
        );
      }
      if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
        return errorResponse('Faltan los datos del cliente', 'VALUES_REQUIRED');
      }

      const headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];
      const rowValues = headers.map(function (header) {
        const value = Object.prototype.hasOwnProperty.call(body.values, header)
          ? body.values[header]
          : '';
        if (value !== '' && value !== null && value !== undefined) {
          assertCanEditColumn(sessionRole, header);
        }
        return value === null || value === undefined ? '' : value;
      });

      const lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) {
        return errorResponse(
          'No se pudo obtener el lock de la hoja (30s), intentá de nuevo',
          'SHEET_LOCK_TIMEOUT'
        );
      }

      let newRow;
      try {
        newRow = Math.max(2, sheet.getLastRow() + 1);
        const target = sheet.getRange(newRow, 1, 1, headers.length);
        let inheritedFormulas = [];
        // Conserva formato, validaciones y fórmulas de la fila anterior, sin
        // copiar sus datos. R1C1 hace que las referencias relativas se ajusten
        // a la fila nueva.
        if (newRow > 2) {
          const previous = sheet.getRange(newRow - 1, 1, 1, headers.length);
          previous.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
          target.setDataValidations(previous.getDataValidations());
          inheritedFormulas = previous.getFormulasR1C1()[0];
        }
        target.setValues([rowValues]);
        inheritedFormulas.forEach(function (formula, index) {
          if (formula && rowValues[index] === '') {
            target.getCell(1, index + 1).setFormulaR1C1(formula);
          }
        });
        headers.forEach(function (header, index) {
          if (rowValues[index] !== '') {
            logChange(sessionUser, body.year, body.sheet, newRow, header, '', rowValues[index]);
          }
        });
      } finally {
        lock.releaseLock();
      }

      return jsonResponse({ ok: true, row: newRow, message: 'Cliente creado' });
    } catch (err) {
      return errorResponse(err.message, 'CREATE_ERROR');
    }
  }

  if (action === 'update') {
    try {
      const sheet = getMonthSheet(body.year, body.sheet);
      if (!sheet) {
        return errorResponse(
          'Año/mes "' + body.year + ' / ' + body.sheet + '" no válido',
          'SHEET_NOT_FOUND'
        );
      }

      const headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0];

      assertCanEditColumn(sessionRole, body.column);
      writeSingleCell(
        sheet,
        headers,
        sessionUser,
        body.year,
        body.sheet,
        body.row,
        body.column,
        body.value
      );

      return jsonResponse({
        ok: true,
        message: 'Celda actualizada',
        row: body.row,
        column: body.column
      });
    } catch (err) {
      return errorResponse(err.message, 'UPDATE_ERROR');
    }
  }

  if (action === 'updateBatch') {
    try {
      const updates = body.updates;
      if (!Array.isArray(updates) || updates.length === 0) {
        return errorResponse(
          'No se recibió ningún cambio para guardar (updates vacío)',
          'UPDATES_REQUIRED'
        );
      }

      const groups = {};
      const groupOrder = [];

      updates.forEach(function (u) {
        const key = String(u.year) + '||' + String(u.sheet);
        if (!groups[key]) {
          groups[key] = [];
          groupOrder.push(key);
        }
        groups[key].push(u);
      });

      const results = [];
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) {
        return errorResponse(
          'No se pudo obtener el lock de la hoja (30s), intentá de nuevo',
          'SHEET_LOCK_TIMEOUT'
        );
      }

      try {
        groupOrder.forEach(function (key) {
          const groupUpdates = groups[key];
          const first = groupUpdates[0];
          const sheet = getMonthSheet(first.year, first.sheet);

          if (!sheet) {
            groupUpdates.forEach(function (u) {
              results.push({
                row: u.row,
                column: u.column,
                ok: false,
                error: 'Año/mes "' + first.year + ' / ' + first.sheet + '" no válido'
              });
            });
            return;
          }

          const headers = sheet
            .getRange(1, 1, 1, sheet.getLastColumn())
            .getValues()[0];

          groupUpdates.forEach(function (u) {
            try {
              assertCanEditColumn(sessionRole, u.column);
              writeSingleCell(
                sheet,
                headers,
                sessionUser,
                u.year,
                u.sheet,
                u.row,
                u.column,
                u.value
              );
              results.push({ row: u.row, column: u.column, ok: true });
            } catch (itemErr) {
              results.push({
                row: u.row,
                column: u.column,
                ok: false,
                error: itemErr.message
              });
            }
          });
        });
      } finally {
        lock.releaseLock();
      }

      return jsonResponse({ ok: true, results: results });
    } catch (err) {
      return errorResponse(err.message, 'UPDATE_BATCH_ERROR');
    }
  }

  // Módulo Vencimientos IVA (archivo AppsScript-Iva.gs).
  const ivaResponse = handleIvaAction(action, body, sessionUser, sessionRole);
  if (ivaResponse) return ivaResponse;

  // Módulo Marcaciones (archivo AppsScript-Marcaciones.gs).
  const marcacionesResponse = handleMarcacionesAction(action, body, sessionUser, sessionRole);
  if (marcacionesResponse) return marcacionesResponse;

  // Módulo Avisos / Buzón (archivo AppsScript-Avisos.gs).
  const avisosResponse = handleAvisosAction(action, body, sessionUser, sessionRole);
  if (avisosResponse) return avisosResponse;

  return errorResponse('Acción desconocida: ' + action, 'UNKNOWN_ACTION');
}

// ===== AppsScript-Iva.gs =====
/**
 * MÓDULO VENCIMIENTOS IVA - archivo aparte del backend de Control Clientes.
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "Iva" y pegar este
 *      contenido completo.
 *   2. En doPost del Code.gs, justo antes de la línea
 *        return errorResponse('Acción desconocida: ' + action, 'UNKNOWN_ACTION');
 *      agregar:
 *        const ivaResponse = handleIvaAction(action, body, sessionUser, sessionRole);
 *        if (ivaResponse) return ivaResponse;
 *   3. Implementar > Administrar implementaciones > editar > Nueva versión.
 *
 * Usa funciones que ya existen en Code.gs: getAdminSpreadsheet, isPrivilegedRole,
 * jsonResponse y errorResponse. Todos los archivos .gs de un proyecto comparten
 * el mismo ámbito, así que no hace falta importarlas.
 */

// ── MÓDULO VENCIMIENTOS IVA ─────────────────────────────────────────────
// Reemplaza al backend de Netlify Blobs de la app "vencimientos-iva".
// La lista de clientes sale de las planillas mensuales; acá sólo se guarda
// lo propio del IVA:
//   "IVA AAAA-MM"   una hoja por período fiscal, una fila por cliente (RUC).
//                   Las primeras columnas son legibles (estado, resultado);
//                   la liquidación completa va como JSON, partida en varias
//                   celdas porque Sheets admite 50.000 caracteres por celda.
//   "IVA Clientes"  datos fijos del cliente para el IVA (WhatsApp, notas).
//   "IVA Config"    colores, feriados, mora y nombre del estudio.
// Por defecto viven en la planilla de administración; con la propiedad
// IVA_SPREADSHEET_ID se pueden mover a una planilla aparte.
const IVA_PERIOD_PREFIX = 'IVA ';
const IVA_CLIENTES_SHEET_NAME = 'IVA Clientes';
const IVA_CONFIG_SHEET_NAME = 'IVA Config';
const IVA_PERIOD_HEADERS = ['RUC', 'Cliente', 'Estado', 'Resultado', 'Monto', 'Actualizado', 'Usuario'];
const IVA_DATA_CHUNK = 45000;
const IVA_DATA_MAX_CHUNKS = 14;
const IVA_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function getIvaSpreadsheet() {
  const customId = String(
    PropertiesService.getScriptProperties().getProperty('IVA_SPREADSHEET_ID') || ''
  ).trim();
  return customId ? SpreadsheetApp.openById(customId) : getAdminSpreadsheet();
}

function normalizeRuc(value) {
  // Sólo el número de RUC, sin el dígito verificador.
  const text = String(value === null || value === undefined ? '' : value).trim();
  const base = text.indexOf('-') !== -1 ? text.split('-')[0] : text;
  return base.replace(/\D/g, '');
}

function assertIvaPeriod(periodo) {
  if (!IVA_PERIOD_PATTERN.test(String(periodo || ''))) {
    throw new Error('Período inválido: se esperaba AAAA-MM');
  }
  return String(periodo);
}

function assertIvaRuc(ruc) {
  const clean = normalizeRuc(ruc);
  if (!clean || clean.length > 12) throw new Error('RUC inválido');
  return clean;
}

function getIvaPeriodSheet(periodo, create) {
  const ss = getIvaSpreadsheet();
  const name = IVA_PERIOD_PREFIX + periodo;
  let sheet = ss.getSheetByName(name);
  if (!sheet && create) {
    sheet = ss.insertSheet(name);
    const headers = IVA_PERIOD_HEADERS.slice();
    for (let i = 1; i <= IVA_DATA_MAX_CHUNKS; i++) headers.push('Datos ' + i);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // RUC y datos como texto: si no, Sheets los reinterpreta.
    sheet.getRange('A:A').setNumberFormat('@');
    sheet.getRange(1, IVA_PERIOD_HEADERS.length + 1, sheet.getMaxRows(), IVA_DATA_MAX_CHUNKS)
      .setNumberFormat('@');
  }
  return sheet;
}

function ensureIvaKeyValueSheet(name, headers) {
  const ss = getIvaSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('@');
  }
  return sheet;
}

function findRowByKey(sheet, key) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const keys = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) return i + 2;
  }
  return -1;
}

function nextFreeRow(sheet) {
  const row = Math.max(2, sheet.getLastRow() + 1);
  // Las filas nuevas heredan el formato de texto de la anterior.
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 200);
  return row;
}

// Cada fragmento lleva "~" adelante: un pedazo de JSON que empezara con
// "=", "+" o "-" Sheets lo tomaría como fórmula o número.
function splitIvaData(json) {
  const parts = [];
  for (let i = 0; i < json.length; i += IVA_DATA_CHUNK) {
    parts.push('~' + json.slice(i, i + IVA_DATA_CHUNK));
  }
  if (parts.length > IVA_DATA_MAX_CHUNKS) {
    throw new Error('La liquidación es demasiado grande para guardarse');
  }
  while (parts.length < IVA_DATA_MAX_CHUNKS) parts.push('');
  return parts;
}

function joinIvaData(rowValues) {
  const json = rowValues
    .slice(IVA_PERIOD_HEADERS.length)
    .map(function (part) { return String(part || '').replace(/^~/, ''); })
    .join('');
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}

// Versión liviana para el tablero: quita el detalle de comprobantes
// (fecha, número, tercero), igual que el backend anterior.
function summarizeIvaDoc(doc) {
  const out = {};
  Object.keys(doc || {}).forEach(function (key) {
    const value = doc[key];
    out[key] = Array.isArray(value)
      ? value.map(function (x) { return { m: x.m, iva: x.iva }; })
      : value;
  });
  return out;
}

function readIvaPeriod(periodo, summary) {
  const sheet = getIvaPeriodSheet(periodo, false);
  const out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  const values = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getDisplayValues();
  values.forEach(function (row) {
    const ruc = String(row[0]).trim();
    if (!ruc) return;
    const doc = joinIvaData(row);
    if (doc) out[ruc] = summary ? summarizeIvaDoc(doc) : doc;
  });
  return out;
}

function readIvaClientes() {
  const sheet = ensureIvaKeyValueSheet(
    IVA_CLIENTES_SHEET_NAME,
    ['RUC', 'Cliente', 'WhatsApp', 'Notas', 'Actualizado', 'Usuario']
  );
  const out = {};
  if (sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getDisplayValues().forEach(function (row) {
    const ruc = String(row[0]).trim();
    if (ruc) out[ruc] = { wa: String(row[2] || ''), notas: String(row[3] || '') };
  });
  return out;
}

function readIvaConfig() {
  const sheet = ensureIvaKeyValueSheet(IVA_CONFIG_SHEET_NAME, ['Clave', 'Valor']);
  const row = findRowByKey(sheet, 'ajustes');
  if (row === -1) return null;
  try {
    return JSON.parse(String(sheet.getRange(row, 2).getValue() || 'null'));
  } catch (err) {
    return null;
  }
}

function withIvaLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('No se pudo obtener el lock de la hoja (30s), intentá de nuevo');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function handleIvaLoad(body) {
  const periodos = (Array.isArray(body.periodos) ? body.periodos : [])
    .map(String)
    .filter(function (p) { return IVA_PERIOD_PATTERN.test(p); })
    .slice(0, 6);
  const liq = {};
  periodos.forEach(function (p) { liq[p] = readIvaPeriod(p, true); });
  return jsonResponse({
    ok: true,
    clientes: readIvaClientes(),
    config: readIvaConfig(),
    liq: liq
  });
}

function handleIvaGetDoc(body) {
  const periodo = assertIvaPeriod(body.periodo);
  const ruc = assertIvaRuc(body.ruc);
  const sheet = getIvaPeriodSheet(periodo, false);
  if (!sheet) return jsonResponse({ ok: true, doc: null });
  const row = findRowByKey(sheet, ruc);
  if (row === -1) return jsonResponse({ ok: true, doc: null });
  const values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  return jsonResponse({ ok: true, doc: joinIvaData(values) });
}

function handleIvaSaveDoc(body, sessionUser) {
  const periodo = assertIvaPeriod(body.periodo);
  const ruc = assertIvaRuc(body.ruc);
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Datos de liquidación inválidos');
  }
  const resumen = body.resumen && typeof body.resumen === 'object' ? body.resumen : {};
  const parts = splitIvaData(JSON.stringify(data));
  const rowValues = [
    ruc,
    String(resumen.cliente || '').slice(0, 200),
    String(resumen.estado || '').slice(0, 40),
    String(resumen.resultado || '').slice(0, 60),
    Number(resumen.monto) || 0,
    new Date(),
    sessionUser
  ].concat(parts);

  withIvaLock(function () {
    const sheet = getIvaPeriodSheet(periodo, true);
    let row = findRowByKey(sheet, ruc);
    if (row === -1) row = nextFreeRow(sheet);
    sheet.getRange(row, 1, 1, rowValues.length).setValues([rowValues]);
  });
  return jsonResponse({ ok: true });
}

function handleIvaSaveCliente(body, sessionUser) {
  const ruc = assertIvaRuc(body.ruc);
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const rowValues = [
    ruc,
    String(data.nombre || '').slice(0, 200),
    String(data.wa || '').slice(0, 40),
    String(data.notas || '').slice(0, 5000),
    new Date(),
    sessionUser
  ];
  withIvaLock(function () {
    const sheet = ensureIvaKeyValueSheet(
      IVA_CLIENTES_SHEET_NAME,
      ['RUC', 'Cliente', 'WhatsApp', 'Notas', 'Actualizado', 'Usuario']
    );
    let row = findRowByKey(sheet, ruc);
    if (row === -1) row = nextFreeRow(sheet);
    sheet.getRange(row, 1, 1, rowValues.length).setValues([rowValues]);
  });
  return jsonResponse({ ok: true });
}

function handleIvaSaveConfig(body, sessionRole) {
  if (!isPrivilegedRole(sessionRole)) {
    throw new Error('Sólo un administrador puede cambiar la configuración de IVA');
  }
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Configuración inválida');
  }
  const json = JSON.stringify(data);
  if (json.length > IVA_DATA_CHUNK) throw new Error('Configuración demasiado grande');
  withIvaLock(function () {
    const sheet = ensureIvaKeyValueSheet(IVA_CONFIG_SHEET_NAME, ['Clave', 'Valor']);
    let row = findRowByKey(sheet, 'ajustes');
    if (row === -1) row = nextFreeRow(sheet);
    sheet.getRange(row, 1, 1, 2).setValues([['ajustes', json]]);
  });
  return jsonResponse({ ok: true });
}

// ── MIGRACIÓN ÚNICA DESDE LA APP DE NETLIFY ─────────────────────────────
// Ejecutar a mano desde el editor de Apps Script, una sola vez:
//   1. Script Properties:
//        IVA_MIGRAR_URL    https://TU-SITIO.netlify.app   (sin barra final)
//        IVA_MIGRAR_CLAVE  la CLAVE_ACCESO de Netlify
//        IVA_MIGRAR_DESDE  primer período a traer, ej. 2025-01
//   2. Ejecutar migrarDesdeVencimientosIvaNetlify y revisar el registro.
//   3. Borrar las tres propiedades.
// Las liquidaciones pasan a identificarse por RUC (antes, por un id interno).
// Es repetible: vuelve a escribir las mismas filas.
function migrarDesdeVencimientosIvaNetlify() {
  const props = PropertiesService.getScriptProperties();
  const baseUrl = String(props.getProperty('IVA_MIGRAR_URL') || '').replace(/\/+$/, '');
  const clave = String(props.getProperty('IVA_MIGRAR_CLAVE') || '');
  const desde = String(props.getProperty('IVA_MIGRAR_DESDE') || '');
  if (!baseUrl || !clave || !IVA_PERIOD_PATTERN.test(desde)) {
    throw new Error('Configurá IVA_MIGRAR_URL, IVA_MIGRAR_CLAVE e IVA_MIGRAR_DESDE (AAAA-MM)');
  }

  const periodos = [];
  const hoy = new Date();
  const limite = hoy.getFullYear() + '-' + ('0' + (hoy.getMonth() + 1)).slice(-2);
  let p = desde;
  while (p <= limite) {
    periodos.push(p);
    const y = Number(p.slice(0, 4));
    const m = Number(p.slice(5, 7));
    p = (m === 12 ? y + 1 : y) + '-' + ('0' + (m === 12 ? 1 : m + 1)).slice(-2);
  }

  function fetchLote(lote) {
    const response = UrlFetchApp.fetch(
      baseUrl + '/api/data?periodos=' + lote.join(','),
      { headers: { 'x-clave': clave }, muteHttpExceptions: true }
    );
    if (response.getResponseCode() !== 200) {
      throw new Error('Netlify respondió ' + response.getResponseCode() + ': ' + response.getContentText());
    }
    return JSON.parse(response.getContentText());
  }

  let clientes = {};
  let config = null;
  let liquidaciones = 0;
  const sinRuc = [];

  for (let i = 0; i < periodos.length; i += 6) {
    const lote = periodos.slice(i, i + 6);
    const data = fetchLote(lote);
    clientes = data.clientes || clientes;
    config = (data.config && data.config.ajustes) || config;

    lote.forEach(function (periodo) {
      const docs = (data.liq && data.liq[periodo]) || {};
      Object.keys(docs).forEach(function (idCliente) {
        const cliente = clientes[idCliente];
        const ruc = cliente ? normalizeRuc(cliente.ruc) : '';
        if (!ruc) {
          sinRuc.push(periodo + ' / ' + idCliente);
          return;
        }
        const doc = docs[idCliente];
        doc.clienteId = ruc;
        doc.periodo = periodo;
        handleIvaSaveDoc(
          { periodo: periodo, ruc: ruc, data: doc, resumen: { cliente: cliente.nombre, estado: doc.estado || '' } },
          'Migración'
        );
        liquidaciones++;
      });
    });
  }

  let fichas = 0;
  Object.keys(clientes).forEach(function (idCliente) {
    const c = clientes[idCliente];
    const ruc = normalizeRuc(c.ruc);
    if (ruc && (c.wa || c.notas)) {
      handleIvaSaveCliente({ ruc: ruc, data: { nombre: c.nombre, wa: c.wa, notas: c.notas } }, 'Migración');
      fichas++;
    }
  });

  if (config) handleIvaSaveConfig({ data: config }, 'SUPERUSUARIO');

  Logger.log('Liquidaciones migradas: ' + liquidaciones);
  Logger.log('Clientes con WhatsApp o notas: ' + fichas);
  Logger.log('Configuración: ' + (config ? 'migrada' : 'no había'));
  if (sinRuc.length) Logger.log('Sin RUC (no migradas): ' + sinRuc.join(', '));
}

// ── RUTEO ───────────────────────────────────────────────────────────────
// Se llama desde doPost después de validar la sesión. Devuelve la respuesta
// si la acción es del módulo de IVA, o null para que doPost siga con lo suyo.
// Cualquier sesión válida puede leer y cargar liquidaciones; la configuración
// sólo la cambian los roles privilegiados.
function handleIvaAction(action, body, sessionUser, sessionRole) {
  const routes = {
    ivaLoad: [function () { return handleIvaLoad(body); }, 'IVA_LOAD_ERROR'],
    ivaGetDoc: [function () { return handleIvaGetDoc(body); }, 'IVA_GET_ERROR'],
    ivaSaveDoc: [function () { return handleIvaSaveDoc(body, sessionUser); }, 'IVA_SAVE_ERROR'],
    ivaSaveCliente: [function () { return handleIvaSaveCliente(body, sessionUser); }, 'IVA_CLIENT_ERROR'],
    ivaSaveConfig: [function () { return handleIvaSaveConfig(body, sessionRole); }, 'IVA_CONFIG_ERROR']
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route[0]();
  } catch (err) {
    return errorResponse(err.message, route[1]);
  }
}

// ===== AppsScript-Marcaciones.gs =====
/**
 * MÓDULO MARCACIONES - archivo aparte del backend de Control Clientes.
 *
 * Guarda en la planilla de administración los horarios y las planillas mensuales
 * procesadas de Marcaciones (sólo ADMINISTRADOR y SUPERUSUARIO). El .dat original
 * no se guarda; se almacenan las marcas procesadas y las correcciones por día.
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "Marcaciones" y pegar
 *      este contenido completo.
 *   2. En doPost del Code.gs, justo antes de la línea
 *        return errorResponse('Acción desconocida: ' + action, 'UNKNOWN_ACTION');
 *      agregar:
 *        const marcacionesResponse = handleMarcacionesAction(action, body, sessionUser, sessionRole);
 *        if (marcacionesResponse) return marcacionesResponse;
 *   3. Implementar > Administrar implementaciones > editar > Nueva versión.
 *
 * Las acciones marcacionesGetMonths, marcacionesGetMonth y marcacionesSaveMonth
 * guardan/leen los datos mensuales en "Marcaciones Datos". La hoja se crea sola.
 *
 * Usa funciones que ya existen en Code.gs: getAdminSpreadsheet, isPrivilegedRole,
 * jsonResponse y errorResponse.
 */

// Hoja "Marcaciones Config": una fila por clave ("ajustes"), con el JSON de
// horarios, quién y cuándo lo guardó. Se crea sola la primera vez.
const MARCACIONES_CONFIG_SHEET_NAME = 'Marcaciones Config';
const MARCACIONES_CONFIG_KEY = 'ajustes';
const MARCACIONES_DATA_SHEET_NAME = 'Marcaciones Datos';
const MARCACIONES_DATA_CHUNK = 40000;
const MARCACIONES_DATA_MAX = 4000000;
const MARCACIONES_CONFIG_MAX = 45000; // Sheets admite 50.000 caracteres por celda
const MARCACIONES_HORA = /^([01]?\d|2[0-3]):[0-5]\d$/;

function ensureMarcacionesConfigSheet() {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(MARCACIONES_CONFIG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MARCACIONES_CONFIG_SHEET_NAME);
    sheet.getRange(1, 1, 1, 4).setValues([['Clave', 'Valor', 'Actualizado', 'Usuario']]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('@');
  }
  return sheet;
}

function findMarcacionesConfigRow(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const keys = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === MARCACIONES_CONFIG_KEY) return i + 2;
  }
  return -1;
}

function assertMarcacionesAdmin(sessionRole) {
  if (!isPrivilegedRole(sessionRole)) {
    throw new Error('Sólo un administrador puede ver o cambiar los horarios de marcaciones');
  }
}

function marcacionesHora(value) {
  const text = String(value || '').trim();
  return MARCACIONES_HORA.test(text) ? text : '';
}

function marcacionesNumero(value, fallback) {
  if (value === '' || value == null) return fallback;
  const n = Number(value);
  return isFinite(n) && n >= 0 && n <= 1440 ? n : fallback;
}

// Se guarda sólo lo que la pantalla usa, con el formato validado.
function sanitizeMarcacionesConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Configuración inválida');
  }
  const sab = data.sab && typeof data.sab === 'object' ? data.sab : {};
  const clean = {
    al: marcacionesNumero(data.al, 40),
    tol: marcacionesNumero(data.tol, 0),
    dup: marcacionesNumero(data.dup, 3),
    sab: { e: marcacionesHora(sab.e), s: marcacionesHora(sab.s) },
    emp: {}
  };
  const emp = data.emp && typeof data.emp === 'object' && !Array.isArray(data.emp) ? data.emp : {};
  Object.keys(emp).forEach(function (cedula) {
    if (!/^\d{3,15}$/.test(cedula)) return;
    const c = emp[cedula] || {};
    const lab = Array.isArray(c.lab)
      ? c.lab.map(Number).filter(function (d, i, all) {
          return d === Math.floor(d) && d >= 0 && d <= 6 && all.indexOf(d) === i;
        })
      : [];
    const item = { e: marcacionesHora(c.e), s: marcacionesHora(c.s), lab: lab, tipo: c.tipo === 'flexible' ? 'flexible' : 'fijo' };
    const nom = String(c.nom || '').trim().slice(0, 60);
    if (nom) item.nom = nom;
    const al = marcacionesNumero(c.al, null);
    const tol = marcacionesNumero(c.tol, null);
    if (al !== null) item.al = al;
    if (tol !== null) item.tol = tol;
    clean.emp[cedula] = item;
  });
  return clean;
}

function withMarcacionesLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('No se pudo obtener el lock de la hoja (30s), intentá de nuevo');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function handleMarcacionesGetConfig(sessionRole) {
  assertMarcacionesAdmin(sessionRole);
  const sheet = ensureMarcacionesConfigSheet();
  const row = findMarcacionesConfigRow(sheet);
  if (row === -1) return jsonResponse({ ok: true, config: null });
  let config = null;
  try {
    config = JSON.parse(String(sheet.getRange(row, 2).getValue() || 'null'));
  } catch (err) {
    config = null;
  }
  return jsonResponse({
    ok: true,
    config: config,
    actualizado: String(sheet.getRange(row, 3).getDisplayValue() || ''),
    usuario: String(sheet.getRange(row, 4).getDisplayValue() || '')
  });
}

function handleMarcacionesSaveConfig(body, sessionUser, sessionRole) {
  assertMarcacionesAdmin(sessionRole);
  const clean = sanitizeMarcacionesConfig(body.data);
  const json = JSON.stringify(clean);
  if (json.length > MARCACIONES_CONFIG_MAX) throw new Error('Configuración demasiado grande');
  withMarcacionesLock(function () {
    const sheet = ensureMarcacionesConfigSheet();
    let row = findMarcacionesConfigRow(sheet);
    if (row === -1) row = Math.max(2, sheet.getLastRow() + 1);
    sheet.getRange(row, 1, 1, 4).setValues([[MARCACIONES_CONFIG_KEY, json, new Date(), sessionUser]]);
  });
  return jsonResponse({ ok: true });
}

function ensureMarcacionesDataSheet() {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(MARCACIONES_DATA_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MARCACIONES_DATA_SHEET_NAME);
    sheet.getRange(1, 1, 1, 5).setValues([['Mes', 'Parte', 'Datos JSON', 'Actualizado', 'Usuario']]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('@');
  }
  return sheet;
}

function validateMarcacionesMonth(month) {
  const value = String(month || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error('Mes inválido');
  return value;
}

function handleMarcacionesGetMonths(sessionRole) {
  assertMarcacionesAdmin(sessionRole);
  const sheet = ensureMarcacionesDataSheet();
  const last = sheet.getLastRow();
  const months = last < 2 ? [] : sheet.getRange(2, 1, last - 1, 1).getDisplayValues()
    .map(function (r) { return String(r[0] || '').trim(); })
    .filter(function (m, i, all) { return /^\d{4}-\d{2}$/.test(m) && all.indexOf(m) === i; })
    .sort();
  return jsonResponse({ ok: true, months: months });
}

function handleMarcacionesGetMonth(body, sessionRole) {
  assertMarcacionesAdmin(sessionRole);
  const month = validateMarcacionesMonth(body.month);
  const sheet = ensureMarcacionesDataSheet();
  const last = sheet.getLastRow();
  if (last < 2) return jsonResponse({ ok: true, month: month, data: null });
  const rows = sheet.getRange(2, 1, last - 1, 5).getValues()
    .filter(function (r) { return String(r[0]) === month; })
    .sort(function (a, b) { return Number(a[1]) - Number(b[1]); });
  if (!rows.length) return jsonResponse({ ok: true, month: month, data: null });
  const text = rows.map(function (r) { return String(r[2] || ''); }).join('');
  return jsonResponse({ ok: true, month: month, data: JSON.parse(text) });
}

function sanitizeMarcacionesMonthData(month, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Datos del mes inválidos');
  const regs = Array.isArray(data.regs) ? data.regs : [];
  if (regs.length > 60000) throw new Error('Demasiadas marcaciones para un mes');
  const cleanRegs = regs.map(function (r) {
    const id = String(r && r.id || '').trim();
    const f = String(r && r.f || '').trim();
    const seg = Number(r && r.seg);
    if (!/^\d{3,15}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(f) || f.slice(0, 7) !== month || !isFinite(seg) || seg < 0 || seg >= 86400) {
      throw new Error('Hay una marcación inválida o fuera del mes');
    }
    return { id: id, f: f, seg: Math.floor(seg) };
  });
  const editsIn = data.edits && typeof data.edits === 'object' && !Array.isArray(data.edits) ? data.edits : {};
  const edits = {};
  Object.keys(editsIn).forEach(function (key) {
    const m = /^(\d{3,15})\|(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!m || m[2].slice(0, 7) !== month) return;
    const e = editsIn[key] || {};
    const slots = Array.isArray(e.slots) ? e.slots.slice(0, 4).map(marcacionesHora) : null;
    edits[key] = { slots: slots, attendance: Boolean(e.attendance) };
  });
  const clean = {
    version: 1,
    info: String(data.info || '').slice(0, 500),
    regs: cleanRegs,
    edits: edits
  };
  const json = JSON.stringify(clean);
  if (json.length > MARCACIONES_DATA_MAX) throw new Error('El mes supera el tamaño máximo permitido');
  return { clean: clean, json: json };
}

function handleMarcacionesSaveMonth(body, sessionUser, sessionRole) {
  assertMarcacionesAdmin(sessionRole);
  const month = validateMarcacionesMonth(body.month);
  const prepared = sanitizeMarcacionesMonthData(month, body.data);
  withMarcacionesLock(function () {
    const sheet = ensureMarcacionesDataSheet();
    const last = sheet.getLastRow();
    if (last >= 2) {
      const existing = sheet.getRange(2, 1, last - 1, 1).getDisplayValues();
      for (let i = existing.length - 1; i >= 0; i--) {
        if (String(existing[i][0]) === month) sheet.deleteRow(i + 2);
      }
    }
    const chunks = [];
    for (let i = 0; i < prepared.json.length; i += MARCACIONES_DATA_CHUNK) {
      chunks.push([month, chunks.length + 1, prepared.json.slice(i, i + MARCACIONES_DATA_CHUNK), new Date(), sessionUser]);
    }
    if (!chunks.length) chunks.push([month, 1, '{}', new Date(), sessionUser]);
    sheet.getRange(sheet.getLastRow() + 1, 1, chunks.length, 5).setValues(chunks);
  });
  return jsonResponse({ ok: true, month: month, marks: prepared.clean.regs.length });
}

// Leer y guardar los horarios queda restringido a roles privilegiados
// (ADMINISTRADOR y SUPERUSUARIO), validado acá y no sólo en la interfaz.
function handleMarcacionesAction(action, body, sessionUser, sessionRole) {
  const routes = {
    marcacionesGetConfig: [function () { return handleMarcacionesGetConfig(sessionRole); }, 'MARCACIONES_GET_ERROR'],
    marcacionesSaveConfig: [function () { return handleMarcacionesSaveConfig(body, sessionUser, sessionRole); }, 'MARCACIONES_SAVE_ERROR'],
    marcacionesGetMonths: [function () { return handleMarcacionesGetMonths(sessionRole); }, 'MARCACIONES_MONTHS_ERROR'],
    marcacionesGetMonth: [function () { return handleMarcacionesGetMonth(body, sessionRole); }, 'MARCACIONES_MONTH_ERROR'],
    marcacionesSaveMonth: [function () { return handleMarcacionesSaveMonth(body, sessionUser, sessionRole); }, 'MARCACIONES_MONTH_SAVE_ERROR']
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route[0]();
  } catch (err) {
    return errorResponse(err.message, route[1]);
  }
}

// ===== AppsScript-Avisos.gs =====
/**
 * MÓDULO AVISOS (BUZÓN) - archivo aparte del backend de Control Clientes.
 *
 * Cuando alguien registra la recepción de documentación en la ficha de un
 * cliente, se le deja un aviso al Encargado de esa fila. Cada usuario ve sólo
 * sus avisos y los marca como leídos (no hay confirmación de recepción).
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "Avisos" y pegar
 *      este contenido completo.
 *   2. En doPost del Code.gs, justo antes de la línea
 *        return errorResponse('Acción desconocida: ' + action, 'UNKNOWN_ACTION');
 *      agregar:
 *        const avisosResponse = handleAvisosAction(action, body, sessionUser, sessionRole);
 *        if (avisosResponse) return avisosResponse;
 *   3. Implementar > Administrar implementaciones > editar > Nueva versión.
 *
 * Además, al registrar la recepción, pinta la fila del cliente (B a K) con el
 * color del Vencimiento de la columna A (acción recepcionPintarFila).
 *
 * Hoja "Avisos" en la planilla de administración (se crea sola), una fila por
 * aviso. Usa funciones de Code.gs: getAdminSpreadsheet, getAllowedUsers,
 * canonicalUserName, jsonResponse y errorResponse.
 */

const AVISOS_SHEET_NAME = 'Avisos';
const AVISOS_HEADERS = [
  'ID', 'Creado', 'Para', 'De', 'Año', 'Mes', 'Fila', 'Cliente', 'RUC',
  'Documentos', 'Nota', 'Vencimiento', 'Leído'
];
const AVISOS_COL_PARA = 3;
const AVISOS_COL_LEIDO = 13;
// Sólo se revisan los avisos más recientes: el buzón muestra los últimos días.
const AVISOS_MAX_FILAS_LEIDAS = 3000;
const AVISOS_MAX_DEVUELTOS = 200;
const AVISOS_DIAS_VISIBLES = 60;

function ensureAvisosSheet() {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(AVISOS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(AVISOS_SHEET_NAME);
    // Todo como texto: si no, Sheets convierte "OCTUBRE 2026" o el RUC en
    // fecha/número y el aviso deja de apuntar a la hoja del mes.
    sheet.getRange(1, 1, sheet.getMaxRows(), AVISOS_HEADERS.length).setNumberFormat('@');
    sheet.getRange(1, 1, 1, AVISOS_HEADERS.length).setValues([AVISOS_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

const AVISOS_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Avisos guardados antes de forzar el texto: Sheets convirtió el nombre de
// la hoja ("OCTUBRE 2026") en fecha. Se recupera buscando la hoja del año
// que tenga ese mes en el nombre.
function avisosMesDesdeFecha_(fecha, anio, cacheHojas) {
  const mes = AVISOS_MESES[fecha.getMonth()];
  const clave = String(anio || fecha.getFullYear());
  if (!Object.prototype.hasOwnProperty.call(cacheHojas, clave)) {
    try { cacheHojas[clave] = getAvailableSheets(clave); } catch (err) { cacheHojas[clave] = []; }
  }
  const variantes = mes === 'septiembre' ? ['septiembre', 'setiembre'] : [mes];
  const anioFecha = String(fecha.getFullYear());
  const candidatas = cacheHojas[clave].filter(function (nombre) {
    const n = normalizeText(nombre);
    return variantes.some(function (v) { return n.indexOf(v) !== -1; });
  });
  // Primero la que también tiene el año ("OCTUBRE 2026"), después cualquiera.
  const hoja = candidatas.filter(function (nombre) {
    return String(nombre).indexOf(anioFecha) !== -1;
  })[0] || candidatas[0];
  return hoja || (mes.charAt(0).toUpperCase() + mes.slice(1) + ' ' + fecha.getFullYear());
}

function avisosCeldaTexto_(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value === null || value === undefined ? '' : value);
}

function avisosTexto_(value, max) {
  return String(value === null || value === undefined ? '' : value).trim().slice(0, max);
}

function avisosMismoUsuario_(a, b) {
  return canonicalUserName(a) === canonicalUserName(b);
}

// Lee las últimas filas de la hoja como objetos (fila real incluida).
function avisosLeerRecientes_(sheet, opciones) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const resolverMes = Boolean(opciones && opciones.resolverMes);
  const cacheHojas = {};
  const desde = Math.max(2, lastRow - AVISOS_MAX_FILAS_LEIDAS + 1);
  const values = sheet.getRange(desde, 1, lastRow - desde + 1, AVISOS_HEADERS.length).getValues();
  return values.map(function (r, i) {
    let documentos = [];
    try { documentos = JSON.parse(r[9] || '[]'); } catch (err) { documentos = []; }
    const anio = r[4] instanceof Date ? String(r[4].getFullYear()) : avisosCeldaTexto_(r[4]).trim();
    let mes = avisosCeldaTexto_(r[5]);
    if (r[5] instanceof Date) {
      mes = resolverMes ? avisosMesDesdeFecha_(r[5], anio, cacheHojas) : '';
    }
    return {
      fila: desde + i,
      id: String(r[0] || ''),
      creado: avisosCeldaTexto_(r[1]),
      para: String(r[2] || ''),
      de: String(r[3] || ''),
      anio: anio,
      mes: mes,
      filaCliente: Number(r[6]) || 0,
      cliente: String(r[7] || ''),
      ruc: avisosCeldaTexto_(r[8]),
      documentos: Array.isArray(documentos) ? documentos : [],
      nota: String(r[10] || ''),
      vencimiento: r[11] instanceof Date ? Utilities.formatDate(r[11], Session.getScriptTimeZone(), 'dd/MM/yyyy') : String(r[11] || ''),
      leido: avisosCeldaTexto_(r[12])
    };
  });
}

function avisosPublico_(a) {
  return {
    id: a.id,
    creado: a.creado,
    de: a.de,
    anio: a.anio,
    mes: a.mes,
    fila: a.filaCliente,
    cliente: a.cliente,
    ruc: a.ruc,
    documentos: a.documentos,
    nota: a.nota,
    vencimiento: a.vencimiento,
    leido: Boolean(a.leido)
  };
}

function handleAvisosCrear(body, sessionUser) {
  const destinatario = getAllowedUsers().filter(function (u) {
    return avisosMismoUsuario_(u.nombre, body.para);
  })[0];
  if (!destinatario) {
    return errorResponse(
      'El Encargado "' + avisosTexto_(body.para, 80) + '" no es un usuario activo: no se pudo dejar el aviso.',
      'AVISO_DESTINATARIO'
    );
  }

  const anio = avisosTexto_(body.anio, 10);
  const mes = avisosTexto_(body.mes, 60);
  const fila = Number(body.fila);
  const cliente = avisosTexto_(body.cliente, 200);
  if (!anio || !mes || !(fila >= 2) || !cliente) {
    return errorResponse('Faltan datos del cliente para el aviso', 'AVISO_DATOS');
  }

  const documentos = (Array.isArray(body.documentos) ? body.documentos : [])
    .map(function (d) { return avisosTexto_(d, 80); })
    .filter(function (d) { return d; })
    .slice(0, 12);

  const id = Utilities.getUuid();
  const filaAviso = [
    id,
    new Date().toISOString(),
    destinatario.nombre,
    sessionUser,
    anio,
    mes,
    fila,
    cliente,
    avisosTexto_(body.ruc, 40),
    JSON.stringify(documentos),
    avisosTexto_(body.nota, 1000),
    avisosTexto_(body.vencimiento, 60),
    ''
  ].map(function (v) { return String(v); });

  // Se escribe como texto (no appendRow): así Sheets no convierte el mes ni
  // el RUC. El lock evita que dos avisos simultáneos pisen la misma fila.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return errorResponse('El buzón está ocupado, intentá de nuevo', 'AVISOS_LOCK_TIMEOUT');
  }
  try {
    const sheet = ensureAvisosSheet();
    const destino = sheet.getRange(sheet.getLastRow() + 1, 1, 1, AVISOS_HEADERS.length);
    destino.setNumberFormat('@');
    destino.setValues([filaAviso]);
  } finally {
    lock.releaseLock();
  }

  return jsonResponse({ ok: true, id: id, para: destinatario.nombre });
}

function handleAvisosListar(sessionUser) {
  const limite = Date.now() - AVISOS_DIAS_VISIBLES * 24 * 60 * 60 * 1000;
  const mios = avisosLeerRecientes_(ensureAvisosSheet(), { resolverMes: true }).filter(function (a) {
    if (!a.id || !avisosMismoUsuario_(a.para, sessionUser)) return false;
    const t = Date.parse(a.creado);
    return !isNaN(t) && t >= limite;
  });
  mios.reverse(); // más recientes primero
  const noLeidos = mios.filter(function (a) { return !a.leido; }).length;
  return jsonResponse({
    ok: true,
    avisos: mios.slice(0, AVISOS_MAX_DEVUELTOS).map(avisosPublico_),
    noLeidos: noLeidos
  });
}

// body.ids: lista de IDs a marcar; body.todos: true marca todos los propios.
function handleAvisosMarcarLeidos(body, sessionUser) {
  const ids = {};
  (Array.isArray(body.ids) ? body.ids : []).forEach(function (id) {
    ids[String(id)] = true;
  });
  const todos = body.todos === true;
  if (!todos && !Object.keys(ids).length) return jsonResponse({ ok: true, marcados: 0 });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return errorResponse('El buzón está ocupado, intentá de nuevo', 'AVISOS_LOCK_TIMEOUT');
  }
  let marcados = 0;
  try {
    const sheet = ensureAvisosSheet();
    const ahora = new Date().toISOString();
    avisosLeerRecientes_(sheet).forEach(function (a) {
      if (a.leido || !avisosMismoUsuario_(a.para, sessionUser)) return;
      if (!todos && !ids[a.id]) return;
      sheet.getRange(a.fila, AVISOS_COL_LEIDO).setValue(ahora);
      marcados++;
    });
  } finally {
    lock.releaseLock();
  }
  return jsonResponse({ ok: true, marcados: marcados });
}

// ── PINTAR LA FILA AL REGISTRAR LA RECEPCIÓN ─────────────────────────────
// Al registrar la documentación recibida, la fila del cliente se pinta de B
// a K con el color de su vencimiento, el mismo de Vencimientos IVA: VENC. =
// último dígito del RUC (sin DV), color configurado en "IVA Config" (o el
// de fábrica del módulo). Si la fila no tiene un RUC usable, el color sale
// de la columna A: su relleno, una regla de formato condicional que aplique
// a esa celda, u otra fila con el mismo vencimiento que tenga relleno.
const RECEPCION_COLOR_COL_REFERENCIA = 1; // A
const RECEPCION_COLOR_COL_DESDE = 2;      // B
const RECEPCION_COLOR_COL_HASTA = 11;     // K
// Mismos colores de fábrica que DEFAULT_COLORS de src/iva/ivaCore.js.
const RECEPCION_COLORES_IVA = {
  0: '#ffff99', 1: '#cc99ff', 2: '#4285f4', 3: '#ffcc99', 4: '#ccecff',
  5: '#ffff99', 6: '#b6d7a8', 7: '#ffccff', 8: '#cde9de', 9: '#8e7cc3'
};

// VENC. del cliente: último dígito del RUC, sin el DV ("80171953-3" -> 3).
function recepcionDigitoVenc_(sheet, row) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  let col = -1;
  headers.forEach(function (h, i) {
    const k = normalizeKey(h);
    if (col === -1 && (k === 'ruc' || k === 'nroruc' || k === 'ruccliente' || k.indexOf('ruc') === 0)) col = i;
  });
  if (col === -1) return null;
  const ruc = String(sheet.getRange(row, col + 1).getDisplayValue() || '').split('-')[0].replace(/\D/g, '');
  return ruc ? Number(ruc.slice(-1)) : null;
}

function recepcionColorIva_(digito) {
  let config = null;
  try { config = typeof readIvaConfig === 'function' ? readIvaConfig() : null; } catch (err) { config = null; }
  const propio = config && config.colores ? config.colores[digito] : '';
  return /^#[0-9a-f]{6}$/i.test(String(propio || '')) ? String(propio) : RECEPCION_COLORES_IVA[digito];
}

function recepcionColorValido_(color) {
  const c = String(color || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(c) && c !== '#ffffff';
}

function recepcionCumpleCondicion_(condicion, valor) {
  const tipos = SpreadsheetApp.BooleanCriteria;
  const tipo = condicion.getCriteriaType();
  const criterios = condicion.getCriteriaValues() || [];
  const texto = normalizeText(valor);
  const c0 = normalizeText(criterios[0]);
  const numero = Number(String(valor).replace(/[^0-9.,-]/g, '').replace(',', '.'));
  switch (tipo) {
    case tipos.TEXT_EQUAL_TO: return texto === c0;
    case tipos.TEXT_CONTAINS: return texto.indexOf(c0) !== -1;
    case tipos.TEXT_NOT_CONTAINS: return texto.indexOf(c0) === -1;
    case tipos.TEXT_STARTS_WITH: return texto.indexOf(c0) === 0;
    case tipos.TEXT_ENDS_WITH: return c0 !== '' && texto.slice(-c0.length) === c0;
    case tipos.NUMBER_EQUAL_TO: return !isNaN(numero) && numero === Number(criterios[0]);
    case tipos.NUMBER_BETWEEN: return !isNaN(numero) && numero >= Number(criterios[0]) && numero <= Number(criterios[1]);
    case tipos.NUMBER_GREATER_THAN: return !isNaN(numero) && numero > Number(criterios[0]);
    case tipos.NUMBER_GREATER_THAN_OR_EQUAL_TO: return !isNaN(numero) && numero >= Number(criterios[0]);
    case tipos.NUMBER_LESS_THAN: return !isNaN(numero) && numero < Number(criterios[0]);
    case tipos.NUMBER_LESS_THAN_OR_EQUAL_TO: return !isNaN(numero) && numero <= Number(criterios[0]);
    default: return false; // fórmulas personalizadas y otros tipos no se evalúan
  }
}

function recepcionColorDeVencimiento_(sheet, row) {
  const celda = sheet.getRange(row, RECEPCION_COLOR_COL_REFERENCIA);
  const relleno = celda.getBackground();
  if (recepcionColorValido_(relleno)) return { color: relleno, origen: 'celda' };

  const valor = celda.getDisplayValue();
  const reglas = sheet.getConditionalFormatRules ? sheet.getConditionalFormatRules() : [];
  for (let i = 0; i < reglas.length; i++) {
    const condicion = reglas[i].getBooleanCondition();
    if (!condicion) continue;
    const color = condicion.getBackground();
    if (!recepcionColorValido_(color)) continue;
    const aplica = reglas[i].getRanges().some(function (r) {
      return row >= r.getRow() && row <= r.getLastRow() &&
        RECEPCION_COLOR_COL_REFERENCIA >= r.getColumn() && RECEPCION_COLOR_COL_REFERENCIA <= r.getLastColumn();
    });
    if (aplica && recepcionCumpleCondicion_(condicion, valor)) return { color: color, origen: 'formato condicional' };
  }

  // Otra fila con el mismo vencimiento que sí tenga relleno en A.
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2 && normalizeText(valor)) {
    const valores = sheet.getRange(2, RECEPCION_COLOR_COL_REFERENCIA, lastRow - 1, 1).getDisplayValues();
    const fondos = sheet.getRange(2, RECEPCION_COLOR_COL_REFERENCIA, lastRow - 1, 1).getBackgrounds();
    for (let j = 0; j < valores.length; j++) {
      if (normalizeText(valores[j][0]) === normalizeText(valor) && recepcionColorValido_(fondos[j][0])) {
        return { color: fondos[j][0], origen: 'otra fila con el mismo vencimiento' };
      }
    }
  }
  return null;
}

function handleRecepcionPintarFila(body, sessionUser) {
  const sheet = getMonthSheet(body.year, body.sheet);
  if (!sheet) {
    return errorResponse('Año/mes "' + body.year + ' / ' + body.sheet + '" no válido', 'SHEET_NOT_FOUND');
  }
  const row = Number(body.row);
  if (!(row >= 2) || row > sheet.getLastRow()) return errorResponse('Fila inválida', 'ROW_INVALID');

  const digito = recepcionDigitoVenc_(sheet, row);
  const encontrado = digito !== null
    ? { color: recepcionColorIva_(digito), origen: 'vencimientos IVA (VENC. ' + digito + ')' }
    : recepcionColorDeVencimiento_(sheet, row);
  if (!encontrado) {
    return jsonResponse({
      ok: true,
      pintado: false,
      motivo: 'El cliente no tiene RUC y el Vencimiento de la columna A no tiene un color definido.'
    });
  }

  const ancho = RECEPCION_COLOR_COL_HASTA - RECEPCION_COLOR_COL_DESDE + 1;
  const destino = sheet.getRange(row, RECEPCION_COLOR_COL_DESDE, 1, ancho);
  const anterior = destino.getBackground();
  destino.setBackground(encontrado.color);
  logChange(sessionUser, body.year, body.sheet, row, 'Color B:K', anterior, encontrado.color);
  return jsonResponse({ ok: true, pintado: true, color: encontrado.color, origen: encontrado.origen, digito: digito });
}

function handleAvisosAction(action, body, sessionUser, sessionRole) {
  // Las sugerencias (AppsScript-Sugerencias.gs), las preferencias y los libros
  // IVA entran por acá para no tener que tocar doPost otra vez.
  if (String(action).indexOf('sugerencias') === 0 && typeof handleSugerenciasAction === 'function') {
    return handleSugerenciasAction(action, body, sessionUser, sessionRole);
  }
  // Preferencias de cada usuario (AppsScript-Preferencias.gs).
  if (String(action).indexOf('preferencias') === 0 && typeof handlePreferenciasAction === 'function') {
    return handlePreferenciasAction(action, body, sessionUser, sessionRole);
  }
  // Libros IVA de compras y ventas importados de SIGA (AppsScript-Libros.gs).
  if (String(action).indexOf('libros') === 0 && typeof handleLibrosAction === 'function') {
    return handleLibrosAction(action, body, sessionUser, sessionRole);
  }
  // Asistente con IA y envío de fichas por Whaticket (AppsScript-Agente.gs).
  if ((String(action).indexOf('agente') === 0 || String(action).indexOf('whaticket') === 0) &&
      typeof handleAgenteAction === 'function') {
    return handleAgenteAction(action, body, sessionUser, sessionRole);
  }
  const routes = {
    avisosCrear: [function () { return handleAvisosCrear(body, sessionUser); }, 'AVISOS_CREAR_ERROR'],
    avisosListar: [function () { return handleAvisosListar(sessionUser); }, 'AVISOS_LISTAR_ERROR'],
    avisosMarcarLeidos: [function () { return handleAvisosMarcarLeidos(body, sessionUser); }, 'AVISOS_LEIDOS_ERROR'],
    recepcionPintarFila: [function () { return handleRecepcionPintarFila(body, sessionUser); }, 'RECEPCION_PINTAR_ERROR']
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route[0]();
  } catch (err) {
    return errorResponse(err.message, route[1]);
  }
}

// ===== AppsScript-Sugerencias.gs =====
/**
 * MÓDULO SUGERENCIAS - archivo aparte del backend de Control Clientes.
 *
 * Cualquier usuario deja sugerencias para mejorar el sistema (recomendación,
 * fallo, consejo u otro). ADMINISTRADOR y SUPERUSUARIO ven todas, con el
 * nombre de quien la escribió, y las marcan como vistas o resueltas. Los
 * demás ven sólo las suyas y en qué estado están.
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "Sugerencias" y
 *      pegar este contenido completo.
 *   2. No hace falta tocar Code.gs: las acciones sugerencias* llegan por
 *      handleAvisosAction (AppsScript-Avisos.gs), que ya está en doPost.
 *   3. Implementar > Administrar implementaciones > editar > Nueva versión.
 *
 * Hoja "Sugerencias" en la planilla de administración (se crea sola), una
 * fila por sugerencia. Usa funciones de Code.gs: getAdminSpreadsheet,
 * canonicalUserName, normalizeRole, jsonResponse y errorResponse.
 */

const SUGERENCIAS_SHEET_NAME = 'Sugerencias';
const SUGERENCIAS_HEADERS = [
  'ID', 'Creada', 'Usuario', 'Rol', 'Tipo', 'Sección', 'Texto', 'Estado', 'Revisada por', 'Revisada el'
];
const SUGERENCIAS_COL_ESTADO = 8;
const SUGERENCIAS_TIPOS = ['recomendacion', 'fallo', 'consejo', 'otro'];
const SUGERENCIAS_ESTADOS = ['nueva', 'vista', 'resuelta'];
const SUGERENCIAS_MAX_TEXTO = 1500;
const SUGERENCIAS_MAX_FILAS_LEIDAS = 3000;
const SUGERENCIAS_MAX_DEVUELTAS = 300;
const SUGERENCIAS_MAX_POR_DIA = 30; // por usuario, para frenar envíos repetidos

function ensureSugerenciasSheet() {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(SUGERENCIAS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SUGERENCIAS_SHEET_NAME);
    // Todo como texto: Sheets no convierte fechas ni números escritos.
    sheet.getRange(1, 1, sheet.getMaxRows(), SUGERENCIAS_HEADERS.length).setNumberFormat('@');
    sheet.getRange(1, 1, 1, SUGERENCIAS_HEADERS.length).setValues([SUGERENCIAS_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(7, 420);
  }
  return sheet;
}

function sugerenciasEsAdmin_(sessionRole) {
  const rol = normalizeRole(sessionRole);
  return rol === 'ADMINISTRADOR' || rol === 'SUPERUSUARIO';
}

function sugerenciasTexto_(value, max) {
  if (value instanceof Date) return value.toISOString();
  return String(value === null || value === undefined ? '' : value).trim().slice(0, max);
}

function sugerenciasLeer_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const desde = Math.max(2, lastRow - SUGERENCIAS_MAX_FILAS_LEIDAS + 1);
  const values = sheet.getRange(desde, 1, lastRow - desde + 1, SUGERENCIAS_HEADERS.length).getValues();
  return values.map(function (r, i) {
    const estado = sugerenciasTexto_(r[7], 20).toLowerCase();
    return {
      fila: desde + i,
      id: sugerenciasTexto_(r[0], 60),
      creada: sugerenciasTexto_(r[1], 40),
      usuario: sugerenciasTexto_(r[2], 120),
      rol: sugerenciasTexto_(r[3], 40),
      tipo: sugerenciasTexto_(r[4], 20).toLowerCase(),
      seccion: sugerenciasTexto_(r[5], 60),
      texto: sugerenciasTexto_(r[6], SUGERENCIAS_MAX_TEXTO),
      estado: SUGERENCIAS_ESTADOS.indexOf(estado) >= 0 ? estado : 'nueva',
      revisadaPor: sugerenciasTexto_(r[8], 120),
      revisadaEl: sugerenciasTexto_(r[9], 40)
    };
  }).filter(function (s) { return s.id; });
}

function sugerenciasPublica_(s) {
  return {
    id: s.id,
    creada: s.creada,
    usuario: s.usuario,
    rol: s.rol,
    tipo: s.tipo,
    seccion: s.seccion,
    texto: s.texto,
    estado: s.estado,
    revisadaPor: s.revisadaPor,
    revisadaEl: s.revisadaEl
  };
}

function handleSugerenciasCrear(body, sessionUser, sessionRole) {
  const tipo = sugerenciasTexto_(body.tipo, 20).toLowerCase();
  if (SUGERENCIAS_TIPOS.indexOf(tipo) < 0) {
    return errorResponse('Elegí el tipo de sugerencia', 'SUGERENCIA_TIPO');
  }
  const texto = String(body.texto === null || body.texto === undefined ? '' : body.texto).trim();
  if (texto.length < 3) return errorResponse('Escribí tu sugerencia', 'SUGERENCIA_VACIA');
  if (texto.length > SUGERENCIAS_MAX_TEXTO) {
    return errorResponse('La sugerencia es muy larga (máximo ' + SUGERENCIAS_MAX_TEXTO + ' caracteres)', 'SUGERENCIA_LARGA');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return errorResponse('Las sugerencias están ocupadas, intentá de nuevo', 'SUGERENCIAS_LOCK_TIMEOUT');
  }
  try {
    const sheet = ensureSugerenciasSheet();
    const haceUnDia = Date.now() - 24 * 60 * 60 * 1000;
    const usuario = canonicalUserName(sessionUser);
    const hoy = sugerenciasLeer_(sheet).filter(function (s) {
      return canonicalUserName(s.usuario) === usuario && Date.parse(s.creada) >= haceUnDia;
    }).length;
    if (hoy >= SUGERENCIAS_MAX_POR_DIA) {
      return errorResponse('Llegaste al máximo de sugerencias por hoy. Probá mañana.', 'SUGERENCIAS_LIMITE');
    }
    const id = 'sg-' + Utilities.getUuid();
    const fila = [
      id,
      new Date().toISOString(),
      sessionUser,
      normalizeRole(sessionRole) || '',
      tipo,
      sugerenciasTexto_(body.seccion, 60),
      texto,
      'nueva',
      '',
      ''
    ].map(function (v) { return String(v); });
    const destino = sheet.getRange(sheet.getLastRow() + 1, 1, 1, SUGERENCIAS_HEADERS.length);
    destino.setNumberFormat('@');
    destino.setValues([fila]);
    return jsonResponse({ ok: true, id: id });
  } finally {
    lock.releaseLock();
  }
}

// Administradores: todas. Resto: sólo las propias.
function handleSugerenciasListar(sessionUser, sessionRole) {
  const admin = sugerenciasEsAdmin_(sessionRole);
  const usuario = canonicalUserName(sessionUser);
  const lista = sugerenciasLeer_(ensureSugerenciasSheet()).filter(function (s) {
    return admin || canonicalUserName(s.usuario) === usuario;
  });
  lista.reverse(); // más recientes primero
  return jsonResponse({
    ok: true,
    admin: admin,
    sugerencias: lista.slice(0, SUGERENCIAS_MAX_DEVUELTAS).map(sugerenciasPublica_),
    nuevas: admin ? lista.filter(function (s) { return s.estado === 'nueva'; }).length : 0
  });
}

// body.ids + body.estado ('vista' | 'resuelta' | 'nueva'). Sólo administradores.
function handleSugerenciasEstado(body, sessionUser, sessionRole) {
  if (!sugerenciasEsAdmin_(sessionRole)) {
    return errorResponse('Sólo un administrador puede cambiar el estado', 'FORBIDDEN');
  }
  const estado = sugerenciasTexto_(body.estado, 20).toLowerCase();
  if (SUGERENCIAS_ESTADOS.indexOf(estado) < 0) return errorResponse('Estado no válido', 'SUGERENCIA_ESTADO');
  const ids = {};
  (Array.isArray(body.ids) ? body.ids : []).forEach(function (id) { ids[String(id)] = true; });
  if (!Object.keys(ids).length) return jsonResponse({ ok: true, cambiadas: 0 });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return errorResponse('Las sugerencias están ocupadas, intentá de nuevo', 'SUGERENCIAS_LOCK_TIMEOUT');
  }
  let cambiadas = 0;
  try {
    const sheet = ensureSugerenciasSheet();
    const ahora = new Date().toISOString();
    sugerenciasLeer_(sheet).forEach(function (s) {
      if (!ids[s.id] || s.estado === estado) return;
      // "vista" no pisa una "resuelta" (al abrir la lista se marcan vistas).
      if (estado === 'vista' && s.estado === 'resuelta') return;
      const celdas = sheet.getRange(s.fila, SUGERENCIAS_COL_ESTADO, 1, 3);
      celdas.setNumberFormat('@');
      celdas.setValues([[estado, estado === 'nueva' ? '' : String(sessionUser), estado === 'nueva' ? '' : ahora]]);
      cambiadas++;
    });
  } finally {
    lock.releaseLock();
  }
  return jsonResponse({ ok: true, cambiadas: cambiadas });
}

function handleSugerenciasAction(action, body, sessionUser, sessionRole) {
  const routes = {
    sugerenciasCrear: [function () { return handleSugerenciasCrear(body, sessionUser, sessionRole); }, 'SUGERENCIAS_CREAR_ERROR'],
    sugerenciasListar: [function () { return handleSugerenciasListar(sessionUser, sessionRole); }, 'SUGERENCIAS_LISTAR_ERROR'],
    sugerenciasEstado: [function () { return handleSugerenciasEstado(body, sessionUser, sessionRole); }, 'SUGERENCIAS_ESTADO_ERROR']
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route[0]();
  } catch (err) {
    return errorResponse(err.message, route[1]);
  }
}

// ===== AppsScript-Preferencias.gs =====
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

// ===== AppsScript-Libros.gs =====
/**
 * MÓDULO LIBROS IVA - archivo aparte del backend de Control Clientes.
 *
 * Guarda los libros de COMPRAS y VENTAS que se exportan de SIGA (Excel) e
 * importan desde la app, uno por cliente + mes + tipo, para consultarlos
 * después. La app lee el Excel y manda los comprobantes ya ordenados.
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "Libros" y pegar
 *      este contenido completo.
 *   2. No hace falta tocar Code.gs: las acciones libros* llegan por
 *      handleAvisosAction (AppsScript-Avisos.gs), que ya está en doPost.
 *   3. Implementar > Administrar implementaciones > editar > Nueva versión.
 *
 * Hoja "Libros IVA" en la planilla de administración (se crea sola): una fila
 * por libro. Las columnas 1 a 10 son el índice; el detalle de comprobantes
 * (JSON) va desde la columna 11 repartido en celdas de hasta 45.000
 * caracteres (Google admite 50.000 por celda).
 * Todos los usuarios ven e importan; sólo ADMINISTRADOR y SUPERUSUARIO borran.
 * Usa funciones de Code.gs: getAdminSpreadsheet, normalizeRole, jsonResponse
 * y errorResponse.
 */

const LIBROS_SHEET_NAME = 'Libros IVA';
const LIBROS_HEADERS = [
  'ID', 'Tipo', 'RUC cliente', 'Cliente', 'Período', 'Archivo', 'Comprobantes',
  'Totales', 'Importado por', 'Importado el'
];
const LIBROS_COL_DATOS = LIBROS_HEADERS.length + 1; // 11
const LIBROS_TROZO = 45000;
const LIBROS_MAX_COMPROBANTES = 5000;
const LIBROS_MAX_JSON = 2 * 1000 * 1000; // ~2 MB de detalle por libro
const LIBROS_TIPOS = ['compras', 'ventas'];

function ensureLibrosSheet() {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(LIBROS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LIBROS_SHEET_NAME);
    sheet.getRange(1, 1, 1, LIBROS_HEADERS.length).setValues([LIBROS_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function librosEsAdmin_(sessionRole) {
  const rol = normalizeRole(sessionRole);
  return rol === 'ADMINISTRADOR' || rol === 'SUPERUSUARIO';
}

function librosTexto_(v, max) {
  if (v instanceof Date) return v.toISOString();
  return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 500);
}

// Índice de todos los libros (sin el detalle).
function librosLeerIndice_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, LIBROS_HEADERS.length).getValues();
  const out = [];
  values.forEach(function (r, i) {
    const id = librosTexto_(r[0], 80);
    if (!id) return;
    let totales = {};
    try { totales = JSON.parse(String(r[7] || '{}')) || {}; } catch (e) { totales = {}; }
    out.push({
      fila: i + 2,
      id: id,
      tipo: librosTexto_(r[1], 20),
      ruc: librosTexto_(r[2], 30).replace(/\D/g, ''),
      cliente: librosTexto_(r[3], 200),
      periodo: librosTexto_(r[4], 10),
      archivo: librosTexto_(r[5], 200),
      cantidad: Number(r[6]) || 0,
      totales: totales,
      importadoPor: librosTexto_(r[8], 120),
      importadoEl: librosTexto_(r[9], 40)
    });
  });
  return out;
}

function librosPublico_(l) {
  return {
    id: l.id, tipo: l.tipo, ruc: l.ruc, cliente: l.cliente, periodo: l.periodo,
    archivo: l.archivo, cantidad: l.cantidad, totales: l.totales,
    importadoPor: l.importadoPor, importadoEl: l.importadoEl
  };
}

// body.ruc opcional: sólo los libros de ese cliente.
function handleLibrosListar(body) {
  const ruc = librosTexto_(body.ruc, 30).replace(/\D/g, '');
  const lista = librosLeerIndice_(ensureLibrosSheet())
    .filter(function (l) { return !ruc || l.ruc === ruc; })
    .map(librosPublico_);
  return jsonResponse({ ok: true, libros: lista });
}

function handleLibrosLeer(body) {
  const id = librosTexto_(body.id, 80);
  const sheet = ensureLibrosSheet();
  const libro = librosLeerIndice_(sheet).filter(function (l) { return l.id === id; })[0];
  if (!libro) return errorResponse('No se encontró ese libro', 'LIBRO_NO_EXISTE');
  const ancho = Math.max(sheet.getLastColumn() - LIBROS_COL_DATOS + 1, 1);
  const trozos = sheet.getRange(libro.fila, LIBROS_COL_DATOS, 1, ancho).getValues()[0];
  let datos = null;
  try { datos = JSON.parse(trozos.map(function (t) { return String(t || ''); }).join('')); } catch (e) { datos = null; }
  if (!datos) return errorResponse('El detalle de ese libro está dañado: volvé a importarlo', 'LIBRO_DANADO');
  const out = librosPublico_(libro);
  out.datos = datos;
  return jsonResponse({ ok: true, libro: out });
}

// body: { tipo, ruc, cliente, periodo, archivo, totales, datos, reemplazar }
// datos = { columnas: [...], filas: [[...], ...] } tal como lo arma la app.
function handleLibrosGuardar(body, sessionUser) {
  const tipo = librosTexto_(body.tipo, 20).toLowerCase();
  if (LIBROS_TIPOS.indexOf(tipo) < 0) return errorResponse('Tipo de libro no válido', 'LIBRO_TIPO');
  const ruc = librosTexto_(body.ruc, 30).replace(/\D/g, '');
  if (!ruc) return errorResponse('Elegí el cliente del libro', 'LIBRO_CLIENTE');
  const periodo = librosTexto_(body.periodo, 10);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) return errorResponse('Mes o año no válido', 'LIBRO_PERIODO');
  const datos = body.datos;
  if (!datos || !Array.isArray(datos.columnas) || !Array.isArray(datos.filas)) {
    return errorResponse('El libro no tiene comprobantes', 'LIBRO_VACIO');
  }
  if (datos.filas.length > LIBROS_MAX_COMPROBANTES) {
    return errorResponse('El libro tiene demasiados comprobantes (máximo ' + LIBROS_MAX_COMPROBANTES + ')', 'LIBRO_GRANDE');
  }
  const json = JSON.stringify({ columnas: datos.columnas, filas: datos.filas, resumen: Array.isArray(datos.resumen) ? datos.resumen : [] });
  if (json.length > LIBROS_MAX_JSON) return errorResponse('El libro es demasiado grande', 'LIBRO_GRANDE');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return errorResponse('Los libros están ocupados, intentá de nuevo', 'LIBROS_LOCK_TIMEOUT');
  try {
    const sheet = ensureLibrosSheet();
    const existente = librosLeerIndice_(sheet).filter(function (l) {
      return l.tipo === tipo && l.ruc === ruc && l.periodo === periodo;
    })[0];
    if (existente && body.reemplazar !== true) {
      return jsonResponse({ ok: false, code: 'LIBRO_EXISTE', error: 'Ya hay un libro cargado para ese cliente y mes', existente: librosPublico_(existente) });
    }
    const id = existente ? existente.id : 'lb-' + Utilities.getUuid();
    const fila = existente ? existente.fila : sheet.getLastRow() + 1;
    const indice = [
      id, tipo, ruc, librosTexto_(body.cliente, 200), periodo, librosTexto_(body.archivo, 200),
      String(datos.filas.length), JSON.stringify(body.totales || {}).slice(0, 5000),
      String(sessionUser), new Date().toISOString()
    ];
    const trozos = [];
    for (let i = 0; i < json.length; i += LIBROS_TROZO) trozos.push(json.slice(i, i + LIBROS_TROZO));
    // Al reemplazar se limpian los trozos viejos que sobren.
    const anchoViejo = Math.max(sheet.getLastColumn() - LIBROS_COL_DATOS + 1, 0);
    if (existente && anchoViejo > 0) sheet.getRange(fila, LIBROS_COL_DATOS, 1, anchoViejo).clearContent();
    const todo = indice.concat(trozos);
    const rango = sheet.getRange(fila, 1, 1, todo.length);
    rango.setNumberFormat('@'); // texto: Sheets no convierte números ni fechas
    rango.setValues([todo.map(function (v) { return String(v); })]);
    return jsonResponse({ ok: true, id: id, reemplazado: !!existente });
  } finally {
    lock.releaseLock();
  }
}

function handleLibrosEliminar(body, sessionRole) {
  if (!librosEsAdmin_(sessionRole)) return errorResponse('Sólo un administrador puede eliminar libros', 'FORBIDDEN');
  const id = librosTexto_(body.id, 80);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return errorResponse('Los libros están ocupados, intentá de nuevo', 'LIBROS_LOCK_TIMEOUT');
  try {
    const sheet = ensureLibrosSheet();
    const libro = librosLeerIndice_(sheet).filter(function (l) { return l.id === id; })[0];
    if (!libro) return errorResponse('No se encontró ese libro', 'LIBRO_NO_EXISTE');
    sheet.deleteRow(libro.fila);
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function handleLibrosAction(action, body, sessionUser, sessionRole) {
  const routes = {
    librosListar: [function () { return handleLibrosListar(body); }, 'LIBROS_LISTAR_ERROR'],
    librosLeer: [function () { return handleLibrosLeer(body); }, 'LIBROS_LEER_ERROR'],
    librosGuardar: [function () { return handleLibrosGuardar(body, sessionUser); }, 'LIBROS_GUARDAR_ERROR'],
    librosEliminar: [function () { return handleLibrosEliminar(body, sessionRole); }, 'LIBROS_ELIMINAR_ERROR']
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route[0]();
  } catch (err) {
    return errorResponse(err.message, route[1]);
  }
}

// ===== AppsScript-Agente.gs =====
/**
 * MÓDULO ASISTENTE (IA) — archivo aparte del backend.
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "Agente" y pegar este
 *      contenido completo.
 *   2. Pegar también la versión nueva de AppsScript-Avisos.gs: su router ya
 *      deriva acá las acciones que empiezan con "agente" y "whaticket" (estas
 *      últimas siguen a AppsScript-Whaticket.gs), así que NO hace falta tocar
 *      doPost.
 *   3. Configuración del proyecto > Propiedades de la secuencia de comandos:
 *        ANTHROPIC_API_KEY        clave de console.anthropic.com (obligatoria
 *                                 para el asistente).
 *        AGENTE_MODELO            opcional. Por defecto "claude-haiku-5-5".
 *        AGENTE_ESFUERZO          opcional. low | medium | high (por
 *                                 defecto medium).
 *        AGENTE_LIMITE_DIARIO     opcional. Consultas a la IA por usuario y
 *                                 por día. Por defecto 200.
 *   4. Implementar > Administrar implementaciones > editar > Nueva versión.
 *
 * La clave de la IA vive SÓLO acá (Script Properties): nunca se manda al
 * navegador ni va en el .env de Vite.
 *
 * Diseño del asistente: este archivo es un intermediario seguro hacia la API
 * de Claude. Las herramientas del asistente (buscar clientes, ver el IVA...)
 * corren en la app, con los mismos datos y permisos que ya ve el usuario;
 * acá se valida la sesión, se fija el modelo y el tope de respuesta, se
 * controla el límite diario y se registra el consumo en la hoja "Agente Uso".
 *
 * Usa funciones de Code.gs: getAdminSpreadsheet, jsonResponse, errorResponse.
 */

const AGENTE_API_URL = 'https://api.anthropic.com/v1/messages';
const AGENTE_API_VERSION = '2023-06-01';
const AGENTE_MODELO_DEFAULT = 'claude-haiku-5-5';
// Incluye el "pensamiento" del modelo (Haiku 5.5 piensa por defecto) más la
// respuesta. El texto final suele ser corto; el tope sólo evita excesos.
const AGENTE_MAX_TOKENS = 4000;
// Esfuerzo del modelo: low | medium | high. "medium" equilibra calidad y costo.
const AGENTE_ESFUERZO_DEFAULT = 'medium';
const AGENTE_LIMITE_DIARIO_DEFAULT = 200;
const AGENTE_MAX_PAYLOAD_CHARS = 400000;
const AGENTE_MAX_MENSAJES = 80;
const AGENTE_MAX_HERRAMIENTAS = 20;
const AGENTE_USO_SHEET_NAME = 'Agente Uso';
const AGENTE_CUENTA_PROPERTY = 'AGENTE_CUENTA_DIARIA';

// Precios en USD por millón de tokens (entrada, salida, lectura de caché,
// escritura de caché) para estimar el costo en la hoja de uso. Si se cambia
// AGENTE_MODELO a uno que no está acá, el costo queda en blanco.
const AGENTE_PRECIOS = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.10, cacheWrite: 2.5 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.20, cacheWrite: 5 }
};

// ── CONFIGURACIÓN ───────────────────────────────────────────────────────
function agenteProp(name) {
  return String(PropertiesService.getScriptProperties().getProperty(name) || '').trim();
}

function agenteConfig() {
  const limite = parseInt(agenteProp('AGENTE_LIMITE_DIARIO'), 10);
  const esfuerzo = agenteProp('AGENTE_ESFUERZO').toLowerCase();
  return {
    apiKey: agenteProp('ANTHROPIC_API_KEY'),
    modelo: agenteProp('AGENTE_MODELO') || AGENTE_MODELO_DEFAULT,
    esfuerzo: /^(low|medium|high)$/.test(esfuerzo) ? esfuerzo : AGENTE_ESFUERZO_DEFAULT,
    limiteDiario: limite > 0 ? limite : AGENTE_LIMITE_DIARIO_DEFAULT
  };
}

function hoyIso() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Asuncion', 'yyyy-MM-dd');
}

function ensureLogSheet(name, headers) {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ── LÍMITE DIARIO POR USUARIO ───────────────────────────────────────────
// Un solo JSON en Script Properties con la fecha y el contador de cada
// usuario; al cambiar el día se reinicia.
function leerCuentaDiaria() {
  const hoy = hoyIso();
  let data = null;
  try {
    data = JSON.parse(agenteProp(AGENTE_CUENTA_PROPERTY) || 'null');
  } catch (err) {
    data = null;
  }
  if (!data || data.fecha !== hoy || typeof data.usuarios !== 'object') {
    data = { fecha: hoy, usuarios: {} };
  }
  return data;
}

function usadasHoy(sessionUser) {
  return Number(leerCuentaDiaria().usuarios[sessionUser]) || 0;
}

// Suma una consulta si todavía hay cupo. Devuelve false si se alcanzó el límite.
function reservarConsulta(sessionUser, limite) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('El servidor está ocupado, probá de nuevo en unos segundos');
  try {
    const data = leerCuentaDiaria();
    const actual = Number(data.usuarios[sessionUser]) || 0;
    if (actual >= limite) return false;
    data.usuarios[sessionUser] = actual + 1;
    PropertiesService.getScriptProperties().setProperty(AGENTE_CUENTA_PROPERTY, JSON.stringify(data));
    return true;
  } finally {
    lock.releaseLock();
  }
}

// ── VALIDACIÓN DEL PEDIDO ───────────────────────────────────────────────
// Sólo se reenvía a la API lo que hace falta y con la forma esperada: el
// modelo, el tope de respuesta y el resto de los parámetros los fija el
// servidor, no el navegador.
// Lo que escribe la persona (o la app con resultados de herramientas) y lo que
// devolvió el modelo. Los bloques de "pensamiento" (thinking y
// redacted_thinking) los genera Haiku 5.5 por defecto y la API exige que
// vuelvan tal cual en la conversación con herramientas.
const AGENTE_BLOQUES_PERMITIDOS = {
  user: { text: true, tool_result: true },
  assistant: { text: true, tool_use: true, thinking: true, redacted_thinking: true }
};

function limpiarSystem(system) {
  if (typeof system === 'string') return system.slice(0, 60000);
  if (!Array.isArray(system)) throw new Error('Instrucciones del asistente inválidas');
  return system.slice(0, 4).map(function (b) {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') throw new Error('Instrucciones del asistente inválidas');
    return { type: 'text', text: b.text.slice(0, 60000) };
  });
}

function limpiarHerramientas(tools) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools) || tools.length > AGENTE_MAX_HERRAMIENTAS) throw new Error('Herramientas inválidas');
  return tools.map(function (t) {
    if (!t || typeof t.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name) ||
        typeof t.input_schema !== 'object' || t.input_schema === null) {
      throw new Error('Herramienta inválida');
    }
    return { name: t.name, description: String(t.description || '').slice(0, 4000), input_schema: t.input_schema };
  });
}

function limpiarMensajes(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > AGENTE_MAX_MENSAJES) {
    throw new Error('Conversación inválida o demasiado larga: empezá una nueva');
  }
  return messages.map(function (m) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw new Error('Mensaje inválido');
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    if (!Array.isArray(m.content)) throw new Error('Mensaje inválido');
    const permitidos = AGENTE_BLOQUES_PERMITIDOS[m.role];
    m.content.forEach(function (b) {
      if (!b || !permitidos[b.type]) throw new Error('Tipo de contenido no permitido (' + (b && b.type) + ')');
    });
    return { role: m.role, content: m.content };
  });
}

// ── LLAMADA A LA API DE CLAUDE ──────────────────────────────────────────
function handleAgenteMensaje(body, sessionUser) {
  const cfg = agenteConfig();
  if (!cfg.apiKey) {
    return errorResponse('El asistente no está configurado: falta ANTHROPIC_API_KEY en las propiedades del Apps Script.', 'AGENTE_SIN_CLAVE');
  }

  const payload = {
    model: cfg.modelo,
    max_tokens: AGENTE_MAX_TOKENS,
    output_config: { effort: cfg.esfuerzo },
    // Caché automático: las instrucciones, las herramientas y lo ya hablado
    // se cobran ~10 veces más barato en las consultas siguientes.
    cache_control: { type: 'ephemeral' },
    system: limpiarSystem(body.system),
    messages: limpiarMensajes(body.messages)
  };
  const tools = limpiarHerramientas(body.tools);
  if (tools.length) payload.tools = tools;

  const json = JSON.stringify(payload);
  if (json.length > AGENTE_MAX_PAYLOAD_CHARS) {
    return errorResponse('La conversación quedó muy larga. Empezá una nueva con el botón «Nueva».', 'AGENTE_MUY_LARGO');
  }

  if (!reservarConsulta(sessionUser, cfg.limiteDiario)) {
    return errorResponse('Llegaste al límite de ' + cfg.limiteDiario + ' consultas al asistente por hoy. Mañana se renueva.', 'AGENTE_LIMITE');
  }

  const resp = UrlFetchApp.fetch(AGENTE_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': AGENTE_API_VERSION },
    payload: json,
    muteHttpExceptions: true
  });

  const status = resp.getResponseCode();
  let data = null;
  try {
    data = JSON.parse(resp.getContentText());
  } catch (err) {
    data = null;
  }

  if (status < 200 || status >= 300 || !data) {
    const detalle = data && data.error && data.error.message ? data.error.message : ('HTTP ' + status);
    registrarUsoAgente(sessionUser, cfg.modelo, null, 'Error: ' + detalle);
    const mensaje = status === 429 || status === 529
      ? 'El servicio de IA está saturado en este momento. Probá de nuevo en un minuto.'
      : status === 401
        ? 'La clave de la IA no es válida. Avisale al administrador.'
        : (status === 400 && /credit|balance/i.test(detalle))
          ? 'La cuenta de la IA se quedó sin saldo. Avisale al administrador.'
          : 'No se pudo consultar a la IA (' + detalle + ').';
    return errorResponse(mensaje, 'AGENTE_API_ERROR');
  }

  registrarUsoAgente(sessionUser, cfg.modelo, data.usage, '');
  return jsonResponse({
    ok: true,
    content: data.content || [],
    stop_reason: data.stop_reason || '',
    usage: data.usage || null
  });
}

function costoEstimado(modelo, usage) {
  const p = AGENTE_PRECIOS[modelo];
  if (!p || !usage) return '';
  const m = 1000000;
  const total =
    (Number(usage.input_tokens) || 0) * p.in / m +
    (Number(usage.output_tokens) || 0) * p.out / m +
    (Number(usage.cache_read_input_tokens) || 0) * p.cacheRead / m +
    (Number(usage.cache_creation_input_tokens) || 0) * p.cacheWrite / m;
  return Math.round(total * 1000000) / 1000000;
}

function registrarUsoAgente(sessionUser, modelo, usage, nota) {
  try {
    const sheet = ensureLogSheet(AGENTE_USO_SHEET_NAME, [
      'Fecha', 'Usuario', 'Modelo', 'Entrada', 'Salida', 'Caché leída', 'Caché escrita', 'Costo USD (estimado)', 'Nota'
    ]);
    const u = usage || {};
    sheet.appendRow([
      new Date(), sessionUser, modelo,
      Number(u.input_tokens) || 0, Number(u.output_tokens) || 0,
      Number(u.cache_read_input_tokens) || 0, Number(u.cache_creation_input_tokens) || 0,
      costoEstimado(modelo, usage), nota || ''
    ]);
  } catch (err) {
    // El registro es informativo: si falla, la respuesta igual llega.
  }
}

// ── ESTADO (qué está configurado) ───────────────────────────────────────
function handleAgenteEstado(sessionUser) {
  const cfg = agenteConfig();
  // AppsScript-Whaticket.gs es opcional: si no está, Whaticket queda apagado.
  const wt = typeof whaticketEstado === 'function' ? whaticketEstado() : { activo: false, grupo: false };
  return jsonResponse({
    ok: true,
    agente: {
      activo: Boolean(cfg.apiKey),
      modelo: cfg.modelo,
      limiteDiario: cfg.limiteDiario,
      usadasHoy: usadasHoy(sessionUser)
    },
    whaticket: wt
  });
}

// ── PRUEBA MANUAL DESDE EL EDITOR ───────────────────────────────────────
// Ejecutar a mano para verificar la clave de la IA sin pasar por la app.
function probarAsistente() {
  const cfg = agenteConfig();
  if (!cfg.apiKey) throw new Error('Falta ANTHROPIC_API_KEY en las propiedades del script');
  const resp = UrlFetchApp.fetch(AGENTE_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': AGENTE_API_VERSION },
    payload: JSON.stringify({
      model: cfg.modelo,
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Respondé sólo: "Asistente de Sistema MJ funcionando".' }]
    }),
    muteHttpExceptions: true
  });
  Logger.log('HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText());
}

// ── RUTEO ───────────────────────────────────────────────────────────────
// Lo llama handleAvisosAction (AppsScript-Avisos.gs) para las acciones que
// empiezan con "agente" o "whaticket" (éstas pasan a AppsScript-Whaticket.gs).
// Devuelve null si no es de acá.
function handleAgenteAction(action, body, sessionUser, sessionRole) {
  if (String(action).indexOf('whaticket') === 0) {
    return typeof handleWhaticketAction === 'function'
      ? handleWhaticketAction(action, body, sessionUser, sessionRole)
      : errorResponse('Falta el archivo Whaticket en el Apps Script.', 'WHATICKET_SIN_MODULO');
  }
  const routes = {
    agenteEstado: [function () { return handleAgenteEstado(sessionUser); }, 'AGENTE_ESTADO_ERROR'],
    agenteMensaje: [function () { return handleAgenteMensaje(body, sessionUser); }, 'AGENTE_ERROR']
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route[0]();
  } catch (err) {
    return errorResponse(err.message, route[1]);
  }
}

// ===== AppsScript-Whaticket.gs =====
/**
 * MÓDULO WHATICKET — envío de fichas IVA y chat del cliente dentro de Sistema MJ.
 *
 * Usa la API oficial de Whaticket (https://api.whaticket.com/api/v1, la de
 * Integraciones → Documentación del panel).
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "Whaticket" y pegar
 *      este contenido completo. Necesita también el archivo "Agente"
 *      (AppsScript-Agente.gs), que es el que recibe las acciones "whaticket*"
 *      desde el router de Avisos.
 *   2. En Whaticket: Integraciones → Tokens → Nuevo token, con permisos
 *        tickets:view, tickets:viewAll, tickets:viewPending,
 *        campaigns:create, campaigns:start y connections:view.
 *   3. Configuración del proyecto > Propiedades de la secuencia de comandos:
 *        WHATICKET_TOKEN         la clave del token (obligatoria).
 *        WHATICKET_GRUPO_NOMBRE  nombre exacto del grupo contable de WhatsApp,
 *                                como aparece en Whaticket.
 *        WHATICKET_CONEXION_ID   opcional. Si hay más de una conexión de
 *                                WhatsApp; si no, se detecta sola.
 *        WHATICKET_COLA_ID       opcional. Cola donde se abren los chats nuevos.
 *        WHATICKET_USUARIO_ID    opcional. Usuario de Whaticket al que se
 *                                asignan los chats nuevos.
 *        WHATICKET_URL           opcional. Por defecto la API oficial.
 *   4. Ejecutar "probarWhaticket" desde el editor y revisar el registro.
 *   5. Implementar > Administrar implementaciones > editar > Nueva versión.
 *
 * Cómo se envía la ficha a un cliente:
 *   - Si el cliente escribió en los últimos 7 días, va a su chat existente
 *     (POST /tickets/{id}/messages): no consume créditos y queda en el hilo.
 *   - Si no, Whaticket sólo permite escribirle con un mensaje nuevo
 *     (POST /messages, que funciona como una campaña de un mensaje y puede
 *     consumir créditos del plan).
 * Al grupo contable siempre se le escribe en su chat; Whaticket exige que
 * alguien haya escrito en el grupo en los últimos 7 días.
 *
 * El token vive SÓLO acá (Script Properties): nunca llega al navegador.
 * Usa funciones de Code.gs: getAdminSpreadsheet, jsonResponse, errorResponse.
 */

const WT_URL_DEFAULT = 'https://api.whaticket.com/api/v1';
const WT_VENTANA_MS = 7 * 24 * 60 * 60 * 1000;
const WT_MARGEN_VENTANA_MS = 30 * 60 * 1000; // no apurar el límite de 7 días
const WT_LOG_SHEET_NAME = 'Whaticket Envíos';
const WT_MAX_TEXTO = 4000;
const WT_MAX_IMAGEN_CHARS = 8 * 1024 * 1024; // base64 (~6 MB de PNG)
const WT_DUPLICADO_SEGUNDOS = 90;
const WT_CAMPANA_NOMBRE = 'Sistema MJ - Fichas IVA';
const WT_GRUPO_CACHE_PROPERTY = 'WHATICKET_GRUPO_DETECTADO';

// ── CONFIGURACIÓN ───────────────────────────────────────────────────────
function wtProp(name) {
  return String(PropertiesService.getScriptProperties().getProperty(name) || '').trim();
}

function wtConfig() {
  return {
    url: (wtProp('WHATICKET_URL') || WT_URL_DEFAULT).replace(/\/+$/, ''),
    token: wtProp('WHATICKET_TOKEN'),
    conexionId: wtProp('WHATICKET_CONEXION_ID'),
    grupoNombre: wtProp('WHATICKET_GRUPO_NOMBRE'),
    grupoTicketId: wtProp('WHATICKET_GRUPO_TICKET_ID'),
    colaId: wtProp('WHATICKET_COLA_ID'),
    usuarioId: wtProp('WHATICKET_USUARIO_ID')
  };
}

// Lo usa handleAgenteEstado para que la app sepa qué botones mostrar.
function whaticketEstado() {
  const cfg = wtConfig();
  return {
    activo: Boolean(cfg.token),
    grupo: Boolean(cfg.token && (cfg.grupoNombre || cfg.grupoTicketId))
  };
}

// ── LLAMADAS A LA API ───────────────────────────────────────────────────
function wtError(mensaje, codigo, status) {
  const err = new Error(mensaje);
  err.wtCodigo = codigo || '';
  err.wtStatus = status || 0;
  return err;
}

function wtCodigoDe(data) {
  if (!data) return '';
  return String(data.error || data.code || data.message || data.mensagem || '');
}

function wtMensajeError(status, codigo) {
  if (/REPLY_WINDOW_CLOSED/i.test(codigo)) {
    return 'Ese chat no tuvo mensajes del contacto en los últimos 7 días, y Whaticket no deja responder ahí.';
  }
  if (status === 401) return 'Whaticket rechazó el token. Revisá WHATICKET_TOKEN.';
  if (status === 403) return 'Al token de Whaticket le faltan permisos (' + (codigo || 'sin detalle') + '). Revisá los permisos del token.';
  if (status === 404) return 'Whaticket no encontró lo pedido (' + (codigo || 'sin detalle') + ').';
  if (status === 429) return 'Whaticket recibió demasiados pedidos seguidos. Probá en un minuto.';
  return 'Whaticket respondió con un error (HTTP ' + status + (codigo ? ': ' + codigo : '') + ').';
}

function wtQuery(query) {
  if (!query) return '';
  const partes = Object.keys(query)
    .filter(function (k) { return query[k] !== undefined && query[k] !== null && query[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k])); });
  return partes.length ? '?' + partes.join('&') : '';
}

// opciones: { query, json, form }
function wtRequest(method, path, opciones) {
  const cfg = wtConfig();
  if (!cfg.token) throw wtError('Whaticket no está configurado: falta WHATICKET_TOKEN en las propiedades del Apps Script.', 'SIN_TOKEN');
  const o = opciones || {};
  const params = {
    method: method,
    headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/json' },
    muteHttpExceptions: true
  };
  if (o.json !== undefined) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(o.json);
  } else if (o.form) {
    params.payload = o.form; // con un blob adentro Apps Script arma multipart/form-data
  }
  let resp;
  try {
    resp = UrlFetchApp.fetch(cfg.url + path + wtQuery(o.query), params);
  } catch (err) {
    throw wtError('No se pudo conectar con Whaticket: ' + err.message, 'CONEXION');
  }
  const status = resp.getResponseCode();
  const texto = resp.getContentText() || '';
  let data = {};
  try {
    data = texto ? JSON.parse(texto) : {};
  } catch (err) {
    data = { raw: texto.slice(0, 300) };
  }
  if (status < 200 || status >= 300) {
    const codigo = wtCodigoDe(data);
    throw wtError(wtMensajeError(status, codigo), codigo, status);
  }
  return data;
}

function wtSoloDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

// Compara números tolerando prefijos distintos (595981… / 0981… / 981…).
function wtMismoNumero(a, b) {
  const x = wtSoloDigitos(a);
  const y = wtSoloDigitos(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const n = Math.min(x.length, y.length, 9);
  return n >= 8 && x.slice(-n) === y.slice(-n);
}

// Para comparar nombres de grupos: sin mayúsculas, tildes, emojis ni signos.
function wtNormalizar(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function wtVentanaAbierta(ticket) {
  if (!ticket || !ticket.lastReceivedMessageAt) return false;
  const t = new Date(ticket.lastReceivedMessageAt).getTime();
  if (!t) return false;
  return Date.now() - t < WT_VENTANA_MS - WT_MARGEN_VENTANA_MS;
}

// Lista chats con un texto de búsqueda. Si el token no tiene permiso para
// ver los "pendientes", se reintenta sin ellos.
function wtListarTickets(busqueda) {
  try {
    return wtRequest('get', '/tickets', { query: { searchParam: busqueda, status: 'open,pending,closed' } }).tickets || [];
  } catch (err) {
    if (err.wtStatus !== 403) throw err;
    return wtRequest('get', '/tickets', { query: { searchParam: busqueda, status: 'open,closed' } }).tickets || [];
  }
}

function wtBuscarTicketCliente(numero) {
  const lista = wtListarTickets(numero).filter(function (t) {
    return !t.isGroup && t.contact && wtMismoNumero(t.contact.number, numero);
  });
  // La API los devuelve del más reciente al más viejo.
  return lista.length ? lista[0] : null;
}

function wtBuscarGrupo() {
  const cfg = wtConfig();
  if (cfg.grupoTicketId) return { id: cfg.grupoTicketId, nombre: cfg.grupoNombre || 'Grupo contable' };
  if (!cfg.grupoNombre) {
    throw wtError('Falta configurar el grupo contable: cargá WHATICKET_GRUPO_NOMBRE en las propiedades del Apps Script.', 'SIN_GRUPO');
  }
  const props = PropertiesService.getScriptProperties();
  try {
    const guardado = JSON.parse(props.getProperty(WT_GRUPO_CACHE_PROPERTY) || 'null');
    if (guardado && guardado.id && guardado.buscado === cfg.grupoNombre) return guardado;
  } catch (err) { /* se vuelve a buscar */ }

  const buscado = wtNormalizar(cfg.grupoNombre);
  if (!buscado) throw wtError('WHATICKET_GRUPO_NOMBRE tiene que incluir letras del nombre del grupo.', 'SIN_GRUPO');
  // Se busca sólo con el texto (sin emojis), que es lo que Whaticket indexa.
  const grupos = wtListarTickets(buscado).filter(function (t) { return t.isGroup && t.contact; });
  const exacto = grupos.filter(function (t) { return wtNormalizar(t.contact.name) === buscado; });
  const elegido = exacto[0] || (grupos.length === 1 ? grupos[0] : null);
  if (!elegido) {
    throw wtError(
      grupos.length
        ? 'Hay varios grupos parecidos a "' + cfg.grupoNombre + '" en Whaticket. Escribí el nombre exacto en WHATICKET_GRUPO_NOMBRE.'
        : 'No encontré el grupo "' + cfg.grupoNombre + '" en Whaticket. Revisá el nombre en WHATICKET_GRUPO_NOMBRE.',
      'GRUPO_NO_ENCONTRADO'
    );
  }
  const grupo = { id: elegido.id, nombre: elegido.contact.name, buscado: cfg.grupoNombre };
  props.setProperty(WT_GRUPO_CACHE_PROPERTY, JSON.stringify(grupo));
  return grupo;
}

// Conexión de WhatsApp para los mensajes nuevos: la configurada, o la única
// conexión de WhatsApp conectada.
function wtConexionId() {
  const cfg = wtConfig();
  if (cfg.conexionId) return cfg.conexionId;
  const cache = CacheService.getScriptCache();
  const enCache = cache.get('WT_CONEXION_ID');
  if (enCache) return enCache;
  const conexiones = (wtRequest('get', '/connections').connections || []).filter(function (c) {
    return /^WHATSAPP$/i.test(String(c.channel || ''));
  });
  const conectadas = conexiones.filter(function (c) { return /CONNECTED|OPEN/i.test(String(c.status || '')); });
  const candidatas = conectadas.length ? conectadas : conexiones;
  if (candidatas.length !== 1) {
    throw wtError(
      candidatas.length
        ? 'Hay ' + candidatas.length + ' conexiones de WhatsApp en Whaticket: indicá cuál usar en WHATICKET_CONEXION_ID (ver probarWhaticket).'
        : 'No encontré ninguna conexión de WhatsApp en Whaticket.',
      'CONEXION_AMBIGUA'
    );
  }
  cache.put('WT_CONEXION_ID', candidatas[0].id, 21600);
  return candidatas[0].id;
}

function wtSubirImagen(base64, nombreArchivo) {
  let blob;
  try {
    blob = Utilities.newBlob(
      Utilities.base64Decode(base64),
      'image/png',
      String(nombreArchivo || 'ficha-iva.png').replace(/[^\w.\- ]/g, '_').slice(0, 80)
    );
  } catch (err) {
    throw wtError('No se pudo leer la imagen de la ficha.', 'IMAGEN');
  }
  const data = wtRequest('post', '/medias', { form: { media: blob } });
  const key = data.mediaKey || data.key || (data.media && (data.media.mediaKey || data.media.key)) || (data.data && data.data.mediaKey);
  if (!key) throw wtError('Whaticket no devolvió la referencia de la imagen subida.', 'SIN_MEDIA_KEY');
  return key;
}

function wtResponderTicket(ticketId, texto, mediaKey) {
  const cuerpo = { signMessage: false };
  if (texto) cuerpo.body = texto;
  if (mediaKey) cuerpo.mediaKey = mediaKey;
  return wtRequest('post', '/tickets/' + encodeURIComponent(ticketId) + '/messages', { json: cuerpo });
}

function wtMensajeNuevo(numero, nombre, texto, mediaKey) {
  const cfg = wtConfig();
  const mensaje = { number: numero };
  if (nombre) mensaje.name = String(nombre).slice(0, 120);
  if (texto) mensaje.body = texto;
  if (mediaKey) {
    mensaje.mediaKey = mediaKey;
    mensaje.mediaType = 'image';
  }
  const ticketData = {};
  if (cfg.colaId) ticketData.queueId = cfg.colaId;
  if (cfg.usuarioId) ticketData.userId = cfg.usuarioId;
  if (Object.keys(ticketData).length) mensaje.ticketData = ticketData;
  return wtRequest('post', '/messages', {
    json: { connectionId: wtConexionId(), campaignName: WT_CAMPANA_NOMBRE, fastMode: true, messages: [mensaje] }
  });
}

// ── VALIDACIONES COMUNES ────────────────────────────────────────────────
function wtNumeroValido(raw) {
  let numero = wtSoloDigitos(raw);
  // Celular paraguayo cargado como 0981… → 595981… (mismo criterio que la app).
  if (/^09\d{8}$/.test(numero)) numero = '595' + numero.slice(1);
  if (numero.length < 10 || numero.length > 15) {
    throw wtError('El número de WhatsApp del cliente no es válido. Revisalo en la ficha.', 'NUMERO');
  }
  return numero;
}

function wtTextoValido(raw, obligatorio) {
  const texto = String(raw || '').trim();
  if (texto.length > WT_MAX_TEXTO) throw wtError('El mensaje es demasiado largo.', 'TEXTO');
  if (obligatorio && !texto) throw wtError('Escribí un mensaje.', 'TEXTO');
  return texto;
}

function wtImagenValida(raw) {
  let imagen = String(raw || '');
  if (imagen.indexOf('base64,') !== -1) imagen = imagen.split('base64,')[1];
  if (imagen.length > WT_MAX_IMAGEN_CHARS) throw wtError('La imagen de la ficha es demasiado grande.', 'IMAGEN');
  return imagen;
}

// ── ACCIONES ────────────────────────────────────────────────────────────
// Ficha IVA → cliente o grupo contable. body.destino: "cliente" | "grupo".
function handleWhaticketEnviar(body, sessionUser) {
  const destino = body.destino === 'grupo' ? 'grupo' : 'cliente';
  const texto = wtTextoValido(body.texto, false);
  const imagen = wtImagenValida(body.imagen);
  if (!imagen && !texto) throw wtError('No hay nada para enviar.', 'VACIO');
  const numero = destino === 'cliente' ? wtNumeroValido(body.numero) : '';

  // Evita el doble envío por un doble clic o un reintento.
  const cache = CacheService.getScriptCache();
  const claveDuplicado = 'WT_' + destino + '_' + (numero || 'grupo') + '_' + String(body.periodo || '') + '_' + String(body.ruc || '');
  if (!body.forzar && cache.get(claveDuplicado)) {
    return errorResponse(
      destino === 'grupo'
        ? 'Esta ficha se acaba de enviar al grupo contable. Esperá un momento antes de reenviarla.'
        : 'Esta ficha se acaba de enviar a ese número. Esperá un momento antes de reenviarla.',
      'WHATICKET_DUPLICADO'
    );
  }

  let via = '';
  let ticketId = '';
  try {
    const mediaKey = imagen ? wtSubirImagen(imagen, body.nombreArchivo) : '';
    if (destino === 'grupo') {
      const grupo = wtBuscarGrupo();
      try {
        wtResponderTicket(grupo.id, texto, mediaKey);
      } catch (err) {
        if (/REPLY_WINDOW_CLOSED/i.test(err.wtCodigo)) {
          throw wtError('Whaticket no deja escribir en el grupo contable porque nadie escribió ahí en los últimos 7 días. Mandá cualquier mensaje en el grupo desde el celular y volvé a intentar.', 'GRUPO_VENTANA');
        }
        if (err.wtStatus === 404) PropertiesService.getScriptProperties().deleteProperty(WT_GRUPO_CACHE_PROPERTY);
        throw err;
      }
      via = 'grupo';
      ticketId = grupo.id;
    } else {
      const ticket = wtBuscarTicketCliente(numero);
      if (ticket && wtVentanaAbierta(ticket)) {
        try {
          wtResponderTicket(ticket.id, texto, mediaKey);
          via = 'chat';
          ticketId = ticket.id;
        } catch (err) {
          if (!/REPLY_WINDOW_CLOSED/i.test(err.wtCodigo)) throw err;
        }
      }
      if (!via) {
        wtMensajeNuevo(numero, body.cliente, texto, mediaKey);
        via = 'nuevo';
        ticketId = ticket ? ticket.id : '';
      }
    }
  } catch (err) {
    registrarEnvioWhaticket(sessionUser, destino, body, numero, '', false, err.message);
    return errorResponse(err.message, 'WHATICKET_' + (err.wtCodigo ? String(err.wtCodigo).replace(/[^\w]/g, '').toUpperCase() : 'ERROR'));
  }

  registrarEnvioWhaticket(sessionUser, destino, body, numero, via, true, '');
  cache.put(claveDuplicado, '1', WT_DUPLICADO_SEGUNDOS);
  return jsonResponse({ ok: true, enviado: true, destino: destino, via: via, ticketId: ticketId });
}

function wtMensajeParaApp(m) {
  return {
    id: m.id,
    texto: m.body || '',
    deMi: Boolean(m.fromMe),
    nota: Boolean(m.isNote),
    tipo: m.mediaType || '',
    mediaUrl: m.mediaUrl || '',
    ack: typeof m.ack === 'number' ? m.ack : null,
    fecha: m.createdAt || ''
  };
}

// Chat del cliente (sólo ese cliente, buscado por su número).
// body: { numero, cursor?, cursorId? } → 20 mensajes, del más viejo al más nuevo.
function handleWhaticketChat(body) {
  const numero = wtNumeroValido(body.numero);
  const ticket = wtBuscarTicketCliente(numero);
  if (!ticket) return jsonResponse({ ok: true, ticket: null, mensajes: [], hayMasAntes: false });
  const query = {};
  if (body.cursor && body.cursorId) {
    query.cursor = body.cursor;
    query.cursorId = body.cursorId;
    query.direction = 'before';
  }
  const data = wtRequest('get', '/tickets/' + encodeURIComponent(ticket.id) + '/messages', { query: query });
  const mensajes = (data.messages || []).filter(function (m) { return !m.isDeleted; }).map(wtMensajeParaApp);
  return jsonResponse({
    ok: true,
    ticket: {
      id: ticket.id,
      estado: ticket.status || '',
      nombre: (ticket.contact && ticket.contact.name) || '',
      numero: (ticket.contact && ticket.contact.number) || numero,
      foto: (ticket.contact && ticket.contact.profilePicUrl) || '',
      ventanaAbierta: wtVentanaAbierta(ticket),
      ultimoRecibido: ticket.lastReceivedMessageAt || ''
    },
    mensajes: mensajes,
    // Para pedir más viejos: cursor/cursorId del primer mensaje de la página.
    cursor: data.messages && data.messages.length ? { cursor: data.messages[0].createdAt, cursorId: data.messages[0].id } : null,
    hayMasAntes: Boolean(data.hasMoreBefore)
  });
}

// Respuesta escrita desde Sistema MJ en el chat del cliente. Va firmada con el
// nombre de quien la escribe, como hace Whaticket.
function handleWhaticketResponder(body, sessionUser) {
  const numero = wtNumeroValido(body.numero);
  const texto = wtTextoValido(body.texto, true);
  const ticket = wtBuscarTicketCliente(numero);
  if (!ticket) {
    throw wtError('Este cliente todavía no tiene chat en Whaticket. Enviale primero la ficha.', 'SIN_CHAT');
  }
  if (!wtVentanaAbierta(ticket)) {
    throw wtError('Pasaron más de 7 días desde el último mensaje del cliente: Whaticket no deja responder en el chat. Usá «Enviar al cliente» con la ficha, o escribile desde Whaticket.', 'VENTANA');
  }
  try {
    wtResponderTicket(ticket.id, '*' + sessionUser + ':*\n' + texto, '');
  } catch (err) {
    registrarEnvioWhaticket(sessionUser, 'respuesta', body, numero, 'chat', false, err.message);
    throw err;
  }
  registrarEnvioWhaticket(sessionUser, 'respuesta', body, numero, 'chat', true, '');
  return jsonResponse({ ok: true });
}

function registrarEnvioWhaticket(sessionUser, destino, body, numero, via, ok, detalle) {
  try {
    const ss = getAdminSpreadsheet();
    let sheet = ss.getSheetByName(WT_LOG_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(WT_LOG_SHEET_NAME);
      const headers = ['Fecha', 'Usuario', 'Destino', 'Cliente', 'RUC', 'Período', 'Número', 'Vía', 'Resultado', 'Detalle'];
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    const vias = { chat: 'Chat existente', nuevo: 'Mensaje nuevo', grupo: 'Grupo contable' };
    sheet.appendRow([
      new Date(), sessionUser,
      destino === 'grupo' ? 'Grupo contable' : destino === 'respuesta' ? 'Respuesta' : 'Cliente',
      String(body.cliente || '').slice(0, 120), String(body.ruc || '').slice(0, 20),
      String(body.periodo || '').slice(0, 7), numero,
      vias[via] || '', ok ? 'Enviado' : 'Error', String(detalle || '').slice(0, 500)
    ]);
  } catch (err) {
    // Informativo: no frena el envío.
  }
}

// ── PRUEBA MANUAL DESDE EL EDITOR ───────────────────────────────────────
// Ejecutar a mano: muestra el token, sus permisos, las conexiones y el grupo.
function probarWhaticket() {
  const me = wtRequest('get', '/me');
  Logger.log('Token: ' + JSON.stringify(me));
  const conexiones = wtRequest('get', '/connections').connections || [];
  conexiones.forEach(function (c) {
    Logger.log('Conexión: ' + c.name + ' | canal ' + c.channel + ' | estado ' + c.status + ' | id ' + c.id);
  });
  Logger.log('Conexión que se usará para mensajes nuevos: ' + wtConexionId());
  if (wtConfig().grupoNombre || wtConfig().grupoTicketId) {
    PropertiesService.getScriptProperties().deleteProperty(WT_GRUPO_CACHE_PROPERTY);
    const grupo = wtBuscarGrupo();
    Logger.log('Grupo contable: ' + grupo.nombre + ' (chat ' + grupo.id + ')');
  } else {
    Logger.log('Falta WHATICKET_GRUPO_NOMBRE para el envío al grupo contable.');
  }
}

// ── RUTEO ───────────────────────────────────────────────────────────────
// Lo llama handleAgenteAction (AppsScript-Agente.gs) para las acciones que
// empiezan con "whaticket". Devuelve null si no es de acá.
function handleWhaticketAction(action, body, sessionUser, sessionRole) {
  const routes = {
    whaticketEnviar: function () { return handleWhaticketEnviar(body, sessionUser); },
    whaticketChat: function () { return handleWhaticketChat(body); },
    whaticketResponder: function () { return handleWhaticketResponder(body, sessionUser); }
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route();
  } catch (err) {
    const codigo = err.wtCodigo ? String(err.wtCodigo).replace(/[^\w]/g, '').toUpperCase() : 'ERROR';
    return errorResponse(err.message, 'WHATICKET_' + codigo);
  }
}

// ===== pruebas/instalador.gs =====
// ════════════════════════════════════════════════════════════════════════
// INSTALADOR DEL BACKEND DE PRUEBAS (sólo para el entorno de pruebas)
// ════════════════════════════════════════════════════════════════════════
// Ejecutar UNA vez la función instalarEntornoPruebas(). Crea en tu Google
// Drive dos planillas NUEVAS con datos ficticios y configura el proyecto:
//   - "PRUEBAS - Control Total (administración)": Usuarios, Planillas,
//     Historial (y las del IVA y Marcaciones, que se crean solas al usarlas).
//   - "PRUEBAS - Clientes 2026": hojas Septiembre, Octubre y Noviembre con
//     clientes inventados (RUC y Clave MH ficticios: Marangatu los rechaza).
// No lee ni toca ninguna planilla real.

const PRUEBAS_ANIO = '2026';
const PRUEBAS_MESES = ['Septiembre', 'Octubre', 'Noviembre'];
const PRUEBAS_PIN = '1234';
const PRUEBAS_USUARIOS = [
  ['Super Pruebas', 'SUPERUSUARIO'],
  ['Admin Pruebas', 'ADMINISTRADOR'],
  ['Usuario Pruebas', 'USUARIO'],
];
const PRUEBAS_CLIENTES_POR_MES = 25;
// Mismas columnas que la planilla real del estudio.
const PRUEBAS_ENCABEZADOS = [
  'Vencimiento', 'CLIENTE O RAZON SOCIAL', 'R.U.C.', 'D.V.', 'CLAVE MH', 'ZONA', 'Nº DE CASA', 'BARRIO',
  'CONTACTO', 'TELEFONO', 'ESTADO', 'OBSERVACIONES', 'VENTAS', 'Compras', 'Nota de Credito', 'Despacho ',
  'Fecha', 'Archivado por:', 'Encargado',
];

function instalarEntornoPruebas() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ADMIN_SPREADSHEET_ID')) {
    throw new Error(
      'El entorno de pruebas ya está instalado (existe ADMIN_SPREADSHEET_ID). ' +
      'Ejecutá mostrarDatosEntornoPruebas() para ver los datos.'
    );
  }

  // 1. Secretos propios de pruebas (distintos a los reales).
  props.setProperties({
    API_TOKEN: createRandomToken(),
    PIN_PEPPER: createRandomToken(),
    ALLOW_SELF_PIN_SETUP: 'false',
    ALLOW_PINLESS_LOGIN: 'false',
  });

  // 2. Planilla de clientes del año, con datos inventados.
  const anual = SpreadsheetApp.create('PRUEBAS - Clientes ' + PRUEBAS_ANIO);
  PRUEBAS_MESES.forEach(function (mes, i) {
    const hoja = i === 0 ? anual.getSheets()[0].setName(mes) : anual.insertSheet(mes);
    hoja.getRange(1, 1, 1, PRUEBAS_ENCABEZADOS.length).setValues([PRUEBAS_ENCABEZADOS]).setFontWeight('bold');
    hoja.getRange(2, 1, PRUEBAS_CLIENTES_POR_MES, PRUEBAS_ENCABEZADOS.length).setValues(clientesFicticios_(i));
    hoja.setFrozenRows(1);
    hoja.autoResizeColumns(1, PRUEBAS_ENCABEZADOS.length);
  });

  // 3. Planilla de administración.
  const admin = SpreadsheetApp.create('PRUEBAS - Control Total (administración)');
  props.setProperty('ADMIN_SPREADSHEET_ID', admin.getId());

  const usuarios = admin.getSheets()[0].setName(USERS_SHEET_NAME);
  usuarios.getRange(1, 1, 1, 4).setValues([['Nombre', 'Rol', PIN_HASH_HEADER, USER_STATUS_HEADER]]).setFontWeight('bold');
  usuarios.getRange(2, 1, PRUEBAS_USUARIOS.length, 4).setValues(
    PRUEBAS_USUARIOS.map(function (u) {
      return [u[0], u[1], computePinHash(u[0], PRUEBAS_PIN, false), 'ACTIVO'];
    })
  );

  const planillas = admin.insertSheet(PLANILLAS_SHEET_NAME);
  planillas.getRange(1, 1, 2, 3).setValues([
    ['Año', 'ID Planilla', 'Nombre'],
    [PRUEBAS_ANIO, anual.getId(), 'PRUEBAS - Clientes ' + PRUEBAS_ANIO],
  ]);
  planillas.getRange(1, 1, 1, 3).setFontWeight('bold');
  ensureHistorialSheet();

  mostrarDatosEntornoPruebas();
}

// Vuelve a mostrar lo que hay que copiar (token, planillas, usuarios).
function mostrarDatosEntornoPruebas() {
  const props = PropertiesService.getScriptProperties();
  const adminId = props.getProperty('ADMIN_SPREADSHEET_ID');
  if (!adminId) throw new Error('El entorno de pruebas no está instalado: ejecutá instalarEntornoPruebas().');
  const anual = getClientSpreadsheet(PRUEBAS_ANIO);
  Logger.log('════════ ENTORNO DE PRUEBAS LISTO ════════');
  Logger.log('Planilla de administración: https://docs.google.com/spreadsheets/d/' + adminId + '/edit');
  if (anual) Logger.log('Planilla de clientes ' + PRUEBAS_ANIO + ':  ' + anual.getUrl());
  Logger.log('VITE_API_TOKEN (para Vercel):  ' + props.getProperty('API_TOKEN'));
  Logger.log('Usuarios (PIN ' + PRUEBAS_PIN + ' para todos): ' +
    PRUEBAS_USUARIOS.map(function (u) { return u[0] + ' (' + u[1] + ')'; }).join(', '));
  Logger.log('Siguiente paso: Implementar → Nueva implementación → Aplicación web.');
}

function clientesFicticios_(mesIndex) {
  const nombres = ['Comercial', 'Ferretería', 'Distribuidora', 'Panadería', 'Transportes', 'Farmacia', 'Consultora', 'Librería'];
  const lugares = ['Sur', 'del Este', 'Ñandutí', 'Guaraní', 'Central', 'Paraná', 'Chaco', 'Ypacaraí'];
  const zonas = ['Centro', 'Norte', 'Sur', 'Este'];
  const barrios = ['San Vicente', 'Villa Morra', 'Recoleta', 'Sajonia', 'Trinidad'];
  const encargados = PRUEBAS_USUARIOS.map(function (u) { return u[0]; });
  const filas = [];
  for (let i = 0; i < PRUEBAS_CLIENTES_POR_MES; i++) {
    // Los meses anteriores al último quedan mayormente con documentación.
    const recibido = mesIndex < PRUEBAS_MESES.length - 1 ? i % 5 !== 0 : i % 3 === 0;
    const archivado = recibido && i % 4 === 0;
    const quien = encargados[i % encargados.length];
    filas.push([
      'Día ' + (((i * 3) % 25) + 1),
      'PRUEBA ' + nombres[i % nombres.length] + ' ' + lugares[(i * 3) % lugares.length] + ' ' + (i + 1) + ' S.A.',
      String(80000000 + i * 37),
      String(i % 10),
      i % 6 === 5 ? '' : 'CLAVE-FICTICIA-' + (i + 1),
      zonas[i % zonas.length],
      String(100 + i),
      barrios[i % barrios.length],
      'Contacto ' + (i + 1),
      '0981 ' + String(100000 + i * 13),
      'ACTIVO',
      i % 6 === 0 ? 'Cliente de prueba con IVA mensual' : '',
      recibido ? '\u2713' : '',
      recibido ? '\u2713 12 facturas' : '',
      '',
      recibido && i % 2 === 0 ? '\u2713' : '',
      '',
      archivado ? quien : '',
      i % 7 === 6 ? '' : quien,
    ]);
  }
  return filas;
}
