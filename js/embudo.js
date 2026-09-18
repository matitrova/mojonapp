// ---------------------------------------------------------------------------
// Embudo de conversión: dónde se cae la gente y cuánto tarda en cada etapa.
//
// QUÉ SE AGREGA Y QUÉ YA EXISTÍA. El Dashboard ya mostraba cuántos
// contactos hay en cada etapa (contactosPorEtapa en crm-metricas.js) y la
// tasa de conversión a cerrado. Eso es una foto del momento: dice que hay
// 3 en visita, no dice cuántos de los que entraron llegaron a la visita
// ni cuánto tardaron en llegar. Esas dos son las preguntas que se usan
// para decidir algo — "de cada 10 leads, 6 llegan a visita pero solo 1
// hace oferta" señala exactamente dónde trabajar.
//
// DE DÓNDE SALEN LOS DATOS. De las actividades que el CRM ya venía
// grabando solo en cada contacto: cada cambio de etapa deja un registro
// con su fecha (ver actividadesAutomaticas en crm-metricas.js). No hace
// falta ningún dato nuevo ni ninguna colección nueva; solo leer lo que
// ya está.
//
// "PERDIDO" NO ES UN PASO DEL EMBUDO, es una fuga. Un contacto perdido
// avanzó hasta donde avanzó y se cayó; ponerlo como sexta etapa daría
// una conversión "de oferta a perdido" que no significa nada. Por eso
// ETAPAS_EMBUDO llega hasta "cerrado" y los perdidos cuentan en las
// etapas por las que pasaron.
//
// Módulo puro: recibe los contactos por parámetro, no toca Firestore ni
// el DOM.
// ---------------------------------------------------------------------------

import { ETIQUETA_ETAPA } from "./crm-metricas.js";

export const ETAPAS_EMBUDO = ["nuevo", "contactado", "visita", "oferta", "cerrado"];

const CLAVE_POR_ETIQUETA = Object.fromEntries(
  Object.entries(ETIQUETA_ETAPA).map(([clave, etiqueta]) => [etiqueta, clave])
);

// Respaldo para las actividades viejas, que guardaban el cambio solo como
// texto ("Nuevo → Contactado"). Las nuevas traen etapa_desde/etapa_hasta
// y no pasan por acá.
function claveDesdeElTexto(texto, indice) {
  const partes = String(texto || "").split("→");
  if (partes.length < 2) return null;
  return CLAVE_POR_ETIQUETA[partes[indice].trim()] ?? null;
}

function cambiosDeEtapa(contacto) {
  return (contacto.actividades || [])
    .filter((actividad) => actividad.tipo === "cambio_etapa")
    .map((actividad) => ({
      desde: actividad.etapa_desde ?? claveDesdeElTexto(actividad.texto, 0),
      hasta: actividad.etapa_hasta ?? claveDesdeElTexto(actividad.texto, 1),
      fecha: actividad.fecha
    }))
    .filter((cambio) => cambio.fecha)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
}

/**
 * Por qué etapas pasó un contacto.
 *
 * LA ETAPA ACTUAL IMPLICA LAS ANTERIORES, a propósito. Un contacto que
 * está en "visita" pasó por "nuevo" y "contactado" aunque nadie haya
 * registrado esos cambios — y eso pasa de verdad: un contacto creado
 * desde la ficha de un lote o traído de una importación puede nacer en
 * cualquier etapa, sin historial. Sin esta regla, el embudo mostraría
 * conversiones ridículas (0 de 3 llegaron a visita, con 3 en visita).
 *
 * La excepción es "perdido", que no tiene lugar en el orden del embudo:
 * de un contacto perdido solo cuenta el historial que dejó.
 */
export function etapasAlcanzadas(contacto = {}) {
  const alcanzadas = new Set();
  for (const cambio of cambiosDeEtapa(contacto)) {
    if (cambio.desde) alcanzadas.add(cambio.desde);
    if (cambio.hasta) alcanzadas.add(cambio.hasta);
  }
  const posicion = ETAPAS_EMBUDO.indexOf(contacto.estado);
  for (let i = 0; i <= posicion; i++) alcanzadas.add(ETAPAS_EMBUDO[i]);
  return alcanzadas;
}

