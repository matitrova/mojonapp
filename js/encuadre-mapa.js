// ---------------------------------------------------------------------------
// Cómo encuadrar el mapa cuando los lotes están lejos entre sí.
//
// El encuadre por defecto es "que entren todos" (el fitBounds de
// mapa.js). Funciona bien con una cartera concentrada —los 108 lotes
// reales de producción están todos en la misma ciudad— y falla cuando no
// lo está: con lotes en tres localidades separadas por decenas de
// kilómetros, el mapa se aleja hasta cubrirlas todas y cada lote queda
// del tamaño de un punto.
//
// Pasó de verdad, y por eso existe este archivo: la cartera de
// demostración tiene lotes en Potrero de los Funes, El Trapiche y
// Carpintería. Al abrir la vista previa había 17 polígonos dibujados en
// pantalla y ninguno visible. El mapa parecía roto y no lo estaba.
//
// LA REGLA. Si para que entren todos hay que alejarse más allá de
// ZOOM_MINIMO_ENCUADRE, se enfoca el grupo más numeroso en vez de
// alejarse: se ve una zona con lotes de verdad en lugar de una provincia
// vacía. El costo está aceptado a propósito: al entrar no se ven los
// lotes de las otras zonas, quedan a un zoom out de distancia.
//
// POR QUÉ ESTÁ SEPARADO DE mapa.js. Acá no hay efectos ni se importa
// Leaflet, así que la decisión se puede testear sin un mapa de verdad —
// y un mapa de verdad, en un test, es justo la parte difícil: necesita
// un contenedor con tamaño real, y cuando no lo tiene Leaflet calcula
// cualquier cosa (ver el comentario del maxZoom en mapa.js).
// ---------------------------------------------------------------------------

// Por debajo de este zoom un lote de 1000 m² —unos 30 m de lado— mide
// menos de dos píxeles: es indistinguible del suelo.
export const ZOOM_MINIMO_ENCUADRE = 13;

// Lado de la celda con la que se agrupan los lotes, en grados. 0,05° son
// unos 5 km: la distancia a la que dos loteos ya se leen como dos
// manchas separadas y no como una sola.
export const LADO_CELDA_GRADOS = 0.05;

/**
 * Centro del grupo más numeroso de lotes.
 *
 * Agrupa por celdas de LADO_CELDA_GRADOS y devuelve el promedio de los
 * centros de la celda con más lotes. Es una grilla y no un clustering de
 * verdad porque lo único que hace falta es elegir un centro razonable,
 * no dibujar grupos en pantalla — eso sería otra feature.
 *
 * @param centros lista de {lat, lng} (el centro de cada lote)
 * @returns [lat, lng] o null si la lista está vacía
 */
export function centroDelGrupoMasNumeroso(centros) {
  const celdas = new Map();
  for (const centro of centros) {
    const clave =
      Math.round(centro.lat / LADO_CELDA_GRADOS) + "|" + Math.round(centro.lng / LADO_CELDA_GRADOS);
    const celda = celdas.get(clave) || { lat: 0, lng: 0, cuenta: 0 };
    celda.lat += centro.lat;
    celda.lng += centro.lng;
    celda.cuenta += 1;
    celdas.set(clave, celda);
  }
  let mejor = null;
  // Ante un empate gana el primero, o sea el grupo que aparece primero
  // en la lista de lotes. Es arbitrario pero determinista: el mapa abre
  // siempre en el mismo lugar y no salta de zona entre recargas.
  for (const celda of celdas.values()) {
    if (!mejor || celda.cuenta > mejor.cuenta) mejor = celda;
  }
  return mejor ? [mejor.lat / mejor.cuenta, mejor.lng / mejor.cuenta] : null;
}

/**
 * ¿Hay que enfocar un grupo en vez de encuadrar todo?
 *
 * @param zoomQueEntraTodo el zoom que necesitaría fitBounds
 */
export function convieneEnfocarUnGrupo(zoomQueEntraTodo) {
  return zoomQueEntraTodo < ZOOM_MINIMO_ENCUADRE;
}
