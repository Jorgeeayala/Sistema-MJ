import { useEffect, useState } from 'react';
import { api, onPrivateDataCleared } from '../api';

// Qué está configurado en el servidor (asistente con IA y Whaticket). Se
// consulta una vez por sesión y se comparte entre pantallas.
const SIN_DATOS = { cargado: false, agente: { activo: false }, whaticket: { activo: false } };

let estadoPromise = null;
let estadoActual = SIN_DATOS;
const oyentes = new Set();

function publicar(next) {
  estadoActual = next;
  oyentes.forEach((fn) => fn(next));
}

export function cargarIntegraciones({ forzar = false } = {}) {
  if (estadoPromise && !forzar) return estadoPromise;
  estadoPromise = api.agente.estado()
    .then((data) => {
      const next = {
        cargado: true,
        agente: { activo: false, ...(data.agente || {}) },
        whaticket: { activo: false, ...(data.whaticket || {}) },
      };
      publicar(next);
      return next;
    })
    .catch((error) => {
      // Backend sin el módulo (UNKNOWN_ACTION) o sin conexión: todo apagado.
      const next = { ...SIN_DATOS, cargado: true, error: error.code === 'UNKNOWN_ACTION' ? 'SIN_MODULO' : (error.message || 'ERROR') };
      publicar(next);
      estadoPromise = null;
      return next;
    });
  return estadoPromise;
}

onPrivateDataCleared(() => {
  estadoPromise = null;
  publicar(SIN_DATOS);
});

export function useIntegraciones(habilitado = true) {
  const [estado, setEstado] = useState(estadoActual);
  useEffect(() => {
    if (!habilitado) return undefined;
    oyentes.add(setEstado);
    cargarIntegraciones();
    return () => { oyentes.delete(setEstado); };
  }, [habilitado]);
  return estado;
}

// Blob → base64 sin el prefijo "data:...;base64,".
export function blobABase64(blob) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result).split('base64,')[1] || '');
    lector.onerror = reject;
    lector.readAsDataURL(blob);
  });
}
