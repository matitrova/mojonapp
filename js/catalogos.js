// ---------------------------------------------------------------------------
// Catálogos de "Zonas" (colección Firestore "sectores" — el nombre interno
// no se tocó al renombrar la UI a "Zona", para no arriesgar una migración
// de datos reales sin necesidad) y "Barrios": dos categorizaciones
// independientes de un lote (tiene zona Y barrio a la vez), con el mismo
// patrón exacto en todo — datos, combos, y panel de administración.
//
// getDocs/addDoc/setDoc/deleteDoc/collection/doc y `db` los recibe este
// módulo por parámetro desde app.js en vez de importar el SDK de Firebase
// directo acá — así no duplica esa dependencia ni el objeto `db`.
// ---------------------------------------------------------------------------

import {
  getSectoresActuales,
  setSectoresActuales,
  getBarriosActuales,
  setBarriosActuales,
  getMotivosActuales,
  setMotivosActuales,
  getEtiquetasCrmActuales,
  setEtiquetasCrmActuales
} from "./estado.js";
import { registrarAuditoria } from "./auditoria.js";
// estado-vacio.js no importa a nadie, así que no hay riesgo de ciclo.
import { pintarEstadoVacio } from "./estado-vacio.js";

let db, getDocs, addDoc, setDoc, deleteDoc, collection, doc;

// app.js llama esto una sola vez, antes de usar cualquier otra función de
// este módulo — le pasa el SDK de Firestore ya inicializado (mismo patrón
// que el resto de la app, sin duplicar el import del CDN acá).
export function configurarCatalogos(sdk) {
  ({ db, getDocs, addDoc, setDoc, deleteDoc, collection, doc } = sdk);
}

// ---------------------------------------------------------------------------
// Datos: cargar cada catálogo desde Firestore y poblar un <select> con él.
// Las usan, además del panel de administración de acá abajo, la ficha
// (editores inline de zona/barrio), "Cargar a mano" y "Editar lote".
// ---------------------------------------------------------------------------

// Si falla (reglas viejas sin esta colección, sin conexión, etc.) el
// catálogo queda vacío — no puede tirar abajo el login ni el resto de la
// carga de lotes, así que el catch deja la lista en [] y sigue.
async function cargarCatalogoEn(coleccion, setter) {
  try {
    const snapshot = await getDocs(collection(db, coleccion));
    setter(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.nombre.localeCompare(b.nombre)));
  } catch {
    setter([]);
  }
}

export async function cargarSectores() {
  await cargarCatalogoEn("sectores", setSectoresActuales);
}

// Mismo catálogo que zonas, colección separada — un lote tiene zona Y
// barrio a la vez, son dos categorías independientes.
export async function cargarBarrios() {
  await cargarCatalogoEn("barrios", setBarriosActuales);
}

// Catálogos del CRM (motivos de pérdida y etiquetas de contacto): antes
// eran texto libre, así que "precio"/"Precio"/"caro" contaban como tres
// motivos distintos en el Dashboard y "urgente"/"Urgente" como dos
// etiquetas en el filtro del pipeline. Ver asegurarEnCatalogo más abajo.
export async function cargarMotivos() {
  await cargarCatalogoEn("motivos_perdida", setMotivosActuales);
}

export async function cargarEtiquetasCrm() {
  await cargarCatalogoEn("etiquetas_contacto", setEtiquetasCrmActuales);
}

// valorActual: el nombre que ya tiene el lote (si lo tiene), para
// preseleccionarlo — y para no perderlo si ya no está en el catálogo
// (se borró después de asignárselo a este lote, o se cargó a mano antes
// de que existiera esta lista). catalogo/textoVacio parametrizan entre
// zona y barrio, que comparten exactamente esta misma lógica.
export function poblarSelectCatalogo(elSelect, valorActual, catalogo, textoVacio) {
  const opciones = catalogo.map((s) => `<option value="${s.nombre}">${s.nombre}</option>`);
  if (valorActual && !catalogo.some((s) => s.nombre === valorActual)) {
    opciones.push(`<option value="${valorActual}">${valorActual} (fuera del catálogo)</option>`);
  }
  elSelect.innerHTML = `<option value="">${textoVacio}</option>` + opciones.join("");
  elSelect.value = valorActual || "";
}

export function poblarSelectSector(elSelect, valorActual) {
  poblarSelectCatalogo(elSelect, valorActual, getSectoresActuales(), "Sin zona");
}

