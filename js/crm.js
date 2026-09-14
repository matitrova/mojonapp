// ---------------------------------------------------------------------------
// CRM: contactos + pipeline visual (nuevo → contactado → visita → oferta →
// cerrado/perdido). Un contacto puede tener uno o más lotes de interés
// asociados y un historial de actividades (colección Firestore "contactos",
// ver firestore.rules).
//
// "Agregar interesado" en la ficha de un lote (js/ficha.js, colección
// "lotes", array "interesados") sigue existiendo tal cual y NO depende de
// este módulo para seguir funcionando — pero además de guardarse ahí,
// crearContactoDesdeInteresado() (llamada desde ficha.js) alimenta este
// pipeline central, fire-and-forget, para que cargar un interesado desde
// la ficha sea la MISMA acción que darlo de alta acá, sin que nadie tenga
// que cargarlo dos veces.
//
// `mapa`, `mostrarFicha` y `tituloLote` los recibe este módulo por
// parámetro (configurarCrm), igual que dashboard.js — viven en
// mapa.js/ficha.js, y ficha.js importa crearContactoDesdeInteresado() de
// acá: inyectar por parámetro en vez de `import` evita la dependencia
// circular entre los dos módulos. `permisos.js` sí se importa directo:
// no depende de crm.js, así que no hay riesgo de ciclo ahí.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  doc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getContactosActuales, getLotesActuales, getModoVista, setModoVista } from "./estado.js";
import { centroideDePoligono } from "./geometria.js";
import { registrarAuditoria } from "./auditoria.js";
// Primera etapa de la modularización de este archivo (venía con 1643
// líneas) — constantes y lógica pura sin Firestore/DOM, movidas a su
// propio módulo testeable. Ver el plan en curso.
import {
  ETAPAS,
  ETIQUETA_ETAPA,
  COLOR_ETAPA,
  ETIQUETA_ACTIVIDAD,
  DIAS_ESTANCADO,
  HORAS_SIN_ATENDER,
  colorAvatar,
  iniciales,
  estaEstancado,
  estaSinAtender,
  ultimaActividad,
  calificacionContacto,
  valorPotencialContacto,
  formatoUsdCompacto,
  calcularMetricas
} from "./crm-metricas.js";
// tests/test_crm_round_robin.py importa elegirMenosCargado de crm.js (no
// se movió ese test, solo la función) — reexportada para no romperlo.
export { elegirMenosCargado } from "./crm-metricas.js";
// Segunda etapa de la modularización: capa de datos (Firestore), sin DOM.
// crm.js reexporta crearContactoDesdeInteresado/cargarContactos para que
// ficha.js/dashboard.js/vista-lista.js sigan importándolas de acá sin
// cambiar nada.
import {
  COLECCION_CONTACTOS,
  configurarDatosCrm,
  crearContactoDesdeInteresado,
  cargarContactos,
  puedeVerTodosLosContactos,
  obtenerUsuariosPorUid,
  obtenerUsuariosPorUidCache,
  textoAsignado
} from "./crm-datos.js";
export { crearContactoDesdeInteresado, cargarContactos };
// Tercera etapa: el formulario de alta/edición (con fusionar y aviso de
// duplicado adentro) — importado de una sola dirección; crm-formulario.js
// nunca importa de acá, recibe lo que necesita de este módulo por
// parámetro (configurarFormulario), así no hay ciclo.
import { configurarFormulario, mostrarForm } from "./crm-formulario.js";

// Un seguimiento agendado entra a la lista de "Seguimientos" del panel si
// ya venció o si es hoy o en los próximos N días — mismo umbral "urgente"
// que ya usa el Dashboard para reservas por vencer.
const DIAS_SEGUIMIENTO_PROXIMO = 3;

let mapa, mostrarFicha, tituloLote;

// app.js llama esto una sola vez, antes de usar cualquier otra función de
// este módulo.
export function configurarCrm(deps) {
  ({ mapa, mostrarFicha, tituloLote } = deps);
  configurarDatosCrm({ tituloLote });
  configurarFormulario({ renderTodo, mostrarKanban, irALoteDesdeCrm, tituloLote });
}

// ---------------------------------------------------------------------------
// Panel: métricas + seguimientos + barra de herramientas + kanban (vista
// principal), y el formulario de alta/edición (reemplaza al kanban, mismo
// patrón que catalogos.js/admin.js: la vista completa cambia, no un
// formulario que se abre encima).
// ---------------------------------------------------------------------------

