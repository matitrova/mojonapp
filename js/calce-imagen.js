// ---------------------------------------------------------------------------
// Calce de la foto satelital: cuántos metros hay que correrla para que
// coincida con el catastro.
//
// POR QUÉ HACE FALTA. El catastro y la imagen satelital no coinciden.
// Verificado el 2026-09-18: las mismas parcelas dibujadas sobre
// OpenStreetMap calzan con la red de calles y sobre la foto de Esri
// quedan corridas, y el corrimiento llega a los 20-25 metros en algunas
// zonas. Para un lote de 30×30 eso es la mitad del frente.
//
// LO QUE ESTÁ MAL ES LA FOTO, NO EL CATASTRO, y por eso se corrige la
// foto. Las parcelas vienen del catastro provincial —es el dato legal y
// es el que el corredor usa para trabajar— y los lotes cargados se
// dibujaron contra ellas. Mover cualquiera de esos dos sería corromper
// datos buenos para que se vean bien sobre un dibujo malo.
//
// POR QUÉ SE CALZA A MANO Y NO SOLO. Se intentó medir el corrimiento por
// registración de imagen (buscar el desplazamiento que hace caer los
// límites del catastro sobre los bordes de la foto). No funciona acá: el
// mejor calce no se distingue del resto (pico chato, y resultados que se
// contradicen entre zonas), porque en zona rural los bordes de la foto
// no corresponden a los límites de parcela — no hay alambrados, hay
// árboles tapando y los caminos de tierra tienen filo difuso. Un ojo
// humano lo resuelve de un vistazo; la correlación no. Cuando eso pasa,
// el control va en manos de la persona.
//
// POR QUÉ POR ZONA Y NO UNO SOLO. El mosaico de Esri está armado con
// capturas distintas, cada una con su propia georreferenciación: la
// medición, aunque poco confiable, coincidió en que el corrimiento no es
// el mismo ni en magnitud ni en dirección entre Merlo, Carpintería y
// Potrero. Un valor único estaría mal en casi todos lados.
//
// Módulo puro: sin Leaflet, sin Firestore, sin DOM. Todo lo que decide
// se puede probar solo.
// ---------------------------------------------------------------------------

// Tamaño de la celda de calibración, en grados. 0,02° son unos 2,2 km de
// norte a sur y ~1,9 km de este a oeste en San Luis.
//
// El tamaño sale de a qué se parece el problema: las capturas del
// mosaico satelital cubren varios kilómetros, así que dentro de una
// celda de 2 km el corrimiento es casi siempre el mismo. Más chico
// obligaría a calibrar muchas veces lo mismo; más grande mezclaría dos
// capturas con corrimientos distintos en una sola celda.
export const GRADOS_POR_CELDA = 0.02;

// Tope de lo que se puede correr, en metros. No es un límite técnico:
// es que más allá de esto ya no estás calzando una foto, estás
// mandándola a otro lado, y lo más probable es que sea un error de
// quien lo hizo. El corrimiento más grande medido fue de 25 m.
export const CORRIMIENTO_MAXIMO_M = 60;

/**
 * Nombre de la celda a la que pertenece un punto.
 *
 * Es el id del documento en Firestore, así que tiene que ser estable y
 * sin caracteres raros: se usa el índice de la celda (un entero) y no
 * las coordenadas, para que no dependa de cómo se redondean los
 * decimales.
 */
export function celdaDe(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const y = Math.floor(lat / GRADOS_POR_CELDA);
  const x = Math.floor(lon / GRADOS_POR_CELDA);
  return `c${y}_${x}`;
}

/**
 * Metros que mide un píxel de pantalla, en la proyección del mapa.
 *
 * Es la fórmula de Web Mercator: el ancho del ecuador (40.075.016 m)
 * repartido en 256 píxeles por tile, por 2^zoom tiles, corregido por el
 * coseno de la latitud (los meridianos se juntan hacia los polos).
 */
export function metrosPorPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * La corrección, de metros a píxeles de pantalla.
 *
 * HAY QUE RECALCULARLA EN CADA ZOOM. La corrección se guarda en metros
 * porque eso es lo que no cambia —la foto está corrida tantos metros en
 * el terreno—, pero lo que se mueve es una capa dibujada en píxeles, y
 * un metro son muchos más píxeles acercado que alejado. Guardar píxeles
 * haría que el calce se rompiera al hacer zoom, que es exactamente
 * cuando la gente lo mira.
 *
 * El eje Y va al revés que la latitud: en pantalla crece hacia abajo
 * (hacia el sur), así que correr la foto hacia el norte es restar.
 */
export function corrimientoEnPixeles({ este_m = 0, norte_m = 0 }, lat, zoom) {
  const mpp = metrosPorPixel(lat, zoom);
  if (!(mpp > 0)) return { x: 0, y: 0 };
  return {
    x: Math.round(este_m / mpp),
    y: Math.round(-norte_m / mpp)
  };
}

/**
 * Deja un corrimiento dentro de lo aceptable, o dice que no sirve.
 *
 * Se valida al leer de la base, no solo al escribir: un documento con
 * basura (editado a mano, o de una versión vieja del formato) tiene que
 * dar como resultado "sin corrección" y no mover la foto a Uruguay.
 */
export function corrimientoValido(valor) {
  const datos = valor || {};
  const este = Number(datos.este_m);
  const norte = Number(datos.norte_m);
  if (!Number.isFinite(este) || !Number.isFinite(norte)) return null;
  if (Math.abs(este) > CORRIMIENTO_MAXIMO_M) return null;
  if (Math.abs(norte) > CORRIMIENTO_MAXIMO_M) return null;
  if (este === 0 && norte === 0) return null;
  return { este_m: este, norte_m: norte };
}

/**
 * Cómo se cuenta el corrimiento cuando alguien aprieta una flecha.
 *
 * El paso es de un metro: es la unidad en la que una persona piensa
 * ("está corrido como cinco metros") y a la vez suficientemente fino
 * para que el calce quede bien. Si se pasa del tope, se queda en el
 * tope en vez de rebotar: que la flecha deje de hacer efecto se
 * entiende, que el valor salte a otra cosa no.
 */
export function conElPaso(actual, direccion, paso = 1) {
  const base = { este_m: 0, norte_m: 0, ...(actual || {}) };
  const topar = (v) => Math.max(-CORRIMIENTO_MAXIMO_M, Math.min(CORRIMIENTO_MAXIMO_M, v));
  const movimientos = {
    este: { este_m: topar(base.este_m + paso), norte_m: base.norte_m },
    oeste: { este_m: topar(base.este_m - paso), norte_m: base.norte_m },
    norte: { este_m: base.este_m, norte_m: topar(base.norte_m + paso) },
    sur: { este_m: base.este_m, norte_m: topar(base.norte_m - paso) }
  };
  return movimientos[direccion] || base;
}

/** Cómo se le cuenta a la persona cuánto corrió la foto. */
export function comoTexto({ este_m = 0, norte_m = 0 } = {}) {
  if (este_m === 0 && norte_m === 0) return "sin corrección";
  const partes = [];
  if (norte_m) partes.push(`${Math.abs(norte_m)} m al ${norte_m > 0 ? "norte" : "sur"}`);
  if (este_m) partes.push(`${Math.abs(este_m)} m al ${este_m > 0 ? "este" : "oeste"}`);
  return partes.join(" y ");
}
