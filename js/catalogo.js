// ---------------------------------------------------------------------------
// El catálogo público: qué propiedades se muestran, en qué orden y con qué
// datos.
//
// POR QUÉ ES UNA PANTALLA APARTE Y NO /lotes CON UN MODO. /lotes es la
// herramienta del corredor: tiene la insignia "Nuevo", los tildes de
// edición en masa, el filtro por estado y el título "Lotes cargados".
// Hasta el 2026-09-24 esa misma pantalla era lo que veía un comprador
// que tocaba "Ver las propiedades disponibles" — y ahí le aparecía un
// lote VENDIDO en la lista, con su precio, arriba de todo.
//
// Se separó porque el problema no fue un descuido puntual: mientras una
// sola pantalla sirva a los dos, cada cosa que se le agregue hay que
// acordarse de esconderla. Con dos pantallas, lo interno no tiene por
// dónde filtrarse.
//
// Módulo puro: sin Firestore ni DOM. Lo dibuja js/catalogo-publico.js.
//
// LO QUE SE MIRÓ ANTES DE DISEÑARLO. Argenprop, terrenos en venta en San
// Luis (2026-09-24). La anatomía de una tarjeta real: foto grande con
// contador, ubicación en negrita, precio, superficie TOTAL y además
// frente/fondo, una descripción corta, "Publica: <inmobiliaria>" y los
// botones de WhatsApp y Contactar EN LA PROPIA TARJETA — no hay que
// abrir la propiedad para escribir. Las dos últimas son las que acá
// faltaban por completo.
// ---------------------------------------------------------------------------

// Lo que se puede comprar va primero. Los vendidos van al final y sin
// precio: son prueba social ("esta inmobiliaria vende de verdad"), no
// oferta. Decisión del dueño del producto — la alternativa era
// esconderlos, y se eligió mostrarlos porque una cartera con ventas
// dice más que una cartera a secas.
const ORDEN_ESTADO = { disponible: 0, reservado: 1, vendido: 2 };

export function esVendible(propiedades) {
  return (propiedades?.estado || "disponible") !== "vendido";
}

/**
 * Las propiedades tal como las ve un comprador.
 *
 * Ordena por estado (lo que se vende primero) y, dentro de cada grupo,
 * por precio de menor a mayor — que es como ordena cualquier portal
 * cuando no elegís nada. Las que no tienen precio van al final de su
 * grupo: sin número no hay con qué compararlas.
 */
