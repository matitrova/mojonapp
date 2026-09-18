// ---------------------------------------------------------------------------
// CRM — formulario de alta/edición de contacto: lotes de interés,
// etiquetas, actividad, WhatsApp/motivo de pérdida en vivo, aviso de
// posible duplicado, fusionar con otro contacto, y el guardar/borrar del
// contacto mismo.
//
// Tercera etapa de la modularización de crm.js (ver el plan en curso).
// Este módulo SÍ necesita cosas del kanban (refrescar el pipeline al
// guardar/borrar/fusionar, volver a mostrarlo, saltar a un lote desde un
// chip) — en vez de `import` directo de crm.js (que crearía un ciclo real,
// porque crm.js importa `mostrarForm` de acá), las recibe por parámetro
// vía configurarFormulario(), mismo patrón que configurarCrm.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  arrayUnion
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getContactosActuales, getLotesActuales } from "./estado.js";
import { registrarAuditoria } from "./auditoria.js";
import {
  ETIQUETA_ACTIVIDAD,
  TIPOS_ACTIVIDAD_AUTOMATICA,
  actividadesAutomaticas,
  linkWhatsapp,
  lotesSugeridos,
  plantillasMensaje
} from "./crm-metricas.js";
import {
  COLECCION_CONTACTOS,
  cargarContactos,
  puedeVerTodosLosContactos,
  obtenerUsuariosPorUidCache,
  textoAsignado
} from "./crm-datos.js";
// Catálogos del CRM: devuelven el nombre canónico y, si es nuevo, lo dejan
// guardado para la próxima. catalogos.js no importa nada de acá, así que
// no hay riesgo de ciclo.
import { asegurarMotivo, asegurarEtiqueta } from "./catalogos.js";

let renderTodo, mostrarKanban, irALoteDesdeCrm, tituloLote;
export function configurarFormulario(deps) {
  ({ renderTodo, mostrarKanban, irALoteDesdeCrm, tituloLote } = deps);
}

const elVistaKanban = document.getElementById("crm-vista-kanban");
const elVistaForm = document.getElementById("crm-vista-form");
const formulario = document.getElementById("formulario-contacto");
const elFormTitulo = document.getElementById("crm-form-titulo");
const elIdEditando = document.getElementById("contacto-id-editando");
const elNotaFijada = document.getElementById("contacto-nota-fijada");
const elNombre = document.getElementById("contacto-nombre");
const elTelefono = document.getElementById("contacto-telefono");
const elWhatsapp = document.getElementById("contacto-whatsapp");
const elPlantillasWhatsapp = document.getElementById("crm-plantillas-whatsapp");
const elSelectPlantilla = document.getElementById("crm-select-plantilla");
const elBtnEnviarPlantilla = document.getElementById("crm-btn-enviar-plantilla");
const elAvisoDuplicado = document.getElementById("crm-aviso-duplicado");
const elAvisoDuplicadoTexto = document.getElementById("crm-aviso-duplicado-texto");
const elBtnAbrirDuplicado = document.getElementById("btn-abrir-duplicado");
const elTabDatos = document.getElementById("crm-tab-datos");
const elTabLotes = document.getElementById("crm-tab-lotes");
const elTabActividad = document.getElementById("crm-tab-actividad");
const elPanelDatos = document.getElementById("crm-panel-datos");
const elPanelLotes = document.getElementById("crm-panel-lotes");
const elPanelActividad = document.getElementById("crm-panel-actividad");
const elEmail = document.getElementById("contacto-email");
const elEstado = document.getElementById("contacto-estado");
const elCampoMotivoPerdido = document.getElementById("crm-campo-motivo-perdido");
const elMotivoPerdido = document.getElementById("contacto-motivo-perdido");
const elCampoAsignado = document.getElementById("crm-campo-asignado");
const elSelectAsignado = document.getElementById("contacto-asignado");
const elSeguimientoInput = document.getElementById("contacto-seguimiento");
const elListaLotesInteres = document.getElementById("crm-lista-lotes-interes");
const elLotesInteresVacio = document.getElementById("crm-lotes-interes-vacio");
const elSelectLote = document.getElementById("crm-select-lote");
const elBtnAgregarLoteInteres = document.getElementById("btn-agregar-lote-interes");
const elMiniMapa = document.getElementById("crm-mini-mapa");
const elCrmSugeridos = document.getElementById("crm-sugeridos");
const elListaSugeridos = document.getElementById("crm-lista-sugeridos");
const elListaEtiquetas = document.getElementById("crm-lista-etiquetas");
const elEtiquetasVacio = document.getElementById("crm-etiquetas-vacio");
const elInputEtiqueta = document.getElementById("crm-input-etiqueta");
const elBtnAgregarEtiqueta = document.getElementById("btn-agregar-etiqueta");
const elListaActividades = document.getElementById("crm-lista-actividades");
const elActividadesVacio = document.getElementById("crm-actividades-vacio");
const elAgregarActividad = document.getElementById("crm-agregar-actividad");
const elActividadPrimeroGuardar = document.getElementById("crm-actividad-primero-guardar");
const elActividadTipo = document.getElementById("actividad-tipo");
const elActividadTexto = document.getElementById("actividad-texto");
const elBtnAgregarActividad = document.getElementById("btn-agregar-actividad");
const elBtnGuardarContacto = document.getElementById("contacto-guardar-btn");
const elBtnBorrarContacto = document.getElementById("btn-borrar-contacto");
const elError = document.getElementById("contacto-error");
const elCrmFusionar = document.getElementById("crm-fusionar");
const elBtnFusionarContacto = document.getElementById("btn-fusionar-contacto");
const elCrmFusionarPanel = document.getElementById("crm-fusionar-panel");
const elCrmFusionarSelect = document.getElementById("crm-fusionar-select");
const elBtnFusionarConfirmar = document.getElementById("btn-fusionar-confirmar");
const elBtnFusionarCancelar = document.getElementById("btn-fusionar-cancelar");