export function poblarSelectBarrio(elSelect, valorActual) {
  poblarSelectCatalogo(elSelect, valorActual, getBarriosActuales(), "Sin barrio");
}

// Los catálogos del CRM se eligen con un <input list> + <datalist> en vez
// de un <select>: el corredor tiene que poder elegir uno de la lista O
// escribir uno nuevo sin frenar la carga ("lista + crear al vuelo",
// decisión del usuario). Un <select> solo no permite lo segundo.
function poblarDatalist(idDatalist, catalogo) {
  const el = document.getElementById(idDatalist);
  if (!el) return;
  el.innerHTML = catalogo.map((item) => `<option value="${item.nombre}"></option>`).join("");
}

// Los ids de los <datalist> viven solo acá: quien necesita refrescar el
// autocompletado (app.js al iniciar sesión, crm-formulario.js al crear un
// valor nuevo al vuelo) llama a esto y listo.
export function refrescarDatalistsCrm() {
  poblarDatalist("lista-motivos", getMotivosActuales());
  poblarDatalist("lista-etiquetas-crm", getEtiquetasCrmActuales());
}

// El corazón del "sin duplicados": devuelve SIEMPRE el nombre canónico.
// Si lo que se tipeó ya está en el catálogo con otra capitalización
// ("precio" cuando existe "Precio"), devuelve el del catálogo; si no
// está, lo agrega y lo devuelve tal cual se escribió.
//
// Nunca tira: si el usuario no tiene el permiso para escribir el catálogo
// (o no hay conexión), devuelve el texto original y deja que el contacto
// se guarde igual — el catálogo es para ordenar, no para bloquear una
// carga en el medio del campo.
async function asegurarEnCatalogo(nombre, coleccion, getCatalogoActual, recargar) {
  const limpio = (nombre || "").trim();
  if (!limpio) return null;
  const yaExiste = getCatalogoActual().find((item) => item.nombre.toLowerCase() === limpio.toLowerCase());
  if (yaExiste) return yaExiste.nombre;
  try {
    await addDoc(collection(db, coleccion), { nombre: limpio });
    await recargar();
    refrescarDatalistsCrm(); // el valor nuevo ya queda para autocompletar
  } catch {
    // sin permiso / sin conexión: el valor se guarda igual en el contacto
  }
  return limpio;
}

export function asegurarMotivo(nombre) {
  return asegurarEnCatalogo(nombre, "motivos_perdida", getMotivosActuales, cargarMotivos);
}

export function asegurarEtiqueta(nombre) {
  return asegurarEnCatalogo(nombre, "etiquetas_contacto", getEtiquetasCrmActuales, cargarEtiquetasCrm);
}

// ---------------------------------------------------------------------------
// Panel de administración: lista + alta/edición + borrado. "Sectores" y
// "Barrios" son el mismo patrón exacto (root / permiso administrar_
// sectores), así que se arma una sola vez acá y se instancia dos veces
// en vez de mantener dos copias del mismo código.
// ---------------------------------------------------------------------------

// Todos los paneles de catálogo que existen: al abrir uno se cierran los
// otros (antes era un solo "panel hermano", con dos alcanzaba).
const PANELES_CATALOGO = ["panel-sectores", "panel-barrios", "panel-motivos", "panel-etiquetas-crm"];

