// ---------------------------------------------------------------------------
// Router de MojonApp: una URL por sección.
//
// POR QUÉ EXISTE. Hasta acá la app era un solo index.html donde cada
// pantalla se abría mostrando su <div> y escondiendo a mano una lista de
// los demás. Cada pantalla tenía su propia lista, y ninguna estaba
// completa: abrirPanelDashboard() escondía vista-lista/admin/sectores/
// barrios pero no el CRM, ni los catálogos, ni auditoría. Resultado
// (reportado por el usuario en producción): estando en Contactos, tocar
// "Dashboard" lo abría POR DEBAJO del CRM — o sea "el botón no lleva a
// ninguna parte" y "las secciones se superponen". Con 14 pantallas eran
// 14 criterios distintos y cada pantalla nueva sumaba otro.
//
// CÓMO LO RESUELVE. Este archivo es el único lugar que decide qué se ve.
// No hay ninguna lista de paneles para mantener: esconde TODO lo que
// tenga la clase .panel-pantalla-completa (las 14 ya la tienen) y recién
// después deja que se abra la pantalla destino. Es el mismo patrón que
// ya usaba abrirHoja() en app.js para las hojas inferiores
// (.hoja-inferior), llevado a las pantallas grandes.
//
// Y COMO AHORA CADA SECCIÓN TIENE URL, la navegación es de verdad: se
// puede recargar, compartir el link, y el botón "atrás" del navegador
// (y la flecha ← de cada pantalla) vuelven a la sección anterior en vez
// de sacar al corredor de la app.
//
// CÓMO SE ENGANCHA CON EL CÓDIGO QUE YA ESTABA. Cada botón del menú
// lleva un `data-ruta` en index.html, y acá se escucha el click en fase
// de CAPTURA — o sea ANTES del handler propio de ese botón. Así el
// router limpia la pantalla y arregla la URL, y después corre el handler
// que ya existía (abrirPanelDashboard, abrirPanelCrm, etc.) sobre un
// tablero limpio. Ninguna de esas 13 funciones tuvo que reescribirse, y
// todos los ids y data-testid quedaron igual (hay 49 archivos de tests
// que los usan).
// ---------------------------------------------------------------------------

// Una fila por sección. `panel` es el <div> que se muestra; `boton` es el
// ítem del menú que ya sabía abrirla (el router lo "clickea" cuando la
// navegación no vino de un click, por ejemplo al entrar por URL directa
// o al apretar "atrás"); `navTab` es la pestaña de #nav-secciones que
// hay que dejar activa — esa barra está oculta por CSS, pero su clase
// "activo" sigue siendo la que define si se ve el mapa (ver
// sincronizarSeccionMapa en app.js) y la miran varios módulos.
const RUTAS = [
  { path: "/", clave: "mapa", panel: null, boton: "btn-drawer-mapa", navTab: "nav-tab-mapa", titulo: "Mapa" },
  { path: "/lotes", clave: "lotes", panel: "vista-lista", boton: "btn-ver-lista", navTab: "nav-tab-lista", titulo: "Lotes" },
  { path: "/apartados", clave: "favoritos", panel: "panel-favoritos", boton: "btn-abrir-favoritos", navTab: null, titulo: "Apartados" },
  { path: "/dashboard", clave: "dashboard", panel: "panel-dashboard", boton: "btn-abrir-dashboard", navTab: "nav-tab-dashboard", titulo: "Dashboard" },
  { path: "/contactos", clave: "contactos", panel: "panel-crm", boton: "btn-abrir-crm", navTab: "nav-tab-crm", titulo: "Pipeline de leads" },
  { path: "/tareas", clave: "tareas", panel: "panel-tareas", boton: "btn-abrir-tareas", navTab: null, titulo: "Tareas" },
  { path: "/zonas", clave: "zonas", panel: "panel-sectores", boton: "btn-abrir-sectores", navTab: null, titulo: "Zonas" },
  { path: "/barrios", clave: "barrios", panel: "panel-barrios", boton: "btn-abrir-barrios", navTab: null, titulo: "Barrios" },
  { path: "/motivos-de-perdida", clave: "motivos", panel: "panel-motivos", boton: "btn-abrir-motivos", navTab: null, titulo: "Motivos de pérdida" },
  { path: "/etiquetas", clave: "etiquetas", panel: "panel-etiquetas-crm", boton: "btn-abrir-etiquetas-crm", navTab: null, titulo: "Etiquetas" },
  // Usuarios y Perfiles comparten #panel-admin y se diferencian por el
  // tab interno que ya existía (tab-usuarios/tab-perfiles en admin.js),
  // así que son dos rutas sobre el mismo panel.
  { path: "/usuarios", clave: "usuarios", panel: "panel-admin", boton: "menu-seguridad-usuarios", navTab: null, titulo: "Usuarios" },
  { path: "/perfiles", clave: "perfiles", panel: "panel-admin", boton: "menu-seguridad-perfiles", navTab: null, titulo: "Perfiles de seguridad" },
  { path: "/inmobiliaria", clave: "inmobiliaria", panel: "panel-inmobiliaria", boton: "btn-abrir-inmobiliaria", navTab: null, titulo: "Datos de la inmobiliaria" },
  { path: "/actividades", clave: "actividades", panel: "panel-actividades", boton: "btn-abrir-actividades", navTab: null, titulo: "Actividades" },
  { path: "/auditoria", clave: "auditoria", panel: "panel-auditoria", boton: "btn-abrir-auditoria", navTab: null, titulo: "Auditoría" },
  { path: "/ia", clave: "ia", panel: "panel-ia", boton: "btn-abrir-ia", navTab: null, titulo: "Inteligencia Artificial" }
];

