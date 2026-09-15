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

import { getLotesActuales, getContactosActuales } from "./estado.js";
import { centroideDePoligono } from "./geometria.js";
// Idea #11: "Seguimientos pendientes (CRM)" reusa el mismo criterio de
// "qué cuenta como pendiente" que la sección propia del CRM (evita que
// las dos pantallas se desincronicen), y abre el CRM directo en el
// contacto tocado. Sin dependencia circular: crm.js no importa nada de
// acá.
import { cargarContactos, contactosParaSeguimiento, abrirContactoEnCrm } from "./crm.js";
// "Ventas" (pedido explícito: que el dashboard sea información que
// ayude a vender más, no solo inventario de lotes) — reusa las mismas
// métricas/template que ya se ven en "#crm-stats" del panel CRM, sin
// dependencia circular: crm-metricas.js es lógica pura, no importa nada
// de este archivo.
import {
  calcularMetricas,
  contactosPorEtapa,
  motivosPerdidaFrecuentes,
  demandaPorZona,
  visitasDeHoy,
  htmlResumenVentas
} from "./crm-metricas.js";

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
  // Resalta "Dashboard" en la barra de secciones persistente (ver
  // index.html/app.js) — puro DOM, sin import nuevo, mismo criterio que
  // el resto de esta función para tocar elementos de otros módulos.
  document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("activo"));
  document.getElementById("nav-tab-dashboard").classList.add("activo");

  // A diferencia de getLotesActuales() (ya en memoria desde que arrancó
  // la app), los contactos del CRM recién se piden la primera vez que
  // hace falta acá — si el corredor todavía no abrió el panel CRM en
  // esta sesión, getContactosActuales() está vacío y "Seguimientos
  // pendientes" se vería vacío aunque sí tenga pendientes reales. Se
  // pide en paralelo (no bloquea el resto del dashboard, que no depende
  // de esto) y se vuelve a renderizar solo esa sección cuando llega —
  // mismo criterio que el refresco de renderDashboard() al terminar
  // cargarLotesDesdeFirestore() en app.js.
  cargarContactos().then(() => {
    // renderDashboard() ya llama renderSeguimientosCrm()/renderVentas()
    // (y ahora también "Resumen por zona", que pasa a depender de los
    // contactos para la demanda por zona — ver demandaPorZona en
    // crm-metricas.js) — un solo re-render de todo en vez de acordarse
    // de repetir cada sección nueva que pase a depender de esto.
    if (!elPanelDashboard.classList.contains("oculto")) renderDashboard();
  });
}

