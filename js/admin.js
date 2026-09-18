// ---------------------------------------------------------------------------
// Sección "Seguridad" (root / permiso administrar_usuarios): altas y
// ediciones de corredores, y perfiles de seguridad. Usuarios y Perfiles
// son pestañas separadas, y dentro de cada una "Agregar"/"Editar"
// reemplaza la grilla por su propia vista (no un formulario que se abre
// encima) — con varios usuarios cargados, todo apilado en una sola
// pantalla se pierde de vista rápido. Acá solo se decide qué mostrar —
// el permiso real lo hacen cumplir las reglas de Firestore
// (firestore.rules repite esta misma lógica del lado del servidor).
//
// Módulo autocontenido: nada más en la app llama a nada de acá (solo
// sus propios botones lo disparan), así que no exporta nada — a
// diferencia de dashboard.js/vista-lista.js/etc. no hace falta ningún
// configurarX() ni import de vuelta desde app.js.
// ---------------------------------------------------------------------------

import { db, auth, firebaseConfig } from "./firebase-config.js";
import {
  collection,
  getDocs,
  addDoc,
  setDoc,
  doc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  initializeApp,
  deleteApp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  signOut,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  getAuth
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

// Agrupados en secciones para el formulario de perfil (checkbox
// "maestro" por sección, ver más abajo) — el resto del código que solo
// necesita la lista plana (guardar, leer, resumen en la tabla) usa
// PERMISOS_INFO, derivada de acá.
const PERMISOS_SECCIONES = [
  {
    id: "lotes",
    nombre: "Lotes",
    permisos: [
      { clave: "cargar_lote", etiqueta: "Cargar lotes" },
      { clave: "ver_todos_los_lotes", etiqueta: "Ver todos los lotes" },
      { clave: "editar_lote_propio", etiqueta: "Editar lotes propios" },
      { clave: "editar_lote_ajeno", etiqueta: "Editar lotes ajenos" },
      { clave: "borrar_lote_propio", etiqueta: "Borrar lotes propios" },
      { clave: "borrar_lote_ajeno", etiqueta: "Borrar lotes ajenos" }
    ]
  },
  {
    id: "administracion",
    nombre: "Administración",
    permisos: [
      { clave: "administrar_sectores", etiqueta: "Administrar zonas/barrios" },
      { clave: "administrar_usuarios", etiqueta: "Administrar usuarios" }
    ]
  },
  {
    id: "crm",
    nombre: "CRM",
    permisos: [
      // Crear un contacto (ej. "Agregar interesado" en la ficha de un
      // lote) NO depende de este permiso — cualquier corredor logueado
      // puede seguir haciendo eso, ver firestore.rules. Este permiso es
      // para GESTIONAR el pipeline entero (verlo armado en el panel CRM,
      // mover contactos de estado, editarlos o borrarlos).
      { clave: "gestionar_contactos", etiqueta: "Gestionar contactos (CRM)" },
      // Sin este permiso, un corredor con "gestionar_contactos" ve y
      // gestiona sus PROPIOS contactos nomás (asignado_a) — pensado para
      // que varios corredores usando el mismo MojonApp no se pisen la
      // cartera de leads entre sí a medida que crece el equipo. Con este
      // permiso (pensado para dueños/gerentes) se ve la cartera completa.
      { clave: "ver_todos_los_contactos", etiqueta: "Ver contactos de todos los corredores" },
      // Administrar los catálogos del CRM (motivos de pérdida y etiquetas,
      // ver js/catalogos.js). Permiso propio y no `administrar_sectores`
      // porque eso es de lotes: acá se decide el vocabulario del pipeline,
      // que es otra responsabilidad. Sin este permiso un corredor sigue
      // pudiendo ELEGIR de la lista y escribir un valor nuevo al vuelo —
      // solo que ese valor no queda guardado en el catálogo.
      { clave: "administrar_catalogos_crm", etiqueta: "Administrar catálogos del CRM" }
    ]
  }
];

const PERMISOS_INFO = PERMISOS_SECCIONES.flatMap((s) => s.permisos);

const elPanelAdmin = document.getElementById("panel-admin");
const elMenuSeguridadUsuarios = document.getElementById("menu-seguridad-usuarios");
const elMenuSeguridadPerfiles = document.getElementById("menu-seguridad-perfiles");

const elTabUsuarios = document.getElementById("tab-usuarios");
const elTabPerfiles = document.getElementById("tab-perfiles");
const elSeccionUsuarios = document.getElementById("seccion-usuarios");
const elSeccionPerfiles = document.getElementById("seccion-perfiles");

const elUsuariosVistaLista = document.getElementById("usuarios-vista-lista");
const elUsuariosVistaForm = document.getElementById("usuarios-vista-form");
const elTablaUsuariosCuerpo = document.getElementById("tabla-usuarios-cuerpo");
const elBtnAgregarUsuario = document.getElementById("btn-agregar-usuario");
const elUsuarioVolver = document.getElementById("usuario-volver");
const elUsuarioFormTitulo = document.getElementById("usuario-form-titulo");
const formularioUsuario = document.getElementById("formulario-usuario");
const elUsuarioUidEditando = document.getElementById("usuario-uid-editando");
const elUsuarioEmail = document.getElementById("usuario-email");
const elUsuarioPasswordLabel = document.getElementById("usuario-password-label");
const elUsuarioPassword = document.getElementById("usuario-password");
const elUsuarioPerfil = document.getElementById("usuario-perfil");
const elUsuarioGuardar = document.getElementById("usuario-guardar");
const elUsuarioError = document.getElementById("usuario-error");

const elPerfilesVistaLista = document.getElementById("perfiles-vista-lista");
const elPerfilesVistaForm = document.getElementById("perfiles-vista-form");
const elTablaPerfilesCuerpo = document.getElementById("tabla-perfiles-cuerpo");
const elBtnAgregarPerfil = document.getElementById("btn-agregar-perfil");
const elPerfilVolver = document.getElementById("perfil-volver");
const elPerfilFormTitulo = document.getElementById("perfil-form-titulo");
const formularioPerfil = document.getElementById("formulario-perfil");
const elPerfilIdEditando = document.getElementById("perfil-id-editando");
const elPerfilNombre = document.getElementById("perfil-nombre");
const elPerfilError = document.getElementById("perfil-error");

let perfilesActuales = []; // último resultado de cargarPerfiles(), lo reusa el <select> de usuarios

function elCheckboxPermiso(clave) {
  return document.getElementById(`perfil-permiso-${clave}`);
}

function elCheckboxSeccion(id) {
  return document.getElementById(`perfil-seccion-${id}`);
}

// El checkbox "maestro" de una sección (Lotes, Administración...)
// refleja el estado de sus permisos hijos: tildado si están todos,
// "indeterminate" (el guioncito de Firefox/Chrome) si hay una mezcla,
// destildado si no hay ninguno. Se llama cada vez que cambia un
// permiso individual, y al precargar un perfil para editarlo.
function actualizarCheckboxSeccion(seccion) {
  const casillas = seccion.permisos.map(({ clave }) => elCheckboxPermiso(clave));
  const marcadas = casillas.filter((c) => c.checked).length;
  const master = elCheckboxSeccion(seccion.id);
  master.checked = marcadas === casillas.length;
  master.indeterminate = marcadas > 0 && marcadas < casillas.length;
}

function actualizarTodosLosCheckboxSeccion() {
  PERMISOS_SECCIONES.forEach(actualizarCheckboxSeccion);
}

// Tocar el checkbox de una sección tilda/destilda de una todos sus
// permisos — no hace falta ir uno por uno para dar (o sacar) un bloque
// entero de acceso, como "todo Administración".
PERMISOS_SECCIONES.forEach((seccion) => {
  elCheckboxSeccion(seccion.id).addEventListener("change", (evento) => {
    seccion.permisos.forEach(({ clave }) => {
      elCheckboxPermiso(clave).checked = evento.target.checked;
    });
    evento.target.indeterminate = false;
  });
  seccion.permisos.forEach(({ clave }) => {
    elCheckboxPermiso(clave).addEventListener("change", () => actualizarCheckboxSeccion(seccion));
  });
});

function resumenPermisos(permisos) {
  const activos = PERMISOS_INFO.filter(({ clave }) => permisos?.[clave]).map(({ etiqueta }) => etiqueta);
  return activos.length > 0 ? activos.join(", ") : "Sin permisos";
}

function mostrarTabUsuarios() {
  elTabUsuarios.classList.add("activo");
  elTabPerfiles.classList.remove("activo");
  elSeccionUsuarios.classList.remove("oculto");
  elSeccionPerfiles.classList.add("oculto");
}

function mostrarTabPerfiles() {
  elTabPerfiles.classList.add("activo");
  elTabUsuarios.classList.remove("activo");
  elSeccionPerfiles.classList.remove("oculto");
  elSeccionUsuarios.classList.add("oculto");
}

elTabUsuarios.addEventListener("click", mostrarTabUsuarios);
elTabPerfiles.addEventListener("click", mostrarTabPerfiles);

// --- Perfiles ---------------------------------------------------------

async function cargarPerfiles() {
  const snapshot = await getDocs(collection(db, "perfiles"));
  perfilesActuales = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

  elTablaPerfilesCuerpo.innerHTML = "";
  perfilesActuales.forEach((perfil) => {
    const fila = document.createElement("tr");
    fila.innerHTML = `
      <td>${perfil.nombre}${perfil.es_root ? " (root)" : ""}</td>
      <td>${perfil.es_root ? "Todos" : resumenPermisos(perfil.permisos)}</td>
      <td></td>
    `;
    // El perfil root no se edita desde acá: siempre tiene todos los
    // permisos, por definición (ver esRoot() en firestore.rules).
    if (!perfil.es_root) {
      const botonEditar = document.createElement("button");
      botonEditar.type = "button";
      botonEditar.className = "btn-editar-fila";
      botonEditar.textContent = "Editar";
      botonEditar.addEventListener("click", () => mostrarFormPerfil(perfil));
      fila.querySelector("td:last-child").appendChild(botonEditar);
    }
    elTablaPerfilesCuerpo.appendChild(fila);
  });

  actualizarSelectPerfiles();
}

function actualizarSelectPerfiles() {
  const seleccionPrevia = elUsuarioPerfil.value;
  elUsuarioPerfil.innerHTML = perfilesActuales
    .filter((p) => !p.es_root)
    .map((p) => `<option value="${p.id}">${p.nombre}</option>`)
    .join("");
  if (seleccionPrevia) elUsuarioPerfil.value = seleccionPrevia;
}

function mostrarListaPerfiles() {
  elPerfilesVistaForm.classList.add("oculto");
  elPerfilesVistaLista.classList.remove("oculto");
}

// perfil == null: alta de un perfil nuevo. Con un perfil, lo precarga
// para editarlo (mismo formulario, en modo edición).
function mostrarFormPerfil(perfil) {
  formularioPerfil.reset();
  elPerfilError.classList.add("oculto");
  if (perfil) {
    elPerfilIdEditando.value = perfil.id;
    elPerfilFormTitulo.textContent = `Editar "${perfil.nombre}"`;
    elPerfilNombre.value = perfil.nombre;
    PERMISOS_INFO.forEach(({ clave }) => {
      elCheckboxPermiso(clave).checked = !!perfil.permisos?.[clave];
    });
  } else {
    elPerfilIdEditando.value = "";
    elPerfilFormTitulo.textContent = "Nuevo perfil";
  }
  // formularioPerfil.reset() no dispara "change" en los checkboxes, así
  // que los maestros de sección quedan desincronizados si no se los
  // recalcula acá a mano (tanto al editar como al abrir en blanco).
  actualizarTodosLosCheckboxSeccion();
  elPerfilesVistaLista.classList.add("oculto");
  elPerfilesVistaForm.classList.remove("oculto");
}

elBtnAgregarPerfil.addEventListener("click", () => mostrarFormPerfil(null));
elPerfilVolver.addEventListener("click", mostrarListaPerfiles);

formularioPerfil.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elPerfilError.classList.add("oculto");
  try {
    const permisos = {};
    PERMISOS_INFO.forEach(({ clave }) => {
      permisos[clave] = elCheckboxPermiso(clave).checked;
    });
    const datos = { nombre: elPerfilNombre.value.trim(), es_root: false, permisos };
    const idEditando = elPerfilIdEditando.value;
    if (idEditando) {
      await setDoc(doc(db, "perfiles", idEditando), datos);
    } else {
      await addDoc(collection(db, "perfiles"), datos);
    }
    await cargarPerfiles();
    mostrarListaPerfiles();
  } catch (error) {
    elPerfilError.textContent =
      error.code === "permission-denied"
        ? "No tienes permiso para administrar perfiles."
        : "No se pudo guardar el perfil.";
    elPerfilError.classList.remove("oculto");
  }
});

