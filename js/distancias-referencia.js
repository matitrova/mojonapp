// ---------------------------------------------------------------------------
// Distancia a la ruta pavimentada y a la localidad más cercana — dato real
// (no inventado a mano) sacado en vivo de OpenStreetMap vía Overpass API
// (pública, gratuita, sin clave: https://overpass-api.de). Un lote rural se
// vende en buena parte por esto ("a 2 km de la ruta"), pero MojonApp no
// tiene ningún dataset propio de rutas/pueblos — inventar esa distancia a
// ojo sería peor que no mostrar nada, así que se consulta de verdad.
//
// Se pide async y NO bloquea la ficha: si Overpass tarda, no responde, o no
// hay nada en el radio buscado, la sección de "Cercanías" simplemente no
// aparece — mejor eso que un dato mal calculado o un error visible a un
// comprador real mirando el mapa.
// ---------------------------------------------------------------------------

import { distanciaMetros } from "./geometria.js";

// El servidor público oficial (overpass-api.de) a veces tarda 15+ segundos
// bajo carga — medido en vivo, mismo pedido: entre 9s y 16s según el
// momento, sin relación clara con el radio pedido. Se probó sumar un
// espejo alternativo (overpass.kumi.systems) como respaldo, pero resultó
// MENOS confiable todavía (no contestó en 45+ s en la prueba) — se
// descartó: mejor un solo servidor conocido con margen generoso que uno
// "de respaldo" que en la práctica solo suma espera. En el peor caso
// (Overpass muy cargado) esta sección no se llega a mostrar — eso es
// aceptable, corre en background y nunca bloquea la ficha.
const ENDPOINTS = ["https://overpass-api.de/api/interpreter"];
const RADIO_METROS = 15000; // 15 km — alcanza para el propósito ("¿qué tan aislado está?")
const TIMEOUT_MS = 18000;

// Cache en memoria de la sesión, por centroide redondeado a ~11 m — el
// mismo lote consultado de nuevo (reabrir la ficha, o un lote vecino con
// centroide casi igual) no vuelve a pedirle nada a Overpass.
const cache = new Map();

function claveCache(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function armarQuery(lat, lon) {
  return (
    `[out:json][timeout:10];` +
    `(way(around:${RADIO_METROS},${lat},${lon})["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"];` +
    `node(around:${RADIO_METROS},${lat},${lon})["place"~"^(city|town|village)$"];);` +
    `out center 20;`
  );
}

async function consultarUnEndpoint(endpoint, query) {
  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    const respuesta = await fetch(endpoint, {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: controlador.signal
    });
    if (!respuesta.ok) return null;
    const datos = await respuesta.json();
    return datos.elements || [];
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function consultarOverpass(lat, lon) {
  const query = armarQuery(lat, lon);
  for (const endpoint of ENDPOINTS) {
    const elementos = await consultarUnEndpoint(endpoint, query);
    if (elementos) return elementos;
  }
  // Ningún espejo contestó a tiempo — se degrada a "sin dato" en vez de
  // romper la ficha.
  return null;
}

// Devuelve { rutaKm, localidadNombre, localidadKm } (cualquiera de los
// dos puede venir null si no se encontró) o null si no se pudo calcular
// nada en absoluto.
export async function distanciasReferenciaCercanas(lat, lon) {
  const clave = claveCache(lat, lon);
  if (cache.has(clave)) return cache.get(clave);

  const elementos = await consultarOverpass(lat, lon);
  if (!elementos) return null; // no se cachea un fallo — puede andar en el próximo intento

  let rutaMasCercanaM = null;
  let localidadMasCercana = null;

  elementos.forEach((el) => {
    const puntoLat = el.center ? el.center.lat : el.lat;
    const puntoLon = el.center ? el.center.lon : el.lon;
    if (puntoLat == null || puntoLon == null) return;
    const distancia = distanciaMetros(lat, lon, puntoLat, puntoLon);

    if (el.type === "way" && el.tags?.highway) {
      if (rutaMasCercanaM == null || distancia < rutaMasCercanaM) rutaMasCercanaM = distancia;
    } else if (el.type === "node" && el.tags?.place) {
      if (!localidadMasCercana || distancia < localidadMasCercana.distancia) {
        localidadMasCercana = { nombre: el.tags.name || "Localidad cercana", distancia };
      }
    }
  });

  const resultado =
    rutaMasCercanaM == null && !localidadMasCercana
      ? null
      : {
          rutaKm: rutaMasCercanaM != null ? rutaMasCercanaM / 1000 : null,
          localidadNombre: localidadMasCercana?.nombre || null,
          localidadKm: localidadMasCercana ? localidadMasCercana.distancia / 1000 : null
        };

  cache.set(clave, resultado);
  return resultado;
}
