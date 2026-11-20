import { forwardRef, lazy, Suspense, useImperativeHandle, useState } from 'react';

const SettingsDialog = lazy(() => import('./SettingsDialog'));

// Contenedor del panel de Configuración. El estado «abierto» vive acá y no en
// App: antes, abrir o cerrar Configuración volvía a dibujar toda la app (la
// lista de clientes incluida) y en PCs modestas con la planilla real se
// trababa un momento. App lo abre y cierra con ref.current.setAbierto(bool).
// mustChangePin lo deja abierto sí o sí (PIN temporal).
const SettingsHost = forwardRef(function SettingsHost(
  { mustChangePin = false, pinChangeSubmitting = false, ...props },
  ref
) {
  const [abierto, setAbierto] = useState(false);
  useImperativeHandle(ref, () => ({ setAbierto }), []);

  if (!abierto && !mustChangePin) return null;
  return (
    <Suspense fallback={null}>
      <SettingsDialog
        key={mustChangePin ? 'settings-must-change-pin' : 'settings-open'}
        open
        mustChangePin={mustChangePin}
        submitting={pinChangeSubmitting}
        onClose={() => {
          if (!pinChangeSubmitting && !mustChangePin) setAbierto(false);
        }}
        {...props}
      />
    </Suspense>
  );
});

export default SettingsHost;