// --- Usuarios -----------------------------------------------------------

async function cargarUsuarios() {
  const snapshot = await getDocs(collection(db, "usuarios"));
  const usuarios = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

  elTablaUsuariosCuerpo.innerHTML = "";
  usuarios.forEach((usuario) => {
    const fila = document.createElement("tr");
    const perfilDelUsuario = perfilesActuales.find((p) => p.id === usuario.perfil_id);

    const celdaEmail = document.createElement("td");
    celdaEmail.textContent = usuario.email;

    const celdaPerfil = document.createElement("td");
    celdaPerfil.textContent = perfilDelUsuario ? (perfilDelUsuario.es_root ? "Root" : perfilDelUsuario.nombre) : "Sin perfil";

    const celdaAcciones = document.createElement("td");
    // Root no se edita desde acá, mismo motivo que en perfiles: siempre
    // tiene todos los permisos por definición.
    if (!perfilDelUsuario?.es_root) {
      const botonEditar = document.createElement("button");
      botonEditar.type = "button";
      botonEditar.className = "btn-editar-fila";
      botonEditar.textContent = "Editar";
      botonEditar.addEventListener("click", () => mostrarFormUsuario(usuario));
      celdaAcciones.appendChild(botonEditar);
    }
    const botonReset = document.createElement("button");
    botonReset.type = "button";
    botonReset.className = "btn-editar-fila";
    botonReset.textContent = "Restablecer contraseña";
    botonReset.addEventListener("click", async () => {
      try {
        await sendPasswordResetEmail(auth, usuario.email);
        window.alert(`Se envió un email para restablecer la contraseña a ${usuario.email}.`);
      } catch {
        window.alert("No se pudo enviar el email de restablecimiento.");
      }
    });
    celdaAcciones.appendChild(botonReset);

    fila.append(celdaEmail, celdaPerfil, celdaAcciones);
    elTablaUsuariosCuerpo.appendChild(fila);
  });
}

