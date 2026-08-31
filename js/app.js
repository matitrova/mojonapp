// ---------------------------------------------------------------------------
// MojonApp. Los lotes viven en Firestore (colección "lotes"): cualquiera
// que abra la app los puede ver, pero solo un corredor logueado (Firebase
// Auth) puede cargar uno nuevo. Ver firebase-config.js y firestore.rules.
// ---------------------------------------------------------------------------

import { db, auth, firebaseConfig } from "./firebase-config.js";
import {
  centroideDePoligono,
  areaEnM2,
  medidasFrenteYLargo,
  textoMedidasLados,
  aRadianes,
  verticesUnicos,
  longitudLadoEnMetros,
  verticesCasiColineales,
  verticesSimplificados,
  distanciaPuntoASegmentoPx
} from "./geometria.js";
import {
  CATASTRO_WFS_URL,
  CATASTRO_CBA_WFS_URL,
  CATASTRO_BSAS_WFS_URL,
  pedirWfsA,
  pedirWfs,
  primerAnilloDeGeometria,
  normalizarParcelaSanLuis,
  normalizarParcelaCordoba,
  normalizarParcelaBuenosAires,
  nomenclaturaDeManzana,
  superficieDesdeNombreCatastro,
  esParcelaDeCalle,
  manzanaDesdeNomenclaturaDeParcela
} from "./catastro-normalizacion.js";
import {
  getLoteSeleccionado,
  setLoteSeleccionado,
  setCorredorLogueado,
  getMiPerfil,
  setMiPerfil,
  getLotesActuales,
  setLotesActuales,
  getDeepLinkAbierto,
  setDeepLinkAbierto,
  setSectoresActuales,
  setBarriosActuales,
  getModoCaptura,
  setModoCaptura,
  setLoteEditadoDesdeFicha,
  emitirSesionCerrada,
  onSesionCerrada
} from "./estado.js";
import { iniciarEstoyYendo } from "./estoy-yendo.js";
import {
  configurarCatalogos,
  iniciarCatalogos,
  cargarSectores,
  cargarBarrios,
  poblarSelectSector,
  poblarSelectBarrio
} from "./catalogos.js";
import { configurarDashboard, abrirPanelDashboard, renderDashboard, registrarVistaDeLote } from "./dashboard.js";
import {
  configurarVistaLista,
  actualizarVistaLista,
  mostrarEditarLoteDesdeGrilla
} from "./vista-lista.js";
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
  where,
  arrayUnion,
  arrayRemove,
  increment
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  getAuth
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

configurarCatalogos({ db, getDocs, addDoc, setDoc, deleteDoc, collection, doc });
iniciarCatalogos();

const COLECCION_LOTES = "lotes";

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

// Texto de estado listo para mostrar, con la fecha de vencimiento de la
// reserva si corresponde ("Reservado (hasta 15/09/2026)" o "Reservado
// (vencida desde 10/09/2026)" en rojo) — para que un lote reservado
// hace rato y nunca actualizado no pase desapercibido. HTML porque el
// "vencida" va en rojo (.texto-vencido); si no hay fecha, se devuelve
// como texto plano (sin riesgo: ETIQUETA_ESTADO no trae HTML).
function textoEstadoConVencimiento(p) {
  const base = ETIQUETA_ESTADO[p.estado] || p.estado;
  if (p.estado !== "reservado" || !p.reservado_hasta) return base;
  const hoy = new Date().toISOString().slice(0, 10);
  const fecha = new Date(`${p.reservado_hasta}T00:00:00`).toLocaleDateString("es-AR");
  return p.reservado_hasta < hoy
    ? `${base} <span class="texto-vencido">(vencida desde ${fecha})</span>`
    : `${base} (hasta ${fecha})`;
}

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

// ---------------------------------------------------------------------------
// Permisos: quién puede qué. Todo lo que decide acá es solo para mostrar
// u ocultar botones — el permiso real lo hacen cumplir las reglas de
// Firestore (firestore.rules), que repiten esta misma lógica del lado
// del servidor. Si algo queda mal escondido acá, Firestore igual lo
// rechaza.
// ---------------------------------------------------------------------------

function esRootActual() {
  const perfil = getMiPerfil();
  return !!perfil && perfil.es_root === true;
}

function tienePermiso(clave) {
  const perfil = getMiPerfil();
  if (!perfil) return false;
  if (perfil.es_root) return true;
  return perfil.permisos?.[clave] === true;
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

// Capas de referencia (calles, localidades, límites) — mismo proveedor
// gratis y sin API key que la imagen satelital, pensadas por Esri
// justo para superponerse arriba de "World_Imagery" (fondo
// transparente, solo texto/líneas). Pedido explícito: la vista
// satelital sola no trae ningún nombre. Ninguna de las dos muestra un
// placeholder feo fuera de su zoom nativo — donde no tienen nada que
// dibujar, el tile viene vacío/transparente nomás (verificado bajando
// tiles reales).
//
// Son DOS capas, no una — se probó primero solo con
// "World_Boundaries_and_Places" y quedó vacía justo en el zoom 16-18
// que usa la app para mirar lotes (esa capa solo tiene nombres de
// localidad/límites a zoom bajo, ≤15 en la zona de Merlo/Carpintería —
// confirmado bajando tiles reales, deja de traer nada más cerca).
// "World_Transportation" es la que sí tiene calles con nombre en ese
// rango de zoom (confirmado con un tile real: "Avenida del Sol",
// "Presbítero Becerra", "C Champaquí" cerca de los lotes cargados) —
// juntas cubren tanto "en qué localidad estoy" (zoom lejos) como "qué
// calle es esta" (zoom cerca), que es lo que se pidió.
// minZoom 16: con todo el pueblo a la vista (zoom ~14-15) esta capa
// mete el nombre de CADA calle, y se ve como un empapelado de texto
// encima del satelital — reportado en vivo ("muchas cosas en
// pantalla"). Recién se prende al acercarse a la escala de un barrio,
// que es donde realmente hace falta saber qué calle es cuál.
// opacity 0.75: la tipografía de Esri para estas capas viene con halo
// blanco bien marcado — no hay forma de aflojar el grosor de la letra
// en sí (son tiles ya dibujados en el servidor, no texto editable del
// lado del navegador), pero bajarle la opacidad a la capa entera
// atenúa ese contraste tan fuerte contra el satelital sin perder
// legibilidad — pedido en vivo ("no quiero que se vean tan
// resaltadas").
const capasReferencia = L.layerGroup([
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 24,
    maxNativeZoom: 23, // tope real del servicio, confirmado por su propio ?f=json
    minZoom: 16,
    opacity: 0.75,
    attribution: "Reference &copy; Esri"
  }),
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 24,
    maxNativeZoom: 23,
    minZoom: 16,
    opacity: 0.75,
    attribution: "Reference &copy; Esri"
  })
]).addTo(mapa);

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
const elMensajeCargaInicial = document.getElementById("mensaje-carga-inicial");

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

