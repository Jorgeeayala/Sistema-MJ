// Registro de comprobantes: modelo, validaciones, totales y pase al
// Formulario 120 (IVA). Sin React, para poder probarlo suelto.
//
// Un comprobante se guarda una vez por cliente y mes (el de su fecha) y se
// marca a qué impuestos se imputa, como en el registro de la RG 90. Los
// montos gravados se cargan con el IVA incluido (como figuran en la factura).

import { LIST_BY } from '../iva/ivaCore.js';

export const OPERACIONES = { venta: 'Venta', compra: 'Compra' };
export const TIPOS = { factura: 'Factura', nc: 'Nota de crédito', recibo: 'Recibo de dinero' };
// Recibos: quién lo emite. «cliente» = el cliente cobra (lo emite él);
// «tercero» = el cliente pagó y le dieron el recibo; «estudio» = honorarios
// que cobra el estudio al cliente.
export const EMISORES = { cliente: 'Emitido por el cliente', tercero: 'Recibido por el cliente', estudio: 'Emitido por el estudio (honorarios)' };
export const FORMAS_PAGO = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', tarjeta: 'Tarjeta', otro: 'Otro' };
export const esRecibo = (c) => c && c.tipo === 'recibo';
// El sistema numera los recibos que emite (el cliente o el estudio).
export const reciboEmitido = (c) => esRecibo(c) && c.emisor !== 'tercero';
export const CONDICIONES = { contado: 'Contado', credito: 'Crédito' };
export const MONEDAS = { PYG: 'Guaraníes', USD: 'Dólares' };
export const IMPUESTOS = { iva: 'IVA', ire: 'IRE', irp: 'IRP-RSP' };

const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
};

export function nuevoId() {
  return 'cp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function comprobanteVacio(base = {}) {
  return {
    id: '',
    op: base.op || 'venta',
    tipo: base.tipo || 'factura',
    fecha: base.fecha || '',
    numero: '',
    timbrado: '',
    condicion: base.condicion || 'contado',
    moneda: base.moneda || 'PYG',
    cambio: base.cambio || '',
    ruc: '',
    nombre: '',
    g10: '',
    g5: '',
    ex: '',
    agro: false,
    imputa: { iva: true, ire: false, irp: false, ...(base.imputa || {}) },
    asociado: '',
    nota: '',
    // Recibos
    emisor: base.emisor || 'cliente',
    monto: '',
    concepto: '',
    facturas: '',
    formaPago: base.formaPago || 'efectivo',
    detallePago: '',
  };
}

// Deja un comprobante con los tipos y largos correctos (lo que se guarda).
export function normalizar(c) {
  const tipo = TIPOS[c.tipo] ? c.tipo : 'factura';
  const moneda = c.moneda === 'USD' ? 'USD' : 'PYG';
  const comunes = {
    id: txt(c.id, 60) || nuevoId(),
    tipo,
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(c.fecha || '') ? c.fecha : '',
    moneda,
    cambio: moneda === 'USD' ? num(c.cambio) : 0,
    ruc: txt(c.ruc, 20).toUpperCase(),
    nombre: txt(c.nombre, 120),
    nota: txt(c.nota, 200),
  };
  let out;
  if (tipo === 'recibo') {
    const emisor = EMISORES[c.emisor] ? c.emisor : 'cliente';
    out = {
      ...comunes,
      op: emisor === 'cliente' ? 'venta' : 'compra',
      emisor,
      numero: txt(c.numero, 40),
      monto: num(c.monto),
      concepto: txt(c.concepto, 300),
      facturas: txt(c.facturas, 200),
      formaPago: FORMAS_PAGO[c.formaPago] ? c.formaPago : 'efectivo',
      detallePago: txt(c.detallePago, 120),
      imputa: { iva: false, ire: false, irp: false },
    };
    // Datos de quien emite, tal como salen impresos (se guardan con el recibo
    // para poder volver a imprimirlo igual).
    if (emisor !== 'tercero' && c.emisorDatos) {
      const e = c.emisorDatos;
      out.emisorDatos = { nombre: txt(e.nombre, 120), ruc: txt(e.ruc, 20), direccion: txt(e.direccion, 120), telefono: txt(e.telefono, 40), ciudad: txt(e.ciudad, 60) };
    }
  } else {
    const imp = c.imputa || {};
    out = {
      ...comunes,
      op: c.op === 'compra' ? 'compra' : 'venta',
      numero: formatearNumero(c.numero),
      timbrado: String(c.timbrado ?? '').replace(/\D/g, '').slice(0, 8),
      condicion: c.condicion === 'credito' ? 'credito' : 'contado',
      g10: num(c.g10),
      g5: num(c.g5),
      ex: num(c.ex),
      agro: !!c.agro && num(c.g5) > 0,
      imputa: { iva: !!imp.iva, ire: !!imp.ire, irp: !!imp.irp },
      asociado: tipo === 'nc' ? txt(c.asociado, 40) : '',
    };
  }
  if (c.cargadoPor) out.cargadoPor = txt(c.cargadoPor, 80);
  if (c.cargadoEl) out.cargadoEl = txt(c.cargadoEl, 40);
  return out;
}

