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
  getMiPerfil,
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
  cargarMotivos,
  cargarEtiquetasCrm,
  poblarSelectSector,
  poblarSelectBarrio,
  refrescarDatalistsCrm
} from "./catalogos.js";
import { configurarDashboard, renderDashboard } from "./dashboard.js";
import { configurarCrm, abrirContactoEnCrm } from "./crm.js";
import { centroideDePoligono } from "./geometria.js";
// Tareas: el módulo se registra solo al importarse (engancha su botón).
import "./tareas-panel.js";
import "./actividades-panel.js";
import "./fab-carga.js";
import { actualizarBotonCalce } from "./calce-panel.js";
import { refrescarLotePublicoSiCorresponde } from "./lote-publico.js";
import { configurarBuscador, mostrarBuscador } from "./buscador-panel.js";
import { configurarFavoritos } from "./favoritos.js";
import { configurarVistaLista, aplicarFiltrosDesdeUrlSiCorresponde, actualizarVistaLista } from "./vista-lista.js";
import { configurarEditorForma } from "./editor-forma.js";
import { configurarCargarLote } from "./cargar-lote.js";
import {
  mapa,
  centrarDejandoVer,
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
  abrirLoteDesdeUrlSiCorresponde,
  refrescarPermisosDeLaFicha
} from "./ficha.js";
import "./admin.js";
import "./auditoria.js";
import "./ia-proximamente.js";
import "./ia-descripcion.js";
import "./ia-lead.js";
import "./inmobiliaria-panel.js";
import { cargarInmobiliaria, alCambiarLaInmobiliaria } from "./inmobiliaria.js";
import { nombreParaMostrar } from "./inmobiliaria-datos.js";
import { entrarEnLaRutaDeLaUrl, navegarA, ponerNombreDeLaApp } from "./router.js";
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

// El buscador global necesita saber llevar a un lote y a un lead, y las
// dos cosas viven en módulos que no puede importar sin armar un ciclo
// (ficha.js y crm.js lo importarían de vuelta). Se le pasan por
// parámetro, mismo criterio que dashboard.js y vista-lista.js.
configurarBuscador({
  irAlLote: (feature) => {
    const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
    mostrarFicha(feature);
    // El centrado va DESPUÉS de abrir la ficha: mide la hoja para
    // sacar el lote de atrás de ella, y antes de abrirla esa hoja
    // todavía no existe (ver centrarDejandoVer en js/mapa.js).
    centrarDejandoVer(lat, lon, 19);
  },
  irAlLead: (contacto) => abrirContactoEnCrm(contacto.id)
});

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

// La navegación entre secciones vive ahora en js/router.js: una URL por
// sección, un solo lugar que decide qué se ve, y el botón "atrás" del
// navegador funcionando de verdad. Lo que había acá antes
// (volverAlMapa + irASeccion + los handlers de cada .nav-tab) era el
// parche previo: pusheaba historial pero SIEMPRE con la misma URL, y
// cada pantalla escondía a mano su propia lista incompleta de las otras
// — de ahí que abrir una sección sobre otra las superpusiera. Las
// pestañas de #nav-secciones quedan como estaban (ocultas por CSS, con
// su clase "activo" como fuente de verdad de si se ve el mapa), pero ya
// no tienen handler propio: las mantiene sincronizadas el router.

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
  // La página pública (/lote/<id>) puede haberse abierto antes de que
  // llegaran los lotes: entrar por el link es más rápido que Firestore.
  refrescarLotePublicoSiCorresponde();
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
  centrarDejandoVer,
  mostrarFicha,
  tituloLote,
  puedeEditarLote,
  puedeBorrarLote,
  borrarLote,
  cargarLotesDesdeFirestore,
  textoEstadoConVencimiento,
  renderServiciosHTML
});
configurarDashboard({ db, doc, updateDoc, increment, mapa, centrarDejandoVer, mostrarFicha, tituloLote });
configurarCrm({ mapa, centrarDejandoVer, mostrarFicha, tituloLote });
configurarFavoritos({ mapa, centrarDejandoVer, mostrarFicha, tituloLote });
configurarCargarLote({ mapa, cargarLotesDesdeFirestore, anilloAGeometryFirestore });