// Se muestra un "Cargando lotes…" solo la primera vez que arranca la
// app — esta función se vuelve a llamar seguido después (al guardar un
// lote, al iniciar/cerrar sesión, etc.) y repetir el aviso en cada una
// de esas veces sería más ruido que ayuda, además de parpadear sobre
// lotes que ya están a la vista.
let primeraCargaDeLotesHecha = false;

async function cargarLotesDesdeFirestore() {
  if (!primeraCargaDeLotesHecha) elMensajeCargaInicial.classList.remove("oculto");

  // Un corredor sin "ver_todos_los_lotes" solo trae lo suyo — root, y
  // cualquiera sin sesión (el catálogo público), siguen viendo todo.
  const restringirAPropios = !!getMiPerfil() && !esRootActual() && !tienePermiso("ver_todos_los_lotes");
  const consulta = restringirAPropios
    ? query(collection(db, COLECCION_LOTES), where("creado_por", "==", auth.currentUser.uid))
    : collection(db, COLECCION_LOTES);
  const snapshot = await getDocs(consulta);
  const features = snapshot.docs.map(docALoteFeature);
  setLotesActuales(features); // la vista en grilla reusa esto, no vuelve a pedirle nada a Firestore
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
          if (getModoCaptura() !== null) return;
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
    // maxZoom explícito: si el contenedor del mapa todavía no tiene un
    // tamaño real en este instante (puede pasar, esta llamada es lo
    // primero que corre la app apenas responde Firestore), Leaflet
    // calcula mal el zoom que hace falta para encuadrar y termina
    // clavado en el maxZoom del mapa (24) — un solo lote de golpe
    // aislado en una esquina, imagen satelital reventada de borrosa.
    // Reproducido de forma consistente en pruebas. 18 alcanza de sobra
    // para encuadrar cualquier cartera real de lotes de un corredor.
    mapa.fitBounds(capaLotes.getBounds(), { padding: [20, 20], maxZoom: 18 });
  }

  if (habiaCatastroCercano) capaCatastroCercano.addTo(mapa);

  elMensajeCargaInicial.classList.add("oculto");
  primeraCargaDeLotesHecha = true;
}

cargarLotesDesdeFirestore().catch((error) => {
  console.error("No se pudieron cargar los lotes desde Firestore:", error);
  // Si la primera carga falla, no dejar el aviso de "Cargando…" pegado
  // para siempre — mejor un mensaje de error concreto que uno que
  // sugiere que todavía está en curso.
  elMensajeCargaInicial.textContent = "No se pudieron cargar los lotes. Recargá la página para reintentar.";
});

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

// ---------------------------------------------------------------------------
// Fotos del lote: se suben directo desde el navegador a Cloudinary (plan
// gratis, sin tarjeta — a diferencia de Firebase Storage o Cloudflare R2,
// que piden tarjeta cargada aunque el uso se mantenga gratis, ver charla
// con el usuario) usando un "upload preset" sin firmar (unsigned) — el
// modo pensado por Cloudinary para subir directo desde el cliente sin
// exponer ninguna clave secreta ni necesitar un servidor propio. Firestore
// solo guarda la URL resultante (y el public_id, por si en el futuro hace
// falta) en un array "fotos" del lote, mismo patrón que "interesados"
// (arrayUnion/arrayRemove) más abajo.
//
// Cloud name y upload preset de la cuenta de Cloudinary del usuario —
// ninguno de los dos es secreto (a diferencia del API key/secret, que
// jamás deben viajar al navegador): son justamente los dos únicos datos
// que Cloudinary espera ver embebidos en código de cliente para el modo
// "unsigned". El preset está configurado como Unsigned + carpeta
// "mojonapp-lotes" en el panel de Cloudinary.
const CLOUDINARY_CLOUD_NAME = "ipuyvn4v";
const CLOUDINARY_UPLOAD_PRESET = "mojonapp_lotes";

const elFichaFotos = document.getElementById("ficha-fotos");
const elGaleriaFotos = document.getElementById("galeria-fotos-lote");
const elSubirFotoLabel = document.getElementById("subir-foto-label");
const elInputFotoLote = document.getElementById("input-foto-lote");
const elFichaFotoCargando = document.getElementById("ficha-foto-cargando");
const elFichaFotoError = document.getElementById("ficha-foto-error");

async function subirFotoACloudinary(archivo) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    throw new Error("Cloudinary todavía no está configurado en la app (falta CLOUDINARY_CLOUD_NAME/CLOUDINARY_UPLOAD_PRESET).");
  }
  const formData = new FormData();
  formData.append("file", archivo);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  const respuesta = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: "POST",
    body: formData
  });
  if (!respuesta.ok) {
    throw new Error("Cloudinary rechazó la subida.");
  }
  const datos = await respuesta.json();
  // Un objeto chico y estable a propósito: arrayRemove (ver borrarFoto)
  // necesita coincidir EXACTO con lo que ya está guardado para poder
  // sacarlo, así que cuantos menos campos variables, mejor.
  return { url: datos.secure_url, id: datos.public_id };
}

function renderFotos(feature) {
  const fotos = feature.properties.fotos || [];
  const puedeSubir = puedeEditarLote(feature);

  elFichaFotos.classList.toggle("oculto", fotos.length === 0 && !puedeSubir);
  elSubirFotoLabel.classList.toggle("oculto", !puedeSubir);

  elGaleriaFotos.innerHTML = "";
  fotos.forEach((foto) => {
    const contenedor = document.createElement("div");
    contenedor.className = "foto-lote";

    const img = document.createElement("img");
    img.src = foto.url;
    img.loading = "lazy";
    img.alt = "Foto del lote";
    // Ver más grande en una pestaña aparte — más simple que armar un
    // visor propio para una sola imagen a la vez.
    img.addEventListener("click", () => window.open(foto.url, "_blank"));
    contenedor.appendChild(img);

    if (puedeSubir) {
      const botonBorrar = document.createElement("button");
      botonBorrar.type = "button";
      botonBorrar.className = "btn-borrar-foto";
      botonBorrar.textContent = "×";
      botonBorrar.setAttribute("aria-label", "Borrar foto");
      botonBorrar.addEventListener("click", (evento) => {
        evento.stopPropagation();
        borrarFoto(feature, foto);
      });
      contenedor.appendChild(botonBorrar);
    }

    elGaleriaFotos.appendChild(contenedor);
  });
}

