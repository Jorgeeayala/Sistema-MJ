import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import { useClientsData, useClientsMeta } from '../context/ClientsContext';
import { initialPeriodo } from '../iva/ivaPeriodo';
import { perLabel } from '../iva/ivaCore';
import { INSTRUCCIONES, SUGERENCIAS_INICIALES, contextoSesion } from './conocimiento';
import { HERRAMIENTAS, crearEjecutor } from './herramientas';
import { useIntegraciones } from './integraciones';
import './agente.css';

// Vueltas máximas de "la IA pide datos → la app se los da" por pregunta.
const MAX_VUELTAS = 8;
// Tope de lo que se le devuelve a la IA por herramienta (caracteres).
const MAX_RESULTADO = 30000;

const ETIQUETA_HERRAMIENTA = {
  resumen_periodo: 'el resumen del período',
  buscar_clientes: 'la cartera',
  ver_cliente: 'la ficha del cliente',
  estado_iva: 'el IVA del período',
  liquidacion_iva: 'la liquidación de IVA',
  vencimiento_iva: 'el calendario de vencimientos',
};

function fechaHoyLarga() {
  return new Date().toLocaleDateString('es-PY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Texto con formato mínimo (párrafos, listas y **negrita**) ───────────
// Se arma con elementos de React: nunca se inyecta HTML.
function Negritas({ texto }) {
  const partes = texto.split(/(\*\*[^*]+\*\*)/g);
  return partes.map((p, i) => (
    p.startsWith('**') && p.endsWith('**') && p.length > 4
      ? <strong key={i}>{p.slice(2, -2)}</strong>
      : <Fragment key={i}>{p}</Fragment>
  ));
}

function TextoFormateado({ texto }) {
  const bloques = [];
  let lista = null;
  texto.split('\n').forEach((linea) => {
    const item = linea.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      if (!lista) {
        lista = { tipo: /^\s*\d/.test(linea) ? 'ol' : 'ul', items: [] };
        bloques.push(lista);
      }
      lista.items.push(item[1]);
      return;
    }
    lista = null;
    const limpio = linea.replace(/^#{1,6}\s+/, '').trim();
    if (limpio) bloques.push({ tipo: 'p', texto: limpio });
  });
  return bloques.map((b, i) => {
    if (b.tipo === 'p') return <p key={i}><Negritas texto={b.texto} /></p>;
    const Lista = b.tipo;
    return <Lista key={i}>{b.items.map((t, j) => <li key={j}><Negritas texto={t} /></li>)}</Lista>;
  });
}

// Mensajes que se muestran: lo que escribió la persona y el texto de la IA
// (los pedidos de datos y sus resultados quedan sólo en el historial).
function mensajesVisibles(historial) {
  const out = [];
  historial.forEach((m, i) => {
    if (m.role === 'user' && typeof m.content === 'string') {
      out.push({ id: i, rol: 'user', texto: m.content });
    } else if (m.role === 'assistant') {
      const bloques = Array.isArray(m.content) ? m.content : [];
      // El texto previo a una consulta de datos («dejame revisar…») no se
      // muestra: el indicador «Consultando…» ya cumple esa función.
      if (bloques.some((b) => b.type === 'tool_use')) return;
      const texto = bloques
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (texto) out.push({ id: i, rol: 'assistant', texto });
    }
  });
  return out;
}

export default function AgentePanel({ open, onClose }) {
  const meta = useClientsMeta();
  const { assignedRows } = useClientsData();
  const integraciones = useIntegraciones(open);

  const [historial, setHistorial] = useState([]);
  const [borrador, setBorrador] = useState('');
  const [trabajando, setTrabajando] = useState('');
  const [error, setError] = useState('');
  const listaRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const ocupadoRef = useRef(false);

  // Las herramientas leen siempre los datos más recientes de la planilla.
  const datosRef = useRef(null);
  useEffect(() => {
    datosRef.current = { ...meta, assignedRows };
  }, [meta, assignedRows]);

  const visibles = useMemo(() => mensajesVisibles(historial), [historial]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const t = setTimeout(() => inputRef.current?.focus(), 150);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);

  useEffect(() => {
    const el = listaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibles.length, trabajando, error, open]);

  const enviar = useCallback(async (textoIngresado) => {
    const texto = String(textoIngresado || '').trim();
    if (!texto || ocupadoRef.current) return;
    ocupadoRef.current = true;
    setError('');
    setBorrador('');

    const previo = historial;
    const d = datosRef.current;
    // Un ejecutor por pregunta: comparte la carga del IVA entre herramientas.
    const ejecutar = crearEjecutor(d);
    const system = [
      { type: 'text', text: INSTRUCCIONES },
      {
        type: 'text',
        text: contextoSesion({
          user: d.user,
          userRole: d.userRole,
          year: d.year,
          month: d.month,
          periodoFiscal: (() => { const p = initialPeriodo(d.year, d.month); return p + ' (' + perLabel(p) + ')'; })(),
          fechaHoy: fechaHoyLarga(),
        }),
      },
    ];

    let conv = [...previo, { role: 'user', content: texto }];
    setHistorial(conv);
    setTrabajando('Pensando…');

    try {
      for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
        const resp = await api.agente.mensaje({ system, tools: HERRAMIENTAS, messages: conv });
        const contenido = Array.isArray(resp.content) ? resp.content : [];
        conv = [...conv, { role: 'assistant', content: contenido }];
        setHistorial(conv);

        const usos = contenido.filter((b) => b.type === 'tool_use');
        if (resp.stop_reason !== 'tool_use' || !usos.length) break;

        const etiquetas = [...new Set(usos.map((u) => ETIQUETA_HERRAMIENTA[u.name] || 'los datos'))];
        setTrabajando('Consultando ' + etiquetas.join(' y ') + '…');
        const resultados = await Promise.all(usos.map(async (u) => {
          const r = await ejecutar(u.name, u.input);
          let json = JSON.stringify(r);
          if (json.length > MAX_RESULTADO) json = json.slice(0, MAX_RESULTADO) + '… (recortado: pedí menos resultados o usá filtros)';
          return { type: 'tool_result', tool_use_id: u.id, content: json, ...(r && r.error ? { is_error: true } : {}) };
        }));
        conv = [...conv, { role: 'user', content: resultados }];
        setHistorial(conv);
        setTrabajando('Pensando…');
      }

      // Si se agotaron las vueltas con datos sin responder, se cierra el turno
      // para que la conversación quede válida.
      if (conv[conv.length - 1].role === 'user') {
        conv = [...conv, { role: 'assistant', content: [{ type: 'text', text: 'No llegué a una respuesta completa con los datos consultados. ¿Podés hacer la pregunta más concreta?' }] }];
        setHistorial(conv);
      }
    } catch (err) {
      // La pregunta vuelve al cuadro de texto para poder reintentarla.
      setHistorial(previo);
      setBorrador(texto);
      setError(err.message || 'No se pudo consultar al asistente.');
    } finally {
      ocupadoRef.current = false;
      setTrabajando('');
    }
  }, [historial]);

  const nueva = () => {
    if (ocupadoRef.current) return;
    setHistorial([]);
    setError('');
    setBorrador('');
    inputRef.current?.focus();
  };

  const agente = integraciones.agente || {};
  const noConfigurado = integraciones.cargado && !agente.activo;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="agente-fondo"
            className="rx-buzon-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />
          <motion.aside
            key="agente-panel"
            ref={panelRef}
            className="rx-buzon-panel ag-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Asistente"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
          >
            <div className="rx-buzon-head">
              <h2 className="ag-titulo"><Sparkles size={20} aria-hidden="true" /> Asistente</h2>
              <div className="rx-buzon-head-actions">
                <button type="button" className="rx-buzon-link" onClick={nueva} disabled={!historial.length || Boolean(trabajando)}>
                  <RotateCcw size={14} aria-hidden="true" /> Nueva
                </button>
                <button type="button" className="rx-buzon-close" onClick={onClose} aria-label="Cerrar asistente">
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="ag-lista" ref={listaRef} aria-live="polite">
              {noConfigurado ? (
                <div className="ag-vacio">
                  <p><strong>El asistente todavía no está activado.</strong></p>
                  <p>
                    {meta.userRole === 'SUPERUSUARIO' || meta.userRole === 'ADMINISTRADOR'
                      ? 'Falta cargar la clave de la IA (ANTHROPIC_API_KEY) en las propiedades del Apps Script y publicar una nueva versión. Los pasos están en el README.'
                      : 'Avisale al administrador para que lo configure.'}
                  </p>
                </div>
              ) : visibles.length === 0 && !trabajando ? (
                <div className="ag-vacio">
                  <p>Hola{meta.user ? ', ' + meta.user : ''}. Preguntame sobre tus clientes, el IVA del período o cómo usar el sistema.</p>
                  <div className="ag-sugerencias">
                    {SUGERENCIAS_INICIALES.map((s) => (
                      <button key={s} type="button" className="ag-sugerencia" onClick={() => enviar(s)}>{s}</button>
                    ))}
                  </div>
                </div>
              ) : (
                visibles.map((m) => (
                  <div key={m.id} className={'ag-msg ' + (m.rol === 'user' ? 'is-user' : 'is-bot')}>
                    {m.rol === 'user' ? <p>{m.texto}</p> : <TextoFormateado texto={m.texto} />}
                  </div>
                ))
              )}
              {trabajando && <div className="ag-trabajando"><span className="ag-puntos" aria-hidden="true" />{trabajando}</div>}
              {error && <p className="rx-buzon-error" role="alert">{error}</p>}
            </div>

            <form
              className="ag-form"
              onSubmit={(e) => { e.preventDefault(); enviar(borrador); }}
            >
              <textarea
                ref={inputRef}
                className="ag-input"
                rows={2}
                value={borrador}
                maxLength={2000}
                placeholder={noConfigurado ? 'Asistente sin configurar' : 'Escribí tu pregunta…'}
                disabled={noConfigurado}
                onChange={(e) => setBorrador(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    enviar(borrador);
                  }
                }}
                aria-label="Pregunta para el asistente"
              />
              <button
                type="submit"
                className="ag-enviar"
                disabled={!borrador.trim() || Boolean(trabajando) || noConfigurado}
                aria-label="Enviar pregunta"
              >
                <Send size={18} />
              </button>
            </form>
            <p className="ag-pie">Sólo consulta datos, no modifica nada. Verificá los montos importantes antes de usarlos.</p>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
