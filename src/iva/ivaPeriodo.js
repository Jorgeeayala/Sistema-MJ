import { compactHeader } from '../utils';
import { monthIndexFromSheet, ym } from './ivaCore';

// Compartido entre el módulo de IVA y el asistente.

// La hoja mensual de la planilla es el mes de los documentos: su IVA vence el
// mes siguiente. (Hoja "Octubre" → período fiscal octubre, que vence en
// noviembre.) Sin hoja elegida se abre el mes anterior al actual, que es el
// que se está liquidando.
export const DESFASE_PERIODO_FISCAL = 0;
export const DESFASE_SIN_HOJA = -1;

export function initialPeriodo(year, month) {
  const idx = monthIndexFromSheet(month);
  const yearInSheet = String(month || '').match(/\b(20\d{2})\b/);
  const y = Number(yearInSheet ? yearInSheet[1] : year);
  if (idx === null || !y) {
    const now = new Date();
    return ym(now.getFullYear(), now.getMonth() + DESFASE_SIN_HOJA);
  }
  return ym(y, idx + DESFASE_PERIODO_FISCAL);
}

export function findDvColumn(headers) {
  return headers.find((h) => ['dv', 'digitoverificador', 'digito'].includes(compactHeader(h))) || null;
}

export function findWhatsappColumn(headers) {
  return headers.find((h) => /whats|celular|telef|movil/.test(compactHeader(h))) || null;
}
