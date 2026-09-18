// ---------------------------------------------------------------------------
// Historial de precios de un lote.
//
// PARA QUÉ. El Dashboard compara cada métrica contra el mes anterior
// (ver js/comparacion.js), pero tres tarjetas no se pueden comparar:
// "Valor en pipeline", "Comisión proyectada" y "Comisión ganada"
// dependen del precio de cada lote, y hasta ahora un lote solo guardaba
// su precio ACTUAL. El valor de hace un mes tendría que calcularse con
// los precios de hoy: un número que nunca existió, justo en las
// tarjetas que se miran para decidir. Así que no se muestran.
//
// Con este historial, dentro de un mes van a poder mostrarse — y bien.
// Decisión del usuario el 2026-09-18: prefirió empezar a guardarlo antes
// que ver un número aproximado.
//
// POR QUÉ UN ARRAY EN EL LOTE Y NO UNA COLECCIÓN NUEVA. Una subcolección
// necesitaría su propia regla en firestore.rules, que en este proyecto
// se pega A MANO en los dos proyectos de Firebase (no hay CLI). Un array
// en el documento del lote viaja con las reglas que ya existen y con la
// lectura que la app ya hace: cero configuración, cero riesgo de que
// quede a medio publicar en un proyecto y no en el otro.
//
// EL COSTO, y hay que decirlo: los documentos crecen. Un lote al que le
// cambian el precio una vez por mes suma 12 entradas por año, de dos
// campos cada una — irrelevante frente al límite de 1 MB por documento
// de Firestore. Un lote al que se lo editen cien veces por día sería
// otra cosa, pero eso no es lo que hace una inmobiliaria.
//
// Módulo puro: sin Firestore ni DOM, para poder probar la decisión
// sola. Quien guarda es quien ya estaba guardando el lote.
// ---------------------------------------------------------------------------

/**
 * El historial nuevo después de un cambio de precio, o null si no hay
 * nada que registrar.
 *
 * Devuelve null —y no el historial sin cambios— para que quien llama
 * pueda OMITIR el campo del updateDoc: así una edición que no toca el
 * precio no reescribe el array, que es la diferencia entre un historial
 * y una lista de cuántas veces alguien abrió el formulario.
 *
 * `cuando` entra por parámetro (no se lee el reloj acá dentro) para que
 * los tests puedan fijar la fecha.
 */
export function historialTrasCambio(precioAnterior, precioNuevo, historialActual, cuando) {
  const antes = normalizar(precioAnterior);
  const ahora = normalizar(precioNuevo);

  // Sin cambio no se registra nada. Incluye el caso de guardar el
  // formulario sin haber tocado el precio, que es lo más frecuente.
  if (antes === ahora) return null;

  // Un lote que NUNCA tuvo precio y ahora tiene uno: se registra el
  // primero, porque es el punto de partida de cualquier comparación
  // futura. Un lote al que le BORRAN el precio también, porque "dejó de
  // tener precio" es un hecho del negocio (se sacó de la venta).
  const historial = Array.isArray(historialActual) ? [...historialActual] : [];
  historial.push({ precio_usd: ahora, fecha: cuando });
  return historial;
}

/**
 * El precio que tenía un lote en una fecha, según su historial.
 *
 * Devuelve null si en esa fecha no se le conocía precio — que NO es lo
 * mismo que "valía cero". Quien calcule plata con esto tiene que dejar
 * ese lote afuera, no sumarle un cero.
 *
 * SI EL LOTE NO TIENE HISTORIAL devuelve null, aunque tenga precio hoy.
 * Es la decisión importante del módulo: los lotes cargados antes de que
 * esto existiera no tienen pasado, y usar su precio actual como si
 * hubiera sido el de hace un mes es exactamente el número inventado que
 * este historial existe para evitar.
 */
export function precioEnLaFecha(lote, corte) {
  const historial = (lote && lote.historial_precios) || [];
  if (!Array.isArray(historial) || historial.length === 0) return null;

  const previas = historial
    .filter((e) => e && e.fecha && new Date(e.fecha) <= corte)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  if (previas.length === 0) return null;
  return normalizar(previas[previas.length - 1].precio_usd);
}

function normalizar(precio) {
  if (precio === null || precio === undefined || precio === "") return null;
  const numero = Number(precio);
  return Number.isFinite(numero) ? numero : null;
}