const elPanel = document.getElementById("panel-crm");
const elBtnAbrir = document.getElementById("btn-abrir-crm");
const elVistaKanban = document.getElementById("crm-vista-kanban");
const elVistaForm = document.getElementById("crm-vista-form");
const elStats = document.getElementById("crm-stats");
const elAutomatizacion = document.getElementById("crm-automatizacion");
const elAutomatizacionTexto = document.getElementById("crm-automatizacion-texto");
const elBtnCerrarEstancados = document.getElementById("btn-cerrar-estancados");
const elRendimientoSeccion = document.getElementById("crm-rendimiento-seccion");
const elRendimientoCuerpo = document.getElementById("crm-rendimiento-cuerpo");
const elSeguimientos = document.getElementById("crm-seguimientos");
const elSeguimientosVacio = document.getElementById("crm-seguimientos-vacio");
const elSeguimientosContador = document.getElementById("crm-seguimientos-contador");
const elBuscar = document.getElementById("crm-buscar");
const elFiltroVista = document.getElementById("crm-filtro-vista");
const elBtnVistaMias = document.getElementById("btn-crm-vista-mias");
const elBtnVistaTodas = document.getElementById("btn-crm-vista-todas");
const elKanban = document.getElementById("crm-kanban");
const elVacio = document.getElementById("crm-vacio");
const elSinResultados = document.getElementById("crm-sin-resultados");
const elBtnAgregarContacto = document.getElementById("btn-agregar-contacto");
const elBtnExportar = document.getElementById("btn-exportar-contactos");
const elVolver = document.getElementById("crm-volver");
const elFiltroCalificacion = document.getElementById("crm-filtro-calificacion");
const elFiltroEtiqueta = document.getElementById("crm-filtro-etiqueta");

// Filtro de texto de la barra de herramientas (nombre o teléfono) — se
// aplica en el cliente sobre lo ya cargado, no perfora Firestore de nuevo
// por cada letra tipeada. filtroCalificacion/filtroEtiqueta son
// combinables con el texto y entre sí (ver contactosFiltrados).
let terminoBusqueda = "";
let filtroCalificacion = "";
let filtroEtiqueta = "";

function textoHaceDias(fechaIso) {
  if (!fechaIso) return "";
  const dias = Math.max(0, Math.floor((Date.now() - new Date(fechaIso).getTime()) / 86400000));
  if (dias === 0) return "Hoy";
  if (dias === 1) return "Hace 1 día";
  return `Hace ${dias} días`;
}

function textoLotesResumen(lotes) {
  if (!lotes.length) return "Sin lote de interés";
  if (lotes.length === 1) return `📍 ${lotes[0].titulo}`;
  return `📍 ${lotes[0].titulo} +${lotes.length - 1} más`;
}

// Lleva directo al lote en el mapa desde un chip de "lotes de interés" —
// mismo criterio que irAFichaDesdeDashboard (dashboard.js): centra el
// mapa primero para que la ficha no se abra sobre un punto fuera de la
// vista actual. Si el lote ya no existe (se borró después) no hay nada
// que mostrar.
function irALoteDesdeCrm(loteId) {
  const feature = getLotesActuales().find((f) => f.id === loteId);
  if (!feature) {
    window.alert("Este lote ya no existe.");
    return;
  }
  elPanel.classList.add("oculto");
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  mapa.setView([lat, lon], 19);
  mostrarFicha(feature);
}

