// Lectura del «Detalle de comprobantes registrados» que se descarga de
// Marangatu (registro de comprobantes, RG 90). Una fila por comprobante:
//
//   RUC del Informante | Nombre o Razon Social del Informante |
//   RUC / Nº de Identificacion del Informado | Tipo de Identificación del Informado |
//   Nombre o Razón Social del Informado | Tipo de Registro (VENTAS/COMPRAS/…) |
//   Tipo de Comprobante | Fecha de Emision | Periodo | Condicion de la Operacion |
//   Operación en Moneda Extranjera | Timbrado del Comprobante | Numero de Comprobante |
//   CDC | Monto Gravado 10% | IVA 10% | Monto Gravado 5% | IVA 5% |
//   Monto No Gravado / Exento | Total Comprobante | Imputa IVA | Imputa IRE |
//   Imputa IRP | No Imputar | Numero de Comprobante Asociado |
//   Timbrado del Comprobante Asociado | Fecha de Registro | Origen de la Información
//
// Los montos gravados vienen con el IVA incluido, igual que en el registro de
// la app. Las columnas se buscan por título, no por posición.

import { dvRuc } from './comprobantesCore.js';

const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => sinAcentos(s).toUpperCase().replace(/[º°]/g, '').replace(/\s+/g, ' ').trim();

// clave → prueba sobre el título normalizado
const TITULOS = {
  rucInformante: (t) => t === 'RUC DEL INFORMANTE',
  nombreInformante: (t) => t.startsWith('NOMBRE O RAZON SOCIAL DEL INFORMANTE'),
  rucInformado: (t) => t.startsWith('RUC / N DE IDENTIFICACION DEL INFORMADO') || t.startsWith('RUC / NRO DE IDENTIFICACION') || (t.includes('IDENTIFICACION DEL INFORMADO') && t.startsWith('RUC')),
  tipoId: (t) => t.startsWith('TIPO DE IDENTIFICACION DEL INFORMADO'),
  nombreInformado: (t) => t.startsWith('NOMBRE O RAZON SOCIAL DEL INFORMADO'),
  tipoRegistro: (t) => t === 'TIPO DE REGISTRO',
  tipoComprobante: (t) => t === 'TIPO DE COMPROBANTE',
  fecha: (t) => t === 'FECHA DE EMISION',
  periodo: (t) => t === 'PERIODO',
  condicion: (t) => t.startsWith('CONDICION DE LA OPERACION'),
  monedaExtranjera: (t) => t.startsWith('OPERACION EN MONEDA EXTRANJERA'),
  timbrado: (t) => t === 'TIMBRADO DEL COMPROBANTE',
  numero: (t) => t === 'NUMERO DE COMPROBANTE',
  cdc: (t) => t === 'CDC',
  g10: (t) => t === 'MONTO GRAVADO 10%',
  iva10: (t) => t === 'IVA 10%',
  g5: (t) => t === 'MONTO GRAVADO 5%',
  iva5: (t) => t === 'IVA 5%',
  ex: (t) => t.startsWith('MONTO NO GRAVADO') || t === 'EXENTO',
  total: (t) => t === 'TOTAL COMPROBANTE',
  imputaIva: (t) => t === 'IMPUTA IVA',
  imputaIre: (t) => t === 'IMPUTA IRE',
  imputaIrp: (t) => t === 'IMPUTA IRP',
  asociado: (t) => t === 'NUMERO DE COMPROBANTE ASOCIADO',
  timbradoAsociado: (t) => t === 'TIMBRADO DEL COMPROBANTE ASOCIADO',
};
const OBLIGATORIAS = ['tipoRegistro', 'tipoComprobante', 'fecha', 'numero', 'total'];

function buscarTitulos(filas) {
  for (let r = 0; r < Math.min(filas.length, 15); r += 1) {
    const f = filas[r] || [];
    const cols = {};
    f.forEach((c, i) => {
      const t = norm(c);
      if (!t) return;
      for (const [k, prueba] of Object.entries(TITULOS)) {
        if (cols[k] === undefined && prueba(t)) { cols[k] = i; break; }
      }
    });
    if (OBLIGATORIAS.every((k) => cols[k] !== undefined)) return { fila: r, cols };
  }
  return null;
}

export function esRegistroMarangatu(filas) {
  return !!buscarTitulos(filas);
}

