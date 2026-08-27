// ---------------------------------------------------------------------------
// MojonApp. Los lotes viven en Firestore (colección "lotes"): cualquiera
// que abra la app los puede ver, pero solo un corredor logueado (Firebase
// Auth) puede cargar uno nuevo. Ver firebase-config.js y firestore.rules.
// ---------------------------------------------------------------------------

import { db, auth, firebaseConfig } from "./firebase-config.js";
import {
  initializeApp,
  deleteApp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  collection,
  getDocs,
  getDoc,
  addDoc,
  deleteDoc,
  updateDoc,
  setDoc,
  doc,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  getAuth
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const COLECCION_LOTES = "lotes";

// GeoServer público de la Dirección Provincial de Catastro y Tierras
// Fiscales de San Luis (el mismo que usa su visor público en
// sistemacatastro.sanluis.gov.ar). No es una API oficial ni documentada:
// se encontró mirando qué pide el navegador del visor. Puede cambiar o
// dejar de andar sin aviso — si eso pasa, "Traer manzana del catastro"
// deja de funcionar pero el resto de la app sigue igual.
//
// No se pide directo: ese GeoServer solo responde por HTTP (sin TLS
// válido), y el navegador bloquea ese pedido como "mixed content" desde
// una página HTTPS como mojonapp.com.ar. Se pasa por
// netlify/functions/catastro-proxy.js, que sí puede hablarle por HTTP
// (corre en el servidor, no en el navegador) y devuelve la respuesta
// por HTTPS. En local (servidor de pruebas por HTTP) esta ruta no
// existe — pedirWfs() cae al WFS real directo en ese caso, ver abajo.
const CATASTRO_WFS_URL =
  location.protocol === "https:" ? "/.netlify/functions/catastro-proxy" : "http://visualcatsl.dyndns.info/geoserver/SanLuis/ows";

const COLOR_POR_ESTADO = {
  disponible: "#2e7d32",
  reservado: "#f9a825",
  vendido: "#c62828"
};

const ETIQUETA_ESTADO = {
  disponible: "Disponible",
  reservado: "Reservado",
  vendido: "Vendido"
};

// Servicios que puede tener un lote (luz, agua, gas, cloaca). El catastro
// no trae este dato — solo se carga a mano ("Cargar a mano"), así que la
// mayoría de los lotes importados de "+ Manzana"/"+ Parcela" no van a
// tener el campo `servicios` en absoluto. Se distingue "sin dato" (no se
// muestra nada) de "no tiene el servicio" (chip apagado) — ver
// renderServiciosHTML.
const SERVICIOS_INFO = [
  { clave: "luz", icono: "⚡", etiqueta: "Luz" },
  { clave: "agua", icono: "🚰", etiqueta: "Agua" },
  { clave: "gas", icono: "🔥", etiqueta: "Gas" },
  { clave: "cloaca", icono: "🚽", etiqueta: "Cloaca" }
];

function renderServiciosHTML(servicios) {
  if (servicios == null) return "Sin datos";
  return SERVICIOS_INFO.map(({ clave, icono, etiqueta }) => {
    const tiene = !!servicios[clave];
    return `<span class="chip-servicio${tiene ? "" : " sin-servicio"}">${icono} ${etiqueta}</span>`;
  }).join("");
}

let lotePolyLayerSeleccionado = null; // feature GeoJSON del lote actualmente en la ficha
let corredorLogueado = false; // se actualiza en onAuthStateChanged; true con cualquier perfil logueado
// Perfil de seguridad del usuario logueado ({ es_root, permisos: {...} }),
// o null sin sesión. Se resuelve en onAuthStateChanged leyendo
// usuarios/{uid} -> perfiles/{perfil_id}. Root tiene vía libre en
// tienePermiso() sin necesidad de tildar cada permiso a mano.
let miPerfilActual = null;
let lotesActuales = []; // último resultado de cargarLotesDesdeFirestore, lo reusa la vista en lista
let sectoresActuales = []; // catálogo de zonas (colección "sectores"), alimenta los combos
let barriosActuales = []; // catálogo de barrios (colección "barrios") — misma idea, categoría independiente de zona
let watchId = null; // id de navigator.geolocation.watchPosition, para poder cancelarlo
let listenerOrientacion = null; // referencia al handler de deviceorientation, para poder sacarlo

// ---------------------------------------------------------------------------
// Catálogo de sectores/zonas: antes "Sector" era texto libre en cada
// lote, y cada corredor terminaba escribiendo su propia variante del
// mismo nombre ("Zona Norte", "zona norte", "Norte"...). Ahora es un
// combo que sale de la colección "sectores" (administrada desde el
// panel "Sectores" del menú), y el lote sigue guardando el nombre como
// texto plano — no hay una relación por id, así que borrar un sector
// del catálogo no le mueve el dato a los lotes que ya lo tenían.
// ---------------------------------------------------------------------------

async function cargarSectores() {
  try {
    const snapshot = await getDocs(collection(db, "sectores"));
    sectoresActuales = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  } catch {
    // Si falla (reglas viejas sin esta colección, sin conexión, etc.) el
    // combo queda con "Sin zona" nomás — no puede tirar abajo el login
    // ni el resto de la carga de lotes.
    sectoresActuales = [];
  }
}

// Mismo catálogo que zonas, colección separada — un lote tiene zona Y
// barrio a la vez, son dos categorías independientes.
async function cargarBarrios() {
  try {
    const snapshot = await getDocs(collection(db, "barrios"));
    barriosActuales = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  } catch {
    barriosActuales = [];
  }
}

// valorActual: el nombre que ya tiene el lote (si lo tiene), para
// preseleccionarlo — y para no perderlo si ya no está en el catálogo
// (se borró después de asignárselo a este lote, o se cargó a mano antes
// de que existiera esta lista). catalogo/textoVacio parametrizan entre
// zona y barrio, que comparten exactamente esta misma lógica.
function poblarSelectCatalogo(elSelect, valorActual, catalogo, textoVacio) {
  const opciones = catalogo.map((s) => `<option value="${s.nombre}">${s.nombre}</option>`);
  if (valorActual && !catalogo.some((s) => s.nombre === valorActual)) {
    opciones.push(`<option value="${valorActual}">${valorActual} (fuera del catálogo)</option>`);
  }
  elSelect.innerHTML = `<option value="">${textoVacio}</option>` + opciones.join("");
  elSelect.value = valorActual || "";
}

function poblarSelectSector(elSelect, valorActual) {
  poblarSelectCatalogo(elSelect, valorActual, sectoresActuales, "Sin zona");
}

function poblarSelectBarrio(elSelect, valorActual) {
  poblarSelectCatalogo(elSelect, valorActual, barriosActuales, "Sin barrio");
}

// ---------------------------------------------------------------------------
// Permisos: quién puede qué. Todo lo que decide acá es solo para mostrar
// u ocultar botones — el permiso real lo hacen cumplir las reglas de
// Firestore (firestore.rules), que repiten esta misma lógica del lado
// del servidor. Si algo queda mal escondido acá, Firestore igual lo
// rechaza.
// ---------------------------------------------------------------------------

function esRootActual() {
  return !!miPerfilActual && miPerfilActual.es_root === true;
}

function tienePermiso(clave) {
  if (!miPerfilActual) return false;
  if (miPerfilActual.es_root) return true;
  return miPerfilActual.permisos?.[clave] === true;
}

function esDuenoDelLote(feature) {
  return !!auth.currentUser && feature.properties.creado_por === auth.currentUser.uid;
}

function puedeEditarLote(feature) {
  if (esRootActual()) return true;
  return esDuenoDelLote(feature) ? tienePermiso("editar_lote_propio") : tienePermiso("editar_lote_ajeno");
}

function puedeBorrarLote(feature) {
  if (esRootActual()) return true;
  return esDuenoDelLote(feature) ? tienePermiso("borrar_lote_propio") : tienePermiso("borrar_lote_ajeno");
}

// ---------------------------------------------------------------------------
// Mapa base
// ---------------------------------------------------------------------------

// maxZoom (24) es hasta dónde deja acercarse el mapa; maxNativeZoom es
// hasta dónde Esri realmente tiene fotos en la zona rural que usa esta
// app (en el centro de una ciudad grande puede llegar a 20-21, pero en
// el campo suele cortar antes). Sin maxNativeZoom, pasado ese punto
// Leaflet pide tiles que no existen y el mapa queda en blanco ("Map
// data not yet available"). Con maxNativeZoom, Leaflet sigue
// permitiendo acercarse: agranda el último tile real en vez de pedir
// uno inexistente, así que la imagen se ve más borrosa pero el mapa
// nunca desaparece — y el polígono del lote, que es un dibujo
// vectorial y no una imagen, se sigue viendo nítido en cualquier zoom.
//
// El valor 18 se verificó bajando tiles reales del servicio para
// Carpintería/Merlo (zona de los lotes cargados): en zoom 18 la imagen
// es satelital real (~13-18 KB por tile); en zoom 19 y más, Esri
// devuelve siempre el mismo tile de "Map data not yet available"
// (2521 bytes exactos) — el corte real acá es 18, no 19. Si el corredor
// carga lotes en otra zona con mejor cobertura, en el peor caso el mapa
// se ve un poco más borroso ahí de lo estrictamente necesario, pero
// nunca desaparece — eso es preferible a que desaparezca en ESTA zona.
const mapa = L.map("mapa", { zoomControl: true, maxZoom: 24 }).setView([-32.34715, -65.01300], 18);

// Capa satelital gratuita (Esri World Imagery, sin API key).
// Si más adelante contratan un proveedor con mejor resolución (Mapbox, Google Maps
// Platform, etc.), la capa se cambia acá: reemplazar la URL y el "attribution".
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 24,
    maxNativeZoom: 18,
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics"
  }
).addTo(mapa);

// Leyenda de colores por estado
const leyenda = L.control({ position: "bottomleft" });
leyenda.onAdd = function () {
  const div = L.DomUtil.create("div", "leyenda-estados");
  div.innerHTML = Object.keys(COLOR_POR_ESTADO)
    .map(
      (estado) =>
        `<div><span style="background:${COLOR_POR_ESTADO[estado]}"></span>${ETIQUETA_ESTADO[estado]}</div>`
    )
    .join("");
  return div;
};
leyenda.addTo(mapa);

let capaLotes = null;

// Un documento de Firestore es {geometry, ...propiedades} (ver
// formularioLote.addEventListener("submit", ...) más abajo). Se reconstruye
// como Feature GeoJSON para reusar el resto del código (ficha, centroide,
// "estoy yendo"), que ya trabaja con esa forma.
//
// geometry.coordinates en Firestore NO es el anillo GeoJSON de siempre
// ([[lon,lat], ...]): Firestore no permite un array que tenga otro array
// como elemento directo (a cualquier profundidad), y coordinates de un
// Polygon GeoJSON son array de array de [lon,lat] — tres niveles. Se
// guarda como un array plano de objetos {lon, lat} (los lotes de esta app
// nunca tienen agujeros, así que un solo anillo alcanza) y se lo envuelve
// de vuelta en el formato GeoJSON estándar acá, solo en memoria.
// La conversión inversa: un anillo GeoJSON ([lon, lat], ...) al formato
// plano que sí acepta Firestore. La usan tanto la carga manual (vértices
// pegados a mano) como la importación de manzanas del catastro.
function anilloAGeometryFirestore(anillo) {
  return {
    type: "Polygon",
    coordinates: anillo.map(([lon, lat]) => ({ lon, lat }))
  };
}

function docALoteFeature(doc) {
  const { geometry, ...properties } = doc.data();
  const anillo = geometry.coordinates.map((punto) => [punto.lon, punto.lat]);
  return {
    type: "Feature",
    id: doc.id,
    properties,
    geometry: { type: "Polygon", coordinates: [anillo] }
  };
}

async function cargarLotesDesdeFirestore() {
  // Un corredor sin "ver_todos_los_lotes" solo trae lo suyo — root, y
  // cualquiera sin sesión (el catálogo público), siguen viendo todo.
  const restringirAPropios = !!miPerfilActual && !esRootActual() && !tienePermiso("ver_todos_los_lotes");
  const consulta = restringirAPropios
    ? query(collection(db, COLECCION_LOTES), where("creado_por", "==", auth.currentUser.uid))
    : collection(db, COLECCION_LOTES);
  const snapshot = await getDocs(consulta);
  const features = snapshot.docs.map(docALoteFeature);
  lotesActuales = features; // la vista en grilla reusa esto, no vuelve a pedirle nada a Firestore
  actualizarVistaLista();

  // Reconstruir capaLotes con "Ver catastro cercano" prendido (600+
  // elementos ya en el DOM) es lo que causaba el freeze real que se vio
  // con "+ Manzana" al importar varios lotes de golpe — se saca la capa
  // de referencia un momento y se repone después de terminar, sin
  // volver a pedirle nada al catastro.
  const habiaCatastroCercano = capaCatastroCercano && mapa.hasLayer(capaCatastroCercano);
  if (habiaCatastroCercano) mapa.removeLayer(capaCatastroCercano);

  if (capaLotes) {
    mapa.removeLayer(capaLotes);
  }

  capaLotes = L.geoJSON(
    { type: "FeatureCollection", features },
    {
      style: (feature) => ({
        color: "#ffffff",
        weight: 2,
        fillColor: COLOR_POR_ESTADO[feature.properties.estado] || "#888",
        fillOpacity: 0.55,
        // Clase estable por lote (adelante del id va una letra siempre,
        // "lote-", porque un id de Firestore puede arrancar con un
        // número y eso no es válido como iniciador de clase CSS). La
        // usan los tests para apuntar a un lote puntual en vez de
        // contar todos los polígonos del mapa — necesario ahora que la
        // colección tiene lotes reales además de los que siembra cada
        // test.
        className: `lote-poligono lote-${feature.id}`
      }),
      onEachFeature: (feature, layer) => {
        layer.on("click", () => {
          // Si se está capturando vértices (a mano en el mapa, o con GPS),
          // tocar un lote ya cargado no debería abrir su ficha encima y
          // pisar lo que se venía marcando — se ignora el click acá y,
          // en el caso de "dibujar en el mapa", sigue de largo hasta el
          // listener del mapa para agregarlo como vértice.
          if (modoCaptura !== null) return;
          mostrarFicha(feature);
        });
        // Pasar el mouse por encima adelanta un resumen sin tener que
        // tocar el lote — pedido explícito. "sticky" para que el cartel
        // siga al cursor en vez de quedar fijo en un punto del
        // polígono (con lotes grandes, quedaba lejos del mouse).
        layer.bindTooltip(contenidoTooltipLote(feature), {
          direction: "top",
          sticky: true,
          className: "tooltip-lote-mapa"
        });
      }
    }
  ).addTo(mapa);

  if (features.length > 0) {
    mapa.fitBounds(capaLotes.getBounds(), { padding: [20, 20] });
  }

  if (habiaCatastroCercano) capaCatastroCercano.addTo(mapa);
}

cargarLotesDesdeFirestore().catch((error) => {
  console.error("No se pudieron cargar los lotes desde Firestore:", error);
});

// ---------------------------------------------------------------------------
// Geometría: centroide de un polígono y test de punto-dentro-de-polígono.
// Se implementan a mano (sin Turf.js) porque el MVP no tiene otras dependencias
// además de Leaflet, y estas dos funciones son chicas.
// ---------------------------------------------------------------------------

