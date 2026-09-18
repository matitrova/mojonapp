// ---------------------------------------------------------------------------
// Vista en lista/grilla: alternativa al mapa para revisar los lotes
// cargados (más cómoda que ir tocando polígonos chicos uno por uno,
// sobre todo para borrar). Reusa getLotesActuales(), ya en memoria desde la
// última carga — no le vuelve a pedir nada a Firestore.
//
// mapa/mostrarFicha/tituloLote/puedeEditarLote/puedeBorrarLote/borrarLote/
// cargarLotesDesdeFirestore/textoEstadoConVencimiento/renderServiciosHTML
// todavía viven en app.js (Mapa y Ficha no son módulos separados en este
// punto de la modularización) — se inyectan por parámetro vía
// configurarVistaLista() para evitar una dependencia circular.
// ---------------------------------------------------------------------------

import {
  getLotesActuales,
  getContactosActuales,
  getLoteEditadoDesdeFicha,
  setLoteEditadoDesdeFicha,
  getSectoresActuales,
  getBarriosActuales,
  getCorredorLogueado
} from "./estado.js";
import { pintarEstadoVacio } from "./estado-vacio.js";
import { SIN_CAMBIO, VACIAR, armarCambios, textoDeConfirmacion, detalleParaAuditoria } from "./edicion-masiva.js";
import { centroideDePoligono } from "./geometria.js";
// Navegación por URL (ver js/router.js) — capa de abajo, sin ciclos.
import { navegarA } from "./router.js";
import { poblarSelectSector, poblarSelectBarrio } from "./catalogos.js";
import { registrarAuditoria } from "./auditoria.js";
import { leerNotasInternas, guardarNotasInternas } from "./notas-internas.js";
import { cargarContactos } from "./crm.js";

const COLECCION_LOTES = "lotes";

// Badge "Nuevo" (idea propia, mismo criterio que LandWatch, que deja
// ordenar por "listing age" — un lote recién cargado es justo lo que un
// comprador que ya miró el catálogo antes quiere ver primero). Un lote
// cargado ANTES de que existiera el campo `creado_en` (ver
// cargar-lote.js) simplemente no lo tiene — se trata igual que "no es
// nuevo", no un error.
const DIAS_NUEVO = 7;
function esLoteNuevo(p) {
  if (!p.creado_en) return false;
  const dias = (Date.now() - new Date(p.creado_en).getTime()) / 86400000;
  return dias >= 0 && dias <= DIAS_NUEVO;
}

let db,
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
  renderServiciosHTML;

// app.js llama esto una sola vez, antes de usar cualquier otra función de
// este módulo.
export function configurarVistaLista(deps) {
  ({
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
  } = deps);
}

const elBtnVerLista = document.getElementById("btn-ver-lista");
const elVistaLista = document.getElementById("vista-lista");
const elVistaListaVacio = document.getElementById("vista-lista-vacio");
const elVistaListaSinResultados = document.getElementById("vista-lista-sin-resultados");
const elTablaLotes = document.getElementById("tabla-lotes");
const elTablaLotesCuerpo = document.getElementById("tabla-lotes-cuerpo");
const elFiltroBuscar = document.getElementById("filtro-buscar");
const elFiltroSector = document.getElementById("filtro-sector");
const elFiltroBarrio = document.getElementById("filtro-barrio");
const elFiltroEstado = document.getElementById("filtro-estado");
const elFiltroPrecioMin = document.getElementById("filtro-precio-min");
const elFiltroPrecioMax = document.getElementById("filtro-precio-max");
const elFiltroSuperficieMin = document.getElementById("filtro-superficie-min");
const elFiltroSuperficieMax = document.getElementById("filtro-superficie-max");
const elFiltroOrden = document.getElementById("filtro-orden");
const elFiltroCantidad = document.getElementById("filtro-cantidad");
const elPaginacion = document.getElementById("vista-lista-paginacion");
const elPaginaAnterior = document.getElementById("pagina-anterior");
const elPaginaSiguiente = document.getElementById("pagina-siguiente");
const elPaginaInfo = document.getElementById("pagina-info");
const elBtnModoTabla = document.getElementById("btn-modo-tabla");
const elBtnModoGrilla = document.getElementById("btn-modo-grilla");
const elGrillaLotes = document.getElementById("grilla-lotes");
const elTablaScroll = document.getElementById("tabla-lotes-scroll");

const elLoteVistaLista = document.getElementById("lote-vista-lista");
const elLoteVistaEditar = document.getElementById("lote-vista-editar");
const elLoteEditarTitulo = document.getElementById("lote-editar-titulo");
const elLoteEditarVolver = document.getElementById("lote-editar-volver");
const formularioEditarLote = document.getElementById("formulario-editar-lote");
const elEditarLoteManzana = document.getElementById("editar-lote-manzana");
const elEditarLoteNumero = document.getElementById("editar-lote-numero");
const elEditarLoteNomenclatura = document.getElementById("editar-lote-nomenclatura");
const elEditarLoteSuperficie = document.getElementById("editar-lote-superficie");
const elEditarLoteEstado = document.getElementById("editar-lote-estado");
const elEditarLoteReservadoHastaLabel = document.getElementById("editar-lote-reservado-hasta-label");
const elEditarLoteReservadoHasta = document.getElementById("editar-lote-reservado-hasta");
const elEditarLotePrecio = document.getElementById("editar-lote-precio");
const elEditarLoteCompradorLabel = document.getElementById("editar-lote-comprador-label");
const elEditarLoteComprador = document.getElementById("editar-lote-comprador");

// El campo "Reservado hasta" solo tiene sentido con estado "Reservado"
// — se muestra/oculta solo al cambiar el estado en el formulario.
function actualizarVisibilidadReservadoHasta() {
  elEditarLoteReservadoHastaLabel.classList.toggle("oculto", elEditarLoteEstado.value !== "reservado");
}