// Quién es la inmobiliaria. Se pide SIN esperar sesión, a propósito: el
// comprador que abre /lote/<id> no tiene cuenta y es justamente el que
// necesita ver de quién es la propiedad. Es una lectura de Firestore por
// carga de página, cacheada (ver js/inmobiliaria.js).
alCambiarLaInmobiliaria((datos) => ponerNombreDeLaApp(nombreParaMostrar(datos)));
cargarInmobiliaria();

iniciarEstoyYendo();

// Primera pasada del router (ver entrarEnLaRutaDeLaUrl en router.js):
// resuelve la URL con la que se abrió la app cuando todavía no se sabe
// si hay sesión, así las secciones públicas (/lotes, /favoritos) andan
// de una. Las que necesitan permisos se resuelven en la segunda pasada,
// desde onAuthStateChanged más abajo. Va acá, al final del wiring, para
// que todos los módulos ya tengan sus listeners puestos: el router
// navega disparando el click del botón que cada módulo registró.
entrarEnLaRutaDeLaUrl("/");

// ¿Hubo una sesión de verdad en esta carga de la app? Distingue un
// "cerró sesión" real del callback inicial de Firebase con usuario=null
// (ver el comentario en onAuthStateChanged más abajo).
let huboSesionActiva = false;

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
    //
    // Va por el router (y no directo a abrirPanelDashboard) para que la
    // URL quede en /dashboard y el "atrás" del navegador vuelva al mapa
    // público en vez de sacar de la app.
    //
    // Solo desde la raíz: si alguien entró con la URL de una sección
    // (/contactos, por ejemplo) y se logueó ahí, el aterrizaje no tiene
    // que robarle el destino — de eso se encarga la segunda pasada del
    // router en onAuthStateChanged, que ya sabe qué permisos hay.
    if (location.pathname === "/") navegarA("/dashboard");
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
// Tarjeta de usuario del pie de la barra lateral (rediseño 2026-09-18).
// El nombre sale de la parte del mail anterior a la arroba: es lo más
// parecido a un nombre que la app tiene hoy, porque no se guarda uno.
// El perfil llega después (es una lectura aparte), así que esto se llama
// de nuevo desde actualizarUIPorPermisos cuando ya se resolvió.
function pintarTarjetaDeUsuario(usuario) {
  const elNombre = document.getElementById("usuario-nombre");
  const elRol = document.getElementById("usuario-rol");
  const elAvatar = document.getElementById("usuario-avatar");
  if (!usuario) return;
  const nombre = (usuario.email || "").split("@")[0];
  elNombre.textContent = nombre;
  elNombre.title = usuario.email || "";
  elAvatar.textContent = nombre.slice(0, 2).toUpperCase();
  const perfil = getMiPerfil();
  elRol.textContent = perfil?.nombre || (perfil ? "Corredor" : "Cargando perfil…");
}

