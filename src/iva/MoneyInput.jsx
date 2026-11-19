import { useLayoutEffect, useRef, useState } from 'react';
import { gs, toNum } from './ivaCore.js';

// Monto en guaraníes con separador de miles mientras se escribe. El cursor
// se conserva contando desde el final, como en la versión anterior.
// Con `decimales` (montos en dólares) acepta coma decimal: «1.234,56».
export default function MoneyInput({ value, onValue, className = '', decimales = false, ...rest }) {
  const ref = useRef(null);
  const fromEnd = useRef(null);
  const [texto, setTexto] = useState(null); // sólo con decimales, mientras se edita
  useLayoutEffect(() => {
    const el = ref.current;
    if (fromEnd.current === null || !el || el !== document.activeElement) return;
    const pos = Math.max(0, el.value.length - fromEnd.current);
    el.setSelectionRange(pos, pos);
    fromEnd.current = null;
  });
  if (decimales) {
    const mostrar = (n) => (n ? Number(n).toLocaleString('es-PY', { maximumFractionDigits: 2 }) : '');
    return (
      <input
        ref={ref}
        className={className}
        inputMode="decimal"
        placeholder="0"
        value={texto !== null ? texto : mostrar(value)}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.,]/g, '');
          setTexto(t);
          const n = Number(t.replace(/\./g, '').replace(',', '.'));
          onValue(Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
        }}
        onFocus={(e) => e.target.select()}
        onBlur={() => setTexto(null)}
        {...rest}
      />
    );
  }
  return (
    <input
      ref={ref}
      className={className}
      inputMode="numeric"
      placeholder="0"
      value={value ? gs(value) : ''}
      onChange={(e) => {
        fromEnd.current = e.target.value.length - (e.target.selectionStart ?? e.target.value.length);
        onValue(toNum(e.target.value));
      }}
      onFocus={(e) => e.target.select()}
      {...rest}
    />
  );
}
