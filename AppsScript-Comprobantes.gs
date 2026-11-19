/**
 * MÓDULO COMPROBANTES - archivo aparte del backend de Control Clientes.
 *
 * Registro de comprobantes por cliente (facturas y notas de crédito de
 * ventas y compras, con timbrado y a qué impuesto se imputan). La app arma
 * desde acá el Formulario 120 de IVA y, más adelante, el IRP.
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "Comprobantes" y
 *      pegar este contenido completo.
 *   2. Pegar también el AppsScript-Avisos.gs nuevo (deriva las acciones
 *      comprobantes* a este archivo). No hace falta tocar Code.gs.
 *   3. Implementar > Administrar implementaciones > editar > Nueva versión.
 *
 * Hoja "Comprobantes" en la planilla de administración (se crea sola): una
 * fila por cliente + mes. Las columnas 1 a 8 son el índice; los comprobantes
 * (JSON) van desde la columna 9 en celdas de hasta 45.000 caracteres.
 * Cada alta, cambio o baja es de UN comprobante y se hace con bloqueo, así
 * dos personas pueden cargar el mismo mes sin pisarse.
 * Usa funciones de Code.gs: getAdminSpreadsheet, jsonResponse, errorResponse.
 */

const COMPROBANTES_SHEET_NAME = 'Comprobantes';
const COMPROBANTES_HEADERS = [
  'ID', 'RUC cliente', 'Cliente', 'Período', 'Cantidad', 'Totales', 'Modificado por', 'Modificado el'
];
const COMPROBANTES_COL_DATOS = COMPROBANTES_HEADERS.length + 1; // 9
const COMPROBANTES_TROZO = 45000;
const COMPROBANTES_MAX_MES = 3000;

function ensureComprobantesSheet() {
  const ss = getAdminSpreadsheet();
  let sheet = ss.getSheetByName(COMPROBANTES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(COMPROBANTES_SHEET_NAME);
    sheet.getRange(1, 1, 1, COMPROBANTES_HEADERS.length).setValues([COMPROBANTES_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function cpTexto_(v, max) {
  if (v instanceof Date) return v.toISOString();
  return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 200);
}
function cpNum_(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}
function cpRuc_(v) { return cpTexto_(v, 30).replace(/\D/g, ''); }

function cpLeerIndice_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, COMPROBANTES_HEADERS.length).getValues();
  const out = [];
  values.forEach(function (r, i) {
    const id = cpTexto_(r[0], 80);
    if (!id) return;
    let totales = {};
    try { totales = JSON.parse(String(r[5] || '{}')) || {}; } catch (e) { totales = {}; }
    out.push({
      fila: i + 2, id: id, ruc: cpRuc_(r[1]), cliente: cpTexto_(r[2], 200),
      periodo: cpTexto_(r[3], 10), cantidad: Number(r[4]) || 0, totales: totales,
      modificadoPor: cpTexto_(r[6], 120), modificadoEl: cpTexto_(r[7], 40)
    });
  });
  return out;
}

function cpPublico_(x) {
  return {
    id: x.id, ruc: x.ruc, cliente: x.cliente, periodo: x.periodo, cantidad: x.cantidad,
    totales: x.totales, modificadoPor: x.modificadoPor, modificadoEl: x.modificadoEl
  };
}

function cpLeerLista_(sheet, fila) {
  const ancho = Math.max(sheet.getLastColumn() - COMPROBANTES_COL_DATOS + 1, 1);
  const trozos = sheet.getRange(fila, COMPROBANTES_COL_DATOS, 1, ancho).getValues()[0];
  const json = trozos.map(function (t) { return String(t || ''); }).join('');
  if (!json) return [];
  const lista = JSON.parse(json); // si está dañado, que falle: no se sobrescribe
  return Array.isArray(lista) ? lista : [];
}

// Lo mismo que normalizar() de comprobantesCore.js.
function cpNormalizar_(c, usuario) {
  c = c || {};
  const tipo = c.tipo === 'nc' ? 'nc' : 'factura';
  const moneda = c.moneda === 'USD' ? 'USD' : 'PYG';
  const imp = c.imputa || {};
  const numero = cpTexto_(c.numero, 40);
  return {
    id: cpTexto_(c.id, 60) || 'cp-' + Utilities.getUuid(),
    op: c.op === 'compra' ? 'compra' : 'venta',
    tipo: tipo,
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(c.fecha || '')) ? String(c.fecha) : '',
    numero: numero,
    timbrado: cpTexto_(c.timbrado, 20).replace(/\D/g, '').slice(0, 8),
    condicion: c.condicion === 'credito' ? 'credito' : 'contado',
    moneda: moneda,
    cambio: moneda === 'USD' ? cpNum_(c.cambio) : 0,
    ruc: cpTexto_(c.ruc, 20).toUpperCase(),
    nombre: cpTexto_(c.nombre, 120),
    g10: cpNum_(c.g10), g5: cpNum_(c.g5), ex: cpNum_(c.ex),
    agro: !!c.agro && cpNum_(c.g5) > 0,
    imputa: { iva: !!imp.iva, ire: !!imp.ire, irp: !!imp.irp },
    asociado: tipo === 'nc' ? cpTexto_(c.asociado, 40) : '',
    nota: cpTexto_(c.nota, 200),
    cargadoPor: cpTexto_(usuario, 80),
    cargadoEl: new Date().toISOString()
  };
}

