// ---------------------------------------------------------------------------
// Pantalla de Tareas: leer, crear, completar y borrar.
//
// Las REGLAS (qué está vencido, cómo se ordena, cómo se resume por
// responsable) viven en js/tareas.js, sin Firestore ni DOM. Acá está solo
// el cableado: traer de Firestore, dibujar y guardar.
//
// Los textos de esta pantalla están en español neutro ("tienes", no
// "tenés") por decisión del usuario del 2026-09-18. El resto de la app
// todavía usa voseo: se pasa junto con el rediseño, no a mitad de camino,
// para no romper los tests que verifican textos visibles sin poder
// correrlos.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  TIPOS_DE_TAREA,
  ICONO_TIPO,
  ETIQUETA_TIPO,
  clasificarPorVencimiento,
  resumenPorResponsable,
  textoDeVencimiento,
  validarTarea,
  diaComoTexto
} from "./tareas.js";
import { getContactosActuales } from "./estado.js";
import { cargarContactos, obtenerUsuariosPorUid, obtenerUsuariosPorUidCache } from "./crm-datos.js";
import { registrarAuditoria } from "./auditoria.js";
import { tienePermiso } from "./permisos.js";

const COLECCION = "tareas";

const elPanel = document.getElementById("panel-tareas");
const elGrupos = document.getElementById("tareas-grupos");
const elVacio = document.getElementById("tareas-vacio");
const elError = document.getElementById("tareas-error");
const elResumen = document.getElementById("tareas-resumen");
const elBtnMias = document.getElementById("btn-tareas-mias");
const elBtnTodas = document.getElementById("btn-tareas-todas");
const elBtnNueva = document.getElementById("btn-nueva-tarea");
const elForm = document.getElementById("tarea-form");
const elTitulo = document.getElementById("tarea-titulo");
const elTipo = document.getElementById("tarea-tipo");
const elVence = document.getElementById("tarea-vence");
const elContacto = document.getElementById("tarea-contacto");
const elResponsable = document.getElementById("tarea-responsable");
const elFormError = document.getElementById("tarea-error");
const elCancelar = document.getElementById("tarea-cancelar");

let tareas = [];
let verSoloMias = true;
let editando = null;

function mostrarError(mensaje) {
  elError.textContent = mensaje;
  elError.classList.toggle("oculto", !mensaje);
}

async function cargarTareas() {
  try {
    const snapshot = await getDocs(collection(db, COLECCION));
    tareas = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    mostrarError("");
  } catch (error) {
    // Con la colección recién creada, lo más probable es que falten las
    // reglas: se dice eso y no un "error" genérico, porque es
    // exactamente lo que ya pasó dos veces en este proyecto.
    mostrarError(
      error.code === "permission-denied"
        ? "No se pueden leer las tareas: faltan las reglas de seguridad de la colección “tareas” en Firebase."
        : "No se pudieron cargar las tareas."
    );
    tareas = [];
  }
}

function tareasVisibles() {
  if (!verSoloMias) return tareas;
  const uid = auth.currentUser?.uid;
  return tareas.filter((t) => t.asignado_a === uid);
}

function filaDeTarea(tarea) {
  const fila = document.createElement("li");
  fila.className = "tarea-fila";
  fila.dataset.testid = `tarea-${tarea.id}`;
  if (tarea.hecha) fila.classList.add("tarea-hecha");

  const tilde = document.createElement("input");
  tilde.type = "checkbox";
  tilde.className = "tarea-tilde";
  tilde.checked = !!tarea.hecha;
  tilde.dataset.testid = `tarea-completar-${tarea.id}`;
  tilde.setAttribute("aria-label", tarea.hecha ? "Marcar como pendiente" : "Marcar como hecha");
  tilde.addEventListener("change", () => completarTarea(tarea, tilde.checked));
  fila.appendChild(tilde);

  const cuerpo = document.createElement("div");
  cuerpo.className = "tarea-cuerpo";

  const titulo = document.createElement("p");
  titulo.className = "tarea-titulo";
  // textContent y no innerHTML: el título lo escribe una persona.
  titulo.textContent = `${ICONO_TIPO[tarea.tipo] || "📌"} ${tarea.titulo}`;
  cuerpo.appendChild(titulo);

  const meta = document.createElement("p");
  meta.className = "tarea-meta";
  const partes = [textoDeVencimiento(tarea)];
  if (tarea.contacto_nombre) partes.push(tarea.contacto_nombre);
  const usuarios = obtenerUsuariosPorUidCache();
  const responsable = tarea.asignado_a
    ? tarea.asignado_a === auth.currentUser?.uid
      ? "Tú"
      : usuarios[tarea.asignado_a] || tarea.asignado_email || "Otro corredor"
    : "Sin asignar";
  partes.push(responsable);
  meta.textContent = partes.join(" · ");
  cuerpo.appendChild(meta);

  fila.appendChild(cuerpo);

  const borrar = document.createElement("button");
  borrar.type = "button";
  borrar.className = "tarea-borrar";
  borrar.textContent = "Borrar";
  borrar.dataset.testid = `tarea-borrar-${tarea.id}`;
  borrar.addEventListener("click", () => borrarTarea(tarea));
  fila.appendChild(borrar);

  return fila;
}