async function moverContacto(contacto, nuevoEstado) {
  if (nuevoEstado === contacto.estado) return;

  // Perder un contacto sin dejar registrado por qué es tirar a la basura
  // el único dato que después sirve para ver patrones reales (precio,
  // financiación, se lo llevó otra inmobiliaria...) — se pregunta acá,
  // en el momento, en vez de esperar a que alguien abra el contacto y
  // complete un campo aparte (que en la práctica nunca pasa).
  let motivoPerdido = contacto.motivo_perdido || null;
  if (nuevoEstado === "perdido") {
    const respuesta = window.prompt("¿Por qué se perdió este contacto? (opcional)", "");
    if (respuesta === null) {
      // Canceló: no se mueve. Se vuelve a pintar el kanban desde el
      // estado real (todavía sin tocar) para que el <select> no quede
      // mostrando "Perdido" sin haberse aplicado de verdad.
      renderKanban();
      return;
    }
    motivoPerdido = respuesta.trim() || null;
  }

  const estadoAnterior = contacto.estado;
  const motivoAnterior = contacto.motivo_perdido || null;
  // Optimista: se pinta ya, sin esperar el updateDoc — con conexión rural
  // lenta, esperar a Firestore antes de mover la tarjeta se siente
  // trabado. Si falla, se revierte más abajo.
  contacto.estado = nuevoEstado;
  contacto.motivo_perdido = motivoPerdido;
  contacto.fecha_actualizacion = new Date().toISOString();
  renderTodo();
  try {
    await updateDoc(doc(db, COLECCION_CONTACTOS, contacto.id), {
      estado: nuevoEstado,
      motivo_perdido: motivoPerdido,
      fecha_actualizacion: contacto.fecha_actualizacion
    });
    registrarAuditoria({
      accion: "mover_contacto",
      objetoId: contacto.id,
      objetoTitulo: contacto.nombre,
      detalle: `${ETIQUETA_ETAPA[estadoAnterior]} → ${ETIQUETA_ETAPA[nuevoEstado]}${motivoPerdido ? ` (${motivoPerdido})` : ""}`
    });
  } catch (error) {
    contacto.estado = estadoAnterior;
    contacto.motivo_perdido = motivoAnterior;
    renderTodo();
    window.alert(
      error.code === "permission-denied" ? "No tenés permiso para mover contactos." : "No se pudo mover el contacto."
    );
  }
}