// Lotes de interés/etiquetas del contacto que se está editando/creando en
// este momento — viven acá (no en Firestore) hasta que se guarda el
// formulario, evita un updateDoc por cada "+ Agregar"/"Quitar" mientras
// se completa el alta.
let lotesInteresEnEdicion = [];
let etiquetasEnEdicion = [];

// {id, nombre} del contacto que se está editando ahora mismo, o null si
// es un alta nueva (todavía sin guardar/sin id) — se le pasa a
// irALoteDesdeCrm para que la ficha de destino pueda mostrar "← Volver
// a [contacto]" (idea propia #2 de "el mapa como una cualidad del
// CRM"). Sin id todavía no tiene sentido "volver" a nada.
function contactoOrigenActual() {
  return elIdEditando.value ? { id: elIdEditando.value, nombre: elNombre.value } : null;
}

// ---------------------------------------------------------------------------
// Pestañas Datos/Lotes/Actividad (mismo patrón .tabs-admin/.tab-admin que
// Usuarios/Perfiles en js/admin.js — ver mostrarTabUsuarios/mostrarTabPerfiles).
// ---------------------------------------------------------------------------

function mostrarTabDatos() {
  elTabDatos.classList.add("activo");
  elTabLotes.classList.remove("activo");
  elTabActividad.classList.remove("activo");
  elPanelDatos.classList.remove("oculto");
  elPanelLotes.classList.add("oculto");
  elPanelActividad.classList.add("oculto");
}

function mostrarTabLotes() {
  elTabLotes.classList.add("activo");
  elTabDatos.classList.remove("activo");
  elTabActividad.classList.remove("activo");
  elPanelLotes.classList.remove("oculto");
  elPanelDatos.classList.add("oculto");
  elPanelActividad.classList.add("oculto");
  // El mini-mapa se renderiza en mostrarForm(), mientras esta pestaña
  // todavía está oculta (arranca en "Datos") — Leaflet mide el
  // contenedor en 0x0 en ese momento y se queda con ese tamaño "roto"
  // para siempre si nadie lo invalida de nuevo. Recién ahora, con el
  // panel ya visible de verdad, tiene sentido volver a calcular tamaño/
  // encuadre (mismo motivo que renderMiniMapa ya invalida al abrir el
  // formulario por primera vez).
  renderMiniMapa();
}

function mostrarTabActividad() {
  elTabActividad.classList.add("activo");
  elTabDatos.classList.remove("activo");
  elTabLotes.classList.remove("activo");
  elPanelActividad.classList.remove("oculto");
  elPanelDatos.classList.add("oculto");
  elPanelLotes.classList.add("oculto");
}

elTabDatos.addEventListener("click", mostrarTabDatos);
elTabLotes.addEventListener("click", mostrarTabLotes);
elTabActividad.addEventListener("click", mostrarTabActividad);

// ---------------------------------------------------------------------------
// Lotes de interés.
// ---------------------------------------------------------------------------

function renderListaLotesInteres() {
  elListaLotesInteres.innerHTML = "";
  lotesInteresEnEdicion.forEach((lote) => {
    const li = document.createElement("li");
    li.className = "crm-chip-lote";

    const botonTitulo = document.createElement("button");
    botonTitulo.type = "button";
    botonTitulo.className = "crm-chip-titulo";
    botonTitulo.textContent = lote.titulo;
    botonTitulo.addEventListener("click", () => irALoteDesdeCrm(lote.id, contactoOrigenActual()));
    li.appendChild(botonTitulo);

    const botonQuitar = document.createElement("button");
    botonQuitar.type = "button";
    botonQuitar.className = "crm-chip-quitar";
    botonQuitar.textContent = "×";
    botonQuitar.setAttribute("aria-label", `Quitar ${lote.titulo} de lotes de interés`);
    botonQuitar.addEventListener("click", () => {
      lotesInteresEnEdicion = lotesInteresEnEdicion.filter((l) => l.id !== lote.id);
      renderListaLotesInteres();
      renderLotesSugeridos();
      renderMiniMapa();
      actualizarPlantillasWhatsapp();
    });
    li.appendChild(botonQuitar);

    elListaLotesInteres.appendChild(li);
  });
  elLotesInteresVacio.classList.toggle("oculto", lotesInteresEnEdicion.length > 0);
}

function poblarSelectLotes() {
  const lotes = getLotesActuales();
  elSelectLote.innerHTML = lotes.map((f) => `<option value="${f.id}">${tituloLote(f.properties)}</option>`).join("");
}

