/**
 * AVISO DIARIO DE VENCIMIENTOS — mensaje automático al grupo contable.
 *
 * Cada mañana manda al grupo de WhatsApp del equipo (por Whaticket) un
 * resumen de los vencimientos de IVA:
 *   - lo que vence hoy y hasta el día del próximo aviso (normalmente hoy y
 *     mañana; el sábado, si el domingo no hay aviso, sábado a lunes), con la
 *     terminación de RUC (VENC.), pendientes por encargado y el monto a
 *     pagar de cada cliente;
 *   - los clientes del período que ya vencieron y siguen sin presentar.
 * Usa los mismos datos que la app: la hoja mensual de la planilla (clientes,
 * RUC, encargado, "Presentado") y la liquidación de IVA (estado, monto y
 * vencimiento manual), con el mismo cálculo de fechas (día 7 + 2·VENC. del
 * mes siguiente al período).
 *
 * Instalación en el proyecto de Apps Script:
 *   1. Archivo nuevo (+ > Secuencia de comandos) llamado "AvisoDiario" y pegar
 *      este contenido completo. Necesita los archivos "Whaticket" (envío al
 *      grupo), "IVA" (liquidaciones) y "Código" (planillas).
 *   2. Ejecutar "probarAvisoDiario": muestra en el registro el mensaje que se
 *      mandaría hoy, SIN enviarlo.
 *   3. Ejecutar "instalarAvisoDiario": programa el envío automático todos los
 *      días a la hora configurada (pide permiso para ejecutarse solo y para
 *      mandar correo).
 *   (No hace falta publicar una nueva versión del Web App: corre solo.)
 *
 * Propiedades opcionales (Configuración del proyecto > Propiedades):
 *   AVISO_DIARIO_HORA    hora del envío, 0 a 23 (por defecto 7, hora de Paraguay).
 *   AVISO_DIARIO_DIAS    días de envío: "1-6" lunes a sábado (por defecto),
 *                        "1-5" lunes a viernes, "0-6" todos los días.
 *   AVISO_DIARIO_EMAIL   correo de respaldo si Whaticket no puede enviar
 *                        (por defecto, el del dueño del script).
 *
 * Otras funciones: "enviarAvisoDiarioAhora" (manda ya, aunque hoy ya se haya
 * mandado) y "desinstalarAvisoDiario" (deja de enviarse solo).
 */

const AD_TZ = 'America/Asuncion';
const AD_HORA_DEFAULT = 7;
const AD_DIAS_DEFAULT = '1-6';
const AD_ULTIMO_PROPERTY = 'AVISO_DIARIO_ULTIMO';
const AD_MAX_CARACTERES = 3800; // WhatsApp admite ~4000 por mensaje
const AD_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const AD_DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// ── FECHAS (mismo criterio que src/iva/ivaCore.js) ─────────────────────
function adProp(name) {
  return String(PropertiesService.getScriptProperties().getProperty(name) || '').trim();
}