// Centroide "de área" de un anillo exterior de polígono GeoJSON ([lon, lat], ...).
// Para los rectángulos de ejemplo da lo mismo que el promedio simple, pero esta
// fórmula también es correcta para polígonos irregulares (mensuras reales).
//
// Los puntos se trasladan a coordenadas locales (relativas al primer vértice)
// antes de operar: lon/lat rondan magnitudes como -65/-32, mientras que un
// lote mide unos pocos metros en grados (~0.0003). Calcular la fórmula del
// área directamente sobre esas coordenadas "grandes" resta números casi
// iguales entre sí y pierde toda la precisión (cancelación catastrófica),
// dando un centroide desplazado varios metros del real.
function centroideDePoligono(anillo) {
  const puntos = anillo[0][0] === anillo[anillo.length - 1][0] && anillo[0][1] === anillo[anillo.length - 1][1]
    ? anillo.slice(0, -1)
    : anillo;

  const [lonOrigen, latOrigen] = puntos[0];
  const locales = puntos.map(([lon, lat]) => [lon - lonOrigen, lat - latOrigen]);

  let areaAcumulada = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < locales.length; i++) {
    const [x0, y0] = locales[i];
    const [x1, y1] = locales[(i + 1) % locales.length];
    const cruzado = x0 * y1 - x1 * y0;
    areaAcumulada += cruzado;
    cx += (x0 + x1) * cruzado;
    cy += (y0 + y1) * cruzado;
  }

  if (areaAcumulada === 0) {
    // Polígono degenerado: fallback a promedio simple.
    const lon = puntos.reduce((s, p) => s + p[0], 0) / puntos.length;
    const lat = puntos.reduce((s, p) => s + p[1], 0) / puntos.length;
    return { lat, lon };
  }

  const area = areaAcumulada / 2;
  cx = cx / (6 * area);
  cy = cy / (6 * area);
  return { lat: cy + latOrigen, lon: cx + lonOrigen };
}

// Superficie en m² de un anillo de polígono ([lon, lat], ...), con la misma
// proyección local que centroideDePoligono (evita la cancelación numérica).
// Se usa en el formulario de carga para avisarle al corredor si el área que
// dan los vértices que pegó no se parece a la superficie declarada — el
// caso real que motivó el test de integridad del GeoJSON (vértices en
// orden cruzado, área totalmente distinta, sin ningún error visible).
function areaEnM2(anillo) {
  const [lonOrigen, latOrigen] = anillo[0];
  const mPorGradoLat = 111320;
  const mPorGradoLon = 111320 * Math.cos(aRadianes(latOrigen));
  const puntosMetros = anillo.map(([lon, lat]) => [
    (lon - lonOrigen) * mPorGradoLon,
    (lat - latOrigen) * mPorGradoLat
  ]);

  let area2 = 0;
  for (let i = 0; i < puntosMetros.length - 1; i++) {
    const [x0, y0] = puntosMetros[i];
    const [x1, y1] = puntosMetros[i + 1];
    area2 += x0 * y1 - x1 * y0;
  }
  return Math.abs(area2) / 2;
}

// Largo en metros de cada lado de un anillo de polígono ([lon, lat], ...),
// en el orden en que están los vértices — misma proyección local que
// areaEnM2, más que suficiente de precisa para un lote (decenas de
// metros, no kilómetros). Se usa para mostrar "cuánto mide" un lote sin
// que el corredor tenga que medir nada a mano: pedido explícito, para
// saber el frente/fondo de un terreno con solo mirarlo.
function ladosDelPoligonoEnMetros(anillo) {
  const puntos = anillo[0][0] === anillo[anillo.length - 1][0] && anillo[0][1] === anillo[anillo.length - 1][1]
    ? anillo.slice(0, -1)
    : anillo;
  if (puntos.length < 2) return [];

  const [lonOrigen, latOrigen] = puntos[0];
  const mPorGradoLat = 111320;
  const mPorGradoLon = 111320 * Math.cos(aRadianes(latOrigen));
  const puntosMetros = puntos.map(([lon, lat]) => [
    (lon - lonOrigen) * mPorGradoLon,
    (lat - latOrigen) * mPorGradoLat
  ]);

  return puntosMetros.map(([x0, y0], i) => {
    const [x1, y1] = puntosMetros[(i + 1) % puntosMetros.length];
    return Math.hypot(x1 - x0, y1 - y0);
  });
}

// Texto listo para mostrar ("45.2 m, 30.1 m, 44.8 m, 29.9 m") — no se
// etiqueta como "frente"/"fondo" porque no hay forma de saber desde la
// geometría sola cuál lado da a la calle; se listan en orden y el
// corredor, que conoce el lote, los reconoce con solo mirar el mapa.
function textoMedidasLados(anillo) {
  const lados = ladosDelPoligonoEnMetros(anillo);
  if (lados.length === 0) return "Sin datos";
  return lados.map((m) => `${m.toFixed(1)} m`).join(", ");
}

// Ray casting: ¿el punto (lat, lon) está dentro del anillo exterior?
function puntoDentroDePoligono(lat, lon, anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i];
    const [xj, yj] = anillo[j];
    const interseca =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (interseca) dentro = !dentro;
  }
  return dentro;
}

// ---------------------------------------------------------------------------
// Distancia (Haversine) y rumbo inicial entre dos puntos, en grados.
// ---------------------------------------------------------------------------

const RADIO_TIERRA_M = 6371000;

function aRadianes(g) {
  return (g * Math.PI) / 180;
}

function distanciaMetros(lat1, lon1, lat2, lon2) {
  const dLat = aRadianes(lat2 - lat1);
  const dLon = aRadianes(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aRadianes(lat1)) * Math.cos(aRadianes(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return RADIO_TIERRA_M * c;
}

function rumboInicial(lat1, lon1, lat2, lon2) {
  const y = Math.sin(aRadianes(lon2 - lon1)) * Math.cos(aRadianes(lat2));
  const x =
    Math.cos(aRadianes(lat1)) * Math.sin(aRadianes(lat2)) -
    Math.sin(aRadianes(lat1)) * Math.cos(aRadianes(lat2)) * Math.cos(aRadianes(lon2 - lon1));
  const grados = (Math.atan2(y, x) * 180) / Math.PI;
  return (grados + 360) % 360;
}

// ---------------------------------------------------------------------------
// Hojas inferiores (ficha, login, y los formularios de carga): todas
// comparten la misma posición fija en la parte de abajo de la pantalla,
// así que abrir una sin cerrar las demás las deja superpuestas. Cualquier
// botón que abra una hoja pasa por acá para cerrar el resto primero.
// ---------------------------------------------------------------------------

function abrirHoja(elHoja) {
  document.querySelectorAll(".hoja-inferior").forEach((hoja) => {
    if (hoja !== elHoja) hoja.classList.add("oculto");
  });
  elHoja.classList.remove("oculto");
}

// ---------------------------------------------------------------------------
// Menú lateral (drawer): todas las secciones/subsecciones de la app en
// un solo lugar, para no seguir amontonando botones en el header a
// medida que se suman funciones nuevas.
// ---------------------------------------------------------------------------

const elBtnMenu = document.getElementById("btn-menu");
const elDrawerMenu = document.getElementById("drawer-menu");
const elDrawerOverlay = document.getElementById("drawer-overlay");

function abrirDrawer() {
  elDrawerMenu.classList.remove("oculto");
  elDrawerOverlay.classList.remove("oculto");
}

function cerrarDrawer() {
  elDrawerMenu.classList.add("oculto");
  elDrawerOverlay.classList.add("oculto");
}

elBtnMenu.addEventListener("click", abrirDrawer);
document.getElementById("cerrar-drawer").addEventListener("click", cerrarDrawer);
elDrawerOverlay.addEventListener("click", cerrarDrawer);

// Elegir cualquier acción del menú cierra el drawer: casi todas abren
// otra hoja o panel encima del mapa, así que dejarlo abierto tapando
// todo no sirve.
document.querySelectorAll(".drawer-item").forEach((boton) => {
  boton.addEventListener("click", cerrarDrawer);
});

// Subsecciones plegables (genérico: cualquier ".drawer-grupo-titulo"
// nuevo que se agregue más adelante ya funciona solo, sin tocar este
// código de nuevo). Arrancan cerradas para que la lista no se alargue
// sola a medida que se sumen más secciones.
document.querySelectorAll(".drawer-grupo-titulo").forEach((boton) => {
  const items = boton.nextElementSibling;
  boton.addEventListener("click", () => {
    const abierto = boton.classList.toggle("abierto");
    items.classList.toggle("oculto", !abierto);
  });
});

// ---------------------------------------------------------------------------
// Ficha del lote
// ---------------------------------------------------------------------------

const elFicha = document.getElementById("ficha-lote");
const elTitulo = document.getElementById("ficha-titulo");
const elSuperficie = document.getElementById("ficha-superficie");
const elMedidas = document.getElementById("ficha-medidas");
const elEstado = document.getElementById("ficha-estado");
const elPrecio = document.getElementById("ficha-precio");
const elServicios = document.getElementById("ficha-servicios");
const elObservaciones = document.getElementById("ficha-observaciones");
const elBtnEditarServicios = document.getElementById("btn-editar-servicios");
const elEditorServicios = document.getElementById("editor-servicios");
const elEditarServicioLuz = document.getElementById("editar-servicio-luz");
const elEditarServicioAgua = document.getElementById("editar-servicio-agua");
const elEditarServicioGas = document.getElementById("editar-servicio-gas");
const elEditarServicioCloaca = document.getElementById("editar-servicio-cloaca");
const elBtnGuardarServicios = document.getElementById("btn-guardar-servicios");
const elBtnCancelarServicios = document.getElementById("btn-cancelar-servicios");
const elEditorServiciosError = document.getElementById("editor-servicios-error");

const elSector = document.getElementById("ficha-sector");
const elBtnEditarSector = document.getElementById("btn-editar-sector");
const elEditorSector = document.getElementById("editor-sector");
const elEditarSectorValor = document.getElementById("editar-sector-valor");
const elBtnGuardarSector = document.getElementById("btn-guardar-sector");
const elBtnCancelarSector = document.getElementById("btn-cancelar-sector");
const elEditorSectorError = document.getElementById("editor-sector-error");

const elBarrio = document.getElementById("ficha-barrio");
const elBtnEditarBarrio = document.getElementById("btn-editar-barrio");
const elEditorBarrio = document.getElementById("editor-barrio");
const elEditarBarrioValor = document.getElementById("editar-barrio-valor");
const elBtnGuardarBarrio = document.getElementById("btn-guardar-barrio");
const elBtnCancelarBarrio = document.getElementById("btn-cancelar-barrio");
const elEditorBarrioError = document.getElementById("editor-barrio-error");

// Varios lotes reales todavía no tienen nomenclatura catastral asignada ni
// manzana/lote definidos (loteos nuevos, en trámite). Se arma el título con
// el mejor identificador disponible, sin mostrar nunca "null".
function tituloLote(p) {
  if (p.nomenclatura) return p.nomenclatura;
  if (p.manzana != null && p.lote != null) return `Manzana ${p.manzana} — Lote ${p.lote}`;
  return "Lote sin nomenclatura catastral";
}

// Contenido del cartel que aparece al pasar el mouse por encima de un
// lote cargado (ver bindTooltip en cargarLotesDesdeFirestore) — un
// resumen rápido sin tener que tocarlo y abrir la ficha completa.
function contenidoTooltipLote(feature) {
  const p = feature.properties;
  const superficie = p.superficie_m2 == null ? "Sin datos" : `${p.superficie_m2} m²`;
  const precio = p.precio_usd == null ? "Sin datos" : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`;
  return `
    <div class="tooltip-lote-titulo">${tituloLote(p)}</div>
    <div>Zona: ${p.sector || "Sin datos"}</div>
    <div>Barrio: ${p.barrio || "Sin datos"}</div>
    <div>Superficie: ${superficie}</div>
    <div>Medidas: ${textoMedidasLados(feature.geometry.coordinates[0])}</div>
    <div>Estado: ${ETIQUETA_ESTADO[p.estado] || p.estado}</div>
    <div>Precio: ${precio}</div>
  `;
}

function mostrarFicha(feature) {
  lotePolyLayerSeleccionado = feature;
  const p = feature.properties;

  elTitulo.textContent = tituloLote(p);
  elSector.textContent = p.sector || "Sin datos";
  elBarrio.textContent = p.barrio || "Sin datos";
  // superficie_m2 puede venir en null: el catastro no siempre la declara
  // para sub-parcelas (se vio con datos reales de "+ Manzana"), y a
  // diferencia del formulario manual, la importación en bloque no pasa
  // por el "required" del campo — puede llegar null a Firestore.
  elSuperficie.textContent = p.superficie_m2 == null ? "Sin datos" : `${p.superficie_m2} m²`;
  elMedidas.textContent = textoMedidasLados(feature.geometry.coordinates[0]);
  elEstado.textContent = ETIQUETA_ESTADO[p.estado] || p.estado;
  elPrecio.textContent = p.precio_usd == null ? "Sin datos" : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`;
  elServicios.innerHTML = renderServiciosHTML(p.servicios);
  elObservaciones.textContent = p.observaciones || "Sin datos";

  document.getElementById("btn-borrar-lote").classList.toggle("oculto", !puedeBorrarLote(feature));
  document.getElementById("btn-editar-lote-completo").classList.toggle("oculto", !puedeEditarLote(feature));
  cerrarEditorServicios(); // por si había quedado abierto en el lote anterior
  cerrarEditorSector();
  cerrarEditorBarrio();

  abrirHoja(elFicha);
}

document.getElementById("cerrar-ficha").addEventListener("click", () => {
  elFicha.classList.add("oculto");
});

// "Editar lote" en la ficha abre el mismo formulario completo que
// "Editar" desde la grilla (manzana/lote/nomenclatura/superficie/
// estado/precio/sector/servicios/observaciones) — pedido explícito:
// antes solo se podía corregir todo eso yendo a "Ver como lista", acá
// arriba del mapa solo había editores sueltos para sector y servicios.
// Reusa mostrarEditarLoteDesdeGrilla tal cual para no duplicar la
// validación de nomenclatura ni el guardado.
document.getElementById("btn-editar-lote-completo").addEventListener("click", () => {
  if (!lotePolyLayerSeleccionado) return;
  elFicha.classList.add("oculto");
  document.getElementById("panel-admin").classList.add("oculto");
  document.getElementById("panel-sectores").classList.add("oculto");
  document.getElementById("panel-barrios").classList.add("oculto");
  elVistaLista.classList.remove("oculto");
  elBtnVerLista.classList.add("activo");
  loteEditadoDesdeFicha = true;
  mostrarEditarLoteDesdeGrilla(lotePolyLayerSeleccionado);
});

// Editar servicios de un lote ya cargado: el catastro no trae este dato,
// así que la mayoría de los lotes traídos por "+ Manzana"/"+ Parcela"
// necesitan que un corredor lo complete después, no solo al cargarlos a
// mano. Mismo criterio de permiso que "Borrar lote" (propio/ajeno, ver
// puedeEditarLote).
function cerrarEditorServicios() {
  elEditorServicios.classList.add("oculto");
  elServicios.classList.remove("oculto");
  elBtnEditarServicios.classList.toggle(
    "oculto",
    !lotePolyLayerSeleccionado || !puedeEditarLote(lotePolyLayerSeleccionado)
  );
  elEditorServiciosError.classList.add("oculto");
}

elBtnEditarServicios.addEventListener("click", () => {
  const servicios = lotePolyLayerSeleccionado?.properties?.servicios || {};
  elEditarServicioLuz.checked = !!servicios.luz;
  elEditarServicioAgua.checked = !!servicios.agua;
  elEditarServicioGas.checked = !!servicios.gas;
  elEditarServicioCloaca.checked = !!servicios.cloaca;
  elServicios.classList.add("oculto");
  elBtnEditarServicios.classList.add("oculto");
  elEditorServicios.classList.remove("oculto");
});

elBtnCancelarServicios.addEventListener("click", cerrarEditorServicios);

elBtnGuardarServicios.addEventListener("click", async () => {
  if (!lotePolyLayerSeleccionado) return;
  const servicios = {
    luz: elEditarServicioLuz.checked,
    agua: elEditarServicioAgua.checked,
    gas: elEditarServicioGas.checked,
    cloaca: elEditarServicioCloaca.checked
  };

  elBtnGuardarServicios.disabled = true;
  elEditorServiciosError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, lotePolyLayerSeleccionado.id), { servicios });
    lotePolyLayerSeleccionado.properties.servicios = servicios;
    elServicios.innerHTML = renderServiciosHTML(servicios);
    cerrarEditorServicios();
    cargarLotesDesdeFirestore(); // refresca mapa y grilla; la ficha ya se actualizó sola arriba
  } catch (error) {
    elEditorServiciosError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para editar servicios. Iniciá sesión de nuevo."
        : "No se pudieron guardar los servicios.";
    elEditorServiciosError.classList.remove("oculto");
  } finally {
    elBtnGuardarServicios.disabled = false;
  }
});

