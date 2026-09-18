// ---------------------------------------------------------------------------
// Tareas: qué hay que hacer, quién lo tiene que hacer y para cuándo.
//
// QUÉ HABÍA ANTES Y POR QUÉ NO ALCANZA. El contacto tiene un campo
// "proximo_seguimiento": UNA fecha, sin responsable propio, sin tipo y
// sin forma de marcarla cumplida que no sea borrarla. Con eso no se
// puede tener "llamarlo el martes" y "mandarle la escritura el viernes"
// con la misma persona, ni saber qué hizo y qué le queda pendiente a
// cada corredor.
//
// CONVIVENCIA TEMPORAL, A PROPÓSITO. "proximo_seguimiento" sigue
// existiendo y sigue alimentando las pantallas de "Seguimientos
// pendientes" del Dashboard y del CRM. Migrarlas a tareas toca el
// formulario del CRM, dos pantallas y unos 17 archivos de test, y se
// decidió no hacerlo a ciegas mientras la suite no pueda correr entera.
// Queda como deuda explícita, no como olvido.
//
// Este módulo es la decisión pura: qué está vencido, qué es de hoy, de
// quién es cada cosa y cómo se ordena. Sin Firestore y sin DOM, para
// poder testear cada regla sin abrir la app.
// ---------------------------------------------------------------------------

export const TIPOS_DE_TAREA = [
  { clave: "llamar", etiqueta: "Llamar", icono: "📞" },
  { clave: "visitar", etiqueta: "Visita", icono: "🚗" },
  { clave: "whatsapp", etiqueta: "WhatsApp", icono: "💬" },
  { clave: "email", etiqueta: "Email", icono: "✉️" },
  { clave: "otro", etiqueta: "Otro", icono: "📌" }
];

export const ETIQUETA_TIPO = Object.fromEntries(TIPOS_DE_TAREA.map((t) => [t.clave, t.etiqueta]));
export const ICONO_TIPO = Object.fromEntries(TIPOS_DE_TAREA.map((t) => [t.clave, t.icono]));

/**
 * Una fecha como texto "AAAA-MM-DD" en hora local. Sin argumento, hoy.
 *
 * Las fechas se comparan como texto y no como Date.
 *
 * POR QUÉ. Una tarea vence un DÍA, no un instante. Con Date, "vence hoy"
 * depende de la hora y de la zona horaria del navegador: una tarea del
 * 18 se vería vencida a las 00:00 en un huso y todavía no en otro. Como
 * texto, el 18 es el 18 en todos lados, que es lo que entiende quien la
 * cargó. Mismo criterio que ya usa el CRM para proximo_seguimiento.
 */
export function diaComoTexto(fecha = new Date()) {
  const desfase = fecha.getTimezoneOffset() * 60000;
  return new Date(fecha.getTime() - desfase).toISOString().slice(0, 10);
}

/**
 * Valida una tarea antes de guardarla.
 *
 * @returns lista de errores en castellano; vacía si está bien.
 */
export function validarTarea(datos = {}) {
  const errores = [];
  if (!(datos.titulo || "").trim()) errores.push("La tarea necesita un título: qué hay que hacer.");
  if (!datos.vence) errores.push("La tarea necesita una fecha de vencimiento.");
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(datos.vence)) errores.push("La fecha tiene que ser una fecha válida.");
  if (datos.tipo && !ETIQUETA_TIPO[datos.tipo]) errores.push(`"${datos.tipo}" no es un tipo de tarea conocido.`);
  return errores;
}

/**
 * Separa las tareas pendientes en vencidas, de hoy y próximas.
 *
 * Las hechas NO entran en ninguno de los tres grupos: una tarea cumplida
 * no es pendiente aunque su fecha ya haya pasado. Se devuelven aparte
 * para poder mostrarlas si alguien las pide.
 */
export function clasificarPorVencimiento(tareas = [], hoy = diaComoTexto()) {
  const grupos = { vencidas: [], hoy: [], proximas: [], hechas: [] };
  for (const tarea of tareas) {
    if (tarea.hecha) grupos.hechas.push(tarea);
    else if (!tarea.vence) grupos.proximas.push(tarea);
    else if (tarea.vence < hoy) grupos.vencidas.push(tarea);
    else if (tarea.vence === hoy) grupos.hoy.push(tarea);
    else grupos.proximas.push(tarea);
  }
  for (const clave of ["vencidas", "hoy", "proximas"]) grupos[clave] = ordenarTareas(grupos[clave]);
  return grupos;
}

/**
 * Lo más urgente primero: por fecha, y a igual fecha por título para que
 * el orden no cambie entre recargas (un orden inestable hace que la
 * lista "salte" y se pierda de vista lo que se estaba mirando).
 */
export function ordenarTareas(tareas = []) {
  return [...tareas].sort((a, b) => {
    const fechaA = a.vence || "9999-12-31";
    const fechaB = b.vence || "9999-12-31";
    if (fechaA !== fechaB) return fechaA < fechaB ? -1 : 1;
    return (a.titulo || "").localeCompare(b.titulo || "");
  });
}

/**
 * Cuántos días de atraso lleva una tarea. 0 si vence hoy o más adelante.
 */
export function diasDeAtraso(tarea = {}, hoy = diaComoTexto()) {
  if (tarea.hecha || !tarea.vence || tarea.vence >= hoy) return 0;
  const ms = new Date(`${hoy}T00:00:00Z`) - new Date(`${tarea.vence}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

/**
 * Resumen por corredor, para saber cómo viene cada uno.
 *
 * Solo cuenta lo PENDIENTE: lo hecho se cuenta aparte, porque mezclarlos
 * daría un número que no dice si alguien está al día o desbordado.
 * Ordena por vencidas primero: quien tiene más atraso es a quien hay que
 * mirar.
 */
export function resumenPorResponsable(tareas = [], hoy = diaComoTexto()) {
  const porUid = new Map();
  for (const tarea of tareas) {
    const uid = tarea.asignado_a || "__sin_asignar__";
    const fila = porUid.get(uid) || {
      uid,
      email: tarea.asignado_email || null,
      vencidas: 0,
      hoy: 0,
      proximas: 0,
      hechas: 0
    };
    if (!fila.email && tarea.asignado_email) fila.email = tarea.asignado_email;
    if (tarea.hecha) fila.hechas += 1;
    else if (!tarea.vence) fila.proximas += 1;
    else if (tarea.vence < hoy) fila.vencidas += 1;
    else if (tarea.vence === hoy) fila.hoy += 1;
    else fila.proximas += 1;
    porUid.set(uid, fila);
  }
  return [...porUid.values()].sort((a, b) => b.vencidas - a.vencidas || b.hoy - a.hoy);
}

/**
 * Texto corto del estado de una tarea, el que se lee en la lista.
 *
 * Se arma acá y no en el HTML para que el plural y los casos borde estén
 * testeados: "vence en 1 días" delata un sistema descuidado en la
 * pantalla que más se mira.
 */
export function textoDeVencimiento(tarea = {}, hoy = diaComoTexto()) {
  if (tarea.hecha) return "Hecha";
  if (!tarea.vence) return "Sin fecha";
  if (tarea.vence === hoy) return "Vence hoy";
  const atraso = diasDeAtraso(tarea, hoy);
  if (atraso === 1) return "Venció ayer";
  if (atraso > 1) return `Vencida hace ${atraso} días`;
  const dias = Math.round((new Date(`${tarea.vence}T00:00:00Z`) - new Date(`${hoy}T00:00:00Z`)) / 86400000);
  return dias === 1 ? "Vence mañana" : `Vence en ${dias} días`;
}