function cpTotales_(lista) {
  const t = { ventas: 0, compras: 0, ivaVentas: 0, ivaCompras: 0 };
  lista.forEach(function (c) {
    const f = c.moneda === 'USD' ? Number(c.cambio) || 0 : 1;
    const g10 = Math.round((Number(c.g10) || 0) * f);
    const g5 = Math.round((Number(c.g5) || 0) * f);
    const ex = Math.round((Number(c.ex) || 0) * f);
    const s = c.tipo === 'nc' ? -1 : 1;
    const iva = Math.round(g10 / 11) + Math.round(g5 / 21);
    if (c.op === 'compra') { t.compras += s * (g10 + g5 + ex); t.ivaCompras += s * iva; }
    else { t.ventas += s * (g10 + g5 + ex); t.ivaVentas += s * iva; }
  });
  return t;
}

// Escribe (o borra, si queda vacía) la fila del cliente + mes.
function cpEscribir_(sheet, existente, ruc, cliente, periodo, lista, usuario) {
  if (!lista.length) {
    if (existente) sheet.deleteRow(existente.fila);
    return;
  }
  const json = JSON.stringify(lista);
  const fila = existente ? existente.fila : sheet.getLastRow() + 1;
  const indice = [
    existente ? existente.id : 'cm-' + Utilities.getUuid(), ruc,
    cliente || (existente && existente.cliente) || '', periodo, String(lista.length),
    JSON.stringify(cpTotales_(lista)), String(usuario), new Date().toISOString()
  ];
  const trozos = [];
  for (let i = 0; i < json.length; i += COMPROBANTES_TROZO) trozos.push(json.slice(i, i + COMPROBANTES_TROZO));
  const anchoViejo = Math.max(sheet.getLastColumn() - COMPROBANTES_COL_DATOS + 1, 0);
  if (existente && anchoViejo > 0) sheet.getRange(fila, COMPROBANTES_COL_DATOS, 1, anchoViejo).clearContent();
  const todo = indice.concat(trozos);
  const rango = sheet.getRange(fila, 1, 1, todo.length);
  rango.setNumberFormat('@'); // texto: Sheets no convierte números ni fechas
  rango.setValues([todo.map(function (v) { return String(v); })]);
}

function cpBuscar_(indice, ruc, periodo) {
  return indice.filter(function (x) { return x.ruc === ruc && x.periodo === periodo; })[0] || null;
}

function handleComprobantesListar(body) {
  const ruc = cpRuc_(body.ruc);
  const lista = cpLeerIndice_(ensureComprobantesSheet())
    .filter(function (x) { return !ruc || x.ruc === ruc; })
    .map(cpPublico_);
  return jsonResponse({ ok: true, registros: lista });
}

function handleComprobantesLeer(body) {
  const ruc = cpRuc_(body.ruc);
  const periodo = cpTexto_(body.periodo, 10);
  if (!ruc || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) return errorResponse('Cliente o mes no válido', 'COMPROBANTES_DATOS');
  const sheet = ensureComprobantesSheet();
  const reg = cpBuscar_(cpLeerIndice_(sheet), ruc, periodo);
  if (!reg) return jsonResponse({ ok: true, registro: { ruc: ruc, periodo: periodo, cantidad: 0, comprobantes: [] } });
  let lista;
  try { lista = cpLeerLista_(sheet, reg.fila); } catch (e) {
    return errorResponse('El registro de ese mes está dañado: avisá a un administrador', 'COMPROBANTES_DANADO');
  }
  const out = cpPublico_(reg);
  out.comprobantes = lista;
  return jsonResponse({ ok: true, registro: out });
}

