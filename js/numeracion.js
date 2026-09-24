// ---------------------------------------------------------------------------
// El número de cada contacto: #1, #2, #3…
//
// POR QUÉ NO ALCANZA CON EL ID QUE YA TIENE. Todo documento de Firestore
// trae uno (db8IRHh6GDfIsuU6rmX6), pero eso no se puede decir por
// teléfono ni anotar en un papel, y no distingue nada a simple vista.
// Pedido del dueño del producto: dos contactos que se llaman igual
// tienen que poder diferenciarse.
//
// POR QUÉ UN CONTADOR Y NO "EL MÁXIMO QUE TENGO CARGADO + 1". Dos
// corredores dando de alta al mismo tiempo sacarían el mismo número, y
// un número repetido no distingue nada — o sea que fallaría justo para
// lo que se está construyendo. Con una transacción sobre un documento
// contador eso no puede pasar: Firestore reintenta la que llegó segunda.
//
// EL CONTADOR NUNCA VUELVE PARA ATRÁS, tampoco al borrar un contacto. Si
// se reciclaran números, el "contacto 42" de una conversación de hace un
// mes sería otro hoy, que es peor que un hueco en la numeración.
// ---------------------------------------------------------------------------

import { db } from "./firebase-config.js";
import {
  doc,
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

export const COLECCION_CONTADORES = "contadores";
export const CONTADOR_CONTACTOS = "contactos";

/**
 * Reserva el próximo número y lo devuelve.
 *
 * Devuelve null si no se pudo (sin conexión, reglas sin publicar). Quien
 * llama tiene que poder seguir sin número: un contacto sin numerar es
 * molesto, un contacto que no se pudo guardar es un lead perdido. Esa es
 * la única razón por la que esto no tira.
 */
export async function siguienteNumeroDeContacto() {
  try {
    return await runTransaction(db, async (tx) => {
      const ref = doc(db, COLECCION_CONTADORES, CONTADOR_CONTACTOS);
      const snap = await tx.get(ref);
      // El primer contacto de la inmobiliaria es el 1, no el 0.
      const actual = snap.exists() ? Number(snap.data().valor) || 0 : 0;
      const siguiente = actual + 1;
      tx.set(ref, { valor: siguiente });
      return siguiente;
    });
  } catch {
    return null;
  }
}

/**
 * El número como se muestra: "#42".
 *
 * Un contacto sin número (los de antes de que esto existiera, o uno que
 * se creó sin conexión) devuelve cadena vacía en vez de "#" o "#null":
 * mejor no mostrar nada que mostrar algo roto.
 */
export function numeroParaMostrar(contacto) {
  const n = contacto?.numero;
  return Number.isFinite(n) && n > 0 ? `#${n}` : "";
}