const TITULOS_DE_GRUPO = {
  vencidas: "Vencidas",
  hoy: "Para hoy",
  proximas: "Más adelante",
  hechas: "Hechas"
};

function render() {
  const visibles = tareasVisibles();
  const grupos = clasificarPorVencimiento(visibles);

  elGrupos.innerHTML = "";
  let hayAlguna = false;
  for (const clave of ["vencidas", "hoy", "proximas", "hechas"]) {
    const delGrupo = grupos[clave];
    if (delGrupo.length === 0) continue;
    hayAlguna = true;

    const seccion = document.createElement("section");
    seccion.className = `tareas-grupo tareas-grupo-${clave}`;
    seccion.dataset.testid = `tareas-grupo-${clave}`;

    const titulo = document.createElement("h3");
    titulo.textContent = `${TITULOS_DE_GRUPO[clave]} (${delGrupo.length})`;
    seccion.appendChild(titulo);

    const lista = document.createElement("ul");
    lista.className = "tareas-lista";
    for (const tarea of delGrupo) lista.appendChild(filaDeTarea(tarea));
    seccion.appendChild(lista);

    elGrupos.appendChild(seccion);
  }
  elVacio.classList.toggle("oculto", hayAlguna);

  // El resumen por corredor solo tiene sentido mirando a todo el equipo.
  elResumen.classList.toggle("oculto", verSoloMias);
  if (!verSoloMias) renderResumen();
}

function renderResumen() {
  const usuarios = obtenerUsuariosPorUidCache();
  elResumen.innerHTML = "";
  for (const fila of resumenPorResponsable(tareas)) {
    const tarjeta = document.createElement("div");
    tarjeta.className = "tareas-resumen-fila";
    tarjeta.dataset.testid = `tareas-resumen-${fila.uid}`;

    const quien = document.createElement("strong");
    quien.textContent =
      fila.uid === "__sin_asignar__" ? "Sin asignar" : usuarios[fila.uid] || fila.email || fila.uid;
    tarjeta.appendChild(quien);

    const numeros = document.createElement("span");
    numeros.className = "tareas-resumen-numeros";
    numeros.textContent = `${fila.vencidas} vencidas · ${fila.hoy} para hoy · ${fila.proximas} más adelante`;
    tarjeta.appendChild(numeros);

    elResumen.appendChild(tarjeta);
  }
}

async function completarTarea(tarea, hecha) {
  const antes = tarea.hecha;
  tarea.hecha = hecha;
  tarea.fecha_hecha = hecha ? new Date().toISOString() : null;
  render();
  try {
    await updateDoc(doc(db, COLECCION, tarea.id), {
      hecha,
      fecha_hecha: tarea.fecha_hecha,
      // Quién la completó, que no siempre es el responsable: en una
      // inmobiliaria chica atiende el que está.
      completada_por: hecha ? auth.currentUser?.email ?? null : null
    });
    registrarAuditoria({
      accion: hecha ? "completar_tarea" : "reabrir_tarea",
      objetoId: tarea.id,
      objetoTitulo: tarea.titulo
    });
  } catch (error) {
    tarea.hecha = antes;
    render();
    mostrarError("No se pudo guardar el cambio de la tarea.");
  }
}

async function borrarTarea(tarea) {
  if (!window.confirm(`¿Borrar la tarea "${tarea.titulo}"?`)) return;
  try {
    await deleteDoc(doc(db, COLECCION, tarea.id));
    tareas = tareas.filter((t) => t.id !== tarea.id);
    registrarAuditoria({ accion: "borrar_tarea", objetoId: tarea.id, objetoTitulo: tarea.titulo });
    render();
  } catch (error) {
    mostrarError("No se pudo borrar la tarea.");
  }
}

