// ---------------------------------------------------------------------------
// Dashboard: aterrizaje al iniciar sesión (ver formularioLogin en app.js).
// Todo se calcula al vuelo a partir de getLotesActuales() (ya en memoria por
// cargarLotesDesdeFirestore) — no le pide nada nuevo a Firestore, así que
// abrir el dashboard es instantáneo.
//
// `mapa`, `mostrarFicha` y `tituloLote` los recibe este módulo por
// parámetro desde app.js (configurarDashboard) en vez de importarlos
// directo: viven en app.js/mapa.js/ficha.js, que todavía no existen como
// módulos separados en este punto de la modularización — inyectarlos evita
// una dependencia circular mientras tanto.
// ---------------------------------------------------------------------------

import { getLotesActuales } from "./estado.js";
import { centroideDePoligono } from "./geometria.js";

const COLECCION_LOTES = "lotes";

let db, doc, updateDoc, increment, mapa, mostrarFicha, tituloLote;

// app.js llama esto una sola vez, antes de usar cualquier otra función de
// este módulo.
export function configurarDashboard(deps) {
  ({ db, doc, updateDoc, increment, mapa, mostrarFicha, tituloLote } = deps);
}

// Contador de "más consultados" para el dashboard — sube en Firestore
// cada vez que se abre la ficha de un lote, para cualquiera que la abra
// (con o sin sesión: el interés real de un comprador anónimo importa
// tanto como el de un corredor mirando su propia cartera). Deliberadamente
// "fire and forget": no bloquea ni se le avisa nada al usuario si falla
// (por ejemplo, si todavía no se pegó la regla nueva en Firebase
// Console) — es una métrica de fondo, no algo crítico para poder ver
// la ficha. Actualiza también la copia en memoria (lotesActuales), así
// el dashboard ve el número nuevo sin tener que releer Firestore si se
// abre en la misma sesión después de mirar algunas fichas.
export function registrarVistaDeLote(feature) {
  updateDoc(doc(db, COLECCION_LOTES, feature.id), { vistas: increment(1) }).catch(() => {});
  feature.properties.vistas = (feature.properties.vistas || 0) + 1;
}

const elPanelDashboard = document.getElementById("panel-dashboard");
const elBtnAbrirDashboard = document.getElementById("btn-abrir-dashboard");

export function abrirPanelDashboard() {
  document.getElementById("vista-lista").classList.add("oculto");
  document.getElementById("btn-ver-lista").classList.remove("activo");
  document.getElementById("panel-admin").classList.add("oculto");
  document.getElementById("panel-sectores").classList.add("oculto");
  document.getElementById("panel-barrios").classList.add("oculto");
  document.getElementById("ficha-lote").classList.add("oculto");
  renderDashboard();
  elPanelDashboard.classList.remove("oculto");
}

elBtnAbrirDashboard.addEventListener("click", abrirPanelDashboard);
document.getElementById("cerrar-panel-dashboard").addEventListener("click", () => {
  elPanelDashboard.classList.add("oculto");
});

// Cualquier navegación desde el menú lateral (Cargar lote, +Manzana,
// Ver catastro cercano, Seguridad, etc.) cierra el dashboard primero —
// un solo listener delegado en vez de acordarse de agregarlo a mano en
// cada botón nuevo del drawer. Hace falta de verdad: el dashboard tiene
// más z-index que las "hojas inferiores" (ficha, formularios), así que
// sin esto se quedaba tapando cualquiera de esas por encima.
document.getElementById("drawer-menu").addEventListener("click", (evento) => {
  const boton = evento.target.closest(".drawer-item");
  if (boton && boton.id !== "btn-abrir-dashboard") {
    elPanelDashboard.classList.add("oculto");
  }
});

// Lleva directo a la ficha de un lote puntual desde una fila del
// dashboard (reservas por vencer, incompletos, rankings) — mismo criterio
// que abrir desde "Ver como lista": centra el mapa primero para que la
// ficha no se abra sobre un punto fuera de la vista actual.
function irAFichaDesdeDashboard(feature) {
  elPanelDashboard.classList.add("oculto");
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  mapa.setView([lat, lon], 19);
  mostrarFicha(feature);
}

