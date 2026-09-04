// ---------------------------------------------------------------------------
// Favoritos: un comprador anónimo puede marcar lotes para volver a verlos
// después, sin necesidad de cuenta — se guardan en localStorage del propio
// navegador (solo ese dispositivo, no sincroniza entre dispositivos ni pasa
// por Firestore). Mismo criterio que cualquier portal real (LandWatch,
// Idealista): el ❤️ de un listado no depende de estar logueado.
//
// `mapa`, `mostrarFicha` y `tituloLote` se reciben por parámetro
// (configurarFavoritos), mismo patrón que dashboard.js/crm.js — viven en
// mapa.js/ficha.js, y ficha.js importa esFavorito()/alternarFavorito() de
// acá directo: inyectar por parámetro evita la dependencia circular.
// ---------------------------------------------------------------------------

import { getLotesActuales } from "./estado.js";
import { centroideDePoligono } from "./geometria.js";

const CLAVE_LOCALSTORAGE = "mojonapp_favoritos";

function leerFavoritos() {
  try {
    const crudo = localStorage.getItem(CLAVE_LOCALSTORAGE);
    const lista = crudo ? JSON.parse(crudo) : [];
    return Array.isArray(lista) ? lista : [];
  } catch {
    // Navegador con localStorage bloqueado (privado a rajatabla, cuota
    // llena, etc.) — sin favoritos en vez de romper la app.
    return [];
  }
}

function guardarFavoritos(lista) {
  try {
    localStorage.setItem(CLAVE_LOCALSTORAGE, JSON.stringify(lista));
  } catch {
    // Si no se puede guardar, la UI de esta sesión igual refleja el
    // estado en memoria — no revienta, solo no persiste al recargar.
  }
}

export function esFavorito(loteId) {
  return leerFavoritos().includes(loteId);
}

// Devuelve el nuevo estado (true = quedó guardado, false = se sacó) para
// que quien llama pueda actualizar su propio botón sin tener que
// preguntar de nuevo.
export function alternarFavorito(loteId) {
  const lista = leerFavoritos();
  const yaEstaba = lista.includes(loteId);
  guardarFavoritos(yaEstaba ? lista.filter((id) => id !== loteId) : [...lista, loteId]);
  return !yaEstaba;
}

let mapa, mostrarFicha, tituloLote;

export function configurarFavoritos(deps) {
  ({ mapa, mostrarFicha, tituloLote } = deps);
}

const elPanel = document.getElementById("panel-favoritos");
const elBtnAbrir = document.getElementById("btn-abrir-favoritos");
const elLista = document.getElementById("lista-favoritos");
const elVacio = document.getElementById("favoritos-vacio");

// Mismo criterio que irAFichaDesdeDashboard (dashboard.js): centra el
// mapa primero para que la ficha no se abra sobre un punto fuera de la
// vista actual.
function irALoteDesdeFavoritos(feature) {
  elPanel.classList.add("oculto");
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  mapa.setView([lat, lon], 19);
  mostrarFicha(feature);
}

function renderFavoritos() {
  const ids = leerFavoritos();
  const lotesPorId = new Map(getLotesActuales().map((f) => [f.id, f]));
  // Un favorito guardado hace tiempo puede apuntar a un lote que ya no
  // está cargado (se borró, o esta pestaña todavía no bajó el catálogo
  // completo) — se muestra solo lo que hoy existe de verdad, no un id
  // suelto sin nada que abrir.
  const lotes = ids.map((id) => lotesPorId.get(id)).filter(Boolean);

  elLista.innerHTML = "";
  lotes.forEach((feature) => {
    const li = document.createElement("li");

    const grupo = document.createElement("span");
    grupo.className = "dashboard-lote-titulo-grupo";
    const titulo = document.createElement("span");
    titulo.className = "dashboard-lote-titulo";
    titulo.textContent = tituloLote(feature.properties);
    grupo.appendChild(titulo);
    li.appendChild(grupo);
    li.addEventListener("click", () => irALoteDesdeFavoritos(feature));

    const botonQuitar = document.createElement("button");
    botonQuitar.type = "button";
    botonQuitar.className = "favorito-quitar";
    botonQuitar.textContent = "×";
    botonQuitar.setAttribute("aria-label", `Quitar ${tituloLote(feature.properties)} de favoritos`);
    botonQuitar.addEventListener("click", (evento) => {
      evento.stopPropagation(); // no abrir la ficha al tocar "quitar"
      alternarFavorito(feature.id);
      renderFavoritos();
    });
    li.appendChild(botonQuitar);

    elLista.appendChild(li);
  });

  elVacio.classList.toggle("oculto", lotes.length > 0);
}

elBtnAbrir.addEventListener("click", () => {
  document.getElementById("vista-lista").classList.add("oculto");
  document.getElementById("btn-ver-lista").classList.remove("activo");
  document.getElementById("panel-admin")?.classList.add("oculto");
  document.getElementById("panel-sectores")?.classList.add("oculto");
  document.getElementById("panel-barrios")?.classList.add("oculto");
  document.getElementById("panel-dashboard")?.classList.add("oculto");
  document.getElementById("panel-crm")?.classList.add("oculto");
  document.getElementById("ficha-lote").classList.add("oculto");
  renderFavoritos();
  elPanel.classList.remove("oculto");
});

document.getElementById("cerrar-panel-favoritos").addEventListener("click", () => {
  elPanel.classList.add("oculto");
});

// Cualquier otra navegación desde el menú lateral cierra este panel
// primero — mismo criterio que dashboard.js/crm.js.
document.getElementById("drawer-menu").addEventListener("click", (evento) => {
  const boton = evento.target.closest(".drawer-item");
  if (boton && boton.id !== "btn-abrir-favoritos") {
    elPanel.classList.add("oculto");
  }
});