function crearPanelCatalogo({
  prefijo, // singular, para los ids que van uno por item ("sector", "motivo"...)
  plural, // para los ids del panel/tabla/vistas ("sectores", "motivos"...)
  panelId, // "panel-sectores" | "panel-barrios" | "panel-motivos" | "panel-etiquetas-crm"
  coleccion, // colección de Firestore
  entidad, // "zona" | "barrio" | "motivo" | "etiqueta" — para los mensajes
  genero, // "f" (zona, etiqueta) | "m" (barrio, motivo) — concordancia de los mensajes
  tituloNuevo, // "Nueva zona" | "Nuevo barrio" | ...
  cargarCatalogo, // cargarSectores | cargarBarrios | cargarMotivos | cargarEtiquetasCrm
  getCatalogoActual // getSectoresActuales | getBarriosActuales | ...
}) {
  const articulo = genero === "f" ? "la" : "el";
  const pronombre = genero === "f" ? "la" : "lo"; // "la tienen asignada" / "lo tienen asignado"
  const terminacion = genero === "f" ? "a" : "o";
  const elPanel = document.getElementById(panelId);
  const elBtnAbrir = document.getElementById(`btn-abrir-${plural}`);
  const elVistaLista = document.getElementById(`${plural}-vista-lista`);
  const elVistaForm = document.getElementById(`${plural}-vista-form`);
  const elTablaCuerpo = document.getElementById(`tabla-${plural}-cuerpo`);
  const elVacio = document.getElementById(`${plural}-vacio`);
  // La tabla ENTERA, no solo el cuerpo: el encabezado "Nombre" y su raya
  // son HTML fijo, y son justamente lo que hacía parecer que la pantalla
  // había fallado cuando no hay nada cargado.
  const elTablaScroll = elTablaCuerpo.closest(".tabla-scroll");
  const elBtnAgregar = document.getElementById(`btn-agregar-${prefijo}`);
  const elVolver = document.getElementById(`${prefijo}-volver`);
  const elFormTitulo = document.getElementById(`${prefijo}-form-titulo`);
  const formulario = document.getElementById(`formulario-${prefijo}`);
  const elIdEditando = document.getElementById(`${prefijo}-id-editando`);
  const elNombre = document.getElementById(`${prefijo}-nombre`);
  const elError = document.getElementById(`${prefijo}-error`);

  async function cargarPanel() {
    await cargarCatalogo();
    // Los <datalist> del formulario de contacto se arman desde el mismo
    // estado que acaba de recargarse, así que se repueblan acá.
    //
    // FALTABA: crear un motivo o una etiqueta desde su panel no llegaba
    // al autocompletado del formulario hasta recargar la página entera.
    // El único lugar que refrescaba los datalist era asegurarEnCatalogo
    // (el camino "lo escribo al vuelo en el contacto"), no el panel de
    // administración. Se llama para los cuatro catálogos: para zonas y
    // barrios es un no-op barato (repinta dos datalist con lo mismo) y
    // evita tener que acordarse de encenderlo por catálogo.
    refrescarDatalistsCrm();

    elTablaCuerpo.innerHTML = "";
    getCatalogoActual().forEach((item) => {
      const fila = document.createElement("tr");
      const celdaNombre = document.createElement("td");
      celdaNombre.textContent = item.nombre;

      const celdaAcciones = document.createElement("td");
      const botonEditar = document.createElement("button");
      botonEditar.type = "button";
      botonEditar.className = "btn-editar-fila";
      botonEditar.textContent = "Editar";
      botonEditar.addEventListener("click", () => mostrarForm(item));
      celdaAcciones.appendChild(botonEditar);

      const botonBorrar = document.createElement("button");
      botonBorrar.type = "button";
      botonBorrar.className = "btn-borrar-fila";
      botonBorrar.textContent = "Borrar";
      botonBorrar.addEventListener("click", () => borrarItem(item, botonBorrar));
      celdaAcciones.appendChild(botonBorrar);

      fila.append(celdaNombre, celdaAcciones);
      elTablaCuerpo.appendChild(fila);
    });

    // Un catálogo vacío no es un error, pero sin esto se ve igual que
    // uno. El botón de agregar queda visible: es el paso siguiente.
    // `plural` es también la clave en TEXTOS de js/estado-vacio.js.
    const vacio = getCatalogoActual().length === 0;
    if (vacio) pintarEstadoVacio(elVacio, { pantalla: plural, conSesion: true });
    elVacio.classList.toggle("oculto", !vacio);
    elTablaScroll.classList.toggle("oculto", vacio);
  }

  function mostrarLista() {
    elVistaForm.classList.add("oculto");
    elVistaLista.classList.remove("oculto");
  }

  // item == null: alta de un item nuevo. Con un item, lo precarga para
  // editarlo (mismo formulario, en modo edición).
  function mostrarForm(item) {
    formulario.reset();
    elError.classList.add("oculto");
    if (item) {
      elIdEditando.value = item.id;
      elFormTitulo.textContent = `Editar "${item.nombre}"`;
      elNombre.value = item.nombre;
    } else {
      elIdEditando.value = "";
      elFormTitulo.textContent = tituloNuevo;
    }
    elVistaLista.classList.add("oculto");
    elVistaForm.classList.remove("oculto");
  }

  elBtnAgregar.addEventListener("click", () => mostrarForm(null));
  elVolver.addEventListener("click", mostrarLista);

  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    elError.classList.add("oculto");
    try {
      const datos = { nombre: elNombre.value.trim() };
      const idEditando = elIdEditando.value;
      // Duplicados, case-insensitive: hasta ahora se podía cargar "Merlo"
      // y "merlo" como dos zonas distintas. Al estar acá, la validación
      // protege a los cuatro catálogos por igual.
      const repetido = getCatalogoActual().find(
        (item) => item.id !== idEditando && item.nombre.toLowerCase() === datos.nombre.toLowerCase()
      );
      if (repetido) {
        elError.textContent = `Ya existe: "${repetido.nombre}".`;
        elError.classList.remove("oculto");
        return;
      }
      if (idEditando) {
        await setDoc(doc(db, coleccion, idEditando), datos);
        registrarAuditoria({ accion: `editar_${entidad}`, objetoId: idEditando, objetoTitulo: datos.nombre });
      } else {
        const nuevoRef = await addDoc(collection(db, coleccion), datos);
        registrarAuditoria({ accion: `crear_${entidad}`, objetoId: nuevoRef.id, objetoTitulo: datos.nombre });
      }
      await cargarPanel();
      mostrarLista();
    } catch (error) {
      elError.textContent =
        error.code === "permission-denied"
          ? `No tienes permiso para administrar ${entidad}s.`
          : `No se pudo guardar ${articulo} ${entidad}.`;
      elError.classList.remove("oculto");
    }
  });

  // Borrar un item del catálogo no le toca el dato a los lotes que ya lo
  // tenían asignado — solo dejan de poder elegirlo de nuevo para otro lote.
  async function borrarItem(item, boton) {
    if (
      !window.confirm(
        `¿Borrar ${articulo} ${entidad} "${item.nombre}"? Los lotes que ya ${pronombre} tienen asignad${terminacion} no se ven afectados.`
      )
    )
      return;
    boton.disabled = true;
    try {
      await deleteDoc(doc(db, coleccion, item.id));
      registrarAuditoria({ accion: `borrar_${entidad}`, objetoId: item.id, objetoTitulo: item.nombre });
      await cargarPanel();
    } catch (error) {
      window.alert(
        error.code === "permission-denied" ? `No tienes permiso para borrar ${entidad}s.` : `No se pudo borrar ${articulo} ${entidad}.`
      );
    } finally {
      boton.disabled = false;
    }
  }

  // Ya no esconde las otras pantallas (ni los otros catálogos): lo hace
  // js/router.js antes de que esto corra, escondiendo TODO lo que tenga
  // .panel-pantalla-completa. Acá vivía la lista a mano que hubo que ir
  // ampliando con cada pantalla nueva — primero "el panel hermano",
  // después los cuatro catálogos, después el CRM…
  elBtnAbrir.addEventListener("click", async () => {
    mostrarLista();
    elPanel.classList.remove("oculto");
    await cargarPanel();
  });

  // El ← de cada catálogo lo maneja el router (data-volver en el botón).
}

