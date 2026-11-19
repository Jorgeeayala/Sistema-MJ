import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { sinAcentos } from './clientes';
import '../libros/libros.css';

// Selector de cliente con búsqueda (Libros IVA, Comprobantes). Usa los
// estilos lb-cliente* de libros.css.

export function ClienteSelect({ clientes, valor, onChange, id, detalle, placeholder = 'Buscar cliente por nombre o RUC…' }) {
  const [texto, setTexto] = useState('');
  const [abierto, setAbierto] = useState(false);
  const caja = useRef(null);
  const elegido = clientes.find((c) => c.ruc === valor) || null;
  const q = sinAcentos(texto.trim());
  const lista = useMemo(
    () => clientes.filter((c) => !q || sinAcentos(c.nombre).includes(q) || c.ruc.includes(q.replace(/\D/g, '') || '¬')).slice(0, 60),
    [clientes, q]
  );
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (caja.current && !caja.current.contains(e.target)) setAbierto(false); };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [abierto]);
  return (
    <div className="lb-cliente" ref={caja}>
      <div className="lb-cliente-input">
        <Search size={15} aria-hidden="true" />
        <input
          id={id}
          value={abierto ? texto : elegido ? `${elegido.nombre} · ${elegido.ruc}` : texto}
          placeholder={placeholder}
          onFocus={() => { setAbierto(true); setTexto(''); }}
          onChange={(e) => { setTexto(e.target.value); setAbierto(true); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && lista[0]) { onChange(lista[0].ruc); setAbierto(false); e.currentTarget.blur(); }
            if (e.key === 'Escape') { setAbierto(false); e.currentTarget.blur(); }
          }}
          role="combobox"
          aria-expanded={abierto}
          aria-autocomplete="list"
          autoComplete="off"
        />
        {elegido && !abierto && (
          <button type="button" className="lb-cliente-quitar" onClick={() => onChange('')} aria-label="Quitar cliente">
            <X size={14} />
          </button>
        )}
      </div>
      {abierto && (
        <ul className="lb-cliente-lista" role="listbox">
          {lista.length === 0 && <li className="lb-vacio-li">Sin coincidencias</li>}
          {lista.map((c) => (
            <li key={c.ruc}>
              <button
                type="button"
                role="option"
                aria-selected={c.ruc === valor}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChange(c.ruc); setAbierto(false); setTexto(''); }}
              >
                <strong>{c.nombre}</strong>
                <small>RUC {c.ruc}{detalle ? detalle(c) : ''}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

