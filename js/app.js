// ---------------------------------------------------------------------------
// MojonApp. Los lotes viven en Firestore (colección "lotes"): cualquiera
// que abra la app los puede ver, pero solo un corredor logueado (Firebase
// Auth) puede cargar uno nuevo. Ver firebase-config.js y firestore.rules.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  getLoteSeleccionado,
  setCorredorLogueado,
  setMiPerfil,
  setSectoresActuales,
  setBarriosActuales,
  setLoteEditadoDesdeFicha,
  emitirSesionCerrada
} from "./estado.js";
import { tienePermiso, puedeEditarLote, puedeBorrarLote, esRootActual } from "./permisos.js";
import { iniciarEstoyYendo } from "./estoy-yendo.js";
import {
  configurarCatalogos,
  iniciarCatalogos,
  cargarSectores,
  cargarBarrios,
  poblarSelectSector,
  poblarSelectBarrio
} from "./catalogos.js";
import { configurarDashboard, abrirPanelDashboard, renderDashboard } from "./dashboard.js";
import { configurarCrm } from "./crm.js";
import { configurarFavoritos } from "./favoritos.js";
import { configurarVistaLista, aplicarFiltrosDesdeUrlSiCorresponde } from "./vista-lista.js";
import { configurarEditorForma } from "./editor-forma.js";
import { configurarCargarLote } from "./cargar-lote.js";
import {
  mapa,
  cargarLotesDesdeFirestore,
  anilloAGeometryFirestore,
  configurarMapa,
  iniciarMapa
} from "./mapa.js";
import {
  mostrarFicha,
  tituloLote,
  contenidoTooltipLote,
  borrarLote,
  cerrarEditorServicios,
  cerrarEditorSector,
  cerrarEditorBarrio,
  abrirLoteDesdeUrlSiCorresponde
} from "./ficha.js";
import "./admin.js";
import "./auditoria.js";
import "./ia-proximamente.js";
import "./ia-descripcion.js";
import "./dibujar-area.js";
import {
  collection,
  getDocs,
  getDoc,
  addDoc,
  deleteDoc,
  updateDoc,
  setDoc,
  doc,
  query,
  where,
  increment
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

configurarCatalogos({ db, getDocs, addDoc, setDoc, deleteDoc, collection, doc });
iniciarCatalogos();

const ETIQUETA_ESTADO = {
  disponible: "Disponible",
  reservado: "Reservado",
  vendido: "Vendido"
};

// Texto de estado listo para mostrar, con la fecha de vencimiento de la
// reserva si corresponde ("Reservado (hasta 15/09/2026)" o "Reservado
// (vencida desde 10/09/2026)" en rojo) — para que un lote reservado
// hace rato y nunca actualizado no pase desapercibido. HTML porque el
// "vencida" va en rojo (.texto-vencido); si no hay fecha, se devuelve
// como texto plano (sin riesgo: ETIQUETA_ESTADO no trae HTML).
function textoEstadoConVencimiento(p) {
  const base = ETIQUETA_ESTADO[p.estado] || p.estado;
  if (p.estado !== "reservado" || !p.reservado_hasta) return base;
  const hoy = new Date().toISOString().slice(0, 10);
  const fecha = new Date(`${p.reservado_hasta}T00:00:00`).toLocaleDateString("es-AR");
  return p.reservado_hasta < hoy
    ? `${base} <span class="texto-vencido">(vencida desde ${fecha})</span>`
    : `${base} (hasta ${fecha})`;
}

// Servicios que puede tener un lote (luz, agua, gas, cloaca). El catastro
// no trae este dato — solo se carga a mano ("Cargar a mano"), así que la
// mayoría de los lotes importados de "+ Manzana"/"+ Parcela" no van a
// tener el campo `servicios` en absoluto. Se distingue "sin dato" (no se
// muestra nada) de "no tiene el servicio" (chip apagado) — ver
// renderServiciosHTML.
const SERVICIOS_INFO = [
  { clave: "luz", icono: "⚡", etiqueta: "Luz" },
  { clave: "agua", icono: "🚰", etiqueta: "Agua" },
  { clave: "gas", icono: "🔥", etiqueta: "Gas" },
  { clave: "cloaca", icono: "🚽", etiqueta: "Cloaca" }
];

function renderServiciosHTML(servicios) {
  if (servicios == null) return "Sin datos";
  return SERVICIOS_INFO.map(({ clave, icono, etiqueta }) => {
    const tiene = !!servicios[clave];
    return `<span class="chip-servicio${tiene ? "" : " sin-servicio"}">${icono} ${etiqueta}</span>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Hojas inferiores (ficha, login, y los formularios de carga): todas
// comparten la misma posición fija en la parte de abajo de la pantalla,
// así que abrir una sin cerrar las demás las deja superpuestas. Cualquier
// botón que abra una hoja pasa por acá para cerrar el resto primero.
// ---------------------------------------------------------------------------

function abrirHoja(elHoja) {
  document.querySelectorAll(".hoja-inferior").forEach((hoja) => {
    if (hoja !== elHoja) hoja.classList.add("oculto");
  });
  elHoja.classList.remove("oculto");
}

// ---------------------------------------------------------------------------
// Menú lateral (drawer): todas las secciones/subsecciones de la app en
// un solo lugar, para no seguir amontonando botones en el header a
// medida que se suman funciones nuevas.
// ---------------------------------------------------------------------------

const elBtnMenu = document.getElementById("btn-menu");
const elDrawerMenu = document.getElementById("drawer-menu");
const elDrawerOverlay = document.getElementById("drawer-overlay");

// "Contraído" no es lo mismo que "oculto" desde que el menú es el único
// de la app (ver index.html/estilos.css): con sesión en escritorio, el
// menú contraído sigue visible como un rail de íconos, así que cerrarlo
// solo le saca .expandido — el CSS decide si contraído significa "rail"
// (escritorio con sesión) o "no se ve" (celular / sin sesión). .oculto
// queda reservado para "no hay sesión", lo maneja onAuthStateChanged.
function abrirDrawer() {
  elDrawerMenu.classList.remove("oculto");
  elDrawerMenu.classList.add("expandido");
  elDrawerOverlay.classList.remove("oculto");
}

function cerrarDrawer() {
  elDrawerMenu.classList.remove("expandido");
  elDrawerOverlay.classList.add("oculto");
}

elBtnMenu.addEventListener("click", abrirDrawer);
document.getElementById("cerrar-drawer").addEventListener("click", cerrarDrawer);
elDrawerOverlay.addEventListener("click", cerrarDrawer);

// Elegir cualquier acción del menú cierra el drawer: casi todas abren
// otra hoja o panel encima del mapa, así que dejarlo abierto tapando
// todo no sirve.
document.querySelectorAll(".drawer-item").forEach((boton) => {
  boton.addEventListener("click", cerrarDrawer);
});

// Tocar el ícono de un módulo lleva a su pantalla por defecto (mismo
// criterio que Gestor: el módulo es una puerta, no solo un rótulo) — y
// cierra el menú, igual que cualquier ítem. Se hace disparando el botón
// que YA abre esa pantalla, no duplicando la lógica de apertura.
const PANTALLA_POR_MODULO = {
  "btn-modulo-inicio": "btn-abrir-dashboard",
  "btn-modulo-lotes": "btn-drawer-mapa",
  "btn-modulo-contactos": "btn-abrir-crm",
  "btn-modulo-sistema": "menu-seguridad-usuarios"
};
Object.entries(PANTALLA_POR_MODULO).forEach(([idModulo, idDestino]) => {
  document.getElementById(idModulo).addEventListener("click", () => {
    document.getElementById(idDestino).click();
    cerrarDrawer();
  });
});

// Barra de secciones persistente (Mapa | Lista | Dashboard | CRM) — ver
// index.html/estilos.css. Cada botón dispara la MISMA función que ya
// abre esa pantalla hoy (ningún estado nuevo que sincronizar a mano);
// los "×" de cada panel se dejan funcionando tal cual estaban, esto es
// un camino adicional, no un reemplazo.
function volverAlMapa() {
  [
    "panel-admin",
    "panel-auditoria",
    "panel-ia",
    "panel-sectores",
    "panel-barrios",
    "panel-dashboard",
    "panel-favoritos",
    "panel-comparar-lotes",
    "panel-cartel-qr",
    "panel-ficha-imprimir",
    "panel-crm",
    "vista-lista"
  ].forEach((id) => document.getElementById(id).classList.add("oculto"));
  document.getElementById("btn-ver-lista").classList.remove("activo");
  // A propósito NO toca "ficha-lote" — mirar una ficha con el mapa de
  // fondo ya es "estar en el Mapa", no hace falta cerrarla para volver.
  document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("activo"));
  document.getElementById("nav-tab-mapa").classList.add("activo");
}

// Botón "atrás" del navegador (pedido explícito del usuario) — hasta
// ahora, al ser un solo index.html sin ninguna entrada de historial
// propia, "atrás" sacaba de la app entera en vez de volver a la sección
// anterior DENTRO del sistema. Se pushea un estado por cada cambio entre
// las 4 secciones principales (Mapa/Lista/Dashboard/CRM) — alcance
// acotado a propósito, no cubre paneles del drawer ni la ficha de un
// lote (mirar una ficha ya "es" estar en el Mapa, ver volverAlMapa).
let seccionActual = "mapa";
let restaurandoDesdeHistorial = false;

function irASeccion(seccion, accion) {
  if (!restaurandoDesdeHistorial && seccion !== seccionActual) {
    history.pushState({ seccion }, "", location.href);
  }
  seccionActual = seccion;
  accion();
}

window.addEventListener("popstate", (evento) => {
  restaurandoDesdeHistorial = true;
  const seccion = evento.state?.seccion || "mapa";
  document.getElementById(`nav-tab-${seccion}`).click();
  restaurandoDesdeHistorial = false;
});

history.replaceState({ seccion: "mapa" }, "", location.href);

document.getElementById("nav-tab-mapa").addEventListener("click", () => irASeccion("mapa", volverAlMapa));
document.getElementById("nav-tab-lista").addEventListener("click", () => {
  irASeccion("lista", () => {
    // "Ver como lista" es un toggle (ver vista-lista.js) — solo se
    // reenvía el click si todavía está cerrado, para no cerrarlo por
    // error si ya era la sección activa.
    if (document.getElementById("vista-lista").classList.contains("oculto")) {
      document.getElementById("btn-ver-lista").click();
    }
  });
});
document.getElementById("nav-tab-dashboard").addEventListener("click", () => {
  irASeccion("dashboard", () => document.getElementById("btn-abrir-dashboard").click());
});
document.getElementById("nav-tab-crm").addEventListener("click", () => {
  irASeccion("crm", () => document.getElementById("btn-abrir-crm").click());
});
// "Mapa" del menú: dispara el mismo botón de la barra de secciones
// oculta, que es quien sabe mostrar el mapa y cerrar el resto de los
// paneles (volverAlMapa) y además deja la entrada de historial para que
// el botón "atrás" del navegador siga funcionando entre secciones.
document.getElementById("btn-drawer-mapa").addEventListener("click", () => {
  elNavTabMapa.click();
});

// #seccion-mapa se sigue solo del estado de "nav-tab-mapa" en vez de
// tocar cada uno de los ~13 lugares que ya prenden/apagan esa clase
// "activo" (dashboard.js/crm.js/vista-lista.js/acá arriba) — más seguro
// que perseguir cada call site a mano. El mapa arranca visible (sin
// sesión, es el catálogo público de siempre); con sesión, pasa a
// ocultarse/mostrarse como cualquier otra sección. Mismo motivo que ya
// documentado en renderMiniMapa (crm-formulario.js): Leaflet puede
// quedarse con un tamaño interno "roto" si el contenedor cambió de
// tamaño real mientras estaba en display:none (oculto) — invalidateSize()
// recién al volver a mostrarse, no al ocultarse, evita ese problema sin
// costo (nadie mira el mapa mientras está oculto).
const elNavTabMapa = document.getElementById("nav-tab-mapa");
const elSeccionMapa = document.getElementById("seccion-mapa");
function sincronizarSeccionMapa() {
  const visible = elNavTabMapa.classList.contains("activo");
  elSeccionMapa.classList.toggle("oculto", !visible);
  if (visible) mapa.invalidateSize();
}
new MutationObserver(sincronizarSeccionMapa).observe(elNavTabMapa, { attributes: true, attributeFilter: ["class"] });

// Wiring de los módulos que necesitan mapa/mostrarFicha/etc. — todos
// estos valores ya están disponibles como imports acá arriba (mapa.js,
// ficha.js, permisos.js, catalogos.js no tienen ninguna dependencia
// circular real hacia acá, así que no hace falta pasarles nada a mano
// salvo lo que sigue viviendo directo en este archivo: la instancia de
// Firestore/Auth).
configurarEditorForma({
  db,
  doc,
  updateDoc,
  mapa,
  mostrarFicha,
  tituloLote,
  cargarLotesDesdeFirestore,
  anilloAGeometryFirestore
});

configurarMapa({ mostrarFicha, contenidoTooltipLote });
// Encadenado: reaplica el centrado del deep link ("?lote=") si esta carga
// (la que pinta rápido, antes de saber si hay sesión) termina después que
// la de onAuthStateChanged más abajo — ver el comentario en
// abrirLoteDesdeUrlSiCorresponde (ficha.js).
iniciarMapa().then(() => {
  abrirLoteDesdeUrlSiCorresponde();
  aplicarFiltrosDesdeUrlSiCorresponde();
});

configurarVistaLista({
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
});
configurarDashboard({ db, doc, updateDoc, increment, mapa, mostrarFicha, tituloLote });
configurarCrm({ mapa, mostrarFicha, tituloLote });
configurarFavoritos({ mapa, mostrarFicha, tituloLote });
configurarCargarLote({ mapa, cargarLotesDesdeFirestore, anilloAGeometryFirestore });

iniciarEstoyYendo();

// ---------------------------------------------------------------------------
// Sesión del corredor (Firebase Auth): lectura de lotes es pública, cargar
// uno nuevo requiere estar logueado (ver firestore.rules).
// ---------------------------------------------------------------------------

const elBtnAbrirLogin = document.getElementById("btn-abrir-login");
const elSesionActiva = document.getElementById("sesion-activa");
const elSesionEmail = document.getElementById("sesion-email");
const elBtnCargarLote = document.getElementById("btn-cargar-lote");
const elBtnSalir = document.getElementById("btn-salir");

const elFormLogin = document.getElementById("form-login");
const formularioLogin = document.getElementById("formulario-login");
const elLoginEmail = document.getElementById("login-email");
const elLoginPassword = document.getElementById("login-password");
const elLoginError = document.getElementById("login-error");

elBtnAbrirLogin.addEventListener("click", () => abrirHoja(elFormLogin));
document.getElementById("cerrar-login").addEventListener("click", () => elFormLogin.classList.add("oculto"));

formularioLogin.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elLoginError.classList.add("oculto");
  try {
    await signInWithEmailAndPassword(auth, elLoginEmail.value.trim(), elLoginPassword.value);
    formularioLogin.reset();
    elFormLogin.classList.add("oculto");
    // Se abre YA, en la misma continuación síncrona del login — no
    // espera a que termine cargarLotesDesdeFirestore() (dispara aparte,
    // desde onAuthStateChanged, y es un pedido real a Firestore). Abrir
    // acá evita una carrera: si se esperara a esa carga, alcanzaba a
    // pasar un instante en el que el usuario ya había navegado a otra
    // parte (la ficha de un lote, por ejemplo) y el dashboard aparecía
    // de golpe encima, tapándola. Puede arrancar mostrando números
    // desactualizados por una fracción de segundo — se refresca solo
    // cuando esa carga efectivamente termine, ver onAuthStateChanged.
    abrirPanelDashboard();
  } catch (error) {
    elLoginError.textContent = "Email o contraseña incorrectos.";
    elLoginError.classList.remove("oculto");
  }
});

elBtnSalir.addEventListener("click", () => signOut(auth));

// Resuelve el perfil de seguridad del usuario logueado: lee su doc en
// "usuarios" para saber qué perfil tiene asignado, y ese perfil en
// "perfiles" para saber qué puede hacer. Si cualquiera de los dos pasos
// falla (cuenta sin perfil asignado todavía, o borrado a mano) se trata
// como sin permisos — nunca como root ni con acceso de más.
async function resolverMiPerfil(usuario) {
  try {
    const docUsuario = await getDoc(doc(db, "usuarios", usuario.uid));
    const perfilId = docUsuario.exists() ? docUsuario.data().perfil_id : null;
    if (!perfilId) return null;
    const docPerfil = await getDoc(doc(db, "perfiles", perfilId));
    return docPerfil.exists() ? docPerfil.data() : null;
  } catch {
    return null;
  }
}

// Muestra/oculta los botones que dependen de un permiso puntual (no de
// "estar logueado" nomás). Se llama después de resolver miPerfilActual,
// y de nuevo si root reasigna el perfil de alguien desde "Administrar".
function actualizarUIPorPermisos() {
  document.getElementById("btn-abrir-manzana").classList.toggle("oculto", !tienePermiso("cargar_lote"));
  document.getElementById("btn-abrir-parcela").classList.toggle("oculto", !tienePermiso("cargar_lote"));
  elBtnCargarLote.classList.toggle("oculto", !tienePermiso("cargar_lote"));
  document.getElementById("drawer-grupo-seguridad").classList.toggle("oculto", !tienePermiso("administrar_usuarios"));
  // A diferencia de "Usuarios"/"Perfiles de seguridad" (permiso
  // administrar_usuarios, que un corredor no-root puede tener), "quién
  // hizo qué" es exclusivamente de root — esRootActual() directo, no
  // tienePermiso().
  document.getElementById("btn-abrir-auditoria").classList.toggle("oculto", !esRootActual());
  // "Inteligencia Artificial" es una vidriera de funciones futuras que
  // implican costo por uso (APIs pagas) — mismo criterio que Auditoría,
  // decisión de root, no de cualquiera con administrar_usuarios.
  document.getElementById("btn-abrir-ia").classList.toggle("oculto", !esRootActual());
  // Sectores es un permiso propio, distinto de "administrar_usuarios": un
  // corredor puede organizar su propia cartera en zonas sin depender de
  // root, y root puede sacarle ese permiso puntual sin tocarle el resto.
  // Mismo criterio en firestore.rules.
  document.getElementById("drawer-grupo-sectores").classList.toggle("oculto", !tienePermiso("administrar_sectores"));
  // CRM: ver el panel/gestionar el pipeline entero. Crear un contacto
  // (ej. "Agregar interesado" en la ficha) no depende de este permiso,
  // ver firestore.rules.
  document.getElementById("btn-abrir-crm").classList.toggle("oculto", !tienePermiso("gestionar_contactos"));
  // "Interés del CRM" en el mapa (idea #5 de "el mapa como una cualidad
  // del CRM") — mismo permiso que el botón "CRM" del drawer.
  document.getElementById("btn-ver-interes-crm").classList.toggle("oculto", !tienePermiso("gestionar_contactos"));
  // Idea #11: el resumen de seguimientos del Dashboard abre el CRM al
  // tocar una fila (abrirContactoEnCrm en crm.js) — mismo permiso que el
  // botón "CRM" del drawer, para no mostrar un resumen que apunta a una
  // pantalla a la que ese corredor no puede entrar.
  document.getElementById("dashboard-seguimientos-seccion").classList.toggle("oculto", !tienePermiso("gestionar_contactos"));
  // "Visitas de hoy" (idea #4 de "el mapa como una cualidad del CRM")
  // — mismo permiso que "Seguimientos pendientes".
  document.getElementById("dashboard-visitas-seccion").classList.toggle("oculto", !tienePermiso("gestionar_contactos"));
  // "Ventas" (pedido explícito: que el dashboard ayude a vender más, no
  // solo a llevar el inventario de lotes) — mismo permiso que el resto
  // de lo que depende del pipeline del CRM.
  document.getElementById("dashboard-ventas-seccion").classList.toggle("oculto", !tienePermiso("gestionar_contactos"));
  document.getElementById("dashboard-embudo-seccion").classList.toggle("oculto", !tienePermiso("gestionar_contactos"));
  document.getElementById("dashboard-motivos-perdida-seccion").classList.toggle("oculto", !tienePermiso("gestionar_contactos"));
  // Tab "CRM" de la barra de secciones — mismo permiso que el botón del
  // drawer (#btn-abrir-crm).
  document.getElementById("nav-tab-crm").classList.toggle("oculto", !tienePermiso("gestionar_contactos"));
}

onAuthStateChanged(auth, async (usuario) => {
  setCorredorLogueado(!!usuario);
  setMiPerfil(usuario ? await resolverMiPerfil(usuario) : null);

  if (usuario) {
    elBtnAbrirLogin.classList.add("oculto");
    elSesionActiva.classList.remove("oculto");
    // Varios bloques del menú son solo para quien tiene sesión, y no están
    // todos juntos: el módulo "Lotes" mezcla lo público (Mapa, Lista,
    // Favoritos, Dibujar área) con lo de gestión (Carga, Catastro,
    // Clasificación). Por eso el gate es una clase y no un solo wrapper.
    document.querySelectorAll(".solo-con-sesion").forEach((el) => el.classList.remove("oculto"));
    elSesionEmail.textContent = usuario.email;
    actualizarUIPorPermisos();
    // El rail de íconos del menú (menú contraído, ver estilos.css) es
    // solo para quien tiene sesión, nunca para un visitante anónimo ni en
    // modo embed (mismo criterio que #encabezado ahí) — sin sesión el
    // menú sigue siendo el de siempre: oculto hasta que se toca el ☰.
    // #nav-secciones se deja sin "oculto" igual (aunque el CSS la
    // esconda) porque su estado "activo" es el que define qué sección se
    // ve; "con-nav-secciones" en <body> es el que activa el rail.
    if (!document.documentElement.classList.contains("modo-embed")) {
      document.getElementById("nav-secciones").classList.remove("oculto");
      document.body.classList.add("con-nav-secciones");
      elDrawerMenu.classList.remove("oculto");
      // El rail le come 68px de ancho al mapa (ver estilos.css): sin esto
      // Leaflet se queda con el tamaño de antes de iniciar sesión y
      // dibuja los tiles corridos. Mismo motivo que sincronizarSeccionMapa.
      mapa.invalidateSize();
    }
    // Aterrizaje real al iniciar sesión (pedido explícito: "apenas
    // inicie sesión que tenga un dashboard con información importante
    // para él"): el login manual YA abre el Dashboard (ver
    // formularioLogin más arriba), pero Firebase Auth persiste la
    // sesión por default — si el corredor simplemente reabre la app
    // (sin volver a pasar por el formulario), este onAuthStateChanged
    // es el único lugar donde se resuelve que ya está logueado. No
    // pisa un deep link deliberado (`?lote=`, `?vista=lista`, ver
    // abrirLoteDesdeUrlSiCorresponde/aplicarFiltrosDesdeUrlSiCorresponde)
    // ni el modo embed (mismo criterio que ficha.js con modo-embed), y
    // no hace nada si el Dashboard ya está abierto (login manual).
    if (
      location.search === "" &&
      !document.documentElement.classList.contains("modo-embed") &&
      document.getElementById("panel-dashboard").classList.contains("oculto")
    ) {
      abrirPanelDashboard();
    }
    // El catálogo de zonas/barrios necesita sesión para leerse (ver
    // firestore.rules), así que se carga acá y no al arrancar la app.
    await cargarSectores();
    await cargarBarrios();
    const elLoteSectorForm = document.getElementById("lote-sector");
    const elLoteBarrioForm = document.getElementById("lote-barrio");
    poblarSelectSector(elLoteSectorForm, elLoteSectorForm.value);
    poblarSelectBarrio(elLoteBarrioForm, elLoteBarrioForm.value);
  } else {
    elBtnAbrirLogin.classList.remove("oculto");
    elSesionActiva.classList.add("oculto");
    document.querySelectorAll(".solo-con-sesion").forEach((el) => el.classList.add("oculto"));
    document.getElementById("nav-secciones").classList.add("oculto");
    document.body.classList.remove("con-nav-secciones");
    // Sin sesión el menú vuelve a ser "oculto hasta que se toca el ☰"
    // (no queda el rail de íconos colgado de una sesión que ya cerró).
    elDrawerMenu.classList.add("oculto");
    cerrarDrawer();
    volverAlMapa();
    mapa.invalidateSize(); // el mapa recupera los 68px del rail

    setSectoresActuales([]);
    setBarriosActuales([]);
    // Cerrar sesión apaga todas las herramientas de corredor, no solo
    // "+ Lote": sin esto, si alguien cerraba sesión con "Ver catastro
    // cercano" prendido (o cualquier otro panel abierto), el botón para
    // apagarlo desaparecía junto con el resto de la barra, pero la capa
    // seguía activa y pidiéndole datos al catastro en cada movimiento del
    // mapa, visible para cualquiera que mirara la app después.
    emitirSesionCerrada();
  }

  // Si la ficha de un lote está abierta al cambiar de sesión (login,
  // logout, o root reasignando el perfil de alguien), "Borrar lote" y
  // "Editar servicios"/"Editar sector" tienen que reflejar el permiso
  // nuevo sin esperar a que se cierre y se vuelva a abrir.
  if (getLoteSeleccionado()) {
    document.getElementById("btn-borrar-lote").classList.toggle("oculto", !puedeBorrarLote(getLoteSeleccionado()));
    document.getElementById("btn-editar-lote-completo").classList.toggle("oculto", !puedeEditarLote(getLoteSeleccionado()));
    document.getElementById("btn-editar-forma-lote").classList.toggle("oculto", !puedeEditarLote(getLoteSeleccionado()));
    document.getElementById("ficha-interesados").classList.toggle("oculto", !puedeEditarLote(getLoteSeleccionado()));
    cerrarEditorServicios();
    cerrarEditorSector();
    cerrarEditorBarrio();
  }

  // El alcance de la consulta a Firestore depende del permiso
  // "ver_todos_los_lotes" (ver cargarLotesDesdeFirestore): tiene que
  // volver a pedirse cada vez que cambia quién está logueado, no solo al
  // arrancar la app.
  cargarLotesDesdeFirestore().then(() => {
    abrirLoteDesdeUrlSiCorresponde();
    aplicarFiltrosDesdeUrlSiCorresponde();
    // Si el dashboard se abrió recién (ver formularioLogin más arriba)
    // con datos todavía viejos/vacíos, esto lo refresca con los reales
    // apenas terminan de llegar. Si para entonces ya está cerrado (el
    // usuario navegó a otra parte), no hace nada visible — recalcular
    // el contenido de un panel oculto es inofensivo.
    if (!document.getElementById("panel-dashboard").classList.contains("oculto")) renderDashboard();
  });
});

