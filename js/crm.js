// ---------------------------------------------------------------------------
// CRM: contactos + pipeline visual (nuevo → contactado → visita → oferta →
// cerrado/perdido). Un contacto puede tener uno o más lotes de interés
// asociados (colección Firestore "contactos", ver firestore.rules).
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
// circular entre los dos módulos.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getContactosActuales, setContactosActuales, getLotesActuales } from "./estado.js";
import { centroideDePoligono } from "./geometria.js";
import { registrarAuditoria } from "./auditoria.js";

const COLECCION_CONTACTOS = "contactos";

let mapa, mostrarFicha, tituloLote;

// app.js llama esto una sola vez, antes de usar cualquier otra función de
// este módulo.
export function configurarCrm(deps) {
  ({ mapa, mostrarFicha, tituloLote } = deps);
}

const ETAPAS = [
  { clave: "nuevo", etiqueta: "Nuevo" },
  { clave: "contactado", etiqueta: "Contactado" },
  { clave: "visita", etiqueta: "Visita" },
  { clave: "oferta", etiqueta: "Oferta" },
  { clave: "cerrado", etiqueta: "Cerrado" },
  { clave: "perdido", etiqueta: "Perdido" }
];
const ETIQUETA_ETAPA = Object.fromEntries(ETAPAS.map((e) => [e.clave, e.etiqueta]));

// ---------------------------------------------------------------------------
// Alta automática desde "Agregar interesado" (ficha del lote). Fire-and-
// forget, mismo criterio que registrarVistaDeLote/registrarAuditoria: si
// falla acá (sin conexión, etc.) el interesado ya se guardó en el lote de
// todas formas — esto solo alimenta el pipeline central, no reemplaza a
// aquel guardado ni bloquea el flujo si algo sale mal.
//
// Si ya existe un contacto con el mismo teléfono, no se crea uno nuevo:
// se le suma este lote a "lotes de interés" (si todavía no lo tenía) —
// el mismo comprador preguntando por otro lote no debería aparecer
// duplicado en el pipeline. Sin teléfono no hay forma confiable de saber
// si es la misma persona, así que en ese caso siempre crea un contacto
// nuevo.
export async function crearContactoDesdeInteresado({ nombre, telefono, nota, feature }) {
  if (!auth.currentUser) return;
  try {
    const loteInteres = { id: feature.id, titulo: tituloLote(feature.properties) };

    if (telefono) {
      const coincidencias = await getDocs(
        query(collection(db, COLECCION_CONTACTOS), where("telefono", "==", telefono))
      );
      if (!coincidencias.empty) {
        const docExistente = coincidencias.docs[0];
        const datos = docExistente.data();
        const yaLoTiene = (datos.lotes_interes || []).some((l) => l.id === loteInteres.id);
        if (!yaLoTiene) {
          await updateDoc(doc(db, COLECCION_CONTACTOS, docExistente.id), {
            lotes_interes: [...(datos.lotes_interes || []), loteInteres],
            fecha_actualizacion: new Date().toISOString()
          });
        }
        return;
      }
    }

    await addDoc(collection(db, COLECCION_CONTACTOS), {
      nombre,
      telefono: telefono || null,
      email: null,
      nota: nota || null,
      estado: "nuevo",
      lotes_interes: [loteInteres],
      creado_por: auth.currentUser.uid,
      fecha_creacion: new Date().toISOString(),
      fecha_actualizacion: new Date().toISOString()
    });
  } catch {
    // Crear un contacto no depende del permiso "gestionar_contactos" (ver
    // firestore.rules) — si igual falla acá (sin conexión, la actualización
    // de un contacto ajeno sin ese permiso) no se avisa nada: el
    // interesado ya quedó guardado en el lote de todas formas.
  }
}

// ---------------------------------------------------------------------------
// Datos: cargar todos los contactos una vez al abrir el panel — el
// pipeline se pinta desde esta copia en memoria después (mismo criterio
// que lotesActuales con el mapa).
// ---------------------------------------------------------------------------

