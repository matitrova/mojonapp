// ---------------------------------------------------------------------------
// Notas internas de un lote: la libreta del corredor ("el dueño acepta
// menos", "cuesta encontrarlo, doblar en el molino"). NO se publican.
//
// Antes esto vivía mezclado con la descripción en el campo "observaciones"
// del lote. Ese campo se mostraba en la ficha sin ningún control, y como
// la colección "lotes" es de lectura pública (allow read: if true, ver
// firestore.rules), las notas de trabajo eran legibles por cualquiera —
// tanto en la ficha como pidiéndole el documento a la API.
//
// Por eso viven en una subcolección y no en un campo más: es la única
// forma de que tengan su propia regla de Firestore. Ver el bloque
// lotes/{loteId}/privado/{docId} en firestore.rules.
//
// Este módulo existe para que la ruta ("privado" / "notas") esté escrita
// en UN solo lugar y no en los tres que la usan (ficha, alta y edición).
// ---------------------------------------------------------------------------

import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const SUBCOLECCION = "privado";
const DOCUMENTO = "notas";

function refNotas(loteId) {
  return doc(db, "lotes", loteId, SUBCOLECCION, DOCUMENTO);
}

// Devuelve el texto, o null si el lote no tiene notas / no se pudieron
// leer. Nunca tira: quien llama siempre puede seguir sin esto.
//
// Sin sesión, la regla de Firestore rechaza la lectura — por eso quien
// llama no debería ni intentarlo (ver actualizarNotasInternas en
// ficha.js), pero si igual pasa, acá se traga el error y devuelve null en
// vez de romper la ficha.
export async function leerNotasInternas(loteId) {
  try {
    const instantanea = await getDoc(refNotas(loteId));
    return instantanea.exists() ? instantanea.data().texto || null : null;
  } catch {
    return null;
  }
}

// Guardar vacío BORRA el documento en vez de dejarlo con un texto en
// blanco: así "no tiene notas" es siempre la misma cosa (el documento no
// existe) y no dos estados distintos que después hay que distinguir.
export async function guardarNotasInternas(loteId, texto) {
  const limpio = (texto || "").trim();
  if (!limpio) {
    try {
      await deleteDoc(refNotas(loteId));
    } catch {
      // Borrar algo que no existe no es un error que valga la pena
      // propagar: el estado final es el que se pedía.
    }
    return;
  }
  await setDoc(refNotas(loteId), { texto: limpio, fecha_actualizacion: new Date().toISOString() });
}
