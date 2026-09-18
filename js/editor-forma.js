// ---------------------------------------------------------------------------
// Ajustar la forma de un lote ya cargado: el catastro puede traer un
// polígono más chico que el terreno real (caso real: un lote que en
// los papeles medía menos que el terreno de verdad) — pedido explícito
// para poder arrastrar cada esquina directo sobre el mapa, con
// superficie/frente/largo recalculados EN VIVO mientras se mueve, no
// solo al soltar.
//
// mapa/mostrarFicha/cargarLotesDesdeFirestore/anilloAGeometryFirestore
// todavía viven en app.js (Mapa y Ficha no son módulos separados en este
// punto de la modularización) — se inyectan por parámetro vía
// configurarEditorForma() para evitar una dependencia circular.
// ---------------------------------------------------------------------------

import {
  areaEnM2,
  medidasFrenteYLargo,
  longitudLadoEnMetros,
  distanciaPuntoASegmentoPx,
  verticesUnicos,
  verticesSimplificados,
  verticesCasiColineales,
  aRadianes
} from "./geometria.js";
import { getLoteSeleccionado, setModoCaptura, onSesionCerrada } from "./estado.js";
import { registrarAuditoria } from "./auditoria.js";

const COLECCION_LOTES = "lotes";

let db, doc, updateDoc, mapa, mostrarFicha, tituloLote, cargarLotesDesdeFirestore, anilloAGeometryFirestore;

// app.js llama esto una sola vez, antes de usar cualquier otra función de
// este módulo.
export function configurarEditorForma(deps) {
  ({ db, doc, updateDoc, mapa, mostrarFicha, tituloLote, cargarLotesDesdeFirestore, anilloAGeometryFirestore } = deps);
}

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
  document.getElementById("ficha-lote").classList.add("oculto");
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
    elEditorPoligonoError.textContent = "Escribe una medida en metros mayor a 0 para aplicar.";
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
    const superficieAnterior = edicionPoligono.feature.properties.superficie_m2;
    await updateDoc(doc(db, COLECCION_LOTES, edicionPoligono.feature.id), {
      geometry: anilloAGeometryFirestore(anillo),
      superficie_m2: superficie
    });
    registrarAuditoria({
      accion: "editar_lote",
      objetoId: edicionPoligono.feature.id,
      objetoTitulo: tituloLote(edicionPoligono.feature.properties),
      detalle: `Ajustó la forma (superficie: ${superficieAnterior ?? "?"} → ${superficie} m²)`
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
        ? "No tienes permiso para editar este lote."
        : "No se pudo guardar la forma nueva.";
    elEditorPoligonoError.classList.remove("oculto");
  } finally {
    elBtnGuardarPoligono.disabled = false;
  }
});
