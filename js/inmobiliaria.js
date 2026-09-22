// ---------------------------------------------------------------------------
// Los datos de la inmobiliaria, leídos y guardados en Firestore.
//
// UN SOLO DOCUMENTO: configuracion/inmobiliaria. No es una colección
// porque no hay varias inmobiliarias — cada instalación de MojonApp es
// de una, y un id fijo hace que leerlo cueste UNA lectura de Firestore
// por carga de página en vez de una consulta.
//
// LECTURA ABIERTA, ESCRITURA SOLO DE ROOT (ver firestore.rules). Abierta
// porque la página pública de un lote la ve un comprador sin cuenta, y
// es justo la pantalla donde estos datos importan. Solo root escribe
// porque el teléfono al que llegan las consultas de TODA la agencia no
// lo cambia un corredor cualquiera: es el equivalente a cambiarle el
// cartel a la oficina.
//
// Las decisiones (qué es válido, cómo se muestra) viven en
// js/inmobiliaria-datos.js, que se prueba sin Firestore.
// ---------------------------------------------------------------------------

import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { normalizarInmobiliaria, nombreParaMostrar, puedeRecibirWhatsapp } from "./inmobiliaria-datos.js";
import { linkWhatsapp } from "./crm-metricas.js";

const COLECCION = "configuracion";
const DOCUMENTO = "inmobiliaria";

// Lo último que se leyó (o guardó). null = todavía no se configuró, o no
// se pudo leer; para quien dibuja son el mismo caso, y a propósito: la
// página del comprador tiene que verse bien igual.
let cache = null;

// La lectura en curso. Sin esto, el arranque dispara varias: la página
// pública, el título de la pestaña y el panel piden lo mismo al mismo
// tiempo, y cada pedido es una lectura de Firestore que se factura. Este
// proyecto ya viene chocando contra la cuota gratuita.
let leyendo = null;

const suscriptores = [];

/**
 * Avisa cada vez que los datos cambian (al leerlos y al guardarlos).
 *
 * Es lo que hace que el título de la pestaña y la página pública no
 * queden con el nombre viejo: la lectura es asíncrona y casi siempre
 * termina DESPUÉS de que la pantalla ya se dibujó. Es exactamente la
 * misma forma en que se arreglaron los permisos de la ficha.
 */
export function alCambiarLaInmobiliaria(fn) {
  suscriptores.push(fn);
  // Si ya hay datos, el suscriptor nuevo los recibe enseguida: no tiene
  // por qué esperar al próximo cambio para pintarse bien.
  if (cache) fn(cache);
}

function avisar() {
  for (const fn of suscriptores) {
    try {
      fn(cache);
    } catch {
      // Un suscriptor roto no puede impedir que se enteren los demás.
    }
  }
}

function leerDelServidor() {
  return getDoc(doc(db, COLECCION, DOCUMENTO)).then((snap) => {
    cache = snap.exists() ? normalizarInmobiliaria(snap.data()) : null;
    avisar();
    return cache;
  });
}

/**
 * Lee el documento una vez por carga de página. NUNCA TIRA.
 *
 * Si falla (sin conexión, reglas todavía sin publicar) devuelve lo
 * último que se supo —o null si nunca se supo nada— y la app sigue
 * andando: que no esté el logo no puede dejar al comprador sin ver el
 * lote.
 *
 * UN FALLO NO BORRA EL CACHE. Antes el catch hacía cache = null aunque
 * ya hubiera datos buenos leídos, y de ahí salía una cadena fea: la
 * pantalla de configuración mostraba los nueve campos vacíos, root
 * retipeaba el nombre, guardaba —setDoc reemplaza el documento entero—
 * y el teléfono al que llegan las consultas desaparecía.
 *
 * HONESTIDAD SOBRE ESA CADENA: no se pudo reproducir. Para que arranque
 * hace falta que getDoc RECHACE, y el SDK casi nunca rechaza: si no hay
 * red reintenta, y si tiene el documento en memoria lo devuelve igual.
 * Se probó cortando la red, cortando Firestore y respondiéndole 403, y
 * en los tres casos la lectura se resolvió o quedó colgada, nunca
 * rechazada. Por eso NO hay un test de esto: un test que no puede
 * fallar es peor que no tenerlo. Queda el arreglo igual, porque es de
 * dos líneas y el daño, si alguna vez pasa, no se ve.
 *
 * Tampoco queda marcada como "ya leída": un intento posterior vuelve a
 * probar en vez de quedarse pegado al fallo para toda la sesión.
 */
export function cargarInmobiliaria() {
  if (leyendo) return leyendo;
  leyendo = leerDelServidor().catch(() => {
    leyendo = null;
    return cache;
  });
  return leyendo;
}

/**
 * Vuelve a leer ignorando lo que ya estaba. ESTA SÍ TIRA si no pudo.
 *
 * La usa solo la pantalla de configuración, que es la única que
 * necesita distinguir "no hay nada configurado" (devuelve null) de "no
 * pude leer" (tira). Para todo lo demás son el mismo caso y por eso
 * cargarInmobiliaria los une; acá no, porque confundirlos es
 * exactamente cómo se borraban los datos.
 *
 * Se recarga —y no se usa lo cacheado— porque alguien pudo haberlo
 * cambiado desde otra sesión, y es una pantalla a la que root entra de
 * vez en cuando: una lectura de más ahí no mueve la aguja de la cuota.
 */
export function recargarInmobiliaria() {
  leyendo = null;
  const lectura = leerDelServidor();
  // Quien pida cargarInmobiliaria mientras esta viaja comparte el mismo
  // pedido, pero envuelto: a ese no le llega el error.
  leyendo = lectura.catch(() => {
    leyendo = null;
    return cache;
  });
  return lectura;
}

/** Lo que ya se leyó, sin esperar. null mientras no haya llegado. */
export function getInmobiliaria() {
  return cache;
}

/**
 * Guarda los datos ya validados. Deja el cache al día y avisa, así la
 * pestaña y la página pública se actualizan sin recargar.
 *
 * Esta sí propaga el error: quien la llama es el formulario, y ahí un
 * fallo tiene que verse — al revés que en la lectura.
 */
export async function guardarInmobiliaria(datos) {
  await setDoc(doc(db, COLECCION, DOCUMENTO), datos);
  cache = normalizarInmobiliaria(datos);
  // Una escritura deja el documento al día, así que una lectura
  // posterior no aportaría nada: se marca como ya leído.
  leyendo = Promise.resolve(cache);
  avisar();
  return cache;
}

/** El nombre para títulos y pestañas, con lo que haya en este momento. */
export function nombreDeLaInmobiliaria() {
  return nombreParaMostrar(cache);
}

/**
 * El link de WhatsApp a la inmobiliaria, o null si no hay teléfono.
 *
 * Reusa linkWhatsapp del CRM en vez de armar el wa.me a mano: un solo
 * lugar arma el número para los tres botones que mandan WhatsApp.
 *
 * Cuando se escribió esto, esa función NO sacaba el 0 ni el 15 — o sea
 * que el número de la inmobiliaria escrito como lo escribe cualquiera
 * ("0266 15 455-8821") armaba un link roto. Se arregló ahí, así que el
 * CRM se benefició igual; ver normalizarTelefonoWhatsapp y
 * tests/test_whatsapp_numero.py.
 */
export function whatsappDeLaInmobiliaria(mensaje) {
  if (!puedeRecibirWhatsapp(cache)) return null;
  return linkWhatsapp(cache.telefono, mensaje);
}