async function borrarFoto(feature, foto) {
  if (!window.confirm("¿Borrar esta foto del lote?")) return;
  try {
    // Solo saca la referencia en Firestore — el archivo en sí sigue
    // ocupando espacio en Cloudinary. Borrarlo de ahí también necesita
    // una llamada FIRMADA (con la clave secreta), que no puede hacerse
    // con seguridad desde el navegador — queda fuera de alcance por
    // ahora, la cuota gratis (25GB) da para mucho antes de que importe.
    await updateDoc(doc(db, COLECCION_LOTES, feature.id), { fotos: arrayRemove(foto) });
    feature.properties.fotos = (feature.properties.fotos || []).filter((f) => f !== foto);
    renderFotos(feature);
  } catch (error) {
    window.alert(
      error.code === "permission-denied" ? "No tenés permiso para borrar fotos de este lote." : "No se pudo borrar la foto."
    );
  }
}

elInputFotoLote.addEventListener("change", async () => {
  const archivo = elInputFotoLote.files[0];
  if (!archivo || !getLoteSeleccionado()) return;

  elFichaFotoError.classList.add("oculto");
  elFichaFotoCargando.classList.remove("oculto");
  elInputFotoLote.disabled = true;
  try {
    const foto = await subirFotoACloudinary(archivo);
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { fotos: arrayUnion(foto) });
    if (!getLoteSeleccionado().properties.fotos) getLoteSeleccionado().properties.fotos = [];
    getLoteSeleccionado().properties.fotos.push(foto);
    renderFotos(getLoteSeleccionado());
  } catch (error) {
    elFichaFotoError.textContent =
      error.code === "permission-denied" ? "No tenés permiso para agregar fotos a este lote." : "No se pudo subir la foto. Probá de nuevo.";
    elFichaFotoError.classList.remove("oculto");
  } finally {
    elFichaFotoCargando.classList.add("oculto");
    elInputFotoLote.disabled = false;
    elInputFotoLote.value = "";
  }
});

// Interesados: mini-CRM liviano, solo para quien puede editar el lote.
const elFichaInteresados = document.getElementById("ficha-interesados");
const elListaInteresados = document.getElementById("lista-interesados");
const formularioInteresado = document.getElementById("formulario-interesado");
const elInteresadoNombre = document.getElementById("interesado-nombre");
const elInteresadoTelefono = document.getElementById("interesado-telefono");
const elInteresadoNota = document.getElementById("interesado-nota");
const elInteresadoError = document.getElementById("interesado-error");

function renderInteresados(feature) {
  const interesados = feature.properties.interesados || [];
  elListaInteresados.innerHTML = "";
  interesados.forEach((interesado) => {
    const fila = document.createElement("li");
    fila.className = "fila-interesado";

    const datos = document.createElement("div");
    datos.className = "fila-interesado-datos";
    const fecha = interesado.fecha
      ? new Date(`${interesado.fecha}T00:00:00`).toLocaleDateString("es-AR")
      : "";
    datos.innerHTML = `<strong>${interesado.nombre}</strong>${
      interesado.telefono ? ` · ${interesado.telefono}` : ""
    }${interesado.nota ? ` · ${interesado.nota}` : ""}${fecha ? ` <span>(${fecha})</span>` : ""}`;

    const botonBorrar = document.createElement("button");
    botonBorrar.type = "button";
    botonBorrar.textContent = "Borrar";
    botonBorrar.addEventListener("click", () => borrarInteresado(feature, interesado));

    fila.append(datos, botonBorrar);
    elListaInteresados.appendChild(fila);
  });
}

async function borrarInteresado(feature, interesado) {
  if (!window.confirm(`¿Borrar a "${interesado.nombre}" de los interesados en este lote?`)) return;
  try {
    await updateDoc(doc(db, COLECCION_LOTES, feature.id), { interesados: arrayRemove(interesado) });
    feature.properties.interesados = (feature.properties.interesados || []).filter((i) => i !== interesado);
    renderInteresados(feature);
  } catch (error) {
    window.alert(
      error.code === "permission-denied"
        ? "No tenés permiso para borrar interesados."
        : "No se pudo borrar."
    );
  }
}

formularioInteresado.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!getLoteSeleccionado()) return;
  elInteresadoError.classList.add("oculto");

  const nombre = elInteresadoNombre.value.trim();
  if (!nombre) return;
  const interesado = {
    nombre,
    telefono: elInteresadoTelefono.value.trim() || null,
    nota: elInteresadoNota.value.trim() || null,
    fecha: new Date().toISOString().slice(0, 10)
  };

  const boton = document.getElementById("interesado-guardar-btn");
  boton.disabled = true;
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), {
      interesados: arrayUnion(interesado)
    });
    if (!getLoteSeleccionado().properties.interesados) {
      getLoteSeleccionado().properties.interesados = [];
    }
    getLoteSeleccionado().properties.interesados.push(interesado);
    renderInteresados(getLoteSeleccionado());
    formularioInteresado.reset();
  } catch (error) {
    elInteresadoError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para agregar interesados."
        : "No se pudo guardar.";
    elInteresadoError.classList.remove("oculto");
  } finally {
    boton.disabled = false;
  }
});

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
    <div>Estado: ${textoEstadoConVencimiento(p)}</div>
    <div>Precio: ${precio}</div>
  `;
}

function mostrarFicha(feature) {
  setLoteSeleccionado(feature);
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
  elEstado.innerHTML = textoEstadoConVencimiento(p);
  elPrecio.textContent = p.precio_usd == null ? "Sin datos" : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`;
  elServicios.innerHTML = renderServiciosHTML(p.servicios);
  elObservaciones.textContent = p.observaciones || "Sin datos";
  renderFotos(feature);

  document.getElementById("btn-borrar-lote").classList.toggle("oculto", !puedeBorrarLote(feature));
  document.getElementById("btn-editar-lote-completo").classList.toggle("oculto", !puedeEditarLote(feature));
  document.getElementById("btn-editar-forma-lote").classList.toggle("oculto", !puedeEditarLote(feature));
  elFichaInteresados.classList.toggle("oculto", !puedeEditarLote(feature));
  renderInteresados(feature);
  cerrarEditorServicios(); // por si había quedado abierto en el lote anterior
  cerrarEditorSector();
  cerrarEditorBarrio();

  abrirHoja(elFicha);
  registrarVistaDeLote(feature);
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
  if (!getLoteSeleccionado()) return;
  elFicha.classList.add("oculto");
  document.getElementById("panel-admin").classList.add("oculto");
  document.getElementById("panel-sectores").classList.add("oculto");
  document.getElementById("panel-barrios").classList.add("oculto");
  document.getElementById("vista-lista").classList.remove("oculto");
  document.getElementById("btn-ver-lista").classList.add("activo");
  setLoteEditadoDesdeFicha(true);
  mostrarEditarLoteDesdeGrilla(getLoteSeleccionado());
});