// Mini-mapa de "Lotes de interés" (idea propia — "el mapa como una
// cualidad del CRM", no una pantalla aparte que hay que ir a buscar):
// mismo satelital que el mapa principal (Esri World Imagery), un solo
// polígono o varios, sin controles — solo para ubicar de un vistazo
// dónde está el interés de este contacto. Se crea una ÚNICA instancia
// de Leaflet (nunca una por render — "Map container is already
// initialized" si se repite) y se reusa, actualizando solo la capa de
// polígonos. `invalidateSize()` es necesario porque el contenedor pudo
// haber estado en display:none (oculto) la última vez que se calculó
// su tamaño.
let miniMapa = null;
let capaMiniMapa = null;

function renderMiniMapa() {
  const features = lotesInteresEnEdicion
    .map((li) => getLotesActuales().find((f) => f.id === li.id))
    .filter(Boolean);
  elMiniMapa.classList.toggle("oculto", features.length === 0);
  if (features.length === 0) return;

  if (!miniMapa) {
    miniMapa = L.map("crm-mini-mapa", {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false
    });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 20,
      maxNativeZoom: 18
    }).addTo(miniMapa);
  }

  if (capaMiniMapa) miniMapa.removeLayer(capaMiniMapa);
  capaMiniMapa = L.geoJSON(
    { type: "FeatureCollection", features },
    {
      style: { color: "#ffffff", weight: 2, fillColor: "#c1663f", fillOpacity: 0.55 },
      onEachFeature: (feature, layer) => {
        layer.on("click", () => irALoteDesdeCrm(feature.id, contactoOrigenActual()));
      }
    }
  ).addTo(miniMapa);

  requestAnimationFrame(() => {
    miniMapa.invalidateSize();
    miniMapa.fitBounds(capaMiniMapa.getBounds(), { padding: [12, 12], maxZoom: 18 });
  });
}

// Matching lote↔interesado por reglas (zona/precio/superficie de los lotes
// de interés ya cargados) — cero costo, no llama a ningún servicio externo.
// Se recalcula cada vez que cambian los lotes de interés en edición.
function renderLotesSugeridos() {
  const sugerencias = lotesSugeridos(lotesInteresEnEdicion);
  elCrmSugeridos.classList.toggle("oculto", sugerencias.length === 0);
  elListaSugeridos.innerHTML = "";
  sugerencias.forEach(({ feature, motivos }) => {
    const li = document.createElement("li");
    li.className = "crm-chip-sugerido";

    const info = document.createElement("div");
    info.className = "crm-chip-sugerido-info";
    // Mismo <button> clickeable que los chips de "Lotes de interés" (ver
    // renderListaLotesInteres): .crm-chip-titulo se ve como un link, así
    // que acá era un <span> que parecía clickeable y no llevaba a ningún
    // lado — bug reportado por el usuario. Lleva a la ficha real del lote
    // aunque todavía no sea un interés guardado: sirve justo para ir a
    // mirarlo antes de decidir si agregarlo.
    const titulo = document.createElement("button");
    titulo.type = "button";
    titulo.className = "crm-chip-titulo";
    titulo.textContent = tituloLote(feature.properties);
    titulo.addEventListener("click", () => irALoteDesdeCrm(feature.id, contactoOrigenActual()));
    info.appendChild(titulo);
    if (motivos.length > 0) {
      const razon = document.createElement("span");
      razon.className = "crm-chip-sugerido-motivo";
      razon.textContent = motivos.join(", ");
      info.appendChild(razon);
    }
    li.appendChild(info);

    const botonAgregar = document.createElement("button");
    botonAgregar.type = "button";
    botonAgregar.className = "crm-chip-agregar";
    botonAgregar.textContent = "+ Agregar";
    botonAgregar.addEventListener("click", () => {
      lotesInteresEnEdicion.push({ id: feature.id, titulo: tituloLote(feature.properties) });
      renderListaLotesInteres();
      renderLotesSugeridos();
      renderMiniMapa();
      actualizarPlantillasWhatsapp();
    });
    li.appendChild(botonAgregar);

    elListaSugeridos.appendChild(li);
  });
}

// "Asignado a" — reasignar es elegir otro corredor de la lista y guardar,
// nada más especial que eso. Solo tiene sentido con "ver_todos_los_
// contactos" (o root): sin ese permiso un corredor gestiona su propia
// cartera nomás, mostrarle este campo no tendría nada útil para elegir.
// valorActual puede apuntar a un uid que ya no está en el cache (un
// corredor borrado después) — mismo criterio que poblarSelectCatalogo
// (catalogos.js): se agrega como opción aparte en vez de perder el dato.
function poblarSelectAsignado(valorActual) {
  const puede = puedeVerTodosLosContactos();
  elCampoAsignado.classList.toggle("oculto", !puede);
  if (!puede) return;

  const usuarios = obtenerUsuariosPorUidCache();
  const opciones = Object.entries(usuarios).sort((a, b) => a[1].localeCompare(b[1]));
  let html = opciones.map(([uid, email]) => `<option value="${uid}">${email}</option>`).join("");
  const valorFinal = valorActual || auth.currentUser?.uid;
  if (valorFinal && !usuarios[valorFinal]) {
    html += `<option value="${valorFinal}">${valorFinal} (usuario no encontrado)</option>`;
  }
  elSelectAsignado.innerHTML = html;
  elSelectAsignado.value = valorFinal;
}

