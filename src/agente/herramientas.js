// Herramientas del asistente. Corren en la app (no en el servidor) con los
// mismos datos que ya ve el usuario logueado: la planilla del período abierto
// y el módulo de IVA. Son de SÓLO LECTURA: ninguna escribe en la planilla.
//
// Cada herramienta devuelve un objeto chico y ya resumido; así la consulta a
// la IA gasta pocos tokens (y cuesta poco).
import { api } from '../api';
import {
  compactHeader,
  findClaveMarangatuColumn,
  formatSheetValue,
  getClientSearchScore,
  isAffirmativeValue,
} from '../utils';
import {
  ESTADOS,
  calc,
  diasRetraso,
  fechaCorta,
  fichaModel,
  gs,
  lastDigit,
  normalizeConfig,
  perLabel,
  rucTexto,
  shiftPer,
  splitRuc,
  vencAuto,
  vencDe,
  waMensaje,
  waTelefono,
} from '../iva/ivaCore';
import { findDvColumn, findWhatsappColumn, initialPeriodo } from '../iva/ivaPeriodo';

const LIMITE_DEFAULT = 25;
const LIMITE_MAX = 60;
const PERIODO_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Columnas que NUNCA se le pasan a la IA: claves de Marangatu y similares.
const SENSIBLE_RE = /clave|contrasen|password|passwd|pass$|^pin$|token|secreto/;

function columnasSensibles(headers) {
  const set = new Set();
  const clave = findClaveMarangatuColumn(headers);
  if (clave) set.add(clave);
  (headers || []).forEach((h) => { if (SENSIBLE_RE.test(compactHeader(h))) set.add(h); });
  return set;
}

function texto(v) {
  return String(v ?? '').trim();
}

function limite(n) {
  const x = Number(n) || LIMITE_DEFAULT;
  return Math.max(1, Math.min(LIMITE_MAX, x));
}

function mismaPersona(a, b) {
  return texto(a).toLowerCase() === texto(b).toLowerCase();
}

function isArchived(row, archivadoCol, archivadoPorCol) {
  if (archivadoCol && archivadoCol === archivadoPorCol) {
    const t = texto(row[archivadoCol]);
    return Boolean(t) && !/^no?$/i.test(t);
  }
  if (archivadoCol) return isAffirmativeValue(row[archivadoCol]);
  return Boolean(archivadoPorCol && texto(row[archivadoPorCol]));
}

