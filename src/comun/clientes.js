import { splitRuc } from '../iva/ivaCore.js';
import { compactHeader } from '../utils';

export const sinAcentos = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function findDvColumn(headers) {
  return headers.find((h) => ['dv', 'digitoverificador', 'digito'].includes(compactHeader(h))) || null;
}

// Clientes de la hoja del mes, identificados por RUC sin DV: [{ ruc, dv, nombre }].
export function clientesDeFilas(rows, headers, nameKey, rucKey) {
  const dvKey = findDvColumn(headers || []);
  const m = new Map();
  (rows || []).forEach((row) => {
    const { ruc, dv } = rucKey ? splitRuc(row[rucKey], dvKey ? row[dvKey] : '') : { ruc: '', dv: '' };
    const nombre = String((nameKey && row[nameKey]) || '').trim();
    if (ruc && nombre && !m.has(ruc)) m.set(ruc, { ruc, dv, nombre });
  });
  return m;
}