// ---------------------------------------------------------------------------
// Ajustar la forma de un lote ya cargado: el catastro puede traer un
// polígono más chico que el terreno real (caso real: un lote que en
// los papeles medía menos que el terreno de verdad) — pedido explícito
// para poder arrastrar cada esquina directo sobre el mapa, con
// superficie/frente/largo recalculados EN VIVO mientras se mueve, no
// solo al soltar.
// ---------------------------------------------------------------------------

const elEditorPoligonoBarra = document.getElementById("editor-poligono-barra");
const elEditorPoligonoSuperficie = document.getElementById("editor-poligono-superficie");
const elEditorPoligonoFrente = document.getElementById("editor-poligono-frente");
const elEditorPoligonoLargo = document.getElementById("editor-poligono-largo");
const elEditorPoligonoError = document.getElementById("editor-poligono-error");
const elBtnGuardarPoligono = document.getElementById("btn-guardar-poligono");
const elEditorPoligonoSimplificar = document.getElementById("editor-poligono-simplificar");
const elBtnSimplificarForma = document.getElementById("btn-simplificar-forma");
const elBtnModoLadoTocar = document.getElementById("btn-modo-lado-tocar");
const elBtnModoLadoLista = document.getElementById("btn-modo-lado-lista");
const elLadoTocarAyuda = document.getElementById("lado-tocar-ayuda");
const elListaLados = document.getElementById("lista-lados");
const elLadoSeleccionadoForm = document.getElementById("lado-seleccionado-form");
const elLadoSeleccionadoMedida = document.getElementById("lado-seleccionado-medida");
const elInputLadoNuevo = document.getElementById("input-lado-nuevo");
const elBtnAplicarLado = document.getElementById("btn-aplicar-lado");

let edicionPoligono = null; // { feature, capa: L.Polygon, marcadores: L.Marker[] } | null
let ladoSeleccionado = null; // índice i: el lado entre marcadores[i] y marcadores[(i+1) % n]
let modoSeleccionLado = "tocar"; // "tocar" (en el mapa) | "lista"
let capaResaltadoLado = null; // L.Polyline que resalta el lado seleccionado

// Saca los marcadores/capa viejos y los reemplaza por unos nuevos en
// las posiciones dadas — hace falta para "Simplificar forma" porque
// cambia la CANTIDAD de vértices, no solo mueve uno.
function reemplazarVerticesEdicionPoligono(latlngs) {
  edicionPoligono.marcadores.forEach((m) => mapa.removeLayer(m));
  edicionPoligono.marcadores = latlngs.map((latlng) => crearMarcadorVerticeEdicion(latlng));
  edicionPoligono.capa.setLatLngs(latlngs);
}

function actualizarMedidasEdicionPoligono() {
  if (!edicionPoligono) return;
  const puntos = edicionPoligono.marcadores.map((m) => {
    const { lat, lng } = m.getLatLng();
    return [lng, lat]; // [lon, lat], como espera areaEnM2/medidasFrenteYLargo
  });
  const anillo = [...puntos, puntos[0]];

  elEditorPoligonoSuperficie.textContent = `${areaEnM2(anillo).toFixed(1)} m²`;
  const dims = medidasFrenteYLargo(anillo);
  if (dims) {
    elEditorPoligonoFrente.textContent = `${dims[0].toFixed(1)} m`;
    elEditorPoligonoLargo.textContent = `${dims[1].toFixed(1)} m`;
  }

  actualizarResaltadoLado();
  if (modoSeleccionLado === "lista") renderizarListaLados();
  elEditorPoligonoSimplificar.classList.toggle("oculto", !verticesCasiColineales(edicionPoligono.marcadores));
}

// Dibuja (o borra) la línea amarilla que marca el lado elegido — se
// llama después de cualquier cambio de posición de los marcadores, así
// el resaltado sigue al lado aunque se lo arrastre.
function actualizarResaltadoLado() {
  if (capaResaltadoLado) {
    mapa.removeLayer(capaResaltadoLado);
    capaResaltadoLado = null;
  }
  if (!edicionPoligono || ladoSeleccionado === null) {
    elLadoSeleccionadoForm.classList.add("oculto");
    return;
  }
  const marcadores = edicionPoligono.marcadores;
  const n = marcadores.length;
  const a = marcadores[ladoSeleccionado].getLatLng();
  const b = marcadores[(ladoSeleccionado + 1) % n].getLatLng();
  capaResaltadoLado = L.polyline([a, b], { color: "#ffcc00", weight: 7, opacity: 0.9 }).addTo(mapa);

  elLadoSeleccionadoForm.classList.remove("oculto");
  elLadoSeleccionadoMedida.textContent = `${longitudLadoEnMetros(a, b).toFixed(1)} m`;
}

function renderizarListaLados() {
  if (!edicionPoligono) return;
  const marcadores = edicionPoligono.marcadores;
  const n = marcadores.length;
  elListaLados.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const a = marcadores[i].getLatLng();
    const b = marcadores[(i + 1) % n].getLatLng();
    const li = document.createElement("li");
    li.textContent = `Lado ${i + 1}: ${longitudLadoEnMetros(a, b).toFixed(1)} m`;
    li.classList.toggle("activo", i === ladoSeleccionado);
    li.addEventListener("click", () => seleccionarLado(i));
    elListaLados.appendChild(li);
  }
}

function seleccionarLado(indice) {
  ladoSeleccionado = indice;
  if (indice !== null) {
    const marcadores = edicionPoligono.marcadores;
    const n = marcadores.length;
    const a = marcadores[indice].getLatLng();
    const b = marcadores[(indice + 1) % n].getLatLng();
    elInputLadoNuevo.value = longitudLadoEnMetros(a, b).toFixed(1);
  }
  actualizarResaltadoLado();
  if (modoSeleccionLado === "lista") renderizarListaLados();
}

// Qué lado del lote está más cerca de un click en el mapa — null si el
// click cayó lejos de todos (por ejemplo, en el medio de un lote
// grande), para no "adivinar" una selección que no tiene sentido.
function ladoMasCercano(latlngClick) {
  const marcadores = edicionPoligono.marcadores;
  const n = marcadores.length;
  const p = mapa.latLngToLayerPoint(latlngClick);
  let mejorIndice = null;
  let mejorDistancia = Infinity;
  for (let i = 0; i < n; i++) {
    const a = mapa.latLngToLayerPoint(marcadores[i].getLatLng());
    const b = mapa.latLngToLayerPoint(marcadores[(i + 1) % n].getLatLng());
    const d = distanciaPuntoASegmentoPx(p, a, b);
    if (d < mejorDistancia) {
      mejorDistancia = d;
      mejorIndice = i;
    }
  }
  return mejorDistancia <= 25 ? mejorIndice : null;
}