// "Vendido a" (trazabilidad de venta, idea propia — Tokko no conecta
// esto entre su CRM y su inventario de forma tan directa): solo tiene
// sentido con estado "Vendido". Lista los contactos ya cargados en el
// CRM — si nunca se abrió el panel CRM en esta sesión, getContactosActuales()
// viene vacío, así que se dispara cargarContactos() recién la primera vez
// que hace falta (mismo criterio "lazy" que abrirPanelDashboard con los
// seguimientos del CRM). "valorDeseado" es el comprador_contacto_id ya
// guardado del lote, para preseleccionarlo al abrir el formulario (el
// cambio manual del <select> desde el usuario no pasa por acá).
async function actualizarVisibilidadComprador(valorDeseado) {
  const esVendido = elEditarLoteEstado.value === "vendido";
  elEditarLoteCompradorLabel.classList.toggle("oculto", !esVendido);
  if (!esVendido) return;
  if (getContactosActuales().length === 0) await cargarContactos();
  const valorPrevio = valorDeseado ?? elEditarLoteComprador.value;
  const opciones = [...getContactosActuales()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  elEditarLoteComprador.innerHTML =
    `<option value="">Sin especificar</option>` +
    opciones.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join("");
  elEditarLoteComprador.value = valorPrevio || "";
}
elEditarLoteEstado.addEventListener("change", () => {
  actualizarVisibilidadReservadoHasta();
  actualizarVisibilidadComprador();
});
const elEditarLoteSector = document.getElementById("editar-lote-sector");
const elEditarLoteBarrio = document.getElementById("editar-lote-barrio");
const elEditarLoteServicioLuz = document.getElementById("editar-lote-servicio-luz");
const elEditarLoteServicioAgua = document.getElementById("editar-lote-servicio-agua");
const elEditarLoteServicioGas = document.getElementById("editar-lote-servicio-gas");
const elEditarLoteServicioCloaca = document.getElementById("editar-lote-servicio-cloaca");
const elEditarLoteDescripcion = document.getElementById("editar-lote-descripcion");
const elEditarLoteNotas = document.getElementById("editar-lote-notas");
const elEditarLoteError = document.getElementById("editar-lote-error");
let loteEditandoDesdeGrilla = null; // feature actual del formulario de edición

// El filtro se arma con lo que ya se cargó, no con el catálogo entero —
// no tiene sentido ofrecer para filtrar una zona que ningún lote tiene
// puesto todavía. Misma lógica para zona y barrio.
function actualizarOpcionesFiltroSector() {
  const seleccionPrevia = elFiltroSector.value;
  const sectores = [...new Set(getLotesActuales().map((f) => f.properties.sector).filter(Boolean))].sort();
  elFiltroSector.innerHTML =
    '<option value="">Todas las zonas</option>' +
    sectores.map((s) => `<option value="${s}">${s}</option>`).join("");
  if (sectores.includes(seleccionPrevia)) elFiltroSector.value = seleccionPrevia;
}

function actualizarOpcionesFiltroBarrio() {
  const seleccionPrevia = elFiltroBarrio.value;
  const barrios = [...new Set(getLotesActuales().map((f) => f.properties.barrio).filter(Boolean))].sort();
  elFiltroBarrio.innerHTML =
    '<option value="">Todos los barrios</option>' +
    barrios.map((b) => `<option value="${b}">${b}</option>`).join("");
  if (barrios.includes(seleccionPrevia)) elFiltroBarrio.value = seleccionPrevia;
}

// Un lote sin el dato que se está ordenando (precio o superficie) va
// SIEMPRE al final, ordene como ordene ("menor a mayor" o "mayor a
// menor") — mezclarlo en el medio según a qué número equivale
// "sin dato" (0? Infinity?) sería arbitrario y confundiría más de lo
// que ayuda. Mismo criterio que los filtros de rango de arriba: un
// lote sin ese dato no puede compararse con uno que sí lo tiene.
const COMPARADORES_ORDEN = {
  "precio-asc": (a, b) => compararConNulosAlFinal(a.properties.precio_usd, b.properties.precio_usd, 1),
  "precio-desc": (a, b) => compararConNulosAlFinal(a.properties.precio_usd, b.properties.precio_usd, -1),
  "superficie-asc": (a, b) => compararConNulosAlFinal(a.properties.superficie_m2, b.properties.superficie_m2, 1),
  "superficie-desc": (a, b) => compararConNulosAlFinal(a.properties.superficie_m2, b.properties.superficie_m2, -1)
};

function compararConNulosAlFinal(valorA, valorB, signo) {
  if (valorA == null && valorB == null) return 0;
  if (valorA == null) return 1;
  if (valorB == null) return -1;
  return (valorA - valorB) * signo;
}

// Busca en manzana/lote/nomenclatura/zona/barrio/descripción juntos
// (idea propia, mismo criterio que #crm-buscar en crm.js) — no hace
// falta saber en qué campo puntual está el dato que se busca.
function coincideConBusqueda(p, termino) {
  if (!termino) return true;
  return [p.manzana, p.lote, p.nomenclatura, p.sector, p.barrio, p.descripcion]
    .filter(Boolean)
    .some((valor) => String(valor).toLowerCase().includes(termino));
}

function lotesFiltrados() {
  const precioMin = elFiltroPrecioMin.value ? Number(elFiltroPrecioMin.value) : null;
  const precioMax = elFiltroPrecioMax.value ? Number(elFiltroPrecioMax.value) : null;
  const superficieMin = elFiltroSuperficieMin.value ? Number(elFiltroSuperficieMin.value) : null;
  const superficieMax = elFiltroSuperficieMax.value ? Number(elFiltroSuperficieMax.value) : null;
  const termino = elFiltroBuscar.value.trim().toLowerCase();

  const filtrados = getLotesActuales().filter((feature) => {
    const p = feature.properties;
    if (!coincideConBusqueda(p, termino)) return false;
    if (elFiltroSector.value && p.sector !== elFiltroSector.value) return false;
    if (elFiltroBarrio.value && p.barrio !== elFiltroBarrio.value) return false;
    if (elFiltroEstado.value && p.estado !== elFiltroEstado.value) return false;
    // Un lote sin precio/superficie cargado no puede asegurarse que
    // esté en el rango pedido — no pasa el filtro apenas se completa
    // alguno de los dos campos (mismo criterio que un portal real).
    if (precioMin != null && (p.precio_usd == null || p.precio_usd < precioMin)) return false;
    if (precioMax != null && (p.precio_usd == null || p.precio_usd > precioMax)) return false;
    if (superficieMin != null && (p.superficie_m2 == null || p.superficie_m2 < superficieMin)) return false;
    if (superficieMax != null && (p.superficie_m2 == null || p.superficie_m2 > superficieMax)) return false;
    return true;
  });

  const comparador = COMPARADORES_ORDEN[elFiltroOrden.value];
  if (comparador) filtrados.sort(comparador);
  return filtrados;
}

// Paginación: sin techo, una cartera grande (o el catálogo público con
// muchos lotes) terminaba en una sola tabla larguísima — "Mostrar" deja
// elegir cuántas filas por página (5/10/15/20/50/100, o "Todos" con
// value="0" para volver al comportamiento de siempre). Se reinicia a la
// página 1 cada vez que cambia un filtro o la cantidad — quedarse en,
// por ejemplo, la página 4 después de aplicar un filtro que deja solo 2
// páginas mostraría una tabla vacía sin que se entienda por qué.
let paginaActual = 1;

function cambiarPagina(delta) {
  paginaActual += delta;
  actualizarVistaLista();
}

elPaginaAnterior.addEventListener("click", () => cambiarPagina(-1));
elPaginaSiguiente.addEventListener("click", () => cambiarPagina(1));

// Tabla/Grilla (idea propia, ver comentario en index.html) — arranca en
// "tabla" siempre (no se persiste entre sesiones): es el modo que ya
// conocía cualquiera que usara la app antes de esta idea, y sigue
// siendo el que necesita un corredor administrando (Editar/Borrar en
// fila no tiene sentido en tarjetas).
let modoVistaLista = "tabla";

function irAFichaDesdeVistaLista(feature) {
  // Navegar al mapa deja la URL en "/", así el "atrás" del navegador
  // vuelve a la lista.
  navegarA("/");
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  mapa.setView([lat, lon], 19);
  mostrarFicha(feature);
}

function renderTabla(lotesPagina) {
  lotesDeLaPagina = lotesPagina;
  elTablaLotesCuerpo.innerHTML = "";
  lotesPagina.forEach((feature) => {
    const p = feature.properties;
    const fila = document.createElement("tr");
    fila.className = "fila-lote";
    fila.dataset.loteId = feature.id; // permite ubicar una fila puntual (tests, debug)
    fila.innerHTML = `
      <td class="col-tilde"></td>
      <td>${tituloLote(p)}${esLoteNuevo(p) ? ' <span class="chip-nuevo">Nuevo</span>' : ""}</td>
      <td>${p.sector || "—"}</td>
      <td>${p.barrio || "—"}</td>
      <td>${p.superficie_m2 == null ? "—" : `${p.superficie_m2} m²`}</td>
      <td>${textoEstadoConVencimiento(p)}</td>
      <td>${p.precio_usd == null ? "—" : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`}</td>
      <td>${p.servicios == null ? "—" : renderServiciosHTML(p.servicios)}</td>
      <td></td>
    `;

    fila.addEventListener("click", () => irAFichaDesdeVistaLista(feature));

    // El tilde solo aparece en los lotes que este usuario puede editar.
    // Es más honesto que mostrarlo siempre y fallar al aplicar: el
    // permiso real lo hace cumplir firestore.rules, y una selección que
    // incluya lotes ajenos terminaría en "permission-denied" a mitad de
    // una escritura en masa (ver puedeEditarLote en js/permisos.js).
    if (puedeEditarLote(feature)) {
      const tilde = document.createElement("input");
      tilde.type = "checkbox";
      tilde.className = "tilde-lote";
      tilde.checked = loteSeleccionados.has(feature.id);
      tilde.dataset.tildeLoteId = feature.id;
      tilde.setAttribute("aria-label", `Seleccionar ${tituloLote(p)}`);
      // La fila entera abre la ficha: sin esto, tildar te saca de la lista.
      tilde.addEventListener("click", (evento) => evento.stopPropagation());
      tilde.addEventListener("change", () => {
        if (tilde.checked) loteSeleccionados.add(feature.id);
        else loteSeleccionados.delete(feature.id);
        actualizarBarraSeleccion();
      });
      fila.querySelector("td.col-tilde").appendChild(tilde);
    }

    const celdaAcciones = fila.querySelector("td:last-child");

    if (puedeEditarLote(feature)) {
      const botonEditar = document.createElement("button");
      botonEditar.type = "button";
      botonEditar.className = "btn-editar-fila";
      botonEditar.textContent = "Editar";
      botonEditar.addEventListener("click", (evento) => {
        evento.stopPropagation(); // no abrir la ficha al tocar "Editar"
        setLoteEditadoDesdeFicha(false);
        mostrarEditarLoteDesdeGrilla(feature);
      });
      celdaAcciones.appendChild(botonEditar);
    }

    if (puedeBorrarLote(feature)) {
      const botonBorrar = document.createElement("button");
      botonBorrar.type = "button";
      botonBorrar.className = "btn-borrar-fila";
      botonBorrar.textContent = "Borrar";
      botonBorrar.addEventListener("click", (evento) => {
        evento.stopPropagation(); // no abrir la ficha al tocar "Borrar"
        borrarLote(feature, botonBorrar);
      });
      celdaAcciones.appendChild(botonBorrar);
    }

    elTablaLotesCuerpo.appendChild(fila);
  });
}

// ---------------------------------------------------------------------------
// Edición en masa: tildar varios lotes y cambiarles un campo de una vez.
//
// Por qué existe y qué NO deja cambiar está explicado en
// js/edicion-masiva.js, que tiene la parte con reglas. Acá solo está el
// cableado con la pantalla.
// ---------------------------------------------------------------------------

const elSeleccionBarra = document.getElementById("seleccion-barra");
const elSeleccionCuenta = document.getElementById("seleccion-cuenta");
const elSeleccionarPagina = document.getElementById("seleccionar-pagina");
const elBtnSeleccionarFiltro = document.getElementById("btn-seleccionar-filtro");
const elBtnAplicarAVarios = document.getElementById("btn-aplicar-a-varios");
const elBtnLimpiarSeleccion = document.getElementById("btn-limpiar-seleccion");
const elMasivaForm = document.getElementById("masiva-form");
const elMasivaSector = document.getElementById("masiva-sector");
const elMasivaBarrio = document.getElementById("masiva-barrio");
const elMasivaPrecio = document.getElementById("masiva-precio");
const elMasivaConfirmacion = document.getElementById("masiva-confirmacion");
const elMasivaError = document.getElementById("masiva-error");
const elMasivaProgreso = document.getElementById("masiva-progreso");
const elMasivaAplicar = document.getElementById("masiva-aplicar");
const elMasivaCancelar = document.getElementById("masiva-cancelar");
const elMasivaServicios = {
  luz: document.getElementById("masiva-luz"),
  agua: document.getElementById("masiva-agua"),
  gas: document.getElementById("masiva-gas"),
  cloaca: document.getElementById("masiva-cloaca")
};

// Ids, no features: la lista se vuelve a dibujar en cada filtro y cada
// página, y los objetos cambian de identidad en cada carga desde
// Firestore. Con ids, la selección sobrevive a todo eso.
const loteSeleccionados = new Set();
let lotesDeLaPagina = [];

function lotesSeleccionadosActuales() {
  return getLotesActuales().filter((f) => loteSeleccionados.has(f.id));
}

function actualizarBarraSeleccion() {
  const cantidad = loteSeleccionados.size;
  // En modo grilla no hay tildes, así que la barra tampoco: la selección
  // se conserva y vuelve a aparecer al volver a la tabla.
  const visible = cantidad > 0 && modoVistaLista === "tabla";
  elSeleccionBarra.classList.toggle("oculto", !visible);
  if (!visible) elMasivaForm.classList.add("oculto");
  elSeleccionCuenta.textContent =
    cantidad === 1 ? "1 lote seleccionado" : `${cantidad} lotes seleccionados`;

  const seleccionablesDeLaPagina = lotesDeLaPagina.filter((f) => puedeEditarLote(f));
  elSeleccionarPagina.checked =
    seleccionablesDeLaPagina.length > 0 &&
    seleccionablesDeLaPagina.every((f) => loteSeleccionados.has(f.id));

  // "Seleccionar los N del filtro" solo tiene sentido si el filtro
  // alcanza más lotes que los que se están viendo en esta página.
  const seleccionablesDelFiltro = lotesFiltrados().filter((f) => puedeEditarLote(f));
  const hayMasQueLaPagina = seleccionablesDelFiltro.length > seleccionablesDeLaPagina.length;
  elBtnSeleccionarFiltro.classList.toggle("oculto", !hayMasQueLaPagina);
  elBtnSeleccionarFiltro.textContent = `Seleccionar los ${seleccionablesDelFiltro.length} del filtro`;

  if (visible) actualizarConfirmacionMasiva();
}

elSeleccionarPagina.addEventListener("change", () => {
  const seleccionables = lotesDeLaPagina.filter((f) => puedeEditarLote(f));
  for (const feature of seleccionables) {
    if (elSeleccionarPagina.checked) loteSeleccionados.add(feature.id);
    else loteSeleccionados.delete(feature.id);
  }
  renderTabla(lotesDeLaPagina);
  actualizarBarraSeleccion();
});

elBtnSeleccionarFiltro.addEventListener("click", () => {
  for (const feature of lotesFiltrados().filter((f) => puedeEditarLote(f))) {
    loteSeleccionados.add(feature.id);
  }
  renderTabla(lotesDeLaPagina);
  actualizarBarraSeleccion();
});

function limpiarSeleccion() {
  loteSeleccionados.clear();
  elMasivaForm.classList.add("oculto");
  renderTabla(lotesDeLaPagina);
  actualizarBarraSeleccion();
}
elBtnLimpiarSeleccion.addEventListener("click", limpiarSeleccion);

elBtnAplicarAVarios.addEventListener("click", () => {
  // Los selects se rearman en cada apertura: las zonas y barrios pueden
  // haberse creado desde su propio panel mientras la lista estaba abierta.
  const opcionesFijas =
    `<option value="${SIN_CAMBIO}">No cambiar</option>` +
    `<option value="${VACIAR}">Vaciar el campo</option>`;
  elMasivaSector.innerHTML =
    opcionesFijas + getSectoresActuales().map((s) => `<option value="${s.nombre}">${s.nombre}</option>`).join("");
  elMasivaBarrio.innerHTML =
    opcionesFijas + getBarriosActuales().map((b) => `<option value="${b.nombre}">${b.nombre}</option>`).join("");
  elMasivaPrecio.value = "";
  for (const select of Object.values(elMasivaServicios)) select.value = SIN_CAMBIO;
  elMasivaError.classList.add("oculto");
  elMasivaProgreso.classList.add("oculto");
  elMasivaForm.classList.remove("oculto");
  actualizarConfirmacionMasiva();
});

elMasivaCancelar.addEventListener("click", () => elMasivaForm.classList.add("oculto"));

function valoresDelFormularioMasivo() {
  return {
    sector: elMasivaSector.value,
    barrio: elMasivaBarrio.value,
    precio: elMasivaPrecio.value,
    luz: elMasivaServicios.luz.value,
    agua: elMasivaServicios.agua.value,
    gas: elMasivaServicios.gas.value,
    cloaca: elMasivaServicios.cloaca.value
  };
}

// El resumen se actualiza a medida que se elige, no al apretar Aplicar:
// es la única forma de que el usuario vea a cuántos lotes le va a pegar
// ANTES de pegarles. Con una escritura sobre decenas de documentos, esa
// frase es la última chance de darse cuenta de un error.
function actualizarConfirmacionMasiva() {
  const { resumen, error } = armarCambios(valoresDelFormularioMasivo());
  const hayResumen = !error && resumen.length > 0;
  elMasivaConfirmacion.classList.toggle("oculto", !hayResumen);
  if (hayResumen) elMasivaConfirmacion.textContent = textoDeConfirmacion(loteSeleccionados.size, resumen);
  elMasivaAplicar.disabled = !hayResumen;
}

elMasivaSector.addEventListener("change", actualizarConfirmacionMasiva);
elMasivaBarrio.addEventListener("change", actualizarConfirmacionMasiva);
elMasivaPrecio.addEventListener("input", actualizarConfirmacionMasiva);
for (const select of Object.values(elMasivaServicios)) {
  select.addEventListener("change", actualizarConfirmacionMasiva);
}

elMasivaForm.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elMasivaError.classList.add("oculto");

  const { cambios, resumen, error } = armarCambios(valoresDelFormularioMasivo());
  if (error) {
    elMasivaError.textContent = error;
    elMasivaError.classList.remove("oculto");
    return;
  }

  const seleccionados = lotesSeleccionadosActuales();
  if (seleccionados.length === 0) {
    elMasivaError.textContent = "No quedó ningún lote seleccionado.";
    elMasivaError.classList.remove("oculto");
    return;
  }

  elMasivaAplicar.disabled = true;
  elMasivaProgreso.textContent = `Guardando ${seleccionados.length}...`;
  elMasivaProgreso.classList.remove("oculto");

  // En paralelo y con allSettled a propósito, en vez de un batch
  // atómico: aplicar el MISMO cambio dos veces no hace ningún daño
  // (escribe los mismos valores), así que una aplicación parcial se
  // arregla reintentando. A cambio se puede decir exactamente cuántos
  // fallaron en vez de perder todo por uno.
  const resultados = await Promise.allSettled(
    seleccionados.map((feature) => updateDoc(doc(db, COLECCION_LOTES, feature.id), cambios))
  );

  const fallados = [];
  resultados.forEach((resultado, indice) => {
    if (resultado.status === "fulfilled") {
      // Se refleja en memoria para que la lista muestre el cambio sin
      // esperar la recarga. Las rutas con punto ("servicios.luz") hay
      // que aplicarlas a mano: Object.assign no entiende de anidados.
      const p = seleccionados[indice].properties;
      for (const [campo, valor] of Object.entries(cambios)) {
        if (campo.startsWith("servicios.")) {
          p.servicios = { ...(p.servicios || {}), [campo.slice("servicios.".length)]: valor };
        } else {
          p[campo] = valor;
        }
      }
    } else {
      fallados.push(seleccionados[indice]);
    }
  });

  const aplicados = seleccionados.length - fallados.length;
  if (aplicados > 0) {
    // UN evento por operación, no uno por lote: 40 filas iguales en la
    // auditoría tapan todo lo demás, y además fue una sola acción. Los
    // títulos van en el detalle mientras sean pocos, porque saber QUÉ se
    // tocó vale más que saber cuántos.
    const titulos = seleccionados
      .filter((f) => !fallados.includes(f))
      .map((f) => tituloLote(f.properties));
    const hasta = 10;
    const listado =
      titulos.length <= hasta
        ? titulos.join(", ")
        : `${titulos.slice(0, hasta).join(", ")} y ${titulos.length - hasta} más`;
    registrarAuditoria({
      accion: "editar_lotes_en_masa",
      objetoId: null,
      objetoTitulo: null,
      detalle: `${detalleParaAuditoria(aplicados, resumen)} — ${listado}`
    });
  }

  await cargarLotesDesdeFirestore();

  elMasivaProgreso.classList.add("oculto");
  elMasivaAplicar.disabled = false;

  if (fallados.length > 0) {
    // Los que fallaron quedan seleccionados y los que salieron bien no:
    // así "Aplicar" de nuevo reintenta exactamente lo que falta.
    loteSeleccionados.clear();
    for (const feature of fallados) loteSeleccionados.add(feature.id);
    elMasivaError.textContent =
      `Se aplicó a ${aplicados} de ${seleccionados.length}. Los ${fallados.length} que fallaron quedaron ` +
      "seleccionados: podés apretar Aplicar otra vez, aplicar el mismo cambio dos veces no hace daño.";
    elMasivaError.classList.remove("oculto");
    actualizarVistaLista();
    return;
  }

  limpiarSeleccion();
  actualizarVistaLista();
});

// Misma info que la tabla, sin las acciones de editar/borrar (esas se
// siguen haciendo desde la tabla) — con la primera foto si el lote
// tiene alguna cargada. Un lote sin fotos no muestra ningún placeholder
// genérico, mismo criterio "no se inventa nada" del resto de la app.
function renderGrilla(lotesPagina) {
  elGrillaLotes.innerHTML = "";
  lotesPagina.forEach((feature) => {
    const p = feature.properties;
    const foto = (p.fotos || [])[0];
    const tarjeta = document.createElement("article");
    tarjeta.className = "tarjeta-lote";
    tarjeta.dataset.loteId = feature.id;
    tarjeta.innerHTML = `
      ${foto ? `<img class="tarjeta-lote-foto" src="${foto}" alt="Foto de ${tituloLote(p)}" loading="lazy" />` : ""}
      <div class="tarjeta-lote-cuerpo">
        <span class="tarjeta-lote-estado ${p.estado || ""}">${textoEstadoConVencimiento(p)}</span>
        <span class="tarjeta-lote-titulo">${tituloLote(p)}${esLoteNuevo(p) ? ' <span class="chip-nuevo">Nuevo</span>' : ""}</span>
        <span class="tarjeta-lote-dato">${[p.sector, p.barrio].filter(Boolean).join(" — ") || "Zona sin datos"}</span>
        <span class="tarjeta-lote-dato">${p.superficie_m2 == null ? "Superficie sin datos" : `${p.superficie_m2} m²`}</span>
        ${p.precio_usd != null ? `<span class="tarjeta-lote-precio">USD ${Number(p.precio_usd).toLocaleString("es-AR")}</span>` : ""}
      </div>
    `;
    tarjeta.addEventListener("click", () => irAFichaDesdeVistaLista(feature));
    elGrillaLotes.appendChild(tarjeta);
  });
}

// hayLotesParaMostrar se guarda del último actualizarVistaLista() —
// tocar el toggle Tabla/Grilla no vuelve a filtrar nada, solo cambia
// cuál de las dos, ya renderizadas, se ve.
let hayLotesParaMostrar = false;

function actualizarModoVistaLista(hayLotes = hayLotesParaMostrar) {
  hayLotesParaMostrar = hayLotes;
  elBtnModoTabla.classList.toggle("activo", modoVistaLista === "tabla");
  elBtnModoGrilla.classList.toggle("activo", modoVistaLista === "grilla");
  elTablaScroll.classList.toggle("oculto", !hayLotes || modoVistaLista !== "tabla");
  elGrillaLotes.classList.toggle("oculto", !hayLotes || modoVistaLista !== "grilla");
}

elBtnModoTabla.addEventListener("click", () => {
  modoVistaLista = "tabla";
  actualizarModoVistaLista();
  actualizarBarraSeleccion();
});
elBtnModoGrilla.addEventListener("click", () => {
  modoVistaLista = "grilla";
  actualizarModoVistaLista();
  actualizarBarraSeleccion();
});

export function actualizarVistaLista() {
  actualizarOpcionesFiltroSector();
  actualizarOpcionesFiltroBarrio();
  const lotes = lotesFiltrados();

  const porPagina = Number(elFiltroCantidad.value) || Infinity; // "Todos" = value 0
  const totalPaginas = Number.isFinite(porPagina) ? Math.max(1, Math.ceil(lotes.length / porPagina)) : 1;
  paginaActual = Math.min(Math.max(1, paginaActual), totalPaginas);
  const inicio = Number.isFinite(porPagina) ? (paginaActual - 1) * porPagina : 0;
  const lotesPagina = Number.isFinite(porPagina) ? lotes.slice(inicio, inicio + porPagina) : lotes;

  elPaginacion.classList.toggle("oculto", totalPaginas <= 1);
  elPaginaAnterior.disabled = paginaActual <= 1;
  elPaginaSiguiente.disabled = paginaActual >= totalPaginas;
  elPaginaInfo.textContent = `Página ${paginaActual} de ${totalPaginas} (${lotes.length} lotes)`;

  const sinLotesCargados = getLotesActuales().length === 0;
  elVistaListaVacio.classList.toggle("oculto", !sinLotesCargados);
  if (sinLotesCargados) {
    pintarEstadoVacio(elVistaListaVacio, { pantalla: "lista", conSesion: getCorredorLogueado() });
  }
  // Distinto de "no hay lotes cargados": acá SÍ hay lotes, pero ninguno
  // coincide con el sector/estado elegido — un mensaje genérico de
  // "vacío" hubiera hecho pensar que se perdió todo lo cargado.
  elVistaListaSinResultados.classList.toggle("oculto", getLotesActuales().length === 0 || lotes.length > 0);
  elTablaLotes.classList.toggle("oculto", lotes.length === 0);
  document.getElementById("vista-lista-modo").classList.toggle("oculto", lotes.length === 0);

  renderTabla(lotesPagina);
  renderGrilla(lotesPagina);
  actualizarModoVistaLista(lotes.length > 0);
  actualizarBarraSeleccion();
}

function reiniciarPaginaYActualizar() {
  paginaActual = 1;
  // Cambiar el filtro limpia la selección, a propósito. Si no, quedarían
  // lotes tildados fuera de la vista y "Aplicar a todos" les pegaría a
  // lotes que no se están viendo — el peor final posible para una
  // escritura en masa. Además calza con cómo se usa esto: filtrar una
  // manzana, seleccionar todo, aplicar, y pasar a la siguiente.
  loteSeleccionados.clear();
  actualizarVistaLista();
}
elFiltroBuscar.addEventListener("input", reiniciarPaginaYActualizar);
elFiltroSector.addEventListener("change", reiniciarPaginaYActualizar);
elFiltroBarrio.addEventListener("change", reiniciarPaginaYActualizar);
elFiltroEstado.addEventListener("change", reiniciarPaginaYActualizar);
elFiltroPrecioMin.addEventListener("input", reiniciarPaginaYActualizar);
elFiltroPrecioMax.addEventListener("input", reiniciarPaginaYActualizar);
elFiltroSuperficieMin.addEventListener("input", reiniciarPaginaYActualizar);
elFiltroSuperficieMax.addEventListener("input", reiniciarPaginaYActualizar);
elFiltroOrden.addEventListener("change", reiniciarPaginaYActualizar);
elFiltroCantidad.addEventListener("change", reiniciarPaginaYActualizar);

// Editar un lote directo desde la grilla (sin pasar por el mapa/ficha):
// pedido explícito, ya que la grilla es la herramienta de trabajo del
// corredor y no siempre tiene sentido ir hasta el mapa solo para
// cambiar el estado o el sector de un lote. Mismos campos editables que
// ya existían sueltos (servicios, sector) más estado/precio/
// descripción, que hasta ahora solo se cargaban una vez al crearlo.
export function mostrarListaLotesGrilla() {
  elLoteVistaEditar.classList.add("oculto");
  elLoteVistaLista.classList.remove("oculto");
  loteEditandoDesdeGrilla = null;
}

export function mostrarEditarLoteDesdeGrilla(feature) {
  loteEditandoDesdeGrilla = feature;
  const p = feature.properties;
  elLoteEditarTitulo.textContent = `Editar ${tituloLote(p)}`;
  elEditarLoteManzana.value = p.manzana || "";
  elEditarLoteNumero.value = p.lote || "";
  elEditarLoteNomenclatura.value = p.nomenclatura || "";
  elEditarLoteSuperficie.value = p.superficie_m2 ?? "";
  elEditarLoteEstado.value = p.estado || "disponible";
  elEditarLoteReservadoHasta.value = p.reservado_hasta || "";
  actualizarVisibilidadReservadoHasta();
  actualizarVisibilidadComprador(p.comprador_contacto_id || "");
  elEditarLotePrecio.value = p.precio_usd ?? "";
  poblarSelectSector(elEditarLoteSector, p.sector);
  poblarSelectBarrio(elEditarLoteBarrio, p.barrio);
  const s = p.servicios || {};
  elEditarLoteServicioLuz.checked = !!s.luz;
  elEditarLoteServicioAgua.checked = !!s.agua;
  elEditarLoteServicioGas.checked = !!s.gas;
  elEditarLoteServicioCloaca.checked = !!s.cloaca;
  elEditarLoteDescripcion.value = p.descripcion || "";
  // Las notas viven en una subcolección (js/notas-internas.js), no en el
  // documento del lote, así que hay que ir a buscarlas. Se limpia primero
  // para no mostrar por un instante las del lote anterior.
  elEditarLoteNotas.value = "";
  leerNotasInternas(feature.id).then((texto) => {
    // Pudo haberse abierto la edición de otro lote mientras respondía.
    if (loteEditandoDesdeGrilla !== feature) return;
    // Y tampoco se pisa lo que el corredor YA empezó a escribir: esta
    // respuesta llega DESPUÉS de que el formulario está en pantalla, así
    // que sin este chequeo el texto tipeado en el medio se perdía sin
    // aviso — y si el lote no tenía notas, se perdía reemplazado por
    // vacío. La ventana es una lectura a Firestore: en la conexión rural
    // que este proyecto tiene como caso normal, más de un segundo.
    if (elEditarLoteNotas.value === "") elEditarLoteNotas.value = texto || "";
  });
  elEditarLoteError.classList.add("oculto");

  elLoteVistaLista.classList.add("oculto");
  elLoteVistaEditar.classList.remove("oculto");
}

elLoteEditarVolver.addEventListener("click", mostrarListaLotesGrilla);

formularioEditarLote.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!loteEditandoDesdeGrilla) return;
  elEditarLoteError.classList.add("oculto");

  const boton = formularioEditarLote.querySelector('button[type="submit"]');
  boton.disabled = true;
  try {
    const nomenclatura = elEditarLoteNomenclatura.value.trim() || null;

    // Mismo chequeo que "Cargar a mano": si esta nomenclatura ya está en
    // OTRO lote, avisar en vez de dejar dos lotes con la misma. Se
    // excluye el propio lote de la búsqueda — si no cambió la
    // nomenclatura (el caso más común), no tiene que chocar consigo
    // mismo.
    if (nomenclatura) {
      const yaExiste = await getDocs(
        query(collection(db, COLECCION_LOTES), where("nomenclatura", "==", nomenclatura))
      );
      const loEstaUsandoOtroLote = yaExiste.docs.some((d) => d.id !== loteEditandoDesdeGrilla.id);
      if (loEstaUsandoOtroLote) {
        throw new Error(`Ya hay otro lote cargado con la nomenclatura ${nomenclatura}.`);
      }
    }

    const datos = {
      manzana: elEditarLoteManzana.value.trim() || null,
      lote: elEditarLoteNumero.value.trim() || null,
      nomenclatura,
      superficie_m2: elEditarLoteSuperficie.value.trim() === "" ? null : Number(elEditarLoteSuperficie.value),
      estado: elEditarLoteEstado.value,
      // Se limpia sola si el estado deja de ser "reservado" — no tiene
      // sentido arrastrar una fecha de reserva vieja en un lote que ya
      // se vendió o volvió a estar disponible.
      reservado_hasta:
        elEditarLoteEstado.value === "reservado" ? elEditarLoteReservadoHasta.value || null : null,
      // Mismo criterio que reservado_hasta: solo tiene sentido con
      // "Vendido" cargado, se limpia solo si no.
      comprador_contacto_id: elEditarLoteEstado.value === "vendido" ? elEditarLoteComprador.value || null : null,
      comprador_nombre:
        elEditarLoteEstado.value === "vendido" && elEditarLoteComprador.value
          ? elEditarLoteComprador.options[elEditarLoteComprador.selectedIndex].textContent
          : null,
      precio_usd: elEditarLotePrecio.value.trim() === "" ? null : Number(elEditarLotePrecio.value),
      sector: elEditarLoteSector.value.trim() || null,
      barrio: elEditarLoteBarrio.value.trim() || null,
      servicios: {
        luz: elEditarLoteServicioLuz.checked,
        agua: elEditarLoteServicioAgua.checked,
        gas: elEditarLoteServicioGas.checked,
        cloaca: elEditarLoteServicioCloaca.checked
      },
      descripcion: elEditarLoteDescripcion.value.trim() || null
    };

    // Para la auditoría: si el estado entra o sale de "reservado"/
    // "vendido" en este mismo guardado, eso es lo que se registra
    // (reservar_lote/quitar_reserva/vender_lote) en vez de un
    // "editar_lote" genérico — es el dato más sensible comercialmente de
    // todo lo que puede cambiar acá. Si no hubo ese cruce puntual, es una
    // edición común.
    const estadoAnterior = loteEditandoDesdeGrilla.properties.estado;
    let accionAuditoria = "editar_lote";
    if (estadoAnterior !== "reservado" && datos.estado === "reservado") accionAuditoria = "reservar_lote";
    else if (estadoAnterior === "reservado" && datos.estado !== "reservado") accionAuditoria = "quitar_reserva";
    else if (estadoAnterior !== "vendido" && datos.estado === "vendido") accionAuditoria = "vender_lote";

    await updateDoc(doc(db, COLECCION_LOTES, loteEditandoDesdeGrilla.id), datos);
    // Las notas no son un campo del lote sino una subcolección aparte
    // (js/notas-internas.js), así que son una escritura PROPIA y pueden
    // fallar solas — con el lote ya guardado.
    //
    // Por eso este try/catch y no dejar que el error suba al de afuera:
    // así el corredor veía "No tenés permiso para editar este lote", que
    // es falso (lo tenía, y el lote se guardó), y además el error cortaba
    // antes de refrescar la pantalla, así que parecía que no había pasado
    // nada mientras Firestore ya tenía los cambios. Pasó de verdad: con
    // la regla de lotes/{id}/privado sin publicar, toda edición con nota
    // terminaba así.
    try {
      await guardarNotasInternas(loteEditandoDesdeGrilla.id, elEditarLoteNotas.value);
    } catch (error) {
      // El lote sí se guardó: se refleja en memoria y en la lista igual
      // que en el camino feliz, y el formulario queda abierto para poder
      // reintentar la nota sin recargar nada.
      Object.assign(loteEditandoDesdeGrilla.properties, datos);
      await cargarLotesDesdeFirestore();
      elEditarLoteError.textContent =
        error.code === "permission-denied"
          ? "Los cambios del lote se guardaron, pero la nota interna no: falta un permiso. Avisale a quien administra la app."
          : "Los cambios del lote se guardaron, pero la nota interna no se pudo guardar.";
      elEditarLoteError.classList.remove("oculto");
      return;
    }
    Object.assign(loteEditandoDesdeGrilla.properties, datos);
    registrarAuditoria({
      accion: accionAuditoria,
      objetoId: loteEditandoDesdeGrilla.id,
      objetoTitulo: tituloLote(datos),
      detalle:
        accionAuditoria === "reservar_lote" && datos.reservado_hasta
          ? `Hasta ${datos.reservado_hasta}`
          : accionAuditoria === "vender_lote" && datos.comprador_nombre
            ? `A ${datos.comprador_nombre}`
            : null
    });

    if (getLoteEditadoDesdeFicha()) {
      // Se entró desde "Editar lote" en el mapa: volver ahí (con la
      // ficha ya actualizada), no a la lista — el mapa nunca se tocó
      // durante la edición, así que sigue centrado en la misma zona de
      // antes sin hacer nada especial acá.
      const loteGuardado = loteEditandoDesdeGrilla;
      loteEditandoDesdeGrilla = null;
      elLoteVistaEditar.classList.add("oculto");
      elLoteVistaLista.classList.remove("oculto"); // deja la vista interna lista para la próxima vez que se entre por la grilla
      navegarA("/"); // vuelve al mapa con la ficha, dejando la URL en "/"
      mostrarFicha(loteGuardado);
    } else {
      mostrarListaLotesGrilla();
    }

    await cargarLotesDesdeFirestore();
  } catch (error) {
    elEditarLoteError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para editar este lote."
        : error.message || "No se pudieron guardar los cambios.";
    elEditarLoteError.classList.remove("oculto");
  } finally {
    boton.disabled = false;
  }
});

// Compartida entre el click de "Ver como lista" y el deep link de un
// filtro compartido (más abajo) — las dos formas de abrir este panel
// tienen que cerrar los otros paneles de pantalla completa igual.
// Ya no esconde las otras pantallas ni toca #nav-secciones: lo hace
// js/router.js antes de que esto corra (ver el comentario allá).
function abrirPanelVistaLista() {
  mostrarListaLotesGrilla(); // siempre arranca en la lista, no en edición
  elVistaLista.classList.remove("oculto");
}

// Antes era un toggle ("Ver como lista" prendía y apagaba la grilla).
// Desde que la lista es una sección con su propia URL (/lotes) pasó a
// ser una navegación como cualquier otra: el ítem del menú entra, y se
// sale con la flecha ← o eligiendo otra sección. El ← es data-volver,
// así que lo maneja el router y este archivo ya no necesita cerrarlo.
elBtnVerLista.addEventListener("click", abrirPanelVistaLista);

// "Compartir este filtro": mismo criterio que "Compartir este lote"
// (ficha.js) pero para el estado completo de los filtros de esta grilla
// en vez de un lote puntual — útil para mandarle a un colega "mirá los
// lotes disponibles de tal zona entre tal y tal precio" sin tener que
// explicarle qué tocar.
const elCompartirFiltroMensaje = document.getElementById("compartir-filtro-mensaje");

document.getElementById("btn-compartir-filtro").addEventListener("click", async () => {
  const parametros = new URLSearchParams();
  parametros.set("vista", "lista");
  if (elFiltroBuscar.value.trim()) parametros.set("buscar", elFiltroBuscar.value.trim());
  if (elFiltroSector.value) parametros.set("sector", elFiltroSector.value);
  if (elFiltroBarrio.value) parametros.set("barrio", elFiltroBarrio.value);
  if (elFiltroEstado.value) parametros.set("estado", elFiltroEstado.value);
  if (elFiltroPrecioMin.value) parametros.set("precioMin", elFiltroPrecioMin.value);
  if (elFiltroPrecioMax.value) parametros.set("precioMax", elFiltroPrecioMax.value);
  if (elFiltroSuperficieMin.value) parametros.set("superficieMin", elFiltroSuperficieMin.value);
  if (elFiltroSuperficieMax.value) parametros.set("superficieMax", elFiltroSuperficieMax.value);
  if (elFiltroOrden.value) parametros.set("orden", elFiltroOrden.value);
  const url = `${location.origin}${location.pathname}?${parametros.toString()}`;

  if (navigator.share) {
    try {
      await navigator.share({ title: "MojonApp - Lotes filtrados", url });
    } catch {
      // Cancelado por quien comparte, o bloqueado por el navegador — no
      // es un error real, no hace falta avisar nada (mismo criterio que
      // "Compartir este lote").
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(url);
    elCompartirFiltroMensaje.textContent = "Link copiado.";
    elCompartirFiltroMensaje.classList.remove("oculto");
    setTimeout(() => elCompartirFiltroMensaje.classList.add("oculto"), 2500);
  } catch {
    elCompartirFiltroMensaje.textContent = url;
    elCompartirFiltroMensaje.classList.remove("oculto");
  }
});

// Si la app se abrió con "?vista=lista" (link armado por "Compartir este
// filtro"), abre el panel con los filtros de la URL ya aplicados. Se
// engancha en los mismos dos puntos que abrirLoteDesdeUrlSiCorresponde
// (ficha.js) — ver ese comentario en app.js —, pero a diferencia de esa
// función esto NO necesita reaplicarse en cada carga: una vez que el
// usuario está mirando la lista con sus filtros, una segunda carga de
// lotes (login/logout) no debería volver a pisarle lo que ya eligió.
let filtroUrlYaAplicado = false;

export function aplicarFiltrosDesdeUrlSiCorresponde() {
  if (filtroUrlYaAplicado) return;
  const parametros = new URLSearchParams(location.search);
  if (parametros.get("vista") !== "lista") return;
  filtroUrlYaAplicado = true;

  abrirPanelVistaLista();

  // Los <select> de sector/barrio ya están poblados con datos reales acá
  // (mapa.js llama actualizarVistaLista() apenas termina de cargar los
  // lotes, antes de este punto) — si el valor de la URL no coincide con
  // ninguna opción real, el navegador simplemente lo ignora y el select
  // se queda en "Todas las zonas"/"Todos los barrios".
  if (parametros.has("buscar")) elFiltroBuscar.value = parametros.get("buscar");
  if (parametros.has("sector")) elFiltroSector.value = parametros.get("sector");
  if (parametros.has("barrio")) elFiltroBarrio.value = parametros.get("barrio");
  if (parametros.has("estado")) elFiltroEstado.value = parametros.get("estado");
  if (parametros.has("precioMin")) elFiltroPrecioMin.value = parametros.get("precioMin");
  if (parametros.has("precioMax")) elFiltroPrecioMax.value = parametros.get("precioMax");
  if (parametros.has("superficieMin")) elFiltroSuperficieMin.value = parametros.get("superficieMin");
  if (parametros.has("superficieMax")) elFiltroSuperficieMax.value = parametros.get("superficieMax");
  // Igual que sector/barrio: si el valor de la URL no es una de las
  // opciones válidas del <select>, el navegador lo ignora y queda en
  // "Más recientes primero" — no hace falta validarlo a mano acá.
  if (parametros.has("orden")) elFiltroOrden.value = parametros.get("orden");

  reiniciarPaginaYActualizar();
}
