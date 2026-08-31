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
  setBarriosActuales
} from "./estado.js";

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

export async function cargarSectores() {
  try {
    const snapshot = await getDocs(collection(db, "sectores"));
    setSectoresActuales(
      snapshot.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.nombre.localeCompare(b.nombre))
    );
  } catch {
    // Si falla (reglas viejas sin esta colección, sin conexión, etc.) el
    // combo queda con "Sin zona" nomás — no puede tirar abajo el login
    // ni el resto de la carga de lotes.
    setSectoresActuales([]);
  }
}

// Mismo catálogo que zonas, colección separada — un lote tiene zona Y
// barrio a la vez, son dos categorías independientes.
export async function cargarBarrios() {
  try {
    const snapshot = await getDocs(collection(db, "barrios"));
    setBarriosActuales(
      snapshot.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.nombre.localeCompare(b.nombre))
    );
  } catch {
    setBarriosActuales([]);
  }
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

// ---------------------------------------------------------------------------
// Panel de administración: lista + alta/edición + borrado. "Sectores" y
// "Barrios" son el mismo patrón exacto (root / permiso administrar_
// sectores), así que se arma una sola vez acá y se instancia dos veces
// en vez de mantener dos copias del mismo código.
// ---------------------------------------------------------------------------

function crearPanelCatalogo({
  prefijo, // "sector" | "barrio" — singular, para los ids que van uno por item
  plural, // "sectores" | "barrios" — para los ids del panel/tabla/vistas
  panelId, // "panel-sectores" | "panel-barrios"
  coleccion, // "sectores" | "barrios"
  entidad, // "zona" | "barrio" — para los mensajes
  genero, // "f" (zona) | "m" (barrio) — concordancia de los mensajes de abajo
  tituloNuevo, // "Nueva zona" | "Nuevo barrio"
  cargarCatalogo, // cargarSectores | cargarBarrios
  getCatalogoActual, // getSectoresActuales | getBarriosActuales
  idPanelHermano // el otro panel (Barrios si esto es Sectores, y viceversa)
}) {
  const articulo = genero === "f" ? "la" : "el";
  const pronombre = genero === "f" ? "la" : "lo"; // "la tienen asignada" / "lo tienen asignado"
  const terminacion = genero === "f" ? "a" : "o";
  const elPanel = document.getElementById(panelId);
  const elBtnAbrir = document.getElementById(`btn-abrir-${plural}`);
  const elVistaLista = document.getElementById(`${plural}-vista-lista`);
  const elVistaForm = document.getElementById(`${plural}-vista-form`);
  const elTablaCuerpo = document.getElementById(`tabla-${plural}-cuerpo`);
  const elBtnAgregar = document.getElementById(`btn-agregar-${prefijo}`);
  const elVolver = document.getElementById(`${prefijo}-volver`);
  const elFormTitulo = document.getElementById(`${prefijo}-form-titulo`);
  const formulario = document.getElementById(`formulario-${prefijo}`);
  const elIdEditando = document.getElementById(`${prefijo}-id-editando`);
  const elNombre = document.getElementById(`${prefijo}-nombre`);
  const elError = document.getElementById(`${prefijo}-error`);

  async function cargarPanel() {
    await cargarCatalogo();

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
      if (idEditando) {
        await setDoc(doc(db, coleccion, idEditando), datos);
      } else {
        await addDoc(collection(db, coleccion), datos);
      }
      await cargarPanel();
      mostrarLista();
    } catch (error) {
      elError.textContent =
        error.code === "permission-denied"
          ? `No tenés permiso para administrar ${entidad}s.`
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
      await cargarPanel();
    } catch (error) {
      window.alert(
        error.code === "permission-denied" ? `No tenés permiso para borrar ${entidad}s.` : `No se pudo borrar ${articulo} ${entidad}.`
      );
    } finally {
      boton.disabled = false;
    }
  }

  elBtnAbrir.addEventListener("click", async () => {
    document.getElementById("vista-lista").classList.add("oculto"); // no superponer con "Ver como lista"
    document.getElementById("btn-ver-lista").classList.remove("activo");
    document.getElementById("panel-admin").classList.add("oculto"); // ni con "Seguridad"
    document.getElementById(idPanelHermano).classList.add("oculto"); // ni con el otro catálogo
    document.getElementById("panel-dashboard").classList.add("oculto"); // ni con "Dashboard"
    mostrarLista();
    elPanel.classList.remove("oculto");
    await cargarPanel();
  });

  document.getElementById(`cerrar-${panelId}`).addEventListener("click", () => {
    elPanel.classList.add("oculto");
  });
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
    getCatalogoActual: getSectoresActuales,
    idPanelHermano: "panel-barrios"
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
    getCatalogoActual: getBarriosActuales,
    idPanelHermano: "panel-sectores"
  });
}