elBtnAgregarLoteInteres.addEventListener("click", () => {
  const loteId = elSelectLote.value;
  if (!loteId || lotesInteresEnEdicion.some((l) => l.id === loteId)) return;
  const feature = getLotesActuales().find((f) => f.id === loteId);
  if (!feature) return;
  lotesInteresEnEdicion.push({ id: loteId, titulo: tituloLote(feature.properties) });
  renderListaLotesInteres();
  renderLotesSugeridos();
  renderMiniMapa();
  actualizarPlantillasWhatsapp();
});

// ---------------------------------------------------------------------------
// Etiquetas libres — mismo patrón visual que "Lotes de interés" (chip +
// quitar), pero de texto libre en vez de un <select> con catálogo fijo.
// ---------------------------------------------------------------------------

function renderListaEtiquetas() {
  elListaEtiquetas.innerHTML = "";
  etiquetasEnEdicion.forEach((etiqueta) => {
    const li = document.createElement("li");
    li.className = "crm-chip-lote";

    const texto = document.createElement("span");
    texto.className = "crm-chip-etiqueta-texto";
    texto.textContent = etiqueta;
    li.appendChild(texto);

    const botonQuitar = document.createElement("button");
    botonQuitar.type = "button";
    botonQuitar.className = "crm-chip-quitar";
    botonQuitar.textContent = "×";
    botonQuitar.setAttribute("aria-label", `Quitar etiqueta ${etiqueta}`);
    botonQuitar.addEventListener("click", () => {
      etiquetasEnEdicion = etiquetasEnEdicion.filter((e) => e !== etiqueta);
      renderListaEtiquetas();
    });
    li.appendChild(botonQuitar);

    elListaEtiquetas.appendChild(li);
  });
  elEtiquetasVacio.classList.toggle("oculto", etiquetasEnEdicion.length > 0);
}

async function agregarEtiquetaDesdeInput() {
  const valor = elInputEtiqueta.value.trim();
  if (!valor) return;
  elInputEtiqueta.value = "";
  elInputEtiqueta.focus();
  // El catálogo manda: si "urgente" ya está como "Urgente", se usa
  // "Urgente" — así el filtro del pipeline no termina con la misma
  // etiqueta escrita de tres formas. Si es nueva, queda en el catálogo
  // para la próxima (ver asegurarEtiqueta en catalogos.js).
  const canonico = (await asegurarEtiqueta(valor)) || valor;
  const yaExiste = etiquetasEnEdicion.some((e) => e.toLowerCase() === canonico.toLowerCase());
  if (!yaExiste) {
    etiquetasEnEdicion.push(canonico);
    renderListaEtiquetas();
  }
}

elBtnAgregarEtiqueta.addEventListener("click", agregarEtiquetaDesdeInput);
elInputEtiqueta.addEventListener("keydown", (evento) => {
  // Enter agrega la etiqueta en vez de mandar el formulario entero —
  // mismo criterio que cualquier campo de "chips" (Gmail, Notion, etc.).
  if (evento.key === "Enter") {
    evento.preventDefault();
    agregarEtiquetaDesdeInput();
  }
});

// ---------------------------------------------------------------------------
// Actividad (historial de interacciones) — reemplaza a un campo de "nota"
// único: cada llamada/visita/whatsapp queda registrada con fecha y autor,
// no se pisa la anterior. Se agrega con su propio guardado inmediato (no
// espera al "Guardar" del resto del formulario) — mismo criterio que
// "Interesados" en la ficha de un lote. Solo disponible con el contacto ya
// guardado (hace falta un id de documento para poder sumarle algo).
// ---------------------------------------------------------------------------

