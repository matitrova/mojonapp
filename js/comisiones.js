// ---------------------------------------------------------------------------
// Comisiones: cuánto deja de ganancia la cartera y el pipeline.
//
// PARA QUÉ. El valor del pipeline ya se mostraba (ver
// valorPotencialContacto en crm-metricas.js), pero el valor no es lo que
// gana la inmobiliaria: de USD 90.000 en lotes, la inmobiliaria ve su
// porcentaje. Es la cifra que mira quien es dueño del negocio, y era la
// única de la lista de módulos que no existía en ninguna parte del código.
//
// EL PORCENTAJE ES POR LOTE, CON UNO GENERAL DE RESPALDO (decisión del
// usuario). Un lote puede traer su propio "comision_pct" —hay loteos que
// pagan distinto— y si no lo trae, se usa COMISION_PCT_POR_DEFECTO.
//
// NO SE PONDERA POR PROBABILIDAD, A PROPÓSITO. Un CRM grande multiplica
// cada oportunidad por una probabilidad según su etapa (visita 40%,
// oferta 70%...). Acá no, porque esas probabilidades habría que
// inventarlas: no hay historia todavía para calcularlas y serían números
// de adorno con aire de precisión. Mismo criterio que el resto de la app
// (ver valorPotencialContacto: "sin precio no aporta nada, no se inventa
// un valor"). Cuando haya suficientes contactos cerrados, la tasa real
// por etapa se puede calcular con js/embudo.js y recién entonces
// ponderar significa algo.
//
// Módulo puro y sin efectos: no lee del DOM ni de Firestore, recibe los
// datos por parámetro. Así cada regla se testea sin abrir la app.
// ---------------------------------------------------------------------------

// Porcentaje que se usa cuando el lote no tiene uno propio.
//
// OJO: 4% es un valor a confirmar con el usuario, no un dato relevado.
// Se eligió para poder mostrar la cifra; si el número real es otro, se
// cambia acá y cambia en toda la app.
export const COMISION_PCT_POR_DEFECTO = 4;

// Etapas en las que la venta todavía puede pasar. "cerrado" quedó afuera
// porque ya pasó (su comisión se cuenta aparte, como ganada) y "perdido"
// porque no va a pasar.
export const ETAPAS_ABIERTAS = ["nuevo", "contactado", "visita", "oferta"];

/**
 * Porcentaje que le corresponde a un lote.
 *
 * Acepta 0 como valor válido (un lote que no paga comisión), por eso se
 * pregunta por null/undefined y no por "si es falsy": con `||` un 0
 * caería en el porcentaje general y mostraría una comisión que no existe.
 */
export function pctDelLote(propiedades = {}) {
  const propio = propiedades.comision_pct;
  return propio === null || propio === undefined ? COMISION_PCT_POR_DEFECTO : Number(propio);
}

/**
 * Comisión en dólares de un lote. Sin precio cargado no hay comisión que
 * calcular: devuelve 0 en vez de inventar un precio.
 */
export function comisionDeUnLote(propiedades = {}) {
  const precio = propiedades.precio_usd;
  if (precio === null || precio === undefined) return 0;
  return (Number(precio) * pctDelLote(propiedades)) / 100;
}

/**
 * Comisión proyectada de un contacto: la suma de la de cada lote que le
 * interesa.
 *
 * @param contacto el contacto, con su array lotes_interes
 * @param propiedadesPorId Map de id de lote -> properties del lote
 */
export function comisionDeContacto(contacto = {}, propiedadesPorId = new Map()) {
  return (contacto.lotes_interes || []).reduce((total, lote) => {
    const propiedades = propiedadesPorId.get(lote.id);
    return total + (propiedades ? comisionDeUnLote(propiedades) : 0);
  }, 0);
}

/**
 * Las dos cifras que importan, juntas.
 *
 * enPipeline: lo que se puede ganar si se cierran los contactos que
 *   siguen vivos. Es una proyección.
 * cerrada: lo que YA se ganó, de los contactos en etapa "cerrado". No es
 *   una proyección, y por eso se muestra aparte: mezclarlas daría un
 *   número más grande y menos cierto.
 */
export function resumenDeComisiones(contactos = [], propiedadesPorId = new Map()) {
  let enPipeline = 0;
  let cerrada = 0;
  for (const contacto of contactos) {
    const comision = comisionDeContacto(contacto, propiedadesPorId);
    if (contacto.estado === "cerrado") cerrada += comision;
    else if (ETAPAS_ABIERTAS.includes(contacto.estado)) enPipeline += comision;
  }
  return { enPipeline, cerrada };
}

/**
 * Comisión de toda la cartera: lo que dejaría vender todo lo que está
 * disponible. Sirve para dimensionar el negocio, aparte del pipeline.
 */
export function comisionDeLaCartera(lotes = []) {
  return lotes
    .filter((f) => f.properties?.estado === "disponible")
    .reduce((total, f) => total + comisionDeUnLote(f.properties), 0);
}