function tarjetaContacto(contacto) {
  const tarjeta = document.createElement("div");
  tarjeta.className = "crm-tarjeta";
  tarjeta.dataset.testid = `crm-tarjeta-${contacto.id}`;
  // Borde izquierdo del color de la etapa actual — se lee de un vistazo
  // sin depender del texto del <select>, mismo lenguaje visual que
  // Pipedrive/HubSpot (ver COLOR_ETAPA más arriba).
  tarjeta.style.setProperty("--stage-color", COLOR_ETAPA[contacto.estado] || "var(--color-borde)");

  const cabecera = document.createElement("div");
  cabecera.className = "crm-tarjeta-cabecera";

  const avatar = document.createElement("span");
  avatar.className = "crm-avatar";
  avatar.textContent = iniciales(contacto.nombre);
  avatar.style.background = colorAvatar(contacto.nombre);
  cabecera.appendChild(avatar);

  const nombre = document.createElement("p");
  nombre.className = "crm-tarjeta-nombre";
  nombre.textContent = contacto.nombre;
  cabecera.appendChild(nombre);
  tarjeta.appendChild(cabecera);

  // Calificación (idea propia, ver calificacionContacto más arriba) —
  // en su propia línea, no adentro de la cabecera: un nombre largo no
  // tiene que competir por espacio con esto para no quedar cortado.
  const calificacion = calificacionContacto(contacto);
  if (calificacion) {
    const chip = document.createElement("p");
    chip.className = `crm-calificacion crm-calificacion-${calificacion.nivel}`;
    chip.textContent = calificacion.etiqueta;
    tarjeta.appendChild(chip);
  }

  const lotes = document.createElement("p");
  lotes.className = "crm-tarjeta-lotes";
  lotes.textContent = textoLotesResumen(contacto.lotes_interes || []);
  tarjeta.appendChild(lotes);

  // Etiquetas libres, como chips chicos — mismo criterio que Trello: se
  // leen de un vistazo sin tener que abrir el contacto.
  if ((contacto.etiquetas || []).length > 0) {
    const etiquetasEl = document.createElement("div");
    etiquetasEl.className = "crm-tarjeta-etiquetas";
    contacto.etiquetas.forEach((etiqueta) => {
      const chip = document.createElement("span");
      chip.className = "crm-tarjeta-etiqueta";
      chip.textContent = etiqueta;
      etiquetasEl.appendChild(chip);
    });
    tarjeta.appendChild(etiquetasEl);
  }

  // Última actividad en una línea (idea propia, mismo criterio que
  // Pipedrive/HubSpot: se lee de un vistazo qué fue lo último que pasó,
  // sin tener que abrir el contacto). Sin actividad todavía, no se
  // muestra nada acá — "Sin atender" (más abajo) ya cubre ese caso.
  const ultima = ultimaActividad(contacto);
  if (ultima) {
    const actividad = document.createElement("p");
    actividad.className = "crm-tarjeta-ultima-actividad";
    const textoCorto = ultima.texto && ultima.texto.length > 42 ? `${ultima.texto.slice(0, 42)}…` : ultima.texto;
    actividad.textContent = `${ETIQUETA_ACTIVIDAD[ultima.tipo] || ultima.tipo}${textoCorto ? `: ${textoCorto}` : ""}`;
    tarjeta.appendChild(actividad);
  }

  // Solo en "Todos": en "Mis contactos" siempre serías vos, no aporta
  // nada aclararlo tarjeta por tarjeta.
  if (getModoVista() === "todas") {
    const asignado = document.createElement("p");
    asignado.className = "crm-tarjeta-asignado";
    asignado.textContent = `👤 ${textoAsignado(contacto)}`;
    tarjeta.appendChild(asignado);
  }

  // "Sin atender" (rojo, más urgente) y "Sin novedades" (acento, más
  // suave) — investigado en Tokko Broker antes de armarlo ("controlar
  // los tiempos de atención"), ver comentario en estaSinAtender. Los dos
  // pueden convivir en teoría, pero en la práctica no: "sin atender"
  // exige actividades.length === 0 y estado "nuevo", "estancado" mide
  // silencio DESPUÉS de la primera gestión — se muestran igual como dos
  // chips independientes por si algún día cambia el criterio de alguno.
  const badgesUrgencia = [];
  if (estaSinAtender(contacto)) {
    badgesUrgencia.push({ clase: "crm-badge-sin-atender", texto: `Sin atender +${HORAS_SIN_ATENDER}h` });
  }
  if (estaEstancado(contacto)) {
    badgesUrgencia.push({ clase: "crm-badge-estancado", texto: `Sin novedades +${DIAS_ESTANCADO}d` });
  }
  if (badgesUrgencia.length > 0) {
    const badges = document.createElement("div");
    badges.className = "crm-tarjeta-badges";
    badgesUrgencia.forEach(({ clase, texto }) => {
      const badge = document.createElement("span");
      badge.className = clase;
      badge.textContent = texto;
      badges.appendChild(badge);
    });
    tarjeta.appendChild(badges);
  }

  const pie = document.createElement("div");
  pie.className = "crm-tarjeta-pie";
  const fecha = document.createElement("span");
  fecha.className = "crm-tarjeta-fecha";
  fecha.textContent = textoHaceDias(contacto.fecha_actualizacion || contacto.fecha_creacion);
  pie.appendChild(fecha);
  tarjeta.appendChild(pie);

  // Selector de etapa directo en la tarjeta: mecanismo PRINCIPAL para
  // mover un contacto de estado (no drag-and-drop) — el drag-and-drop
  // nativo de HTML5 no funciona bien en pantallas táctiles, y esta app
  // está pensada para usarse desde el celular igual que desde escritorio.
  const selectMover = document.createElement("select");
  selectMover.className = "crm-tarjeta-mover";
  selectMover.dataset.testid = `crm-mover-${contacto.id}`;
  ETAPAS.forEach(({ clave, etiqueta }) => {
    const opcion = document.createElement("option");
    opcion.value = clave;
    opcion.textContent = etiqueta;
    if (clave === contacto.estado) opcion.selected = true;
    selectMover.appendChild(opcion);
  });
  // Evita que tocar el select también dispare el click de la tarjeta
  // (abriría el formulario de edición al mismo tiempo que se mueve de
  // etapa).
  selectMover.addEventListener("click", (evento) => evento.stopPropagation());
  selectMover.addEventListener("change", () => moverContacto(contacto, selectMover.value));
  tarjeta.appendChild(selectMover);

  tarjeta.addEventListener("click", () => mostrarForm(contacto));
  return tarjeta;
}

function contactosFiltrados() {
  const contactos = getContactosActuales();
  return contactos.filter((c) => {
    if (terminoBusqueda) {
      const coincideTexto =
        (c.nombre || "").toLowerCase().includes(terminoBusqueda) ||
        (c.telefono || "").toLowerCase().includes(terminoBusqueda);
      if (!coincideTexto) return false;
    }
    if (filtroCalificacion) {
      const calificacion = calificacionContacto(c);
      if (!calificacion || calificacion.nivel !== filtroCalificacion) return false;
    }
    if (filtroEtiqueta) {
      if (!(c.etiquetas || []).includes(filtroEtiqueta)) return false;
    }
    return true;
  });
}