// Editar sector/zona: es el corredor quien organiza su propia cartera
// (el catastro no tiene idea de "sectores"), así que casi todo lote
// importado necesita que alguien se lo asigne después. Mismo criterio
// de permiso y mismo patrón que "Editar servicios".
function cerrarEditorSector() {
  elEditorSector.classList.add("oculto");
  elSector.classList.remove("oculto");
  elBtnEditarSector.classList.toggle(
    "oculto",
    !lotePolyLayerSeleccionado || !puedeEditarLote(lotePolyLayerSeleccionado)
  );
  elEditorSectorError.classList.add("oculto");
}

elBtnEditarSector.addEventListener("click", () => {
  poblarSelectSector(elEditarSectorValor, lotePolyLayerSeleccionado?.properties?.sector);
  elSector.classList.add("oculto");
  elBtnEditarSector.classList.add("oculto");
  elEditorSector.classList.remove("oculto");
  elEditarSectorValor.focus();
});

elBtnCancelarSector.addEventListener("click", cerrarEditorSector);

elBtnGuardarSector.addEventListener("click", async () => {
  if (!lotePolyLayerSeleccionado) return;
  const sector = elEditarSectorValor.value.trim() || null;

  elBtnGuardarSector.disabled = true;
  elEditorSectorError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, lotePolyLayerSeleccionado.id), { sector });
    lotePolyLayerSeleccionado.properties.sector = sector;
    elSector.textContent = sector || "Sin datos";
    cerrarEditorSector();
    cargarLotesDesdeFirestore(); // refresca mapa y grilla; la ficha ya se actualizó sola arriba
  } catch (error) {
    elEditorSectorError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para editar la zona. Iniciá sesión de nuevo."
        : "No se pudo guardar la zona.";
    elEditorSectorError.classList.remove("oculto");
  } finally {
    elBtnGuardarSector.disabled = false;
  }
});

// Editar barrio: mismo patrón exacto que "Editar zona" arriba — segunda
// categorización independiente de un lote.
function cerrarEditorBarrio() {
  elEditorBarrio.classList.add("oculto");
  elBarrio.classList.remove("oculto");
  elBtnEditarBarrio.classList.toggle(
    "oculto",
    !lotePolyLayerSeleccionado || !puedeEditarLote(lotePolyLayerSeleccionado)
  );
  elEditorBarrioError.classList.add("oculto");
}

elBtnEditarBarrio.addEventListener("click", () => {
  poblarSelectBarrio(elEditarBarrioValor, lotePolyLayerSeleccionado?.properties?.barrio);
  elBarrio.classList.add("oculto");
  elBtnEditarBarrio.classList.add("oculto");
  elEditorBarrio.classList.remove("oculto");
  elEditarBarrioValor.focus();
});

elBtnCancelarBarrio.addEventListener("click", cerrarEditorBarrio);

elBtnGuardarBarrio.addEventListener("click", async () => {
  if (!lotePolyLayerSeleccionado) return;
  const barrio = elEditarBarrioValor.value.trim() || null;

  elBtnGuardarBarrio.disabled = true;
  elEditorBarrioError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, lotePolyLayerSeleccionado.id), { barrio });
    lotePolyLayerSeleccionado.properties.barrio = barrio;
    elBarrio.textContent = barrio || "Sin datos";
    cerrarEditorBarrio();
    cargarLotesDesdeFirestore(); // refresca mapa y grilla; la ficha ya se actualizó sola arriba
  } catch (error) {
    elEditorBarrioError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para editar el barrio. Iniciá sesión de nuevo."
        : "No se pudo guardar el barrio.";
    elEditorBarrioError.classList.remove("oculto");
  } finally {
    elBtnGuardarBarrio.disabled = false;
  }
});

// "Borrar lote": solo visible para un corredor logueado (corredorLogueado
// se actualiza en onAuthStateChanged, más abajo). Pide confirmación
// porque borrar un documento de Firestore no se puede deshacer. La usan
// tanto el botón de la ficha como el de cada fila de la vista en lista.
async function borrarLote(feature, elBoton) {
  const titulo = tituloLote(feature.properties);
  if (!window.confirm(`¿Borrar "${titulo}"? No se puede deshacer.`)) return;

  if (elBoton) elBoton.disabled = true;
  try {
    await deleteDoc(doc(db, COLECCION_LOTES, feature.id));
    elFicha.classList.add("oculto");
    await cargarLotesDesdeFirestore();
  } catch (error) {
    window.alert(
      error.code === "permission-denied"
        ? "No tenés permiso para borrar lotes. Iniciá sesión de nuevo."
        : "No se pudo borrar el lote."
    );
  } finally {
    if (elBoton) elBoton.disabled = false;
  }
}

const elBtnBorrarLote = document.getElementById("btn-borrar-lote");
elBtnBorrarLote.addEventListener("click", () => {
  if (!lotePolyLayerSeleccionado) return;
  borrarLote(lotePolyLayerSeleccionado, elBtnBorrarLote);
});

// ---------------------------------------------------------------------------
// Vista en lista/grilla: alternativa al mapa para revisar los lotes
// cargados (más cómoda que ir tocando polígonos chicos uno por uno,
// sobre todo para borrar). Reusa lotesActuales, ya en memoria desde la
// última carga — no le vuelve a pedir nada a Firestore.
// ---------------------------------------------------------------------------

const elBtnVerLista = document.getElementById("btn-ver-lista");
const elVistaLista = document.getElementById("vista-lista");
const elVistaListaVacio = document.getElementById("vista-lista-vacio");
const elVistaListaSinResultados = document.getElementById("vista-lista-sin-resultados");
const elTablaLotes = document.getElementById("tabla-lotes");
const elTablaLotesCuerpo = document.getElementById("tabla-lotes-cuerpo");
const elFiltroSector = document.getElementById("filtro-sector");
const elFiltroBarrio = document.getElementById("filtro-barrio");
const elFiltroEstado = document.getElementById("filtro-estado");

const elLoteVistaLista = document.getElementById("lote-vista-lista");
const elLoteVistaEditar = document.getElementById("lote-vista-editar");
const elLoteEditarTitulo = document.getElementById("lote-editar-titulo");
const elLoteEditarVolver = document.getElementById("lote-editar-volver");
const formularioEditarLote = document.getElementById("formulario-editar-lote");
const elEditarLoteManzana = document.getElementById("editar-lote-manzana");
const elEditarLoteNumero = document.getElementById("editar-lote-numero");
const elEditarLoteNomenclatura = document.getElementById("editar-lote-nomenclatura");
const elEditarLoteSuperficie = document.getElementById("editar-lote-superficie");
const elEditarLoteEstado = document.getElementById("editar-lote-estado");
const elEditarLotePrecio = document.getElementById("editar-lote-precio");
const elEditarLoteSector = document.getElementById("editar-lote-sector");
const elEditarLoteBarrio = document.getElementById("editar-lote-barrio");
const elEditarLoteServicioLuz = document.getElementById("editar-lote-servicio-luz");
const elEditarLoteServicioAgua = document.getElementById("editar-lote-servicio-agua");
const elEditarLoteServicioGas = document.getElementById("editar-lote-servicio-gas");
const elEditarLoteServicioCloaca = document.getElementById("editar-lote-servicio-cloaca");
const elEditarLoteObservaciones = document.getElementById("editar-lote-observaciones");
const elEditarLoteError = document.getElementById("editar-lote-error");
let loteEditandoDesdeGrilla = null; // feature actual del formulario de edición
// true si se entró a este formulario desde "Editar lote" en la ficha del
// mapa, false si se entró desde "Editar" en la grilla — al guardar,
// determina si hay que volver al mapa (con la ficha actualizada) o a la
// lista, para no sacar al corredor de donde ya estaba.
let loteEditadoDesdeFicha = false;

// El filtro se arma con lo que ya se cargó, no con el catálogo entero —
// no tiene sentido ofrecer para filtrar una zona que ningún lote tiene
// puesto todavía. Misma lógica para zona y barrio.
function actualizarOpcionesFiltroSector() {
  const seleccionPrevia = elFiltroSector.value;
  const sectores = [...new Set(lotesActuales.map((f) => f.properties.sector).filter(Boolean))].sort();
  elFiltroSector.innerHTML =
    '<option value="">Todas las zonas</option>' +
    sectores.map((s) => `<option value="${s}">${s}</option>`).join("");
  if (sectores.includes(seleccionPrevia)) elFiltroSector.value = seleccionPrevia;
}

function actualizarOpcionesFiltroBarrio() {
  const seleccionPrevia = elFiltroBarrio.value;
  const barrios = [...new Set(lotesActuales.map((f) => f.properties.barrio).filter(Boolean))].sort();
  elFiltroBarrio.innerHTML =
    '<option value="">Todos los barrios</option>' +
    barrios.map((b) => `<option value="${b}">${b}</option>`).join("");
  if (barrios.includes(seleccionPrevia)) elFiltroBarrio.value = seleccionPrevia;
}

function lotesFiltrados() {
  return lotesActuales.filter((feature) => {
    const p = feature.properties;
    if (elFiltroSector.value && p.sector !== elFiltroSector.value) return false;
    if (elFiltroBarrio.value && p.barrio !== elFiltroBarrio.value) return false;
    if (elFiltroEstado.value && p.estado !== elFiltroEstado.value) return false;
    return true;
  });
}

