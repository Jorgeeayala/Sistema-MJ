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