const RUTA_MAPA = RUTAS[0];

// Prefijo de la página pública de un lote: /lote/<id>. Es la única ruta
// con una parte variable, y por eso no puede estar en la tabla de
// arriba, que compara por igualdad.
//
// POR QUÉ UNA RUTA PROPIA Y NO "?lote=". El "?lote=" abre la ficha de
// trabajo sobre el mapa, que es la pantalla del corredor. Esta otra es
// la página pública, la que se le manda al comprador: tiene que tener
// una dirección que se lea como la dirección de una propiedad, no como
// un parámetro pegado al mapa.
export const PREFIJO_LOTE_PUBLICO = "/lote/";

export function idDeLotePublico(path) {
  if (!path.startsWith(PREFIJO_LOTE_PUBLICO)) return null;
  const id = path.slice(PREFIJO_LOTE_PUBLICO.length).split("/")[0];
  return id || null;
}

// Direcciones viejas que siguen andando. "Favoritos" se llama
// "Apartados" desde 2026-09-22, pero alguien puede tenerla guardada en
// el navegador o habérsela mandado por mensaje: que un link guardado
// deje de funcionar es una forma barata de perder a un usuario.
const RUTAS_VIEJAS = { "/favoritos": "/apartados" };

export function rutaPorPath(path) {
  const renombrada = RUTAS_VIEJAS[path];
  if (renombrada) path = renombrada;

  const exacta = RUTAS.find((r) => r.path === path);
  if (exacta) return exacta;

  // La página pública de un lote: misma forma que una ruta de la tabla,
  // armada al vuelo con el id que trae la URL. El título se completa
  // después, cuando se sabe de qué lote se trata (js/lote-publico.js).
  const id = idDeLotePublico(path);
  if (id) {
    return {
      path,
      clave: "lote-publico",
      panel: "panel-lote-publico",
      boton: null,
      navTab: null,
      titulo: "Lote",
      loteId: id
    };
  }
  return null;
}

// El nombre que se muestra en la pestaña. Arranca en "MojonApp" y lo
// reemplaza el de la inmobiliaria en cuanto se lee (ver
// ponerNombreDeLaApp, que llama app.js).
//
// Esto vive acá y no en js/inmobiliaria.js para que el router siga sin
// importar nada de la app: es la capa de abajo. Recibe el nombre, no lo
// va a buscar.
let nombreDeLaApp = "MojonApp";
let ultimaRuta = null;

function refrescarTitulo() {
  if (!ultimaRuta) return;
  document.title = ultimaRuta.clave === "mapa" ? nombreDeLaApp : `${ultimaRuta.titulo} — ${nombreDeLaApp}`;
}

export function ponerNombreDeLaApp(nombre) {
  nombreDeLaApp = nombre || "MojonApp";
  refrescarTitulo();
}

/**
 * Le cambia el título a la sección en la que estamos.
 *
 * Existe porque hay una pantalla cuyo título no se sabe hasta que
 * llegan los datos: la página pública de un lote, que en la tabla de
 * rutas figura como "Lote" y en la pestaña tiene que decir "Manzana 3 —
 * Lote 7". Esa pantalla escribía document.title por su cuenta, y
 * cualquier refrescarTitulo() posterior —por ejemplo el que dispara el
 * nombre de la inmobiliaria cuando termina de leerse— se lo pisaba con
 * el genérico. El resultado era una pestaña que decía "Lote" a secas,
 * que es lo que ve alguien a quien le compartieron la propiedad.
 *
 * Se copia la ruta en vez de mutarla: las de la tabla son compartidas y
 * mutarlas dejaría el título pegado para la próxima visita.
 */
