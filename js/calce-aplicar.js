// ---------------------------------------------------------------------------
// Aplica el calce de la foto satelital: lee la corrección de la zona y
// corre la capa de la imagen.
//
// Lo usan los DOS mapas: el principal (js/mapa.js) y el chico de la
// página pública de un lote (js/lote-publico.js). Está separado del
// panel de edición a propósito — un comprador que abre el link tiene que
// ver la foto ya calzada sin que se cargue nada del modo de calibración.
//
// Las decisiones (celda, metros a píxeles, qué valor es válido) viven en
// js/calce-imagen.js, sin Leaflet ni Firestore, con sus propios tests.
// Acá está solo el pegamento.
// ---------------------------------------------------------------------------

import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { celdaDe, corrimientoEnPixeles, corrimientoValido } from "./calce-imagen.js";

export const COLECCION_CALCES = "calces_imagen";

// Un tile de más por lado. Correr la capa de la foto deja descubierta
// una franja del ancho de la corrección en el borde contrario: se ve una
// banda gris sin imagen, que parece un error de la app. Lo agarró una
// captura, no un test — los tests miden dónde quedó la foto, no qué
// quedó sin foto.
//
// Con este margen Leaflet carga tiles alrededor de lo visible, así que
// al correr la capa aparece imagen de verdad. 256 px cubre el
// corrimiento máximo (60 m) hasta zoom 20, más allá del cual la imagen
// ya está muy agrandada. El costo son unas pocas tiles más por vista,
// que además sirven al arrastrar el mapa.
const MARGEN_DE_TILES = 256;

/**
 * La capa de la foto, que carga un poco más allá de lo visible.
 *
 * Es la capa de tiles de siempre con UNA cosa cambiada: pide las tiles
 * de un área más grande que la pantalla. Nada más. La corrección se
 * sigue aplicando moviendo el pane (ver moverLaFoto), que es lo simple
 * de entender y de probar.
 */
export function capaConMargen(url, opciones) {
  const ConMargen = L.TileLayer.extend({
    _getTiledPixelBounds(centro) {
      const limites = L.TileLayer.prototype._getTiledPixelBounds.call(this, centro);
      return new L.Bounds(
        limites.min.subtract([MARGEN_DE_TILES, MARGEN_DE_TILES]),
        limites.max.add([MARGEN_DE_TILES, MARGEN_DE_TILES])
      );
    }
  });
  return new ConMargen(url, opciones);
}

// Celda → corrección (o null si esa celda no está calibrada). Se cachea
// por sesión: son datos que cambian cuando alguien calibra a mano, o sea
// casi nunca, y sin caché cada arrastre del mapa sería una lectura.
const cache = new Map();

async function calceDeLaCelda(celda) {
  if (!celda) return null;
  if (cache.has(celda)) return cache.get(celda);

  let valor = null;
  try {
    const snapshot = await getDoc(doc(db, COLECCION_CALCES, celda));
    if (snapshot.exists()) valor = corrimientoValido(snapshot.data());
  } catch {
    // Sin conexión, o reglas que no dejan leer: la foto queda sin
    // corregir, que es exactamente como estaba antes de esta feature.
    // No se avisa nada porque no hay nada que la persona pueda hacer, y
    // un cartel de error sobre el mapa por algo cosmético molesta más
    // de lo que ayuda.
    valor = null;
  }
  cache.set(celda, valor);
  return valor;
}

/** Para después de guardar: que la próxima lectura traiga lo nuevo. */
export function olvidarCalceDe(celda) {
  cache.delete(celda);
}

export function guardarEnCache(celda, corrimiento) {
  cache.set(celda, corrimiento);
}

/**
 * Mueve la capa de la foto los píxeles que corresponda.
 *
 * Se toca el transform del pane y no la posición de la capa: el pane es
 * un contenedor propio que solo tiene la imagen (ver PANE_FOTO en
 * js/mapa.js), así que todo lo dibujado —lotes, parcelas del catastro,
 * marcadores— se queda quieto. Eso es lo único que no puede fallar: la
 * corrección es para que la foto coincida con los datos, nunca al revés.
 */
export function moverLaFoto(mapa, nombreDelPane, corrimiento) {
  const pane = mapa.getPane(nombreDelPane);
  if (!pane) return;
  if (!corrimiento) {
    pane.style.transform = "";
    pane.dataset.calce = "";
    return;
  }
  const centro = mapa.getCenter();
  const { x, y } = corrimientoEnPixeles(corrimiento, centro.lat, mapa.getZoom());
  pane.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  // Para los tests y para poder mirarlo desde la consola sin desarmar
  // el transform a mano.
  pane.dataset.calce = `${corrimiento.este_m},${corrimiento.norte_m}`;
}

/**
 * Deja la foto calzada y la mantiene así mientras el mapa se mueve.
 *
 * Se re-aplica en cada zoom porque la corrección está en METROS y lo que
 * se mueve son píxeles: un metro son cuatro veces más píxeles dos zooms
 * más cerca. Sin esto el calce se vería bien solo en el zoom en que se
 * hizo — y se rompería justo al acercarse, que es cuando se mira.
 *
 * Y se vuelve a leer al cambiar de celda, porque el corrimiento no es el
 * mismo en cada pueblo: el mosaico satelital está armado con capturas
 * distintas.
 */
export function seguirElCalce(mapa, nombreDelPane) {
  let celdaActual = null;
  let corrimientoActual = null;

  // Lo que se está probando en el panel de calibración, mientras está
  // abierto. Tiene prioridad sobre lo guardado: si no la tuviera, mover
  // el mapa un poco para ver mejor —que es justo lo que uno hace
  // calzando a ojo— borraría el ajuste en curso y habría que empezar de
  // nuevo. Lo encontró un test que movía el zoom después de correr la
  // foto y la encontraba en su lugar original.
  let enPrueba = null;
  let probando = false;

  async function revisar() {
    const centro = mapa.getCenter();
    const celda = celdaDe(centro.lat, centro.lng);
    if (celda !== celdaActual) {
      celdaActual = celda;
      corrimientoActual = await calceDeLaCelda(celda);
      // Mientras se esperaba la lectura el mapa pudo irse a otra celda:
      // aplicar esto ahora pondría la corrección de un lugar en otro.
      if (celdaDe(mapa.getCenter().lat, mapa.getCenter().lng) !== celda) return;
    }
    moverLaFoto(mapa, nombreDelPane, probando ? enPrueba : corrimientoActual);
  }

  mapa.on("moveend", revisar);
  mapa.on("zoomend", revisar);
  revisar();

  // Para que el panel de calibración pueda mostrar en vivo lo que se
  // está probando, y volver a lo guardado al salir.
  return {
    verEnVivo: (corrimiento) => {
      probando = true;
      enPrueba = corrimiento;
      moverLaFoto(mapa, nombreDelPane, corrimiento);
    },
    volverALoGuardado: () => {
      probando = false;
      enPrueba = null;
      return revisar();
    },
    // Después de guardar. Sin esto, revisar() ve que la celda no cambió
    // y no vuelve a leer, así que el mapa seguiría mostrando el valor
    // viejo hasta que te fueras de la zona y volvieras.
    yaEstaGuardado: (corrimiento) => {
      probando = false;
      enPrueba = null;
      corrimientoActual = corrimiento;
      moverLaFoto(mapa, nombreDelPane, corrimiento);
    },
    celda: () => celdaDe(mapa.getCenter().lat, mapa.getCenter().lng),
    guardado: () => corrimientoActual
  };
}