const texto = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v)) : String(v).trim());
function numero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim();
  if (!s) return 0;
  // «1.234.567» o «1234567,5» → número
  const limpio = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/[.,](?=\d{3}\b)/g, '');
  const n = Number(limpio.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
// «02/10/2026», «2026-10-02» o número de serie de Excel → «2026-10-02»
function fechaIso(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
const si = (v) => /^S/i.test(texto(v));

// Tipo de Registro → operación del registro de la app.
function operacion(tipoRegistro) {
  const t = norm(tipoRegistro);
  if (t.startsWith('VENTA') || t.startsWith('INGRESO')) return 'venta';
  if (t.startsWith('COMPRA') || t.startsWith('EGRESO')) return 'compra';
  return '';
}
// Tipo de Comprobante → factura / nc. Los demás (autofactura, boleta, ticket,
// nota de débito, despacho…) se registran como factura, con el tipo en la nota.
function tipoDe(tipoComprobante) {
  const t = norm(tipoComprobante);
  if (t.includes('NOTA DE CREDITO')) return { tipo: 'nc', otro: '' };
  if (t === 'FACTURA' || t === 'FACTURA ELECTRONICA' || t === 'FACTURA VIRTUAL') return { tipo: 'factura', otro: '' };
  return { tipo: 'factura', otro: tipoComprobante ? String(tipoComprobante).trim() : '' };
}

// filas = matriz (sheet_to_json con header: 1). Devuelve los comprobantes en
// el formato del registro (comprobantesCore) y un resumen.
export function interpretarRegistroMarangatu(filas) {
  const enc = buscarTitulos(filas);
  if (!enc) throw new Error('No es un «Detalle de comprobantes registrados» de Marangatu.');
  const { cols } = enc;
  const val = (f, k) => (cols[k] === undefined ? undefined : f[cols[k]]);
  const comprobantes = [];
  const omitidos = [];
  let informante = { ruc: '', nombre: '' };

  for (let r = enc.fila + 1; r < filas.length; r += 1) {
    const f = filas[r] || [];
    if (!f.some((c) => c !== null && c !== undefined && String(c).trim() !== '')) continue;
    if (!informante.ruc && val(f, 'rucInformante')) {
      informante = { ruc: texto(val(f, 'rucInformante')).replace(/\D/g, ''), nombre: texto(val(f, 'nombreInformante')) };
    }
    const op = operacion(val(f, 'tipoRegistro'));
    const fecha = fechaIso(val(f, 'fecha'));
    const { tipo, otro } = tipoDe(val(f, 'tipoComprobante'));
    if (!op || !fecha) {
      omitidos.push({ fila: r + 1, motivo: !op ? `tipo de registro «${texto(val(f, 'tipoRegistro'))}»` : 'sin fecha' });
      continue;
    }
    const idInformado = texto(val(f, 'rucInformado')).toUpperCase();
    const esRuc = !cols.tipoId || norm(val(f, 'tipoId')) === 'RUC';
    const ruc = esRuc && /^\d{3,9}$/.test(idInformado) ? `${idInformado}-${dvRuc(idInformado)}` : idInformado;
    const g10 = numero(val(f, 'g10'));
    const g5 = numero(val(f, 'g5'));
    let ex = numero(val(f, 'ex'));
    const total = numero(val(f, 'total'));
    // Si sólo viene el total (sin desglose), se toma como exento.
    if (!g10 && !g5 && !ex && total) ex = total;
    const notas = [];
    if (otro) notas.push(otro);
    if (si(val(f, 'monedaExtranjera'))) notas.push('Operación en moneda extranjera (montos en Gs. según Marangatu)');
    const cdc = texto(val(f, 'cdc'));
    if (cdc) notas.push('CDC ' + cdc);
    const asociado = [texto(val(f, 'asociado')), texto(val(f, 'timbradoAsociado')) ? `timbrado ${texto(val(f, 'timbradoAsociado'))}` : '']
      .filter(Boolean).join(' · ');
    comprobantes.push({
      op,
      tipo,
      fecha,
      numero: texto(val(f, 'numero')),
      timbrado: texto(val(f, 'timbrado')).replace(/\D/g, '').slice(0, 8),
      condicion: /CREDITO/.test(norm(val(f, 'condicion'))) ? 'credito' : 'contado',
      moneda: 'PYG',
      ruc,
      nombre: texto(val(f, 'nombreInformado')),
      g10,
      g5,
      ex,
      agro: false,
      imputa: { iva: si(val(f, 'imputaIva')), ire: si(val(f, 'imputaIre')), irp: si(val(f, 'imputaIrp')) },
      asociado: tipo === 'nc' ? asociado.slice(0, 40) : '',
      nota: notas.join(' · ').slice(0, 200),
      // Para comparar con lo que informa Marangatu (no se guarda).
      _iva: numero(val(f, 'iva10')) + numero(val(f, 'iva5')),
      _total: total,
      _tipoOriginal: texto(val(f, 'tipoComprobante')),
    });
  }
  if (!comprobantes.length) throw new Error('El archivo no tiene comprobantes.');
  const periodos = [...new Set(comprobantes.map((c) => c.fecha.slice(0, 7)))].sort();
  const cuenta = (op) => comprobantes.filter((c) => c.op === op).length;
  return { informante, comprobantes, omitidos, periodos, ventas: cuenta('venta'), compras: cuenta('compra') };
}

export async function leerArchivoMarangatu(file) {
  const XLSX = await import('xlsx');
  let wb;
  try {
    wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false });
  } catch {
    throw new Error('No se pudo leer el archivo. Descargalo de Marangatu en Excel (.xlsx).');
  }
  let error = null;
  for (const nombre of wb.SheetNames) {
    const filas = XLSX.utils.sheet_to_json(wb.Sheets[nombre], { header: 1, raw: true, defval: null, blankrows: false });
    try {
      return interpretarRegistroMarangatu(filas);
    } catch (e) {
      error = e;
    }
  }
  throw error || new Error('El archivo está vacío.');
}