export function ponerTituloDeLaSeccion(titulo) {
  if (!ultimaRuta || !titulo) return;
  ultimaRuta = { ...ultimaRuta, titulo };
  refrescarTitulo();
}

// Posición dentro del historial DE LA APP. Se guarda en el propio
// history.state de cada entrada (no como un contador suelto) para que
// siga siendo correcta cuando el usuario va y viene con atrás/adelante:
// un contador se desincronizaba al avanzar, y la flecha "volver" podía
// creer que no había a dónde volver.
//
// Para qué sirve: si vale 0 es que se entró directo por una URL (por
// ejemplo /contactos desde un favorito del navegador) y no hay "atrás"
// propio — la flecha tiene que llevar al mapa y no sacar del sistema.
let indiceEnHistorial = 0;

// Se apaga mientras la navegación viene del historial (popstate) o de la
// carga inicial: en esos dos casos la URL ya es la correcta y pushear
// otra entrada duplicaría el historial.
let pusheando = true;

// Quién quiere enterarse de cada navegación. Lo usa la página pública de
// un lote, que no tiene botón en el menú que la abra: se dibuja cuando
// el router entra en su ruta.
//
// Es una suscripción y no un import al revés a propósito: router.js es
// la capa de abajo y no conoce ningún módulo de la app.
const suscriptores = [];

export function onRutaAplicada(callback) {
  suscriptores.push(callback);
}

// ---------------------------------------------------------------------------

function ocultarPantallasGrandes() {
  document.querySelectorAll(".panel-pantalla-completa").forEach((panel) => {
    panel.classList.add("oculto");
  });
}

function marcarEnElMenu(ruta) {
  document.querySelectorAll("[data-ruta]").forEach((el) => {
    el.classList.remove("ruta-activa");
    el.removeAttribute("aria-current");
  });
  document.querySelectorAll(".menu-modulo").forEach((el) => el.classList.remove("ruta-activa"));

  // SOLO el botón que la tabla de rutas declara como dueño de la
  // sección, más su pestaña en #nav-secciones.
  //
  // Antes se marcaban TODOS los elementos con ese data-ruta, y eso
  // estaba mal: hay seis botones con data-ruta="/" porque son acciones
  // que ocurren sobre el mapa ("Cargar a mano", "Agregar manzana",
  // "Ver catastro cercano"...), no secciones. Con el menú contraído como
  // rail no se notaba; con la barra lateral siempre desplegada del
  // rediseño quedaron seis ítems iluminados a la vez, como si estuvieras
  // en seis lugares al mismo tiempo.
  //
  // El dueño de cada sección es ruta.boton: la misma tabla que ya decide
  // qué panel abrir. Un solo lugar donde se declara la verdad.
  // Solo el botón del menú, NO la pestaña de #nav-secciones: esas
  // pestañas tienen su propia clase "activo", que maneja
  // sincronizarSeccionMapa en app.js. Marcarlas también con
  // "ruta-activa" les dejaba dos clases de estado para lo mismo — y
  // rompía el test que compara la lista de clases exacta.
  const propios = [document.getElementById(ruta.boton)].filter(Boolean);
  propios.forEach((el) => {
    el.classList.add("ruta-activa");
    el.setAttribute("aria-current", "page");
    // El módulo que contiene al ítem queda marcado también: es lo único
    // que se ve cuando el menú está contraído como rail de íconos.
    el.closest(".menu-modulo")?.classList.add("ruta-activa");
  });
}

