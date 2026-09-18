// ---------------------------------------------------------------------------
// Buscador global: encontrar un lote o un lead desde cualquier pantalla.
//
// BUSCA SOBRE LO QUE YA ESTÁ EN MEMORIA (getLotesActuales /
// getContactosActuales), no sobre Firestore. Dos motivos: es instantáneo
// mientras se escribe, y no gasta lecturas — que en este proyecto es un
// recurso que ya se agotó una vez en plena jornada de trabajo.
//
// La contra, dicha: solo encuentra lo que la app ya cargó. Hoy la app
// carga todos los lotes al arrancar, así que para lotes es completo; los
// leads se cargan la primera vez que se abre el CRM o el Dashboard, así
// que antes de eso el buscador no los va a encontrar. Se prefiere eso a
// una consulta por cada tecla.
//
// Este módulo es solo la decisión de qué coincide y en qué orden. Sin
// DOM y sin Firestore, para poder testear las reglas sueltas.
// ---------------------------------------------------------------------------

// Menos de dos caracteres devuelve nada: con una sola letra coincide
// medio sistema y la lista deja de ayudar.
export const MINIMO_PARA_BUSCAR = 2;

// Techo por grupo. Una lista larga no se lee; si lo que buscabas no está
// en los primeros, conviene afinar el término.
export const MAXIMO_POR_GRUPO = 5;

function normalizar(texto) {
  // Sin acentos y en minúsculas: quien busca "carpinteria" tiene que
  // encontrar "Carpintería". En una app argentina, escribir sin tildes
  // es lo normal, no la excepción.
  return String(texto ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Cuánto coincide un texto con lo buscado.
 *
 * 3 = es igual, 2 = empieza igual, 1 = lo contiene, 0 = no coincide.
 * El orden importa: buscando "14", el lote de la manzana 14 tiene que
 * salir antes que el que tiene "14" en el medio de su nomenclatura.
 */
export function puntaje(texto, termino) {
  const t = normalizar(texto);
  const b = normalizar(termino);
  if (!t || !b) return 0;
  if (t === b) return 3;
  if (t.startsWith(b)) return 2;
  return t.includes(b) ? 1 : 0;
}

function mejorPuntaje(campos, termino) {
  return Math.max(0, ...campos.map((campo) => puntaje(campo, termino)));
}

/**
 * Resultados para un término, agrupados por tipo.
 *
 * @param termino lo que se escribió
 * @param lotes   features de lotes (getLotesActuales)
 * @param leads   contactos del CRM (getContactosActuales)
 * @returns { lotes: [...], leads: [...] } ya ordenados y recortados
 */
export function buscar(termino, lotes = [], leads = []) {
  const limpio = String(termino ?? "").trim();
  if (limpio.length < MINIMO_PARA_BUSCAR) return { lotes: [], leads: [] };

  const lotesConPuntaje = lotes
    .map((feature) => {
      const p = feature.properties || {};
      return {
        tipo: "lote",
        id: feature.id,
        feature,
        titulo: `Manzana ${p.manzana ?? "?"} — Lote ${p.lote ?? "?"}`,
        detalle: [p.sector, p.barrio].filter(Boolean).join(" · ") || p.nomenclatura || "",
        puntaje: mejorPuntaje([p.manzana, p.lote, p.nomenclatura, p.sector, p.barrio], limpio)
      };
    })
    .filter((r) => r.puntaje > 0);

  const leadsConPuntaje = leads
    .map((contacto) => ({
      tipo: "lead",
      id: contacto.id,
      contacto,
      titulo: contacto.nombre || "Sin nombre",
      detalle: contacto.telefono || contacto.email || "",
      puntaje: mejorPuntaje([contacto.nombre, contacto.telefono, contacto.email], limpio)
    }))
    .filter((r) => r.puntaje > 0);

  return {
    lotes: ordenarYRecortar(lotesConPuntaje),
    leads: ordenarYRecortar(leadsConPuntaje)
  };
}

function ordenarYRecortar(resultados) {
  return resultados
    .sort((a, b) => b.puntaje - a.puntaje || a.titulo.localeCompare(b.titulo))
    .slice(0, MAXIMO_POR_GRUPO);
}

/**
 * ¿Hay algo que mostrar?
 *
 * Se pregunta acá y no contando a mano en la pantalla para que
 * "escribiste poco" y "no hay resultados" no se confundan: son dos
 * mensajes distintos y la diferencia importa.
 */
export function hayResultados(resultados) {
  return resultados.lotes.length > 0 || resultados.leads.length > 0;
}