function fijarModoSeleccionLado(modo) {
  modoSeleccionLado = modo;
  elBtnModoLadoTocar.classList.toggle("activo", modo === "tocar");
  elBtnModoLadoLista.classList.toggle("activo", modo === "lista");
  elLadoTocarAyuda.classList.toggle("oculto", modo !== "tocar");
  elListaLados.classList.toggle("oculto", modo !== "lista");
  if (modo === "lista") renderizarListaLados();
}

elBtnModoLadoTocar.addEventListener("click", () => fijarModoSeleccionLado("tocar"));
elBtnModoLadoLista.addEventListener("click", () => fijarModoSeleccionLado("lista"));

function terminarEdicionPoligono() {
  if (!edicionPoligono) return;
  mapa.removeLayer(edicionPoligono.capa);
  edicionPoligono.marcadores.forEach((m) => mapa.removeLayer(m));
  if (capaResaltadoLado) mapa.removeLayer(capaResaltadoLado);
  capaResaltadoLado = null;
  ladoSeleccionado = null;
  edicionPoligono = null;
  setModoCaptura(null);
  elEditorPoligonoBarra.classList.add("oculto");
  elEditorPoligonoError.classList.add("oculto");
}

// Si se cierra sesión con el editor de forma abierto (mismo criterio que
// desactivarCatastroCercano/limpiarCaptura), no se queda a mitad de
// camino con marcadores sueltos sobre el mapa.
onSesionCerrada(terminarEdicionPoligono);

// Crea un marcador arrastrable de vértice y lo cablea contra el estado
// ACTUAL de edicionPoligono (no contra un array cerrado por closure).
function crearMarcadorVerticeEdicion(latlng) {
  const marcador = L.marker(latlng, {
    draggable: true,
    icon: L.divIcon({ className: "marcador-vertice-edicion", iconSize: [22, 22] })
  }).addTo(mapa);
  marcador.on("drag", () => {
    edicionPoligono.capa.setLatLngs(edicionPoligono.marcadores.map((m) => m.getLatLng()));
    actualizarMedidasEdicionPoligono();
  });
  return marcador;
}

function iniciarEdicionPoligono(feature) {
  elFicha.classList.add("oculto");
  // Reusa el mismo "semáforo" que ya usa la captura de vértices a mano
  // (ver más abajo) para bloquear otros clicks sobre el mapa mientras se
  // edita — un valor que no es "mapa" ni "gps", así que no dispara nada
  // de esa lógica, solo aprovecha los "if (modoCaptura !== null) return"
  // que ya protegen los clicks sobre lotes/catastro en el resto de la app.
  setModoCaptura("editando-poligono");

  const anillo = verticesUnicos(feature.geometry.coordinates[0]);
  const latlngs = anillo.map(([lon, lat]) => [lat, lon]);

  const capa = L.polygon(latlngs, {
    color: "#c1663f",
    weight: 3,
    dashArray: "6 4",
    fillOpacity: 0.15
  }).addTo(mapa);

  // Tocar el contorno (o el relleno) del lote selecciona el lado más
  // cercano al toque — así funciona el modo "Tocar en el mapa" del
  // bloque de abajo. stopPropagation para que no le llegue también al
  // listener global del mapa (aunque ese ya no hace nada con
  // modoCaptura distinto de null, es más prolijo cortarlo acá).
  capa.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    seleccionarLado(ladoMasCercano(e.latlng));
  });

  // edicionPoligono se arma ANTES de crear los marcadores porque
  // crearMarcadorVerticeEdicion cablea el evento "drag" contra él.
  edicionPoligono = { feature, capa, marcadores: [] };
  edicionPoligono.marcadores = latlngs.map((latlng) => crearMarcadorVerticeEdicion(latlng));

  ladoSeleccionado = null;
  fijarModoSeleccionLado("tocar");
  actualizarMedidasEdicionPoligono();
  elEditorPoligonoError.classList.add("oculto");
  elEditorPoligonoBarra.classList.remove("oculto");
}

document.getElementById("btn-editar-forma-lote").addEventListener("click", () => {
  if (!getLoteSeleccionado()) return;
  iniciarEdicionPoligono(getLoteSeleccionado());
});

elBtnSimplificarForma.addEventListener("click", () => {
  if (!edicionPoligono) return;
  // El índice de lado seleccionado deja de tener sentido — la cantidad
  // de vértices cambia, así que se limpia la selección en vez de
  // arriesgarse a que quede apuntando a un lado distinto del que se ve.
  ladoSeleccionado = null;
  reemplazarVerticesEdicionPoligono(verticesSimplificados(edicionPoligono.marcadores));
  actualizarMedidasEdicionPoligono();
});

// Ajustar un lado puntual a su medida real: en vez de una medida
// "promedio" (el viejo enfoque de rectángulo mínimo, que no tenía
// mucho sentido para un lote triangular o irregular — pedido explícito
// a partir de un caso real, Manzana 18 Lote 5), se elige un lado
// concreto del polígono (tocándolo en el mapa o de una lista) y se
// escribe su medida real. La esquina en el otro extremo del lado queda
// fija; la esquina de este extremo se corre en línea recta sobre la
// misma dirección que ya tenía el lado, hasta la nueva distancia —
// mismo resultado que arrastrarla a mano hasta ese punto exacto, pero
// preciso en vez de a ojo. Funciona igual para cualquier forma
// (triángulo, rectángulo, lo que sea), porque no depende de ninguna
// noción de "rectángulo mínimo": solo mueve un vértice a lo largo de
// una dirección ya existente.
elBtnAplicarLado.addEventListener("click", () => {
  if (!edicionPoligono || ladoSeleccionado === null) return;
  elEditorPoligonoError.classList.add("oculto");

  const nuevaLongitud = parseFloat(elInputLadoNuevo.value);
  if (!(nuevaLongitud > 0)) {
    elEditorPoligonoError.textContent = "Escribí una medida en metros mayor a 0 para aplicar.";
    elEditorPoligonoError.classList.remove("oculto");
    return;
  }

  const marcadores = edicionPoligono.marcadores;
  const n = marcadores.length;
  const i = ladoSeleccionado;
  const j = (i + 1) % n;
  const latlngI = marcadores[i].getLatLng();
  const latlngJ = marcadores[j].getLatLng();

  const mPorGradoLat = 111320;
  const mPorGradoLon = 111320 * Math.cos(aRadianes(latlngI.lat));
  const dx = (latlngJ.lng - latlngI.lng) * mPorGradoLon;
  const dy = (latlngJ.lat - latlngI.lat) * mPorGradoLat;
  const distanciaActual = Math.hypot(dx, dy);
  if (distanciaActual === 0) {
    elEditorPoligonoError.textContent = "Las dos esquinas de este lado están en el mismo punto — arrastrá una primero.";
    elEditorPoligonoError.classList.remove("oculto");
    return;
  }

  const factor = nuevaLongitud / distanciaActual;
  const nuevoLatLng = L.latLng(latlngI.lat + (dy * factor) / mPorGradoLat, latlngI.lng + (dx * factor) / mPorGradoLon);

  marcadores[j].setLatLng(nuevoLatLng);
  edicionPoligono.capa.setLatLngs(marcadores.map((m) => m.getLatLng()));
  actualizarMedidasEdicionPoligono();
});