// Para Libros IVA: un libro (compras o ventas) con las columnas de leerLibroSiga.
// Un libro es de un solo mes: si el archivo trae varios, se toma el que más
// comprobantes tiene (o `periodo`, «AAAA-MM»).
export function registroALibro(reg, tipoLibro, periodo = '') {
  const op = tipoLibro === 'compras' ? 'compra' : 'venta';
  const delTipo = reg.comprobantes.filter((c) => c.op === op);
  if (!periodo) {
    const cuenta = {};
    delTipo.forEach((c) => { const p = c.fecha.slice(0, 7); cuenta[p] = (cuenta[p] || 0) + 1; });
    periodo = Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a])[0] || reg.periodos[0] || '';
  }
  const lista = delTipo.filter((c) => c.fecha.slice(0, 7) === periodo);
  const columnas = ['dia', 'tipoComprobante', 'documento', 'timbrado', 'ruc', 'razonSocial', 'grav10', 'iva10', 'grav5', 'iva5', 'exentas', 'total'];
  const signo = (c) => (c.tipo === 'nc' ? -1 : 1);
  const comprobantes = lista
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.numero.localeCompare(b.numero))
    .map((c) => {
      const s = signo(c);
      return {
        dia: c.fecha.split('-').reverse().join('/'),
        tipoComprobante: c._tipoOriginal || (c.tipo === 'nc' ? 'NOTA DE CREDITO' : 'FACTURA'),
        documento: c.numero,
        timbrado: c.timbrado,
        ruc: c.ruc,
        razonSocial: c.nombre,
        grav10: s * c.g10,
        iva10: s * Math.round(c.g10 / 11),
        grav5: s * c.g5,
        iva5: s * Math.round(c.g5 / 21),
        exentas: s * c.ex,
        total: s * (c._total || c.g10 + c.g5 + c.ex),
      };
    });
  const totales = {};
  ['grav10', 'iva10', 'grav5', 'iva5', 'exentas', 'total'].forEach((k) => { totales[k] = comprobantes.reduce((x, c) => x + c[k], 0); });
  return {
    otrosMeses: delTipo.length - lista.length,
    tipo: tipoLibro,
    razonSocial: reg.informante.nombre,
    rucInformante: reg.informante.ruc,
    mes: periodo ? Number(periodo.slice(5, 7)) : null,
    anio: periodo ? Number(periodo.slice(0, 4)) : null,
    columnas,
    comprobantes,
    totales,
    totalesArchivo: null,
    coinciden: null,
    diferencias: [],
    anulados: 0,
    origen: 'marangatu',
  };
}
