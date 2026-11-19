import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload, X } from 'lucide-react';
import { api } from '../api';
import { ClienteSelect } from '../comun/ClienteSelect';
import { MESES, gs } from '../iva/ivaCore.js';
import { calcular, normalizar } from './comprobantesCore.js';
import { leerArchivoMarangatu } from './leerRegistroMarangatu.js';

const perTexto = (p) => {
  const [a, m] = String(p || '').split('-').map(Number);
  return a && m ? `${MESES[m - 1][0].toUpperCase()}${MESES[m - 1].slice(1)} ${a}` : p;
};

// Importa al registro el «Detalle de comprobantes registrados» de Marangatu.
export default function ImportarMarangatu({ clientes, rucInicial, onCerrar, onImportado }) {
  const [estado, setEstado] = useState({ paso: 'elegir', error: '' });
  const [reg, setReg] = useState(null);
  const [archivo, setArchivo] = useState('');
  const [ruc, setRuc] = useState(rucInicial || '');
  const [arrastrando, setArrastrando] = useState(false);

  const leer = async (file) => {
    if (!file) return;
    setEstado({ paso: 'leyendo', error: '' });
    try {
      const r = await leerArchivoMarangatu(file);
      setReg(r);
      setArchivo(file.name);
      const porRuc = clientes.find((c) => c.ruc === r.informante.ruc);
      if (porRuc) setRuc(porRuc.ruc);
      setEstado({ paso: 'revisar', error: '' });
    } catch (e) {
      setReg(null);
      setEstado({ paso: 'elegir', error: e.message || 'No se pudo leer el archivo.' });
    }
  };

  const cliente = clientes.find((c) => c.ruc === ruc) || null;
  const resumen = useMemo(() => {
    if (!reg) return null;
    let ivaApp = 0;
    let ivaArchivo = 0;
    let total = 0;
    reg.comprobantes.forEach((c) => {
      const s = c.tipo === 'nc' ? -1 : 1;
      ivaApp += s * calcular(c).iva;
      ivaArchivo += s * (c._iva || 0);
      total += s * (c._total || calcular(c).total);
    });
    const ivaImputado = reg.comprobantes.filter((c) => c.imputa.iva).length;
    return { ivaApp, ivaArchivo, total, ivaImputado, coincide: Math.abs(ivaApp - ivaArchivo) <= reg.comprobantes.length };
  }, [reg]);

  const importar = async () => {
    if (!reg || !cliente) return;
    setEstado({ paso: 'guardando', error: '' });
    try {
      const lista = reg.comprobantes.map((c) => {
        const { _iva, _total, _tipoOriginal, ...resto } = c; // eslint-disable-line no-unused-vars
        return normalizar(resto);
      });
      const r = await api.comprobantes.importar(cliente.ruc, cliente.nombre, lista);
      onImportado({ ruc: cliente.ruc, periodo: reg.periodos[reg.periodos.length - 1], agregados: r.agregados, repetidos: r.repetidos, invalidos: r.invalidos });
    } catch (e) {
      setEstado({ paso: 'revisar', error: e.code === 'UNKNOWN_ACTION' ? 'El backend todavía no tiene la importación: pegá el AppsScript-Comprobantes.gs nuevo y publicá una nueva versión.' : e.message || 'No se pudo importar.' });
    }
  };

  const ocupado = estado.paso === 'guardando';
  const otroInformante = reg && cliente && reg.informante.ruc && reg.informante.ruc !== cliente.ruc;
  const muestra = reg ? reg.comprobantes.slice(0, 6) : [];

  return (
    <div className="lb-modal-fondo" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !ocupado) onCerrar(); }}>
      <div className="lb-modal" role="dialog" aria-modal="true" aria-labelledby="cp-imp-titulo">
        <div className="lb-modal-head">
          <h2 id="cp-imp-titulo"><Upload size={18} aria-hidden="true" /> Importar de Marangatu</h2>
          <button type="button" className="lb-icono" onClick={onCerrar} aria-label="Cerrar" disabled={ocupado}><X size={18} /></button>
        </div>
        <div className="lb-modal-body">
          {!reg && (
            <>
              <label
                className={`lb-drop ${arrastrando ? 'is-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }}
                onDragLeave={() => setArrastrando(false)}
                onDrop={(e) => { e.preventDefault(); setArrastrando(false); leer(e.dataTransfer.files && e.dataTransfer.files[0]); }}
              >
                <FileSpreadsheet size={34} aria-hidden="true" />
                <strong>{estado.paso === 'leyendo' ? 'Leyendo el archivo…' : 'Elegí o arrastrá el Excel de Marangatu'}</strong>
                <span>«Detalle de comprobantes registrados» (DetalleComprobantesRegistrados….xlsx).</span>
                <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => leer(e.target.files && e.target.files[0])} disabled={estado.paso === 'leyendo'} />
              </label>
              <p className="lb-ayuda">Se cargan todos los comprobantes del archivo (ventas y compras, de todos los meses) con su timbrado, RUC e imputación. Los que ya estén en el registro no se repiten.</p>
            </>
          )}

          {estado.error && <div className="lb-error" role="alert"><AlertTriangle size={16} aria-hidden="true" /> {estado.error}</div>}

          {reg && (
            <>
              <div className="lb-archivo">
                <FileSpreadsheet size={18} aria-hidden="true" />
                <span>
                  <strong>{archivo}</strong>
                  <small>{reg.comprobantes.length} comprobantes · {reg.ventas} de ventas · {reg.compras} de compras · {reg.periodos.map(perTexto).join(', ')} · informante: {reg.informante.nombre || '—'} (RUC {reg.informante.ruc || '—'})</small>
                </span>
                {!ocupado && <button type="button" className="lb-link" onClick={() => { setReg(null); setEstado({ paso: 'elegir', error: '' }); }}>Cambiar archivo</button>}
              </div>

              {resumen && resumen.coincide && (
                <div className="lb-ok"><CheckCircle2 size={16} aria-hidden="true" /> El IVA calculado coincide con el del archivo (Gs. {gs(resumen.ivaArchivo)}). {resumen.ivaImputado} de {reg.comprobantes.length} se imputan a IVA.</div>
              )}
              {resumen && !resumen.coincide && (
                <div className="lb-aviso"><AlertTriangle size={16} aria-hidden="true" /> El IVA calculado (Gs. {gs(resumen.ivaApp)}) no coincide con el del archivo (Gs. {gs(resumen.ivaArchivo)}). Revisá el detalle después de importar.</div>
              )}
              {reg.omitidos.length > 0 && (
                <div className="lb-aviso"><AlertTriangle size={16} aria-hidden="true" /> {reg.omitidos.length} filas no se importan ({reg.omitidos.slice(0, 3).map((o) => `fila ${o.fila}: ${o.motivo}`).join('; ')}{reg.omitidos.length > 3 ? '…' : ''}).</div>
              )}

              <div className="lb-form">
                <div className="lb-campo lb-campo-ancho">
                  <label htmlFor="cp-imp-cliente">Cliente</label>
                  <ClienteSelect id="cp-imp-cliente" clientes={clientes} valor={ruc} onChange={setRuc} />
                  {!cliente && <small className="lb-falta">El RUC {reg.informante.ruc} no está en la lista: elegí el cliente a mano.</small>}
                  {otroInformante && <small className="lb-falta">Ojo: el archivo es de RUC {reg.informante.ruc} ({reg.informante.nombre}).</small>}
                </div>
              </div>

              <div className="lb-tabla-wrap lb-muestra">
                <table className="lb-tabla">
                  <thead>
                    <tr><th>Fecha</th><th>Registro</th><th>Tipo</th><th>Número</th><th>Timbrado</th><th>RUC</th><th>Nombre</th><th className="num">Total</th><th>Imputa</th></tr>
                  </thead>
                  <tbody>
                    {muestra.map((c, i) => (
                      <tr key={i}>
                        <td>{c.fecha.split('-').reverse().join('/')}</td>
                        <td>{c.op === 'compra' ? 'Compra' : 'Venta'}</td>
                        <td>{c._tipoOriginal}</td>
                        <td>{c.numero}</td>
                        <td>{c.timbrado}</td>
                        <td>{c.ruc}</td>
                        <td className="nombre">{c.nombre}</td>
                        <td className="num">{gs(c._total)}</td>
                        <td>{['iva', 'ire', 'irp'].filter((k) => c.imputa[k]).map((k) => k.toUpperCase()).join(' · ') || 'No imputa'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {reg.comprobantes.length > muestra.length && <p className="lb-ayuda">… y {reg.comprobantes.length - muestra.length} más.</p>}
            </>
          )}
        </div>
        <div className="lb-modal-pie">
          <button type="button" className="rx-btn rx-btn-outline" onClick={onCerrar} disabled={ocupado}>Cancelar</button>
          {reg && (
            <button type="button" className="rx-btn rx-btn-primary" onClick={importar} disabled={!cliente || ocupado}>
              {ocupado ? 'Importando…' : `Importar ${reg.comprobantes.length} comprobantes`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
