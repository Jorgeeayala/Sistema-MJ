/**
 * MÓDULO COMPROBANTES - archivo aparte del backend de Control Clientes.
 *
 * Registro de comprobantes por cliente (facturas y notas de crédito de
 * ventas y compras, con timbrado y a qué impuesto se imputan, y recibos de
 * dinero emitidos o recibidos). La app arma desde acá el Formulario 120 de
 * IVA y, más adelante, el IRP. Los recibos que emite el sistema (del cliente
 * o de honorarios del estudio) se numeran solos: el contador de cada emisor
 * queda en las propiedades del script (CP_RECIBO_<RUC> y CP_RECIBO_ESTUDIO).
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
const CP_FORMAS_PAGO = ['efectivo', 'transferencia', 'cheque', 'tarjeta', 'otro'];
const CP_EMISORES = ['cliente', 'tercero', 'estudio'];

function cpNormalizar_(c, usuario) {
  c = c || {};
  const tipo = c.tipo === 'nc' || c.tipo === 'recibo' ? c.tipo : 'factura';
  const moneda = c.moneda === 'USD' ? 'USD' : 'PYG';
  const out = {
    id: cpTexto_(c.id, 60) || 'cp-' + Utilities.getUuid(),
    tipo: tipo,
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(c.fecha || '')) ? String(c.fecha) : '',
    moneda: moneda,
    cambio: moneda === 'USD' ? cpNum_(c.cambio) : 0,
    ruc: cpTexto_(c.ruc, 20).toUpperCase(),
    nombre: cpTexto_(c.nombre, 120),
    nota: cpTexto_(c.nota, 200),
    cargadoPor: cpTexto_(usuario, 80),
    cargadoEl: new Date().toISOString()
  };
  if (tipo === 'recibo') {
    const emisor = CP_EMISORES.indexOf(c.emisor) >= 0 ? c.emisor : 'cliente';
    out.op = emisor === 'cliente' ? 'venta' : 'compra';
    out.emisor = emisor;
    out.numero = cpTexto_(c.numero, 40);
    out.monto = cpNum_(c.monto);
    out.concepto = cpTexto_(c.concepto, 300);
    out.facturas = cpTexto_(c.facturas, 200);
    out.formaPago = CP_FORMAS_PAGO.indexOf(c.formaPago) >= 0 ? c.formaPago : 'efectivo';
    out.detallePago = cpTexto_(c.detallePago, 120);
    out.imputa = { iva: false, ire: false, irp: false };
    if (emisor !== 'tercero' && c.emisorDatos) {
      const e = c.emisorDatos;
      out.emisorDatos = {
        nombre: cpTexto_(e.nombre, 120), ruc: cpTexto_(e.ruc, 20), direccion: cpTexto_(e.direccion, 120),
        telefono: cpTexto_(e.telefono, 40), ciudad: cpTexto_(e.ciudad, 60)
      };
    }
    return out;
  }
  const imp = c.imputa || {};
  out.op = c.op === 'compra' ? 'compra' : 'venta';
  out.numero = cpTexto_(c.numero, 40);
  out.timbrado = cpTexto_(c.timbrado, 20).replace(/\D/g, '').slice(0, 8);
  out.condicion = c.condicion === 'credito' ? 'credito' : 'contado';
  out.g10 = cpNum_(c.g10);
  out.g5 = cpNum_(c.g5);
  out.ex = cpNum_(c.ex);
  out.agro = !!c.agro && cpNum_(c.g5) > 0;
  out.imputa = { iva: !!imp.iva, ire: !!imp.ire, irp: !!imp.irp };
  out.asociado = tipo === 'nc' ? cpTexto_(c.asociado, 40) : '';
  return out;
}

// Numeración de los recibos que emite el sistema: un contador por emisor
// (el estudio, o cada cliente por su RUC) en las propiedades del script.
// Se llama dentro del bloqueo. Si se escribe un número a mano más alto, el
// contador sigue desde ese.
function cpClaveContador_(c, ruc) {
  return 'CP_RECIBO_' + (c.emisor === 'estudio' ? 'ESTUDIO' : ruc);
}
function cpNumerarRecibo_(c, ruc) {
  if (c.tipo !== 'recibo' || c.emisor === 'tercero') return;
  const props = PropertiesService.getScriptProperties();
  const clave = cpClaveContador_(c, ruc);
  const actual = Number(props.getProperty(clave)) || 0;
  if (!c.numero) {
    c.numero = String(actual + 1).padStart(7, '0');
    props.setProperty(clave, String(actual + 1));
  } else if (/^\d+$/.test(c.numero) && Number(c.numero) > actual) {
    props.setProperty(clave, String(Number(c.numero)));
  }
}

function cpTotales_(lista) {
  const t = { ventas: 0, compras: 0, ivaVentas: 0, ivaCompras: 0 };
  lista.forEach(function (c) {
    if (c.tipo === 'recibo') return;
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
  if (c.tipo === 'recibo' ? !c.monto : !(c.g10 || c.g5 || c.ex)) return errorResponse('El comprobante no tiene montos', 'COMPROBANTE_VACIO');
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
    // Al editar un recibo se conserva su número; los nuevos se numeran acá.
    const previo = lista.filter(function (x) { return x.id === c.id; })[0];
    if (c.tipo === 'recibo' && !c.numero && previo && previo.numero) c.numero = previo.numero;
    const dup = lista.filter(function (x) {
      if (x.id === c.id || x.tipo !== c.tipo || !c.numero || x.numero !== c.numero) return false;
      if (c.tipo === 'recibo') {
        return (x.emisor || 'cliente') === c.emisor && (c.emisor !== 'tercero' || sinDv(x.ruc) === sinDv(c.ruc));
      }
      return x.op === c.op && (x.timbrado || '') === c.timbrado && sinDv(x.ruc) === sinDv(c.ruc);
    })[0];
    if (dup) return jsonResponse({ ok: false, code: 'COMPROBANTE_DUPLICADO', error: 'Ese comprobante ya está cargado en ese mes', existente: dup });
    cpNumerarRecibo_(c, ruc);

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

// Importación en bloque (p. ej. el «Detalle de comprobantes registrados» de
// Marangatu). body: { ruc, cliente, comprobantes: [...] }. Los que ya están
// (mismo tipo, operación, número, timbrado y RUC) se saltean.
function cpClaveDup_(x) {
  return [x.op, x.tipo, x.numero, x.timbrado || '', String(x.ruc || '').replace(/\D/g, '')].join('|');
}
function handleComprobantesImportar(body, sessionUser) {
  const ruc = cpRuc_(body.ruc);
  if (!ruc) return errorResponse('Elegí el cliente', 'COMPROBANTES_DATOS');
  const entrada = Array.isArray(body.comprobantes) ? body.comprobantes : [];
  if (!entrada.length) return errorResponse('No hay comprobantes para importar', 'COMPROBANTE_VACIO');
  if (entrada.length > COMPROBANTES_MAX_MES) return errorResponse('Son demasiados comprobantes para una sola importación (máximo ' + COMPROBANTES_MAX_MES + ')', 'COMPROBANTES_LLENO');
  const porPeriodo = {};
  let invalidos = 0;
  entrada.forEach(function (raw) {
    const c = cpNormalizar_(raw, sessionUser);
    c.id = 'cp-' + Utilities.getUuid(); // siempre nuevos
    if (!c.fecha || c.tipo === 'recibo' || !(c.g10 || c.g5 || c.ex)) { invalidos++; return; }
    const p = c.fecha.slice(0, 7);
    (porPeriodo[p] = porPeriodo[p] || []).push(c);
  });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return errorResponse('El registro está ocupado, intentá de nuevo', 'COMPROBANTES_LOCK_TIMEOUT');
  try {
    const sheet = ensureComprobantesSheet();
    let agregados = 0;
    let repetidos = 0;
    const meses = [];
    Object.keys(porPeriodo).sort().forEach(function (periodo) {
      const reg = cpBuscar_(cpLeerIndice_(sheet), ruc, periodo);
      const lista = reg ? cpLeerLista_(sheet, reg.fila) : [];
      const vistos = {};
      lista.forEach(function (x) { vistos[cpClaveDup_(x)] = true; });
      let nuevos = 0;
      porPeriodo[periodo].forEach(function (c) {
        const k = cpClaveDup_(c);
        if (vistos[k]) { repetidos++; return; }
        if (lista.length >= COMPROBANTES_MAX_MES) { invalidos++; return; }
        vistos[k] = true;
        lista.push(c);
        nuevos++;
      });
      if (nuevos) {
        cpEscribir_(sheet, reg, ruc, cpTexto_(body.cliente, 200), periodo, lista, sessionUser);
        agregados += nuevos;
      }
      meses.push({ periodo: periodo, agregados: nuevos });
    });
    return jsonResponse({ ok: true, agregados: agregados, repetidos: repetidos, invalidos: invalidos, meses: meses });
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
    comprobantesEliminar: [function () { return handleComprobantesEliminar(body, sessionUser); }, 'COMPROBANTES_ELIMINAR_ERROR'],
    comprobantesImportar: [function () { return handleComprobantesImportar(body, sessionUser); }, 'COMPROBANTES_IMPORTAR_ERROR']
  };
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return null;
  try {
    return route[0]();
  } catch (err) {
    return errorResponse(err.message, route[1]);
  }
}