// Opciones del filtro de etiquetas: la unión de todas las etiquetas que
// aparecen en los contactos ya cargados, ordenadas — se rearma cada vez
// que cambia la lista visible (no hace falta una colección aparte para
// "catálogo de etiquetas", son libres). Conserva la selección actual si
// sigue existiendo.
function poblarSelectFiltroEtiqueta() {
  const etiquetas = new Set();
  getContactosActuales().forEach((c) => (c.etiquetas || []).forEach((e) => etiquetas.add(e)));
  const opciones = [...etiquetas].sort((a, b) => a.localeCompare(b));
  elFiltroEtiqueta.innerHTML =
    `<option value="">Toda etiqueta</option>` + opciones.map((e) => `<option value="${e}">${e}</option>`).join("");
  elFiltroEtiqueta.value = opciones.includes(filtroEtiqueta) ? filtroEtiqueta : "";
  if (!opciones.includes(filtroEtiqueta)) filtroEtiqueta = "";
}

function renderKanban() {
  const contactos = getContactosActuales();
  const filtrados = contactosFiltrados();
  elVacio.classList.toggle("oculto", contactos.length > 0);
  elSinResultados.classList.toggle("oculto", contactos.length === 0 || filtrados.length > 0);
  elKanban.innerHTML = "";
  ETAPAS.forEach(({ clave, etiqueta, color }) => {
    const deEstaEtapa = filtrados.filter((c) => c.estado === clave);
    const valorColumna = deEstaEtapa.reduce((total, c) => total + valorPotencialContacto(c), 0);
    const columna = document.createElement("div");
    columna.className = "crm-columna";
    columna.dataset.testid = `crm-columna-${clave}`;
    columna.style.setProperty("--stage-color", color);

    const cabeceraColumna = document.createElement("div");
    cabeceraColumna.className = "crm-columna-cabecera";

    // Título + valor apilados en su propio grupo — así "space-between"
    // en la cabecera reparte contra el botón "+" nomás, no contra el
    // valor (que si no quedaría empujado lejos del título al que
    // pertenece).
    const grupoTitulo = document.createElement("div");
    grupoTitulo.className = "crm-columna-titulo-grupo";

    const titulo = document.createElement("p");
    titulo.className = "crm-columna-titulo";
    titulo.innerHTML = `<span class="crm-columna-dot"></span>${etiqueta} <span class="crm-columna-contador">${deEstaEtapa.length}</span>`;
    grupoTitulo.appendChild(titulo);

    const valorTexto = formatoUsdCompacto(valorColumna);
    if (valorTexto) {
      const valorEl = document.createElement("p");
      valorEl.className = "crm-columna-valor";
      valorEl.dataset.testid = `crm-columna-valor-${clave}`;
      valorEl.textContent = valorTexto;
      grupoTitulo.appendChild(valorEl);
    }
    cabeceraColumna.appendChild(grupoTitulo);

    // Alta rápida directamente en esta columna (idea de Attio: un "+" en
    // cada cabecera de columna) — abre el mismo formulario de siempre,
    // solo que ya con el estado de esta columna preseleccionado.
    const btnAgregarAqui = document.createElement("button");
    btnAgregarAqui.type = "button";
    btnAgregarAqui.className = "crm-columna-agregar";
    btnAgregarAqui.textContent = "+";
    btnAgregarAqui.setAttribute("aria-label", `Nuevo contacto en ${etiqueta}`);
    btnAgregarAqui.addEventListener("click", () => mostrarForm(null, clave));
    cabeceraColumna.appendChild(btnAgregarAqui);

    columna.appendChild(cabeceraColumna);

    deEstaEtapa.forEach((contacto) => columna.appendChild(tarjetaContacto(contacto)));
    elKanban.appendChild(columna);
  });
}

function renderStats() {
  const m = calcularMetricas(getContactosActuales());
  elStats.innerHTML = `
    <div class="crm-stat"><strong>${m.total}</strong><span>Contactos</span></div>
    <div class="crm-stat"><strong>${m.nuevosEstaSemana}</strong><span>Nuevos (7 días)</span></div>
    <div class="crm-stat"><strong>${m.tasaConversion == null ? "—" : `${m.tasaConversion}%`}</strong><span>Conversión a cerrado</span></div>
    <div class="crm-stat crm-stat-urgente"><strong>${m.sinAtender}</strong><span>Sin atender (+${HORAS_SIN_ATENDER}h)</span></div>
    <div class="crm-stat"><strong>${m.estancados}</strong><span>Estancados (+${DIAS_ESTANCADO}d)</span></div>
    <div class="crm-stat crm-stat-valor"><strong>${formatoUsdCompacto(m.valorPipelineActivo) || "—"}</strong><span>Valor en pipeline</span></div>
  `;
}

