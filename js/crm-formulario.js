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
import { ETIQUETA_ACTIVIDAD, linkWhatsapp, lotesSugeridos } from "./crm-metricas.js";
import {
  COLECCION_CONTACTOS,
  cargarContactos,
  puedeVerTodosLosContactos,
  obtenerUsuariosPorUidCache,
  textoAsignado
} from "./crm-datos.js";

let renderTodo, mostrarKanban, irALoteDesdeCrm, tituloLote;
export function configurarFormulario(deps) {
  ({ renderTodo, mostrarKanban, irALoteDesdeCrm, tituloLote } = deps);
}

const elVistaKanban = document.getElementById("crm-vista-kanban");
const elVistaForm = document.getElementById("crm-vista-form");
const formulario = document.getElementById("formulario-contacto");
const elFormTitulo = document.getElementById("crm-form-titulo");
const elIdEditando = document.getElementById("contacto-id-editando");
const elNombre = document.getElementById("contacto-nombre");
const elTelefono = document.getElementById("contacto-telefono");
const elWhatsapp = document.getElementById("contacto-whatsapp");
const elAvisoDuplicado = document.getElementById("crm-aviso-duplicado");
const elAvisoDuplicadoTexto = document.getElementById("crm-aviso-duplicado-texto");
const elBtnAbrirDuplicado = document.getElementById("btn-abrir-duplicado");
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
    botonTitulo.addEventListener("click", () => irALoteDesdeCrm(lote.id));
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
    const titulo = document.createElement("span");
    titulo.className = "crm-chip-titulo";
    titulo.textContent = tituloLote(feature.properties);
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

function agregarEtiquetaDesdeInput() {
  const valor = elInputEtiqueta.value.trim();
  if (!valor) return;
  // Comparación sin mayúsculas/minúsculas para no juntar "Urgente" y
  // "urgente" como dos etiquetas distintas — se guarda tal cual se
  // escribió la primera vez.
  const yaExiste = etiquetasEnEdicion.some((e) => e.toLowerCase() === valor.toLowerCase());
  if (!yaExiste) {
    etiquetasEnEdicion.push(valor);
    renderListaEtiquetas();
  }
  elInputEtiqueta.value = "";
  elInputEtiqueta.focus();
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
    li.className = "crm-actividad";

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
      error.code === "permission-denied" ? "No tenés permiso para agregar actividad." : "No se pudo guardar la actividad."
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
}
elTelefono.addEventListener("input", actualizarBotonWhatsapp);

function actualizarVisibilidadMotivoPerdido() {
  elCampoMotivoPerdido.classList.toggle("oculto", elEstado.value !== "perdido");
}
elEstado.addEventListener("change", actualizarVisibilidadMotivoPerdido);

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
export function mostrarForm(contacto, estadoInicial) {
  formulario.reset();
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
}

formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elError.classList.add("oculto");
  const idEditando = elIdEditando.value;
  const estado = elEstado.value;
  const datos = {
    nombre: elNombre.value.trim(),
    telefono: elTelefono.value.trim() || null,
    email: elEmail.value.trim() || null,
    estado,
    motivo_perdido: estado === "perdido" ? elMotivoPerdido.value.trim() || null : null,
    proximo_seguimiento: elSeguimientoInput.value || null,
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
      datos.actividades = [];
      if (!datos.asignado_a) datos.asignado_a = auth.currentUser.uid;
      datos.creado_por = auth.currentUser.uid;
      datos.fecha_creacion = datos.fecha_actualizacion;
      const nuevoRef = await addDoc(collection(db, COLECCION_CONTACTOS), datos);
      registrarAuditoria({ accion: "crear_contacto", objetoId: nuevoRef.id, objetoTitulo: datos.nombre });
    }
    await cargarContactos();
    renderTodo();
    mostrarKanban();
  } catch (error) {
    elError.textContent =
      error.code === "permission-denied"
        ? "No tenés permiso para gestionar contactos."
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
      error.code === "permission-denied" ? "No tenés permiso para borrar contactos." : "No se pudo borrar el contacto."
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
      error.code === "permission-denied" ? "No tenés permiso para editar estos contactos." : "No se pudo fusionar."
    );
  } finally {
    elBtnFusionarConfirmar.disabled = false;
  }
});