// "1-1-123" → "001-001-0000123". Si no tiene esa forma, se deja como vino.
export function formatearNumero(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,3})\s*-\s*(\d{1,3})\s*-\s*(\d{1,7})$/);
  if (m) return `${m[1].padStart(3, '0')}-${m[2].padStart(3, '0')}-${m[3].padStart(7, '0')}`;
  const solo = s.replace(/\D/g, '');
  if (solo.length === 13 && /^[\d\s-]+$/.test(s)) return `${solo.slice(0, 3)}-${solo.slice(3, 6)}-${solo.slice(6)}`;
  return s.slice(0, 40);
}
export const numeroValido = (v) => /^\d{3}-\d{3}-\d{7}$/.test(String(v || ''));

// Dígito verificador del RUC paraguayo (módulo 11, base máxima 11).
export function dvRuc(base) {
  const s = String(base || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!s) return null;
  const digitos = s.split('').map((ch) => (/\d/.test(ch) ? ch : String(ch.charCodeAt(0)))).join('');
  let k = 2;
  let total = 0;
  for (let i = digitos.length - 1; i >= 0; i--) {
    total += Number(digitos[i]) * k;
    k = k === 11 ? 2 : k + 1;
  }
  const resto = total % 11;
  return resto > 1 ? 11 - resto : 0;
}

// null = no se puede revisar (sin guion: cédula, documento extranjero, etc.)
export function rucValido(v) {
  const m = String(v || '').trim().match(/^([0-9A-Za-z]+)-(\d)$/);
  if (!m) return null;
  return dvRuc(m[1]) === Number(m[2]);
}

export const periodoDe = (fecha) => (/^\d{4}-\d{2}/.test(fecha || '') ? fecha.slice(0, 7) : '');

// Montos en guaraníes (los de dólares se pasan con el tipo de cambio).
export function calcular(c) {
  const f = c.moneda === 'USD' ? Number(c.cambio) || 0 : 1;
  if (esRecibo(c)) {
    const total = Math.round((Number(c.monto) || 0) * f);
    return { g10: 0, g5: 0, ex: 0, iva10: 0, iva5: 0, base10: 0, base5: 0, iva: 0, total };
  }
  const g10 = Math.round((Number(c.g10) || 0) * f);
  const g5 = Math.round((Number(c.g5) || 0) * f);
  const ex = Math.round((Number(c.ex) || 0) * f);
  const iva10 = Math.round(g10 / 11);
  const iva5 = Math.round(g5 / 21);
  return { g10, g5, ex, iva10, iva5, base10: g10 - iva10, base5: g5 - iva5, iva: iva10 + iva5, total: g10 + g5 + ex };
}

