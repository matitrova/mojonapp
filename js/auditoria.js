// ---------------------------------------------------------------------------
// Auditoría: quién cargó/editó/borró un lote, quién reservó o quitó una
// reserva, y quién dio de alta/editó/borró una zona o un barrio. Colección
// Firestore "auditoria" — un evento nunca se EDITA, pero root sí puede
// BORRARLO desde acá mismo (para limpiar ruido, ej. datos de prueba del
// test suite/CI corriendo contra este mismo Firestore), ver firestore.rules.
//
// registrarAuditoria() la llaman, "fire and forget" (mismo criterio que
// registrarVistaDeLote en dashboard.js), cargar-lote.js, ficha.js,
// vista-lista.js, editor-forma.js y catalogos.js — si falla (sin conexión,
// reglas viejas, etc.) no bloquea la acción real, solo se pierde ese
// registro puntual.
//
// Importa el SDK de Firestore directo del mismo CDN que cargar-lote.js/
// ficha.js/mapa.js/admin.js — se cachea por URL, no duplica nada.
// El panel es visible solo para root (ver actualizarUIPorPermisos en
// app.js, con esRootActual() directo, no con un permiso de perfil) — acá
// no hay ningún chequeo extra de JS para eso, mismo criterio que el resto
// de los paneles de esta sección: la UI se esconde y firestore.rules hace
// cumplir el permiso real.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  limit,
  serverTimestamp,
  doc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const COLECCION_AUDITORIA = "auditoria";

// Techo duro de lo que trae el panel — de sobra para uso normal, evita
// traer miles de documentos si con los años se acumula mucho.
const MAX_EVENTOS = 300;

// accion: "crear_lote" | "editar_lote" | "borrar_lote" | "reservar_lote" |
// "quitar_reserva" | "vender_lote" | "crear_zona" | "editar_zona" |
// "borrar_zona" | "crear_barrio" | "editar_barrio" | "borrar_barrio".
// objetoId/objetoTitulo: id y nombre para mostrar de lo que se tocó — el
// id del lote/zona/barrio y su título/nombre. Nombres genéricos (no
// "lote_id") porque esta misma colección cubre lotes Y catálogos.
export function registrarAuditoria({ accion, objetoId = null, objetoTitulo = null, detalle = null }) {
  const usuario = auth.currentUser;
  if (!usuario) return; // no debería pasar (todo lo auditado requiere sesión), pero por las dudas
  addDoc(collection(db, COLECCION_AUDITORIA), {
    fecha: serverTimestamp(),
    usuario_uid: usuario.uid,
    usuario_email: usuario.email,
    accion,
    objeto_id: objetoId,
    objeto_titulo: objetoTitulo,
    detalle
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Panel "Auditoría": lista de solo lectura, sin alta/edición propia.
// ---------------------------------------------------------------------------

const ETIQUETA_ACCION = {
  crear_lote: "Cargó el lote",
  editar_lote: "Editó el lote",
  borrar_lote: "Borró el lote",
  reservar_lote: "Reservó el lote",
  quitar_reserva: "Quitó la reserva del lote",
  vender_lote: "Vendió el lote",
  crear_zona: "Creó la zona",
  editar_zona: "Editó la zona",
  borrar_zona: "Borró la zona",
  crear_barrio: "Creó el barrio",
  editar_barrio: "Editó el barrio",
  borrar_barrio: "Borró el barrio",
  // Contactos del CRM (crm.js) — usadas ahí desde antes de que existiera
  // este mapa; faltaban acá, así que el panel les mostraba la clave
  // cruda en vez de una etiqueta en español (encontrado de paso
  // armando "Fusionar contactos", no arreglado en el momento por
  // alcance — completado ahora).
  crear_contacto: "Creó el contacto",
  editar_contacto: "Editó el contacto",
  borrar_contacto: "Borró el contacto",
  mover_contacto: "Movió el contacto de etapa"
};

const elPanel = document.getElementById("panel-auditoria");
const elBtnAbrir = document.getElementById("btn-abrir-auditoria");
const elLista = document.getElementById("auditoria-lista");
const elVacio = document.getElementById("auditoria-vacio");
const elError = document.getElementById("auditoria-error");

function formatearFecha(timestamp) {
  if (!timestamp?.toDate) return "";
  return timestamp.toDate().toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function cargarAuditoria() {
  elError.classList.add("oculto");
  elVacio.classList.add("oculto");
  elLista.innerHTML = "";
  try {
    const snapshot = await getDocs(
      query(collection(db, COLECCION_AUDITORIA), orderBy("fecha", "desc"), limit(MAX_EVENTOS))
    );
    if (snapshot.empty) {
      elVacio.classList.remove("oculto");
      return;
    }
    snapshot.docs.forEach((d) => {
      const ev = d.data();
      const etiqueta = ETIQUETA_ACCION[ev.accion] || ev.accion;
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="auditoria-linea">
          <span class="auditoria-usuario"></span>
          <span class="auditoria-fecha"></span>
        </div>
        <div class="auditoria-accion"></div>
      `;
      li.querySelector(".auditoria-usuario").textContent = ev.usuario_email || "?";
      li.querySelector(".auditoria-fecha").textContent = formatearFecha(ev.fecha);
      li.querySelector(".auditoria-accion").textContent = ev.objeto_titulo ? `${etiqueta} "${ev.objeto_titulo}"` : etiqueta;
      if (ev.detalle) {
        const elDetalle = document.createElement("div");
        elDetalle.className = "auditoria-detalle";
        elDetalle.textContent = ev.detalle;
        li.appendChild(elDetalle);
      }

      // Un evento nunca se edita, pero root sí lo puede borrar acá — para
      // limpiar ruido (datos de prueba, corridas del test suite/CI) sin
      // depender de entrar a Firebase Console cada vez. Saca la fila del
      // DOM directo en vez de recargar todo el panel (más liviano, y no
      // hay que volver a pedirle a Firestore el resto de la lista).
      const botonBorrar = document.createElement("button");
      botonBorrar.type = "button";
      botonBorrar.className = "btn-link auditoria-borrar";
      botonBorrar.textContent = "Borrar";
      botonBorrar.addEventListener("click", async () => {
        if (!window.confirm("¿Borrar este evento de la auditoría? No se puede deshacer.")) return;
        botonBorrar.disabled = true;
        try {
          await deleteDoc(doc(db, COLECCION_AUDITORIA, d.id));
          li.remove();
          if (!elLista.children.length) elVacio.classList.remove("oculto");
        } catch (error) {
          window.alert(error.code === "permission-denied" ? "No tenés permiso para borrar eventos." : "No se pudo borrar el evento.");
          botonBorrar.disabled = false;
        }
      });
      li.appendChild(botonBorrar);

      elLista.appendChild(li);
    });
  } catch (error) {
    elError.textContent =
      error.code === "permission-denied" ? "No tenés permiso para ver la auditoría." : "No se pudo cargar la auditoría.";
    elError.classList.remove("oculto");
  }
}

elBtnAbrir.addEventListener("click", async () => {
  document.getElementById("vista-lista").classList.add("oculto"); // no superponer con "Ver como lista"
  document.getElementById("btn-ver-lista").classList.remove("activo");
  document.getElementById("panel-admin").classList.add("oculto");
  document.getElementById("panel-sectores").classList.add("oculto");
  document.getElementById("panel-barrios").classList.add("oculto");
  document.getElementById("panel-dashboard").classList.add("oculto");
  elPanel.classList.remove("oculto");
  await cargarAuditoria();
});

document.getElementById("cerrar-panel-auditoria").addEventListener("click", () => {
  elPanel.classList.add("oculto");
});
