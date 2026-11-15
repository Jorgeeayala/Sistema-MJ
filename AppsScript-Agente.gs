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