// Totales del mes, separando ventas y compras. Las notas de crédito restan.
export function totales(lista) {
  const t = {
    venta: { cantidad: 0, total: 0, iva: 0, g10: 0, g5: 0, ex: 0 },
    compra: { cantidad: 0, total: 0, iva: 0, g10: 0, g5: 0, ex: 0 },
  };
  t.recibos = { emitidos: { cantidad: 0, total: 0 }, recibidos: { cantidad: 0, total: 0 } };
  for (const c of lista) {
    const k = calcular(c);
    if (esRecibo(c)) {
      const r = t.recibos[reciboEmitido(c) ? 'emitidos' : 'recibidos'];
      r.cantidad += 1;
      r.total += k.total;
      continue;
    }
    const s = c.tipo === 'nc' ? -1 : 1;
    const d = t[c.op === 'compra' ? 'compra' : 'venta'];
    d.cantidad += 1;
    d.total += s * k.total;
    d.iva += s * k.iva;
    d.g10 += s * k.g10;
    d.g5 += s * k.g5;
    d.ex += s * k.ex;
  }
  // Débito de ventas menos crédito de compras (sólo lo imputado a IVA).
  const ivaImputado = (op) => lista
    .filter((c) => !esRecibo(c) && c.op === op && c.imputa && c.imputa.iva)
    .reduce((s, c) => s + (c.tipo === 'nc' ? -1 : 1) * calcular(c).iva, 0);
  t.saldoIva = ivaImputado('venta') - ivaImputado('compra');
  return t;
}

// Casilla del Formulario 120 a la que va cada parte de un comprobante.
// Ventas: factura emitida → débito; NC emitida → resta débito.
// Compras: factura recibida → crédito; NC recibida → resta crédito.
function casillas(c) {
  const venta = c.op !== 'compra';
  if (c.tipo === 'nc') {
    return venta
      ? { g10: 'ncv10', g5: 'ncv5', ex: 'ncvex' }
      : { g10: 'ncc10', g5: c.agro ? 'ncc5a' : 'ncc5', ex: 'nccex' };
  }
  return venta
    ? { g10: 'v10', g5: c.agro ? 'v5a' : 'v5', ex: 'vex' }
    : { g10: 'c10', g5: 'c5', ex: 'cex' };
}

// Arma las listas del editor de IVA (ivaCore LISTS) con los comprobantes
// imputados a IVA. Cada monto va con IVA incluido (iva: true = se extrae).
export function aListasIva(lista) {
  const out = {};
  const usados = [];
  const ordenados = [...lista].sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '') || (a.numero || '').localeCompare(b.numero || ''));
  for (const c of ordenados) {
    if (esRecibo(c) || !c.imputa || !c.imputa.iva) continue;
    const k = calcular(c);
    const dest = casillas(c);
    const contraparte = [c.ruc, c.nombre].filter(Boolean).join(' ');
    let alguno = false;
    for (const parte of ['g10', 'g5', 'ex']) {
      if (!k[parte]) continue;
      const key = dest[parte];
      if (!LIST_BY[key]) continue;
      (out[key] = out[key] || []).push({ m: k[parte], iva: true, f: c.fecha || '', n: c.numero || '', tb: c.timbrado || '', t: contraparte.slice(0, 80) });
      alguno = true;
    }
    if (alguno) usados.push(c.id);
  }
  return { listas: out, usados };
}

// Avisos (no bloquean) para mostrar en el formulario.
export function revisar(c, lista = []) {
  if (esRecibo(c)) return revisarRecibo(c, lista);
  const avisos = [];
  const errores = [];
  if (!c.fecha) errores.push('Falta la fecha.');
  if (!c.numero) errores.push('Falta el número del comprobante.');
  else if (!numeroValido(c.numero)) avisos.push('El número no tiene la forma 001-001-0000001.');
  if (!c.timbrado) avisos.push('Falta el timbrado.');
  else if (c.timbrado.length !== 8) avisos.push('El timbrado suele tener 8 dígitos.');
  if (!c.nombre && !c.ruc) errores.push(`Falta el ${c.op === 'compra' ? 'proveedor' : 'cliente'}.`);
  if (rucValido(c.ruc) === false) avisos.push(`El dígito verificador del RUC no coincide (debería ser ${dvRuc(c.ruc.split('-')[0])}).`);
  if (c.moneda === 'USD' && !(Number(c.cambio) > 0)) errores.push('Falta el tipo de cambio.');
  if (!(Number(c.g10) > 0 || Number(c.g5) > 0 || Number(c.ex) > 0)) errores.push('Cargá al menos un monto.');
  if (!c.imputa || !(c.imputa.iva || c.imputa.ire || c.imputa.irp)) avisos.push('No se imputa a ningún impuesto.');
  if (c.tipo === 'nc' && !c.asociado) avisos.push('Indicá el comprobante al que corresponde la nota de crédito.');
  const dup = lista.find((x) => x.id !== c.id && x.op === c.op && x.tipo === c.tipo && x.numero === c.numero
    && (x.timbrado || '') === (c.timbrado || '') && String(x.ruc || '').replace(/\D/g, '') === String(c.ruc || '').replace(/\D/g, ''));
  if (dup && c.numero) errores.push('Ese comprobante ya está cargado este mes.');
  return { errores, avisos };
}