/**
 * Los pasos del embudo, con su tasa de conversión.
 *
 * @returns [{ desde, hasta, base, avanzaron, tasa }] — tasa en % entero,
 *          o null cuando nadie llegó a la etapa de origen (sin base no
 *          hay porcentaje: 0 de 0 no es 0%, es "todavía no se sabe").
 */
export function pasosDelEmbudo(contactos = []) {
  const alcanzadasPorContacto = contactos.map((contacto) => etapasAlcanzadas(contacto));
  const pasos = [];
  for (let i = 0; i < ETAPAS_EMBUDO.length - 1; i++) {
    const desde = ETAPAS_EMBUDO[i];
    const hasta = ETAPAS_EMBUDO[i + 1];
    const base = alcanzadasPorContacto.filter((etapas) => etapas.has(desde)).length;
    const avanzaron = alcanzadasPorContacto.filter((etapas) => etapas.has(hasta)).length;
    pasos.push({
      desde,
      hasta,
      base,
      avanzaron,
      tasa: base === 0 ? null : Math.round((avanzaron / base) * 100)
    });
  }
  return pasos;
}

const MS_POR_DIA = 86400000;

/**
 * Cuántos días tarda un contacto, en promedio, en salir de cada etapa.
 *
 * Solo cuenta los tramos TERMINADOS: desde que entró a una etapa hasta
 * que salió. El tiempo en la etapa actual no se promedia porque todavía
 * está corriendo — meterlo bajaría el promedio de forma engañosa
 * (alguien que entró ayer contaría como "1 día en visita" cuando puede
 * quedarse un mes).
 *
 * El primer tramo arranca en fecha_creacion: el tiempo en la etapa
 * inicial también cuenta, y es justo el que más importa (cuánto tarda
 * alguien en ser atendido).
 *
 * @returns { [etapa]: { dias, muestras } } solo con las etapas que
 *          tengan al menos un tramo terminado.
 */
export function diasPromedioPorEtapa(contactos = []) {
  const acumulado = new Map();

  for (const contacto of contactos) {
    const cambios = cambiosDeEtapa(contacto);
    if (cambios.length === 0) continue;

    // La etapa de la que salió el primer cambio empezó cuando se creó el
    // contacto. Sin fecha_creacion ese primer tramo no se puede medir y
    // se saltea, en vez de suponer una fecha.
    let inicioDelTramo = contacto.fecha_creacion ? new Date(contacto.fecha_creacion) : null;

    for (const cambio of cambios) {
      const fechaDelCambio = new Date(cambio.fecha);
      if (inicioDelTramo && cambio.desde) {
        const dias = (fechaDelCambio - inicioDelTramo) / MS_POR_DIA;
        // Un tramo negativo significa datos inconsistentes (una fecha de
        // creación posterior a un cambio). Se descarta en vez de restar.
        if (dias >= 0) {
          const previo = acumulado.get(cambio.desde) || { total: 0, muestras: 0 };
          acumulado.set(cambio.desde, { total: previo.total + dias, muestras: previo.muestras + 1 });
        }
      }
      inicioDelTramo = fechaDelCambio;
    }
  }

  const resultado = {};
  for (const [etapa, { total, muestras }] of acumulado) {
    resultado[etapa] = { dias: Math.round((total / muestras) * 10) / 10, muestras };
  }
  return resultado;
}

/**
 * En qué paso se cae más gente, para poder señalarlo en pantalla.
 *
 * Devuelve el paso con la tasa más baja entre los que tienen base
 * suficiente. MINIMO_PARA_OPINAR existe porque con dos contactos
 * cualquier porcentaje es ruido, y señalar "acá se te cae todo" por un
 * solo caso sería peor que no decir nada.
 */
export const MINIMO_PARA_OPINAR = 5;

export function pasoMasFlojo(pasos = []) {
  const candidatos = pasos.filter((paso) => paso.tasa !== null && paso.base >= MINIMO_PARA_OPINAR);
  if (candidatos.length === 0) return null;
  return candidatos.reduce((peor, paso) => (paso.tasa < peor.tasa ? paso : peor));
}
