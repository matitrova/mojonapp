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

import { getLotesActuales, getLoteEditadoDesdeFicha, setLoteEditadoDesdeFicha } from "./estado.js";
import { centroideDePoligono } from "./geometria.js";
import { poblarSelectSector, poblarSelectBarrio } from "./catalogos.js";
import { registrarAuditoria } from "./auditoria.js";

const COLECCION_LOTES = "lotes";

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
const elFiltroSector = document.getElementById("filtro-sector");
const elFiltroBarrio = document.getElementById("filtro-barrio");
const elFiltroEstado = document.getElementById("filtro-estado");
const elFiltroPrecioMin = document.getElementById("filtro-precio-min");
const elFiltroPrecioMax = document.getElementById("filtro-precio-max");
const elFiltroSuperficieMin = document.getElementById("filtro-superficie-min");
const elFiltroSuperficieMax = document.getElementById("filtro-superficie-max");
const elFiltroCantidad = document.getElementById("filtro-cantidad");
const elPaginacion = document.getElementById("vista-lista-paginacion");
const elPaginaAnterior = document.getElementById("pagina-anterior");
const elPaginaSiguiente = document.getElementById("pagina-siguiente");
const elPaginaInfo = document.getElementById("pagina-info");

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

// El campo "Reservado hasta" solo tiene sentido con estado "Reservado"
// — se muestra/oculta solo al cambiar el estado en el formulario.
function actualizarVisibilidadReservadoHasta() {
  elEditarLoteReservadoHastaLabel.classList.toggle("oculto", elEditarLoteEstado.value !== "reservado");
}
elEditarLoteEstado.addEventListener("change", actualizarVisibilidadReservadoHasta);
const elEditarLoteSector = document.getElementById("editar-lote-sector");
const elEditarLoteBarrio = document.getElementById("editar-lote-barrio");
const elEditarLoteServicioLuz = document.getElementById("editar-lote-servicio-luz");
const elEditarLoteServicioAgua = document.getElementById("editar-lote-servicio-agua");
const elEditarLoteServicioGas = document.getElementById("editar-lote-servicio-gas");
const elEditarLoteServicioCloaca = document.getElementById("editar-lote-servicio-cloaca");
const elEditarLoteObservaciones = document.getElementById("editar-lote-observaciones");
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