function mostrarListaUsuarios() {
  elUsuariosVistaForm.classList.add("oculto");
  elUsuariosVistaLista.classList.remove("oculto");
}

// usuario == null: alta de un corredor nuevo (pide contraseña inicial y
// crea la cuenta de Auth). Con un usuario, edita solo el perfil asignado
// — el email de una cuenta de Firebase Auth no se cambia desde acá.
function mostrarFormUsuario(usuario) {
  formularioUsuario.reset();
  elUsuarioError.classList.add("oculto");
  actualizarSelectPerfiles();
  if (usuario) {
    elUsuarioUidEditando.value = usuario.id;
    elUsuarioFormTitulo.textContent = `Editar ${usuario.email}`;
    elUsuarioEmail.value = usuario.email;
    elUsuarioEmail.disabled = true;
    elUsuarioPasswordLabel.classList.add("oculto");
    elUsuarioPassword.required = false;
    if (usuario.perfil_id) elUsuarioPerfil.value = usuario.perfil_id;
    elUsuarioGuardar.textContent = "Guardar cambios";
  } else {
    elUsuarioUidEditando.value = "";
    elUsuarioFormTitulo.textContent = "Nuevo usuario";
    elUsuarioEmail.disabled = false;
    elUsuarioPasswordLabel.classList.remove("oculto");
    elUsuarioPassword.required = true;
    elUsuarioGuardar.textContent = "Crear usuario";
  }
  elUsuariosVistaLista.classList.add("oculto");
  elUsuariosVistaForm.classList.remove("oculto");
}