function actualizarVistaLista() {
  actualizarOpcionesFiltroSector();
  actualizarOpcionesFiltroBarrio();
  const lotes = lotesFiltrados();

  elTablaLotesCuerpo.innerHTML = "";
  elVistaListaVacio.classList.toggle("oculto", lotesActuales.length > 0);
  // Distinto de "no hay lotes cargados": acá SÍ hay lotes, pero ninguno
  // coincide con el sector/estado elegido — un mensaje genérico de
  // "vacío" hubiera hecho pensar que se perdió todo lo cargado.
  elVistaListaSinResultados.classList.toggle("oculto", lotesActuales.length === 0 || lotes.length > 0);
  elTablaLotes.classList.toggle("oculto", lotes.length === 0);

  lotes.forEach((feature) => {
    const p = feature.properties;
    const fila = document.createElement("tr");
    fila.className = "fila-lote";
    fila.dataset.loteId = feature.id; // permite ubicar una fila puntual (tests, debug)
    fila.innerHTML = `
      <td>${tituloLote(p)}</td>
      <td>${p.sector || "—"}</td>
      <td>${p.barrio || "—"}</td>
      <td>${p.superficie_m2 == null ? "—" : `${p.superficie_m2} m²`}</td>
      <td>${ETIQUETA_ESTADO[p.estado] || p.estado}</td>
      <td>${p.precio_usd == null ? "—" : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`}</td>
      <td>${p.servicios == null ? "—" : renderServiciosHTML(p.servicios)}</td>
      <td></td>
    `;

    // Tocar la fila lleva al mapa, centrado en ese lote, y abre su ficha.
    fila.addEventListener("click", () => {
      elVistaLista.classList.add("oculto");
      elBtnVerLista.classList.remove("activo");
      const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
      mapa.setView([lat, lon], 19);
      mostrarFicha(feature);
    });

    const celdaAcciones = fila.querySelector("td:last-child");

    if (puedeEditarLote(feature)) {
      const botonEditar = document.createElement("button");
      botonEditar.type = "button";
      botonEditar.className = "btn-editar-fila";
      botonEditar.textContent = "Editar";
      botonEditar.addEventListener("click", (evento) => {
        evento.stopPropagation(); // no abrir la ficha al tocar "Editar"
        loteEditadoDesdeFicha = false;
        mostrarEditarLoteDesdeGrilla(feature);
      });
      celdaAcciones.appendChild(botonEditar);
    }

    if (puedeBorrarLote(feature)) {
      const botonBorrar = document.createElement("button");
      botonBorrar.type = "button";
      botonBorrar.className = "btn-borrar-fila";
      botonBorrar.textContent = "Borrar";
      botonBorrar.addEventListener("click", (evento) => {
        evento.stopPropagation(); // no abrir la ficha al tocar "Borrar"
        borrarLote(feature, botonBorrar);
      });
      celdaAcciones.appendChild(botonBorrar);
    }

    elTablaLotesCuerpo.appendChild(fila);
  });
}

elFiltroSector.addEventListener("change", actualizarVistaLista);
elFiltroBarrio.addEventListener("change", actualizarVistaLista);
elFiltroEstado.addEventListener("change", actualizarVistaLista);

// Editar un lote directo desde la grilla (sin pasar por el mapa/ficha):
// pedido explícito, ya que la grilla es la herramienta de trabajo del
// corredor y no siempre tiene sentido ir hasta el mapa solo para
// cambiar el estado o el sector de un lote. Mismos campos editables que
// ya existían sueltos (servicios, sector) más estado/precio/
// observaciones, que hasta ahora solo se cargaban una vez al crearlo.
function mostrarListaLotesGrilla() {
  elLoteVistaEditar.classList.add("oculto");
  elLoteVistaLista.classList.remove("oculto");
  loteEditandoDesdeGrilla = null;
}

function mostrarEditarLoteDesdeGrilla(feature) {
  loteEditandoDesdeGrilla = feature;
  const p = feature.properties;
  elLoteEditarTitulo.textContent = `Editar ${tituloLote(p)}`;
  elEditarLoteManzana.value = p.manzana || "";
  elEditarLoteNumero.value = p.lote || "";
  elEditarLoteNomenclatura.value = p.nomenclatura || "";
  elEditarLoteSuperficie.value = p.superficie_m2 ?? "";
  elEditarLoteEstado.value = p.estado || "disponible";
  elEditarLotePrecio.value = p.precio_usd ?? "";
  poblarSelectSector(elEditarLoteSector, p.sector);
  poblarSelectBarrio(elEditarLoteBarrio, p.barrio);
  const s = p.servicios || {};
  elEditarLoteServicioLuz.checked = !!s.luz;
  elEditarLoteServicioAgua.checked = !!s.agua;
  elEditarLoteServicioGas.checked = !!s.gas;
  elEditarLoteServicioCloaca.checked = !!s.cloaca;
  elEditarLoteObservaciones.value = p.observaciones || "";
  elEditarLoteError.classList.add("oculto");

  elLoteVistaLista.classList.add("oculto");
  elLoteVistaEditar.classList.remove("oculto");
}

elLoteEditarVolver.addEventListener("click", mostrarListaLotesGrilla);

formularioEditarLote.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!loteEditandoDesdeGrilla) return;
  elEditarLoteError.classList.add("oculto");

  const boton = formularioEditarLote.querySelector('button[type="submit"]');
  boton.disabled = true;
  try {
    const nomenclatura = elEditarLoteNomenclatura.value.trim() || null;

    // Mismo chequeo que "Cargar a mano": si esta nomenclatura ya está en
    // OTRO lote, avisar en vez de dejar dos lotes con la misma. Se
    // excluye el propio lote de la búsqueda — si no cambió la
    // nomenclatura (el caso más común), no tiene que chocar consigo
    // mismo.
    if (nomenclatura) {
      const yaExiste = await getDocs(
        query(collection(db, COLECCION_LOTES), where("nomenclatura", "==", nomenclatura))
      );
      const loEstaUsandoOtroLote = yaExiste.docs.some((d) => d.id !== loteEditandoDesdeGrilla.id);
      if (loEstaUsandoOtroLote) {
        throw new Error(`Ya hay otro lote cargado con la nomenclatura ${nomenclatura}.`);
      }
    }

    const datos = {
      manzana: elEditarLoteManzana.value.trim() || null,
      lote: elEditarLoteNumero.value.trim() || null,
      nomenclatura,
      superficie_m2: elEditarLoteSuperficie.value.trim() === "" ? null : Number(elEditarLoteSuperficie.value),
      estado: elEditarLoteEstado.value,
      precio_usd: elEditarLotePrecio.value.trim() === "" ? null : Number(elEditarLotePrecio.value),
      sector: elEditarLoteSector.value.trim() || null,
      barrio: elEditarLoteBarrio.value.trim() || null,
      servicios: {
        luz: elEditarLoteServicioLuz.checked,
        agua: elEditarLoteServicioAgua.checked,
        gas: elEditarLoteServicioGas.checked,
        cloaca: elEditarLoteServicioCloaca.checked
      },
      observaciones: elEditarLoteObservaciones.value.trim() || null
    };

    await updateDoc(doc(db, COLECCION_LOTES, loteEditandoDesdeGrilla.id), datos);
    Object.assign(loteEditandoDesdeGrilla.properties, datos);

    if (loteEditadoDesdeFicha) {
      // Se entró desde "Editar lote" en el mapa: volver ahí (con la
      // ficha ya actualizada), no a la lista — el mapa nunca se tocó
      // durante la edición, así que sigue centrado en la misma zona de
      // antes sin hacer nada especial acá.
      const loteGuardado = loteEditandoDesdeGrilla;
      loteEditandoDesdeGrilla = null;
      elLoteVistaEditar.classList.add("oculto");
      elLoteVistaLista.classList.remove("oculto"); // deja la vista interna lista para la próxima vez que se entre por la grilla
      elVistaLista.classList.add("oculto");
      elBtnVerLista.classList.remove("activo");
      mostrarFicha(loteGuardado);
    } else {
      mostrarListaLotesGrilla();
    }

    await cargarLotesDesdeFirestore();
  } catch (error) {
    elEditarLoteError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para editar este lote."
        : error.message || "No se pudieron guardar los cambios.";
    elEditarLoteError.classList.remove("oculto");
  } finally {
    boton.disabled = false;
  }
});

elBtnVerLista.addEventListener("click", () => {
  const mostrar = elVistaLista.classList.contains("oculto");
  document.getElementById("panel-admin").classList.add("oculto"); // no superponer con "Seguridad"
  document.getElementById("panel-sectores").classList.add("oculto"); // ni con "Zonas"
  document.getElementById("panel-barrios").classList.add("oculto"); // ni con "Barrios"
  if (mostrar) mostrarListaLotesGrilla(); // siempre arranca en la lista, no en edición
  elVistaLista.classList.toggle("oculto", !mostrar);
  elBtnVerLista.classList.toggle("activo", mostrar);
});
document.getElementById("cerrar-vista-lista").addEventListener("click", () => {
  elVistaLista.classList.add("oculto");
  elBtnVerLista.classList.remove("activo");
});

// ---------------------------------------------------------------------------
// Botón "Cómo llegar": abre Google Maps marcando el centroide del lote.
// Se usa el endpoint de búsqueda (maps/search, no maps/dir): probado a mano,
// "dir" (navegación) puede resolver la coordenada al comercio indexado más
// cercano y mostrar ESE nombre como destino (p. ej. un lote vacío terminó
// etiquetado como un taller de chapa y pintura a varios metros de ahí).
// "search" en cambio deja el pin exactamente en la coordenada que mandamos,
// sin sustituirlo por otro lugar. No admite una etiqueta con el nombre del
// lote (se probó el viejo truco de "lat,lon(Texto)" y ya no funciona, Google
// Maps directamente no encuentra la ubicación) — muestra coordenadas o el
// Plus Code, no el texto del lote. Tampoco calcula una ruta: es responsabilidad
// del corredor iniciar la navegación una vez que confirma visualmente el pin.
// ---------------------------------------------------------------------------

function construirUrlComoLlegar(feature) {
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

document.getElementById("btn-como-llegar").addEventListener("click", () => {
  if (!lotePolyLayerSeleccionado) return;
  const url = construirUrlComoLlegar(lotePolyLayerSeleccionado);
  window.open(url, "_blank", "noopener");
});

// ---------------------------------------------------------------------------
// Modo "Estoy yendo": geolocalización en vivo + flecha tipo brújula.
// ---------------------------------------------------------------------------

const elPanelNav = document.getElementById("panel-navegacion");
const elFlecha = document.getElementById("brujula-flecha");
const elNavMensaje = document.getElementById("nav-mensaje");

let rumboHaciaLote = 0;
let rumboDispositivo = null; // null = sin brújula del dispositivo disponible

function actualizarFlecha() {
  // Si hay brújula del dispositivo, la flecha apunta al lote en relación a
  // hacia dónde está mirando el teléfono. Si no, apunta al rumbo absoluto
  // (asumiendo el teléfono "hacia arriba" = norte).
  const rotacion = rumboDispositivo === null ? rumboHaciaLote : rumboHaciaLote - rumboDispositivo;
  elFlecha.style.transform = `rotate(${rotacion}deg)`;
}

function manejarPosicion(posicion) {
  if (!lotePolyLayerSeleccionado) return;
  const { latitude: latUsuario, longitude: lonUsuario } = posicion.coords;
  const anillo = lotePolyLayerSeleccionado.geometry.coordinates[0];

  if (puntoDentroDePoligono(latUsuario, lonUsuario, anillo)) {
    elNavMensaje.textContent = "Estás dentro del lote.";
    elFlecha.style.transform = "rotate(0deg)";
    return;
  }

  const { lat: latLote, lon: lonLote } = centroideDePoligono(anillo);
  const distancia = distanciaMetros(latUsuario, lonUsuario, latLote, lonLote);
  rumboHaciaLote = rumboInicial(latUsuario, lonUsuario, latLote, lonLote);

  elNavMensaje.textContent = `${Math.round(distancia)} m hasta el lote`;
  actualizarFlecha();
}

function manejarErrorGeolocalizacion(error) {
  if (error.code === error.PERMISSION_DENIED) {
    elNavMensaje.textContent =
      "No pudimos acceder a tu ubicación. Habilitá el permiso de ubicación del navegador e intentá de nuevo.";
  } else {
    elNavMensaje.textContent = "No se pudo obtener tu ubicación en este momento.";
  }
}

function manejarOrientacion(evento) {
  // iOS Safari expone el rumbo real (grados desde el norte) en webkitCompassHeading.
  // El resto de los navegadores da "alpha", que crece en sentido antihorario desde
  // el eje del dispositivo: 360 - alpha lo aproxima a un rumbo brújula estándar
  // cuando el evento es "absolute" (referenciado al mundo, no al estado inicial).
  if (typeof evento.webkitCompassHeading === "number") {
    rumboDispositivo = evento.webkitCompassHeading;
  } else if (evento.absolute && evento.alpha !== null) {
    rumboDispositivo = (360 - evento.alpha) % 360;
  } else {
    return;
  }
  actualizarFlecha();
}

function iniciarBrujulaDispositivo() {
  const EventoOrientacion = window.DeviceOrientationEvent;
  if (!EventoOrientacion) return;

  listenerOrientacion = manejarOrientacion;

  if (typeof EventoOrientacion.requestPermission === "function") {
    // iOS 13+: pedir permiso explícito, solo se puede llamar desde un gesto del usuario.
    EventoOrientacion.requestPermission()
      .then((estado) => {
        if (estado === "granted") {
          window.addEventListener("deviceorientation", listenerOrientacion);
        }
      })
      .catch(() => {
        // Sin brújula del dispositivo: la flecha sigue funcionando con rumbo absoluto.
      });
  } else {
    window.addEventListener("deviceorientationabsolute", listenerOrientacion);
    window.addEventListener("deviceorientation", listenerOrientacion);
  }
}

function iniciarModoEstoyYendo() {
  if (!lotePolyLayerSeleccionado) return;

  elPanelNav.classList.remove("oculto");
  elNavMensaje.textContent = "Buscando tu ubicación…";
  rumboDispositivo = null;

  if (!navigator.geolocation) {
    elNavMensaje.textContent = "Este navegador no soporta geolocalización.";
    return;
  }

  watchId = navigator.geolocation.watchPosition(manejarPosicion, manejarErrorGeolocalizacion, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 10000
  });

  iniciarBrujulaDispositivo();
}

function detenerModoEstoyYendo() {
  elPanelNav.classList.add("oculto");
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (listenerOrientacion) {
    window.removeEventListener("deviceorientation", listenerOrientacion);
    window.removeEventListener("deviceorientationabsolute", listenerOrientacion);
    listenerOrientacion = null;
  }
}

document.getElementById("btn-estoy-yendo").addEventListener("click", iniciarModoEstoyYendo);
document.getElementById("cerrar-navegacion").addEventListener("click", detenerModoEstoyYendo);

// ---------------------------------------------------------------------------
// Sesión del corredor (Firebase Auth): lectura de lotes es pública, cargar
// uno nuevo requiere estar logueado (ver firestore.rules).
// ---------------------------------------------------------------------------

const elBtnAbrirLogin = document.getElementById("btn-abrir-login");
const elSesionActiva = document.getElementById("sesion-activa");
const elSesionEmail = document.getElementById("sesion-email");
const elBtnCargarLote = document.getElementById("btn-cargar-lote");
const elBtnSalir = document.getElementById("btn-salir");

const elFormLogin = document.getElementById("form-login");
const formularioLogin = document.getElementById("formulario-login");
const elLoginEmail = document.getElementById("login-email");
const elLoginPassword = document.getElementById("login-password");
const elLoginError = document.getElementById("login-error");

elBtnAbrirLogin.addEventListener("click", () => abrirHoja(elFormLogin));
document.getElementById("cerrar-login").addEventListener("click", () => elFormLogin.classList.add("oculto"));

formularioLogin.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elLoginError.classList.add("oculto");
  try {
    await signInWithEmailAndPassword(auth, elLoginEmail.value.trim(), elLoginPassword.value);
    formularioLogin.reset();
    elFormLogin.classList.add("oculto");
  } catch (error) {
    elLoginError.textContent = "Email o contraseña incorrectos.";
    elLoginError.classList.remove("oculto");
  }
});

elBtnSalir.addEventListener("click", () => signOut(auth));

// Resuelve el perfil de seguridad del usuario logueado: lee su doc en
// "usuarios" para saber qué perfil tiene asignado, y ese perfil en
// "perfiles" para saber qué puede hacer. Si cualquiera de los dos pasos
// falla (cuenta sin perfil asignado todavía, o borrado a mano) se trata
// como sin permisos — nunca como root ni con acceso de más.
async function resolverMiPerfil(usuario) {
  try {
    const docUsuario = await getDoc(doc(db, "usuarios", usuario.uid));
    const perfilId = docUsuario.exists() ? docUsuario.data().perfil_id : null;
    if (!perfilId) return null;
    const docPerfil = await getDoc(doc(db, "perfiles", perfilId));
    return docPerfil.exists() ? docPerfil.data() : null;
  } catch {
    return null;
  }
}

// Muestra/oculta los botones que dependen de un permiso puntual (no de
// "estar logueado" nomás). Se llama después de resolver miPerfilActual,
// y de nuevo si root reasigna el perfil de alguien desde "Administrar".
function actualizarUIPorPermisos() {
  elBtnAbrirManzana.classList.toggle("oculto", !tienePermiso("cargar_lote"));
  elBtnAbrirParcela.classList.toggle("oculto", !tienePermiso("cargar_lote"));
  elBtnCargarLote.classList.toggle("oculto", !tienePermiso("cargar_lote"));
  document.getElementById("drawer-grupo-seguridad").classList.toggle("oculto", !tienePermiso("administrar_usuarios"));
  // Sectores es un permiso propio, distinto de "administrar_usuarios": un
  // corredor puede organizar su propia cartera en zonas sin depender de
  // root, y root puede sacarle ese permiso puntual sin tocarle el resto.
  // Mismo criterio en firestore.rules.
  document.getElementById("drawer-grupo-sectores").classList.toggle("oculto", !tienePermiso("administrar_sectores"));
}

onAuthStateChanged(auth, async (usuario) => {
  corredorLogueado = !!usuario;
  miPerfilActual = usuario ? await resolverMiPerfil(usuario) : null;

  if (usuario) {
    elBtnAbrirLogin.classList.add("oculto");
    elSesionActiva.classList.remove("oculto");
    document.getElementById("drawer-sesion-activa").classList.remove("oculto");
    elSesionEmail.textContent = usuario.email;
    actualizarUIPorPermisos();
    // El catálogo de zonas/barrios necesita sesión para leerse (ver
    // firestore.rules), así que se carga acá y no al arrancar la app.
    await cargarSectores();
    await cargarBarrios();
    poblarSelectSector(elLoteSector, elLoteSector.value);
    poblarSelectBarrio(elLoteBarrio, elLoteBarrio.value);
  } else {
    elBtnAbrirLogin.classList.remove("oculto");
    elSesionActiva.classList.add("oculto");
    document.getElementById("drawer-sesion-activa").classList.add("oculto");
    sectoresActuales = [];
    barriosActuales = [];
    // Cerrar sesión apaga todas las herramientas de corredor, no solo
    // "+ Lote": sin esto, si alguien cerraba sesión con "Ver catastro
    // cercano" prendido (o cualquier otro panel abierto), el botón para
    // apagarlo desaparecía junto con el resto de la barra, pero la capa
    // seguía activa y pidiéndole datos al catastro en cada movimiento del
    // mapa, visible para cualquiera que mirara la app después.
    window.dispatchEvent(new Event("mojonapp:sesion-cerrada"));
  }

  // Si la ficha de un lote está abierta al cambiar de sesión (login,
  // logout, o root reasignando el perfil de alguien), "Borrar lote" y
  // "Editar servicios"/"Editar sector" tienen que reflejar el permiso
  // nuevo sin esperar a que se cierre y se vuelva a abrir.
  if (lotePolyLayerSeleccionado) {
    document.getElementById("btn-borrar-lote").classList.toggle("oculto", !puedeBorrarLote(lotePolyLayerSeleccionado));
    document.getElementById("btn-editar-lote-completo").classList.toggle("oculto", !puedeEditarLote(lotePolyLayerSeleccionado));
    cerrarEditorServicios();
    cerrarEditorSector();
    cerrarEditorBarrio();
  }

  // El alcance de la consulta a Firestore depende del permiso
  // "ver_todos_los_lotes" (ver cargarLotesDesdeFirestore): tiene que
  // volver a pedirse cada vez que cambia quién está logueado, no solo al
  // arrancar la app.
  cargarLotesDesdeFirestore();
});

// ---------------------------------------------------------------------------
// Formulario "Cargar lote" (solo corredores logueados).
// ---------------------------------------------------------------------------

const elFormLote = document.getElementById("form-lote");
const formularioLote = document.getElementById("formulario-lote");
const elLoteManzana = document.getElementById("lote-manzana");
const elLoteNumero = document.getElementById("lote-numero");
const elLoteNomenclatura = document.getElementById("lote-nomenclatura");
const elLoteSector = document.getElementById("lote-sector");
const elLoteBarrio = document.getElementById("lote-barrio");
const elLoteSuperficie = document.getElementById("lote-superficie");
const elLoteEstado = document.getElementById("lote-estado");
const elLotePrecio = document.getElementById("lote-precio");
const elLoteServicioLuz = document.getElementById("lote-servicio-luz");
const elLoteServicioAgua = document.getElementById("lote-servicio-agua");
const elLoteServicioGas = document.getElementById("lote-servicio-gas");
const elLoteServicioCloaca = document.getElementById("lote-servicio-cloaca");
const elLoteObservaciones = document.getElementById("lote-observaciones");
const elLoteVertices = document.getElementById("lote-vertices");
const elLoteAreaCalculada = document.getElementById("lote-area-calculada");
const elLoteError = document.getElementById("lote-error");

// El formulario se resetea tanto al abrirlo desde cero como al cerrarlo
// sin guardar: si no, quedan pegados los datos de una carga anterior (por
// ejemplo, de una parcela traída del catastro que no se llegó a guardar)
// y podrían mezclarse con la próxima carga sin que el corredor lo note.
function limpiarFormLote() {
  formularioLote.reset();
  elLoteAreaCalculada.textContent = "";
  elLoteError.classList.add("oculto");
}

elBtnCargarLote.addEventListener("click", () => {
  limpiarFormLote();
  poblarSelectSector(elLoteSector, null);
  poblarSelectBarrio(elLoteBarrio, null);
  abrirHoja(elFormLote);
});
document.getElementById("cerrar-form-lote").addEventListener("click", () => {
  elFormLote.classList.add("oculto");
  limpiarFormLote();
});
window.addEventListener("mojonapp:sesion-cerrada", () => {
  elFormLote.classList.add("oculto");
  limpiarFormLote();
});

// Cada línea es "latitud,longitud" tal cual la copia el corredor del visor
// de catastro (así lo muestra ese sitio) — se invierte a [lon, lat], que es
// el orden que usa GeoJSON, y se cierra el anillo si hace falta.
function parsearVertices(texto) {
  const lineas = texto
    .split("\n")
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0);

  if (lineas.length < 3) {
    throw new Error("Hacen falta al menos 3 vértices.");
  }

  const puntos = lineas.map((linea, indice) => {
    const partes = linea.split(",").map((numero) => Number(numero.trim()));
    if (partes.length !== 2 || partes.some(Number.isNaN)) {
      throw new Error(`El vértice de la línea ${indice + 1} no tiene el formato "latitud,longitud".`);
    }
    const [lat, lon] = partes;
    return [lon, lat];
  });

  const [primerLon, primerLat] = puntos[0];
  const [ultimoLon, ultimoLat] = puntos[puntos.length - 1];
  if (primerLon !== ultimoLon || primerLat !== ultimoLat) {
    puntos.push([primerLon, primerLat]);
  }

  return puntos;
}

function actualizarAreaCalculada() {
  elLoteAreaCalculada.classList.remove("area-advertencia");
  try {
    const vertices = parsearVertices(elLoteVertices.value);
    const area = areaEnM2(vertices);
    const superficieDeclarada = Number(elLoteSuperficie.value);

    let mensaje = `Área calculada a partir de los vértices: ${area.toFixed(1)} m²`;
    if (superficieDeclarada > 0) {
      const errorRelativo = Math.abs(area - superficieDeclarada) / superficieDeclarada;
      if (errorRelativo > 0.05) {
        mensaje += ` — se aleja bastante de los ${superficieDeclarada} m² declarados. Revisá el orden de los vértices.`;
        elLoteAreaCalculada.classList.add("area-advertencia");
      }
    }
    elLoteAreaCalculada.textContent = mensaje;
  } catch (error) {
    elLoteAreaCalculada.textContent = "";
  }
}

elLoteVertices.addEventListener("input", actualizarAreaCalculada);
elLoteSuperficie.addEventListener("input", actualizarAreaCalculada);

formularioLote.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elLoteError.classList.add("oculto");

  try {
    const nomenclatura = elLoteNomenclatura.value.trim() || null;

    // Mismo chequeo que ya hace la importación de "+ Manzana": si esta
    // nomenclatura ya está cargada, avisar en vez de duplicar el lote.
    // "+ Parcela" y "Ver catastro cercano" precargan este formulario, así
    // que sin este chequeo alcanzaba con tocar la misma parcela dos veces
    // para terminar con dos lotes iguales en el mapa.
    if (nomenclatura) {
      const yaExiste = await getDocs(
        query(collection(db, COLECCION_LOTES), where("nomenclatura", "==", nomenclatura))
      );
      if (!yaExiste.empty) {
        throw new Error(`Ya hay un lote cargado con la nomenclatura ${nomenclatura}.`);
      }
    }

    const vertices = parsearVertices(elLoteVertices.value);
    await addDoc(collection(db, COLECCION_LOTES), {
      creado_por: auth.currentUser.uid,
      manzana: elLoteManzana.value.trim() || null,
      lote: elLoteNumero.value.trim() || null,
      nomenclatura,
      sector: elLoteSector.value.trim() || null,
      barrio: elLoteBarrio.value.trim() || null,
      superficie_m2: Number(elLoteSuperficie.value),
      estado: elLoteEstado.value,
      precio_usd: elLotePrecio.value.trim() === "" ? null : Number(elLotePrecio.value),
      servicios: {
        luz: elLoteServicioLuz.checked,
        agua: elLoteServicioAgua.checked,
        gas: elLoteServicioGas.checked,
        cloaca: elLoteServicioCloaca.checked
      },
      observaciones: elLoteObservaciones.value.trim() || null,
      geometry: anilloAGeometryFirestore(vertices)
    });

    limpiarFormLote();
    elFormLote.classList.add("oculto");
    await cargarLotesDesdeFirestore();
  } catch (error) {
    elLoteError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para cargar lotes. Iniciá sesión de nuevo."
        : error.message || "No se pudo guardar el lote.";
    elLoteError.classList.remove("oculto");
  }
});

// ---------------------------------------------------------------------------
// "Traer manzana del catastro": busca una manzana por número dentro del
// área visible del mapa (WFS público de catastro) y trae todas las
// parcelas que la componen, para importarlas de una sola vez en vez de
// cargar lote por lote.
// ---------------------------------------------------------------------------

const elBtnAbrirManzana = document.getElementById("btn-abrir-manzana");
const elFormManzana = document.getElementById("form-manzana");
const formularioManzana = document.getElementById("formulario-manzana");
const elManzanaNumero = document.getElementById("manzana-numero");
const elManzanaResultado = document.getElementById("manzana-resultado");
const elManzanaConfirmar = document.getElementById("manzana-confirmar");
const elManzanaError = document.getElementById("manzana-error");

let parcelasEncontradas = []; // resultado de la última búsqueda, pendiente de confirmar

// Si se cierra sin importar, hay que limpiar la búsqueda anterior: si no,
// al reabrir queda visible el botón "Importar estos lotes" todavía
// apuntando a una búsqueda vieja (de otra manzana), y tocarlo importaría
// esos lotes por error.
function limpiarFormManzana() {
  parcelasEncontradas = [];
  elManzanaResultado.innerHTML = "";
  elManzanaConfirmar.classList.add("oculto");
  elManzanaError.classList.add("oculto");
}

elBtnAbrirManzana.addEventListener("click", () => abrirHoja(elFormManzana));
document.getElementById("cerrar-form-manzana").addEventListener("click", () => {
  elFormManzana.classList.add("oculto");
  limpiarFormManzana();
});
window.addEventListener("mojonapp:sesion-cerrada", () => {
  elFormManzana.classList.add("oculto");
  limpiarFormManzana();
});

function bboxDelMapaVisible() {
  const b = mapa.getBounds();
  return `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
}

async function pedirWfs(params) {
  const url = `${CATASTRO_WFS_URL}?${new URLSearchParams(params).toString()}`;
  const respuesta = await fetch(url);
  if (!respuesta.ok) {
    throw new Error("El catastro no respondió. Probá de nuevo en un momento.");
  }
  const datos = await respuesta.json();
  if (!datos.features) {
    throw new Error("El catastro devolvió una respuesta inesperada.");
  }
  return datos.features;
}

// El número de manzana NO es único en toda la provincia (hay una "manzana
// 104" en cada pueblo), así que la búsqueda se acota al área visible del
// mapa además del número — si no encuadra la manzana correcta antes de
// buscar, puede no encontrarla o encontrar la de otro lado.
async function buscarManzana(numero) {
  const cql = `ETIQUETA='${numero}' AND BBOX(GEOM,${bboxDelMapaVisible()},'EPSG:4326')`;
  const features = await pedirWfs({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeName: "SanLuis:GIS_MANZANAS_VV",
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    CQL_FILTER: cql
  });
  return features[0] || null;
}

// El campo NOMBRE de una manzana trae, entre otras cosas, su nomenclatura
// catastral: " Manzana: 104 \n Nomenclatura Manzana:00-06-44-05-000104".
// La nomenclatura de cada parcela empieza exactamente con la de su
// manzana ("00-06-44-05-000104-000001"), así que sirve para filtrar con
// precisión — mejor que quedarse con todo lo que cae dentro de un
// rectángulo, que trae parcelas de la manzana vecina también.
function nomenclaturaDeManzana(nombre) {
  const coincidencia = /Nomenclatura Manzana:\s*([\d-]+)/i.exec(nombre || "");
  return coincidencia ? coincidencia[1] : null;
}

// Este GeoServer no admite indicarle el sistema de coordenadas de un
// polígono dentro de INTERSECTS() (se probó "SRID=4326;POLYGON(...)" y
// tira error de sintaxis), así que en vez de intersectar la forma exacta
// de la manzana se pide todo lo que cae en su rectángulo envolvente (con
// BBOX(), que sí admite el sistema de coordenadas) y se filtra por
// nomenclatura después, del lado del cliente.
async function buscarParcelasDeManzana(manzanaFeature) {
  const anillo = manzanaFeature.geometry.coordinates[0];
  const lons = anillo.map((p) => p[0]);
  const lats = anillo.map((p) => p[1]);
  const bbox = `${Math.min(...lons)},${Math.min(...lats)},${Math.max(...lons)},${Math.max(...lats)}`;

  const candidatas = (
    await pedirWfs({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: "SanLuis:GIS_PARCELAS_VV",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      CQL_FILTER: `BBOX(GEOM,${bbox},'EPSG:4326')`
    })
  ).filter((feature) => !esParcelaDeCalle(feature.properties.NOMBRE));

  const nomenclaturaManzana = nomenclaturaDeManzana(manzanaFeature.properties.NOMBRE);
  if (!nomenclaturaManzana) return candidatas;

  return candidatas.filter((feature) =>
    (feature.properties.CATNMC_CAT || "").startsWith(`${nomenclaturaManzana}-`)
  );
}

// El campo NOMBRE del catastro trae todo junto en texto libre, por ejemplo:
// "Parcela: 2569 \n Nom.Catastral: 00-06-... \n Sup. Terreno: 3024.04 m2 \n
//  Tipo Parcela: URBANA \n Plano Mensura: 06-56-2015". Se extrae la
// superficie con una expresión regular; si el formato cambia y no
// coincide, se deja en null en vez de romper la importación.
function superficieDesdeNombreCatastro(nombre) {
  const coincidencia = /Sup\.\s*Terreno:\s*([\d.,]+)\s*m2/i.exec(nombre || "");
  return coincidencia ? Number(coincidencia[1].replace(",", ".")) : null;
}

// El mismo campo trae el "Tipo Parcela" (URBANA, RURAL, SUB, PROPIEDAD
// HORIZONTAL, CALLE...). Las de tipo CALLE son calles/caminos registrados
// como parcela en el catastro (se confirmó con un caso real: 399
// vértices, ~28.300 m², "Tipo Parcela: CALLE") — no son lotes que un
// corredor pueda cargar, así que se descartan en todas las búsquedas.
function esParcelaDeCalle(nombre) {
  return /Tipo Parcela:\s*CALLE/i.test(nombre || "");
}

formularioManzana.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elManzanaError.classList.add("oculto");
  elManzanaConfirmar.classList.add("oculto");
  elManzanaResultado.textContent = "Buscando…";
  parcelasEncontradas = [];

  try {
    const manzana = await buscarManzana(elManzanaNumero.value.trim());
    if (!manzana) {
      throw new Error(
        "No se encontró esa manzana en el área visible del mapa. Acercate o alejate hasta encuadrarla y probá de nuevo."
      );
    }

    const parcelas = await buscarParcelasDeManzana(manzana);
    if (parcelas.length === 0) {
      throw new Error("La manzana se encontró pero no tiene parcelas cargadas en el catastro.");
    }

    parcelasEncontradas = parcelas.map((feature) => ({
      lote: feature.properties.ETIQUETA || null,
      nomenclatura: feature.properties.CATNMC_CAT || null,
      superficie_m2: superficieDesdeNombreCatastro(feature.properties.NOMBRE),
      anillo: feature.geometry.coordinates[0]
    }));

    elManzanaResultado.innerHTML = `
      <p>Se encontraron ${parcelasEncontradas.length} parcelas en la manzana ${manzana.properties.ETIQUETA}:</p>
      <ul>${parcelasEncontradas
        .map((p) => `<li>Lote ${p.lote || "sin número"}${p.superficie_m2 ? ` — ${p.superficie_m2} m²` : ""}</li>`)
        .join("")}</ul>
    `;
    elManzanaConfirmar.dataset.manzana = manzana.properties.ETIQUETA;
    elManzanaConfirmar.classList.remove("oculto");
  } catch (error) {
    elManzanaResultado.textContent = "";
    elManzanaError.textContent = error.message || "No se pudo buscar la manzana.";
    elManzanaError.classList.remove("oculto");
  }
});

