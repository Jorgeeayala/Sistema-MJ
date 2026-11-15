# Control Remoto Clientes

PWA para gestionar la cartera de clientes de un estudio contable.
Frontend React/Vite con autenticación individual por PIN, acceso por
períodos, edición optimista de la planilla y una vista ejecutiva de
solo lectura.

## Qué incluye la versión actual

- **Inicio de sesión por PIN** por usuario, con sesión individual y
  expiración por inactividad/máxima duración.
- **Alta inicial de PIN** durante la configuración (sujeta a las
  propiedades del backend).
- Selección de **año y mes** según las planillas disponibles.
- **Panel del período** con métricas, prioridades, carga por equipo,
  resumen por vencimiento y la cartera completa de clientes.
  - Búsqueda por nombre o RUC y filtros rápidos.
  - **Más filtros**: vencimiento, estado y encargado (compartidos con
    "Asignar clientes").
  - **Acciones rápidas**: marcar Presentado y Archivado desde la fila,
    sin abrir el cliente.
  - Lista **virtualizada**: sólo se dibujan las filas visibles, así el
    período se mantiene fluido aunque tenga cientos de clientes.
- **Detalle de cliente** con edición de campos, acceso a **Marangatu** y
  vista de solo lectura en el preview ejecutivo.
- **Asignar clientes** (roles con permiso).
- **Configuración** con tema claro/oscuro, **tamaño de texto**
  (Compacto / Normal / Grande / Extra) y cambio de PIN.
- **Marangatu** con apertura del login de la SET y autocompletado
  cuando la extensión está instalada.
- **Vencimientos IVA** (antes, la app aparte `vencimientos-iva`): pestaña
  propia del período para cargar la liquidación de IVA de cada cliente
  (Formulario 120), calcular el vencimiento por el último dígito del RUC
  según el Calendario Perpetuo de la DNIT, la mora, y generar la ficha para
  el cliente (imagen, PDF, texto o WhatsApp), el libro de compras/ventas y
  el PDF del período. Desde el detalle de un cliente, **Liquidación IVA**
  abre directamente la suya.

## Cómo se reparten las funciones

| Sección | Función | Dónde guarda |
|---|---|---|
| Clientes / Estadísticas / Asignar | Control de la cartera: encargado, Presentado, Archivado, Marangatu | Planilla mensual del año (como siempre) |
| Vencimientos IVA | Liquidación, vencimiento, mora, ficha y libros | Hojas `IVA AAAA-MM`, `IVA Clientes` e `IVA Config` |

- La **lista de clientes es una sola**: la planilla del mes elegido. El IVA
  identifica a cada cliente por su **RUC sin DV** (columna tipo "R.U.C.";
  el DV puede venir con guion o en una columna "DV").
- La hoja mensual es el mes en que vencen las obligaciones; el IVA que se
  liquida es el del **período fiscal anterior** (hoja "Octubre" → período
  septiembre). Se puede cambiar de período con las flechas. El desfase está
  en `DESFASE_PERIODO_FISCAL` (`src/iva/IvaModule.jsx`).
- El acceso es el mismo PIN de siempre. Cualquier usuario carga
  liquidaciones; colores, feriados, mora y nombre del estudio sólo los
  cambian `ADMINISTRADOR` y `SUPERUSUARIO`.
- Por defecto las hojas de IVA se crean en la planilla de administración.
  Para usar una planilla aparte, poné su ID en la Script Property
  `IVA_SPREADSHEET_ID`.

### Instalar el módulo de IVA en Apps Script

El módulo vive en su propio archivo, así que no hace falta reemplazar el
`Code.gs` que ya está publicado:

1. En el proyecto de Apps Script: **+ → Secuencia de comandos**, llamarla
   `Iva` y pegar el contenido de `AppsScript-Iva.gs`.
2. En `doPost` del `Code.gs`, justo antes de
   `return errorResponse('Acción desconocida: ' + action, 'UNKNOWN_ACTION');`,
   agregar:
   ```js
   const ivaResponse = handleIvaAction(action, body, sessionUser, sessionRole);
   if (ivaResponse) return ivaResponse;
   ```
3. **Implementar → Administrar implementaciones → editar → Nueva versión**
   (así la URL del Web App no cambia).

### Instalar el módulo de Marcaciones en Apps Script

