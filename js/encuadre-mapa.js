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
// menos de dos píxeles: es indistinguible del suelo. Es el UMBRAL que
// decide si conviene enfocar un grupo en vez de alejarse.
export const ZOOM_MINIMO_ENCUADRE = 13;

// Y este es el zoom al que se ENFOCA ese grupo. Son dos números
// distintos, y confundirlos fue un bug: se enfocaba el grupo a zoom 13,
// o sea exactamente al zoom donde un lote mide dos píxeles. El mapa
// abría sobre la zona correcta y aun así no se veía ni un lote — motas
// de 5 a 15 px en escritorio, de 4x6 px en teléfono, imposibles de
// tocar con el dedo (el tamaño táctil recomendado es 44 px).
//
// LA CUENTA. La resolución de un mapa web es 156543 · cos(latitud) / 2^z
// metros por píxel. En San Luis (latitud -32,3; cos ≈ 0,845):
//   zoom 13 → 19,2 m/px → un lote de 30 m mide 1,6 px
//   zoom 16 →  2,4 m/px → 12 px
//   zoom 17 →  1,2 m/px → 25 px
//   zoom 18 →  0,6 m/px → 50 px
// Se elige 17: el lote se ve y se toca, y todavía entra alrededor el
// resto del grupo (medio kilómetro son unos 400 px).
export const ZOOM_AL_ENFOCAR_UN_GRUPO = 17;

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

/**
 * Cuánto hay que correr la vista cuando una hoja inferior tapa el mapa.
 *
 * EL PROBLEMA, EN PALABRAS DEL USUARIO: "que el mapa no se vaya tan
 * arriba sino que esté en el centro... eso hace perderte mucho".
 *
 * Centrar un lote con setView lo pone en el medio del CONTENEDOR, pero
 * la ficha y los formularios de carga son hojas que tapan desde abajo
 * hasta el 70% de la pantalla. O sea que el punto "centrado" queda
 * detrás de la hoja, y lo poco de mapa que se ve muestra todo corrido
 * hacia arriba. El corredor pierde la referencia justo cuando más la
 * necesita: mientras carga o mira un lote.
 *
 * La cuenta: si abajo hay C píxeles tapados, la franja visible va de 0 a
 * (H - C) y su centro está en (H - C) / 2. El punto está en H / 2, así
 * que hay que subirlo C / 2.
 *
 * @param altoCubierto píxeles tapados por la hoja abierta (0 si no hay)
 * @param altoContenedor alto total del mapa, para no pasarse
 * @returns píxeles a desplazar (0 si no hace falta mover nada)
 */
export function desplazamientoPorHojaAbierta(altoCubierto, altoContenedor) {
  if (!(altoCubierto > 0) || !(altoContenedor > 0)) return 0;
  // Si la hoja tapa todo, no hay franja visible que centrar: mover el
  // mapa no arreglaría nada y dejaría el punto fuera de pantalla.
  if (altoCubierto >= altoContenedor) return 0;
  return Math.round(altoCubierto / 2);
}