// ── Definiciones (lo que ve la IA) ──────────────────────────────────────
export const HERRAMIENTAS = [
  {
    name: 'resumen_periodo',
    description:
      'Resumen de la cartera del período abierto (hoja mensual): total de clientes, presentados, pendientes, archivados, ' +
      'sin encargado, carga y avance por encargado, y pendientes por día de vencimiento. Usala para preguntas generales ' +
      '("¿cómo venimos?", "¿quién tiene más pendientes?").',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'buscar_clientes',
    description:
      'Lista clientes del período abierto con filtros combinables. Devuelve nombre, RUC, encargado, día de vencimiento, ' +
      'presentado y archivado. Si no se pasa ningún filtro devuelve los primeros de la lista.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Parte del nombre, del RUC o de cualquier dato del cliente.' },
        encargado: { type: 'string', description: 'Nombre del encargado. "yo" para el usuario actual.' },
        sin_encargado: { type: 'boolean', description: 'true para sólo los clientes sin encargado asignado.' },
        estado: { type: 'string', enum: ['pendiente', 'presentado', 'archivado', 'sin_archivar'] },
        dia_vencimiento: { type: 'string', description: 'Día de vencimiento de la planilla, por ejemplo "7" o "15".' },
        limite: { type: 'integer', description: 'Cantidad máxima de clientes a devolver (por defecto 25, máximo 60).' },
      },
    },
  },
  {
    name: 'ver_cliente',
    description:
      'Ficha completa de UN cliente del período abierto (todas sus columnas de la planilla, salvo claves). ' +
      'Buscalo por nombre o RUC. Si hay varios parecidos devuelve las opciones para que el usuario elija.',
    input_schema: {
      type: 'object',
      properties: { cliente: { type: 'string', description: 'Nombre o RUC del cliente.' } },
      required: ['cliente'],
    },
  },
  {
    name: 'estado_iva',
    description:
      'Estado de las liquidaciones de IVA de un período fiscal: cuántos clientes están sin cargar, pendientes, enviados ' +
      'y presentados, total a pagar, y la lista filtrada con resultado (a pagar / a favor), monto, fecha de vencimiento y ' +
      'días de retraso. Por defecto usa el período fiscal de la hoja abierta.',
    input_schema: {
      type: 'object',
      properties: {
        periodo: { type: 'string', description: 'Período fiscal AAAA-MM (ej. "2026-10"). Opcional.' },
        estado: { type: 'string', enum: ['sin_cargar', 'pendiente', 'enviado', 'presentado', 'no_presentado'] },
        encargado: { type: 'string', description: 'Nombre del encargado. "yo" para el usuario actual.' },
        digito: { type: 'integer', description: 'Último dígito del RUC (VENC. 0 a 9).' },
        solo_vencidos: { type: 'boolean', description: 'true para sólo los que ya vencieron y no están presentados.' },
        texto: { type: 'string', description: 'Parte del nombre o del RUC.' },
        limite: { type: 'integer', description: 'Máximo de filas (por defecto 25, máximo 60).' },
      },
    },
  },
  {
    name: 'liquidacion_iva',
    description:
      'Detalle de la liquidación de IVA de UN cliente en un período: ventas, compras, IVA débito y crédito, resultado, ' +
      'mora si se paga tarde, fecha de vencimiento, estado, WhatsApp registrado y el mensaje que acompaña la ficha.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: 'Nombre o RUC del cliente.' },
        periodo: { type: 'string', description: 'Período fiscal AAAA-MM. Opcional.' },
      },
      required: ['cliente'],
    },
  },
  {
    name: 'vencimiento_iva',
    description:
      'Fecha de vencimiento del IVA según el último dígito del RUC para un período (calendario de la DNIT, con los ' +
      'feriados cargados en la configuración). Sirve aunque el RUC no sea de un cliente de la cartera.',
    input_schema: {
      type: 'object',
      properties: {
        ruc: { type: 'string', description: 'RUC (con o sin DV) o sólo el último dígito.' },
        periodo: { type: 'string', description: 'Período fiscal AAAA-MM. Opcional.' },
      },
      required: ['ruc'],
    },
  },
];