Igual que el de IVA, en un archivo aparte (`AppsScript-Marcaciones.gs`): crear la
secuencia `Marcaciones`, pegar su contenido y agregar en `doPost`, antes del
`return errorResponse('Acción desconocida: ...')`:
```js
const marcacionesResponse = handleMarcacionesAction(action, body, sessionUser, sessionRole);
if (marcacionesResponse) return marcacionesResponse;
```
Luego, **Nueva versión** de la implementación. Guarda horarios en `Marcaciones Config`
y las planillas procesadas/ajustes diarios por mes en `Marcaciones Datos` dentro de
la planilla de administración. El archivo `.dat` original no se envía. Al publicar
cambios del módulo, actualizar este archivo de Apps Script y crear una nueva versión
del Web App además de publicar el frontend.

### Asistente con IA y envío de fichas por Whaticket

**Qué hace**

- **Asistente** (botón ✨ de la barra superior): un chat que responde en
  lenguaje natural sobre la cartera del período abierto ("¿qué clientes míos
  faltan presentar?"), el IVA ("¿quiénes vencieron y no están presentados?",
  "¿cuánto paga Panadería Sur?") y el uso del sistema ("¿cómo registro la
  documentación?"). Es de **sólo lectura**: no cambia nada en la planilla.
- **Enviar por WhatsApp con Whaticket** (en la liquidación IVA de cada
  cliente): el botón tiene dos opciones.
  - **Al cliente**: abre dentro de Sistema MJ el chat de ese cliente en
    Whaticket (sólo ese chat), con la ficha lista para revisar y enviar.
    Desde ahí también se ve la conversación y se le puede responder.
  - **Al grupo contable**: manda la ficha al grupo de WhatsApp del equipo.
  Las dos marcan la ficha como **Enviado** y salen desde el número del estudio.
  **Ver chat** abre la conversación del cliente sin enviar nada. Sin Whaticket
  configurado, el botón sigue funcionando como antes (WhatsApp Web / app).

**Reglas de Whaticket que conviene conocer**

- Si el cliente escribió en los últimos 7 días, la ficha va a su chat
  existente y no consume créditos.
- Si no escribió en 7 días (o nunca), Whaticket sólo permite escribirle con un
  **mensaje nuevo**, que funciona como una campaña de un mensaje y **puede
  consumir créditos** del plan. Hasta que el cliente responda, no se le puede
  contestar en el chat.
- Al grupo contable sólo se puede escribir si alguien escribió en el grupo en
  los últimos 7 días.

**Cómo está armado**

- `AppsScript-Agente.gs`: guarda la clave de la IA, fija el modelo y el tope
  de respuesta, aplica un límite diario por usuario y registra cada consulta
  (tokens y costo estimado) en la hoja `Agente Uso`.
- `AppsScript-Whaticket.gs`: habla con la API de Whaticket
  (`https://api.whaticket.com/api/v1`) con el token guardado en el servidor.
  Registra cada envío en la hoja `Whaticket Envíos`.
- Las herramientas del asistente (`src/agente/herramientas.js`) corren en la
  app con los mismos datos y permisos que ya ve el usuario. Nunca se le pasan
  columnas de claves (Clave MH, contraseñas, PIN).
- Lo que el asistente "sabe" del sistema está en `src/agente/conocimiento.js`.
  **Al agregar o cambiar una función, actualizá ese texto.**

**Instalación**

1. En el proyecto de Apps Script, crear dos archivos nuevos (**+ →
   Secuencia de comandos**): `Agente` con `AppsScript-Agente.gs` y
   `Whaticket` con `AppsScript-Whaticket.gs`. Reemplazar el contenido de
   `Avisos` por la versión nueva de `AppsScript-Avisos.gs` (su router deriva
   las acciones `agente*` y `whaticket*`; no hace falta tocar `doPost`).
2. En Whaticket: **Integraciones → Tokens → Nuevo token** con los permisos
   `tickets:view`, `tickets:viewAll`, `tickets:viewPending`,
   `campaigns:create`, `campaigns:start` y `connections:view`.
3. **Configuración del proyecto → Propiedades de la secuencia de comandos**:

   | Propiedad | Para qué |
   |---|---|
   | `ANTHROPIC_API_KEY` | Clave de [console.anthropic.com](https://console.anthropic.com) (API Keys). Sin ella el asistente queda apagado. |
   | `AGENTE_MODELO` | Opcional. Por defecto `claude-haiku-5-5`. |
   | `AGENTE_LIMITE_DIARIO` | Opcional. Consultas por usuario y por día (200 por defecto). |
   | `WHATICKET_TOKEN` | Clave del token de Whaticket. Sin ella el botón sigue como antes. |
   | `WHATICKET_GRUPO_NOMBRE` | Nombre exacto del grupo contable como aparece en Whaticket. |
   | `WHATICKET_CONEXION_ID` | Opcional. Sólo si hay más de una conexión de WhatsApp. |
   | `WHATICKET_COLA_ID` | Opcional. Cola donde se abren los chats nuevos. |
   | `WHATICKET_USUARIO_ID` | Opcional. Usuario de Whaticket al que se asignan los chats nuevos. |

4. Ejecutar una vez `probarAsistente` y `probarWhaticket` desde el editor
   (piden permiso para conectarse a servicios externos) y revisar el registro:
   `probarWhaticket` muestra los permisos del token, la conexión de WhatsApp y
   el grupo contable encontrado.
5. **Implementar → Administrar implementaciones → editar → Nueva versión**.
6. Recompilar el frontend y el APK.

**Costos.** La API de la IA se paga por uso, con saldo precargado. En
console.anthropic.com → Limits conviene fijar un tope mensual. Con
`claude-haiku-5-5` una consulta típica cuesta alrededor de US$ 0,003; la hoja
`Agente Uso` muestra el costo estimado de cada una.

### Migrar los datos de la app de Netlify

Si ya había liquidaciones cargadas en `vencimientos-iva`, se traen una sola
vez desde el editor de Apps Script con `migrarDesdeVencimientosIvaNetlify`
(instrucciones en el comentario de la función). Después se puede dar de baja
el sitio de Netlify.

## Cómo correrlo

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar la conexión

Copiá `.env.example` a `.env` y completá:

```ini
VITE_BACKEND_URL=https://script.google.com/.../exec
VITE_API_TOKEN=tu_token
VITE_MARANGATU_LOGIN_URL=https://marangatu.set.gov.py/eset/login
VITE_MARANGATU_EXT_ID=id_de_tu_extension
```

> `VITE_API_TOKEN` no es un secreto real frente al bundle: se
> incorpora al frontend. La validación fuerte la hace el backend.

### 3. Correr en desarrollo

```bash
npm run dev
```

Abrí `http://localhost:3000/`.

### 4. Build de producción

```bash
npm run build
```

La carpeta `dist/` es la que se sube al hosting / se sincroniza con
Capacitor.

## Roles

- `USUARIO`: lee/edita datos permitidos y puede marcar Presentado /
  Archivado. No cambia Encargado.
- `ADMINISTRADOR` y `SUPERUSUARIO`: además pueden asignar y cambiar
  Encargado.

## Estructura relevante

```text
src/
  App.jsx                 estructura de pantallas y sesión
  api.js                  llamadas al backend (POST)
  uiPreferences.js        preferencias locales (tamaño de texto)
  context/ClientsContext  estado compartido de planilla/equipo/filtros
  screens/                pickers, detalle, asignación, nuevo cliente
  ui-executive/           panel del período (interfaz actual)
  iva/                    Vencimientos IVA (cálculo, editor, ficha, PDF)
  components/             modales / utilidades de UI
AppsScript-Code-auth-PROPUESTA.gs   backend de referencia (Apps Script)
AppsScript-Iva.gs                   módulo de IVA del backend (archivo aparte)
AppsScript-Marcaciones.gs           horarios de Marcaciones del backend (archivo aparte)
```

La interfaz que se monta es la ejecutiva: `src/main.jsx` renderiza
`<App uiMode="executive" periodOverviewComponent={ExecutiveDashboard} />`.

## Notas de seguridad

- El backend debe estar con `ALLOW_SELF_PIN_SETUP=false` y
  `ALLOW_PINLESS_LOGIN=false` en producción.
- No subir al repo: `.env`, `API_TOKEN`, `PIN_PEPPER`, PIN reales,
  IDs de planillas ni URLs privadas de despliegue.
- La extensión de Marangatu solo debe permitir orígenes locales
  autorizados.

Para el detalle de pendientes, ver `PENDIENTES.md`.
