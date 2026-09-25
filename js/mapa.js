// ---------------------------------------------------------------------------
// Mapa base (Leaflet + capa satelital Esri), la capa de lotes cargados
// (leerlos de Firestore y dibujarlos) y "Ver catastro cercano" — viven
// juntos en este módulo porque cargarLotesDesdeFirestore() necesita
// conocer el estado de "catastro cercano" (lo saca del mapa un instante
// mientras redibuja, para no trabar el navegador con las dos capas
// reconstruyéndose a la vez).
//
// `mostrarFicha`/`contenidoTooltipLote` todavía viven en app.js (Ficha no
// es un módulo separado en este punto de la modularización) — se
// inyectan por parámetro vía configurarMapa() para evitar una
// dependencia circular. `mapa`, `cargarLotesDesdeFirestore` y
// `anilloAGeometryFirestore` sí se exportan: son la base que necesita
// prácticamente cualquier otro módulo de la app.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  ZOOM_MINIMO_ENCUADRE,
  ZOOM_AL_ENFOCAR_UN_GRUPO,
  centroDelGrupoMasNumeroso,
  convieneEnfocarUnGrupo,
  desplazamientoPorHojaAbierta
} from "./encuadre-mapa.js";
import {
  collection,
  onSnapshot,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { centroideDePoligono } from "./geometria.js";
import {
  CATASTRO_WFS_URL,
  CATASTRO_CBA_WFS_URL,
  CATASTRO_BSAS_WFS_URL,
  pedirWfsA,
  esParcelaDeCalle,
  normalizarParcelaSanLuis,
  normalizarParcelaCordoba,
  normalizarParcelaBuenosAires,
  primerAnilloDeGeometria
} from "./catastro-normalizacion.js";
import {
  getMiPerfil,
  getLotesActuales,
  getContactosActuales,
  setLotesActuales,
  getModoCaptura,
  onSesionCerrada,
  getCorredorLogueado
} from "./estado.js";
import { pintarEstadoVacio } from "./estado-vacio.js";
import { esRootActual, tienePermiso } from "./permisos.js";
import { actualizarVistaLista } from "./vista-lista.js";
import { bboxDelMapaVisible, cargarParcelaEnFormLote } from "./cargar-lote.js";
// "Interés del CRM" (idea propia #5, ver más abajo) — crm-datos.js y
// crm-metricas.js no dependen de este módulo (ni de ficha.js/crm.js),
// así que importarlos acá de una sola dirección no crea ningún ciclo.
import { cargarContactos } from "./crm-datos.js";
import { interesPorLote } from "./crm-metricas.js";
// Calce de la foto satelital. calce-aplicar.js no importa nada de acá,
// así que no hay ciclo; a calce-panel.js se le pasa el seguimiento por
// inyección justamente para no tener que importarlo al revés.
import { capaConMargen, seguirElCalce } from "./calce-aplicar.js";
import { configurarCalce } from "./calce-panel.js";

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

let mostrarFicha, contenidoTooltipLote;

// app.js llama esto una sola vez, antes de tocar un lote en el mapa.
export function configurarMapa(deps) {
  ({ mostrarFicha, contenidoTooltipLote } = deps);
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
// EL VALOR ES 17, Y ANTES ERA 18. Vale la pena contar por qué, porque
// el 18 se había verificado bien y aun así estaba roto.
//
// La verificación original bajó tiles reales para Carpintería/Merlo
// (donde estaban los lotes cargados) y encontró foto real en zoom 18 y
// el cartel de "Map data not yet available" (2521 bytes exactos) recién
// en 19. Todo correcto — pero medido en UN SOLO lugar. El resto de San
// Luis corta un nivel antes:
//
//     Potrero de los Funes    foto hasta z=17
//     Villa Mercedes          foto hasta z=17
//     San Luis capital        foto hasta z=17
//     Carpintería/Merlo       foto hasta z=18
//
// O sea que con maxNativeZoom 18, en Potrero, Villa Mercedes o la
// capital el mapa se llenaba de "Map data not yet available" EN ZOOM 18
// — que es el zoom con el que arranca la app (ver setView acá abajo).
// Reportado por el usuario como "se rompe el mapa cuando haces mucho
// zoom".
//
// LO QUE HACE ESTO DIFÍCIL DE VER: Esri devuelve el cartel con HTTP 200,
// no con un 404. Para Leaflet es un tile que cargó bien, así que no hay
// error en la consola, no falla ninguna petición y maxNativeZoom no
// tiene forma de detectarlo solo. Solo se ve mirando la pantalla o
// pesando el archivo (el cartel siempre pesa 2521 bytes; una foto de
// verdad, 13-22 KB). Por eso hay un test que lo pesa: ver
// tests/test_tiles_satelitales.py.
//
// EL COSTO de bajar a 17 es que en Carpintería/Merlo la imagen se ve un
// poco más blanda de lo estrictamente necesario (se agranda el tile de
// 17 en vez de usar el de 18 que ahí sí existe). Se compararon las dos
// en pantalla: la diferencia es chica. Que tres de las cuatro zonas
// donde se vende queden en gris, no.
export const mapa = L.map("mapa", { zoomControl: true, maxZoom: 24 }).setView([-32.34715, -65.01300], 18);

// LA FOTO VIVE EN SU PROPIO PANE, y no en el de siempre, para poder
// CORRERLA sin mover nada más.
//
// La foto satelital no coincide con el catastro: hasta 20-25 metros de
// diferencia en algunas zonas de San Luis (verificado el 2026-09-18
// dibujando las mismas parcelas sobre OpenStreetMap, donde calzan, y
// sobre Esri, donde no). Lo que está mal es la foto — las parcelas son
// el dato legal del catastro provincial y los lotes se dibujaron contra
// ellas —, así que se corrige la foto y nunca los datos.
//
// Un pane propio es lo que permite eso: se le pone un transform de CSS
// con los píxeles de corrección y se mueve SOLO la imagen. Los
// polígonos de lotes, las parcelas del catastro y los marcadores viven
// en los panes de siempre y no se enteran. Ver js/calce-imagen.js para
// el cálculo y js/calce-panel.js para el control.
//
// El zIndex 199 lo deja abajo de todo lo dibujado (el pane de overlays
// es 400) y arriba del fondo del mapa.
export const PANE_FOTO = "foto-satelital";
mapa.createPane(PANE_FOTO).style.zIndex = 199;

// Capa satelital gratuita (Esri World Imagery, sin API key).
// Si más adelante contratan un proveedor con mejor resolución (Mapbox, Google Maps
// Platform, etc.), la capa se cambia acá: reemplazar la URL y el "attribution".
// capaConMargen y no L.tileLayer: carga un poco más allá de lo visible,
// así al correr la foto para calzarla no queda una franja gris sin
// imagen en el borde contrario.
capaConMargen(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 24,
    maxNativeZoom: 17,
    pane: PANE_FOTO,
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics"
  }
).addTo(mapa);

// Deja la foto calzada con el catastro en esta zona, y la mantiene así
// al moverse y al hacer zoom (la corrección está en metros, y los
// metros son distinta cantidad de píxeles en cada zoom).
// Se exporta para que el panel de calibración lo reciba por inyección y
// para poder probarlo sin pasar por la UI (tests/test_calce_en_el_mapa.py).
export const calceDelMapa = seguirElCalce(mapa, PANE_FOTO);
configurarCalce(calceDelMapa);

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

// Acá vivía el filtro por área dibujada a mano ("Dibujar área"), dado
// de baja a pedido del usuario junto con js/dibujar-area.js.

// Un documento de Firestore es {geometry, ...propiedades} (ver
// formularioLote.addEventListener("submit", ...) en cargar-lote.js). Se
// reconstruye como Feature GeoJSON para reusar el resto del código
// (ficha, centroide, "estoy yendo"), que ya trabaja con esa forma.
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
export function anilloAGeometryFirestore(anillo) {
  return {
    type: "Polygon",
    coordinates: anillo.map(([lon, lat]) => ({ lon, lat }))
  };
}

// Abre el cartel (tooltip) de un lote puntual sin tocar la ficha — lo usa
// "modo embed" (ver ficha.js) para marcar cuál es el lote elegido sobre
// el mapa sin abrir el panel completo, que en un iframe chico tapa casi
// toda la vista.
export function abrirTooltipDeLote(loteId) {
  if (!capaLotes) return;
  capaLotes.eachLayer((capa) => {
    if (capa.feature?.id === loteId) capa.openTooltip();
  });
}

export function docALoteFeature(doc) {
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

// La escucha abierta sobre los lotes, y qué consulta está escuchando.
//
// POR QUÉ UNA ESCUCHA Y NO UN getDocs POR CARGA. Firestore cobra POR
// DOCUMENTO leído del servidor, 50.000 por día en el plan gratuito, y
// esta función trae la cartera entera. Medido el 2026-09-25: con 180
// lotes son 181 lecturas por carga de página, o sea 276 cargas al día
// para TODA la agencia antes de que la app empiece a responder 429 a
// los clientes. Y desde que el catálogo y las páginas de lote son
// públicas, cada comprador que abre un link también las paga.
//
// Con onSnapshot y la caché persistente (ver js/firebase-config.js) el
// SDK guarda un token y en las cargas siguientes le pide al servidor
// nada más que lo que CAMBIÓ. Un corredor que abre la app veinte veces
// al día pasa de 20×N a N.
//
// Y de regalo: lo que carga un corredor aparece solo en la pantalla del
// otro, sin recargar.
let desuscribirDeLosLotes = null;
let queEstaEscuchando = null;

/**
 * Deja la app escuchando los lotes y devuelve una promesa que se resuelve
 * con la primera tanda dibujada.
 *
 * SE CONSERVA LA PROMESA porque siete lugares la esperan con await
 * después de crear, editar o borrar un lote.
 *
 * SI YA ESTÁ ESCUCHANDO LO MISMO, resuelve enseguida y NO vuelve a
 * suscribirse — suscribirse de nuevo relee los N documentos del servidor
 * y sería pagar todo otra vez, justo lo que esto vino a evitar.
 *
 * Y resolver enseguida es correcto, no un atajo: Firestore dispara el
 * snapshot local APENAS se escribe, antes del viaje al servidor (eso es
 * la "compensación de latencia"). O sea que para cuando un
 * `await updateDoc(...)` terminó, el redibujo ya pasó.
 */
export function cargarLotesDesdeFirestore() {
  // Un corredor sin "ver_todos_los_lotes" solo trae lo suyo — root, y
  // cualquiera sin sesión (el catálogo público), siguen viendo todo.
  const restringirAPropios = !!getMiPerfil() && !esRootActual() && !tienePermiso("ver_todos_los_lotes");
  const clave = restringirAPropios ? `propios:${auth.currentUser.uid}` : "todos";

  if (desuscribirDeLosLotes && queEstaEscuchando === clave) return Promise.resolve();

  // Cambió a qué tiene derecho esta persona (resolvió la sesión, entró o
  // salió): se corta la escucha vieja antes de abrir la nueva.
  if (desuscribirDeLosLotes) {
    desuscribirDeLosLotes();
    desuscribirDeLosLotes = null;
  }
  queEstaEscuchando = clave;

  if (!primeraCargaDeLotesHecha) elMensajeCargaInicial.classList.remove("oculto");

  const consulta = restringirAPropios
    ? query(collection(db, COLECCION_LOTES), where("creado_por", "==", auth.currentUser.uid))
    : collection(db, COLECCION_LOTES);

  return new Promise((resolver, rechazar) => {
    let esLaPrimera = true;
    desuscribirDeLosLotes = onSnapshot(
      consulta,
      (snapshot) => {
        // QUEDA ANOTADO DE DÓNDE VINO ESTA TANDA. Firestore cobra los
        // documentos que vienen del SERVIDOR; los que salen de la caché
        // son gratis. Sin esto no hay forma de comprobar desde afuera si
        // la caché está funcionando: la app se ve igual en los dos
        // casos, y el día que alguien saque persistentLocalCache la
        // cuenta se duplica en silencio. Mismo criterio que el
        // dataset.encuadre de más abajo.
        const contenedor = mapa.getContainer();
        contenedor.dataset.lotesDeLaCache = snapshot.metadata.fromCache ? "1" : "0";
        contenedor.dataset.lotesCambiados = String(snapshot.docChanges().length);
        dibujarLotes(snapshot.docs.map(docALoteFeature));
        if (esLaPrimera) {
          esLaPrimera = false;
          resolver();
        }
      },
      (error) => {
        // Se limpia para que un reintento posterior pueda volver a
        // suscribirse en vez de creer que ya está escuchando.
        desuscribirDeLosLotes = null;
        queEstaEscuchando = null;
        elMensajeCargaInicial.classList.add("oculto");
        if (esLaPrimera) {
          esLaPrimera = false;
          rechazar(error);
        }
      }
    );
  });
}

function dibujarLotes(features) {
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

  // EL ENCUADRE, SOLO LA PRIMERA VEZ.
  //
  // Antes esto corría en cada carga, y cada carga era un getDocs
  // disparado a mano. Desde que hay una escucha viva, "cada carga" pasó
  // a ser "cada cambio de cualquiera": si otro corredor edita un lote
  // desde su compu, a vos se te movía el mapa de abajo del mouse
  // mientras lo estabas mirando. Encuadrar es una decisión de ARRANQUE
  // ("mostrame la cartera"), no algo que haya que rehacer porque cambió
  // un precio.
  if (features.length > 0 && !primeraCargaDeLotesHecha) {
    // maxZoom explícito: si el contenedor del mapa todavía no tiene un
    // tamaño real en este instante (puede pasar, esta llamada es lo
    // primero que corre la app apenas responde Firestore), Leaflet
    // calcula mal el zoom que hace falta para encuadrar y termina
    // clavado en el maxZoom del mapa (24) — un solo lote de golpe
    // aislado en una esquina, imagen satelital reventada de borrosa.
    // Reproducido de forma consistente en pruebas. 18 alcanza de sobra
    // para encuadrar cualquier cartera real de lotes de un corredor.
    //
    // animate: false — la app dispara DOS cargas de lotes en paralelo al
    // arrancar (ver abrirLoteDesdeUrlSiCorresponde en ficha.js), y cada
    // una llama a este fitBounds. Si el fitBounds de una carga queda
    // todavía animando (transición de zoom en curso) cuando la otra
    // carga llama a mapa.setView() para enfocar un lote puntual
    // (deep-link "?lote=", o "modo embed"), Leaflet ignora en silencio
    // el zoom pedido por ese setView — el mapa se queda en el zoom del
    // fitBounds en vez de enfocar el lote. Reproducido de forma
    // consistente: con animate:false en AMBAS llamadas (acá y en
    // ficha.js) cada cambio de vista se aplica de una, sin animación en
    // curso que pueda pisarse con la siguiente.
    //
    // Si los lotes están tan desparramados que para que entren todos
    // habría que alejarse más allá de ZOOM_MINIMO_ENCUADRE, se enfoca el
    // grupo más numeroso: alejarse tanto deja cada lote del tamaño de un
    // punto y el mapa se ve vacío aunque esté todo dibujado (ver
    // js/encuadre-mapa.js, que explica el caso real que lo motivó).
    //
    // Ojo con el orden: getBoundsZoom depende del tamaño del contenedor,
    // y cuando el contenedor todavía mide 0×0 devuelve el maxZoom del
    // mapa (24) — o sea que cae en la rama de fitBounds, que es la que
    // ya sabía convivir con ese caso. Bien así: la rama nueva solo entra
    // cuando el tamaño es real y los lotes están de verdad dispersos.
    encuadrarEnLosLotes();
    // Queda anotado cuál de las dos ramas encuadró. Sirve para dos
    // cosas: explicar en vivo por qué el mapa abrió donde abrió, y que
    // el test pueda afirmar que el encuadre efectivamente corrió. Sin
    // esto, un test que mire solo el zoom pasa igual si el encuadre
    // nunca se ejecutó (el mapa se queda en el zoom del setView inicial,
    // que ya es cerca) — un verde que no prueba nada.
    // ¿El contenedor tenía tamaño de verdad cuando se encuadró?
    //
    // POR QUÉ IMPORTA. Los lotes se cargan apenas responde Firestore, y
    // eso puede pasar con el mapa ESCONDIDO — por ejemplo si la app se
    // abrió directo en /lotes. Ahí el contenedor mide 0x0, Leaflet
    // calcula cualquier cosa, y al volver al mapa con la flecha ← se
    // veía la vista por defecto sobre El Desaguadero: foto satelital
    // pelada, ni un lote, y la sensación de que la cartera está vacía.
    // Queda anotado para que al entrar al mapa se pueda rehacer (ver
    // reencuadrarSiHizoFaltaTamano).
    const tam = mapa.getSize();
    mapa.getContainer().dataset.encuadreSinTamano = tam.x < 50 || tam.y < 50 ? "1" : "0";
  }

  if (habiaCatastroCercano) capaCatastroCercano.addTo(mapa);

  // Terminó de cargar y no hay ni un lote: el mapa se ve como una foto
  // satelital cualquiera y no hay forma de saber si falta cargar o si la
  // app falló. El texto y los botones los decide js/estado-vacio.js
  // según haya sesión o no.
  const elMapaVacio = document.getElementById("mapa-vacio");
  elMapaVacio.classList.toggle("oculto", features.length > 0);
  if (features.length === 0) {
    pintarEstadoVacio(elMapaVacio, {
      pantalla: "mapa",
      conSesion: getCorredorLogueado(),
      puedeCargar: tienePermiso("cargar_lote")
    });
  }

  elMensajeCargaInicial.classList.add("oculto");
  primeraCargaDeLotesHecha = true;
}

// app.js dispara la primera carga real recién después de configurarMapa()
// (necesita mostrarFicha/contenidoTooltipLote ya inyectados) — ver
// iniciarMapa() más abajo. Se devuelve la promesa: app.js la encadena con
// abrirLoteDesdeUrlSiCorresponde() para reaplicar el centrado del deep
// link si ESTA carga (la que pinta rápido, sin esperar la sesión) termina
// después que la de onAuthStateChanged — ver el comentario en esa función.
export function iniciarMapa() {
  return cargarLotesDesdeFirestore().catch((error) => {
    console.error("No se pudieron cargar los lotes desde Firestore:", error);
    // Si la primera carga falla, no dejar el aviso de "Cargando…" pegado
    // para siempre — mejor un mensaje de error concreto que uno que
    // sugiere que todavía está en curso.
    elMensajeCargaInicial.textContent = "No se pudieron cargar los lotes. Recargá la página para reintentar.";
  });
}

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
    mostrarMensajeCatastroCercano("No se pudo cargar el catastro cercano ahora. Prueba de nuevo en un momento.");
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

// ---------------------------------------------------------------------------
// "Interés del CRM" en el mapa (idea propia #5 de "el mapa como una
// cualidad del CRM"): resalta, no filtra — los lotes sin interés se ven
// exactamente igual que siempre, no se pierde nada de vista. Un pin
// chico con la cantidad de contactos ACTIVOS interesados (interesPorLote
// en crm-metricas.js) sobre cada lote que corresponda; tocarlo abre la
// ficha real, igual que tocar el polígono. Mismo patrón que "Ver
// catastro cercano": botón del drawer + botón flotante para apagarlo
// rápido, apagado solo al cerrar sesión.
// ---------------------------------------------------------------------------

const elBtnVerInteresCrm = document.getElementById("btn-ver-interes-crm");
const elBtnFlotanteInteresCrm = document.getElementById("btn-flotante-interes-crm");
let interesCrmActivo = false;
let capaInteresCrm = null;

async function activarInteresCrm() {
  await cargarContactos();
  const interes = interesPorLote(getContactosActuales());
  const marcadores = getLotesActuales()
    .filter((f) => interes[f.id] > 0)
    .map((f) => {
      const { lat, lon } = centroideDePoligono(f.geometry.coordinates[0]);
      const cantidad = interes[f.id];
      const marcador = L.marker([lat, lon], {
        icon: L.divIcon({ className: "marcador-interes-crm", html: `<span>${cantidad}</span>`, iconSize: [22, 22] })
      });
      marcador.on("click", () => mostrarFicha(f));
      return marcador;
    });
  if (capaInteresCrm) mapa.removeLayer(capaInteresCrm);
  capaInteresCrm = L.layerGroup(marcadores).addTo(mapa);
}

function desactivarInteresCrm() {
  interesCrmActivo = false;
  elBtnVerInteresCrm.classList.remove("activo");
  elBtnFlotanteInteresCrm.classList.add("oculto");
  if (capaInteresCrm) {
    mapa.removeLayer(capaInteresCrm);
    capaInteresCrm = null;
  }
}

elBtnVerInteresCrm.addEventListener("click", async () => {
  interesCrmActivo = !interesCrmActivo;
  elBtnVerInteresCrm.classList.toggle("activo", interesCrmActivo);
  if (interesCrmActivo) {
    elBtnFlotanteInteresCrm.classList.remove("oculto");
    await activarInteresCrm();
  } else {
    desactivarInteresCrm();
  }
});

elBtnFlotanteInteresCrm.addEventListener("click", desactivarInteresCrm);

onSesionCerrada(desactivarInteresCrm);

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
  return [document.getElementById("ficha-lote"), document.getElementById("form-lote")].some(
    (el) => !el.classList.contains("oculto")
  );
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


/**
 * Centra el mapa en un punto DEJÁNDOLO A LA VISTA.
 *
 * Reemplaza a mapa.setView([lat, lon], zoom) en todos los lugares que
 * abren una ficha o un formulario: esas hojas tapan desde abajo hasta el
 * 70% de la pantalla, así que un punto "centrado" queda detrás de la
 * hoja y el mapa parece haberse ido para arriba (ver
 * desplazamientoPorHojaAbierta en js/encuadre-mapa.js).
 *
 * Se mide la hoja que está abierta EN ESTE MOMENTO, no un valor fijo:
 * la ficha, el formulario de carga y el editor de forma tienen alturas
 * distintas, y además cambian con el contenido.
 */
export function centrarDejandoVer(lat, lon, zoom) {
  mapa.setView([lat, lon], zoom, { animate: false });

  const hoja = [...document.querySelectorAll(".hoja-inferior")].find(
    (el) => !el.classList.contains("oculto")
  );
  if (!hoja) return;

  const desplazamiento = desplazamientoPorHojaAbierta(
    hoja.getBoundingClientRect().height,
    mapa.getSize().y
  );
  // panBy positivo en Y corre la vista hacia abajo, o sea que el
  // contenido (y el lote) sube: justo lo que hace falta para sacarlo de
  // atrás de la hoja.
  if (desplazamiento > 0) mapa.panBy([0, desplazamiento], { animate: false });
}

/**
 * Encuadra el mapa sobre los lotes cargados.
 *
 * Separada de la carga para poder repetirla: la primera vez puede correr
 * con el mapa escondido y el contenedor en 0x0 (ver
 * reencuadrarSiHizoFaltaTamano al final del archivo).
 *
 * Si los lotes están tan desparramados que para que entren todos habría
 * que alejarse más allá de ZOOM_MINIMO_ENCUADRE, enfoca el grupo más
 * numeroso: alejarse tanto deja cada lote del tamaño de un punto y el
 * mapa se ve vacío aunque esté todo dibujado (ver js/encuadre-mapa.js,
 * que explica el caso real que lo motivó).
 */
function encuadrarEnLosLotes() {
  const limites = capaLotes.getBounds();
  const centroDelGrupo = convieneEnfocarUnGrupo(mapa.getBoundsZoom(limites, false, L.point(20, 20)))
    ? centroDelGrupoMasNumeroso(
        capaLotes.getLayers().map((capaDeUnLote) => capaDeUnLote.getBounds().getCenter())
      )
    : null;
  if (centroDelGrupo) mapa.setView(centroDelGrupo, ZOOM_AL_ENFOCAR_UN_GRUPO, { animate: false });
  else mapa.fitBounds(limites, { padding: [20, 20], maxZoom: 18, animate: false });

  // Queda anotado cuál de las dos ramas encuadró. Sirve para dos cosas:
  // explicar en vivo por qué el mapa abrió donde abrió, y que el test
  // pueda afirmar que el encuadre efectivamente corrió. Sin esto, un
  // test que mire solo el zoom pasa igual si el encuadre nunca se
  // ejecutó — un verde que no prueba nada.
  mapa.getContainer().dataset.encuadre = centroDelGrupo ? "grupo-mas-numeroso" : "todos-los-lotes";
}

/**
 * Rehace el encuadre si la primera vez se hizo con el mapa escondido.
 *
 * EL BUG QUE ARREGLA: entrando directo a /lotes (o recargando ahí) y
 * volviendo al mapa con la flecha ←, el mapa aparecía sobre El
 * Desaguadero sin un solo lote dibujado en pantalla. La misma pantalla
 * mostraba dos encuadres distintos según cómo se llegara, y uno de los
 * dos no mostraba nada.
 *
 * La causa: los lotes llegan de Firestore apenas arranca la app, y si en
 * ese momento el mapa está escondido su contenedor mide 0x0 — Leaflet
 * encuadra sobre la nada. Al mostrarlo, nadie volvía a encuadrar.
 *
 * Se llama al entrar a la sección mapa, después de invalidateSize().
 */
export function reencuadrarSiHizoFaltaTamano() {
  const contenedor = mapa.getContainer();
  if (contenedor.dataset.encuadreSinTamano !== "1") return false;
  if (!capaLotes || capaLotes.getLayers().length === 0) return false;
  const tam = mapa.getSize();
  // Sigue sin tamaño: no se gana nada y se perdería la anotación.
  if (tam.x < 50 || tam.y < 50) return false;
  encuadrarEnLosLotes();
  return true;
}
