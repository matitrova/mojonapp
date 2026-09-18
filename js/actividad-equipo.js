// ---------------------------------------------------------------------------
// Actividad del equipo: qué hizo cada uno, en qué período.
//
// DE DÓNDE SALE. De la colección "auditoria", que la app viene grabando
// desde hace rato: en producción ya hay 1668 eventos. O sea que esta
// pantalla nace con historial de verdad en vez de vacía, sin pedir ningún
// dato nuevo.
//
// POR QUÉ NO ES LA PANTALLA DE AUDITORÍA. La auditoría es un registro
// técnico: una línea por evento, en orden, para responder "quién borró
// esto". Sirve para investigar, no para dirigir. Lo que le falta a quien
// tiene empleados es lo contrario: no el detalle de cada evento sino el
// resumen de cada persona, y separando el trabajo comercial del
// mantenimiento. Las dos pantallas leen lo mismo y contestan preguntas
// distintas.
//
// LAS CATEGORÍAS SON UNA OPINIÓN, y conviene que se vea. Cargar un lote
// es trabajo de cartera; mover un contacto de etapa es trabajo de venta;
// renombrar una zona es mantenimiento. Meter todo en un solo número
// diría que quien pasó el día renombrando zonas trabajó igual que quien
// cerró una venta.
//
// Módulo puro: recibe los eventos ya leídos, no toca Firestore ni el DOM.
// ---------------------------------------------------------------------------

// Mismo criterio de "día y no instante" que las tareas: un evento pasó un
// día, y con husos horarios de por medio comparar instantes haría que la
// actividad de anoche apareciera o no en "hoy" según la hora en que se
// mire. Ver el comentario de diaComoTexto en js/tareas.js.
import { diaComoTexto } from "./tareas.js";

export const CATEGORIAS = [
  { clave: "venta", etiqueta: "Venta" },
  { clave: "cartera", etiqueta: "Cartera" },
  { clave: "tareas", etiqueta: "Tareas" },
  { clave: "mantenimiento", etiqueta: "Mantenimiento" }
];

export const ETIQUETA_CATEGORIA = Object.fromEntries(CATEGORIAS.map((c) => [c.clave, c.etiqueta]));

// A qué categoría pertenece cada acción auditada. Lo que no esté acá cae
// en "mantenimiento": es preferible subestimar el trabajo comercial de
// alguien a inflarlo con acciones que nadie clasificó.
const CATEGORIA_POR_ACCION = {
  crear_contacto: "venta",
  editar_contacto: "venta",
  borrar_contacto: "venta",
  mover_contacto: "venta",
  vender_lote: "venta",
  reservar_lote: "venta",
  quitar_reserva: "venta",

  crear_lote: "cartera",
  editar_lote: "cartera",
  editar_lotes_en_masa: "cartera",
  borrar_lote: "cartera",

  crear_tarea: "tareas",
  editar_tarea: "tareas",
  completar_tarea: "tareas",
  reabrir_tarea: "tareas",
  borrar_tarea: "tareas"
};

export function categoriaDe(accion) {
  return CATEGORIA_POR_ACCION[accion] || "mantenimiento";
}

/**
 * El día de un evento, como texto AAAA-MM-DD en hora local.
 *
 * Acepta lo que devuelve Firestore (un Timestamp con toDate), una fecha
 * ISO o un Date. Un evento sin fecha devuelve null en vez de inventarle
 * una: los eventos recién escritos pueden llegar con el serverTimestamp
 * todavía sin resolver.
 */
export function diaDelEvento(evento = {}) {
  const cruda = evento.fecha;
  if (!cruda) return null;
  const fecha = typeof cruda?.toDate === "function" ? cruda.toDate() : new Date(cruda);
  if (Number.isNaN(fecha.getTime())) return null;
  return diaComoTexto(fecha);
}

/**
 * Los eventos de los últimos N días, contando hoy.
 *
 * dias = 1 es "hoy". Los eventos sin fecha quedan afuera: no se puede
 * afirmar que sean de este período.
 */
export function eventosDelPeriodo(eventos = [], dias = 1, hoy = diaComoTexto()) {
  const desde = new Date(`${hoy}T00:00:00Z`);
  desde.setUTCDate(desde.getUTCDate() - (dias - 1));
  const limite = desde.toISOString().slice(0, 10);
  return eventos.filter((evento) => {
    const dia = diaDelEvento(evento);
    return dia !== null && dia >= limite;
  });
}

/**
 * Qué hizo cada persona, por categoría.
 *
 * Ordena por total descendente. Quien no hizo nada en el período no
 * aparece: una fila en cero por cada corredor inactivo llena la pantalla
 * de nada. Si hace falta saber quién no trabajó, eso se ve en la lista de
 * usuarios, no acá.
 */
export function resumenPorPersona(eventos = []) {
  const porPersona = new Map();
  for (const evento of eventos) {
    const quien = evento.usuario_email || "Sin identificar";
    const fila = porPersona.get(quien) || {
      persona: quien,
      total: 0,
      ...Object.fromEntries(CATEGORIAS.map((c) => [c.clave, 0]))
    };
    fila[categoriaDe(evento.accion)] += 1;
    fila.total += 1;
    porPersona.set(quien, fila);
  }
  return [...porPersona.values()].sort((a, b) => b.total - a.total || a.persona.localeCompare(b.persona));
}

/**
 * Cuántos eventos hubo cada día del período, del más viejo al más nuevo.
 *
 * Incluye los días SIN actividad, con cero. Saltearlos haría que una
 * semana con un solo día de trabajo se viera como una semana pareja, que
 * es justo lo contrario de lo que se quiere ver.
 */
export function actividadPorDia(eventos = [], dias = 7, hoy = diaComoTexto()) {
  const conteo = new Map();
  for (const evento of eventos) {
    const dia = diaDelEvento(evento);
    if (dia) conteo.set(dia, (conteo.get(dia) || 0) + 1);
  }
  const filas = [];
  for (let i = dias - 1; i >= 0; i--) {
    const fecha = new Date(`${hoy}T00:00:00Z`);
    fecha.setUTCDate(fecha.getUTCDate() - i);
    const dia = fecha.toISOString().slice(0, 10);
    filas.push({ dia, cantidad: conteo.get(dia) || 0 });
  }
  return filas;
}

/**
 * Una línea en castellano de lo que hizo una persona, para leer de un
 * vistazo sin interpretar cuatro números.
 *
 * Se arma acá y no en el HTML para que los plurales y el caso "no hizo
 * nada de eso" estén testeados.
 */
export function resumenEnPalabras(fila = {}) {
  const partes = [];
  if (fila.venta) partes.push(`${fila.venta} ${fila.venta === 1 ? "movimiento de venta" : "movimientos de venta"}`);
  if (fila.cartera) partes.push(`${fila.cartera} ${fila.cartera === 1 ? "cambio en la cartera" : "cambios en la cartera"}`);
  if (fila.tareas) partes.push(`${fila.tareas} ${fila.tareas === 1 ? "tarea" : "tareas"}`);
  if (fila.mantenimiento) partes.push(`${fila.mantenimiento} de mantenimiento`);
  return partes.length ? partes.join(", ") : "Sin actividad";
}