// El estado que el router garantiza en CADA navegación, sin importar por
// dónde entró (click en el menú, URL directa, "atrás", o navegarA desde
// otro módulo). Lo único que NO hace es abrir la pantalla destino: de eso
// se encarga el handler que ya existía para ese botón.
function aplicarEstado(ruta) {
  ocultarPantallasGrandes();

  // Lo que flota sobre el mapa (el botón "+" de carga y catastro, y los
  // avisos de "ocultar catastro"/"ocultar interés") existe SOLO en la
  // vista mapa. Pedido del usuario del 2026-09-18: fuera del mapa esos
  // controles no tienen sobre qué actuar, y encima quedan tapando el
  // contenido de la pantalla en la que sí estás.
  //
  // Se marca en el <body> y lo esconde el CSS, en vez de tocar cada
  // elemento acá: así sumar un flotante nuevo no obliga a acordarse de
  // agregarlo a esta lista.
  document.body.classList.toggle("en-el-mapa", ruta.path === "/");

  // La ficha de un lote es una hoja sobre el mapa: tiene sentido en el
  // mapa y en ninguna otra sección. (Antes cada panel la escondía por su
  // cuenta, o se olvidaba.)
  if (ruta.clave !== "mapa") {
    document.getElementById("ficha-lote").classList.add("oculto");
    // Y se saca el lote de la URL: si quedara "?lote=" estando en
    // /contactos, recargar ahí volvería a abrir una ficha que ya no está
    // en pantalla. La escritura del parámetro vive en js/ficha.js
    // (ponerElLoteEnLaUrl); acá solo se limpia, sin importar nada de
    // ese módulo — router.js es la capa de abajo y no importa nada de
    // la app.
    const url = new URL(location.href);
    if (url.searchParams.has("lote")) {
      url.searchParams.delete("lote");
      history.replaceState(history.state, "", url);
    }
  }

  document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("activo"));
  if (ruta.navTab) document.getElementById(ruta.navTab).classList.add("activo");

  // El nombre que va en la pestaña es el de la INMOBILIARIA, no el del
  // software. Es lo que ve el comprador cuando le llega el link y lo que
  // queda guardado si se lo agrega a favoritos.
  //
  // Se guarda la última ruta aplicada porque el nombre llega tarde: la
  // lectura de Firestore casi siempre termina después de que la pantalla
  // se dibujó, y sin esto la pestaña quedaría con "MojonApp" hasta la
  // próxima navegación. Cuando llega, refrescarTitulo() lo vuelve a
  // armar con la misma ruta.
  ultimaRuta = ruta;
  refrescarTitulo();

  for (const avisar of suscriptores) avisar(ruta);
  marcarEnElMenu(ruta);

  if (pusheando && location.pathname !== ruta.path) {
    indiceEnHistorial += 1;
    history.pushState({ path: ruta.path, i: indiceEnHistorial }, "", ruta.path);
  }
}

// ---------------------------------------------------------------------------
// Entradas al router
// ---------------------------------------------------------------------------

// Click en cualquier cosa con data-ruta. En CAPTURA a propósito: corre
// antes del handler propio del botón, así ese handler abre su pantalla
// sobre un tablero ya limpio (ver el comentario de arriba).
document.addEventListener(
  "click",
  (evento) => {
    // El target de un click puede no ser un Element (y el ícono SVG de un
    // botón sí lo es, pero no es el botón) — closest resuelve las dos cosas.
    if (!(evento.target instanceof Element)) return;
    const boton = evento.target.closest("[data-ruta]");
    if (!boton) return;
    const ruta = rutaPorPath(boton.dataset.ruta);
    if (ruta) aplicarEstado(ruta);
  },
  true
);

// La flecha "volver" de cada pantalla (antes era una × de "cerrar").
// Ahora que hay URLs, volver es literalmente el "atrás" del navegador:
// desde Contactos abierto desde el Dashboard, la flecha devuelve al
// Dashboard y no al mapa. stopImmediatePropagation corta el handler
// viejo de "cerrar este panel": el panel se va a esconder igual, pero
// por la navegación (popstate -> aplicarEstado), que además deja la URL
// y el menú en su lugar.
document.addEventListener(
  "click",
  (evento) => {
    if (!(evento.target instanceof Element)) return;
    // El botón puede declarar a dónde ir cuando NO hay historial propio
    // (data-volver="/lotes"). Sin valor sigue siendo el mapa, que es lo
    // correcto para las pantallas del corredor.
    const boton = evento.target.closest("[data-volver]");
    if (!boton) return;
    evento.stopImmediatePropagation();
    evento.preventDefault();
    volverAtras(boton.dataset.volver || "/");
  },
  true
);

// Para quien va a abrir la pantalla él mismo y solo necesita el resto
// del estado (esconder las otras secciones, la URL, el título, el ítem
// marcado en el menú). Lo usa abrirContactoEnCrm en crm.js, que tiene
// que esperar (await) a que el CRM termine de cargar para recién
// entonces abrir el formulario de un contacto puntual — con navegarA no
// podría, porque un click no se puede esperar.
export function aplicarRuta(path) {
  const ruta = rutaPorPath(path);
  if (ruta) aplicarEstado(ruta);
}

export function volverAtras(sinHistorial = "/") {
  if (indiceEnHistorial > 0) {
    history.back();
    return;
  }
  // Se entró directo por URL: no hay "atrás" dentro de la app, así que
  // "volver" es ir al mapa (y no salir del sistema, que es justamente lo
  // que el usuario pidió que dejara de pasar). Salvo que la pantalla
  // declare otro destino: la página pública de un lote manda al catálogo
  // público, porque quien llegó por un link de WhatsApp no tiene nada
  // que hacer en el mapa interno de toda la zona.
  navegarA(sinHistorial);
}