elManzanaConfirmar.addEventListener("click", async () => {
  elManzanaError.classList.add("oculto");
  elManzanaConfirmar.disabled = true;
  const numeroManzana = elManzanaConfirmar.dataset.manzana;

  try {
    let importados = 0;
    let omitidos = 0;

    for (const parcela of parcelasEncontradas) {
      // Evita duplicar si esta parcela ya se había importado antes (misma
      // nomenclatura catastral).
      if (parcela.nomenclatura) {
        const yaExiste = await getDocs(
          query(collection(db, COLECCION_LOTES), where("nomenclatura", "==", parcela.nomenclatura))
        );
        if (!yaExiste.empty) {
          omitidos++;
          continue;
        }
      }

      await addDoc(collection(db, COLECCION_LOTES), {
        creado_por: auth.currentUser.uid,
        manzana: numeroManzana,
        lote: parcela.lote,
        nomenclatura: parcela.nomenclatura,
        superficie_m2: parcela.superficie_m2,
        estado: "disponible",
        precio_usd: null,
        observaciones: "Importado automáticamente del catastro de San Luis.",
        geometry: anilloAGeometryFirestore(parcela.anillo)
      });
      importados++;
    }

    elManzanaResultado.textContent =
      omitidos > 0
        ? `Se importaron ${importados} lotes nuevos (${omitidos} ya existían y se omitieron).`
        : `Se importaron ${importados} lotes.`;
    elManzanaConfirmar.classList.add("oculto");
    await cargarLotesDesdeFirestore();
  } catch (error) {
    elManzanaError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para cargar lotes. Iniciá sesión de nuevo."
        : error.message || "No se pudieron importar los lotes.";
    elManzanaError.classList.remove("oculto");
  } finally {
    elManzanaConfirmar.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// "Traer parcela del catastro": busca una parcela individual por número,
// sin pasar por la manzana. Existe porque en varias zonas (justo las que
// le interesan a esta app) el catastro tiene la parcela cargada pero no
// el contorno de la manzana que la contiene, así que "+ Manzana" no
// encuentra nada ahí — se confirmó con el lote real de Carpintería.
// ---------------------------------------------------------------------------

const elBtnAbrirParcela = document.getElementById("btn-abrir-parcela");
const elFormParcela = document.getElementById("form-parcela");
const formularioParcela = document.getElementById("formulario-parcela");
const elParcelaNumero = document.getElementById("parcela-numero");
const elParcelaResultado = document.getElementById("parcela-resultado");
const elParcelaError = document.getElementById("parcela-error");

elBtnAbrirParcela.addEventListener("click", () => abrirHoja(elFormParcela));

// La nomenclatura de una parcela es la de su manzana más "-parcela"
// (ver nomenclaturaDeManzana más arriba): "00-06-43-03-000022-000020" es
// la parcela 20 de la manzana 22. El anteúltimo segmento es el número de
// manzana con ceros a la izquierda.
function manzanaDesdeNomenclaturaDeParcela(nomenclatura) {
  const partes = (nomenclatura || "").split("-");
  if (partes.length < 2) return null;
  const numero = parseInt(partes[partes.length - 2], 10);
  return Number.isNaN(numero) ? null : String(numero);
}

// Al elegir una parcela encontrada, se precarga en el formulario "+ Lote"
// de siempre (en vez de guardarla directo) para que el corredor pueda
// revisar o completar estado/precio/observaciones antes de guardar — y
// para reusar ese único camino de guardado, ya probado.
function cargarParcelaEnFormLote(feature) {
  const nomenclatura = feature.properties.CATNMC_CAT || "";
  const anillo = feature.geometry.coordinates[0];

  elLoteManzana.value = manzanaDesdeNomenclaturaDeParcela(nomenclatura) || "";
  elLoteNumero.value = feature.properties.ETIQUETA || "";
  elLoteNomenclatura.value = nomenclatura;
  poblarSelectSector(elLoteSector, null);
  poblarSelectBarrio(elLoteBarrio, null);
  elLoteSuperficie.value = superficieDesdeNombreCatastro(feature.properties.NOMBRE) ?? "";
  elLoteEstado.value = "disponible";
  elLotePrecio.value = "";
  elLoteObservaciones.value = "Importado del catastro de San Luis (parcela individual).";
  elLoteVertices.value = anillo.map(([lon, lat]) => `${lat},${lon}`).join("\n");
  elLoteVertices.dispatchEvent(new Event("input"));
  abrirHoja(elFormLote);
}

// Las candidatas de "+ Parcela" se resaltan en el mapa (no solo listadas
// como texto), para que el corredor vea de entrada dónde está cada una
// antes de elegir — importa porque el número de parcela se repite en
// varias manzanas dentro de la misma vista.
let capaResaltadoParcelas = null;

function limpiarResaltadoParcelas() {
  if (capaResaltadoParcelas) {
    mapa.removeLayer(capaResaltadoParcelas);
    capaResaltadoParcelas = null;
  }
}

function resaltarCandidatasEnMapa(candidatas) {
  limpiarResaltadoParcelas();
  capaResaltadoParcelas = L.geoJSON(
    { type: "FeatureCollection", features: candidatas },
    {
      style: { color: "#00e5ff", weight: 4, fillColor: "#00e5ff", fillOpacity: 0.25 },
      // Tocar el polígono resaltado en el mapa carga esa parcela, igual
      // que el botón "Cargar este lote" de la lista — antes solo
      // funcionaba el botón, el resaltado era puramente visual.
      onEachFeature: (feature, layer) => {
        layer.on("click", (evento) => {
          // Mismo cuidado que en la capa de lotes cargados: no pisar una
          // captura de vértices en curso (ver el comentario en
          // cargarLotesDesdeFirestore).
          if (modoCaptura !== null) return;
          L.DomEvent.stopPropagation(evento);
          limpiarResaltadoParcelas();
          cargarParcelaEnFormLote(feature);
        });
      }
    }
  ).addTo(mapa);
}

// Si se cierra sin cargar ninguna, se limpia la lista y el resaltado del
// mapa: si no, al reabrir queda una búsqueda vieja dando vueltas.
document.getElementById("cerrar-form-parcela").addEventListener("click", () => {
  elFormParcela.classList.add("oculto");
  limpiarResaltadoParcelas();
  elParcelaResultado.innerHTML = "";
  elParcelaError.classList.add("oculto");
});
window.addEventListener("mojonapp:sesion-cerrada", () => {
  elFormParcela.classList.add("oculto");
  limpiarResaltadoParcelas();
  elParcelaResultado.innerHTML = "";
  elParcelaError.classList.add("oculto");
});

formularioParcela.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elParcelaError.classList.add("oculto");
  elParcelaResultado.innerHTML = "Buscando…";
  limpiarResaltadoParcelas();

  try {
    const numero = elParcelaNumero.value.trim();
    const candidatas = (
      await pedirWfs({
        service: "WFS",
        version: "2.0.0",
        request: "GetFeature",
        typeName: "SanLuis:GIS_PARCELAS_VV",
        outputFormat: "application/json",
        srsName: "EPSG:4326",
        CQL_FILTER: `ETIQUETA='${numero}' AND BBOX(GEOM,${bboxDelMapaVisible()},'EPSG:4326')`
      })
    ).filter((feature) => !esParcelaDeCalle(feature.properties.NOMBRE));

    if (candidatas.length === 0) {
      elParcelaResultado.innerHTML = "";
      throw new Error(
        "No se encontró esa parcela en el área visible del mapa. Acercate o alejate hasta encuadrarla y probá de nuevo."
      );
    }

    resaltarCandidatasEnMapa(candidatas);

    // El número de parcela tampoco es único (puede haber una "20" en cada
    // manzana visible), así que se muestran todas las que caen en el área
    // para que el corredor elija la correcta por su nomenclatura/superficie.
    elParcelaResultado.innerHTML = "";
    candidatas.forEach((feature, indice) => {
      const superficie = superficieDesdeNombreCatastro(feature.properties.NOMBRE);
      const nomenclatura = feature.properties.CATNMC_CAT || "(sin nomenclatura)";
      const fila = document.createElement("div");
      fila.className = "parcela-candidata";
      fila.innerHTML = `
        <p>${nomenclatura}${superficie ? ` — ${superficie} m²` : ""}</p>
        <button type="button" data-testid="parcela-cargar-${indice}">Cargar este lote</button>
      `;
      fila.querySelector("button").addEventListener("click", () => {
        limpiarResaltadoParcelas();
        cargarParcelaEnFormLote(feature);
      });
      elParcelaResultado.appendChild(fila);
    });
  } catch (error) {
    elParcelaError.textContent = error.message || "No se pudo buscar la parcela.";
    elParcelaError.classList.remove("oculto");
  }
});

// ---------------------------------------------------------------------------
// "Ver catastro cercano": en vez de escribir un número de manzana o
// parcela a ciegas, muestra las parcelas oficiales alrededor (con su
// número, como en el visor del catastro) para tocar directo la que se
// quiere cargar. Usa el mismo WFS que "+ Manzana" / "+ Parcela" — esos
// dos siguen sirviendo para importar varios lotes de una sin ir tocando
// el mapa uno por uno.
// ---------------------------------------------------------------------------

const elBtnVerCatastroCercano = document.getElementById("btn-ver-catastro-cercano");
const elCatastroCercanoMensaje = document.getElementById("catastro-cercano-mensaje");
const elBtnFlotanteCatastro = document.getElementById("btn-flotante-catastro");
const ZOOM_MINIMO_CATASTRO_CERCANO = 16; // por debajo de esto el WFS traería demasiadas parcelas

let capaCatastroCercano = null;
let catastroCercanoActivo = false;

function estiloParcelaCatastroCercano() {
  return { color: "#f9a825", weight: 2, dashArray: "4 3", fillOpacity: 0.05 };
}

function mostrarMensajeCatastroCercano(texto) {
  elCatastroCercanoMensaje.textContent = texto;
  elCatastroCercanoMensaje.classList.remove("oculto");
}

function ocultarMensajeCatastroCercano() {
  elCatastroCercanoMensaje.classList.add("oculto");
}

async function actualizarCatastroCercano() {
  if (!catastroCercanoActivo) return;

  if (mapa.getZoom() < ZOOM_MINIMO_CATASTRO_CERCANO) {
    if (capaCatastroCercano) {
      mapa.removeLayer(capaCatastroCercano);
      capaCatastroCercano = null;
    }
    mostrarMensajeCatastroCercano("Acercate más en el mapa para ver las parcelas cercanas.");
    return;
  }

  let features;
  try {
    features = (
      await pedirWfs({
        service: "WFS",
        version: "2.0.0",
        request: "GetFeature",
        typeName: "SanLuis:GIS_PARCELAS_VV",
        outputFormat: "application/json",
        srsName: "EPSG:4326",
        CQL_FILTER: `BBOX(GEOM,${bboxDelMapaVisible()},'EPSG:4326')`
      })
    ).filter((feature) => !esParcelaDeCalle(feature.properties.NOMBRE));
  } catch (error) {
    // La capa de referencia es un complemento opcional: si el catastro no
    // responde, no tiene que interrumpir el resto de la app — pero sí hay
    // que avisar, porque si no parece que el botón no hace nada.
    mostrarMensajeCatastroCercano("No se pudo cargar el catastro cercano ahora. Probá de nuevo en un momento.");
    return;
  }

  ocultarMensajeCatastroCercano();

  if (features.length === 0) {
    mostrarMensajeCatastroCercano("El catastro no tiene parcelas cargadas en esta zona.");
  }

  if (capaCatastroCercano) mapa.removeLayer(capaCatastroCercano);

  // La etiqueta de cada parcela NO se ata directo al polígono: el
  // centrado automático de Leaflet para un polígono ("direction: center")
  // sufre la misma cancelación numérica que ya corregimos en
  // centroideDePoligono() — con lotes de forma irregular (no
  // rectangulares, como suelen ser los reales) el número puede terminar
  // desplazado hacia el lote vecino. En cambio, se ancla a un marcador
  // invisible puesto exactamente en nuestro propio centroide (preciso).
  capaCatastroCercano = L.layerGroup();

  L.geoJSON(
    { type: "FeatureCollection", features },
    {
      style: estiloParcelaCatastroCercano,
      onEachFeature: (feature, layer) => {
        layer.on("click", (evento) => {
          // Mismo cuidado que en la capa de lotes cargados: no pisar una
          // captura de vértices en curso (ver el comentario en
          // cargarLotesDesdeFirestore).
          if (modoCaptura !== null) return;
          L.DomEvent.stopPropagation(evento);
          cargarParcelaEnFormLote(feature);
        });
      }
    }
  ).addTo(capaCatastroCercano);

  features.forEach((feature) => {
    const anillo = feature.geometry.coordinates[0];
    if (!anillo || anillo.length < 3) return;
    const { lat, lon } = centroideDePoligono(anillo);
    L.marker([lat, lon], {
      icon: L.divIcon({ className: "", iconSize: [0, 0] }),
      interactive: false
    })
      .bindTooltip(feature.properties.ETIQUETA || "", {
        permanent: true,
        direction: "center",
        className: "etiqueta-parcela-catastro"
      })
      .addTo(capaCatastroCercano);
  });

  // No mostrarla todavía si hay un formulario abierto tapando el mapa
  // (ver sincronizarVisibilidadCatastroCercano más abajo, que la muestra
  // sola apenas se cierre).
  if (!algunaHojaAbierta()) {
    capaCatastroCercano.addTo(mapa);
  }
}

// Apagar la capa de referencia: se llama desde el botón del drawer (al
// destildarlo), desde el botón flotante sobre el mapa (mismo efecto,
// sin tener que volver a abrir el menú — pedido explícito, entrar al
// drawer cada vez que se quiere desactivar era un mal trago), y al
// cerrar sesión.
function desactivarCatastroCercano() {
  catastroCercanoActivo = false;
  elBtnVerCatastroCercano.classList.remove("activo");
  elBtnFlotanteCatastro.classList.add("oculto");
  ocultarMensajeCatastroCercano();
  if (capaCatastroCercano) {
    mapa.removeLayer(capaCatastroCercano);
    capaCatastroCercano = null;
  }
}

elBtnVerCatastroCercano.addEventListener("click", () => {
  catastroCercanoActivo = !catastroCercanoActivo;
  elBtnVerCatastroCercano.classList.toggle("activo", catastroCercanoActivo);
  if (catastroCercanoActivo) {
    elBtnFlotanteCatastro.classList.remove("oculto");
    actualizarCatastroCercano();
  } else {
    desactivarCatastroCercano();
  }
});

elBtnFlotanteCatastro.addEventListener("click", desactivarCatastroCercano);

window.addEventListener("mojonapp:sesion-cerrada", desactivarCatastroCercano);

mapa.on("moveend", () => {
  if (catastroCercanoActivo) actualizarCatastroCercano();
});

// ---------------------------------------------------------------------------
// Captura interactiva de vértices: dos formas alternativas de llenar el
// textarea de vértices sin pegar coordenadas a mano — parado en cada
// esquina con el GPS del celular, o tocando el mapa directamente.
// Las dos terminan armando el mismo texto "latitud,longitud" por línea
// que ya entiende parsearVertices(), así que el resto del formulario de
// carga de lote no necesita saber de dónde salieron los vértices.
// ---------------------------------------------------------------------------

const elPanelCaptura = document.getElementById("panel-captura-vertices");
const elCapturaMensaje = document.getElementById("captura-mensaje");
const elCapturaContador = document.getElementById("captura-contador");
const elCapturaError = document.getElementById("captura-error");
const elBtnCapturaAgregar = document.getElementById("btn-captura-agregar");
const elBtnCapturaDeshacer = document.getElementById("btn-captura-deshacer");
const elBtnCapturaTerminar = document.getElementById("btn-captura-terminar");

let modoCaptura = null; // "gps" | "mapa"
let puntosCaptura = []; // [[lat, lon], ...]
let marcadoresCaptura = [];
let listenerClickMapaCaptura = null;

function actualizarContadorCaptura() {
  const n = puntosCaptura.length;
  let texto = `${n} punto${n === 1 ? "" : "s"} marcado${n === 1 ? "" : "s"}`;
  if (n >= 3) {
    const anillo = [...puntosCaptura, puntosCaptura[0]].map(([lat, lon]) => [lon, lat]);
    texto += ` — ~${Math.round(areaEnM2(anillo))} m²`;
  }
  elCapturaContador.textContent = texto;
}

function agregarPuntoCaptura(lat, lon) {
  puntosCaptura.push([lat, lon]);
  if (modoCaptura === "mapa") {
    const marcador = L.circleMarker([lat, lon], {
      radius: 7,
      color: "#fff",
      weight: 2,
      fillColor: "#2e7d32",
      fillOpacity: 1
    }).addTo(mapa);
    marcadoresCaptura.push(marcador);
  }
  elCapturaError.classList.add("oculto");
  actualizarContadorCaptura();
}

function deshacerUltimoPuntoCaptura() {
  puntosCaptura.pop();
  const marcador = marcadoresCaptura.pop();
  if (marcador) mapa.removeLayer(marcador);
  actualizarContadorCaptura();
}

function limpiarCaptura() {
  marcadoresCaptura.forEach((m) => mapa.removeLayer(m));
  marcadoresCaptura = [];
  puntosCaptura = [];
  if (listenerClickMapaCaptura) {
    mapa.off("click", listenerClickMapaCaptura);
    listenerClickMapaCaptura = null;
  }
  modoCaptura = null;
  elPanelCaptura.classList.add("oculto");
  elCapturaError.classList.add("oculto");
}

function iniciarCapturaGps() {
  modoCaptura = "gps";
  puntosCaptura = [];
  elCapturaMensaje.textContent = 'Parate en cada esquina del lote y tocá "Marcar acá".';
  elBtnCapturaAgregar.classList.remove("oculto");
  actualizarContadorCaptura();
  elFormLote.classList.add("oculto");
  elPanelCaptura.classList.remove("oculto");
}

function iniciarCapturaMapa() {
  modoCaptura = "mapa";
  puntosCaptura = [];
  elCapturaMensaje.textContent = "Tocá cada esquina del lote directo sobre el mapa.";
  elBtnCapturaAgregar.classList.add("oculto");
  actualizarContadorCaptura();
  elFormLote.classList.add("oculto");
  elPanelCaptura.classList.remove("oculto");

  listenerClickMapaCaptura = (evento) => agregarPuntoCaptura(evento.latlng.lat, evento.latlng.lng);
  mapa.on("click", listenerClickMapaCaptura);
}

elBtnCapturaAgregar.addEventListener("click", () => {
  if (!navigator.geolocation) {
    elCapturaError.textContent = "Este navegador no soporta geolocalización.";
    elCapturaError.classList.remove("oculto");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (posicion) => agregarPuntoCaptura(posicion.coords.latitude, posicion.coords.longitude),
    () => {
      elCapturaError.textContent = "No se pudo obtener tu ubicación. Revisá el permiso de ubicación.";
      elCapturaError.classList.remove("oculto");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

elBtnCapturaDeshacer.addEventListener("click", deshacerUltimoPuntoCaptura);

elBtnCapturaTerminar.addEventListener("click", () => {
  if (puntosCaptura.length < 3) {
    elCapturaError.textContent = "Hacen falta al menos 3 puntos.";
    elCapturaError.classList.remove("oculto");
    return;
  }
  elLoteVertices.value = puntosCaptura.map(([lat, lon]) => `${lat},${lon}`).join("\n");
  elLoteVertices.dispatchEvent(new Event("input"));
  limpiarCaptura();
  elFormLote.classList.remove("oculto");
});

document.getElementById("cerrar-captura-vertices").addEventListener("click", () => {
  const habiaEmpezado = modoCaptura !== null;
  limpiarCaptura();
  if (habiaEmpezado) elFormLote.classList.remove("oculto");
});
window.addEventListener("mojonapp:sesion-cerrada", limpiarCaptura);

document.getElementById("btn-vertices-gps").addEventListener("click", iniciarCapturaGps);
document.getElementById("btn-vertices-mapa").addEventListener("click", iniciarCapturaMapa);

// ---------------------------------------------------------------------------
// "Ver catastro cercano" puede agregar varios cientos de elementos al mapa
// (un polígono + un marcador + una etiqueta por cada parcela visible). Con
// eso activo, abrir cualquier formulario encima obligaba al navegador a
// repintar todo junto — lento, sobre todo en un celular. Mientras haya
// algún formulario abierto no hace falta ver esa capa (la atención está en
// el formulario, no en el mapa), así que se saca del mapa temporalmente
// —sin volver a pedirle nada al catastro— y se repone sola al cerrar todo.
// Un único observador cubre todas las hojas sin tener que tocar cada
// lugar del código que las abre o las cierra.
// Ojo: no es "cualquier hoja abierta" — "+ Manzana" y "+ Parcela" se
// dejan afuera a propósito. Son buscadores: el corredor los usa
// mirando los números de "Ver catastro cercano" para saber qué
// escribir, así que ocultar la capa mientras están abiertos rompía
// justo el caso de uso que la trajo. Sí se sigue ocultando en la ficha
// y en "Cargar a mano", que es donde de verdad se redibuja el mapa.
function algunaHojaAbierta() {
  return [elFicha, elFormLote].some((el) => !el.classList.contains("oculto"));
}

function sincronizarVisibilidadCatastroCercano() {
  if (!catastroCercanoActivo || !capaCatastroCercano) return;
  const debeOcultarse = algunaHojaAbierta();
  const estaEnElMapa = mapa.hasLayer(capaCatastroCercano);
  if (debeOcultarse && estaEnElMapa) {
    mapa.removeLayer(capaCatastroCercano);
  } else if (!debeOcultarse && !estaEnElMapa) {
    capaCatastroCercano.addTo(mapa);
  }
}

const observadorHojas = new MutationObserver(sincronizarVisibilidadCatastroCercano);
document.querySelectorAll(".hoja-inferior, #ficha-lote").forEach((el) => {
  observadorHojas.observe(el, { attributes: true, attributeFilter: ["class"] });
});

// ---------------------------------------------------------------------------
// Sección "Seguridad" (root / permiso administrar_usuarios): altas y
// ediciones de corredores, y perfiles de seguridad. Usuarios y Perfiles
// son pestañas separadas, y dentro de cada una "Agregar"/"Editar"
// reemplaza la grilla por su propia vista (no un formulario que se abre
// encima) — con varios usuarios cargados, todo apilado en una sola
// pantalla se pierde de vista rápido. Acá solo se decide qué mostrar —
// el permiso real lo hacen cumplir las reglas de Firestore
// (firestore.rules repite esta misma lógica del lado del servidor).
// ---------------------------------------------------------------------------

// Agrupados en secciones para el formulario de perfil (checkbox
// "maestro" por sección, ver más abajo) — el resto del código que solo
// necesita la lista plana (guardar, leer, resumen en la tabla) usa
// PERMISOS_INFO, derivada de acá.
const PERMISOS_SECCIONES = [
  {
    id: "lotes",
    nombre: "Lotes",
    permisos: [
      { clave: "cargar_lote", etiqueta: "Cargar lotes" },
      { clave: "ver_todos_los_lotes", etiqueta: "Ver todos los lotes" },
      { clave: "editar_lote_propio", etiqueta: "Editar lotes propios" },
      { clave: "editar_lote_ajeno", etiqueta: "Editar lotes ajenos" },
      { clave: "borrar_lote_propio", etiqueta: "Borrar lotes propios" },
      { clave: "borrar_lote_ajeno", etiqueta: "Borrar lotes ajenos" }
    ]
  },
  {
    id: "administracion",
    nombre: "Administración",
    permisos: [
      { clave: "administrar_sectores", etiqueta: "Administrar zonas/barrios" },
      { clave: "administrar_usuarios", etiqueta: "Administrar usuarios" }
    ]
  }
];

const PERMISOS_INFO = PERMISOS_SECCIONES.flatMap((s) => s.permisos);

const elPanelAdmin = document.getElementById("panel-admin");
const elMenuSeguridadUsuarios = document.getElementById("menu-seguridad-usuarios");
const elMenuSeguridadPerfiles = document.getElementById("menu-seguridad-perfiles");

const elTabUsuarios = document.getElementById("tab-usuarios");
const elTabPerfiles = document.getElementById("tab-perfiles");
const elSeccionUsuarios = document.getElementById("seccion-usuarios");
const elSeccionPerfiles = document.getElementById("seccion-perfiles");

const elUsuariosVistaLista = document.getElementById("usuarios-vista-lista");
const elUsuariosVistaForm = document.getElementById("usuarios-vista-form");
const elTablaUsuariosCuerpo = document.getElementById("tabla-usuarios-cuerpo");
const elBtnAgregarUsuario = document.getElementById("btn-agregar-usuario");
const elUsuarioVolver = document.getElementById("usuario-volver");
const elUsuarioFormTitulo = document.getElementById("usuario-form-titulo");
const formularioUsuario = document.getElementById("formulario-usuario");
const elUsuarioUidEditando = document.getElementById("usuario-uid-editando");
const elUsuarioEmail = document.getElementById("usuario-email");
const elUsuarioPasswordLabel = document.getElementById("usuario-password-label");
const elUsuarioPassword = document.getElementById("usuario-password");
const elUsuarioPerfil = document.getElementById("usuario-perfil");
const elUsuarioGuardar = document.getElementById("usuario-guardar");
const elUsuarioError = document.getElementById("usuario-error");

const elPerfilesVistaLista = document.getElementById("perfiles-vista-lista");
const elPerfilesVistaForm = document.getElementById("perfiles-vista-form");
const elTablaPerfilesCuerpo = document.getElementById("tabla-perfiles-cuerpo");
const elBtnAgregarPerfil = document.getElementById("btn-agregar-perfil");
const elPerfilVolver = document.getElementById("perfil-volver");
const elPerfilFormTitulo = document.getElementById("perfil-form-titulo");
const formularioPerfil = document.getElementById("formulario-perfil");
const elPerfilIdEditando = document.getElementById("perfil-id-editando");
const elPerfilNombre = document.getElementById("perfil-nombre");
const elPerfilError = document.getElementById("perfil-error");

let perfilesActuales = []; // último resultado de cargarPerfiles(), lo reusa el <select> de usuarios

function elCheckboxPermiso(clave) {
  return document.getElementById(`perfil-permiso-${clave}`);
}

function elCheckboxSeccion(id) {
  return document.getElementById(`perfil-seccion-${id}`);
}

// El checkbox "maestro" de una sección (Lotes, Administración...)
// refleja el estado de sus permisos hijos: tildado si están todos,
// "indeterminate" (el guioncito de Firefox/Chrome) si hay una mezcla,
// destildado si no hay ninguno. Se llama cada vez que cambia un
// permiso individual, y al precargar un perfil para editarlo.
function actualizarCheckboxSeccion(seccion) {
  const casillas = seccion.permisos.map(({ clave }) => elCheckboxPermiso(clave));
  const marcadas = casillas.filter((c) => c.checked).length;
  const master = elCheckboxSeccion(seccion.id);
  master.checked = marcadas === casillas.length;
  master.indeterminate = marcadas > 0 && marcadas < casillas.length;
}

function actualizarTodosLosCheckboxSeccion() {
  PERMISOS_SECCIONES.forEach(actualizarCheckboxSeccion);
}

// Tocar el checkbox de una sección tilda/destilda de una todos sus
// permisos — no hace falta ir uno por uno para dar (o sacar) un bloque
// entero de acceso, como "todo Administración".
PERMISOS_SECCIONES.forEach((seccion) => {
  elCheckboxSeccion(seccion.id).addEventListener("change", (evento) => {
    seccion.permisos.forEach(({ clave }) => {
      elCheckboxPermiso(clave).checked = evento.target.checked;
    });
    evento.target.indeterminate = false;
  });
  seccion.permisos.forEach(({ clave }) => {
    elCheckboxPermiso(clave).addEventListener("change", () => actualizarCheckboxSeccion(seccion));
  });
});

function resumenPermisos(permisos) {
  const activos = PERMISOS_INFO.filter(({ clave }) => permisos?.[clave]).map(({ etiqueta }) => etiqueta);
  return activos.length > 0 ? activos.join(", ") : "Sin permisos";
}

function mostrarTabUsuarios() {
  elTabUsuarios.classList.add("activo");
  elTabPerfiles.classList.remove("activo");
  elSeccionUsuarios.classList.remove("oculto");
  elSeccionPerfiles.classList.add("oculto");
}

function mostrarTabPerfiles() {
  elTabPerfiles.classList.add("activo");
  elTabUsuarios.classList.remove("activo");
  elSeccionPerfiles.classList.remove("oculto");
  elSeccionUsuarios.classList.add("oculto");
}

elTabUsuarios.addEventListener("click", mostrarTabUsuarios);
elTabPerfiles.addEventListener("click", mostrarTabPerfiles);

// --- Perfiles ---------------------------------------------------------

async function cargarPerfiles() {
  const snapshot = await getDocs(collection(db, "perfiles"));
  perfilesActuales = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

  elTablaPerfilesCuerpo.innerHTML = "";
  perfilesActuales.forEach((perfil) => {
    const fila = document.createElement("tr");
    fila.innerHTML = `
      <td>${perfil.nombre}${perfil.es_root ? " (root)" : ""}</td>
      <td>${perfil.es_root ? "Todos" : resumenPermisos(perfil.permisos)}</td>
      <td></td>
    `;
    // El perfil root no se edita desde acá: siempre tiene todos los
    // permisos, por definición (ver esRoot() en firestore.rules).
    if (!perfil.es_root) {
      const botonEditar = document.createElement("button");
      botonEditar.type = "button";
      botonEditar.className = "btn-editar-fila";
      botonEditar.textContent = "Editar";
      botonEditar.addEventListener("click", () => mostrarFormPerfil(perfil));
      fila.querySelector("td:last-child").appendChild(botonEditar);
    }
    elTablaPerfilesCuerpo.appendChild(fila);
  });

  actualizarSelectPerfiles();
}

function actualizarSelectPerfiles() {
  const seleccionPrevia = elUsuarioPerfil.value;
  elUsuarioPerfil.innerHTML = perfilesActuales
    .filter((p) => !p.es_root)
    .map((p) => `<option value="${p.id}">${p.nombre}</option>`)
    .join("");
  if (seleccionPrevia) elUsuarioPerfil.value = seleccionPrevia;
}

function mostrarListaPerfiles() {
  elPerfilesVistaForm.classList.add("oculto");
  elPerfilesVistaLista.classList.remove("oculto");
}

// perfil == null: alta de un perfil nuevo. Con un perfil, lo precarga
// para editarlo (mismo formulario, en modo edición).
function mostrarFormPerfil(perfil) {
  formularioPerfil.reset();
  elPerfilError.classList.add("oculto");
  if (perfil) {
    elPerfilIdEditando.value = perfil.id;
    elPerfilFormTitulo.textContent = `Editar "${perfil.nombre}"`;
    elPerfilNombre.value = perfil.nombre;
    PERMISOS_INFO.forEach(({ clave }) => {
      elCheckboxPermiso(clave).checked = !!perfil.permisos?.[clave];
    });
  } else {
    elPerfilIdEditando.value = "";
    elPerfilFormTitulo.textContent = "Nuevo perfil";
  }
  // formularioPerfil.reset() no dispara "change" en los checkboxes, así
  // que los maestros de sección quedan desincronizados si no se los
  // recalcula acá a mano (tanto al editar como al abrir en blanco).
  actualizarTodosLosCheckboxSeccion();
  elPerfilesVistaLista.classList.add("oculto");
  elPerfilesVistaForm.classList.remove("oculto");
}

elBtnAgregarPerfil.addEventListener("click", () => mostrarFormPerfil(null));
elPerfilVolver.addEventListener("click", mostrarListaPerfiles);

formularioPerfil.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elPerfilError.classList.add("oculto");
  try {
    const permisos = {};
    PERMISOS_INFO.forEach(({ clave }) => {
      permisos[clave] = elCheckboxPermiso(clave).checked;
    });
    const datos = { nombre: elPerfilNombre.value.trim(), es_root: false, permisos };
    const idEditando = elPerfilIdEditando.value;
    if (idEditando) {
      await setDoc(doc(db, "perfiles", idEditando), datos);
    } else {
      await addDoc(collection(db, "perfiles"), datos);
    }
    await cargarPerfiles();
    mostrarListaPerfiles();
  } catch (error) {
    elPerfilError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para administrar perfiles."
        : "No se pudo guardar el perfil.";
    elPerfilError.classList.remove("oculto");
  }
});

// --- Usuarios -----------------------------------------------------------

async function cargarUsuarios() {
  const snapshot = await getDocs(collection(db, "usuarios"));
  const usuarios = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

  elTablaUsuariosCuerpo.innerHTML = "";
  usuarios.forEach((usuario) => {
    const fila = document.createElement("tr");
    const perfilDelUsuario = perfilesActuales.find((p) => p.id === usuario.perfil_id);

    const celdaEmail = document.createElement("td");
    celdaEmail.textContent = usuario.email;

    const celdaPerfil = document.createElement("td");
    celdaPerfil.textContent = perfilDelUsuario ? (perfilDelUsuario.es_root ? "Root" : perfilDelUsuario.nombre) : "Sin perfil";

    const celdaAcciones = document.createElement("td");
    // Root no se edita desde acá, mismo motivo que en perfiles: siempre
    // tiene todos los permisos por definición.
    if (!perfilDelUsuario?.es_root) {
      const botonEditar = document.createElement("button");
      botonEditar.type = "button";
      botonEditar.className = "btn-editar-fila";
      botonEditar.textContent = "Editar";
      botonEditar.addEventListener("click", () => mostrarFormUsuario(usuario));
      celdaAcciones.appendChild(botonEditar);
    }
    const botonReset = document.createElement("button");
    botonReset.type = "button";
    botonReset.className = "btn-editar-fila";
    botonReset.textContent = "Restablecer contraseña";
    botonReset.addEventListener("click", async () => {
      try {
        await sendPasswordResetEmail(auth, usuario.email);
        window.alert(`Se envió un email para restablecer la contraseña a ${usuario.email}.`);
      } catch {
        window.alert("No se pudo enviar el email de restablecimiento.");
      }
    });
    celdaAcciones.appendChild(botonReset);

    fila.append(celdaEmail, celdaPerfil, celdaAcciones);
    elTablaUsuariosCuerpo.appendChild(fila);
  });
}

function mostrarListaUsuarios() {
  elUsuariosVistaForm.classList.add("oculto");
  elUsuariosVistaLista.classList.remove("oculto");
}

// usuario == null: alta de un corredor nuevo (pide contraseña inicial y
// crea la cuenta de Auth). Con un usuario, edita solo el perfil asignado
// — el email de una cuenta de Firebase Auth no se cambia desde acá.
function mostrarFormUsuario(usuario) {
  formularioUsuario.reset();
  elUsuarioError.classList.add("oculto");
  actualizarSelectPerfiles();
  if (usuario) {
    elUsuarioUidEditando.value = usuario.id;
    elUsuarioFormTitulo.textContent = `Editar ${usuario.email}`;
    elUsuarioEmail.value = usuario.email;
    elUsuarioEmail.disabled = true;
    elUsuarioPasswordLabel.classList.add("oculto");
    elUsuarioPassword.required = false;
    if (usuario.perfil_id) elUsuarioPerfil.value = usuario.perfil_id;
    elUsuarioGuardar.textContent = "Guardar cambios";
  } else {
    elUsuarioUidEditando.value = "";
    elUsuarioFormTitulo.textContent = "Nuevo usuario";
    elUsuarioEmail.disabled = false;
    elUsuarioPasswordLabel.classList.remove("oculto");
    elUsuarioPassword.required = true;
    elUsuarioGuardar.textContent = "Crear usuario";
  }
  elUsuariosVistaLista.classList.add("oculto");
  elUsuariosVistaForm.classList.remove("oculto");
}

elBtnAgregarUsuario.addEventListener("click", () => mostrarFormUsuario(null));
elUsuarioVolver.addEventListener("click", mostrarListaUsuarios);

// Dar de alta un corredor sin pisar la sesión de quien lo está creando:
// createUserWithEmailAndPassword deja logueada esa cuenta nueva en la
// instancia de Auth donde se la llama, así que se usa una instancia de
// Firebase App secundaria y descartable, en vez de la principal (`auth`).
async function crearCuentaDeCorredor(email, password) {
  const appSecundaria = initializeApp(firebaseConfig, `alta-${Date.now()}`);
  const authSecundaria = getAuth(appSecundaria);
  try {
    const credencial = await createUserWithEmailAndPassword(authSecundaria, email, password);
    return credencial.user.uid;
  } finally {
    await signOut(authSecundaria).catch(() => {});
    await deleteApp(appSecundaria);
  }
}

formularioUsuario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elUsuarioError.classList.add("oculto");
  try {
    const uidEditando = elUsuarioUidEditando.value;
    if (uidEditando) {
      await setDoc(doc(db, "usuarios", uidEditando), { email: elUsuarioEmail.value, perfil_id: elUsuarioPerfil.value });
    } else {
      const email = elUsuarioEmail.value.trim();
      const uid = await crearCuentaDeCorredor(email, elUsuarioPassword.value);
      await setDoc(doc(db, "usuarios", uid), { email, perfil_id: elUsuarioPerfil.value });
    }
    await cargarUsuarios();
    mostrarListaUsuarios();
  } catch (error) {
    elUsuarioError.textContent =
      error.code === "auth/email-already-in-use"
        ? "Ya existe una cuenta con ese email."
        : error.code === "auth/weak-password"
        ? "La contraseña tiene que tener al menos 6 caracteres."
        : "No se pudo guardar el usuario.";
    elUsuarioError.classList.remove("oculto");
  }
});

// "Seguridad" en el menú lateral no abre directo a una pestaña por
// defecto: son dos entradas separadas ("Usuarios" y "Perfiles de
// seguridad") y quien entra elige a cuál.
async function abrirPanelSeguridad(tab) {
  elVistaLista.classList.add("oculto"); // no superponer con "Ver como lista"
  elBtnVerLista.classList.remove("activo");
  document.getElementById("panel-sectores").classList.add("oculto"); // ni con "Zonas"
  document.getElementById("panel-barrios").classList.add("oculto"); // ni con "Barrios"
  mostrarListaUsuarios();
  mostrarListaPerfiles();
  if (tab === "perfiles") mostrarTabPerfiles();
  else mostrarTabUsuarios();
  elPanelAdmin.classList.remove("oculto");
  await cargarPerfiles();
  await cargarUsuarios();
}

elMenuSeguridadUsuarios.addEventListener("click", () => abrirPanelSeguridad("usuarios"));
elMenuSeguridadPerfiles.addEventListener("click", () => abrirPanelSeguridad("perfiles"));

document.getElementById("cerrar-panel-admin").addEventListener("click", () => {
  elPanelAdmin.classList.add("oculto");
});

// ---------------------------------------------------------------------------
// Panel "Sectores" (root / permiso administrar_sectores): catálogo de
// nombres que ofrece el combo de Sector/zona en los lotes. Mismo patrón
// de lista+form que Perfiles, pero sin pestañas (una sola entidad).
// ---------------------------------------------------------------------------

const elPanelSectores = document.getElementById("panel-sectores");
const elBtnAbrirSectores = document.getElementById("btn-abrir-sectores");
const elSectoresVistaLista = document.getElementById("sectores-vista-lista");
const elSectoresVistaForm = document.getElementById("sectores-vista-form");
const elTablaSectoresCuerpo = document.getElementById("tabla-sectores-cuerpo");
const elBtnAgregarSector = document.getElementById("btn-agregar-sector");
const elSectorVolver = document.getElementById("sector-volver");
const elSectorFormTitulo = document.getElementById("sector-form-titulo");
const formularioSector = document.getElementById("formulario-sector");
const elSectorIdEditando = document.getElementById("sector-id-editando");
const elSectorNombre = document.getElementById("sector-nombre");
const elSectorError = document.getElementById("sector-error");

async function cargarPanelSectores() {
  await cargarSectores();

  elTablaSectoresCuerpo.innerHTML = "";
  sectoresActuales.forEach((sector) => {
    const fila = document.createElement("tr");
    const celdaNombre = document.createElement("td");
    celdaNombre.textContent = sector.nombre;

    const celdaAcciones = document.createElement("td");
    const botonEditar = document.createElement("button");
    botonEditar.type = "button";
    botonEditar.className = "btn-editar-fila";
    botonEditar.textContent = "Editar";
    botonEditar.addEventListener("click", () => mostrarFormSector(sector));
    celdaAcciones.appendChild(botonEditar);

    const botonBorrar = document.createElement("button");
    botonBorrar.type = "button";
    botonBorrar.className = "btn-borrar-fila";
    botonBorrar.textContent = "Borrar";
    botonBorrar.addEventListener("click", () => borrarSector(sector, botonBorrar));
    celdaAcciones.appendChild(botonBorrar);

    fila.append(celdaNombre, celdaAcciones);
    elTablaSectoresCuerpo.appendChild(fila);
  });
}

function mostrarListaSectoresPanel() {
  elSectoresVistaForm.classList.add("oculto");
  elSectoresVistaLista.classList.remove("oculto");
}

// sector == null: alta de un sector nuevo. Con un sector, lo precarga
// para editarlo (mismo formulario, en modo edición).
function mostrarFormSector(sector) {
  formularioSector.reset();
  elSectorError.classList.add("oculto");
  if (sector) {
    elSectorIdEditando.value = sector.id;
    elSectorFormTitulo.textContent = `Editar "${sector.nombre}"`;
    elSectorNombre.value = sector.nombre;
  } else {
    elSectorIdEditando.value = "";
    elSectorFormTitulo.textContent = "Nueva zona";
  }
  elSectoresVistaLista.classList.add("oculto");
  elSectoresVistaForm.classList.remove("oculto");
}

elBtnAgregarSector.addEventListener("click", () => mostrarFormSector(null));
elSectorVolver.addEventListener("click", mostrarListaSectoresPanel);

formularioSector.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elSectorError.classList.add("oculto");
  try {
    const datos = { nombre: elSectorNombre.value.trim() };
    const idEditando = elSectorIdEditando.value;
    if (idEditando) {
      await setDoc(doc(db, "sectores", idEditando), datos);
    } else {
      await addDoc(collection(db, "sectores"), datos);
    }
    await cargarPanelSectores();
    mostrarListaSectoresPanel();
  } catch (error) {
    elSectorError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para administrar zonas."
        : "No se pudo guardar la zona.";
    elSectorError.classList.remove("oculto");
  }
});

