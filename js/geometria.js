// ---------------------------------------------------------------------------
// Geometría pura de MojonApp: centroide, área, envoltura convexa, rectángulo
// mínimo, distancia/rumbo (Haversine), y las funciones del editor de forma
// (medir un lado, detectar/simplificar esquinas casi en línea recta).
//
// Ninguna función de este archivo toca el DOM ni Firebase — solo reciben
// coordenadas (o marcadores de Leaflet, vía su `.getLatLng()`) y devuelven
// números u objetos planos. Por eso es el primer módulo que se separó al
// modularizar app.js (ver plan en la sesión del 2026-08-31): es la parte
// más fácil de mover sin arrastrar ningún acoplamiento de estado.
// ---------------------------------------------------------------------------

// Centroide "de área" de un anillo exterior de polígono GeoJSON ([lon, lat], ...).
// Para los rectángulos de ejemplo da lo mismo que el promedio simple, pero esta
// fórmula también es correcta para polígonos irregulares (mensuras reales).
//
// Los puntos se trasladan a coordenadas locales (relativas al primer vértice)
// antes de operar: lon/lat rondan magnitudes como -65/-32, mientras que un
// lote mide unos pocos metros en grados (~0.0003). Calcular la fórmula del
// área directamente sobre esas coordenadas "grandes" resta números casi
// iguales entre sí y pierde toda la precisión (cancelación catastrófica),
// dando un centroide desplazado varios metros del real.
export function centroideDePoligono(anillo) {
  const puntos = anillo[0][0] === anillo[anillo.length - 1][0] && anillo[0][1] === anillo[anillo.length - 1][1]
    ? anillo.slice(0, -1)
    : anillo;

  const [lonOrigen, latOrigen] = puntos[0];
  const locales = puntos.map(([lon, lat]) => [lon - lonOrigen, lat - latOrigen]);

  let areaAcumulada = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < locales.length; i++) {
    const [x0, y0] = locales[i];
    const [x1, y1] = locales[(i + 1) % locales.length];
    const cruzado = x0 * y1 - x1 * y0;
    areaAcumulada += cruzado;
    cx += (x0 + x1) * cruzado;
    cy += (y0 + y1) * cruzado;
  }

  if (areaAcumulada === 0) {
    // Polígono degenerado: fallback a promedio simple.
    const lon = puntos.reduce((s, p) => s + p[0], 0) / puntos.length;
    const lat = puntos.reduce((s, p) => s + p[1], 0) / puntos.length;
    return { lat, lon };
  }

  const area = areaAcumulada / 2;
  cx = cx / (6 * area);
  cy = cy / (6 * area);
  return { lat: cy + latOrigen, lon: cx + lonOrigen };
}

// Superficie en m² de un anillo de polígono ([lon, lat], ...), con la misma
// proyección local que centroideDePoligono (evita la cancelación numérica).
// Se usa en el formulario de carga para avisarle al corredor si el área que
// dan los vértices que pegó no se parece a la superficie declarada — el
// caso real que motivó el test de integridad del GeoJSON (vértices en
// orden cruzado, área totalmente distinta, sin ningún error visible).
export function areaEnM2(anillo) {
  const [lonOrigen, latOrigen] = anillo[0];
  const mPorGradoLat = 111320;
  const mPorGradoLon = 111320 * Math.cos(aRadianes(latOrigen));
  const puntosMetros = anillo.map(([lon, lat]) => [
    (lon - lonOrigen) * mPorGradoLon,
    (lat - latOrigen) * mPorGradoLat
  ]);

  let area2 = 0;
  for (let i = 0; i < puntosMetros.length - 1; i++) {
    const [x0, y0] = puntosMetros[i];
    const [x1, y1] = puntosMetros[i + 1];
    area2 += x0 * y1 - x1 * y0;
  }
  return Math.abs(area2) / 2;
}

// Envoltura convexa (monotone chain) de puntos en metros locales
// [[x,y], ...] — paso previo para el rectángulo mínimo de abajo.
export function envolturaConvexa(puntos) {
  const pts = [...puntos].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cruz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const inferior = [];
  for (const p of pts) {
    while (inferior.length >= 2 && cruz(inferior[inferior.length - 2], inferior[inferior.length - 1], p) <= 0) {
      inferior.pop();
    }
    inferior.push(p);
  }
  const superior = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (superior.length >= 2 && cruz(superior[superior.length - 2], superior[superior.length - 1], p) <= 0) {
      superior.pop();
    }
    superior.push(p);
  }
  inferior.pop();
  superior.pop();
  return inferior.concat(superior);
}

