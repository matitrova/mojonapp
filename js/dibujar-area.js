// ---------------------------------------------------------------------------
// "Dibujar área" (idea #5): tocar el mapa para marcar los vértices de un
// área a mano y dejar solo los lotes que caen adentro bien visibles (los
// de afuera quedan tenues, no desaparecen — da contexto, mismo criterio
// que un mapa de búsqueda real). Mismo patrón de captura que "Cargar a
// mano → en el mapa" (cargar-lote.js), pero acá filtra lotes ya cargados
// en vez de crear uno nuevo.
//
// `mapa` y las funciones de filtro viven en mapa.js — se importan directo
// (no hace falta inyección por parámetro: mapa.js no necesita nada de
// acá, así que no hay dependencia circular).
// ---------------------------------------------------------------------------

import { mapa, filtrarLotesPorArea, limpiarFiltroPorArea } from "./mapa.js";
import { areaEnM2 } from "./geometria.js";
import { getModoCaptura, setModoCaptura, onSesionCerrada } from "./estado.js";

const elPanel = document.getElementById("panel-dibujar-area");
const elContador = document.getElementById("dibujar-area-contador");
const elError = document.getElementById("dibujar-area-error");
const elBtnDeshacer = document.getElementById("btn-dibujar-area-deshacer");
const elBtnAplicar = document.getElementById("btn-dibujar-area-aplicar");
const elChip = document.getElementById("chip-filtro-area");
const elChipTexto = document.getElementById("chip-filtro-area-texto");

let puntos = []; // [[lat, lon], ...]
let marcadores = [];
let linea = null;
let listenerClickMapa = null;

function actualizarContador() {
  const n = puntos.length;
  let texto = `${n} punto${n === 1 ? "" : "s"} marcado${n === 1 ? "" : "s"}`;
  if (n >= 3) {
    const anillo = [...puntos, puntos[0]].map(([lat, lon]) => [lon, lat]);
    texto += ` — ~${Math.round(areaEnM2(anillo))} m²`;
  }
  elContador.textContent = texto;
  if (linea) mapa.removeLayer(linea);
  if (puntos.length >= 2) {
    linea = L.polygon(puntos, {
      color: "#c1663f",
      weight: 2,
      dashArray: "6 4",
      fillOpacity: 0.08
    }).addTo(mapa);
  } else {
    linea = null;
  }
}

function agregarPunto(lat, lon) {
  puntos.push([lat, lon]);
  const marcador = L.circleMarker([lat, lon], {
    radius: 6,
    color: "#fff",
    weight: 2,
    fillColor: "#c1663f",
    fillOpacity: 1
  }).addTo(mapa);
  marcadores.push(marcador);
  elError.classList.add("oculto");
  actualizarContador();
}

function deshacerUltimoPunto() {
  puntos.pop();
  const marcador = marcadores.pop();
  if (marcador) mapa.removeLayer(marcador);
  actualizarContador();
}

function limpiarCaptura() {
  marcadores.forEach((m) => mapa.removeLayer(m));
  marcadores = [];
  if (linea) mapa.removeLayer(linea);
  linea = null;
  puntos = [];
  if (listenerClickMapa) {
    mapa.off("click", listenerClickMapa);
    listenerClickMapa = null;
  }
  setModoCaptura(null);
  elPanel.classList.add("oculto");
  elError.classList.add("oculto");
}

function iniciarCaptura() {
  if (getModoCaptura() !== null) return; // no interferir si hay otra captura en curso
  setModoCaptura("dibujando-area");
  puntos = [];
  actualizarContador();
  elPanel.classList.remove("oculto");
  document.getElementById("drawer-menu").classList.add("oculto");
  document.getElementById("drawer-overlay").classList.add("oculto");

  listenerClickMapa = (evento) => agregarPunto(evento.latlng.lat, evento.latlng.lng);
  mapa.on("click", listenerClickMapa);
}

function textoResultado(cantidad) {
  if (cantidad === 0) return "Ningún lote cargado cae en esta área";
  return `${cantidad} lote${cantidad === 1 ? "" : "s"} en el área`;
}

document.getElementById("btn-dibujar-area").addEventListener("click", iniciarCaptura);

elBtnDeshacer.addEventListener("click", deshacerUltimoPunto);

elBtnAplicar.addEventListener("click", () => {
  if (puntos.length < 3) {
    elError.textContent = "Hacen falta al menos 3 puntos.";
    elError.classList.remove("oculto");
    return;
  }
  const cantidad = filtrarLotesPorArea(puntos);
  limpiarCaptura();
  elChipTexto.textContent = textoResultado(cantidad);
  elChip.classList.remove("oculto");
});

document.getElementById("cerrar-dibujar-area").addEventListener("click", limpiarCaptura);

document.getElementById("btn-quitar-filtro-area").addEventListener("click", () => {
  limpiarFiltroPorArea();
  elChip.classList.add("oculto");
});

// Cerrar sesión no debería dejar la captura a medio hacer, ni el filtro
// puesto con lotes de una sesión que ya no es la actual — mismo criterio
// que cargar-lote.js/editor-forma.js.
onSesionCerrada(() => {
  limpiarCaptura();
  limpiarFiltroPorArea();
  elChip.classList.add("oculto");
});
