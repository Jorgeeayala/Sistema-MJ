import { useEffect, useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../api';
import { gs, perLabel } from '../iva/ivaCore.js';
import { aListasIva, totales } from './comprobantesCore.js';
import './comprobantes.css';

// Aviso en la liquidación del IVA: si el cliente tiene comprobantes del mes
// en el registro, permite pasarlos a las casillas del Formulario 120.
export default function TraerDelRegistro({ ruc, periodo, hayMontos, onAplicar }) {
  const [estado, setEstado] = useState({ clave: '', lista: null });
  const [confirmar, setConfirmar] = useState(false);
  const clave = `${ruc}|${periodo}`;

  useEffect(() => {
    let vigente = true;
    api.comprobantes.leer(ruc, periodo)
      .then((r) => { if (vigente) setEstado({ clave, lista: (r && r.comprobantes) || [] }); })
      .catch(() => { if (vigente) setEstado({ clave, lista: [] }); }); // sin módulo en el backend: no se muestra
    return () => { vigente = false; };
  }, [ruc, periodo, clave]);

  const lista = estado.clave === clave ? estado.lista : null;
  const res = useMemo(() => (lista ? aListasIva(lista) : null), [lista]);
  if (!lista || !res || !res.usados.length) return null;
  const t = totales(lista.filter((c) => c.imputa && c.imputa.iva));

  const aplicar = () => {
    setConfirmar(false);
    onAplicar(res.listas, res.usados.length);
  };

  return (
    <div className="cp-traer" role="region" aria-label="Registro de comprobantes">
      <FileText size={18} aria-hidden="true" />
      <div className="cp-traer-txt">
        <strong>{res.usados.length} {res.usados.length === 1 ? 'comprobante imputado' : 'comprobantes imputados'} a IVA en el registro de {perLabel(periodo)}</strong>
        <small>Ventas Gs. {gs(t.venta.total)} · Compras Gs. {gs(t.compra.total)} · IVA del mes {t.saldoIva >= 0 ? 'a pagar' : 'a favor'} Gs. {gs(Math.abs(t.saldoIva))}</small>
      </div>
      {confirmar ? (
        <span className="cp-traer-conf">
          Reemplaza los montos de ventas y compras ya cargados.
          <button type="button" className="iva-btn sm primary" onClick={aplicar}>Sí, reemplazar</button>
          <button type="button" className="iva-btn sm" onClick={() => setConfirmar(false)}>No</button>
        </span>
      ) : (
        <button type="button" className="iva-btn sm primary" onClick={() => (hayMontos ? setConfirmar(true) : aplicar())}>Traer al formulario</button>
      )}
    </div>
  );
}
