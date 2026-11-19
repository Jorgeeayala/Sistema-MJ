// PDF del recibo de dinero: A4 vertical con ORIGINAL y DUPLICADO (dos
// copias iguales separadas por una línea para cortar).

import { MESES, gs, loadJsPDF, pdfSafe } from '../iva/ivaCore.js';
import { FORMAS_PAGO, montoEnLetras } from './comprobantesCore.js';

const fechaEnLetras = (iso) => {
  const [a, m, d] = String(iso || '').split('-').map(Number);
  return a && m && d ? `${d} de ${MESES[m - 1]} de ${a}` : '';
};

// emisor = { nombre, ruc, direccion, telefono, ciudad }
export async function descargarReciboPdf(recibo, emisor) {
  const JsPDF = await loadJsPDF();
  const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210;
  const M = 14;
  const alto = 148.5;
  const moneda = recibo.moneda === 'USD' ? 'USD' : 'Gs.';
  const montoTxt = recibo.moneda === 'USD'
    ? Number(recibo.monto || 0).toLocaleString('es-PY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : gs(recibo.monto);

  const copia = (y0, etiqueta) => {
    doc.setDrawColor(200, 208, 216);
    doc.setLineWidth(0.4);
    doc.roundedRect(8, y0 + 5, W - 16, alto - 10, 3, 3);
    let y = y0 + 15;
    // Emisor
    doc.setTextColor(20, 33, 58);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(pdfSafe(doc.splitTextToSize(emisor.nombre || '', 110)[0] || ''), M, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(90, 104, 120);
    const datos = [
      emisor.ruc ? `RUC ${emisor.ruc}` : '',
      emisor.direccion || '',
      emisor.telefono ? `Tel. ${emisor.telefono}` : '',
    ].filter(Boolean);
    datos.forEach((t, i) => doc.text(pdfSafe(doc.splitTextToSize(t, 110)[0]), M, y + 5 + i * 4));

    // Título, número y monto
    doc.setTextColor(20, 33, 58);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('RECIBO DE DINERO', W - M, y, { align: 'right' });
    doc.setFontSize(10);
    doc.text(pdfSafe(`N° ${recibo.numero || '-'}`), W - M, y + 6, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(120, 130, 140);
    doc.text(etiqueta, W - M, y + 10.5, { align: 'right' });
    const bx = W - M - 62;
    doc.setDrawColor(27, 51, 88);
    doc.setLineWidth(0.5);
    doc.roundedRect(bx, y + 13, 62, 11, 2, 2);
    doc.setTextColor(20, 33, 58);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(pdfSafe(`${moneda} ${montoTxt}`), W - M - 3, y + 20.6, { align: 'right' });

    y += 32;
    doc.setDrawColor(214, 222, 228);
    doc.setLineWidth(0.3);
    doc.line(M, y, W - M, y);

    // Cuerpo
    y += 9;
    doc.setFontSize(10.5);
    doc.setTextColor(20, 33, 58);
    const pagador = recibo.nombre + (recibo.ruc ? ` (RUC ${recibo.ruc})` : '');
    const lineas = [
      ['Recibí de: ', pagador],
      ['La suma de: ', montoEnLetras(recibo.monto, recibo.moneda) + '.'],
      ['En concepto de: ', recibo.concepto || '-'],
    ];
    if (recibo.facturas) lineas.push(['Factura(s): ', recibo.facturas]);
    const pago = FORMAS_PAGO[recibo.formaPago] || 'Efectivo';
    lineas.push(['Forma de pago: ', pago + (recibo.detallePago ? ` - ${recibo.detallePago}` : '')]);
    if (recibo.moneda === 'USD' && recibo.cambio) lineas.push(['Tipo de cambio: ', `Gs. ${gs(recibo.cambio)} por USD (Gs. ${gs(Math.round(recibo.monto * recibo.cambio))})`]);

    lineas.forEach(([rot, val]) => {
      doc.setFont('helvetica', 'bold');
      const ancho = doc.getTextWidth(rot);
      doc.text(rot, M, y);
      doc.setFont('helvetica', 'normal');
      const partes = doc.splitTextToSize(pdfSafe(val), W - 2 * M - ancho);
      partes.slice(0, 3).forEach((p, i) => doc.text(p, M + ancho, y + i * 5));
      y += Math.max(1, Math.min(partes.length, 3)) * 5 + 2.5;
    });

    // Lugar y fecha + firma
    const pie = y0 + alto - 25;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(pdfSafe([emisor.ciudad, fechaEnLetras(recibo.fecha)].filter(Boolean).join(', ')), M, pie + 8);
    doc.setDrawColor(90, 104, 120);
    doc.line(W - M - 70, pie + 4, W - M, pie + 4);
    doc.setFontSize(8.5);
    doc.setTextColor(90, 104, 120);
    doc.text('Firma y aclaración', W - M - 35, pie + 8.5, { align: 'center' });
  };

  copia(0, 'ORIGINAL');
  // Línea de corte
  doc.setDrawColor(170, 178, 186);
  doc.setLineWidth(0.2);
  doc.setLineDashPattern([2, 2], 0);
  doc.line(6, alto, W - 6, alto);
  doc.setLineDashPattern([], 0);
  copia(alto, 'DUPLICADO');

  const nombre = `Recibo_${recibo.numero || 's-n'}_${recibo.nombre || ''}`.replace(/[^\w-]+/g, '_').slice(0, 80);
  doc.save(`${nombre}.pdf`);
}