// Borrar un sector del catálogo no le toca el dato a los lotes que ya lo
// tenían asignado (ver comentario arriba de cargarSectores) — solo dejan
// de poder elegirlo de nuevo para otro lote.
async function borrarSector(sector, boton) {
  if (!window.confirm(`¿Borrar la zona "${sector.nombre}"? Los lotes que ya la tienen asignada no se ven afectados.`)) return;
  boton.disabled = true;
  try {
    await deleteDoc(doc(db, "sectores", sector.id));
    await cargarPanelSectores();
  } catch (error) {
    window.alert(
      error.code === "permission-denied"
        ? "No tenés permiso para borrar zonas."
        : "No se pudo borrar la zona."
    );
  } finally {
    boton.disabled = false;
  }
}

elBtnAbrirSectores.addEventListener("click", async () => {
  elVistaLista.classList.add("oculto"); // no superponer con "Ver como lista"
  elBtnVerLista.classList.remove("activo");
  elPanelAdmin.classList.add("oculto"); // ni con "Seguridad"
  elPanelBarrios.classList.add("oculto"); // ni con "Barrios"
  mostrarListaSectoresPanel();
  elPanelSectores.classList.remove("oculto");
  await cargarPanelSectores();
});

document.getElementById("cerrar-panel-sectores").addEventListener("click", () => {
  elPanelSectores.classList.add("oculto");
});