function lotesFiltrados() {
  const precioMin = elFiltroPrecioMin.value ? Number(elFiltroPrecioMin.value) : null;
  const precioMax = elFiltroPrecioMax.value ? Number(elFiltroPrecioMax.value) : null;
  const superficieMin = elFiltroSuperficieMin.value ? Number(elFiltroSuperficieMin.value) : null;
  const superficieMax = elFiltroSuperficieMax.value ? Number(elFiltroSuperficieMax.value) : null;

  return getLotesActuales().filter((feature) => {
    const p = feature.properties;
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

  elTablaLotesCuerpo.innerHTML = "";
  elVistaListaVacio.classList.toggle("oculto", getLotesActuales().length > 0);
  // Distinto de "no hay lotes cargados": acá SÍ hay lotes, pero ninguno
  // coincide con el sector/estado elegido — un mensaje genérico de
  // "vacío" hubiera hecho pensar que se perdió todo lo cargado.
  elVistaListaSinResultados.classList.toggle("oculto", getLotesActuales().length === 0 || lotes.length > 0);
  elTablaLotes.classList.toggle("oculto", lotes.length === 0);

  lotesPagina.forEach((feature) => {
    const p = feature.properties;
    const fila = document.createElement("tr");
    fila.className = "fila-lote";
    fila.dataset.loteId = feature.id; // permite ubicar una fila puntual (tests, debug)
    fila.innerHTML = `
      <td>${tituloLote(p)}</td>
      <td>${p.sector || "—"}</td>
      <td>${p.barrio || "—"}</td>
      <td>${p.superficie_m2 == null ? "—" : `${p.superficie_m2} m²`}</td>
      <td>${textoEstadoConVencimiento(p)}</td>
      <td>${p.precio_usd == null ? "—" : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`}</td>
      <td>${p.servicios == null ? "—" : renderServiciosHTML(p.servicios)}</td>
      <td></td>
    `;

    // Tocar la fila lleva al mapa, centrado en ese lote, y abre su ficha.
    fila.addEventListener("click", () => {
      elVistaLista.classList.add("oculto");
      elBtnVerLista.classList.remove("activo");
      const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
      mapa.setView([lat, lon], 19);
      mostrarFicha(feature);
    });

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

function reiniciarPaginaYActualizar() {
  paginaActual = 1;
  actualizarVistaLista();
}
elFiltroSector.addEventListener("change", reiniciarPaginaYActualizar);
elFiltroBarrio.addEventListener("change", reiniciarPaginaYActualizar);
elFiltroEstado.addEventListener("change", reiniciarPaginaYActualizar);
elFiltroPrecioMin.addEventListener("input", reiniciarPaginaYActualizar);
elFiltroPrecioMax.addEventListener("input", reiniciarPaginaYActualizar);
elFiltroSuperficieMin.addEventListener("input", reiniciarPaginaYActualizar);
elFiltroSuperficieMax.addEventListener("input", reiniciarPaginaYActualizar);
elFiltroCantidad.addEventListener("change", reiniciarPaginaYActualizar);

// Editar un lote directo desde la grilla (sin pasar por el mapa/ficha):
// pedido explícito, ya que la grilla es la herramienta de trabajo del
// corredor y no siempre tiene sentido ir hasta el mapa solo para
// cambiar el estado o el sector de un lote. Mismos campos editables que
// ya existían sueltos (servicios, sector) más estado/precio/
// observaciones, que hasta ahora solo se cargaban una vez al crearlo.
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
  elEditarLotePrecio.value = p.precio_usd ?? "";
  poblarSelectSector(elEditarLoteSector, p.sector);
  poblarSelectBarrio(elEditarLoteBarrio, p.barrio);
  const s = p.servicios || {};
  elEditarLoteServicioLuz.checked = !!s.luz;
  elEditarLoteServicioAgua.checked = !!s.agua;
  elEditarLoteServicioGas.checked = !!s.gas;
  elEditarLoteServicioCloaca.checked = !!s.cloaca;
  elEditarLoteObservaciones.value = p.observaciones || "";
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
      precio_usd: elEditarLotePrecio.value.trim() === "" ? null : Number(elEditarLotePrecio.value),
      sector: elEditarLoteSector.value.trim() || null,
      barrio: elEditarLoteBarrio.value.trim() || null,
      servicios: {
        luz: elEditarLoteServicioLuz.checked,
        agua: elEditarLoteServicioAgua.checked,
        gas: elEditarLoteServicioGas.checked,
        cloaca: elEditarLoteServicioCloaca.checked
      },
      observaciones: elEditarLoteObservaciones.value.trim() || null
    };

    // Para la auditoría: si el estado entra o sale de "reservado" en este
    // mismo guardado, eso es lo que se registra (reservar_lote/quitar_
    // reserva) en vez de un "editar_lote" genérico — es el dato más
    // sensible comercialmente de todo lo que puede cambiar acá. Si no
    // hubo ese cruce puntual, es una edición común.
    const estadoAnterior = loteEditandoDesdeGrilla.properties.estado;
    let accionAuditoria = "editar_lote";
    if (estadoAnterior !== "reservado" && datos.estado === "reservado") accionAuditoria = "reservar_lote";
    else if (estadoAnterior === "reservado" && datos.estado !== "reservado") accionAuditoria = "quitar_reserva";

    await updateDoc(doc(db, COLECCION_LOTES, loteEditandoDesdeGrilla.id), datos);
    Object.assign(loteEditandoDesdeGrilla.properties, datos);
    registrarAuditoria({
      accion: accionAuditoria,
      objetoId: loteEditandoDesdeGrilla.id,
      objetoTitulo: tituloLote(datos),
      detalle: accionAuditoria === "reservar_lote" && datos.reservado_hasta ? `Hasta ${datos.reservado_hasta}` : null
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
      elVistaLista.classList.add("oculto");
      elBtnVerLista.classList.remove("activo");
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

elBtnVerLista.addEventListener("click", () => {
  const mostrar = elVistaLista.classList.contains("oculto");
  document.getElementById("panel-admin").classList.add("oculto"); // no superponer con "Seguridad"
  document.getElementById("panel-sectores").classList.add("oculto"); // ni con "Zonas"
  document.getElementById("panel-barrios").classList.add("oculto"); // ni con "Barrios"
  document.getElementById("panel-dashboard").classList.add("oculto"); // ni con "Dashboard"
  if (mostrar) mostrarListaLotesGrilla(); // siempre arranca en la lista, no en edición
  elVistaLista.classList.toggle("oculto", !mostrar);
  elBtnVerLista.classList.toggle("activo", mostrar);
});
document.getElementById("cerrar-vista-lista").addEventListener("click", () => {
  elVistaLista.classList.add("oculto");
  elBtnVerLista.classList.remove("activo");
});