// Navegación desde código (no desde un click del usuario): dispara el
// mismo botón del menú que ya sabía abrir esa pantalla, que es el patrón
// que la app ya usaba para los íconos de módulo en app.js. El click pasa
// por el listener de captura de arriba, así que la URL, el título y el
// menú se actualizan solos.
export function navegarA(path) {
  const ruta = rutaPorPath(path);
  if (!ruta) return;
  const boton = document.getElementById(ruta.boton);
  // La ruta del mapa no tiene panel que abrir: alcanza con aplicar el
  // estado (deja #nav-tab-mapa activo, y de ahí sincronizarSeccionMapa
  // muestra el mapa y le llama invalidateSize).
  if (ruta.clave === "mapa" || !boton) {
    aplicarEstado(ruta);
    return;
  }
  boton.click();
}

window.addEventListener("popstate", (evento) => {
  const ruta = rutaPorPath(evento.state?.path || location.pathname) || RUTA_MAPA;
  // La posición viene de la entrada a la que se llegó, así que queda
  // bien tanto yendo atrás como adelante.
  indiceEnHistorial = evento.state?.i ?? 0;
  pusheando = false;
  navegarA(ruta.path);
  pusheando = true;
});

// ¿Se puede entrar a esta sección ahora mismo? El botón del menú está
// oculto cuando falta el permiso (o cuando no hay sesión) — ver
// actualizarUIPorPermisos en app.js. Se chequea el botón Y sus
// contenedores, porque varios grupos del menú se ocultan enteros
// (#drawer-grupo-seguridad, #drawer-grupo-catalogos-crm, los bloques
// .solo-con-sesion).
function rutaDisponible(ruta) {
  if (ruta.clave === "mapa") return true;
  // La página pública de un lote no cuelga de ningún botón del menú: es
  // una dirección que se comparte, y tiene que abrirse para cualquiera,
  // igual que el mapa. Sin esto, entrar por el link caía al mapa.
  if (ruta.clave === "lote-publico") return true;
  const boton = document.getElementById(ruta.boton);
  if (!boton) return false;
  // Se sube hasta #drawer-menu SIN incluirlo: ese elemento también usa
  // .oculto, pero ahí significa "el menú está cerrado" (sin sesión, o en
  // celular), no "esta sección está prohibida". Con closest(".oculto")
  // a secas, /lotes y /favoritos —que son públicas— quedaban marcadas
  // como no disponibles y un visitante anónimo que entraba por esa URL
  // terminaba viendo el mapa.
  for (let el = boton; el && el.id !== "drawer-menu"; el = el.parentElement) {
    if (el.classList.contains("oculto")) return false;
  }
  return true;
}

// Arranque: resuelve la URL con la que se abrió la app.
//
// Se llama DOS veces a propósito. Primero al cargar, sin sesión resuelta
// todavía (así /lotes o /favoritos, que son públicos, andan de una). Y de
// nuevo desde onAuthStateChanged, cuando ya se sabe qué permisos hay:
// recién ahí se puede entrar a /contactos o /usuarios.
//
// `fallback` es a dónde ir si la URL no lleva a ninguna sección.
// `corregirUrl` solo se activa en la segunda pasada: en la primera, una
// URL que todavía no está disponible se deja INTACTA (se muestra el
// fallback nomás) — si se corrigiera ahí, alguien que abre /contactos
// directo desde un favorito del navegador perdería su destino en el
// instante que tarda Firebase en resolver la sesión.
export function entrarEnLaRutaDeLaUrl(fallback = "/", corregirUrl = false) {
  const ruta = rutaPorPath(location.pathname);
  pusheando = false;
  try {
    if (ruta && rutaDisponible(ruta)) {
      // replaceState y no pushState: es la entrada con la que se abrió la
      // app, no un paso más en el historial. Se conserva location.search
      // porque ahí viajan los deep links que ya existían ("?lote=" de
      // "Compartir este lote" y "?vista=lista" de "Compartir el filtro").
      history.replaceState({ path: ruta.path, i: indiceEnHistorial }, "", ruta.path + location.search);
      navegarA(ruta.path);
      return ruta;
    }
    const destino = rutaPorPath(fallback) || RUTA_MAPA;
    if (!ruta || corregirUrl) {
      history.replaceState({ path: destino.path, i: indiceEnHistorial }, "", destino.path + location.search);
    }
    navegarA(destino.path);
    return destino;
  } finally {
    pusheando = true;
  }
}
