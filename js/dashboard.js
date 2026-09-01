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

// Techo de filas que se renderizan en "Reservas por vencer" y "Lotes
// incompletos" — a diferencia de "Más consultados"/"Con más interesados"
// (rankings, un top 5 tiene sentido de por sí), estas dos listas antes
// mostraban TODO sin límite: con una cartera grande (probado con ~120
// lotes de prueba) el panel terminaba con cientos de filas y varios
// miles de píxeles de scroll — deja de ser un resumen "de un vistazo"
// para pasar a ser, en la práctica, la misma lista completa de "Ver como
// lista" pero sin filtros. El contador del título sigue mostrando el
// total real (no el techo), y de acá para abajo del techo se linkea a
// "Ver como lista" en vez de intentar mostrar todo acá.
const MAX_FILAS_LISTA = 5;

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

// "y N más" al pie de una lista recortada por MAX_FILAS_LISTA — lleva a
// "Ver como lista" (con el filtro de estado ya aplicado si corresponde,
// ej. "reservado") en vez de intentar mostrar cientos de filas acá
// mismo. Reusa el botón/select que ya existen en vez de importar nada
// de vista-lista.js — mismo criterio que el resto del dashboard, que
// manipula esos ids de forma directa para cerrar/abrir paneles.
function filaVerTodos(cantidad, estadoFiltro) {
  const li = document.createElement("li");
  li.className = "dashboard-ver-todos";
  li.textContent = `Ver los ${cantidad} en la lista completa →`;
  li.addEventListener("click", () => {
    elPanelDashboard.classList.add("oculto");
    if (estadoFiltro) {
      const elFiltroEstado = document.getElementById("filtro-estado");
      elFiltroEstado.value = estadoFiltro;
      elFiltroEstado.dispatchEvent(new Event("change"));
    }
    document.getElementById("btn-ver-lista").click();
  });
  return li;
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

// Actualiza el contador de una sección ("Reservas por vencer  3") — se
// oculta con 0, un contador en cero no suma nada que el texto de
// "vacío" de esa lista no diga ya.
function actualizarContador(id, cantidad) {
  const el = document.getElementById(id);
  el.textContent = cantidad;
  el.classList.toggle("oculto", cantidad === 0);
}

// Fila de lista clickeable, con el título del lote y lo que sea que va
// del lado derecho (badge, chips, texto) — mismo armado en las 5 listas
// del dashboard, con o sin medalla de ranking.
function filaLote(feature, contenidoDerecha, { rango } = {}) {
  const li = document.createElement("li");
  const grupo = document.createElement("span");
  grupo.className = "dashboard-lote-titulo-grupo";
  if (rango != null) {
    const elRango = document.createElement("span");
    elRango.className = "dashboard-rango";
    elRango.textContent = rango;
    grupo.appendChild(elRango);
  }
  const elTitulo = document.createElement("span");
  elTitulo.className = "dashboard-lote-titulo";
  elTitulo.textContent = tituloLote(feature.properties);
  grupo.appendChild(elTitulo);
  li.appendChild(grupo);
  li.appendChild(contenidoDerecha);
  li.addEventListener("click", () => irAFichaDesdeDashboard(feature));
  return li;
}

export function renderDashboard() {
  const m = calcularMetricasDashboard();
  const total = getLotesActuales().length;

  const elInventario = document.getElementById("dashboard-inventario");
  elInventario.innerHTML = `
    <div class="dashboard-tarjeta total"><strong>${total}</strong><span>Total</span></div>
    <div class="dashboard-tarjeta disponible"><strong>${m.inventario.disponible}</strong><span>Disponible</span></div>
    <div class="dashboard-tarjeta reservado"><strong>${m.inventario.reservado}</strong><span>Reservado</span></div>
    <div class="dashboard-tarjeta vendido"><strong>${m.inventario.vendido}</strong><span>Vendido</span></div>
  `;

  // Barra de composición: mismo dato que las tarjetas de arriba, en
  // proporción. Sin lotes cargados no hay nada que proporcionar — se
  // deja vacía en vez de dividir por cero.
  const elComposicion = document.getElementById("dashboard-composicion");
  elComposicion.innerHTML =
    total === 0
      ? ""
      : ["disponible", "reservado", "vendido"]
          .filter((estado) => m.inventario[estado] > 0)
          .map((estado) => `<span class="${estado}" style="width:${(m.inventario[estado] / total) * 100}%"></span>`)
          .join("");

  const elReservas = document.getElementById("dashboard-reservas");
  elReservas.innerHTML = "";
  m.reservas.slice(0, MAX_FILAS_LISTA).forEach(({ feature, dias }) => {
    const vencida = dias < 0;
    const urgente = !vencida && dias <= 3;
    const badge = document.createElement("span");
    badge.className = `dashboard-badge${vencida ? " vencida" : urgente ? " urgente" : ""}`;
    badge.textContent = vencida ? `vencida hace ${Math.abs(dias)} d.` : dias === 0 ? "vence hoy" : `vence en ${dias} d.`;
    elReservas.appendChild(filaLote(feature, badge));
  });
  if (m.reservas.length > MAX_FILAS_LISTA) elReservas.appendChild(filaVerTodos(m.reservas.length, "reservado"));
  document.getElementById("dashboard-reservas-vacio").classList.toggle("oculto", m.reservas.length > 0);
  actualizarContador("dashboard-reservas-contador", m.reservas.length);

  const elIncompletos = document.getElementById("dashboard-incompletos");
  elIncompletos.innerHTML = "";
  m.incompletos.slice(0, MAX_FILAS_LISTA).forEach((feature) => {
    const chips = document.createElement("span");
    chips.className = "dashboard-chips";
    if (!(feature.properties.fotos && feature.properties.fotos.length > 0)) {
      chips.innerHTML += `<span class="dashboard-chip-falta">Sin foto</span>`;
    }
    if (feature.properties.precio_usd == null) {
      chips.innerHTML += `<span class="dashboard-chip-falta">Sin precio</span>`;
    }
    elIncompletos.appendChild(filaLote(feature, chips));
  });
  if (m.incompletos.length > MAX_FILAS_LISTA) elIncompletos.appendChild(filaVerTodos(m.incompletos.length, null));
  document.getElementById("dashboard-incompletos-vacio").classList.toggle("oculto", m.incompletos.length > 0);
  actualizarContador("dashboard-incompletos-contador", m.incompletos.length);

  const elConsultados = document.getElementById("dashboard-consultados");
  elConsultados.innerHTML = "";
  m.consultados.forEach((feature, i) => {
    const dato = document.createElement("span");
    dato.className = "dashboard-lote-dato";
    dato.textContent = `${feature.properties.vistas} vistas`;
    elConsultados.appendChild(filaLote(feature, dato, { rango: i + 1 }));
  });
  document.getElementById("dashboard-consultados-vacio").classList.toggle("oculto", m.consultados.length > 0);

  const elInteresados = document.getElementById("dashboard-interesados");
  elInteresados.innerHTML = "";
  m.conInteresados.forEach((feature, i) => {
    const cantidad = feature.properties.interesados.length;
    const dato = document.createElement("span");
    dato.className = "dashboard-lote-dato";
    dato.textContent = `${cantidad} interesado${cantidad === 1 ? "" : "s"}`;
    elInteresados.appendChild(filaLote(feature, dato, { rango: i + 1 }));
  });
  document.getElementById("dashboard-interesados-vacio").classList.toggle("oculto", m.conInteresados.length > 0);

  // Barra comparativa de precio por zona, en proporción a la zona más
  // cara de la tabla (no a un techo fijo) — así siempre hay al menos
  // una barra llena del todo, sea cual sea el rango de precios real.
  const elPreciosCuerpo = document.getElementById("dashboard-precios-zona-cuerpo");
  elPreciosCuerpo.innerHTML = "";
  const promedioMaximo = Math.max(0, ...m.precioPorZona.map((z) => z.promedio));
  m.precioPorZona.forEach(({ zona, cantidad, promedio }) => {
    const fila = document.createElement("tr");
    const ancho = promedioMaximo > 0 ? (promedio / promedioMaximo) * 100 : 0;
    fila.innerHTML = `<td>${zona}</td><td>${cantidad}</td><td><div class="dashboard-precio-celda"><div class="dashboard-precio-bar-track"><div class="dashboard-precio-bar-fill" style="width:${ancho}%"></div></div><span>USD ${Math.round(
      promedio
    ).toLocaleString("es-AR")}</span></div></td>`;
    elPreciosCuerpo.appendChild(fila);
  });
  document.getElementById("dashboard-precios-zona-vacio").classList.toggle("oculto", m.precioPorZona.length > 0);
}