document.getElementById("btn-cancelar-poligono").addEventListener("click", () => {
  const feature = edicionPoligono?.feature;
  terminarEdicionPoligono();
  if (feature) mostrarFicha(feature);
});

elBtnGuardarPoligono.addEventListener("click", async () => {
  if (!edicionPoligono) return;
  const puntos = edicionPoligono.marcadores.map((m) => {
    const { lat, lng } = m.getLatLng();
    return [lng, lat];
  });
  const anillo = [...puntos, puntos[0]];
  const superficie = Math.round(areaEnM2(anillo) * 10) / 10;

  elBtnGuardarPoligono.disabled = true;
  elEditorPoligonoError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, edicionPoligono.feature.id), {
      geometry: anilloAGeometryFirestore(anillo),
      superficie_m2: superficie
    });
    const feature = edicionPoligono.feature;
    feature.properties.superficie_m2 = superficie;
    feature.geometry = { type: "Polygon", coordinates: [anillo] };
    terminarEdicionPoligono();
    mostrarFicha(feature);
    await cargarLotesDesdeFirestore();
  } catch (error) {
    elEditorPoligonoError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para editar este lote."
        : "No se pudo guardar la forma nueva.";
    elEditorPoligonoError.classList.remove("oculto");
  } finally {
    elBtnGuardarPoligono.disabled = false;
  }
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
    !getLoteSeleccionado() || !puedeEditarLote(getLoteSeleccionado())
  );
  elEditorServiciosError.classList.add("oculto");
}

elBtnEditarServicios.addEventListener("click", () => {
  const servicios = getLoteSeleccionado()?.properties?.servicios || {};
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
  if (!getLoteSeleccionado()) return;
  const servicios = {
    luz: elEditarServicioLuz.checked,
    agua: elEditarServicioAgua.checked,
    gas: elEditarServicioGas.checked,
    cloaca: elEditarServicioCloaca.checked
  };

  elBtnGuardarServicios.disabled = true;
  elEditorServiciosError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { servicios });
    getLoteSeleccionado().properties.servicios = servicios;
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
    !getLoteSeleccionado() || !puedeEditarLote(getLoteSeleccionado())
  );
  elEditorSectorError.classList.add("oculto");
}

elBtnEditarSector.addEventListener("click", () => {
  poblarSelectSector(elEditarSectorValor, getLoteSeleccionado()?.properties?.sector);
  elSector.classList.add("oculto");
  elBtnEditarSector.classList.add("oculto");
  elEditorSector.classList.remove("oculto");
  elEditarSectorValor.focus();
});

elBtnCancelarSector.addEventListener("click", cerrarEditorSector);

elBtnGuardarSector.addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const sector = elEditarSectorValor.value.trim() || null;

  elBtnGuardarSector.disabled = true;
  elEditorSectorError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { sector });
    getLoteSeleccionado().properties.sector = sector;
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
    !getLoteSeleccionado() || !puedeEditarLote(getLoteSeleccionado())
  );
  elEditorBarrioError.classList.add("oculto");
}

elBtnEditarBarrio.addEventListener("click", () => {
  poblarSelectBarrio(elEditarBarrioValor, getLoteSeleccionado()?.properties?.barrio);
  elBarrio.classList.add("oculto");
  elBtnEditarBarrio.classList.add("oculto");
  elEditorBarrio.classList.remove("oculto");
  elEditarBarrioValor.focus();
});

elBtnCancelarBarrio.addEventListener("click", cerrarEditorBarrio);

elBtnGuardarBarrio.addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const barrio = elEditarBarrioValor.value.trim() || null;

  elBtnGuardarBarrio.disabled = true;
  elEditorBarrioError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { barrio });
    getLoteSeleccionado().properties.barrio = barrio;
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
  if (!getLoteSeleccionado()) return;
  borrarLote(getLoteSeleccionado(), elBtnBorrarLote);
});

configurarVistaLista({
  db,
  doc,
  updateDoc,
  getDocs,
  query,
  collection,
  where,
  mapa,
  mostrarFicha,
  tituloLote,
  puedeEditarLote,
  puedeBorrarLote,
  borrarLote,
  cargarLotesDesdeFirestore,
  textoEstadoConVencimiento,
  renderServiciosHTML
});
configurarDashboard({ db, doc, updateDoc, increment, mapa, mostrarFicha, tituloLote });

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
  if (!getLoteSeleccionado()) return;
  const url = construirUrlComoLlegar(getLoteSeleccionado());
  window.open(url, "_blank", "noopener");
});

// "Compartir este lote": arma un link a esta misma app con "?lote=<id>"
// (ver el chequeo de ese parámetro en cargarLotesDesdeFirestore, más
// abajo) — mandado por WhatsApp a un cliente, abre la app directo en la
// ficha de ESE lote, sin que tenga que buscarlo a mano en el mapa. En
// el celular usa el selector nativo para compartir (WhatsApp, etc.) si
// está disponible; si no, copia el link al portapapeles.
const elCompartirLoteMensaje = document.getElementById("compartir-lote-mensaje");

document.getElementById("btn-compartir-lote").addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const url = `${location.origin}${location.pathname}?lote=${getLoteSeleccionado().id}`;
  const titulo = tituloLote(getLoteSeleccionado().properties);

  if (navigator.share) {
    try {
      await navigator.share({ title: `MojonApp - ${titulo}`, url });
    } catch {
      // El usuario canceló el selector de compartir, o el navegador lo
      // bloqueó — no es un error real, no hace falta avisar nada.
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(url);
    elCompartirLoteMensaje.textContent = "Link copiado.";
    elCompartirLoteMensaje.classList.remove("oculto");
    setTimeout(() => elCompartirLoteMensaje.classList.add("oculto"), 2500);
  } catch {
    // Sin permiso de portapapeles (o sin soportarlo, como algunos
    // navegadores embebidos): se deja el link a la vista, seleccionable
    // a mano, en vez de depender de prompt() — no todos los entornos lo
    // soportan (ver quirk de testing en la memoria del proyecto).
    elCompartirLoteMensaje.textContent = url;
    elCompartirLoteMensaje.classList.remove("oculto");
  }
});