// "Automatización configurable" (idea propia — Tokko recién ofrece esto
// desde el plan Equipo, $252.320/mes): en vez de abrir cada contacto
// estancado uno por uno para marcarlo "perdido" a mano, un solo clic
// cierra a todos los que llevan +DIAS_ESTANCADO días sin novedades. Solo
// actúa sobre lo que el usuario ya puede ver (getContactosActuales() ya
// viene filtrado por "mias"/"todas", y firestore.rules igual rechazaría
// cualquier escritura sin permiso real) — no es una automatización
// server-side ("cron"), es un atajo manual configurable en el sentido de
// que el umbral (DIAS_ESTANCADO) es un solo número fácil de ajustar.
const MOTIVO_PERDIDO_AUTOMATICO = "Sin actividad reciente (cierre en bloque)";

function renderAutomatizacion() {
  const estancados = getContactosActuales().filter(estaEstancado);
  elAutomatizacion.classList.toggle("oculto", estancados.length === 0);
  if (estancados.length === 0) return;
  elAutomatizacionTexto.textContent =
    estancados.length === 1
      ? "1 contacto lleva más de una semana sin novedades."
      : `${estancados.length} contactos llevan más de una semana sin novedades.`;
}

async function marcarEstancadosComoPerdidos() {
  const estancados = getContactosActuales().filter(estaEstancado);
  if (estancados.length === 0) return;
  const confirmado = window.confirm(
    `¿Marcar ${estancados.length === 1 ? "el contacto estancado" : `los ${estancados.length} contactos estancados`} como perdidos? No se puede deshacer.`
  );
  if (!confirmado) return;

  const ahora = new Date().toISOString();
  let fallidos = 0;
  for (const contacto of estancados) {
    const estadoAnterior = contacto.estado;
    try {
      await updateDoc(doc(db, COLECCION_CONTACTOS, contacto.id), {
        estado: "perdido",
        motivo_perdido: MOTIVO_PERDIDO_AUTOMATICO,
        fecha_actualizacion: ahora
      });
      contacto.estado = "perdido";
      contacto.motivo_perdido = MOTIVO_PERDIDO_AUTOMATICO;
      contacto.fecha_actualizacion = ahora;
      registrarAuditoria({
        accion: "mover_contacto",
        objetoId: contacto.id,
        objetoTitulo: contacto.nombre,
        detalle: `${ETIQUETA_ETAPA[estadoAnterior] || estadoAnterior} → ${ETIQUETA_ETAPA.perdido} (${MOTIVO_PERDIDO_AUTOMATICO})`
      });
    } catch {
      // Uno fallando (permiso, red) no debe frenar al resto — se cuenta
      // y se avisa al final, mismo criterio que moverContacto pero sin
      // revertir nada acá: los que sí se aplicaron quedan aplicados.
      fallidos++;
    }
  }
  renderTodo();
  if (fallidos > 0) {
    window.alert(`Se marcaron ${estancados.length - fallidos} de ${estancados.length}. ${fallidos} no se pudieron actualizar.`);
  }
}