function actualizarUIPorPermisos() {
  // La lista se vuelve a dibujar, y no es un detalle: sus tildes de
  // selección, su botón "Editar" y su botón "Borrar" se dibujan según
  // puedeEditarLote/puedeBorrarLote, que dependen del perfil. Ese perfil
  // llega de una lectura a Firestore (resolverMiPerfil), así que puede
  // resolverse DESPUÉS de que la lista ya se dibujó — y antes de esto,
  // nada la volvía a dibujar: quedaba una lista sin forma de editar
  // hasta que el corredor tocara un filtro.
  //
  // Apareció como un test que fallaba una de cada tres corridas de la
  // suite completa y pasaba siempre corriendo solo: en la suite, con
  // cientos de lecturas hechas, el perfil llega más tarde. El test
  // intermitente era real, no ruido.
  actualizarVistaLista();
  // La ficha, por el MISMO motivo que la lista. Desde que el lote
  // abierto vive en la URL, recargar (o entrar por un link compartido)
  // abre la ficha en la primera pasada, antes de que el perfil llegue:
  // sin esto queda de solo lectura —sin editar, sin borrar, sin
  // interesados, sin portales— hasta cerrarla y volver a abrirla.
  refrescarPermisosDeLaFicha();
  pintarTarjetaDeUsuario(auth.currentUser);
  // Los tres botones de carga viven ahora dentro del flotante (ver
  // js/fab-carga.js), así que se gatea el flotante entero: esconder los
  // botones uno por uno dejaría un "+" que se abre y no ofrece nada.
  document.getElementById("fab-carga").classList.toggle("oculto", !tienePermiso("cargar_lote"));
  // "Calzar la foto" se esconde sin el permiso: mostrarlo sería ofrecer
  // algo que después las reglas rechazan al guardar, y el trabajo de
  // calzar a ojo se perdería recién al final.
  actualizarBotonCalce();
  document.getElementById("drawer-grupo-seguridad").classList.toggle("oculto", !tienePermiso("administrar_usuarios"));
  // A diferencia de "Usuarios"/"Perfiles de seguridad" (permiso
  // administrar_usuarios, que un corredor no-root puede tener), "quién
  // hizo qué" es exclusivamente de root — esRootActual() directo, no
  // tienePermiso().
  // "Actividades" es información de conducción (cómo viene cada
  // corredor), mismo criterio que la Auditoría: solo root.
  document.getElementById("btn-abrir-actividades").classList.toggle("oculto", !esRootActual());
  document.getElementById("btn-abrir-auditoria").classList.toggle("oculto", !esRootActual());
  // "Inteligencia Artificial" es una vidriera de funciones futuras que
  // implican costo por uso (APIs pagas) — mismo criterio que Auditoría,
  // decisión de root, no de cualquiera con administrar_usuarios.
  document.getElementById("btn-abrir-ia").classList.toggle("oculto", !esRootActual());
  // Los datos de la inmobiliaria: de acá sale el número al que llegan
  // TODAS las consultas de la web, así que es decisión de root y no de
  // cualquiera con administrar_usuarios. Mismo criterio en
  // firestore.rules (match /configuracion/{docId}).
  document.getElementById("btn-abrir-inmobiliaria").classList.toggle("oculto", !esRootActual());
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
  // Catálogos del CRM (motivos de pérdida y etiquetas): permiso propio,
  // separado de administrar_sectores (que es de lotes) — ver
  // PERMISOS_SECCIONES en admin.js y firestore.rules.
  document
    .getElementById("drawer-grupo-catalogos-crm")
    .classList.toggle("oculto", !tienePermiso("administrar_catalogos_crm"));
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
  // Las tareas son las cosas que hay que hacer con esos contactos:
  // mismo permiso que el pipeline.
  document.getElementById("btn-abrir-tareas").classList.toggle("oculto", !tienePermiso("gestionar_contactos"));
}