export async function cargarContactos() {
  try {
    const snapshot = await getDocs(collection(db, COLECCION_CONTACTOS));
    setContactosActuales(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch {
    setContactosActuales([]);
  }
}

// ---------------------------------------------------------------------------
// Panel: kanban (vista principal) + formulario de alta/edición (reemplaza
// al kanban, mismo patrón que catalogos.js/admin.js: la vista completa
// cambia, no un formulario que se abre encima).
// ---------------------------------------------------------------------------

const elPanel = document.getElementById("panel-crm");
const elBtnAbrir = document.getElementById("btn-abrir-crm");
const elVistaKanban = document.getElementById("crm-vista-kanban");
const elVistaForm = document.getElementById("crm-vista-form");
const elKanban = document.getElementById("crm-kanban");
const elVacio = document.getElementById("crm-vacio");
const elBtnAgregarContacto = document.getElementById("btn-agregar-contacto");
const elVolver = document.getElementById("crm-volver");
const elFormTitulo = document.getElementById("crm-form-titulo");
const formulario = document.getElementById("formulario-contacto");
const elIdEditando = document.getElementById("contacto-id-editando");
const elNombre = document.getElementById("contacto-nombre");
const elTelefono = document.getElementById("contacto-telefono");
const elEmail = document.getElementById("contacto-email");
const elEstado = document.getElementById("contacto-estado");
const elNota = document.getElementById("contacto-nota");
const elListaLotesInteres = document.getElementById("crm-lista-lotes-interes");
const elLotesInteresVacio = document.getElementById("crm-lotes-interes-vacio");
const elSelectLote = document.getElementById("crm-select-lote");
const elBtnAgregarLoteInteres = document.getElementById("btn-agregar-lote-interes");
const elBtnGuardarContacto = document.getElementById("contacto-guardar-btn");
const elBtnBorrarContacto = document.getElementById("btn-borrar-contacto");
const elError = document.getElementById("contacto-error");

// Lotes de interés del contacto que se está editando/creando en este
// momento — vive acá (no en Firestore) hasta que se guarda el formulario,
// mismo criterio que cualquier otro campo del form; evita un updateDoc
// por cada "+ Agregar"/"Quitar" mientras se completa el alta.
let lotesInteresEnEdicion = [];

function textoHaceDias(fechaIso) {
  if (!fechaIso) return "";
  const dias = Math.max(0, Math.floor((Date.now() - new Date(fechaIso).getTime()) / 86400000));
  if (dias === 0) return "Hoy";
  if (dias === 1) return "Hace 1 día";
  return `Hace ${dias} días`;
}

function textoLotesResumen(lotes) {
  if (!lotes.length) return "Sin lote de interés";
  if (lotes.length === 1) return lotes[0].titulo;
  return `${lotes[0].titulo} +${lotes.length - 1} más`;
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
  const estadoAnterior = contacto.estado;
  // Optimista: se pinta ya, sin esperar el updateDoc — con conexión rural
  // lenta, esperar a Firestore antes de mover la tarjeta se siente
  // trabado. Si falla, se revierte más abajo.
  contacto.estado = nuevoEstado;
  contacto.fecha_actualizacion = new Date().toISOString();
  renderKanban();
  try {
    await updateDoc(doc(db, COLECCION_CONTACTOS, contacto.id), {
      estado: nuevoEstado,
      fecha_actualizacion: contacto.fecha_actualizacion
    });
    registrarAuditoria({
      accion: "mover_contacto",
      objetoId: contacto.id,
      objetoTitulo: contacto.nombre,
      detalle: `${ETIQUETA_ETAPA[estadoAnterior]} → ${ETIQUETA_ETAPA[nuevoEstado]}`
    });
  } catch (error) {
    contacto.estado = estadoAnterior;
    renderKanban();
    window.alert(
      error.code === "permission-denied" ? "No tenés permiso para mover contactos." : "No se pudo mover el contacto."
    );
  }
}

function tarjetaContacto(contacto) {
  const tarjeta = document.createElement("div");
  tarjeta.className = "crm-tarjeta";
  tarjeta.dataset.testid = `crm-tarjeta-${contacto.id}`;

  const nombre = document.createElement("p");
  nombre.className = "crm-tarjeta-nombre";
  nombre.textContent = contacto.nombre;
  tarjeta.appendChild(nombre);

  const lotes = document.createElement("p");
  lotes.className = "crm-tarjeta-lotes";
  lotes.textContent = textoLotesResumen(contacto.lotes_interes || []);
  tarjeta.appendChild(lotes);

  const fecha = document.createElement("p");
  fecha.className = "crm-tarjeta-fecha";
  fecha.textContent = textoHaceDias(contacto.fecha_actualizacion || contacto.fecha_creacion);
  tarjeta.appendChild(fecha);

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

function renderKanban() {
  const contactos = getContactosActuales();
  elVacio.classList.toggle("oculto", contactos.length > 0);
  elKanban.innerHTML = "";
  ETAPAS.forEach(({ clave, etiqueta }) => {
    const deEstaEtapa = contactos.filter((c) => c.estado === clave);
    const columna = document.createElement("div");
    columna.className = "crm-columna";
    columna.dataset.testid = `crm-columna-${clave}`;

    const titulo = document.createElement("p");
    titulo.className = "crm-columna-titulo";
    titulo.innerHTML = `${etiqueta} <span class="crm-columna-contador">${deEstaEtapa.length}</span>`;
    columna.appendChild(titulo);

    deEstaEtapa.forEach((contacto) => columna.appendChild(tarjetaContacto(contacto)));
    elKanban.appendChild(columna);
  });
}

function mostrarKanban() {
  elVistaForm.classList.add("oculto");
  elVistaKanban.classList.remove("oculto");
}

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

elBtnAgregarLoteInteres.addEventListener("click", () => {
  const loteId = elSelectLote.value;
  if (!loteId || lotesInteresEnEdicion.some((l) => l.id === loteId)) return;
  const feature = getLotesActuales().find((f) => f.id === loteId);
  if (!feature) return;
  lotesInteresEnEdicion.push({ id: loteId, titulo: tituloLote(feature.properties) });
  renderListaLotesInteres();
});

// contacto == null: alta de un contacto nuevo. Con un contacto, lo
// precarga para editarlo (mismo formulario, en modo edición) — mismo
// patrón que crearPanelCatalogo (catalogos.js).
function mostrarForm(contacto) {
  formulario.reset();
  elError.classList.add("oculto");
  poblarSelectLotes();
  lotesInteresEnEdicion = contacto ? [...(contacto.lotes_interes || [])] : [];
  renderListaLotesInteres();

  if (contacto) {
    elIdEditando.value = contacto.id;
    elFormTitulo.textContent = contacto.nombre;
    elNombre.value = contacto.nombre;
    elTelefono.value = contacto.telefono || "";
    elEmail.value = contacto.email || "";
    elEstado.value = contacto.estado;
    elNota.value = contacto.nota || "";
    elBtnBorrarContacto.classList.remove("oculto");
  } else {
    elIdEditando.value = "";
    elFormTitulo.textContent = "Nuevo contacto";
    elEstado.value = "nuevo";
    elBtnBorrarContacto.classList.add("oculto");
  }

  elVistaKanban.classList.add("oculto");
  elVistaForm.classList.remove("oculto");
}

elBtnAgregarContacto.addEventListener("click", () => mostrarForm(null));
elVolver.addEventListener("click", mostrarKanban);

formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elError.classList.add("oculto");
  const idEditando = elIdEditando.value;
  const datos = {
    nombre: elNombre.value.trim(),
    telefono: elTelefono.value.trim() || null,
    email: elEmail.value.trim() || null,
    estado: elEstado.value,
    nota: elNota.value.trim() || null,
    lotes_interes: lotesInteresEnEdicion,
    fecha_actualizacion: new Date().toISOString()
  };
  elBtnGuardarContacto.disabled = true;
  try {
    if (idEditando) {
      await updateDoc(doc(db, COLECCION_CONTACTOS, idEditando), datos);
      registrarAuditoria({ accion: "editar_contacto", objetoId: idEditando, objetoTitulo: datos.nombre });
    } else {
      datos.creado_por = auth.currentUser.uid;
      datos.fecha_creacion = datos.fecha_actualizacion;
      const nuevoRef = await addDoc(collection(db, COLECCION_CONTACTOS), datos);
      registrarAuditoria({ accion: "crear_contacto", objetoId: nuevoRef.id, objetoTitulo: datos.nombre });
    }
    await cargarContactos();
    renderKanban();
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
    renderKanban();
    mostrarKanban();
  } catch (error) {
    window.alert(
      error.code === "permission-denied" ? "No tenés permiso para borrar contactos." : "No se pudo borrar el contacto."
    );
  } finally {
    elBtnBorrarContacto.disabled = false;
  }
});

elBtnAbrir.addEventListener("click", async () => {
  document.getElementById("vista-lista").classList.add("oculto"); // no superponer con "Ver como lista"
  document.getElementById("btn-ver-lista").classList.remove("activo");
  document.getElementById("panel-admin").classList.add("oculto"); // ni con "Seguridad"
  document.getElementById("panel-sectores").classList.add("oculto"); // ni con "Zonas"
  document.getElementById("panel-barrios").classList.add("oculto"); // ni con "Barrios"
  document.getElementById("panel-dashboard").classList.add("oculto"); // ni con "Dashboard"
  document.getElementById("ficha-lote").classList.add("oculto");
  mostrarKanban();
  elPanel.classList.remove("oculto");
  await cargarContactos();
  renderKanban();
});

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
