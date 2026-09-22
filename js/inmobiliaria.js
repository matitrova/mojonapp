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

/**
 * Lee el documento una vez por carga de página.
 *
 * NUNCA TIRA. Si falla (sin conexión, reglas viejas sin esta colección)
 * devuelve null y la app sigue mostrando "MojonApp": que no esté el
 * logo no puede dejar al comprador sin ver el lote.
 */
export function cargarInmobiliaria() {
  if (leyendo) return leyendo;
  leyendo = getDoc(doc(db, COLECCION, DOCUMENTO))
    .then((snap) => {
      cache = snap.exists() ? normalizarInmobiliaria(snap.data()) : null;
      avisar();
      return cache;
    })
    .catch(() => {
      cache = null;
      avisar();
      return null;
    });
  return leyendo;
}

/**
 * Vuelve a leer, ignorando lo que ya estaba.
 *
 * Solo la usa la pantalla de configuración al abrirse: ahí sí importa
 * ver lo que está guardado de verdad (alguien pudo haberlo cambiado
 * desde otra sesión), y es una pantalla a la que entra root de vez en
 * cuando. En el resto de la app vale lo cacheado — una lectura por
 * carga de página y listo.
 */
export function recargarInmobiliaria() {
  leyendo = null;
  return cargarInmobiliaria();
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
 * Reusa linkWhatsapp del CRM en vez de armar el wa.me a mano: ahí ya
 * está resuelto el formato argentino (con y sin 0, con y sin 15), que es
 * donde se pierden los mensajes.
 */
export function whatsappDeLaInmobiliaria(mensaje) {
  if (!puedeRecibirWhatsapp(cache)) return null;
  return linkWhatsapp(cache.telefono, mensaje);
}