onAuthStateChanged(auth, async (usuario) => {
  setCorredorLogueado(!!usuario);
  setMiPerfil(usuario ? await resolverMiPerfil(usuario) : null);

  if (usuario) {
    huboSesionActiva = true;
    elBtnAbrirLogin.classList.add("oculto");
    elSesionActiva.classList.remove("oculto");
    // Varios bloques del menú son solo para quien tiene sesión, y no están
    // todos juntos: el módulo "Lotes" mezcla lo público (Mapa, Lista,
    // Favoritos, Dibujar área) con lo de gestión (Carga, Catastro,
    // Clasificación). Por eso el gate es una clase y no un solo wrapper.
    document.querySelectorAll(".solo-con-sesion").forEach((el) => el.classList.remove("oculto"));
    elSesionEmail.textContent = usuario.email;
    pintarTarjetaDeUsuario(usuario);
    mostrarBuscador(true);
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
    if (location.search === "" && !document.documentElement.classList.contains("modo-embed")) {
      // Segunda pasada del router, ya con los permisos resueltos (ver
      // entrarEnLaRutaDeLaUrl en router.js): si la app se abrió con la
      // URL de una sección (alguien que tiene /contactos en favoritos,
      // o que recargó la página estando ahí), se entra a ESA sección.
      // Si se abrió en la raíz, aterriza en el Dashboard.
      if (location.pathname === "/") navegarA("/dashboard");
      else entrarEnLaRutaDeLaUrl("/dashboard", true);
    }
    // El catálogo de zonas/barrios necesita sesión para leerse (ver
    // firestore.rules), así que se carga acá y no al arrancar la app.
    await cargarSectores();
    await cargarBarrios();
    const elLoteSectorForm = document.getElementById("lote-sector");
    const elLoteBarrioForm = document.getElementById("lote-barrio");
    poblarSelectSector(elLoteSectorForm, elLoteSectorForm.value);
    poblarSelectBarrio(elLoteBarrioForm, elLoteBarrioForm.value);
    // Mismo criterio para los catálogos del CRM: alimentan el
    // autocompletado de "motivo de pérdida" y "etiquetas" en el
    // formulario de contacto (ver los <datalist> en index.html).
    await cargarMotivos();
    await cargarEtiquetasCrm();
    refrescarDatalistsCrm();
  } else {
    elBtnAbrirLogin.classList.remove("oculto");
    elSesionActiva.classList.add("oculto");
    mostrarBuscador(false);
    document.querySelectorAll(".solo-con-sesion").forEach((el) => el.classList.add("oculto"));
    document.getElementById("nav-secciones").classList.add("oculto");
    document.body.classList.remove("con-nav-secciones");
    // Sin sesión el menú vuelve a ser "oculto hasta que se toca el ☰"
    // (no queda el rail de íconos colgado de una sesión que ya cerró).
    elDrawerMenu.classList.add("oculto");
    cerrarDrawer();
    // Cerrar sesión saca de cualquier sección privada (deja la URL en
    // "/", no en /dashboard), pero respeta las públicas: cerrar sesión
    // estando en /lotes o /favoritos no tiene por qué mover a nadie.
    //
    // El `if` no es un detalle: Firebase dispara este callback con
    // usuario=null TAMBIÉN al arrancar, antes de resolver si había una
    // sesión persistida. Sin el guard, abrir /contactos directo (o
    // recargar estando ahí) perdía el destino en ese instante y
    // terminaba en /dashboard — verificado con Playwright.
    if (huboSesionActiva) {
      huboSesionActiva = false;
      entrarEnLaRutaDeLaUrl("/", true);
    }
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
  // logout, o root reasignando el perfil de alguien), lo que depende
  // del permiso tiene que reflejar el permiso nuevo sin esperar a que
  // se cierre y se vuelva a abrir.
  //
  // ACÁ HABÍA UNA COPIA de esos toggles, escrita a mano. Se quedó corta
  // sin que nadie lo notara: cuando se sumaron los PORTALES a la ficha,
  // nadie se acordó de agregarlos también acá, así que al recargar con
  // un lote abierto los portales quedaban ocultos aunque el corredor
  // pudiera editar. Ahora las dos situaciones llaman a la MISMA función
  // de ficha.js, que es la que sabe qué gatea la ficha.
  if (getLoteSeleccionado()) {
    refrescarPermisosDeLaFicha();
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
    // La página pública (/lote/<id>) puede haberse abierto antes de que
    // llegaran los lotes: entrar por el link es más rápido que Firestore.
    refrescarLotePublicoSiCorresponde();
    aplicarFiltrosDesdeUrlSiCorresponde();
    // Si el dashboard se abrió recién (ver formularioLogin más arriba)
    // con datos todavía viejos/vacíos, esto lo refresca con los reales
    // apenas terminan de llegar. Si para entonces ya está cerrado (el
    // usuario navegó a otra parte), no hace nada visible — recalcular
    // el contenido de un panel oculto es inofensivo.
    if (!document.getElementById("panel-dashboard").classList.contains("oculto")) renderDashboard();
  });
});