// Rectángulo de área mínima que envuelve el lote ("rotating calipers":
// prueba un rectángulo alineado con cada lado de la envoltura convexa, y
// se queda con el de menor área). Devuelve ancho/alto SIN ordenar (tal
// como quedan según el lado de la envoltura que ganó) más el ángulo de
// ese lado y el centro del rectángulo. Null si el polígono es degenerado.
export function rectanguloMinimoConTransform(puntosMetros) {
  const hull = envolturaConvexa(puntosMetros);
  if (hull.length < 3) return null;

  let mejorArea = Infinity;
  let mejor = null;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i];
    const [x1, y1] = hull[(i + 1) % hull.length];
    const angulo = Math.atan2(y1 - y0, x1 - x0);
    const cos = Math.cos(-angulo);
    const sin = Math.sin(-angulo);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry);
      maxY = Math.max(maxY, ry);
    }
    const ancho = maxX - minX;
    const alto = maxY - minY;
    const area = ancho * alto;
    if (area < mejorArea) {
      mejorArea = area;
      mejor = { ancho, alto, angulo, centroRotado: [(minX + maxX) / 2, (minY + maxY) / 2] };
    }
  }
  return mejor;
}

// Ancho y largo (en metros) del rectángulo de área mínima. Devuelve
// [corto, largo]; null si el polígono es degenerado.
export function rectanguloMinimoEnMetros(puntosMetros) {
  const info = rectanguloMinimoConTransform(puntosMetros);
  if (!info) return null;
  return [info.ancho, info.alto].sort((a, b) => a - b);
}

// Frente y largo del lote — misma proyección local que areaEnM2, más
// que suficiente de precisa para un lote (decenas de metros, no
// kilómetros). "Frente" es el lado corto del rectángulo mínimo, "Largo"
// el lado largo: no hay forma de saber desde la geometría sola cuál
// lado da realmente a la calle, así que es una aproximación por
// tamaño, no una lectura literal del frente catastral.
export function medidasFrenteYLargo(anillo) {
  const puntos = anillo[0][0] === anillo[anillo.length - 1][0] && anillo[0][1] === anillo[anillo.length - 1][1]
    ? anillo.slice(0, -1)
    : anillo;
  if (puntos.length < 3) return null;

  const [lonOrigen, latOrigen] = puntos[0];
  const mPorGradoLat = 111320;
  const mPorGradoLon = 111320 * Math.cos(aRadianes(latOrigen));
  const puntosMetros = puntos.map(([lon, lat]) => [
    (lon - lonOrigen) * mPorGradoLon,
    (lat - latOrigen) * mPorGradoLat
  ]);

  return rectanguloMinimoEnMetros(puntosMetros);
}

export function textoMedidasLados(anillo) {
  const dims = medidasFrenteYLargo(anillo);
  if (!dims) return "Sin datos";
  const [frente, largo] = dims;
  return `Frente ${frente.toFixed(1)} m × Largo ${largo.toFixed(1)} m`;
}

// Ray casting: ¿el punto (lat, lon) está dentro del anillo exterior?
export function puntoDentroDePoligono(lat, lon, anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i];
    const [xj, yj] = anillo[j];
    const interseca =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (interseca) dentro = !dentro;
  }
  return dentro;
}

// ---------------------------------------------------------------------------
// Distancia (Haversine) y rumbo inicial entre dos puntos, en grados.
// ---------------------------------------------------------------------------

const RADIO_TIERRA_M = 6371000;

export function aRadianes(g) {
  return (g * Math.PI) / 180;
}