// ---------------------------------------------------------------------------
// Panel "Barrios" (root / permiso administrar_sectores): mismo patrón
// exacto que el panel "Sectores" de arriba — catálogo independiente,
// segunda categorización de un lote.
// ---------------------------------------------------------------------------

const elPanelBarrios = document.getElementById("panel-barrios");
const elBtnAbrirBarrios = document.getElementById("btn-abrir-barrios");
const elBarriosVistaLista = document.getElementById("barrios-vista-lista");
const elBarriosVistaForm = document.getElementById("barrios-vista-form");
const elTablaBarriosCuerpo = document.getElementById("tabla-barrios-cuerpo");
const elBtnAgregarBarrio = document.getElementById("btn-agregar-barrio");
const elBarrioVolver = document.getElementById("barrio-volver");
const elBarrioFormTitulo = document.getElementById("barrio-form-titulo");
const formularioBarrio = document.getElementById("formulario-barrio");
const elBarrioIdEditando = document.getElementById("barrio-id-editando");
const elBarrioNombre = document.getElementById("barrio-nombre");
const elBarrioError = document.getElementById("barrio-error");

async function cargarPanelBarrios() {
  await cargarBarrios();

  elTablaBarriosCuerpo.innerHTML = "";
  barriosActuales.forEach((barrio) => {
    const fila = document.createElement("tr");
    const celdaNombre = document.createElement("td");
    celdaNombre.textContent = barrio.nombre;

    const celdaAcciones = document.createElement("td");
    const botonEditar = document.createElement("button");
    botonEditar.type = "button";
    botonEditar.className = "btn-editar-fila";
    botonEditar.textContent = "Editar";
    botonEditar.addEventListener("click", () => mostrarFormBarrio(barrio));
    celdaAcciones.appendChild(botonEditar);

    const botonBorrar = document.createElement("button");
    botonBorrar.type = "button";
    botonBorrar.className = "btn-borrar-fila";
    botonBorrar.textContent = "Borrar";
    botonBorrar.addEventListener("click", () => borrarBarrio(barrio, botonBorrar));
    celdaAcciones.appendChild(botonBorrar);

    fila.append(celdaNombre, celdaAcciones);
    elTablaBarriosCuerpo.appendChild(fila);
  });
}

