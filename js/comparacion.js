// ---------------------------------------------------------------------------
// "Cómo venimos respecto del mes pasado": el cálculo de las variaciones
// que muestran las tarjetas del Dashboard.
//
// DE DÓNDE SALE EL DATO DEL PASADO, que es la idea central. No hay
// ninguna colección de métricas históricas ni hace falta: cada cambio de
// etapa queda registrado como una actividad en el contacto mismo, con
// `etapa_desde`, `etapa_hasta` y `fecha` (ver actividadesAutomaticas en
// js/crm-metricas.js). Con eso se puede RECONSTRUIR en qué etapa estaba
// cada contacto en cualquier fecha pasada: se arranca del estado de hoy
// y se camina hacia atrás deshaciendo los cambios posteriores al corte.
//
// HAY DOS CLASES DE MÉTRICA Y NO SE COMPARAN IGUAL. Confundirlas es la
// forma más fácil de mostrar un número que no significa nada:
//
//   - FOTO DEL MOMENTO (cuántos contactos hay, cuántos estancados, la
//     tasa de conversión): se compara el valor de HOY contra el valor
//     que tenía al cierre del mes pasado. Valor contra valor, sin
//     ventanas, así que no importa qué día del mes sea.
//
//   - VENTANA (cuántos entraron en los últimos 7 días): se compara
//     contra la ventana anterior DEL MISMO TAMAÑO. Compararla contra
//     "el mes pasado" daría 7 días contra 30: el número sería siempre
//     catastrófico y no diría nada.
//
// LO QUE NO SE PUEDE CALCULAR, y por eso no se muestra: todo lo que
// depende del PRECIO de un lote (valor en pipeline, comisiones). Los
// lotes no guardan historial de precios, así que el "valor de hace un
// mes" tendría que calcularse con los precios de hoy — un número que
// nunca existió, en las tarjetas que justamente se miran para decidir.
// Se empezó a guardar ese historial (ver js/historial-precios.js), así
// que van a poder compararse dentro de un mes; hasta entonces no
// muestran variación.
//
// Módulo puro: sin Firestore, sin DOM, sin Date.now() escondido — la
// fecha de referencia entra por parámetro para que los tests puedan
// pararse en cualquier día.
// ---------------------------------------------------------------------------

/**
 * El último día del mes anterior al de una fecha, a las 23:59:59.999.
 *
 * Es el "corte" contra el que se comparan las métricas de foto: el
 * estado del negocio cuando cerró el mes pasado.
 *
 * EN HORA LOCAL, no en UTC, a propósito: el cierre del mes de una
 * inmobiliaria de San Luis es a SU medianoche. Visto en UTC, el 31/08
 * 23:59 local es el 01/09 02:59Z — o sea que comparar el corte contra
 * un string ISO hace parecer que cae en el mes siguiente. Las fechas de
 * los contactos sí vienen en ISO/UTC, pero eso no importa: las
 * comparaciones son entre objetos Date, que son instantes y no
 * calendarios.
 */
export function cierreDelMesAnterior(ahora) {
  const fecha = new Date(ahora);
  // Día 0 de este mes = último día del mes anterior. Lo hace el propio
  // Date, así que no hay que saber cuántos días tiene cada mes ni
  // acordarse de los años bisiestos.
  return new Date(fecha.getFullYear(), fecha.getMonth(), 0, 23, 59, 59, 999);
}

/**
 * En qué etapa estaba un contacto en una fecha dada.
 *
 * Devuelve null si en esa fecha el contacto todavía no existía — que no
 * es lo mismo que "estaba en nuevo", y contarlo como si hubiera estado
 * inflaría el pasado y haría que todo parezca que empeoró.
 *
 * CÓMO: se arranca del estado actual y se deshacen los cambios
 * posteriores al corte. El estado en el corte es el `etapa_desde` del
 * PRIMER cambio que ocurrió después. Así funciona igual para un
 * contacto que fue y volvió (nuevo → visita → nuevo): lo que importa es
 * el primer cambio posterior al corte, no el último.
 */
export function etapaEnLaFecha(contacto, corte) {
  const nacimiento = contacto.fecha_creacion;
  if (!nacimiento) return null;
  if (new Date(nacimiento) > corte) return null;

  const cambios = (contacto.actividades || [])
    .filter((a) => a && a.tipo === "cambio_etapa" && a.fecha && a.etapa_desde)
    .filter((a) => new Date(a.fecha) > corte)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  return cambios.length > 0 ? cambios[0].etapa_desde : contacto.estado;
}

/**
 * Las actividades que un contacto tenía hasta el corte.
 *
 * Hace falta para las métricas de higiene: "sin atender" mira si tenía
 * alguna actividad, y "estancado" mira cuánto hacía de la última. Con
 * las actividades de hoy, un contacto que se atendió la semana pasada
 * parecería haber estado atendido el mes pasado también.
 */
export function actividadesHasta(contacto, corte) {
  return (contacto.actividades || []).filter((a) => a && a.fecha && new Date(a.fecha) <= corte);
}

/**
 * La variación entre dos valores, en porcentaje entero.
 *
 * DEVUELVE null CUANDO NO HAY NADA QUE DECIR, y esa es la parte que
 * importa:
 *
 *   - si no hay valor anterior (la base recién arranca, todavía no pasó
 *     un mes), no hay comparación posible;
 *   - si el valor anterior era 0, el porcentaje es infinito. "Pasó de 0
 *     a 3" es una noticia, pero no es "+300%" ni "+∞": se devuelve null
 *     y la tarjeta no muestra nada en vez de un número absurdo.
 *
 * El signo se devuelve aparte de si es bueno o malo: que "estancados"
 * suba es una mala noticia aunque el número sea positivo. Eso lo decide
 * quien dibuja (ver esMejorQueBaje).
 */