export function distanciaMetros(lat1, lon1, lat2, lon2) {
  const dLat = aRadianes(lat2 - lat1);
  const dLon = aRadianes(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aRadianes(lat1)) * Math.cos(aRadianes(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return RADIO_TIERRA_M * c;
}

export function rumboInicial(lat1, lon1, lat2, lon2) {
  const y = Math.sin(aRadianes(lon2 - lon1)) * Math.cos(aRadianes(lat2));
  const x =
    Math.cos(aRadianes(lat1)) * Math.sin(aRadianes(lat2)) -
    Math.sin(aRadianes(lat1)) * Math.cos(aRadianes(lat2)) * Math.cos(aRadianes(lon2 - lon1));
  const grados = (Math.atan2(y, x) * 180) / Math.PI;
  return (grados + 360) % 360;
}

// ---------------------------------------------------------------------------
// Editor de forma: medir/mover un lado exacto, y detectar/simplificar
// esquinas casi en línea recta. Estas reciben marcadores de Leaflet (objetos
// con `.getLatLng()`), no arrays de coordenadas — pero no dependen de nada
// más del mapa ni del DOM, así que siguen siendo funciones puras en ese
// sentido: mismo input, mismo output, sin efectos secundarios.
// ---------------------------------------------------------------------------

// El anillo guardado en Firestore siempre viene cerrado (primer punto
// igual al último, ver anilloAGeometryFirestore) — para editar interesa
// la lista de vértices ÚNICOS, sin ese cierre duplicado.
export function verticesUnicos(anillo) {
  const cerrado =
    anillo.length > 1 && anillo[0][0] === anillo[anillo.length - 1][0] && anillo[0][1] === anillo[anillo.length - 1][1];
  return cerrado ? anillo.slice(0, -1) : anillo;
}

// Distancia real (metros) entre dos esquinas del editor — misma
// proyección local equirectangular que el resto del archivo, con
// origen en el primer punto (alcanza de sobra para el tamaño de un
// lote, no hace falta más precisión que esa).
export function longitudLadoEnMetros(latlngA, latlngB) {
  const mPorGradoLat = 111320;
  const mPorGradoLon = 111320 * Math.cos(aRadianes(latlngA.lat));
  const dx = (latlngB.lng - latlngA.lng) * mPorGradoLon;
  const dy = (latlngB.lat - latlngA.lat) * mPorGradoLat;
  return Math.hypot(dx, dy);
}

// Distancia perpendicular (metros) de un punto a la RECTA que pasa por
// otros dos — no al segmento, a la recta infinita. Se usa para detectar
// esquinas casi en línea recta (ver más abajo): si "actual" está a
// pocos centímetros/metros de la recta entre su vecino anterior y el
// siguiente, ese vértice no aporta forma real, es un quiebre
// imperceptible que solo complica elegir un lado para editar.
export function distanciaPuntoALineaMetros(punto, a, b) {
  const mPorGradoLat = 111320;
  const mPorGradoLon = 111320 * Math.cos(aRadianes(a.lat));
  const ax = 0;
  const ay = 0;
  const bx = (b.lng - a.lng) * mPorGradoLon;
  const by = (b.lat - a.lat) * mPorGradoLat;
  const px = (punto.lng - a.lng) * mPorGradoLon;
  const py = (punto.lat - a.lat) * mPorGradoLat;
  const largo = Math.hypot(bx - ax, by - ay);
  if (largo === 0) return Math.hypot(px - ax, py - ay);
  return Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / largo;
}

// Lote real que motivó esto: una parcela del catastro con 5 vértices
// donde 4 caían casi perfectamente sobre una misma línea recta (el
// "lado de abajo" partido en 3 tramos casi invisibles) — se veía como
// un triángulo pero elegir "ese lado" para escribirle una medida exacta
// obligaba a lidiar con 3 lados distintos en vez de uno. Un metro de
// margen es generoso para cualquier quiebre real de una mensura (que
// se nota a simple vista) y estricto para uno que no se nota.
export const UMBRAL_SIMPLIFICAR_METROS = 1;

export function verticesCasiColineales(marcadores) {
  const n = marcadores.length;
  if (n <= 3) return false;
  for (let i = 0; i < n; i++) {
    const anterior = marcadores[(i - 1 + n) % n].getLatLng();
    const actual = marcadores[i].getLatLng();
    const siguiente = marcadores[(i + 1) % n].getLatLng();
    if (distanciaPuntoALineaMetros(actual, anterior, siguiente) < UMBRAL_SIMPLIFICAR_METROS) return true;
  }
  return false;
}

// Saca, de a uno por vez, cualquier vértice casi en línea recta con sus
// dos vecinos — repite hasta que no quede ninguno o hasta llegar a un
// triángulo (no tiene sentido simplificar más allá de 3 lados).
export function verticesSimplificados(marcadores) {
  let latlngs = marcadores.map((m) => m.getLatLng());
  let siguioSacando = true;
  while (siguioSacando && latlngs.length > 3) {
    siguioSacando = false;
    const n = latlngs.length;
    for (let i = 0; i < n; i++) {
      const anterior = latlngs[(i - 1 + n) % n];
      const actual = latlngs[i];
      const siguiente = latlngs[(i + 1) % n];
      if (distanciaPuntoALineaMetros(actual, anterior, siguiente) < UMBRAL_SIMPLIFICAR_METROS) {
        latlngs.splice(i, 1);
        siguioSacando = true;
        break;
      }
    }
  }
  return latlngs;
}

// Distancia (en píxeles de pantalla, no metros) de un punto a un
// segmento — para saber a qué lado del lote corresponde un click/touch
// en el mapa. En píxeles y no en metros porque así el radio de
// tolerancia (25px en ladoMasCercano, en app.js) es el mismo "qué tan
// cerca hay que tocar" sin importar el zoom o el tamaño real del lote.
export function distanciaPuntoASegmentoPx(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const largo2 = dx * dx + dy * dy;
  if (largo2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / largo2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