function mostrarListaBarriosPanel() {
  elBarriosVistaForm.classList.add("oculto");
  elBarriosVistaLista.classList.remove("oculto");
}

// barrio == null: alta de un barrio nuevo. Con un barrio, lo precarga
// para editarlo (mismo formulario, en modo edición).
function mostrarFormBarrio(barrio) {
  formularioBarrio.reset();
  elBarrioError.classList.add("oculto");
  if (barrio) {
    elBarrioIdEditando.value = barrio.id;
    elBarrioFormTitulo.textContent = `Editar "${barrio.nombre}"`;
    elBarrioNombre.value = barrio.nombre;
  } else {
    elBarrioIdEditando.value = "";
    elBarrioFormTitulo.textContent = "Nuevo barrio";
  }
  elBarriosVistaLista.classList.add("oculto");
  elBarriosVistaForm.classList.remove("oculto");
}

elBtnAgregarBarrio.addEventListener("click", () => mostrarFormBarrio(null));
elBarrioVolver.addEventListener("click", mostrarListaBarriosPanel);

formularioBarrio.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elBarrioError.classList.add("oculto");
  try {
    const datos = { nombre: elBarrioNombre.value.trim() };
    const idEditando = elBarrioIdEditando.value;
    if (idEditando) {
      await setDoc(doc(db, "barrios", idEditando), datos);
    } else {
      await addDoc(collection(db, "barrios"), datos);
    }
    await cargarPanelBarrios();
    mostrarListaBarriosPanel();
  } catch (error) {
    elBarrioError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para administrar barrios."
        : "No se pudo guardar el barrio.";
    elBarrioError.classList.remove("oculto");
  }
});

// Borrar un barrio del catálogo no le toca el dato a los lotes que ya lo
// tenían asignado (mismo criterio que borrarSector) — solo dejan de
// poder elegirlo de nuevo para otro lote.
async function borrarBarrio(barrio, boton) {
  if (!window.confirm(`¿Borrar el barrio "${barrio.nombre}"? Los lotes que ya lo tienen asignado no se ven afectados.`)) return;
  boton.disabled = true;
  try {
    await deleteDoc(doc(db, "barrios", barrio.id));
    await cargarPanelBarrios();
  } catch (error) {
    window.alert(
      error.code === "permission-denied"
        ? "No tenés permiso para borrar barrios."
        : "No se pudo borrar el barrio."
    );
  } finally {
    boton.disabled = false;
  }
}

elBtnAbrirBarrios.addEventListener("click", async () => {
  elVistaLista.classList.add("oculto"); // no superponer con "Ver como lista"
  elBtnVerLista.classList.remove("activo");
  elPanelAdmin.classList.add("oculto"); // ni con "Seguridad"
  elPanelSectores.classList.add("oculto"); // ni con "Zonas"
  mostrarListaBarriosPanel();
  elPanelBarrios.classList.remove("oculto");
  await cargarPanelBarrios();
});

document.getElementById("cerrar-panel-barrios").addEventListener("click", () => {
  elPanelBarrios.classList.add("oculto");
});