iniciarEstoyYendo();

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
    // Se abre YA, en la misma continuación síncrona del login — no
    // espera a que termine cargarLotesDesdeFirestore() (dispara aparte,
    // desde onAuthStateChanged, y es un pedido real a Firestore). Abrir
    // acá evita una carrera: si se esperara a esa carga, alcanzaba a
    // pasar un instante en el que el usuario ya había navegado a otra
    // parte (la ficha de un lote, por ejemplo) y el dashboard aparecía
    // de golpe encima, tapándola. Puede arrancar mostrando números
    // desactualizados por una fracción de segundo — se refresca solo
    // cuando esa carga efectivamente termine, ver onAuthStateChanged.
    abrirPanelDashboard();
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
  setCorredorLogueado(!!usuario);
  setMiPerfil(usuario ? await resolverMiPerfil(usuario) : null);

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
    setSectoresActuales([]);
    setBarriosActuales([]);
    // Cerrar sesión apaga todas las herramientas de corredor, no solo
    // "+ Lote": sin esto, si alguien cerraba sesión con "Ver catastro
    // cercano" prendido (o cualquier otro panel abierto), el botón para
    // apagarlo desaparecía junto con el resto de la barra, pero la capa
    // seguía activa y pidiéndole datos al catastro en cada movimiento del
    // mapa, visible para cualquiera que mirara la app después.
    emitirSesionCerrada();
  }

  // Si la ficha de un lote está abierta al cambiar de sesión (login,
  // logout, o root reasignando el perfil de alguien), "Borrar lote" y
  // "Editar servicios"/"Editar sector" tienen que reflejar el permiso
  // nuevo sin esperar a que se cierre y se vuelva a abrir.
  if (getLoteSeleccionado()) {
    document.getElementById("btn-borrar-lote").classList.toggle("oculto", !puedeBorrarLote(getLoteSeleccionado()));
    document.getElementById("btn-editar-lote-completo").classList.toggle("oculto", !puedeEditarLote(getLoteSeleccionado()));
    document.getElementById("btn-editar-forma-lote").classList.toggle("oculto", !puedeEditarLote(getLoteSeleccionado()));
    elFichaInteresados.classList.toggle("oculto", !puedeEditarLote(getLoteSeleccionado()));
    cerrarEditorServicios();
    cerrarEditorSector();
    cerrarEditorBarrio();
  }

  // El alcance de la consulta a Firestore depende del permiso
  // "ver_todos_los_lotes" (ver cargarLotesDesdeFirestore): tiene que
  // volver a pedirse cada vez que cambia quién está logueado, no solo al
  // arrancar la app.
  cargarLotesDesdeFirestore().then(() => {
    abrirLoteDesdeUrlSiCorresponde();
    // Si el dashboard se abrió recién (ver formularioLogin más arriba)
    // con datos todavía viejos/vacíos, esto lo refresca con los reales
    // apenas terminan de llegar. Si para entonces ya está cerrado (el
    // usuario navegó a otra parte), no hace nada visible — recalcular
    // el contenido de un panel oculto es inofensivo.
    if (!document.getElementById("panel-dashboard").classList.contains("oculto")) renderDashboard();
  });
});

