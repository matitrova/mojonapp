// ---------------------------------------------------------------------------
// Estado mutable compartido por varias secciones de MojonApp a la vez.
//
// Un módulo ES no puede reasignar un binding importado de otro módulo
// (`import { x } from "./y.js"; x = 1` tira error) — por eso cada variable
// de acá se expone con un par get/set en vez de un `export let` directo:
// es la única forma de que dos secciones compartan una variable mutable
// de verdad una vez que viven en archivos separados.
//
// Solo vive acá el estado que cruza fronteras entre secciones (varias
// partes de la app lo leen y/o escriben). El estado exclusivo de una
// sección (por ejemplo `capaLotes` o `edicionPoligono`) se queda como
// variable local de su propio archivo cuando esa sección se separe — no
// tiene sentido pasarlo por acá si nada más lo toca.
// ---------------------------------------------------------------------------

// Feature GeoJSON del lote actualmente en la ficha — la variable de estado
// más transversal de toda la app: la leen la ficha, fotos, interesados,
// los editores inline de servicios/sector/barrio, el editor de forma,
// "Estoy yendo", "Cómo llegar", "Compartir" y el refresco de permisos al
// cambiar de sesión.
let lotePolyLayerSeleccionado = null;
export function getLoteSeleccionado() {
  return lotePolyLayerSeleccionado;
}
export function setLoteSeleccionado(v) {
  lotePolyLayerSeleccionado = v;
}

// Se actualiza en onAuthStateChanged; true con cualquier perfil logueado.
let corredorLogueado = false;
export function getCorredorLogueado() {
  return corredorLogueado;
}
export function setCorredorLogueado(v) {
  corredorLogueado = v;
}

// Perfil de seguridad del usuario logueado ({ es_root, permisos: {...} }),
// o null sin sesión. Se resuelve en onAuthStateChanged leyendo
// usuarios/{uid} -> perfiles/{perfil_id}. Root tiene vía libre en
// tienePermiso() sin necesidad de tildar cada permiso a mano.
let miPerfilActual = null;
export function getMiPerfil() {
  return miPerfilActual;
}
export function setMiPerfil(v) {
  miPerfilActual = v;
}

// Último resultado de cargarLotesDesdeFirestore — lo reusa la vista en
// lista y el dashboard sin volver a pedirle nada a Firestore.
let lotesActuales = [];
export function getLotesActuales() {
  return lotesActuales;
}
export function setLotesActuales(v) {
  lotesActuales = v;
}

// El "?lote=" de la URL solo se abre una vez, en la primera carga.
let deepLinkDeLoteAbierto = false;
export function getDeepLinkAbierto() {
  return deepLinkDeLoteAbierto;
}
export function setDeepLinkAbierto(v) {
  deepLinkDeLoteAbierto = v;
}

// Catálogo de zonas (colección "sectores"), alimenta los combos.
let sectoresActuales = [];
export function getSectoresActuales() {
  return sectoresActuales;
}
export function setSectoresActuales(v) {
  sectoresActuales = v;
}

// Catálogo de barrios (colección "barrios") — misma idea, categoría
// independiente de zona.
let barriosActuales = [];
export function getBarriosActuales() {
  return barriosActuales;
}
export function setBarriosActuales(v) {
  barriosActuales = v;
}

// Id de navigator.geolocation.watchPosition, para poder cancelarlo.
let watchId = null;
export function getWatchId() {
  return watchId;
}
export function setWatchId(v) {
  watchId = v;
}

// Referencia al handler de deviceorientation, para poder sacarlo.
let listenerOrientacion = null;
export function getListenerOrientacion() {
  return listenerOrientacion;
}
export function setListenerOrientacion(v) {
  listenerOrientacion = v;
}

// Semáforo compartido por 4 secciones sin relación entre sí (captura de
// vértices a mano, el editor de forma de un polígono, y los listeners de
// click de la capa de lotes y de las capas de catastro): "gps" | "mapa" |
// "editando-poligono" | null. Mientras no es null, esas secciones evitan
// reaccionar a clicks sobre el mapa que no les corresponden.
let modoCaptura = null;
export function getModoCaptura() {
  return modoCaptura;
}
export function setModoCaptura(v) {
  modoCaptura = v;
}

// true si se entró al formulario de edición completa desde "Editar lote"
// en la ficha del mapa, false si se entró desde "Editar" en la grilla —
// al guardar, determina si hay que volver al mapa (con la ficha
// actualizada) o a la lista, para no sacar al corredor de donde ya estaba.
let loteEditadoDesdeFicha = false;
export function getLoteEditadoDesdeFicha() {
  return loteEditadoDesdeFicha;
}
export function setLoteEditadoDesdeFicha(v) {
  loteEditadoDesdeFicha = v;
}

// Wrapper de conveniencia sobre el evento custom que ya usaba la app para
// avisar "se cerró la sesión" a las 7 secciones que necesitan apagar algo
// en ese momento (capturas en curso, edición de polígono abierta, catastro
// cercano prendido, etc.) — no reemplaza el mecanismo, solo le pone nombre.
export function emitirSesionCerrada() {
  window.dispatchEvent(new Event("mojonapp:sesion-cerrada"));
}
export function onSesionCerrada(callback) {
  window.addEventListener("mojonapp:sesion-cerrada", callback);
}
