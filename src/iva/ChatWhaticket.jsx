import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ImageIcon, RefreshCw, Send } from 'lucide-react';
import { api } from '../api';
import { blobABase64 } from '../agente/integraciones';
import './chat-whaticket.css';

// Chat de UN cliente en Whaticket, dentro de Sistema MJ: muestra la
// conversación (como en Whaticket), permite mandar la ficha IVA pendiente y
// responder. Todo pasa por el Apps Script, que guarda el token.
const REFRESCO_MS = 15000;

function fechaMensaje(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hora = d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' });
  const hoy = new Date();
  if (d.toDateString() === hoy.toDateString()) return hora;
  return d.toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit' }) + ' ' + hora;
}

function ordenar(mensajes) {
  return [...mensajes].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
}

function unir(actuales, nuevos) {
  const porId = new Map(actuales.map((m) => [m.id, m]));
  nuevos.forEach((m) => porId.set(m.id, m));
  return ordenar([...porId.values()]);
}

// Formato de WhatsApp: *negrita* y _cursiva_ (sin inyectar HTML).
function TextoWhatsapp({ texto }) {
  return String(texto).split(/(\*[^*\n]+\*|_[^_\n]+_)/g).map((p, i) => {
    if (p.length > 2 && p.startsWith('*') && p.endsWith('*')) return <strong key={i}>{p.slice(1, -1)}</strong>;
    if (p.length > 2 && p.startsWith('_') && p.endsWith('_')) return <em key={i}>{p.slice(1, -1)}</em>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}

function Tildes({ ack }) {
  if (ack === null || ack === undefined || ack < 1) return null;
  return <span className={'wtc-ack' + (ack >= 3 ? ' is-leido' : '')} aria-label={ack >= 3 ? 'Leído' : ack >= 2 ? 'Entregado' : 'Enviado'}>{ack >= 2 ? '✓✓' : '✓'}</span>;
}

function Mensaje({ m }) {
  const esImagen = /image/i.test(m.tipo) && m.mediaUrl;
  return (
    <div className={'wtc-msg' + (m.deMi ? ' is-mio' : '') + (m.nota ? ' is-nota' : '')}>
      {m.nota && <div className="wtc-msg-etiqueta">Nota interna</div>}
      {esImagen && (
        <a href={m.mediaUrl} target="_blank" rel="noopener noreferrer" className="wtc-msg-img">
          <img src={m.mediaUrl} alt="Imagen del chat" loading="lazy" />
        </a>
      )}
      {!esImagen && m.mediaUrl && (
        <a href={m.mediaUrl} target="_blank" rel="noopener noreferrer" className="wtc-msg-archivo">
          Abrir archivo{m.tipo ? ' (' + m.tipo + ')' : ''}
        </a>
      )}
      {m.texto && <div className="wtc-msg-texto"><TextoWhatsapp texto={m.texto} /></div>}
      <div className="wtc-msg-pie">{fechaMensaje(m.fecha)} {m.deMi && <Tildes ack={m.ack} />}</div>
    </div>
  );
}

/**
 * props:
 *  - cliente: { nombre, ruc }   periodo: 'AAAA-MM'   numero: '595981…'
 *  - ficha (opcional): { crearImagen: () => Promise<Blob>, texto, nombreArchivo }
 *  - onFichaEnviada(): se llama una vez enviada la ficha (marca "Enviado").
 *  - onClose()
 */
export default function ChatWhaticket({ cliente, periodo, numero, ficha, onFichaEnviada, onClose }) {
  const [ticket, setTicket] = useState(null);
  const [mensajes, setMensajes] = useState([]);
  const [masAntes, setMasAntes] = useState(null); // { cursor, cursorId } | null
  const [cargando, setCargando] = useState(true);
  const [errorChat, setErrorChat] = useState('');

  // Ficha pendiente de enviar
  const [fichaPendiente, setFichaPendiente] = useState(Boolean(ficha));
  const [imagen, setImagen] = useState(null);
  const [textoFicha, setTextoFicha] = useState(ficha ? ficha.texto : '');
  const [estadoFicha, setEstadoFicha] = useState(ficha ? 'preparando' : ''); // preparando | listo | enviando | error
  const [errorFicha, setErrorFicha] = useState('');
  const [duplicado, setDuplicado] = useState(false);

  // Respuesta escrita
  const [respuesta, setRespuesta] = useState('');
  const [respondiendo, setRespondiendo] = useState(false);
  const [errorRespuesta, setErrorRespuesta] = useState('');

  const listaRef = useRef(null);
  const pegadoAbajoRef = useRef(true);
  const fichaRef = useRef(ficha);

  // `inicial`: la primera carga ya arranca con cargando=true.
  const cargar = useCallback(async ({ silencioso = false, inicial = false } = {}) => {
    if (!silencioso && !inicial) setCargando(true);
    try {
      const data = await api.whaticket.chat({ numero });
      setTicket(data.ticket);
      setMensajes((prev) => (silencioso ? unir(prev, data.mensajes || []) : ordenar(data.mensajes || [])));
      if (!silencioso) setMasAntes(data.hayMasAntes ? data.cursor : null);
      setErrorChat('');
    } catch (err) {
      if (!silencioso) setErrorChat(err.message || 'No se pudo cargar el chat.');
    } finally {
      if (!silencioso) setCargando(false);
    }
  }, [numero]);

  useEffect(() => {
    const primera = setTimeout(() => cargar({ inicial: true }), 0);
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') cargar({ silencioso: true });
    }, REFRESCO_MS);
    return () => {
      clearTimeout(primera);
      clearInterval(t);
    };
  }, [cargar]);

  // La imagen de la ficha se arma una sola vez al abrir.
  useEffect(() => {
    if (!fichaRef.current) return undefined;
    let vivo = true;
    let url = '';
    fichaRef.current.crearImagen()
      .then((blob) => {
        if (!vivo) return;
        url = URL.createObjectURL(blob);
        setImagen({ blob, url });
        setEstadoFicha('listo');
      })
      .catch(() => {
        if (!vivo) return;
        setErrorFicha('No se pudo generar la imagen de la ficha.');
        setEstadoFicha('error');
      });
    return () => {
      vivo = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && estadoFicha !== 'enviando' && !respondiendo) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, estadoFicha, respondiendo]);

  // Baja al último mensaje salvo que la persona esté leyendo más arriba.
  useEffect(() => {
    const el = listaRef.current;
    if (el && pegadoAbajoRef.current) el.scrollTop = el.scrollHeight;
  }, [mensajes, fichaPendiente, imagen]);

  const onScroll = () => {
    const el = listaRef.current;
    if (el) pegadoAbajoRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const cargarAnteriores = async () => {
    if (!masAntes) return;
    const el = listaRef.current;
    const alturaAntes = el ? el.scrollHeight : 0;
    try {
      const data = await api.whaticket.chat({ numero, cursor: masAntes.cursor, cursorId: masAntes.cursorId });
      pegadoAbajoRef.current = false;
      setMensajes((prev) => unir(prev, data.mensajes || []));
      setMasAntes(data.hayMasAntes ? data.cursor : null);
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - alturaAntes; });
    } catch (err) {
      setErrorChat(err.message || 'No se pudieron cargar los mensajes anteriores.');
    }
  };

  const enviarFicha = async () => {
    if (!imagen || estadoFicha === 'enviando') return;
    setEstadoFicha('enviando');
    setErrorFicha('');
    try {
      await api.whaticket.enviar({
        destino: 'cliente',
        numero,
        texto: textoFicha.trim(),
        imagen: await blobABase64(imagen.blob),
        nombreArchivo: fichaRef.current.nombreArchivo,
        cliente: cliente.nombre,
        ruc: cliente.ruc,
        periodo,
        forzar: duplicado,
      });
      setFichaPendiente(false);
      setEstadoFicha('');
      pegadoAbajoRef.current = true;
      onFichaEnviada?.();
      // Whaticket tarda unos segundos en mostrar el mensaje en el chat.
      setTimeout(() => cargar({ silencioso: true }), 2500);
      setTimeout(() => cargar({ silencioso: true }), 8000);
    } catch (err) {
      if (err.code === 'WHATICKET_DUPLICADO') {
        setDuplicado(true);
        setErrorFicha(err.message + ' Si igual querés reenviarla, tocá «Reenviar igual».');
      } else if (err.name === 'TransportError') {
        setErrorFicha('No se pudo confirmar el envío (sin respuesta del servidor). Mirá si la ficha aparece en el chat antes de reintentar.');
      } else {
        setErrorFicha(err.message || 'No se pudo enviar la ficha.');
      }
      setEstadoFicha('error');
    }
  };

  const responder = async (e) => {
    e?.preventDefault();
    const texto = respuesta.trim();
    if (!texto || respondiendo) return;
    setRespondiendo(true);
    setErrorRespuesta('');
    try {
      await api.whaticket.responder({ numero, texto, cliente: cliente.nombre, ruc: cliente.ruc });
      setRespuesta('');
      pegadoAbajoRef.current = true;
      setTimeout(() => cargar({ silencioso: true }), 1500);
    } catch (err) {
      setErrorRespuesta(err.name === 'TransportError'
        ? 'No se pudo confirmar el envío. Mirá si el mensaje aparece en el chat antes de reintentar.'
        : (err.message || 'No se pudo enviar el mensaje.'));
    } finally {
      setRespondiendo(false);
    }
  };

  const ventanaAbierta = Boolean(ticket && ticket.ventanaAbierta);
  const nombre = (ticket && ticket.nombre) || cliente.nombre;
  const inicial = String(nombre || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="wtc-overlay" role="dialog" aria-modal="true" aria-label={'Chat de WhatsApp con ' + nombre}>
      <div className="wtc-panel">
        <header className="wtc-head">
          <button type="button" className="wtc-iconbtn" onClick={onClose} aria-label="Cerrar el chat" disabled={estadoFicha === 'enviando'}>
            <ArrowLeft size={20} />
          </button>
          {ticket && ticket.foto
            ? <img className="wtc-avatar" src={ticket.foto} alt="" />
            : <span className="wtc-avatar" aria-hidden="true">{inicial}</span>}
          <div className="wtc-head-txt">
            <div className="wtc-nombre">{nombre}</div>
            <div className="wtc-sub">
              +{numero}
              {ticket && (ventanaAbierta ? ' · chat activo' : ' · sin mensajes del cliente en 7 días')}
            </div>
          </div>
          <button type="button" className="wtc-iconbtn" onClick={() => cargar()} aria-label="Actualizar el chat" title="Actualizar">
            <RefreshCw size={18} />
          </button>
        </header>

        <div className="wtc-lista" ref={listaRef} onScroll={onScroll} aria-live="polite">
          {masAntes && (
            <button type="button" className="wtc-anteriores" onClick={cargarAnteriores}>Cargar mensajes anteriores</button>
          )}
          {cargando && !mensajes.length && <p className="wtc-aviso">Cargando el chat…</p>}
          {errorChat && <p className="wtc-aviso is-error" role="alert">{errorChat}</p>}
          {!cargando && !errorChat && !ticket && (
            <p className="wtc-aviso">
              Todavía no hay chat con este cliente en Whaticket.
              {fichaPendiente ? ' Al enviar la ficha se crea.' : ''}
            </p>
          )}
          {mensajes.map((m) => <Mensaje key={m.id} m={m} />)}

          {fichaPendiente && (
            <div className="wtc-ficha">
              <div className="wtc-ficha-titulo"><ImageIcon size={16} aria-hidden="true" /> Ficha IVA para enviar</div>
              <div className="wtc-ficha-img">
                {imagen
                  ? <img src={imagen.url} alt={'Ficha IVA de ' + cliente.nombre} />
                  : <span>{estadoFicha === 'preparando' ? 'Preparando la imagen…' : ''}</span>}
              </div>
              <label className="wtc-ficha-label" htmlFor="wtc-ficha-texto">Mensaje (va como pie de la imagen)</label>
              <textarea
                id="wtc-ficha-texto"
                className="wtc-textarea"
                rows={3}
                maxLength={4000}
                value={textoFicha}
                onChange={(e) => setTextoFicha(e.target.value)}
                disabled={estadoFicha === 'enviando'}
              />
              <p className="wtc-ficha-nota">
                {!ticket || !ventanaAbierta
                  ? 'El cliente no escribió en los últimos 7 días: Whaticket la envía como mensaje nuevo (puede consumir créditos del plan).'
                  : 'Se envía en este chat.'}
              </p>
              {errorFicha && <p className="wtc-aviso is-error" role="alert">{errorFicha}</p>}
              <div className="wtc-ficha-acciones">
                <button type="button" className="wtc-btn" onClick={() => setFichaPendiente(false)} disabled={estadoFicha === 'enviando'}>
                  No enviar
                </button>
                <button
                  type="button"
                  className="wtc-btn is-primario"
                  onClick={enviarFicha}
                  disabled={!imagen || estadoFicha === 'enviando' || estadoFicha === 'preparando'}
                >
                  <Send size={16} aria-hidden="true" /> {estadoFicha === 'enviando' ? 'Enviando…' : duplicado ? 'Reenviar igual' : 'Enviar ficha'}
                </button>
              </div>
            </div>
          )}
        </div>

        <form className="wtc-form" onSubmit={responder}>
          {errorRespuesta && <p className="wtc-aviso is-error" role="alert">{errorRespuesta}</p>}
          {ticket && !ventanaAbierta && (
            <p className="wtc-ficha-nota">Pasaron más de 7 días desde el último mensaje del cliente: Whaticket no deja responder en este chat.</p>
          )}
          <div className="wtc-form-fila">
            <textarea
              className="wtc-textarea"
              rows={1}
              maxLength={4000}
              value={respuesta}
              onChange={(e) => setRespuesta(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); responder(); } }}
              placeholder={ventanaAbierta ? 'Escribí un mensaje…' : 'No se puede responder en este chat'}
              disabled={!ventanaAbierta || respondiendo}
              aria-label="Mensaje para el cliente"
            />
            <button type="submit" className="wtc-enviar" disabled={!ventanaAbierta || respondiendo || !respuesta.trim()} aria-label="Enviar mensaje">
              <Send size={18} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