// Si la app se abrió con "?lote=<id>" (link armado por "Compartir este
// lote"), abre esa ficha directo apenas hay datos para buscarla — una
// sola vez, no cada vez que cambia la sesión (login/logout también
// disparan cargarLotesDesdeFirestore, y no hay que reabrir el deep link
// en medio de que alguien esté usando la app).
function abrirLoteDesdeUrlSiCorresponde() {
  if (getDeepLinkAbierto()) return;
  setDeepLinkAbierto(true);
  const idDesdeUrl = new URLSearchParams(location.search).get("lote");
  if (!idDesdeUrl) return;
  const feature = getLotesActuales().find((f) => f.id === idDesdeUrl);
  if (!feature) return;
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  mapa.setView([lat, lon], 19);
  mostrarFicha(feature);
}

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
onSesionCerrada(() => {
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
onSesionCerrada(() => {
  elFormManzana.classList.add("oculto");
  limpiarFormManzana();
});

function bboxDelMapaVisible() {
  const b = mapa.getBounds();
  return `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
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

// Al elegir una parcela encontrada, se precarga en el formulario "+ Lote"
// de siempre (en vez de guardarla directo) para que el corredor pueda
// revisar o completar estado/precio/observaciones antes de guardar — y
// para reusar ese único camino de guardado, ya probado.
function cargarParcelaEnFormLote(feature) {
  // Las llamadas desde "+ Manzana"/"+ Parcela" (San Luis, sin tocar en
  // este cambio) pasan la parcela cruda sin normalizar — se normaliza
  // acá mismo si hace falta, para no tener que tocar esos otros dos
  // call sites.
  const datos = feature.properties._mojon || normalizarParcelaSanLuis(feature).properties._mojon;
  const anillo = primerAnilloDeGeometria(feature.geometry);

  elLoteManzana.value = manzanaDesdeNomenclaturaDeParcela(datos.nomenclatura) || "";
  elLoteNumero.value = datos.etiqueta || "";
  elLoteNomenclatura.value = datos.nomenclatura || "";
  poblarSelectSector(elLoteSector, null);
  poblarSelectBarrio(elLoteBarrio, null);
  elLoteSuperficie.value = datos.superficie_m2 ?? "";
  elLoteEstado.value = "disponible";
  elLotePrecio.value = "";
  elLoteObservaciones.value = `Importado del catastro de ${datos.provincia} (parcela individual).`;
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
          if (getModoCaptura() !== null) return;
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
onSesionCerrada(() => {
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

// Los tres catastros (San Luis, Córdoba, Buenos Aires) se piden en
// paralelo y se combinan — geográficamente casi nunca se superponen
// entre sí, así que el que no tiene cobertura en el área visible
// simplemente devuelve 0 parcelas, sin afectar a los otros. Si alguno
// falla (well, "throws"), no tiene que tirar abajo a los que sí
// respondieron — Promise.allSettled en vez de esperar que las tres
// promesas salgan bien.
// Tope de features por catastro: en un área densa (un pueblo entero
// visible a zoom bajo) el WFS puede devolver miles de parcelas — eso es
// lo que trababa el mapa ("quiere cargar todo y se laguea"). Con el
// zoom mínimo ya exigido (ZOOM_MINIMO_CATASTRO_CERCANO) esto rara vez
// se llega a usar, pero es un techo duro para el peor caso.
const MAX_PARCELAS_CATASTRO_CERCANO = 400;

async function pedirParcelasCatastroCercano() {
  const bbox = bboxDelMapaVisible();
  const [sanLuis, cordoba, buenosAires] = await Promise.allSettled([
    pedirWfsA(CATASTRO_WFS_URL, {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: "SanLuis:GIS_PARCELAS_VV",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      count: MAX_PARCELAS_CATASTRO_CERCANO,
      CQL_FILTER: `BBOX(GEOM,${bbox},'EPSG:4326')`
    }),
    pedirWfsA(CATASTRO_CBA_WFS_URL, {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: "idecor:parcelas_graf",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      count: MAX_PARCELAS_CATASTRO_CERCANO,
      CQL_FILTER: `BBOX(geom,${bbox},'EPSG:4326')`
    }),
    pedirWfsA(CATASTRO_BSAS_WFS_URL, {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: "idera:Parcela",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      count: MAX_PARCELAS_CATASTRO_CERCANO,
      CQL_FILTER: `BBOX(geom,${bbox},'EPSG:4326')`
    })
  ]);

  const features = [];
  if (sanLuis.status === "fulfilled") {
    features.push(
      ...sanLuis.value.filter((f) => !esParcelaDeCalle(f.properties.NOMBRE)).map(normalizarParcelaSanLuis)
    );
  }
  if (cordoba.status === "fulfilled") {
    features.push(...cordoba.value.map(normalizarParcelaCordoba));
  }
  if (buenosAires.status === "fulfilled") {
    features.push(...buenosAires.value.map(normalizarParcelaBuenosAires));
  }

  // Error real solo si LOS TRES fallaron (sin conexión, etc.) — si
  // alguno respondió, así sea con 0 parcelas (zona sin cobertura en
  // ese catastro puntual), no hace falta alarmar por eso.
  const huboErrorTotal =
    sanLuis.status === "rejected" && cordoba.status === "rejected" && buenosAires.status === "rejected";
  return { features, huboErrorTotal };
}

// Se incrementa en cada llamada a actualizarCatastroCercano() — si el
// usuario paneó de nuevo antes de que la respuesta anterior llegara
// (common paneando rápido), esa respuesta vieja ya no es la generación
// actual y se descarta en vez de dibujar una capa que no corresponde a
// dónde está parado el mapa ahora.
let generacionCatastroCercano = 0;

async function actualizarCatastroCercano() {
  if (!catastroCercanoActivo) return;

  if (mapa.getZoom() < ZOOM_MINIMO_CATASTRO_CERCANO) {
    generacionCatastroCercano++; // invalida cualquier pedido en curso de antes de alejar el zoom
    if (capaCatastroCercano) {
      mapa.removeLayer(capaCatastroCercano);
      capaCatastroCercano = null;
    }
    mostrarMensajeCatastroCercano("Acercate más en el mapa para ver las parcelas cercanas.");
    return;
  }

  const generacion = ++generacionCatastroCercano;

  // El pedido a los 3 catastros puede tardar unos segundos con
  // conexión rural — sin este aviso, el mapa se queda sin cambios
  // visibles y parece que el botón no hizo nada.
  mostrarMensajeCatastroCercano("Buscando parcelas cercanas…");
  const { features, huboErrorTotal } = await pedirParcelasCatastroCercano();

  // Llegó tarde: el mapa ya se movió de nuevo y hay un pedido más nuevo
  // en curso (o ya resuelto) — no pisarlo con esta respuesta vieja.
  if (generacion !== generacionCatastroCercano) return;

  if (huboErrorTotal) {
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
          if (getModoCaptura() !== null) return;
          L.DomEvent.stopPropagation(evento);
          cargarParcelaEnFormLote(feature);
        });
      }
    }
  ).addTo(capaCatastroCercano);

  features.forEach((feature) => {
    const anillo = primerAnilloDeGeometria(feature.geometry);
    if (!anillo || anillo.length < 3) return;
    const { lat, lon } = centroideDePoligono(anillo);
    L.marker([lat, lon], {
      icon: L.divIcon({ className: "", iconSize: [0, 0] }),
      interactive: false
    })
      .bindTooltip(feature.properties._mojon.etiqueta || "", {
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
  // Vuelve la capa de calles/localidades — mientras el catastro de
  // referencia está activo se saca (ver el "if" de abajo) para no
  // amontonar texto de los dos a la vez sobre el mapa.
  if (!mapa.hasLayer(capasReferencia)) capasReferencia.addTo(mapa);
}

elBtnVerCatastroCercano.addEventListener("click", () => {
  catastroCercanoActivo = !catastroCercanoActivo;
  elBtnVerCatastroCercano.classList.toggle("activo", catastroCercanoActivo);
  if (catastroCercanoActivo) {
    elBtnFlotanteCatastro.classList.remove("oculto");
    mapa.removeLayer(capasReferencia);
    actualizarCatastroCercano();
  } else {
    desactivarCatastroCercano();
  }
});

elBtnFlotanteCatastro.addEventListener("click", desactivarCatastroCercano);

onSesionCerrada(desactivarCatastroCercano);

// Debounce: paneando/haciendo zoom rápido, "moveend" puede disparar
// varias veces seguidas — sin esto, cada una lanzaba su propio par de
// pedidos WFS (San Luis + Córdoba) en paralelo, y ahí es donde se
// sentía pesado ("se laguea"). Se espera a que el mapa quede quieto un
// momento antes de pedir de nuevo.
let timerCatastroCercano = null;

mapa.on("moveend", () => {
  if (!catastroCercanoActivo) return;
  clearTimeout(timerCatastroCercano);
  timerCatastroCercano = setTimeout(actualizarCatastroCercano, 400);
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
  if (getModoCaptura() === "mapa") {
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
  setModoCaptura(null);
  elPanelCaptura.classList.add("oculto");
  elCapturaError.classList.add("oculto");
}

function iniciarCapturaGps() {
  setModoCaptura("gps");
  puntosCaptura = [];
  elCapturaMensaje.textContent = 'Parate en cada esquina del lote y tocá "Marcar acá".';
  elBtnCapturaAgregar.classList.remove("oculto");
  actualizarContadorCaptura();
  elFormLote.classList.add("oculto");
  elPanelCaptura.classList.remove("oculto");
}

function iniciarCapturaMapa() {
  setModoCaptura("mapa");
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
  const habiaEmpezado = getModoCaptura() !== null;
  limpiarCaptura();
  if (habiaEmpezado) elFormLote.classList.remove("oculto");
});
onSesionCerrada(limpiarCaptura);

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
  document.getElementById("vista-lista").classList.add("oculto"); // no superponer con "Ver como lista"
  document.getElementById("btn-ver-lista").classList.remove("activo");
  document.getElementById("panel-sectores").classList.add("oculto"); // ni con "Zonas"
  document.getElementById("panel-barrios").classList.add("oculto"); // ni con "Barrios"
  document.getElementById("panel-dashboard").classList.add("oculto"); // ni con "Dashboard"
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

