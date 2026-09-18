// ---------------------------------------------------------------------------
// El control para calzar la foto satelital con el catastro.
//
// POR QUÉ ES A MANO. La foto de Esri no coincide con el catastro: hasta
// 20-25 metros en algunas zonas de San Luis. Se intentó medir el
// corrimiento por registración de imagen y no se puede — en zona rural
// los bordes de la foto no corresponden a los límites de parcela (no hay
// alambrados, hay árboles tapando, los caminos de tierra tienen filo
// difuso), así que el mejor calce no se distingue del resto. Un ojo lo
// resuelve de un vistazo. Ver el comentario largo de js/calce-imagen.js.
//
// SE MUEVE LA FOTO, NUNCA LOS DATOS. Las parcelas son el dato legal del
// catastro provincial y los lotes cargados se dibujaron contra ellas.
// Moverlos para que se vean bien sobre un dibujo mal georreferenciado
// sería corromper lo bueno para disimular lo malo.
//
// SE GUARDA POR ZONA Y COMPARTIDO, no en el navegador: el corrimiento es
// una propiedad del lugar, no del dispositivo. Así se calza una vez y le
// queda a todo el equipo — y también a la página pública que ve un
// comprador, que es de lectura abierta.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import { doc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { comoTexto, conElPaso, corrimientoValido } from "./calce-imagen.js";
import { COLECCION_CALCES, guardarEnCache, olvidarCalceDe } from "./calce-aplicar.js";
import { esRootActual, tienePermiso } from "./permisos.js";

const elBoton = document.getElementById("btn-calzar-foto");
const elPanel = document.getElementById("panel-calce");
const elEstado = document.getElementById("calce-estado");
const elMensaje = document.getElementById("calce-mensaje");
const elGuardar = document.getElementById("calce-guardar");

// Lo inyecta js/mapa.js: el objeto que devuelve seguirElCalce, con el
// que se puede mostrar en vivo lo que se está probando y volver a lo
// guardado al salir. Por inyección y no por import para no crear un
// ciclo — mapa.js es quien crea el mapa.
let calce = null;
let enPrueba = null;

export function configurarCalce(seguimiento) {
  calce = seguimiento;
}

export function puedeCalzar() {
  return !!auth.currentUser && (esRootActual() || tienePermiso("administrar_sectores"));
}

/** El botón del flotante solo aparece si la persona puede guardar. */
export function actualizarBotonCalce() {
  elBoton.classList.toggle("oculto", !puedeCalzar());
}

function mostrarEstado() {
  elEstado.textContent = comoTexto(enPrueba || {});
}

function avisar(texto) {
  elMensaje.textContent = texto;
  elMensaje.classList.remove("oculto");
}

function abrir() {
  if (!calce) return;
  // Se arranca desde lo que ya está guardado para esta zona, no desde
  // cero: si alguien entra a retocar un calce existente, empezar en cero
  // le haría perder el trabajo anterior sin avisarle.
  enPrueba = { este_m: 0, norte_m: 0, ...(calce.guardado() || {}) };
  elPanel.classList.remove("oculto");
  elMensaje.classList.add("oculto");
  mostrarEstado();
}

function cerrar() {
  elPanel.classList.add("oculto");
  enPrueba = null;
  // Lo que quedó sin guardar se descarta: el mapa vuelve a mostrar lo
  // que está en la base. Si no, alguien podría seguir trabajando sobre
  // una corrección que cree guardada y no lo está.
  if (calce) calce.volverALoGuardado();
}

function mover(direccion) {
  if (!enPrueba || !calce) return;
  enPrueba = conElPaso(enPrueba, direccion);
  mostrarEstado();
  calce.verEnVivo(corrimientoValido(enPrueba));
}

elBoton.addEventListener("click", abrir);
document.getElementById("calce-cerrar").addEventListener("click", cerrar);

document.getElementById("calce-norte").addEventListener("click", () => mover("norte"));
document.getElementById("calce-sur").addEventListener("click", () => mover("sur"));
document.getElementById("calce-este").addEventListener("click", () => mover("este"));
document.getElementById("calce-oeste").addEventListener("click", () => mover("oeste"));

document.getElementById("calce-cero").addEventListener("click", () => {
  if (!calce) return;
  enPrueba = { este_m: 0, norte_m: 0 };
  mostrarEstado();
  calce.verEnVivo(null);
});

elGuardar.addEventListener("click", async () => {
  if (!calce || !enPrueba) return;
  const celda = calce.celda();
  if (!celda) return avisar("No se pudo determinar la zona. Movete un poco en el mapa.");

  const corrimiento = corrimientoValido(enPrueba);
  elGuardar.disabled = true;
  try {
    if (corrimiento) {
      await setDoc(doc(db, COLECCION_CALCES, celda), {
        ...corrimiento,
        // Quién y cuándo: si alguien encuentra un calce raro, tiene que
        // poder preguntarle a la persona que lo hizo en vez de adivinar.
        calibrado_por: auth.currentUser?.uid || null,
        calibrado_email: auth.currentUser?.email || null,
        fecha: serverTimestamp()
      });
      guardarEnCache(celda, corrimiento);
      calce.yaEstaGuardado(corrimiento);
      avisar(`Guardado para esta zona: ${comoTexto(corrimiento)}.`);
    } else {
      // Volver a cero es BORRAR el documento, no guardar ceros: así una
      // zona sin calibrar y una calibrada en cero son la misma cosa, y
      // no queda basura en la colección.
      await deleteDoc(doc(db, COLECCION_CALCES, celda));
      olvidarCalceDe(celda);
      guardarEnCache(celda, null);
      calce.yaEstaGuardado(null);
      avisar("Esta zona queda sin corrección.");
    }
  } catch {
    avisar("No se pudo guardar. Revisá la conexión o si tenés permiso.");
  } finally {
    elGuardar.disabled = false;
  }
});