export function ordenarParaElComprador(lotes) {
  return [...lotes].sort((a, b) => {
    const pa = a.properties || {};
    const pb = b.properties || {};
    const ea = ORDEN_ESTADO[pa.estado] ?? 0;
    const eb = ORDEN_ESTADO[pb.estado] ?? 0;
    if (ea !== eb) return ea - eb;

    const ca = pa.precio_usd == null ? Infinity : pa.precio_usd;
    const cb = pb.precio_usd == null ? Infinity : pb.precio_usd;
    if (ca !== cb) return ca - cb;

    // Desempate estable: sin esto el orden cambia entre recargas y el
    // comprador que vuelve no encuentra dos veces lo mismo en el mismo
    // lugar.
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Aplica los filtros del visitante: zona y precio.
 *
 * SOLO DOS, y son las dos preguntas que hace todo el mundo: dónde y
 * cuánto. Con una cartera de 180 lotes se puede querer más, pero cada
 * control extra es una pantalla más difícil de entender de un vistazo,
 * y esta se ve una sola vez desde un link de WhatsApp.
 *
 * UNA PROPIEDAD SIN PRECIO NO SE FILTRA POR PRECIO. Descartarla sería
 * esconder justo la que dice "consultar" — que en terrenos es muy
 * común— a alguien que puso un máximo.
 */
export function filtrarCatalogo(lotes, { zona = "", desde = null, hasta = null } = {}) {
  return lotes.filter((f) => {
    const p = f.properties || {};
    if (zona && (p.sector || "") !== zona) return false;
    if (p.precio_usd == null) return true;
    if (desde != null && p.precio_usd < desde) return false;
    if (hasta != null && p.precio_usd > hasta) return false;
    return true;
  });
}

/** Las zonas que de verdad tienen algo, para el desplegable. */
export function zonasDelCatalogo(lotes) {
  const zonas = new Set();
  for (const f of lotes) {
    const zona = f.properties?.sector;
    if (zona) zonas.add(zona);
  }
  return [...zonas].sort((a, b) => a.localeCompare(b, "es"));
}

/**
 * El precio, tal como lo lee un comprador.
 *
 * "Precio a consultar" y no "—" ni un hueco: en la tabla del corredor el
 * guion significa "no lo cargué todavía", y acá eso no le dice nada a
 * nadie. Un vendido no muestra precio: lo que se pagó por algo que ya no
 * está no es una oferta, y publicarlo tampoco le hace bien al que vendió.
 */
export function precioParaElComprador(propiedades) {
  const p = propiedades || {};
  if (!esVendible(p)) return null;
  if (p.precio_usd == null) return "Precio a consultar";
  return `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`;
}

/**
 * La línea de datos de la tarjeta: superficie y medidas.
 *
 * Las medidas (frente × fondo) las muestran todos los portales y es un
 * dato que acá ya se calcula desde la geometría real del lote — no hay
 * que pedírselo a nadie. Lo que falte se omite en vez de decir "sin
 * datos" tres veces: en una vidriera, un hueco se lee mejor que un
 * cartel avisando que falta algo.
 */
export function datosParaLaTarjeta(propiedades, medidas = null) {
  const p = propiedades || {};
  const partes = [];
  if (p.superficie_m2 != null) partes.push(`${Number(p.superficie_m2).toLocaleString("es-AR")} m²`);
  if (medidas) partes.push(medidas);
  return partes;
}

/** Dónde queda, con lo que haya cargado. */
export function ubicacionParaElComprador(propiedades) {
  const p = propiedades || {};
  return [p.sector, p.barrio].filter(Boolean).join(" · ") || null;
}

/**
 * Lo que dice la faja de estado, o null si no hace falta ninguna.
 *
 * Un disponible no lleva faja: es el caso normal y marcarlo sería ruido.
 */
export function fajaDeEstado(propiedades) {
  const estado = (propiedades || {}).estado;
  if (estado === "vendido") return { texto: "Vendido", clase: "vendido" };
  if (estado === "reservado") return { texto: "Reservado", clase: "reservado" };
  return null;
}

// ---------------------------------------------------------------------------
// La miniatura satelital con el límite real del lote dibujado encima.
//
// POR QUÉ VALE LA PENA. Es lo único que este producto tiene y la
// competencia no: ZonaProp y Argenprop muestran un pin sobre un mapa de
// calles. Y en una cartera recién cargada la mayoría de los lotes
// todavía no tiene fotos, así que sin esto el catálogo es una pared de
// cuadros grises que dice "Sin fotos todavía" — justo en la pantalla
// que la inmobiliaria manda para vender.
//
// Se arma con las mismas fotos satelitales de Esri que usa el mapa, pero
// como imágenes sueltas: no hace falta una instancia de Leaflet por
// tarjeta (serían siete mapas en una pantalla).
//
// Todo esto es aritmética de Web Mercator, la proyección que usan todos
// los mapas web. Está acá y no en el módulo de dibujo justamente para
// poder probarla con números y no a ojo.
// ---------------------------------------------------------------------------

const LADO_TILE = 256;

/** Un punto lat/lon en píxeles del mundo, para un zoom dado. */
export function aPixelesDelMundo(lat, lon, zoom) {
  const escala = LADO_TILE * 2 ** zoom;
  const x = ((lon + 180) / 360) * escala;
  const senoLat = Math.sin((lat * Math.PI) / 180);
  // Clamp: en los polos el logaritmo se va a infinito. Ningún lote está
  // ahí, pero un dato mal cargado no tiene por qué producir un NaN que
  // después se dibuja como una tarjeta rota.
  const acotado = Math.min(Math.max(senoLat, -0.9999), 0.9999);
  const y = (0.5 - Math.log((1 + acotado) / (1 - acotado)) / (4 * Math.PI)) * escala;
  return { x, y };
}

/**
 * El zoom al que un lote de este tamaño llena bien una miniatura.
 *
 * Se busca que el lote ocupe cerca del 70% del alto de la tarjeta: más
 * que eso y queda sin contexto (no se ve la calle, ni el vecino), menos
 * y vuelve a ser una mota, que es el defecto que ya se arregló en el
 * mapa.
 *
 * Este es el zoom VISUAL, y puede pasar de lo que Esri tiene: ver
 * ZOOM_NATIVO_MAX abajo.
 */
export function zoomParaElLote(metrosDeLado, altoEnPx = 300, lat = -32.4) {
  if (!metrosDeLado || metrosDeLado <= 0) return 17;
  const objetivo = altoEnPx * 0.7;
  // metros por píxel a zoom z = 156543,03 · cos(lat) / 2^z
  const metrosPorPixelBuscado = metrosDeLado / objetivo;
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / metrosPorPixelBuscado);
  return Math.max(15, Math.min(19, Math.round(z)));
}

// Hasta dónde Esri tiene foto de verdad en San Luis. Es el mismo
// maxNativeZoom que usan el mapa principal (js/mapa.js) y el mapita de
// la página pública.
//
// PASADO ESE PUNTO ESRI NO FALLA: devuelve un cuadro GRIS que dice "Map
// data not yet available", con HTTP 200. O sea que no hay error que
// atrapar ni status que mirar — el catálogo simplemente se llena de
// cuadros grises con el polígono flotando encima. Se vio en una captura
// el 2026-09-24, con zoom 19 elegido para cuatro de cinco lotes.
//
// Y BAJAR EL ZOOM A 17 NO ALCANZA: ahí un lote de 450 m² mide 17 px, que
// es exactamente la "mota" que se acaba de arreglar en el mapa. Por eso
// se hace lo mismo que hace Leaflet con maxNativeZoom: se piden los
// tiles del zoom que Esri SÍ tiene y se agrandan. Quedan un poco
// borrosos y se ve el lote.
export const ZOOM_NATIVO_MAX = 17;

/**
 * Los tiles que hay que pedir y dónde va cada uno, para cubrir una
 * miniatura de ancho x alto centrada en un punto.
 *
 * `zoom` es el VISUAL: a esa escala se dibuja el polígono. Los tiles se
 * piden al zoom nativo y se estiran por 2^(visual - nativo).
 */
export function mosaicoSatelital(lat, lon, zoom, ancho, alto) {
  const nativo = Math.min(zoom, ZOOM_NATIVO_MAX);
  const agrandado = 2 ** (zoom - nativo);
  // Cuánto mide, en píxeles de la miniatura, un tile nativo estirado.
  const ladoVisual = LADO_TILE * agrandado;

  const centro = aPixelesDelMundo(lat, lon, zoom);
  // Esquina superior izquierda de la miniatura, en píxeles del mundo al
  // zoom visual.
  const origenX = centro.x - ancho / 2;
  const origenY = centro.y - alto / 2;

  const desdeX = Math.floor(origenX / ladoVisual);
  const hastaX = Math.floor((origenX + ancho) / ladoVisual);
  const desdeY = Math.floor(origenY / ladoVisual);
  const hastaY = Math.floor((origenY + alto) / ladoVisual);

  const tiles = [];
  for (let tx = desdeX; tx <= hastaX; tx++) {
    for (let ty = desdeY; ty <= hastaY; ty++) {
      tiles.push({
        z: nativo,
        x: tx,
        y: ty,
        izquierda: tx * ladoVisual - origenX,
        arriba: ty * ladoVisual - origenY
      });
    }
  }
  return { tiles, origenX, origenY, lado: ladoVisual, zoomNativo: nativo };
}

/** lat/lon -> píxeles dentro de la miniatura. */
export function aPixelesDeLaMiniatura(lat, lon, zoom, origenX, origenY) {
  const p = aPixelesDelMundo(lat, lon, zoom);
  return { x: p.x - origenX, y: p.y - origenY };
}

/**
 * Cuántos metros mide el lado más largo del lote.
 *
 * Aproximación plana: a la escala de un lote (decenas o cientos de
 * metros) la curvatura no cambia nada, y lo único que se necesita es
 * elegir un zoom.
 */
export function ladoAproximadoEnMetros(anillo) {
  if (!Array.isArray(anillo) || anillo.length === 0) return null;
  const lats = anillo.map((p) => p.lat ?? p[1]);
  const lons = anillo.map((p) => p.lon ?? p.lng ?? p[0]);
  const latMedia = (Math.min(...lats) + Math.max(...lats)) / 2;
  const alto = (Math.max(...lats) - Math.min(...lats)) * 111320;
  const ancho = (Math.max(...lons) - Math.min(...lons)) * 111320 * Math.cos((latMedia * Math.PI) / 180);
  const lado = Math.max(alto, ancho);
  return lado > 0 ? lado : null;
}