elBtnAgregarUsuario.addEventListener("click", () => mostrarFormUsuario(null));
elUsuarioVolver.addEventListener("click", mostrarListaUsuarios);

// Dar de alta un corredor sin pisar la sesión de quien lo está creando:
// createUserWithEmailAndPassword deja logueada esa cuenta nueva en la
// instancia de Auth donde se la llama, así que se usa una instancia de
// Firebase App secundaria y descartable, en vez de la principal (`auth`).
async function crearCuentaDeCorredor(email, password) {
  const appSecundaria = initializeApp(firebaseConfig, `alta-${Date.now()}`);
  const authSecundaria = getAuth(appSecundaria);
  try {
    const credencial = await createUserWithEmailAndPassword(authSecundaria, email, password);
    return credencial.user.uid;
  } finally {
    await signOut(authSecundaria).catch(() => {});
    await deleteApp(appSecundaria);
  }
}

formularioUsuario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elUsuarioError.classList.add("oculto");
  try {
    const uidEditando = elUsuarioUidEditando.value;
    if (uidEditando) {
      await setDoc(doc(db, "usuarios", uidEditando), { email: elUsuarioEmail.value, perfil_id: elUsuarioPerfil.value });
    } else {
      const email = elUsuarioEmail.value.trim();
      const uid = await crearCuentaDeCorredor(email, elUsuarioPassword.value);
      await setDoc(doc(db, "usuarios", uid), { email, perfil_id: elUsuarioPerfil.value });
    }
    await cargarUsuarios();
    mostrarListaUsuarios();
  } catch (error) {
    elUsuarioError.textContent =
      error.code === "auth/email-already-in-use"
        ? "Ya existe una cuenta con ese email."
        : error.code === "auth/weak-password"
        ? "La contraseña tiene que tener al menos 6 caracteres."
        : "No se pudo guardar el usuario.";
    elUsuarioError.classList.remove("oculto");
  }
});

// "Seguridad" en el menú lateral no abre directo a una pestaña por
// defecto: son dos entradas separadas ("Usuarios" y "Perfiles de
// seguridad") y quien entra elige a cuál.
// Esconder las otras pantallas lo hace js/router.js antes de que esto
// corra (ver el comentario allá). Las dos entradas son dos rutas
// distintas sobre el mismo panel: /usuarios y /perfiles.
async function abrirPanelSeguridad(tab) {
  mostrarListaUsuarios();
  mostrarListaPerfiles();
  if (tab === "perfiles") mostrarTabPerfiles();
  else mostrarTabUsuarios();
  elPanelAdmin.classList.remove("oculto");
  await cargarPerfiles();
  await cargarUsuarios();
}

elMenuSeguridadUsuarios.addEventListener("click", () => abrirPanelSeguridad("usuarios"));
elMenuSeguridadPerfiles.addEventListener("click", () => abrirPanelSeguridad("perfiles"));

// El ← de este panel lo maneja js/router.js (data-volver en el botón).