function renderActividades(contacto) {
  const actividades = [...(contacto?.actividades || [])].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  elListaActividades.innerHTML = "";
  actividades.forEach((actividad) => {
    const li = document.createElement("li");
    li.className = TIPOS_ACTIVIDAD_AUTOMATICA.includes(actividad.tipo) ? "crm-actividad crm-actividad-automatica" : "crm-actividad";

    const cabecera = document.createElement("div");
    cabecera.className = "crm-actividad-cabecera";
    const tipo = document.createElement("span");
    tipo.className = "crm-actividad-tipo";
    tipo.textContent = ETIQUETA_ACTIVIDAD[actividad.tipo] || actividad.tipo;
    cabecera.appendChild(tipo);
    const fecha = document.createElement("span");
    fecha.textContent = actividad.fecha
      ? new Date(actividad.fecha).toLocaleString("es-AR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        })
      : "";
    cabecera.appendChild(fecha);
    li.appendChild(cabecera);

    if (actividad.texto) {
      const texto = document.createElement("p");
      texto.className = "crm-actividad-texto";
      texto.textContent = actividad.texto;
      li.appendChild(texto);
    }

    elListaActividades.appendChild(li);
  });
  elActividadesVacio.classList.toggle("oculto", actividades.length > 0);
}

elBtnAgregarActividad.addEventListener("click", async () => {
  const idEditando = elIdEditando.value;
  const texto = elActividadTexto.value.trim();
  if (!idEditando || !texto) return;

  const actividad = {
    tipo: elActividadTipo.value,
    texto,
    fecha: new Date().toISOString(),
    autor_email: auth.currentUser?.email || null
  };
  elBtnAgregarActividad.disabled = true;
  try {
    await updateDoc(doc(db, COLECCION_CONTACTOS, idEditando), {
      actividades: arrayUnion(actividad),
      fecha_actualizacion: actividad.fecha
    });
    const contactoLocal = getContactosActuales().find((c) => c.id === idEditando);
    if (contactoLocal) {
      contactoLocal.actividades = [...(contactoLocal.actividades || []), actividad];
      contactoLocal.fecha_actualizacion = actividad.fecha;
      renderActividades(contactoLocal);
    }
    elActividadTexto.value = "";
  } catch (error) {
    window.alert(
      error.code === "permission-denied" ? "No tienes permiso para agregar actividad." : "No se pudo guardar la actividad."
    );
  } finally {
    elBtnAgregarActividad.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// WhatsApp directo y motivo de pérdida — reaccionan en vivo mientras se
// completa el formulario, no solo al precargar un contacto existente.
// ---------------------------------------------------------------------------

function actualizarBotonWhatsapp() {
  const link = linkWhatsapp(elTelefono.value);
  elWhatsapp.classList.toggle("oculto", !link);
  if (link) elWhatsapp.href = link;
  actualizarPlantillasWhatsapp();
}
elTelefono.addEventListener("input", actualizarBotonWhatsapp);

// Plantillas de WhatsApp con datos precargados (idea propia — versión
// gratis de los "envíos automáticos" de Tokko Broker: wa.me ya soporta
// precargar el texto con ?text=, sin API de WhatsApp Business). Se
// recalculan con lo que hay en el FORMULARIO en este momento (no un
// contacto ya guardado) para que sigan el borrador mientras se completa
// el alta — mismo criterio que "Lotes sugeridos".
let plantillasActuales = [];

function actualizarLinkPlantilla() {
  const plantilla = plantillasActuales.find((p) => p.id === elSelectPlantilla.value);
  if (plantilla) elBtnEnviarPlantilla.href = linkWhatsapp(elTelefono.value, plantilla.texto);
}
elSelectPlantilla.addEventListener("change", actualizarLinkPlantilla);

function actualizarPlantillasWhatsapp() {
  const hayWhatsapp = !elWhatsapp.classList.contains("oculto");
  elPlantillasWhatsapp.classList.toggle("oculto", !hayWhatsapp);
  if (!hayWhatsapp) return;
  plantillasActuales = plantillasMensaje({
    nombre: elNombre.value,
    lotesInteres: lotesInteresEnEdicion,
    estado: elEstado.value,
    proximoSeguimiento: elSeguimientoInput.value
  });
  elSelectPlantilla.innerHTML = plantillasActuales.map((p) => `<option value="${p.id}">${p.etiqueta}</option>`).join("");
  actualizarLinkPlantilla();
}

function actualizarVisibilidadMotivoPerdido() {
  elCampoMotivoPerdido.classList.toggle("oculto", elEstado.value !== "perdido");
}
elEstado.addEventListener("change", actualizarVisibilidadMotivoPerdido);
// "Recordatorio de visita" (plantillasMensaje) depende de la etapa y de
// la fecha agendada — se recalculan si cualquiera de las dos cambia.
elEstado.addEventListener("change", actualizarPlantillasWhatsapp);
elSeguimientoInput.addEventListener("change", actualizarPlantillasWhatsapp);

// Aviso de posible duplicado (idea propia — complementa "Fusionar con
// otro contacto…": mejor avisar ANTES de cargar dos veces a la misma
// persona que limpiarlo después a mano). Solo tiene sentido dando de
// alta — editando uno existente, comparar contra sí mismo no aporta
// nada. Coincide por teléfono normalizado (mismos dígitos, sin importar
// espacios/guiones) o por nombre exacto sin mayúsculas/minúsculas — no
// es un fuzzy-match sofisticado, es la misma heurística de "casi seguro
// es la misma persona" que ya usa crearContactoDesdeInteresado con el
// teléfono.
function contactoParecido() {
  if (elIdEditando.value) return null;
  const nombre = elNombre.value.trim().toLowerCase();
  const telefono = elTelefono.value.replace(/\D/g, "");
  if (!nombre && !telefono) return null;
  return (
    getContactosActuales().find((c) => {
      const mismoTelefono = telefono && (c.telefono || "").replace(/\D/g, "") === telefono;
      const mismoNombre = nombre && (c.nombre || "").trim().toLowerCase() === nombre;
      return mismoTelefono || mismoNombre;
    }) || null
  );
}

function actualizarAvisoDuplicado() {
  const match = contactoParecido();
  elAvisoDuplicado.classList.toggle("oculto", !match);
  if (!match) return;
  elAvisoDuplicadoTexto.textContent = `Ya hay un contacto parecido: "${match.nombre}"${
    match.telefono ? ` (${match.telefono})` : ""
  }. ¿Es la misma persona?`;
  elAvisoDuplicado.dataset.contactoId = match.id;
}
elNombre.addEventListener("input", actualizarAvisoDuplicado);
elTelefono.addEventListener("input", actualizarAvisoDuplicado);

elBtnAbrirDuplicado.addEventListener("click", () => {
  const match = getContactosActuales().find((c) => c.id === elAvisoDuplicado.dataset.contactoId);
  if (match) mostrarForm(match);
});

// contacto == null: alta de un contacto nuevo. Con un contacto, lo
// precarga para editarlo (mismo formulario, en modo edición) — mismo
// patrón que crearPanelCatalogo (catalogos.js).
// estadoInicial: solo se usa con contacto == null (alta rápida desde el
// "+" de una columna del kanban) — precarga el estado con el que se creó
// el contacto en vez de forzar siempre "Nuevo".
// "Origen del lead" de un contacto que todavía no se guardó. El alta
// normal lo tiene fijo en el submit ("manual"), pero un contacto que sale
// de un mail de portal no es un alta manual — lo pone mostrarFormConLead,
// más abajo. Se limpia al abrir cualquier formulario para que el próximo
// "+ Nuevo contacto" no herede el origen del anterior.
let origenPrefill = null;

export function mostrarForm(contacto, estadoInicial) {
  formulario.reset();
  origenPrefill = null;
  mostrarTabDatos(); // no queda en la pestaña que tenía seleccionada el contacto anterior
  elNotaFijada.value = contacto ? contacto.nota_fijada || "" : "";
  elError.classList.add("oculto");
  elAvisoDuplicado.classList.add("oculto"); // se vuelve a evaluar recién cuando se tipea algo
  poblarSelectLotes();
  lotesInteresEnEdicion = contacto ? [...(contacto.lotes_interes || [])] : [];
  renderListaLotesInteres();
  renderLotesSugeridos();
  etiquetasEnEdicion = contacto ? [...(contacto.etiquetas || [])] : [];
  renderListaEtiquetas();
  elInputEtiqueta.value = "";
  renderActividades(contacto);
  elAgregarActividad.classList.toggle("oculto", !contacto);
  elActividadPrimeroGuardar.classList.toggle("oculto", !!contacto);

  if (contacto) {
    elIdEditando.value = contacto.id;
    elFormTitulo.textContent = contacto.nombre;
    elNombre.value = contacto.nombre;
    elTelefono.value = contacto.telefono || "";
    elEmail.value = contacto.email || "";
    elEstado.value = contacto.estado;
    elMotivoPerdido.value = contacto.motivo_perdido || "";
    elSeguimientoInput.value = contacto.proximo_seguimiento || "";
    elBtnBorrarContacto.classList.remove("oculto");
    elCrmFusionar.classList.remove("oculto");
  } else {
    elIdEditando.value = "";
    elFormTitulo.textContent = "Nuevo contacto";
    elEstado.value = estadoInicial || "nuevo";
    elMotivoPerdido.value = "";
    elSeguimientoInput.value = "";
    elBtnBorrarContacto.classList.add("oculto");
    elCrmFusionar.classList.add("oculto");
  }
  elCrmFusionarPanel.classList.add("oculto"); // por si había quedado abierto del contacto anterior
  // Solo se llega a un contacto ajeno pasando por "Todos" primero (en
  // "Mis contactos" la propia consulta ya lo excluye), así que el cache
  // de usuarios ya está poblado a esta altura — ver cambiarModoVista y
  // elBtnAbrir en crm.js.
  poblarSelectAsignado(contacto ? contacto.asignado_a : auth.currentUser?.uid);
  actualizarVisibilidadMotivoPerdido();
  actualizarBotonWhatsapp();

  elVistaKanban.classList.add("oculto");
  elVistaForm.classList.remove("oculto");
  // Recién acá el formulario (y el contenedor del mini-mapa) ya está
  // visible de verdad — Leaflet necesita el layout real para calcular
  // tamaño/tiles, no alcanza con togglear la clase antes.
  renderMiniMapa();
}

// Precarga el formulario con lo que la IA sacó de un mail de portal (ver
// js/ia-lead.js y functions/ia-lead.js). No guarda nada: deja todo listo
// para que el corredor lo revise y apriete Guardar como siempre.
//
// Vive acá y no en ia-lead.js porque los campos del formulario y
// lotesInteresEnEdicion son estado interno de este módulo — mismo criterio
// por el que mostrarForm también vive acá.
//
// Se llama a mostrarForm(null), no mostrarForm(lead): con un objeto,
// mostrarForm hace elIdEditando.value = contacto.id, y sin un id real de
// Firestore el guardado intentaría actualizar un documento inexistente en
// vez de crear uno.
export function mostrarFormConLead(lead) {
  mostrarForm(null);

  elNombre.value = lead.nombre || "";
  elTelefono.value = lead.telefono || "";
  elEmail.value = lead.email || "";

  // La consulta va a la nota fijada porque es lo único que se guarda
  // junto con el formulario: las actividades no sirven todavía
  // (elAgregarActividad está oculto hasta que el contacto exista).
  //
  // El lote de interés NO se adivina a partir de lead.propiedad: el mail
  // referencia el aviso del portal, no el lote de este sistema, y un
  // match por texto se equivoca en silencio. Queda escrito en la nota y
  // el corredor elige el lote con el selector que ya está en el form.
  elNotaFijada.value = [
    lead.propiedad ? `Consultó por: ${lead.propiedad}` : null,
    lead.consulta || null
  ]
    .filter(Boolean)
    .join("\n");

  origenPrefill = "email";
  elFormTitulo.textContent = "Nuevo contacto (desde un mail)";

  // Todo lo que cuelga del teléfono se evalúa al tipear, y acá el
  // teléfono lo puso el código, no una persona: sin esto, un lead que ya
  // está en el pipeline se guardaría duplicado sin que nadie se entere
  // (actualizarAvisoDuplicado) y el botón de WhatsApp quedaría apagado
  // con un número cargado (actualizarBotonWhatsapp — mostrarForm ya lo
  // llamó, pero antes de que este campo tuviera valor).
  elTelefono.dispatchEvent(new Event("input"));
}

formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elError.classList.add("oculto");
  const idEditando = elIdEditando.value;
  const estado = elEstado.value;
  // Mismo criterio que las etiquetas: el motivo tipeado pasa por el
  // catálogo, así "precio" no queda como un motivo aparte de "Precio" en
  // el resumen del Dashboard (ver motivosPerdidaFrecuentes).
  const motivoCanonico =
    estado === "perdido" ? await asegurarMotivo(elMotivoPerdido.value) : null;
  const datos = {
    nombre: elNombre.value.trim(),
    telefono: elTelefono.value.trim() || null,
    email: elEmail.value.trim() || null,
    estado,
    motivo_perdido: motivoCanonico,
    proximo_seguimiento: elSeguimientoInput.value || null,
    nota_fijada: elNotaFijada.value.trim() || null,
    lotes_interes: lotesInteresEnEdicion,
    etiquetas: etiquetasEnEdicion,
    fecha_actualizacion: new Date().toISOString()
  };
  // El <select> de reasignar solo existe con "ver_todos_los_contactos"
  // (o root) — sin el permiso, un contacto editado se queda con su dueño
  // actual tal cual, y uno nuevo queda asignado a quien lo está creando.
  if (puedeVerTodosLosContactos()) {
    datos.asignado_a = elSelectAsignado.value || auth.currentUser.uid;
  }

  elBtnGuardarContacto.disabled = true;
  try {
    if (idEditando) {
      const contactoPrevio = getContactosActuales().find((c) => c.id === idEditando);
      if (contactoPrevio) {
        const nuevasAutomaticas = actividadesAutomaticas(contactoPrevio, datos, auth.currentUser?.email);
        if (nuevasAutomaticas.length > 0) {
          datos.actividades = [...(contactoPrevio.actividades || []), ...nuevasAutomaticas];
        }
      }
      await updateDoc(doc(db, COLECCION_CONTACTOS, idEditando), datos);
      const reasignado = datos.asignado_a && contactoPrevio && datos.asignado_a !== contactoPrevio.asignado_a;
      registrarAuditoria({
        accion: "editar_contacto",
        objetoId: idEditando,
        objetoTitulo: datos.nombre,
        detalle: reasignado
          ? `Reasignado de ${textoAsignado(contactoPrevio)} a ${obtenerUsuariosPorUidCache()[datos.asignado_a] || datos.asignado_a}`
          : null
      });
    } else {
      // Primera entrada del timeline — mismo espíritu que el "NUEVO CONTACTO"
      // que Tokko deja como primer evento de la línea de tiempo del contacto.
      datos.actividades = [
        { tipo: "contacto_creado", texto: "Contacto creado", fecha: datos.fecha_actualizacion, autor_email: auth.currentUser?.email }
      ];
      if (!datos.asignado_a) datos.asignado_a = auth.currentUser.uid;
      datos.creado_por = auth.currentUser.uid;
      datos.fecha_creacion = datos.fecha_actualizacion;
      // "Origen del lead" (ver mismo criterio en crearContactoDesdeInteresado,
      // crm-datos.js) — "manual" es el alta desde "+ Nuevo contacto", sin
      // pasar por la ficha de ningún lote puntual. Un contacto que vino de
      // un mail de portal llega acá con origenPrefill ya puesto (ver
      // mostrarFormConLead).
      datos.origen = origenPrefill || "manual";
      const nuevoRef = await addDoc(collection(db, COLECCION_CONTACTOS), datos);
      registrarAuditoria({ accion: "crear_contacto", objetoId: nuevoRef.id, objetoTitulo: datos.nombre });
    }
    await cargarContactos();
    renderTodo();
    mostrarKanban();
  } catch (error) {
    elError.textContent =
      error.code === "permission-denied"
        ? "No tienes permiso para gestionar contactos."
        : "No se pudo guardar el contacto.";
    elError.classList.remove("oculto");
  } finally {
    elBtnGuardarContacto.disabled = false;
  }
});

elBtnBorrarContacto.addEventListener("click", async () => {
  const idEditando = elIdEditando.value;
  if (!idEditando) return;
  if (!window.confirm(`¿Borrar a "${elNombre.value}" del CRM? No se puede deshacer.`)) return;
  elBtnBorrarContacto.disabled = true;
  try {
    await deleteDoc(doc(db, COLECCION_CONTACTOS, idEditando));
    registrarAuditoria({ accion: "borrar_contacto", objetoId: idEditando, objetoTitulo: elNombre.value });
    await cargarContactos();
    renderTodo();
    mostrarKanban();
  } catch (error) {
    window.alert(
      error.code === "permission-denied" ? "No tienes permiso para borrar contactos." : "No se pudo borrar el contacto."
    );
  } finally {
    elBtnBorrarContacto.disabled = false;
  }
});

// "Fusionar con otro contacto" — cubre el hueco de deduplicación manual
// (hoy solo hay dedupe automático por teléfono EXACTO al crear desde
// "Agregar interesado" en la ficha; esto es para el resto de los casos:
// alguien cargado dos veces a mano, con el teléfono escrito distinto,
// etc.). El contacto que se está editando ("este") es el que queda; el
// elegido en el <select> se combina adentro y se borra — no al revés,
// para que sea obvio cuál sobrevive sin tener que leer dos veces.
elBtnFusionarContacto.addEventListener("click", () => {
  const idEditando = elIdEditando.value;
  if (!idEditando) return;
  const opciones = getContactosActuales()
    .filter((c) => c.id !== idEditando)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  if (opciones.length === 0) {
    window.alert("No hay otro contacto para fusionar acá.");
    return;
  }
  elCrmFusionarSelect.innerHTML = opciones.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join("");
  elCrmFusionarPanel.classList.remove("oculto");
});

elBtnFusionarCancelar.addEventListener("click", () => {
  elCrmFusionarPanel.classList.add("oculto");
});

elBtnFusionarConfirmar.addEventListener("click", async () => {
  const idEditando = elIdEditando.value;
  const idDuplicado = elCrmFusionarSelect.value;
  if (!idEditando || !idDuplicado) return;
  const actual = getContactosActuales().find((c) => c.id === idEditando);
  const duplicado = getContactosActuales().find((c) => c.id === idDuplicado);
  if (!actual || !duplicado) return;
  if (
    !window.confirm(
      `¿Fusionar "${duplicado.nombre}" dentro de "${actual.nombre}"? Se combina el interés y la actividad de los dos, y "${duplicado.nombre}" se borra. No se puede deshacer.`
    )
  )
    return;

  elBtnFusionarConfirmar.disabled = true;
  try {
    const lotesFusionados = [...(actual.lotes_interes || [])];
    (duplicado.lotes_interes || []).forEach((l) => {
      if (!lotesFusionados.some((existente) => existente.id === l.id)) lotesFusionados.push(l);
    });
    const etiquetasFusionadas = [...(actual.etiquetas || [])];
    (duplicado.etiquetas || []).forEach((e) => {
      if (!etiquetasFusionadas.some((existente) => existente.toLowerCase() === e.toLowerCase())) {
        etiquetasFusionadas.push(e);
      }
    });
    const ahora = new Date().toISOString();
    const actividadFusion = {
      tipo: "nota",
      texto: `Fusionado con "${duplicado.nombre}"${duplicado.telefono ? ` (tel. ${duplicado.telefono})` : ""}.`,
      fecha: ahora,
      autor_email: auth.currentUser?.email || null
    };
    const datos = {
      telefono: actual.telefono || duplicado.telefono || null,
      email: actual.email || duplicado.email || null,
      // La más próxima de las dos, no la del contacto que sobrevive porque
      // sí — un seguimiento ya agendado en el duplicado no debería
      // perderse solo por estar del lado que se borra.
      proximo_seguimiento:
        [actual.proximo_seguimiento, duplicado.proximo_seguimiento].filter(Boolean).sort()[0] || null,
      // Misma idea que teléfono/email: la del que sobrevive si tiene una
      // propia, si no la del que se borra — no se pierde el recordatorio
      // solo por estar del lado que se fusiona.
      nota_fijada: actual.nota_fijada || duplicado.nota_fijada || null,
      lotes_interes: lotesFusionados,
      etiquetas: etiquetasFusionadas,
      actividades: [...(actual.actividades || []), ...(duplicado.actividades || []), actividadFusion],
      fecha_creacion: [actual.fecha_creacion, duplicado.fecha_creacion].filter(Boolean).sort()[0] || actual.fecha_creacion,
      fecha_actualizacion: ahora
    };
    await updateDoc(doc(db, COLECCION_CONTACTOS, idEditando), datos);
    await deleteDoc(doc(db, COLECCION_CONTACTOS, idDuplicado));
    registrarAuditoria({
      accion: "editar_contacto",
      objetoId: idEditando,
      objetoTitulo: actual.nombre,
      detalle: `Fusionado con "${duplicado.nombre}"`
    });
    await cargarContactos();
    renderTodo();
    const fusionado = getContactosActuales().find((c) => c.id === idEditando);
    mostrarForm(fusionado || null);
  } catch (error) {
    window.alert(
      error.code === "permission-denied" ? "No tienes permiso para editar estos contactos." : "No se pudo fusionar."
    );
  } finally {
    elBtnFusionarConfirmar.disabled = false;
  }
});