// Hoy en Paraguay, como fecha local (medianoche) del script.
function adHoy() {
  const p = Utilities.formatDate(new Date(), AD_TZ, 'yyyy-MM-dd').split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function adIso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function adFromIso(s) {
  const p = String(s).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function adMasDias(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function adFechaCorta(d) {
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
}

// "2026-10" del período fiscal cuyo IVA vence en el mes de la fecha dada.
function adPeriodoQueVence(d) {
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return p.getFullYear() + '-' + String(p.getMonth() + 1).padStart(2, '0');
}

function adUltimoDigito(ruc) {
  const d = String(ruc || '').replace(/\D/g, '');
  return d ? Number(d.slice(-1)) : null;
}

function adVencimiento(periodo, digito, vencManual) {
  if (vencManual && /^\d{4}-\d{2}-\d{2}$/.test(vencManual)) return { fecha: adFromIso(vencManual), manual: true };
  const p = periodo.split('-').map(Number);
  return { fecha: new Date(p[0], p[1], 7 + 2 * digito), manual: false };
}

// Días de envío: "1-6", "1-5", "0-6" o una lista "1,3,5" (0 = domingo).
function adDiasDeEnvio() {
  const raw = adProp('AVISO_DIARIO_DIAS') || AD_DIAS_DEFAULT;
  const dias = {};
  raw.split(',').forEach(function (parte) {
    const m = parte.trim().match(/^(\d)(?:\s*-\s*(\d))?$/);
    if (!m) return;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i <= 6; i++) dias[i] = true;
  });
  return Object.keys(dias).length ? dias : { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true };
}

// ── PLANILLA DEL MES (mismo criterio que src/utils.js) ──────────────────
function adCompact(h) {
  return String(h || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

function adColumnas(headers) {
  const comp = headers.map(adCompact);
  const buscar = function (fn) {
    const i = comp.findIndex(fn);
    return i === -1 ? -1 : i;
  };
  const nombre = (function () {
    const fuerte = /^(cliente|razonsocial|razon|nombre|titular|contribuyente|empresa|denominacion|sociedad|apellido)/;
    const suave = /cliente|razon|nombre|titular|contribuyente|empresa/;
    let i = buscar(function (c) { return fuerte.test(c); });
    if (i === -1) i = buscar(function (c) { return suave.test(c); });
    return i === -1 ? 0 : i;
  })();
  const ruc = buscar(function (c) { return c === 'ruc' || c === 'nroruc' || c === 'ruccliente' || c.indexOf('ruc') === 0; });
  const dv = buscar(function (c) { return c === 'dv' || c === 'digitoverificador' || c === 'digito'; });
  const exactosEncargado = ['encargado', 'encargada', 'responsable', 'asignado', 'asignada', 'asignadoa', 'operador', 'asignacion', 'usuarioresponsable'];
  let encargado = buscar(function (c) { return exactosEncargado.indexOf(c) !== -1; });
  if (encargado === -1) {
    encargado = buscar(function (c) {
      if (/present|archiv|liquid|enviad/.test(c)) return false;
      return /encargad|responsable|asignad/.test(c);
    });
  }
  const exactosPresentado = ['presentado', 'presentada', 'presento', 'presentacion', 'ddjj', 'dj', 'declaracion', 'declaracionjurada', 'declarado', 'liquidado', 'enviado', 'presentados', 'presentadas'];
  const presentado = buscar(function (c) { return exactosPresentado.indexOf(c) !== -1; });
  const presentadoPor = buscar(function (c) { return c.indexOf('presentadopor') === 0 || c === 'presentopor'; });
  return { nombre: nombre, ruc: ruc, dv: dv, encargado: encargado, presentado: presentado, presentadoPor: presentadoPor };
}

function adAfirmativo(v) {
  if (v === true) return true;
  const t = String(v === null || v === undefined ? '' : v).trim().toUpperCase();
  return ['SI', 'SÍ', 'S', 'OK', 'X', 'TRUE', '1', 'V', 'LISTO', 'HECHO', 'PRES', 'PRESENTADO'].indexOf(t) !== -1;
}

function adPresentadoEnPlanilla(row, cols) {
  if (cols.presentado !== -1) return adAfirmativo(row[cols.presentado]);
  if (cols.presentadoPor !== -1) {
    const t = String(row[cols.presentadoPor] || '').trim();
    return Boolean(t) && !/^no?$/i.test(t);
  }
  return false;
}

function adMesDeHoja(nombre) {
  const norm = String(nombre || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (let i = 0; i < AD_MESES.length; i++) if (norm.indexOf(AD_MESES[i]) !== -1) return i;
  const num = norm.match(/\b(0?[1-9]|1[0-2])\b/);
  return num ? Number(num[1]) - 1 : null;
}

// Hoja mensual de la planilla para un período fiscal "AAAA-MM" (la hoja de
// octubre es la del período octubre). Devuelve null si no existe.
function adHojaDelPeriodo(periodo) {
  const p = periodo.split('-').map(Number);
  const anio = String(p[0]);
  const mes = p[1] - 1;
  const nombres = getAvailableSheets(anio).filter(function (n) {
    if (adMesDeHoja(n) !== mes) return false;
    const anioEnNombre = String(n).match(/\b(20\d{2})\b/);
    return !anioEnNombre || anioEnNombre[1] === anio;
  });
  if (!nombres.length) return null;
  const sheet = getMonthSheet(anio, nombres[0]);
  return sheet ? { sheet: sheet, nombre: nombres[0] } : null;
}

// Clientes de la hoja: [{ nombre, ruc, encargado, presentadoPlanilla }].
function adClientesDeHoja(sheet) {
  const data = fillMergedValues(sheet.getDataRange());
  if (data.length < 2) return [];
  const cols = adColumnas(data[0]);
  if (cols.ruc === -1) return [];
  const vistos = {};
  const out = [];
  data.slice(1).forEach(function (row) {
    const crudo = String(row[cols.ruc] || '').trim();
    const ruc = (crudo.indexOf('-') !== -1 ? crudo.split('-')[0] : crudo).replace(/\D/g, '');
    if (!ruc || vistos[ruc]) return;
    vistos[ruc] = true;
    out.push({
      nombre: String(row[cols.nombre] || '').trim() || 'Sin nombre',
      ruc: ruc,
      encargado: cols.encargado !== -1 ? String(row[cols.encargado] || '').trim() : '',
      presentadoPlanilla: adPresentadoEnPlanilla(row, cols)
    });
  });
  return out;
}

// Liquidaciones del período: { ruc: { estado, resultado, monto, vencManual } }.
function adLiquidaciones(periodo) {
  const sheet = getIvaPeriodSheet(periodo, false);
  const out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getDisplayValues().forEach(function (row) {
    const ruc = String(row[0]).trim();
    if (!ruc) return;
    const doc = joinIvaData(row) || {};
    out[ruc] = {
      estado: doc.estado || 'pend',
      resultado: String(row[3] || ''),
      monto: Number(String(row[4] || '').replace(/[^\d-]/g, '')) || 0,
      vencManual: doc.vencManual || ''
    };
  });
  return out;
}

// ── ARMADO DEL MENSAJE ─────────────────────────────────────────────────
function adGs(n) {
  return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Datos del aviso para la fecha "hoy" (Date). Exportado para las pruebas.
function adCalcularAviso(hoy) {
  const diasEnvio = adDiasDeEnvio();
  // Rango: desde hoy hasta el día del próximo aviso, inclusive. Con aviso
  // diario son hoy y mañana; el sábado (sin aviso el domingo) son sábado,
  // domingo y lunes.
  let fin = adMasDias(hoy, 1);
  for (let i = 1; i <= 7; i++) {
    const d = adMasDias(hoy, i);
    if (diasEnvio[d.getDay()]) { fin = d; break; }
  }
  const dias = [];
  for (let d = hoy; adIso(d) <= adIso(fin); d = adMasDias(d, 1)) dias.push(d);

  const periodos = {};
  dias.concat([hoy]).forEach(function (d) { periodos[adPeriodoQueVence(d)] = true; });

  const porFecha = {}; // iso → [cliente]
  const vencidos = []; // clientes vencidos sin presentar (del período que vence este mes)
  const periodoActual = adPeriodoQueVence(hoy);
  const avisosDatos = [];

  Object.keys(periodos).forEach(function (periodo) {
    const hoja = adHojaDelPeriodo(periodo);
    if (!hoja) {
      avisosDatos.push('No encontré la hoja de ' + AD_MESES[Number(periodo.split('-')[1]) - 1] + ' ' + periodo.split('-')[0] + ' en la planilla.');
      return;
    }
    const liqs = adLiquidaciones(periodo);
    adClientesDeHoja(hoja.sheet).forEach(function (c) {
      const t = adUltimoDigito(c.ruc);
      if (t === null) return;
      const l = liqs[c.ruc] || null;
      const v = adVencimiento(periodo, t, l && l.vencManual);
      const presentado = c.presentadoPlanilla || (l && l.estado === 'pres');
      const item = {
        nombre: c.nombre,
        encargado: c.encargado || 'Sin asignar',
        digito: t,
        manual: v.manual,
        estado: presentado ? 'pres' : (l ? l.estado : 'none'),
        resultado: l ? l.resultado : '',
        monto: l ? l.monto : 0,
        fecha: v.fecha
      };
      const clave = adIso(v.fecha);
      if (dias.some(function (d) { return adIso(d) === clave; })) {
        (porFecha[clave] = porFecha[clave] || []).push(item);
      } else if (periodo === periodoActual && clave < adIso(hoy) && !presentado) {
        vencidos.push(item);
      }
    });
  });

  return { hoy: hoy, dias: dias, porFecha: porFecha, vencidos: vencidos, avisosDatos: avisosDatos };
}

function adAgruparPorEncargado(items) {
  const grupos = {};
  items.forEach(function (it) { (grupos[it.encargado] = grupos[it.encargado] || []).push(it); });
  return Object.keys(grupos)
    .sort(function (a, b) { return grupos[b].length - grupos[a].length || a.localeCompare(b); })
    .map(function (e) { return { encargado: e, items: grupos[e] }; });
}

// Formato corto: por cada día, totales y pendientes por encargado (sólo la
// cantidad); se nombran únicamente los clientes que ya tienen monto a pagar
// (como mucho AD_MAX_A_PAGAR). Los vencidos van como cantidad por encargado.
const AD_MAX_A_PAGAR = 5;

function adConteoPorEncargado(items) {
  return adAgruparPorEncargado(items)
    .map(function (g) { return g.encargado + ' ' + g.items.length; })
    .join(' · ');
}

function adArmarMensaje(datos) {
  const hoy = datos.hoy;
  const lineas = [];
  lineas.push('*Vencimientos IVA — ' + AD_DIAS_SEMANA[hoy.getDay()] + ' ' + adFechaCorta(hoy) + '*');

  let hayAlgo = false;
  datos.dias.forEach(function (d, idx) {
    const items = datos.porFecha[adIso(d)] || [];
    if (!items.length) return;
    hayAlgo = true;
    const digitos = {};
    items.forEach(function (it) { if (!it.manual) digitos[it.digito] = true; });
    const titulo = idx === 0 ? 'Hoy' : idx === 1 ? 'Mañana' : AD_DIAS_SEMANA[d.getDay()].charAt(0).toUpperCase() + AD_DIAS_SEMANA[d.getDay()].slice(1);
    const venc = Object.keys(digitos).length ? ' · VENC. ' + Object.keys(digitos).join(', ') : '';
    const pendientes = items.filter(function (it) { return it.estado !== 'pres'; });
    const presentados = items.length - pendientes.length;
    lineas.push('');
    lineas.push('*' + titulo + ' ' + adFechaCorta(d) + venc + '*');
    if (!pendientes.length) {
      lineas.push(items.length + ' cliente' + (items.length === 1 ? '' : 's') + ' · todo presentado ✅');
      return;
    }
    const sinCargar = pendientes.filter(function (it) { return it.estado === 'none'; }).length;
    lineas.push(pendientes.length + ' sin presentar de ' + items.length +
      (presentados ? ' (' + presentados + ' presentado' + (presentados === 1 ? '' : 's') + ')' : '') +
      (sinCargar ? ' · ' + sinCargar + ' sin liquidación' : ''));
    lineas.push(adConteoPorEncargado(pendientes));
    const aPagar = pendientes
      .filter(function (it) { return it.resultado === 'A pagar' && it.monto > 0; })
      .sort(function (a, b) { return b.monto - a.monto; });
    if (aPagar.length) {
      const total = aPagar.reduce(function (s, it) { return s + it.monto; }, 0);
      const nombres = aPagar.slice(0, AD_MAX_A_PAGAR).map(function (it) { return it.nombre + ' ' + adGs(it.monto); });
      lineas.push('A pagar Gs. ' + adGs(total) + ': ' + nombres.join(', ') +
        (aPagar.length > AD_MAX_A_PAGAR ? ' y ' + (aPagar.length - AD_MAX_A_PAGAR) + ' más' : ''));
    }
  });

  if (datos.vencidos.length) {
    hayAlgo = true;
    lineas.push('');
    lineas.push('*Vencidos sin presentar: ' + datos.vencidos.length + '*');
    lineas.push(adConteoPorEncargado(datos.vencidos));
  }

  if (!hayAlgo) return null;

  datos.avisosDatos.forEach(function (a) { lineas.push('', '⚠️ ' + a); });
  lineas.push('', '_Detalle en Sistema MJ → Vencimientos IVA_');

  let texto = lineas.join('\n');
  if (texto.length > AD_MAX_CARACTERES) texto = texto.slice(0, AD_MAX_CARACTERES - 2).replace(/\n[^\n]*$/, '') + '\n…';
  return texto;
}

// ── ENVÍO ──────────────────────────────────────────────────────────────
function adCorreoRespaldo() {
  return adProp('AVISO_DIARIO_EMAIL') || Session.getEffectiveUser().getEmail();
}

// Manda el texto al grupo contable; si Whaticket no puede, lo manda por correo.
function adEnviar(texto) {
  try {
    const grupo = wtBuscarGrupo();
    wtResponderTicket(grupo.id, texto, '');
    registrarEnvioWhaticket('Aviso diario', 'grupo', { cliente: 'Aviso diario de vencimientos' }, '', 'grupo', true, '');
    return { ok: true, via: 'whaticket' };
  } catch (err) {
    registrarEnvioWhaticket('Aviso diario', 'grupo', { cliente: 'Aviso diario de vencimientos' }, '', 'grupo', false, err.message);
    const correo = adCorreoRespaldo();
    if (correo) {
      MailApp.sendEmail(
        correo,
        'Sistema MJ — aviso de vencimientos (no se pudo enviar al grupo)',
        'No se pudo mandar el aviso al grupo contable por Whaticket:\n' + err.message +
        '\n\nEste es el aviso de hoy:\n\n' + texto.replace(/\*/g, '').replace(/_/g, '')
      );
      return { ok: false, via: 'correo', error: err.message };
    }
    throw err;
  }
}

function adConstruirTexto() {
  return adArmarMensaje(adCalcularAviso(adHoy()));
}

// Lo ejecuta el disparador programado.
function enviarAvisoDiario() {
  const hoy = adHoy();
  if (!adDiasDeEnvio()[hoy.getDay()]) return;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(AD_ULTIMO_PROPERTY) === adIso(hoy)) return; // ya se mandó hoy
  const texto = adArmarMensaje(adCalcularAviso(hoy));
  props.setProperty(AD_ULTIMO_PROPERTY, adIso(hoy));
  if (!texto) return; // nada que avisar
  adEnviar(texto);
}

// ── FUNCIONES PARA EJECUTAR A MANO DESDE EL EDITOR ─────────────────────
// Muestra el aviso de hoy en el registro, sin enviarlo.
function probarAvisoDiario() {
  const texto = adConstruirTexto();
  Logger.log(texto || 'Hoy no hay vencimientos ni vencidos para avisar: no se enviaría nada.');
  Logger.log('Días de envío: ' + (adProp('AVISO_DIARIO_DIAS') || AD_DIAS_DEFAULT) +
    ' · hora: ' + (adProp('AVISO_DIARIO_HORA') || AD_HORA_DEFAULT) + ' · zona del script: ' + Session.getScriptTimeZone());
}

// Manda el aviso de hoy ya mismo (aunque ya se haya mandado).
function enviarAvisoDiarioAhora() {
  const texto = adConstruirTexto();
  if (!texto) {
    Logger.log('Hoy no hay vencimientos ni vencidos para avisar: no se envió nada.');
    return;
  }
  const r = adEnviar(texto);
  Logger.log(r.ok ? 'Aviso enviado al grupo contable.' : 'No se pudo enviar por Whaticket; se mandó por correo a ' + adCorreoRespaldo() + '. Motivo: ' + r.error);
}

// Programa el envío automático diario (reemplaza el anterior si existía).
function instalarAvisoDiario() {
  desinstalarAvisoDiario();
  const hora = Math.min(23, Math.max(0, parseInt(adProp('AVISO_DIARIO_HORA'), 10) || AD_HORA_DEFAULT));
  ScriptApp.newTrigger('enviarAvisoDiario').timeBased().everyDays(1).atHour(hora).inTimezone(AD_TZ).create();
  Logger.log('Aviso diario programado todos los días a las ' + hora + ' h (Paraguay). Días con envío: ' +
    (adProp('AVISO_DIARIO_DIAS') || AD_DIAS_DEFAULT) + '. Correo de respaldo: ' + adCorreoRespaldo());
}

function desinstalarAvisoDiario() {
  let quitados = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'enviarAvisoDiario') {
      ScriptApp.deleteTrigger(t);
      quitados++;
    }
  });
  Logger.log(quitados ? 'Aviso diario desprogramado.' : 'No había aviso diario programado.');
}