function revisarRecibo(c, lista) {
  const avisos = [];
  const errores = [];
  if (!c.fecha) errores.push('Falta la fecha.');
  if (!c.nombre && !c.ruc) errores.push(c.emisor === 'tercero' ? 'Falta quién emitió el recibo.' : 'Falta de quién se recibe el dinero.');
  if (!(Number(c.monto) > 0)) errores.push('Falta el monto.');
  if (c.moneda === 'USD' && !(Number(c.cambio) > 0)) errores.push('Falta el tipo de cambio.');
  if (c.emisor === 'tercero' && !c.numero) avisos.push('Falta el número del recibo.');
  if (!c.concepto) avisos.push('Conviene indicar el concepto.');
  if (rucValido(c.ruc) === false) avisos.push(`El dígito verificador del RUC no coincide (debería ser ${dvRuc(c.ruc.split('-')[0])}).`);
  if (c.numero) {
    const dup = lista.find((x) => x.id !== c.id && x.tipo === 'recibo' && (x.emisor || 'cliente') === (c.emisor || 'cliente') && x.numero === c.numero
      && (c.emisor !== 'tercero' || String(x.ruc || '').replace(/\D/g, '') === String(c.ruc || '').replace(/\D/g, '')));
    if (dup) errores.push('Ya hay un recibo con ese número este mes.');
  }
  return { errores, avisos };
}

// ── Monto en letras (para el recibo) ───────────────────────────────────
const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece',
  'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés',
  'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function menorMil(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const r = n % 100;
  let t = CENTENAS[c];
  if (r) {
    const d = r < 30 ? UNIDADES[r] : DECENAS[Math.floor(r / 10)] + (r % 10 ? ' y ' + UNIDADES[r % 10] : '');
    t = (t ? t + ' ' : '') + d;
  }
  return t;
}

// 1234567 → "un millón doscientos treinta y cuatro mil quinientos sesenta y siete"
export function numeroALetras(valor) {
  let n = Math.floor(Math.abs(Number(valor) || 0));
  if (n === 0) return 'cero';
  const partes = [];
  const grupos = [[1e12, 'billón', 'billones'], [1e6, 'millón', 'millones'], [1e3, 'mil', 'mil']];
  for (const [base, sing, plur] of grupos) {
    const q = Math.floor(n / base);
    n %= base;
    if (!q) continue;
    if (base === 1e3) partes.push(q === 1 ? 'mil' : numeroALetras(q).replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un') + ' mil');
    else partes.push(q === 1 ? 'un ' + sing : numeroALetras(q).replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un') + ' ' + plur);
  }
  if (n) partes.push(menorMil(n));
  return partes.join(' ');
}

// Texto del monto del recibo: «un millón ... guaraníes» / «... dólares con 50/100».
export function montoEnLetras(monto, moneda) {
  const n = Math.round((Number(monto) || 0) * 100) / 100;
  const entero = Math.floor(n);
  const cent = Math.round((n - entero) * 100);
  let t = numeroALetras(entero).replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un');
  if (/(millón|millones|billón|billones)$/.test(t)) t += ' de'; // «un millón de guaraníes»
  if (moneda === 'USD') return `${t} ${entero === 1 ? 'dólar americano' : 'dólares americanos'}${cent ? ` con ${String(cent).padStart(2, '0')}/100` : ''}`;
  return `${t} ${entero === 1 ? 'guaraní' : 'guaraníes'}`;
}