// body: { ruc, cliente, comprobante, periodoAnterior }
function handleComprobantesGuardar(body, sessionUser) {
  const ruc = cpRuc_(body.ruc);
  if (!ruc) return errorResponse('Elegí el cliente', 'COMPROBANTES_DATOS');
  const c = cpNormalizar_(body.comprobante, sessionUser);
  if (!c.fecha) return errorResponse('Falta la fecha del comprobante', 'COMPROBANTE_FECHA');
  if (!(c.g10 || c.g5 || c.ex)) return errorResponse('El comprobante no tiene montos', 'COMPROBANTE_VACIO');
  const periodo = c.fecha.slice(0, 7);
  const anterior = cpTexto_(body.periodoAnterior, 10);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return errorResponse('El registro está ocupado, intentá de nuevo', 'COMPROBANTES_LOCK_TIMEOUT');
  try {
    const sheet = ensureComprobantesSheet();
    const indice = cpLeerIndice_(sheet);
    const reg = cpBuscar_(indice, ruc, periodo);
    let lista = reg ? cpLeerLista_(sheet, reg.fila) : [];
    const sinDv = function (r) { return String(r || '').replace(/\D/g, ''); };
    const dup = lista.filter(function (x) {
      return x.id !== c.id && x.op === c.op && x.tipo === c.tipo && c.numero && x.numero === c.numero &&
        (x.timbrado || '') === c.timbrado && sinDv(x.ruc) === sinDv(c.ruc);
    })[0];
    if (dup) return jsonResponse({ ok: false, code: 'COMPROBANTE_DUPLICADO', error: 'Ese comprobante ya está cargado en ese mes', existente: dup });

    const i = lista.map(function (x) { return x.id; }).indexOf(c.id);
    // Si viene de otro mes, conserva quién lo cargó primero.
    let viejo = null;
    let restante = null;
    if (anterior && anterior !== periodo) {
      viejo = cpBuscar_(indice, ruc, anterior);
      if (viejo) {
        const previa = cpLeerLista_(sheet, viejo.fila);
        const original = previa.filter(function (x) { return x.id === c.id; })[0];
        if (original) {
          c.cargadoPor = original.cargadoPor || c.cargadoPor;
          c.cargadoEl = original.cargadoEl || c.cargadoEl;
          c.modificadoPor = cpTexto_(sessionUser, 80);
        }
        restante = previa.filter(function (x) { return x.id !== c.id; });
      }
    }
    if (i >= 0) {
      c.cargadoPor = lista[i].cargadoPor || c.cargadoPor;
      c.cargadoEl = lista[i].cargadoEl || c.cargadoEl;
      c.modificadoPor = cpTexto_(sessionUser, 80);
      lista[i] = c;
    } else {
      if (lista.length >= COMPROBANTES_MAX_MES) return errorResponse('Ese mes ya tiene demasiados comprobantes', 'COMPROBANTES_LLENO');
      lista.push(c);
    }
    // Si se cambió la fecha a otro mes, se quita del mes anterior (antes de
    // escribir el nuevo, porque borrar una fila corre las de abajo).
    if (viejo) cpEscribir_(sheet, viejo, ruc, body.cliente, anterior, restante, sessionUser);
    const regActual = cpBuscar_(cpLeerIndice_(sheet), ruc, periodo);
    cpEscribir_(sheet, regActual, ruc, cpTexto_(body.cliente, 200), periodo, lista, sessionUser);
    return jsonResponse({ ok: true, comprobante: c, periodo: periodo, cantidad: lista.length });
  } finally {
    lock.releaseLock();
  }
}

function handleComprobantesEliminar(body, sessionUser) {
  const ruc = cpRuc_(body.ruc);
  const periodo = cpTexto_(body.periodo, 10);
  const id = cpTexto_(body.id, 60);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return errorResponse('El registro está ocupado, intentá de nuevo', 'COMPROBANTES_LOCK_TIMEOUT');
  try {
    const sheet = ensureComprobantesSheet();
    const reg = cpBuscar_(cpLeerIndice_(sheet), ruc, periodo);
    if (!reg) return errorResponse('No se encontró ese comprobante', 'COMPROBANTE_NO_EXISTE');
    const lista = cpLeerLista_(sheet, reg.fila);
    const restante = lista.filter(function (x) { return x.id !== id; });
    if (restante.length === lista.length) return errorResponse('No se encontró ese comprobante', 'COMPROBANTE_NO_EXISTE');
    cpEscribir_(sheet, reg, ruc, reg.cliente, periodo, restante, sessionUser);
    return jsonResponse({ ok: true, cantidad: restante.length });
  } finally {
    lock.releaseLock();
  }
}

function handleComprobantesAction(action, body, sessionUser, sessionRole) {
  const routes = {
    comprobantesListar: [function () { return handleComprobantesListar(body); }, 'COMPROBANTES_LISTAR_ERROR'],
    comprobantesLeer: [function () { return handleComprobantesLeer(body); }, 'COMPROBANTES_LEER_ERROR'],
    comprobantesGuardar: [function () { return handleComprobantesGuardar(body, sessionUser); }, 'COMPROBANTES_GUARDAR_ERROR'],
    comprobantesEliminar: [function () { return handleComprobantesEliminar(body, sessionUser); }, 'COMPROBANTES_ELIMINAR_ERROR']
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route[0]();
  } catch (err) {
    return errorResponse(err.message, route[1]);
  }
}
