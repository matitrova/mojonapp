# MojonApp — MVP

App web estática para que una inmobiliaria chica de zona serrana muestre los
lotes de un loteo sobre imagen satelital, y ayude a corredor y cliente a
llegar físicamente al lote, incluso donde Google Maps no tiene las calles
trazadas.

No tiene backend ni base de datos: es HTML + CSS + JavaScript vanilla +
[Leaflet](https://leafletjs.com/), y los datos salen de un archivo GeoJSON
local.

## Cómo correrla

Es un sitio estático: cualquier servidor HTTP simple alcanza (no puede
abrirse con `file://` directo porque el navegador bloquea el `fetch` del
GeoJSON por CORS).

```bash
cd Test1_Inmo
python3 -m http.server 8123
```

Y abrir `http://localhost:8123` en el navegador (probarla en modo celular:
las devtools tienen un botón para simular pantalla móvil).

## Estructura de archivos

- **`index.html`** — el esqueleto de la página: el mapa, la ficha del lote
  (oculta hasta que se toca un lote) y el panel de navegación con la
  brújula (oculto hasta tocar "Estoy yendo"). Carga Leaflet desde un CDN
  público (`unpkg.com`), sin claves de API.

- **`css/estilos.css`** — estilos mobile-first. La ficha del lote es una
  "hoja inferior" (bottom sheet) pensada para usarse con una mano en
  celular. El panel de navegación ocupa toda la pantalla para que la
  flecha-brújula sea bien visible mientras se camina.

- **`js/app.js`** — toda la lógica de la app. Contiene:
  - Inicialización del mapa y la capa satelital.
  - Carga del GeoJSON y dibujo de los lotes coloreados por `estado`.
  - La ficha del lote (se llena con las `properties` del feature tocado).
  - `centroideDePoligono()` y `puntoDentroDePoligono()`: geometría casera
    (sin librerías) para calcular el centro de cada lote y saber si el
    usuario está parado adentro.
  - El botón "Ver en el mapa", que arma la URL de Google Maps con el pin
    exacto del lote.
  - El modo "Estoy yendo": geolocalización en vivo, cálculo de distancia y
    rumbo (fórmulas de Haversine y rumbo inicial), y la flecha-brújula que
    se ajusta con la orientación del dispositivo cuando está disponible.

- **`data/carpinteria-01.geojson`** — el loteo real que muestra la app hoy:
  un único lote, con vértices tomados del visor de catastro de San Luis.
  Este archivo es la fuente de verdad geométrica — no se regenera ni se
  reformatea a mano, solo se reemplaza por el próximo loteo real cuando
  corresponda (misma estructura de `properties`: `manzana`, `lote`,
  `nomenclatura`, `superficie_m2`, `estado`, `precio_usd`,
  `observaciones`, más `frente_m`/`fondo_m`/`fuente`/`fecha_toma` que
  trae este archivo en particular). Varias propiedades pueden venir en
  `null` (loteos en trámite, sin nomenclatura asignada todavía) — la
  ficha lo maneja mostrando "Sin datos" en vez de romperse o mostrar
  "null".

- **`data/ejemplo/loteo-merlo.geojson`** — los 12 lotes ficticios usados
  para armar el MVP antes de tener datos reales. Quedan acá solo de
  referencia/demo; la app no los usa (`RUTA_GEOJSON` en `js/app.js`
  apunta al archivo real).

- **`tests/test_lotes.py`** — tests de Playwright (pytest) contra la app
  corriendo en un servidor estático local: que se cargue el lote real,
  que la ficha muestre sus datos correctos (incluyendo el manejo de los
  campos en `null`), que el botón "Ver en el mapa" arme bien la URL de
  Google Maps, y que el modo "Estoy yendo" calcule bien distancia/rumbo
  y detecte cuando el usuario está dentro del lote.

- **`tests/test_geojson_integridad.py`** — test de integridad sobre
  `data/carpinteria-01.geojson`, sin navegador: que el anillo del
  polígono cierre (primer vértice = último) y que la superficie
  calculada a partir de los vértices coincida con `superficie_m2`
  dentro de un 2% de tolerancia. Existe para agarrar justamente el tipo
  de error que no tira excepción — vértices cargados en el orden
  equivocado, que dan un área completamente distinta sin que nada
  avise.

- **`.claude/launch.json`** — configuración para levantar el servidor
  estático desde el panel de vista previa de Claude Code (no es necesaria
  para correr la app "a mano").

## Decisiones de diseño

- **Capa satelital gratuita:** se usa Esri World Imagery
  (`server.arcgisonline.com`), que no requiere API key. Si en el futuro
  contratan un proveedor con mejor resolución para su zona, la capa se
  cambia en un solo lugar: la llamada a `L.tileLayer(...)` en
  `js/app.js` (está comentada para ubicarla fácil).

- **"Ver en el mapa" usa el link de búsqueda de Google Maps**
  (`google.com/maps/search/?api=1&query=lat,lon`), no el de navegación
  (`maps/dir`). Se probó a mano y `dir` puede resolver la coordenada al
  comercio indexado más cercano y mostrar ese lugar como destino en vez
  del punto exacto del lote (en un caso real, un lote vacío terminó
  etiquetado como un taller de chapa y pintura). `search` deja el pin
  clavado en la coordenada exacta. No admite ponerle una etiqueta con el
  nombre del lote —no hay forma de hacer eso sin la API paga de Google
  Maps—, así que va a mostrar coordenadas o el Plus Code de Google en vez
  del número de lote. Tampoco calcula una ruta: el corredor confirma
  visualmente el pin y desde ahí Google Maps arma la navegación si hace
  falta. Google Maps **no puede dibujar el polígono del lote** (eso solo
  se ve en el mapa de nuestra propia app).

- **La brújula funciona con o sin sensor de orientación del dispositivo.**
  Si el navegador da acceso al sensor (y el usuario lo permite — en iOS
  hay que pedirlo explícitamente), la flecha apunta al lote relativa a
  hacia dónde mira el teléfono, como una brújula real. Si no está
  disponible, la flecha sigue funcionando pero asume que "arriba del
  teléfono" es el norte.

- **Permiso de ubicación denegado:** si el usuario no da el permiso, se
  muestra un mensaje explicando qué hacer, en vez de romper la app.

## Advertencia legal (siempre visible en la app)

> Las ubicaciones son orientativas y no reemplazan una mensura
> profesional.

## Correr los tests

```bash
cd Test1_Inmo
python3 -m venv .venv
source .venv/bin/activate
pip install -r tests/requirements.txt
playwright install chromium
pytest tests/
```

Los tests levantan su propio servidor estático en un puerto de prueba, así
que no hace falta tener la app corriendo de antemano.

### Contra qué proyecto Firebase corren

Los tests escriben en Firestore de verdad, así que **conviene que sea un
proyecto aparte y no producción**. Cuando corrían contra producción pasaban
dos cosas concretas:

- Los datos de prueba que quedaban sin borrar (cuando un test se corta a
  mitad, el borrado del `finally` también falla) aparecían en el Dashboard
  real: llegó a mostrar "162 Contactos" y 22 seguimientos que no existían.
- Firestore cuenta las lecturas **por documento**, con 50.000 por día en el
  plan gratuito. Cada apertura del CRM leía todos esos contactos, así que
  una corrida completa de la suite agotaba la cuota del proyecto y **la app
  en producción empezaba a responder 429** a cualquiera que entrara.

Para usar un proyecto de pruebas, agregá a `tests/.env` (no versionado):

```
FIREBASE_API_KEY=<api key del proyecto de pruebas>
FIREBASE_PROJECT_ID=<id del proyecto de pruebas>
TEST_USER_EMAIL=<usuario de prueba>
TEST_USER_PASSWORD=<su contraseña>
```

Y después:

```bash
python3 scripts/sembrar_proyecto_de_pruebas.py
```

Ese script revisa que el proyecto esté bien armado y te dice, paso por
paso, lo que falte. Hay una parte que **no puede hacer**: las reglas exigen
ser root para escribir en `usuarios` y `perfiles`, y para ser root ya hay
que tener esos documentos, así que el primer perfil root se crea a mano
desde la consola de Firebase (el único lugar que se saltea las reglas). El
script te dice exactamente qué documento crear y con qué campos.

Sin esas variables la suite corre contra producción, avisando fuerte por
consola. Nada del proyecto de pruebas se versiona: el cambio de proyecto lo
hace `scripts/servidor_dev.py` (que solo corre en local, Cloudflare Pages
nunca lo ejecuta) sirviendo un `js/firebase-config.js` generado al vuelo, y
el archivo real del repo queda intacto.

> **Ojo:** con dos proyectos, `firestore.rules` se pega a mano en **los
> dos**. No hay Firebase CLI en este proyecto.

La suite además **limpia sola** los datos de prueba sobrantes de corridas
anteriores al arrancar (ver `limpiar_sobrantes_al_arrancar` en
`tests/conftest.py`). Para limpiarlos a mano, mirando antes qué se va a
borrar:

```bash
python3 scripts/limpiar_datos_de_prueba.py
```

### Un solo login por corrida

Los tests no se loguean uno por uno: se hace **un** login y el resto
arranca con la sesión ya puesta (ver `estado_de_sesion` en
`tests/conftest.py`). Firebase Authentication limita las verificaciones
de contraseña por día, y con ~140 por corrida esa cuota se agotaba en
tres o cuatro corridas — y fallaba disfrazado de "Email o contraseña
incorrectos", que se parece muchísimo a un bug real.

Un test que necesita sesión lleva el marcador `con_sesion` (a nivel de
archivo con `pytestmark`, o por test en los archivos que además prueban
el comportamiento **sin** sesión). El que no lo lleva arranca anónimo.

### Antes de commitear un cambio grande en los tests

```bash
python3 scripts/chequear_nombres.py && pytest tests/
```

`chequear_nombres.py` busca nombres usados y no definidos sin ejecutar
nada. Cubre un agujero real: en Python los nombres se resuelven al
ejecutar, así que un `page.goto(base_url)` dentro de una función que no
recibe `base_url` compila bien y `pytest --collect-only` lo importa sin
quejarse — el error recién aparece cuando ese test corre. Pasó dos veces
el mismo día, las dos con cambios automatizados sobre ~40 archivos.
