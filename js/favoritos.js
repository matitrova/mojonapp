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

// ---------------------------------------------------------------------------
// Comparador (idea propia, investigada en el comparador de Trulia antes de
// armarla — ver feedback_buscar_inspiracion_real): elegir 2 a 4 favoritos y
// verlos lado a lado. Mismo criterio de "un lote sin ese dato no se
// inventa" que el resto de la app — se muestra "—", no se completa nada.
// ---------------------------------------------------------------------------

const MAX_COMPARAR = 4;
const ETIQUETA_ESTADO = { disponible: "Disponible", reservado: "Reservado", vendido: "Vendido" };
const SERVICIOS_INFO = [
  { clave: "luz", etiqueta: "Luz" },
  { clave: "agua", etiqueta: "Agua" },
  { clave: "gas", etiqueta: "Gas" },
  { clave: "cloaca", etiqueta: "Cloaca" }
];

let seleccionComparar = new Set(); // ids de lote tildados, se reinicia cada vez que se abre el panel

const elAyudaComparar = document.getElementById("favoritos-comparar-ayuda");
const elBtnComparar = document.getElementById("btn-comparar-favoritos");
const elPanelComparar = document.getElementById("panel-comparar-lotes");
const elTablaComparar = document.getElementById("tabla-comparar-lotes");

function actualizarBotonComparar() {
  const n = seleccionComparar.size;
  elBtnComparar.textContent = `Comparar (${n})`;
  elBtnComparar.classList.toggle("oculto", n < 2);
}

function formatearServicios(servicios) {
  if (servicios == null) return "—";
  return SERVICIOS_INFO.map(({ clave, etiqueta }) => `${etiqueta}: ${servicios[clave] ? "sí" : "no"}`).join(" · ");
}

function renderComparador() {
  const lotesPorId = new Map(getLotesActuales().map((f) => [f.id, f]));
  const lotes = [...seleccionComparar].map((id) => lotesPorId.get(id)).filter(Boolean);

  const filas = [
    { etiqueta: "Zona", valor: (p) => p.sector || "—" },
    { etiqueta: "Barrio", valor: (p) => p.barrio || "—" },
    { etiqueta: "Superficie", valor: (p) => (p.superficie_m2 != null ? `${p.superficie_m2} m²` : "—") },
    { etiqueta: "Estado", valor: (p) => ETIQUETA_ESTADO[p.estado] || p.estado || "—" },
    { etiqueta: "Precio", valor: (p) => (p.precio_usd != null ? `USD ${Number(p.precio_usd).toLocaleString("es-AR")}` : "—") },
    { etiqueta: "Servicios", valor: (p) => formatearServicios(p.servicios) }
  ];

  const filaTitulos = lotes
    .map(
      (feature) =>
        `<th><button type="button" class="comparar-lote-titulo">${tituloLote(feature.properties)}</button><br><button type="button" class="comparar-quitar">Quitar ×</button></th>`
    )
    .join("");

  elTablaComparar.innerHTML = `
    <thead><tr><th></th>${filaTitulos}</tr></thead>
    <tbody>
      ${filas
        .map(
          ({ etiqueta, valor }) =>
            `<tr><th>${etiqueta}</th>${lotes.map((f) => `<td>${valor(f.properties)}</td>`).join("")}</tr>`
        )
        .join("")}
    </tbody>
  `;
  // El HTML de arriba es texto plano (innerHTML) — los listeners se
  // enganchan acá, no se pueden poner "adentro" del template.
  elTablaComparar.querySelectorAll(".comparar-lote-titulo").forEach((boton, i) => {
    boton.addEventListener("click", () => irALoteDesdeFavoritos(lotes[i]));
  });
  elTablaComparar.querySelectorAll(".comparar-quitar").forEach((boton, i) => {
    boton.addEventListener("click", () => {
      seleccionComparar.delete(lotes[i].id);
      if (seleccionComparar.size < 2) {
        elPanelComparar.classList.add("oculto");
      } else {
        renderComparador();
      }
      actualizarBotonComparar();
    });
  });
}

elBtnComparar.addEventListener("click", () => {
  renderComparador();
  elPanelComparar.classList.remove("oculto");
});

document.getElementById("cerrar-comparar-lotes").addEventListener("click", () => {
  elPanelComparar.classList.add("oculto");
});

// Mismo criterio que irAFichaDesdeDashboard (dashboard.js): centra el
// mapa primero para que la ficha no se abra sobre un punto fuera de la
// vista actual. Cierra los dos paneles (favoritos y comparador) — puede
// llamarse desde cualquiera de los dos.
function irALoteDesdeFavoritos(feature) {
  elPanel.classList.add("oculto");
  elPanelComparar.classList.add("oculto");
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
    li.dataset.loteId = feature.id; // permite ubicar una fila puntual (tests, debug)

    const grupo = document.createElement("span");
    grupo.className = "dashboard-lote-titulo-grupo";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "favorito-comparar-check";
    check.checked = seleccionComparar.has(feature.id);
    check.setAttribute("aria-label", `Elegir ${tituloLote(feature.properties)} para comparar`);
    check.addEventListener("click", (evento) => evento.stopPropagation()); // no abrir la ficha al tildar
    check.addEventListener("change", () => {
      if (check.checked) {
        // Techo de MAX_COMPARAR: más de 4 columnas no entra cómodo en
        // una tabla comparativa — mismo criterio que cualquier
        // comparador real (Trulia, por ejemplo, también limita cuántos
        // podés comparar a la vez).
        if (seleccionComparar.size >= MAX_COMPARAR) {
          check.checked = false;
          return;
        }
        seleccionComparar.add(feature.id);
      } else {
        seleccionComparar.delete(feature.id);
      }
      actualizarBotonComparar();
    });
    grupo.appendChild(check);

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
      seleccionComparar.delete(feature.id); // no dejarlo colgado en el contador de "Comparar"
      actualizarBotonComparar();
      renderFavoritos();
    });
    li.appendChild(botonQuitar);

    elLista.appendChild(li);
  });

  elVacio.classList.toggle("oculto", lotes.length > 0);
  elAyudaComparar.classList.toggle("oculto", lotes.length < 2);
}

// Ya no esconde las otras pantallas: lo hace js/router.js antes de que
// esto corra (ver el comentario allá).
elBtnAbrir.addEventListener("click", () => {
  seleccionComparar = new Set(); // arranca sin nada tildado cada vez que se abre
  renderFavoritos();
  actualizarBotonComparar();
  elPanel.classList.remove("oculto");
});

// El ← de Favoritos lo maneja js/router.js (data-volver). El panel de
// "Comparar lotes" que se abre por encima también tiene
// .panel-pantalla-completa, así que el router lo esconde junto con el
// resto — no hace falta cerrarlo a mano acá.

// Cualquier otra navegación desde el menú lateral cierra este panel
// primero — mismo criterio que dashboard.js/crm.js.
document.getElementById("drawer-menu").addEventListener("click", (evento) => {
  const boton = evento.target.closest(".drawer-item");
  if (boton && boton.id !== "btn-abrir-favoritos") {
    elPanel.classList.add("oculto");
    elPanelComparar.classList.add("oculto");
  }
});