// ── Ejecutor ────────────────────────────────────────────────────────────
// `ctx` sale de ClientsContext: { user, year, month, headers, assignedRows,
// nameKey, rucKey, encargadoCol, vencimientoKey, archivadoCol,
// archivadoPorCol, isRowPresentado, getVencimientoDay }.
export function crearEjecutor(ctx) {
  const sensibles = columnasSensibles(ctx.headers);
  const periodoBase = initialPeriodo(ctx.year, ctx.month);
  const ivaCache = new Map(); // periodo → promesa de { liq, clientes, config }

  const encargadoBuscado = (valor) => (/^(yo|mio|mios|mis)$/i.test(texto(valor)) ? ctx.user : texto(valor));

  // Copia de la fila sin columnas sensibles ni internas.
  const filaSegura = (row) => {
    const out = {};
    Object.keys(row).forEach((k) => {
      if (k.startsWith('_') || sensibles.has(k)) return;
      out[k] = row[k];
    });
    return out;
  };

  const filas = () => (ctx.assignedRows || []).map((row) => {
    const segura = filaSegura(row);
    return {
      row,
      segura,
      nombre: texto(ctx.nameKey && row[ctx.nameKey]) || 'Sin nombre',
      ruc: texto(ctx.rucKey && row[ctx.rucKey]),
      encargado: ctx.encargadoCol ? texto(row[ctx.encargadoCol]) : '',
      vence: ctx.getVencimientoDay(row),
      presentado: ctx.isRowPresentado(row),
      archivado: isArchived(row, ctx.archivadoCol, ctx.archivadoPorCol),
    };
  });

  const resumenFila = (f) => ({
    cliente: f.nombre,
    ruc: f.ruc,
    encargado: f.encargado || '(sin asignar)',
    vence_dia: f.vence,
    presentado: f.presentado,
    archivado: f.archivado,
  });

  const buscarUno = (consulta) => {
    const q = texto(consulta);
    const lista = filas()
      .map((f) => ({ f, score: getClientSearchScore(f.segura, q, ctx.nameKey, ctx.rucKey) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score);
    if (!lista.length) return { error: 'No encontré ningún cliente que coincida con "' + q + '" en la hoja ' + ctx.month + '.' };
    const top = lista[0].score;
    const empatados = lista.filter((x) => x.score === top);
    // Empate sin coincidencia exacta del nombre ("Ferretería" con dos
    // ferreterías): se pregunta en vez de elegir una al azar.
    if (top < 1000 && empatados.length > 1) {
      return { varios: empatados.slice(0, 10).map((x) => ({ cliente: x.f.nombre, ruc: x.f.ruc })) };
    }
    return { fila: lista[0].f };
  };

  // ── IVA ──
  const clienteIva = (f, extras) => {
    const dvKey = findDvColumn(ctx.headers || []);
    const waKey = findWhatsappColumn(ctx.headers || []);
    const { ruc, dv } = ctx.rucKey ? splitRuc(f.row[ctx.rucKey], dvKey ? f.row[dvKey] : '') : { ruc: '', dv: '' };
    const extra = (ruc && extras[ruc]) || {};
    return {
      ruc,
      dv,
      nombre: f.nombre,
      wa: extra.wa || (waKey ? texto(f.row[waKey]) : ''),
      notas: extra.notas || '',
      encargado: f.encargado,
    };
  };

  const cargarIva = (periodo) => {
    if (!ivaCache.has(periodo)) {
      const p = api.iva.load([periodo, shiftPer(periodo, -1)]).then((data) => ({
        liq: (data.liq && data.liq[periodo]) || {},
        clientes: data.clientes || {},
        config: normalizeConfig(data.config),
      }));
      p.catch(() => ivaCache.delete(periodo));
      ivaCache.set(periodo, p);
    }
    return ivaCache.get(periodo);
  };

  const periodoValido = (p) => {
    const t = texto(p);
    if (!t) return periodoBase;
    if (!PERIODO_RE.test(t)) throw new Error('Período inválido "' + t + '": usá el formato AAAA-MM.');
    return t;
  };

  const herramientas = {
    resumen_periodo() {
      const lista = filas();
      const porEncargado = {};
      const pendientesPorDia = {};
      lista.forEach((f) => {
        const e = f.encargado || '(sin asignar)';
        porEncargado[e] = porEncargado[e] || { clientes: 0, presentados: 0, pendientes: 0 };
        porEncargado[e].clientes++;
        if (f.presentado) porEncargado[e].presentados++;
        else {
          porEncargado[e].pendientes++;
          pendientesPorDia[f.vence] = (pendientesPorDia[f.vence] || 0) + 1;
        }
      });
      const presentados = lista.filter((f) => f.presentado).length;
      return {
        hoja: ctx.month + ' ' + ctx.year,
        total_clientes: lista.length,
        presentados,
        pendientes: lista.length - presentados,
        archivados: lista.filter((f) => f.archivado).length,
        sin_encargado: lista.filter((f) => !f.encargado).length,
        avance_pct: lista.length ? Math.round((presentados / lista.length) * 100) : 0,
        por_encargado: porEncargado,
        pendientes_por_dia_vencimiento: pendientesPorDia,
      };
    },

    buscar_clientes(input = {}) {
      let lista = filas();
      if (texto(input.texto)) {
        lista = lista
          .map((f) => ({ f, score: getClientSearchScore(f.segura, input.texto, ctx.nameKey, ctx.rucKey) }))
          .filter((x) => x.score >= 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.f);
      }
      if (input.sin_encargado) lista = lista.filter((f) => !f.encargado);
      else if (texto(input.encargado)) {
        const quien = encargadoBuscado(input.encargado);
        lista = lista.filter((f) => mismaPersona(f.encargado, quien));
      }
      if (input.estado === 'pendiente') lista = lista.filter((f) => !f.presentado);
      if (input.estado === 'presentado') lista = lista.filter((f) => f.presentado);
      if (input.estado === 'archivado') lista = lista.filter((f) => f.archivado);
      if (input.estado === 'sin_archivar') lista = lista.filter((f) => !f.archivado);
      if (texto(input.dia_vencimiento)) {
        const dia = String(parseInt(input.dia_vencimiento, 10) || texto(input.dia_vencimiento));
        lista = lista.filter((f) => f.vence === dia);
      }
      const max = limite(input.limite);
      return {
        hoja: ctx.month + ' ' + ctx.year,
        encontrados: lista.length,
        mostrados: Math.min(max, lista.length),
        clientes: lista.slice(0, max).map(resumenFila),
      };
    },

    ver_cliente(input = {}) {
      const r = buscarUno(input.cliente);
      if (r.error || r.varios) return r.varios ? { aviso: 'Hay varios clientes parecidos; preguntale al usuario cuál.', opciones: r.varios } : r;
      const f = r.fila;
      const datos = {};
      Object.entries(f.segura).forEach(([k, v]) => {
        const t = texto(formatSheetValue(v));
        if (t) datos[k] = t;
      });
      return { ...resumenFila(f), columnas: datos };
    },

    async estado_iva(input = {}) {
      const periodo = periodoValido(input.periodo);
      const { liq, clientes, config } = await cargarIva(periodo);
      const hoy = new Date();
      let lista = filas().map((f) => {
        const c = clienteIva(f, clientes);
        const l = c.ruc ? liq[c.ruc] : undefined;
        const v = c.ruc ? vencDe(config, c, l, periodo) : null;
        const k = l ? calc(l, { config, cliente: c, periodo }) : null;
        const estado = l ? (l.estado || 'pend') : 'none';
        return { f, c, l, v, k, estado };
      });

      const totales = { sin_cargar: 0, pendiente: 0, enviado: 0, presentado: 0 };
      const nombreEstado = { none: 'sin_cargar', pend: 'pendiente', env: 'enviado', pres: 'presentado' };
      let totalAPagar = 0;
      lista.forEach((x) => {
        totales[nombreEstado[x.estado]]++;
        if (x.k && x.k.pagar > 0) totalAPagar += x.k.pagar;
      });

      if (input.estado === 'no_presentado') lista = lista.filter((x) => x.estado !== 'pres');
      else if (input.estado) lista = lista.filter((x) => nombreEstado[x.estado] === input.estado);
      if (texto(input.encargado)) {
        const quien = encargadoBuscado(input.encargado);
        lista = lista.filter((x) => mismaPersona(x.f.encargado, quien));
      }
      if (input.digito !== undefined && input.digito !== null && input.digito !== '') {
        lista = lista.filter((x) => lastDigit(x.c.ruc) === Number(input.digito));
      }
      if (input.solo_vencidos) lista = lista.filter((x) => x.estado !== 'pres' && x.v && diasRetraso(x.v.fecha, hoy) > 0);
      if (texto(input.texto)) {
        const q = texto(input.texto).toLowerCase();
        lista = lista.filter((x) => x.c.nombre.toLowerCase().includes(q) || String(x.c.ruc).includes(q));
      }
      lista.sort((a, b) => (a.v ? a.v.fecha.getTime() : Infinity) - (b.v ? b.v.fecha.getTime() : Infinity) ||
        a.c.nombre.localeCompare(b.c.nombre));

      const max = limite(input.limite);
      return {
        periodo_fiscal: periodo + ' (' + perLabel(periodo) + ')',
        totales_del_periodo: totales,
        total_a_pagar_gs: totalAPagar,
        encontrados: lista.length,
        mostrados: Math.min(max, lista.length),
        clientes: lista.slice(0, max).map((x) => ({
          cliente: x.c.nombre,
          ruc: rucTexto(x.c) || '(sin RUC)',
          encargado: x.f.encargado || '(sin asignar)',
          estado: x.estado === 'none' ? 'Sin cargar' : ESTADOS[x.estado],
          resultado: !x.k ? '' : x.k.pagar > 0 ? 'A pagar' : x.k.favor > 0 ? 'A favor' : 'Sin saldo',
          monto_gs: !x.k ? null : x.k.pagar > 0 ? x.k.pagar : x.k.favor,
          vence: x.v ? fechaCorta(x.v.fecha) : '',
          dias_retraso: x.estado !== 'pres' && x.v ? diasRetraso(x.v.fecha, hoy) : 0,
        })),
      };
    },

    async liquidacion_iva(input = {}) {
      const periodo = periodoValido(input.periodo);
      const r = buscarUno(input.cliente);
      if (r.error || r.varios) return r.varios ? { aviso: 'Hay varios clientes parecidos; preguntale al usuario cuál.', opciones: r.varios } : r;
      const { liq, clientes, config } = await cargarIva(periodo);
      const c = clienteIva(r.fila, clientes);
      if (!c.ruc) return { error: 'El cliente ' + c.nombre + ' no tiene RUC en la planilla: no se puede liquidar.' };
      const l = liq[c.ruc];
      const v = vencDe(config, c, l, periodo);
      const base = {
        cliente: c.nombre,
        ruc: rucTexto(c),
        periodo_fiscal: periodo + ' (' + perLabel(periodo) + ')',
        venc_digito: lastDigit(c.ruc),
        vence: v ? fechaCorta(v.fecha) : '',
        whatsapp_registrado: c.wa ? '+' + waTelefono(c) : '(no tiene)',
      };
      if (!l) return { ...base, estado: 'Sin cargar', aviso: 'Todavía no se cargó la liquidación de este período.' };
      const fctx = { config, cliente: c, periodo };
      const m = fichaModel(fctx, l);
      const k = calc(l, fctx);
      return {
        ...base,
        estado: ESTADOS[l.estado || 'pend'],
        carga_manual: Boolean(l.manual),
        secciones: m.secs.map((s) => ({ titulo: s.t, lineas: s.lines.map(([a, b]) => a + ': Gs. ' + gs(b)) })),
        resultado: m.resLabel + ': Gs. ' + gs(m.resVal),
        iva_debito: k.deb,
        iva_credito: k.cred,
        fecha_pago_prevista: l.pago || '',
        dias_mora: k.dias,
        multa: k.multa,
        intereses: k.interes,
        nota_interna: l.nota || '',
        mensaje_whatsapp: waMensaje(fctx, l),
      };
    },

    async vencimiento_iva(input = {}) {
      const periodo = periodoValido(input.periodo);
      // Sin el DV: "80012345-6" vence por el 5, no por el 6.
      const digito = lastDigit(splitRuc(texto(input.ruc)).ruc);
      if (digito === null) return { error: 'No reconozco un RUC en "' + texto(input.ruc) + '".' };
      const { config } = await cargarIva(periodo);
      const v = vencAuto(config, digito, periodo);
      return {
        periodo_fiscal: periodo + ' (' + perLabel(periodo) + ')',
        venc_digito: digito,
        vence: fechaCorta(v.fecha),
        dia_inhabil: v.inhabil,
        nota: v.inhabil ? 'Ese día es feriado o fin de semana según la configuración.' : '',
      };
    },
  };

  return async function ejecutar(nombre, input) {
    const fn = herramientas[nombre];
    if (!fn) return { error: 'Herramienta desconocida: ' + nombre };
    try {
      return await fn(input || {});
    } catch (error) {
      return { error: error.message || 'Falló la herramienta ' + nombre };
    }
  };
}