export function variacion(ahora, antes) {
  if (antes == null || ahora == null) return null;
  if (!Number.isFinite(antes) || !Number.isFinite(ahora)) return null;
  if (antes === 0) return null;
  return Math.round(((ahora - antes) / antes) * 100);
}

// Tarjetas donde bajar es la buena noticia. Sin esto, "Estancados -40%"
// se pintaría de rojo por ser un número negativo, cuando es justo lo que
// uno quiere ver.
const MEJOR_QUE_BAJE = new Set(["sinAtender", "estancados"]);

export function esMejorQueBaje(clave) {
  return MEJOR_QUE_BAJE.has(clave);
}

/**
 * ¿La variación es una buena noticia? true / false / null (sin datos).
 *
 * Se separa del número a propósito: el color de la tarjeta no puede
 * depender del signo, porque en dos de las ocho el signo significa lo
 * contrario.
 */
export function esBuenaNoticia(clave, variacionPct) {
  if (variacionPct == null || variacionPct === 0) return null;
  const subio = variacionPct > 0;
  return esMejorQueBaje(clave) ? !subio : subio;
}

/** Cómo se le muestra la variación a una persona. */
export function textoDeVariacion(variacionPct) {
  if (variacionPct == null) return null;
  const signo = variacionPct > 0 ? "+" : "";
  return `${signo}${variacionPct}%`;
}

/**
 * Las métricas de FOTO, tal como estaban en una fecha pasada.
 *
 * LOS UMBRALES ENTRAN POR PARÁMETRO, y esa es la parte que ya falló una
 * vez. La primera versión los duplicaba acá (48 horas, 30 días) para no
 * importar crm-metricas.js y mantener este módulo puro. Pero los valores
 * de la app eran otros —24 horas y 7 días—, así que el pasado se
 * calculaba con un umbral y el presente con otro: la comparación
 * comparaba dos cosas distintas y daba un porcentaje con toda
 * convicción. No lo agarró ningún test (los tests usaban los mismos
 * números inventados), lo agarró una captura donde el rótulo decía
 * "(+24h)" al lado de un cálculo hecho con 48.
 *
 * Ahora el único lugar donde viven esos números es crm-metricas.js, y
 * quien llama los pasa. Este módulo sigue puro y no puede desincronizarse.
 *
 * Solo están las métricas que se pueden reconstruir con honestidad. Las
 * de plata (valor en pipeline, comisiones) no, a propósito: dependen del
 * precio de cada lote y los lotes no guardan historial de precios, así
 * que el número de hace un mes se calcularía con los precios de hoy.
 *
 * "nuevosEstaSemana" tampoco: es una VENTANA, no una foto, y se compara
 * aparte contra los 7 días anteriores (ver nuevosEnLaVentana).
 */
export function metricasALaFecha(contactos, corte, { horasSinAtender, diasEstancado }) {
  if (!Number.isFinite(horasSinAtender) || !Number.isFinite(diasEstancado)) {
    throw new Error(
      "metricasALaFecha necesita los umbrales (horasSinAtender, diasEstancado) " +
        "de crm-metricas.js: sin ellos el pasado se calcularía con otro criterio que el presente."
    );
  }
  const vivos = contactos
    .map((c) => ({ contacto: c, etapa: etapaEnLaFecha(c, corte) }))
    .filter((x) => x.etapa !== null);

  if (vivos.length === 0) return null;

  const total = vivos.length;
  const cerrados = vivos.filter((x) => x.etapa === "cerrado").length;

  const sinAtender = vivos.filter(({ contacto, etapa }) => {
    if (etapa !== "nuevo") return false;
    if (actividadesHasta(contacto, corte).length > 0) return false;
    const horas = (corte - new Date(contacto.fecha_creacion)) / 3600000;
    return horas >= horasSinAtender;
  }).length;

  const estancados = vivos.filter(({ contacto, etapa }) => {
    if (etapa === "cerrado" || etapa === "perdido") return false;
    // Cuánto hacía que no se movía AL CORTE: la última actividad
    // anterior al corte, o su creación si no había ninguna. No sirve
    // fecha_actualizacion, que solo guarda la ÚLTIMA vez y ya está
    // contaminada por lo que pasó después.
    const actividades = actividadesHasta(contacto, corte);
    const ultima = actividades.length > 0
      ? actividades.reduce((max, a) => (new Date(a.fecha) > new Date(max.fecha) ? a : max)).fecha
      : contacto.fecha_creacion;
    const dias = Math.floor((corte - new Date(ultima)) / 86400000);
    return dias >= diasEstancado;
  }).length;

  return {
    total,
    tasaConversion: total > 0 ? Math.round((cerrados / total) * 100) : null,
    sinAtender,
    estancados
  };
}

/**
 * Cuántos contactos entraron en una ventana de días que termina en una
 * fecha.
 *
 * Para comparar "Nuevos (7 días)" contra los 7 días ANTERIORES, que es
 * la única comparación que significa algo para una métrica de ventana:
 * contra "el mes pasado" serían 7 días contra 30 y el número daría
 * siempre catastrófico.
 */
export function nuevosEnLaVentana(contactos, hasta, dias) {
  const desde = new Date(hasta.getTime() - dias * 86400000);
  return contactos.filter((c) => {
    if (!c.fecha_creacion) return false;
    const nacimiento = new Date(c.fecha_creacion);
    return nacimiento > desde && nacimiento <= hasta;
  }).length;
}