function poblarFormulario() {
  elTipo.innerHTML = TIPOS_DE_TAREA.map(
    (t) => `<option value="${t.clave}">${t.icono} ${t.etiqueta}</option>`
  ).join("");

  const contactos = [...getContactosActuales()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  elContacto.innerHTML =
    '<option value="">Sin contacto</option>' +
    contactos.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join("");

  const usuarios = obtenerUsuariosPorUidCache();
  const uidPropio = auth.currentUser?.uid;
  const opciones = Object.entries(usuarios).map(
    ([uid, email]) => `<option value="${uid}">${uid === uidPropio ? "Tú" : email}</option>`
  );
  elResponsable.innerHTML =
    (opciones.length ? opciones.join("") : `<option value="${uidPropio || ""}">Tú</option>`) +
    '<option value="">Sin asignar</option>';
  if (uidPropio) elResponsable.value = uidPropio;
}

function abrirFormulario(tarea = null) {
  editando = tarea;
  poblarFormulario();
  elTitulo.value = tarea?.titulo || "";
  elTipo.value = tarea?.tipo || "llamar";
  elVence.value = tarea?.vence || diaComoTexto();
  elContacto.value = tarea?.contacto_id || "";
  if (tarea?.asignado_a !== undefined) elResponsable.value = tarea.asignado_a || "";
  elFormError.classList.add("oculto");
  elForm.classList.remove("oculto");
  elTitulo.focus();
}

elBtnNueva.addEventListener("click", () => abrirFormulario());
elCancelar.addEventListener("click", () => elForm.classList.add("oculto"));

elBtnMias.addEventListener("click", () => {
  verSoloMias = true;
  elBtnMias.classList.add("activo");
  elBtnTodas.classList.remove("activo");
  render();
});
elBtnTodas.addEventListener("click", () => {
  verSoloMias = false;
  elBtnTodas.classList.add("activo");
  elBtnMias.classList.remove("activo");
  render();
});

elForm.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const datos = {
    titulo: elTitulo.value.trim(),
    tipo: elTipo.value,
    vence: elVence.value || null,
    contacto_id: elContacto.value || null,
    contacto_nombre: elContacto.value
      ? elContacto.options[elContacto.selectedIndex].textContent
      : null,
    asignado_a: elResponsable.value || null,
    asignado_email: elResponsable.value ? obtenerUsuariosPorUidCache()[elResponsable.value] || null : null
  };

  const errores = validarTarea(datos);
  if (errores.length > 0) {
    elFormError.textContent = errores.join(" ");
    elFormError.classList.remove("oculto");
    return;
  }

  try {
    if (editando) {
      await updateDoc(doc(db, COLECCION, editando.id), datos);
      Object.assign(editando, datos);
      registrarAuditoria({ accion: "editar_tarea", objetoId: editando.id, objetoTitulo: datos.titulo });
    } else {
      const completos = {
        ...datos,
        hecha: false,
        fecha_hecha: null,
        creado_por: auth.currentUser?.uid ?? null,
        fecha_creacion: new Date().toISOString()
      };
      const ref = await addDoc(collection(db, COLECCION), completos);
      tareas.push({ id: ref.id, ...completos });
      registrarAuditoria({ accion: "crear_tarea", objetoId: ref.id, objetoTitulo: datos.titulo });
    }
    elForm.classList.add("oculto");
    editando = null;
    render();
  } catch (error) {
    elFormError.textContent =
      error.code === "permission-denied"
        ? "No se pudo guardar: faltan las reglas de seguridad de la colección “tareas” en Firebase."
        : "No se pudo guardar la tarea.";
    elFormError.classList.remove("oculto");
  }
});

/**
 * Se llama al abrir la sección (ver js/router.js). Trae lo que haga
 * falta: las tareas siempre, y los contactos y usuarios solo si todavía
 * no están en memoria — mismo criterio perezoso que usa el Dashboard con
 * los contactos.
 */
export async function abrirPanelTareas() {
  if (!tienePermiso("gestionar_contactos")) return;
  elPanel.classList.remove("oculto");
  await Promise.all([
    cargarTareas(),
    getContactosActuales().length === 0 ? cargarContactos() : Promise.resolve(),
    obtenerUsuariosPorUid()
  ]);
  render();
}

document.getElementById("btn-abrir-tareas").addEventListener("click", abrirPanelTareas);