// Cablea los dos paneles (Sectores/Zonas y Barrios) — se llama una vez
// desde app.js al arrancar, después de configurarCatalogos().
export function iniciarCatalogos() {
  crearPanelCatalogo({
    prefijo: "sector",
    plural: "sectores",
    panelId: "panel-sectores",
    coleccion: "sectores",
    entidad: "zona",
    genero: "f",
    tituloNuevo: "Nueva zona",
    cargarCatalogo: cargarSectores,
    getCatalogoActual: getSectoresActuales
  });
  crearPanelCatalogo({
    prefijo: "barrio",
    plural: "barrios",
    panelId: "panel-barrios",
    coleccion: "barrios",
    entidad: "barrio",
    genero: "m",
    tituloNuevo: "Nuevo barrio",
    cargarCatalogo: cargarBarrios,
    getCatalogoActual: getBarriosActuales
  });
  // Catálogos del CRM. "etiqueta-crm" y no "etiqueta" a propósito: la
  // fábrica arma el id `btn-agregar-${prefijo}`, y `btn-agregar-etiqueta`
  // YA existe (es el botón que suma una etiqueta a un contacto).
  crearPanelCatalogo({
    prefijo: "motivo",
    plural: "motivos",
    panelId: "panel-motivos",
    coleccion: "motivos_perdida",
    entidad: "motivo",
    genero: "m",
    tituloNuevo: "Nuevo motivo",
    cargarCatalogo: cargarMotivos,
    getCatalogoActual: getMotivosActuales
  });
  crearPanelCatalogo({
    prefijo: "etiqueta-crm",
    plural: "etiquetas-crm",
    panelId: "panel-etiquetas-crm",
    coleccion: "etiquetas_contacto",
    entidad: "etiqueta",
    genero: "f",
    tituloNuevo: "Nueva etiqueta",
    cargarCatalogo: cargarEtiquetasCrm,
    getCatalogoActual: getEtiquetasCrmActuales
  });
}