// "Rendimiento por corredor" (idea propia, investigada en Tokko Broker
// antes de armarla — "Métricas de negocio... performance de tu
// equipo"). Solo tiene sentido en "Todos": en "Mis contactos" ya es
// obvio de quién son (las tarjetas de arriba alcanzan), comparar contra
// nadie no aporta nada.
function renderRendimientoPorCorredor() {
  const enTodas = getModoVista() === "todas";
  elRendimientoSeccion.classList.toggle("oculto", !enTodas);
  if (!enTodas) return;

  const contactos = getContactosActuales();
  const usuariosPorUid = obtenerUsuariosPorUidCache();
  const porUid = new Map();
  contactos.forEach((c) => {
    const uid = c.asignado_a || "__sin_asignar__";
    if (!porUid.has(uid)) porUid.set(uid, []);
    porUid.get(uid).push(c);
  });

  const filas = [...porUid.entries()]
    .map(([uid, propios]) => {
      const cerrados = propios.filter((c) => c.estado === "cerrado").length;
      const sinAtender = propios.filter(estaSinAtender).length;
      const tasa = propios.length > 0 ? Math.round((cerrados / propios.length) * 100) : 0;
      const nombreCorredor =
        uid === "__sin_asignar__" ? "Sin asignar" : uid === auth.currentUser?.uid ? "Vos" : usuariosPorUid[uid] || uid;
      return { nombreCorredor, total: propios.length, cerrados, tasa, sinAtender };
    })
    .sort((a, b) => b.total - a.total);

  elRendimientoCuerpo.innerHTML = filas
    .map(
      (f) =>
        `<tr><td>${f.nombreCorredor}</td><td>${f.total}</td><td>${f.cerrados}</td><td>${f.tasa}%</td><td>${f.sinAtender > 0 ? `<span class="crm-badge-sin-atender">${f.sinAtender}</span>` : "0"}</td></tr>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Seguimientos: recordatorios vencidos o próximos, mismo lenguaje visual
// que "Reservas por vencer" del Dashboard (reusa .dashboard-lista/
// .dashboard-badge).
// ---------------------------------------------------------------------------

// Exportada: dashboard.js reusa exactamente el mismo criterio de "qué
// cuenta como pendiente" para su resumen — evita que las dos pantallas
// se desincronicen si el criterio cambia (por ejemplo, el techo de
// DIAS_SEGUIMIENTO_PROXIMO) y una queda vieja.
export function contactosParaSeguimiento(contactos) {
  const limiteFuturo = new Date(Date.now() + DIAS_SEGUIMIENTO_PROXIMO * 86400000).toISOString().slice(0, 10);
  return contactos
    .filter(
      (c) => c.proximo_seguimiento && c.proximo_seguimiento <= limiteFuturo && c.estado !== "cerrado" && c.estado !== "perdido"
    )
    .sort((a, b) => a.proximo_seguimiento.localeCompare(b.proximo_seguimiento));
}

function actualizarContadorSeguimientos(cantidad) {
  elSeguimientosContador.textContent = cantidad;
  elSeguimientosContador.classList.toggle("oculto", cantidad === 0);
}

function renderSeguimientos() {
  const pendientes = contactosParaSeguimiento(getContactosActuales());
  const hoy = new Date().toISOString().slice(0, 10);
  elSeguimientos.innerHTML = "";
  pendientes.forEach((contacto) => {
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
        : dias === 1
          ? "mañana"
          : `en ${dias} d.`;
    li.appendChild(badge);

    li.addEventListener("click", () => mostrarForm(contacto));
    elSeguimientos.appendChild(li);
  });
  elSeguimientosVacio.classList.toggle("oculto", pendientes.length > 0);
  actualizarContadorSeguimientos(pendientes.length);
}

function renderTodo() {
  renderStats();
  renderAutomatizacion();
  renderRendimientoPorCorredor();
  renderSeguimientos();
  poblarSelectFiltroEtiqueta();
  renderKanban();
}

function mostrarKanban() {
  elVistaForm.classList.add("oculto");
  elVistaKanban.classList.remove("oculto");
}

elBtnAgregarContacto.addEventListener("click", () => mostrarForm(null));
elVolver.addEventListener("click", mostrarKanban);

// ---------------------------------------------------------------------------
// Barra de herramientas: buscador + toggle "Mis contactos"/"Todos" +
// exportar CSV.
// ---------------------------------------------------------------------------

elBuscar.addEventListener("input", () => {
  terminoBusqueda = elBuscar.value.trim().toLowerCase();
  renderKanban();
});

elFiltroCalificacion.addEventListener("change", () => {
  filtroCalificacion = elFiltroCalificacion.value;
  renderKanban();
});

elFiltroEtiqueta.addEventListener("change", () => {
  filtroEtiqueta = elFiltroEtiqueta.value;
  renderKanban();
});

async function cambiarModoVista(nuevoModo) {
  if (nuevoModo === getModoVista()) return;
  setModoVista(nuevoModo);
  elBtnVistaMias.classList.toggle("activo", nuevoModo === "mias");
  elBtnVistaTodas.classList.toggle("activo", nuevoModo === "todas");
  // Se resuelve ANTES de renderizar (no en paralelo): renderKanban() ya
  // llama a textoAsignado() por cada tarjeta en "Todos", y sin el cache
  // poblado a tiempo todas mostrarían "Otro corredor" hasta el próximo
  // render.
  if (nuevoModo === "todas") await obtenerUsuariosPorUid();
  await cargarContactos();
  renderTodo();
}
elBtnVistaMias.addEventListener("click", () => cambiarModoVista("mias"));
elBtnVistaTodas.addEventListener("click", () => cambiarModoVista("todas"));

// CSV con BOM (﻿) para que Excel en Windows —lo que casi seguro usa
// una inmobiliaria chica, no una planilla de Google— detecte UTF-8 y no
// rompa los acentos/ñ.
function escaparCsv(valor) {
  const texto = String(valor ?? "");
  return /[",\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function exportarCsv() {
  const filas = [["Nombre", "Teléfono", "Email", "Estado", "Próximo seguimiento", "Lotes de interés", "Última actualización"]];
  getContactosActuales().forEach((c) => {
    filas.push([
      c.nombre || "",
      c.telefono || "",
      c.email || "",
      ETIQUETA_ETAPA[c.estado] || c.estado || "",
      c.proximo_seguimiento || "",
      (c.lotes_interes || []).map((l) => l.titulo).join(" | "),
      c.fecha_actualizacion || ""
    ]);
  });
  const csv = filas.map((fila) => fila.map(escaparCsv).join(",")).join("\r\n");
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = `contactos-mojonapp-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  URL.revokeObjectURL(url);
}
elBtnExportar.addEventListener("click", exportarCsv);
elBtnCerrarEstancados.addEventListener("click", marcarEstancadosComoPerdidos);

// ---------------------------------------------------------------------------
// Apertura/cierre del panel.
// ---------------------------------------------------------------------------

// Factoreado del click de "CRM" en el drawer para poder abrir el panel
// también desde otro lado (dashboard.js, "Seguimientos pendientes") sin
// duplicar el cierre de los otros paneles + reset a "Mis contactos".
async function abrirPanelCrm() {
  document.getElementById("vista-lista").classList.add("oculto"); // no superponer con "Ver como lista"
  document.getElementById("btn-ver-lista").classList.remove("activo");
  document.getElementById("panel-admin").classList.add("oculto"); // ni con "Seguridad"
  document.getElementById("panel-sectores").classList.add("oculto"); // ni con "Zonas"
  document.getElementById("panel-barrios").classList.add("oculto"); // ni con "Barrios"
  document.getElementById("panel-dashboard").classList.add("oculto"); // ni con "Dashboard"
  document.getElementById("ficha-lote").classList.add("oculto");
  mostrarKanban();
  elPanel.classList.remove("oculto");

  // Siempre arranca en "Mis contactos" (default seguro, aunque tenga el
  // permiso de ver todos) — mismo criterio que cualquier vista con
  // alcance: el corredor ve primero lo suyo, y elige ampliar si hace falta.
  setModoVista("mias");
  elBtnVistaMias.classList.add("activo");
  elBtnVistaTodas.classList.remove("activo");
  elFiltroVista.classList.toggle("oculto", !puedeVerTodosLosContactos());
  elBuscar.value = "";
  terminoBusqueda = "";
  elFiltroCalificacion.value = "";
  filtroCalificacion = "";
  filtroEtiqueta = ""; // el <select> se repuebla en renderTodo() más abajo

  // Se precarga acá (no solo al pasar a "Todos") para que el <select>
  // "Asignado a" del formulario ya tenga los corredores listos aunque el
  // manager nunca haya tocado el toggle — reasignar un contacto propio
  // desde "Mis contactos" tiene que andar igual.
  if (puedeVerTodosLosContactos()) await obtenerUsuariosPorUid();

  await cargarContactos();
  renderTodo();
}

elBtnAbrir.addEventListener("click", abrirPanelCrm);

// dashboard.js llama esto al tocar una fila de "Seguimientos pendientes"
// — abre el CRM directo en el formulario de ESE contacto, en vez de
// dejar que lo busque a mano en el kanban. Si el contacto ya no está en
// el modo de vista actual ("Mis contactos" pero es de otro corredor, por
// ejemplo un caso raro de reasignación reciente) se abre igual el panel,
// sin el formulario — mejor eso que romper.
export async function abrirContactoEnCrm(contactoId) {
  await abrirPanelCrm();
  const contacto = getContactosActuales().find((c) => c.id === contactoId);
  if (contacto) mostrarForm(contacto);
}

document.getElementById("cerrar-panel-crm").addEventListener("click", () => {
  elPanel.classList.add("oculto");
});

// Cualquier otra navegación desde el menú lateral (Dashboard, Ver como
// lista, Cargar lote, Seguridad, etc.) cierra el CRM primero — mismo
// criterio que dashboard.js: un solo listener delegado en vez de
// acordarse de agregarlo a mano en cada botón nuevo del drawer.
document.getElementById("drawer-menu").addEventListener("click", (evento) => {
  const boton = evento.target.closest(".drawer-item");
  if (boton && boton.id !== "btn-abrir-crm") {
    elPanel.classList.add("oculto");
  }
});