function calcularMetricasDashboard() {
  const lotes = getLotesActuales();

  const inventario = { disponible: 0, reservado: 0, vendido: 0 };
  lotes.forEach((f) => {
    const estado = f.properties.estado;
    if (estado in inventario) inventario[estado]++;
  });

  const hoy = new Date().toISOString().slice(0, 10);
  const reservas = lotes
    .filter((f) => f.properties.estado === "reservado" && f.properties.reservado_hasta)
    .map((f) => {
      const dias = Math.round(
        (new Date(`${f.properties.reservado_hasta}T00:00:00`) - new Date(`${hoy}T00:00:00`)) / 86400000
      );
      return { feature: f, dias };
    })
    .sort((a, b) => a.dias - b.dias);

  const incompletos = lotes.filter(
    (f) => !(f.properties.fotos && f.properties.fotos.length > 0) || f.properties.precio_usd == null
  );

  const consultados = lotes
    .filter((f) => (f.properties.vistas || 0) > 0)
    .sort((a, b) => (b.properties.vistas || 0) - (a.properties.vistas || 0))
    .slice(0, 5);

  const conInteresados = lotes
    .filter((f) => (f.properties.interesados || []).length > 0)
    .sort((a, b) => (b.properties.interesados || []).length - (a.properties.interesados || []).length)
    .slice(0, 5);

  // Precio promedio por zona: solo entra un lote si tiene precio Y zona
  // cargados — un lote sin zona no puede agruparse en ningún lado, y uno
  // sin precio arruinaría el promedio del resto de su zona.
  const acumuladoPorZona = {};
  lotes.forEach((f) => {
    const { sector, precio_usd } = f.properties;
    if (!sector || precio_usd == null) return;
    if (!acumuladoPorZona[sector]) acumuladoPorZona[sector] = { suma: 0, cantidad: 0 };
    acumuladoPorZona[sector].suma += Number(precio_usd);
    acumuladoPorZona[sector].cantidad++;
  });
  const precioPorZona = Object.entries(acumuladoPorZona)
    .map(([zona, { suma, cantidad }]) => ({ zona, cantidad, promedio: suma / cantidad }))
    .sort((a, b) => b.promedio - a.promedio);

  return { inventario, reservas, incompletos, consultados, conInteresados, precioPorZona };
}

export function renderDashboard() {
  const m = calcularMetricasDashboard();

  const elInventario = document.getElementById("dashboard-inventario");
  elInventario.innerHTML = `
    <div class="dashboard-tarjeta"><strong>${getLotesActuales().length}</strong><span>Total</span></div>
    <div class="dashboard-tarjeta"><strong>${m.inventario.disponible}</strong><span>Disponible</span></div>
    <div class="dashboard-tarjeta"><strong>${m.inventario.reservado}</strong><span>Reservado</span></div>
    <div class="dashboard-tarjeta"><strong>${m.inventario.vendido}</strong><span>Vendido</span></div>
  `;

  const elReservas = document.getElementById("dashboard-reservas");
  elReservas.innerHTML = "";
  m.reservas.forEach(({ feature, dias }) => {
    const li = document.createElement("li");
    const vencida = dias < 0;
    li.innerHTML = `<span class="dashboard-lote-titulo">${tituloLote(feature.properties)}</span><span class="dashboard-lote-dato${
      vencida ? " texto-vencido" : ""
    }">${vencida ? `vencida hace ${Math.abs(dias)} d.` : dias === 0 ? "vence hoy" : `vence en ${dias} d.`}</span>`;
    li.addEventListener("click", () => irAFichaDesdeDashboard(feature));
    elReservas.appendChild(li);
  });
  document.getElementById("dashboard-reservas-vacio").classList.toggle("oculto", m.reservas.length > 0);

  const elIncompletos = document.getElementById("dashboard-incompletos");
  elIncompletos.innerHTML = "";
  m.incompletos.forEach((feature) => {
    const faltantes = [];
    if (!(feature.properties.fotos && feature.properties.fotos.length > 0)) faltantes.push("sin foto");
    if (feature.properties.precio_usd == null) faltantes.push("sin precio");
    const li = document.createElement("li");
    li.innerHTML = `<span class="dashboard-lote-titulo">${tituloLote(feature.properties)}</span><span class="dashboard-lote-dato">${faltantes.join(
      ", "
    )}</span>`;
    li.addEventListener("click", () => irAFichaDesdeDashboard(feature));
    elIncompletos.appendChild(li);
  });
  document.getElementById("dashboard-incompletos-vacio").classList.toggle("oculto", m.incompletos.length > 0);

  const elConsultados = document.getElementById("dashboard-consultados");
  elConsultados.innerHTML = "";
  m.consultados.forEach((feature) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="dashboard-lote-titulo">${tituloLote(feature.properties)}</span><span class="dashboard-lote-dato">${
      feature.properties.vistas
    } vistas</span>`;
    li.addEventListener("click", () => irAFichaDesdeDashboard(feature));
    elConsultados.appendChild(li);
  });
  document.getElementById("dashboard-consultados-vacio").classList.toggle("oculto", m.consultados.length > 0);

  const elInteresados = document.getElementById("dashboard-interesados");
  elInteresados.innerHTML = "";
  m.conInteresados.forEach((feature) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="dashboard-lote-titulo">${tituloLote(feature.properties)}</span><span class="dashboard-lote-dato">${
      feature.properties.interesados.length
    } interesado${feature.properties.interesados.length === 1 ? "" : "s"}</span>`;
    li.addEventListener("click", () => irAFichaDesdeDashboard(feature));
    elInteresados.appendChild(li);
  });
  document.getElementById("dashboard-interesados-vacio").classList.toggle("oculto", m.conInteresados.length > 0);

  const elPreciosCuerpo = document.getElementById("dashboard-precios-zona-cuerpo");
  elPreciosCuerpo.innerHTML = "";
  m.precioPorZona.forEach(({ zona, cantidad, promedio }) => {
    const fila = document.createElement("tr");
    fila.innerHTML = `<td>${zona}</td><td>${cantidad}</td><td>USD ${Math.round(promedio).toLocaleString("es-AR")}</td>`;
    elPreciosCuerpo.appendChild(fila);
  });
  document.getElementById("dashboard-precios-zona-vacio").classList.toggle("oculto", m.precioPorZona.length > 0);
}