elBtnAbrirDashboard.addEventListener("click", abrirPanelDashboard);
document.getElementById("cerrar-panel-dashboard").addEventListener("click", () => {
  elPanelDashboard.classList.add("oculto");
  document.getElementById("nav-tab-dashboard").classList.remove("activo");
  document.getElementById("nav-tab-mapa").classList.add("activo");
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
function irAFichaDesdeDashboard(feature, contactoOrigen = null) {
  elPanelDashboard.classList.add("oculto");
  document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("activo"));
  document.getElementById("nav-tab-mapa").classList.add("activo");
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  mapa.setView([lat, lon], 19);
  mostrarFicha(feature, contactoOrigen);
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

  // Resumen por zona (idea propia, investigada en las funcionalidades y
  // planes de Tokko Broker antes de armarla — ver
  // feedback_buscar_inspiracion_real): Tokko cobra "Emprendimientos"
  // aparte, recién desde el plan de $252.320/mes, con "visión general
  // del estado de las propiedades" como su propia descripción del
  // módulo. Acá cualquier zona/sector ya cumple ese rol (es como se
  // organiza un loteo en esta app) — no hace falta un concepto nuevo de
  // "emprendimiento", solo mostrar el desglose que ya se puede calcular
  // con lo que hay. Un lote sin zona no entra en ninguna fila (no hay
  // dónde agruparlo); dentro de una zona, uno sin precio sí cuenta para
  // el inventario pero no entra en el promedio (arruinaría el número).
  const acumuladoPorZona = {};
  lotes.forEach((f) => {
    const { sector, precio_usd, estado } = f.properties;
    if (!sector) return;
    if (!acumuladoPorZona[sector]) {
      acumuladoPorZona[sector] = { sumaPrecio: 0, cantidadConPrecio: 0, disponible: 0, reservado: 0, vendido: 0, total: 0 };
    }
    const z = acumuladoPorZona[sector];
    z.total++;
    if (estado in z) z[estado]++;
    if (precio_usd != null) {
      z.sumaPrecio += Number(precio_usd);
      z.cantidadConPrecio++;
    }
  });
  // "Interesados" (idea propia #3 de "el mapa como una cualidad del
  // CRM" — demanda por zona, no un mapa de calor geográfico: "zona" es
  // texto libre del lote, sin polígono propio para pintar algo así, ni
  // falta hace) — se mezcla en esta misma tabla en vez de armar una
  // aparte, mismo criterio de agrupación que el resto de la fila.
  const demanda = demandaPorZona(getContactosActuales());
  const resumenPorZona = Object.entries(acumuladoPorZona)
    .map(([zona, z]) => ({
      zona,
      total: z.total,
      disponible: z.disponible,
      reservado: z.reservado,
      vendido: z.vendido,
      pctVendido: z.total > 0 ? Math.round((z.vendido / z.total) * 100) : 0,
      promedio: z.cantidadConPrecio > 0 ? z.sumaPrecio / z.cantidadConPrecio : null,
      interesados: demanda[zona] || 0
    }))
    .sort((a, b) => b.total - a.total);

  return { inventario, reservas, incompletos, consultados, conInteresados, resumenPorZona };
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

// "Seguimientos pendientes (CRM)" (idea #11) — separada de
// renderDashboard() porque se refresca en un momento distinto: llega
// después de un pedido propio a Firestore (cargarContactos, ver
// abrirPanelDashboard), no junto con el resto de las métricas que ya
// están en memoria desde el arranque.
function renderSeguimientosCrm() {
  const pendientes = contactosParaSeguimiento(getContactosActuales());
  const hoy = new Date().toISOString().slice(0, 10);

  const elSeguimientos = document.getElementById("dashboard-seguimientos");
  elSeguimientos.innerHTML = "";
  pendientes.slice(0, MAX_FILAS_LISTA).forEach((contacto) => {
    const dias = Math.round(
      (new Date(`${contacto.proximo_seguimiento}T00:00:00`) - new Date(`${hoy}T00:00:00`)) / 86400000
    );
    const vencido = dias < 0;
    const urgente = !vencido && dias <= 1;

    const li = document.createElement("li");
    const grupo = document.createElement("span");
    grupo.className = "dashboard-lote-titulo-grupo";
    const titulo = document.createElement("span");
    titulo.className = "dashboard-lote-titulo";
    titulo.textContent = contacto.nombre;
    grupo.appendChild(titulo);
    li.appendChild(grupo);

    const badge = document.createElement("span");
    badge.className = `dashboard-badge${vencido ? " vencida" : urgente ? " urgente" : ""}`;
    badge.textContent = vencido
      ? `vencido hace ${Math.abs(dias)} d.`
      : dias === 0
        ? "hoy"
        : `en ${dias} d.`;
    li.appendChild(badge);

    li.addEventListener("click", () => abrirContactoEnCrm(contacto.id));
    elSeguimientos.appendChild(li);
  });
  if (pendientes.length > MAX_FILAS_LISTA) {
    const li = document.createElement("li");
    li.className = "dashboard-ver-todos";
    li.textContent = `Ver los ${pendientes.length} en el CRM →`;
    li.addEventListener("click", () => abrirContactoEnCrm(pendientes[0].id));
    elSeguimientos.appendChild(li);
  }
  document.getElementById("dashboard-seguimientos-vacio").classList.toggle("oculto", pendientes.length > 0);
  actualizarContador("dashboard-seguimientos-contador", pendientes.length);
}

// "Visitas de hoy" (idea propia #4 de "el mapa como una cualidad del
// CRM", literalmente "pineadas" — ver visitasDeHoy en crm-metricas.js):
// una fila por parada (contacto + lote de interés), y una última fila
// "Ver la ruta en el mapa" que las pinea todas juntas de una — mismo
// patrón que filaVerTodos más arriba.
let capaVisitasHoy = null;

function verVisitasEnElMapa(paradas) {
  const marcadores = paradas
    .map((parada) => {
      const feature = getLotesActuales().find((f) => f.id === parada.loteId);
      if (!feature) return null;
      const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
      return { parada, feature, marcador: L.marker([lat, lon]) };
    })
    .filter(Boolean);
  if (marcadores.length === 0) {
    window.alert("Ninguno de esos lotes existe ya.");
    return;
  }

  if (capaVisitasHoy) mapa.removeLayer(capaVisitasHoy);
  marcadores.forEach(({ parada, feature, marcador }, i) => {
    marcador.bindTooltip(`${i + 1}. ${parada.contactoNombre} — ${parada.loteTitulo}`, { permanent: false });
    marcador.on("click", () => irAFichaDesdeDashboard(feature, { id: parada.contactoId, nombre: parada.contactoNombre }));
  });
  capaVisitasHoy = L.layerGroup(marcadores.map((m) => m.marcador)).addTo(mapa);

  elPanelDashboard.classList.add("oculto");
  document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("activo"));
  document.getElementById("nav-tab-mapa").classList.add("activo");
  mapa.fitBounds(L.featureGroup(marcadores.map((m) => m.marcador)).getBounds(), { padding: [40, 40], maxZoom: 17 });
}

function renderVisitasDeHoy() {
  const paradas = visitasDeHoy(getContactosActuales());
  const elVisitas = document.getElementById("dashboard-visitas");
  elVisitas.innerHTML = "";
  paradas.forEach((parada) => {
    const li = document.createElement("li");
    const grupo = document.createElement("span");
    grupo.className = "dashboard-lote-titulo-grupo";
    const titulo = document.createElement("span");
    titulo.className = "dashboard-lote-titulo";
    titulo.textContent = `${parada.contactoNombre} — ${parada.loteTitulo}`;
    grupo.appendChild(titulo);
    li.appendChild(grupo);

    if (parada.zona) {
      const badge = document.createElement("span");
      badge.className = "dashboard-badge";
      badge.textContent = parada.zona;
      li.appendChild(badge);
    }

    li.addEventListener("click", () => {
      const feature = getLotesActuales().find((f) => f.id === parada.loteId);
      if (!feature) {
        window.alert("Este lote ya no existe.");
        return;
      }
      irAFichaDesdeDashboard(feature, { id: parada.contactoId, nombre: parada.contactoNombre });
    });
    elVisitas.appendChild(li);
  });
  if (paradas.length > 0) {
    const li = document.createElement("li");
    li.className = "dashboard-ver-todos";
    li.textContent = "Ver la ruta en el mapa →";
    li.addEventListener("click", () => verVisitasEnElMapa(paradas));
    elVisitas.appendChild(li);
  }
  document.getElementById("dashboard-visitas-vacio").classList.toggle("oculto", paradas.length > 0);
  actualizarContador("dashboard-visitas-contador", paradas.length);
}

// "Ventas" (pedido explícito del usuario: que el dashboard sea
// información que ayude a vender más, no solo inventario de lotes) —
// mismas 6 tarjetas que "#crm-stats" en el panel CRM (mismo template,
// ver htmlResumenVentas en crm-metricas.js), más embudo por etapa y
// motivos de pérdida más frecuentes (estos dos, dentro del <details>
// colapsado junto con "Más consultados"/"Con más interesados"/"Resumen
// por zona" — mismo criterio ya usado ahí: es para repasar de vez en
// cuando, no una alerta urgente que tenga que verse apenas se abre el
// panel).
function renderVentas() {
  const contactos = getContactosActuales();
  document.getElementById("dashboard-ventas-stats").innerHTML = htmlResumenVentas(calcularMetricas(contactos));

  const elEmbudo = document.getElementById("dashboard-embudo");
  elEmbudo.innerHTML = "";
  const etapas = contactosPorEtapa(contactos);
  const maxCantidad = Math.max(1, ...etapas.map((e) => e.cantidad));
  etapas.forEach(({ etiqueta, color, cantidad }) => {
    const fila = document.createElement("div");
    fila.className = "dashboard-embudo-fila";

    const elEtiqueta = document.createElement("span");
    elEtiqueta.className = "dashboard-embudo-etiqueta";
    elEtiqueta.textContent = etiqueta;
    fila.appendChild(elEtiqueta);

    const track = document.createElement("div");
    track.className = "dashboard-precio-bar-track";
    const fill = document.createElement("div");
    fill.className = "dashboard-precio-bar-fill";
    fill.style.width = `${(cantidad / maxCantidad) * 100}%`;
    fill.style.background = color;
    track.appendChild(fill);
    fila.appendChild(track);

    const elCantidad = document.createElement("span");
    elCantidad.className = "dashboard-embudo-cantidad";
    elCantidad.textContent = cantidad;
    fila.appendChild(elCantidad);

    elEmbudo.appendChild(fila);
  });

  // motivo_perdido es texto libre que escribe el corredor — textContent,
  // no innerHTML, mismo criterio que el nombre del contacto más arriba.
  const elMotivos = document.getElementById("dashboard-motivos-perdida");
  elMotivos.innerHTML = "";
  const motivos = motivosPerdidaFrecuentes(contactos);
  motivos.forEach(({ motivo, cantidad }) => {
    const li = document.createElement("li");
    const texto = document.createElement("span");
    texto.textContent = motivo;
    li.appendChild(texto);
    const badge = document.createElement("span");
    badge.className = "dashboard-badge";
    badge.textContent = cantidad;
    li.appendChild(badge);
    elMotivos.appendChild(li);
  });
  document.getElementById("dashboard-motivos-perdida-vacio").classList.toggle("oculto", motivos.length > 0);
}

export function renderDashboard() {
  const m = calcularMetricasDashboard();
  const total = getLotesActuales().length;

  renderSeguimientosCrm();
  renderVisitasDeHoy();
  renderVentas();

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

  // "Resumen por zona" (idea propia, ver comentario en
  // calcularMetricasDashboard) — la barra de precio sigue en proporción
  // a la zona más cara de la tabla (no a un techo fijo), y de paso
  // ahora suma el desglose de inventario de cada zona, mismo dato que
  // "Emprendimientos" de Tokko pero sin pagar un plan más caro por
  // verlo.
  const elPreciosCuerpo = document.getElementById("dashboard-precios-zona-cuerpo");
  elPreciosCuerpo.innerHTML = "";
  const promedioMaximo = Math.max(0, ...m.resumenPorZona.map((z) => z.promedio || 0));
  m.resumenPorZona.forEach(({ zona, total, disponible, reservado, vendido, pctVendido, promedio, interesados }) => {
    const fila = document.createElement("tr");
    const ancho = promedioMaximo > 0 && promedio ? (promedio / promedioMaximo) * 100 : 0;
    const celdaPrecio =
      promedio == null
        ? "—"
        : `<div class="dashboard-precio-celda"><div class="dashboard-precio-bar-track"><div class="dashboard-precio-bar-fill" style="width:${ancho}%"></div></div><span>USD ${Math.round(promedio).toLocaleString("es-AR")}</span></div>`;
    // "Interesados" en rojo cuando hay demanda pero nada disponible ya
    // (0 disponible) — mismo criterio de urgencia que .dashboard-badge
    // vencida: es justo la señal de "traer más inventario acá".
    const celdaInteresados =
      interesados === 0 ? "—" : `<span class="${disponible === 0 ? "texto-vencido" : ""}">${interesados}</span>`;
    fila.innerHTML = `<td>${zona}</td><td>${total}</td><td>${disponible}</td><td>${reservado}</td><td>${vendido} (${pctVendido}%)</td><td>${celdaInteresados}</td><td>${celdaPrecio}</td>`;
    elPreciosCuerpo.appendChild(fila);
  });
  document.getElementById("dashboard-precios-zona-vacio").classList.toggle("oculto", m.resumenPorZona.length > 0);
}
