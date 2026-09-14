// ---------------------------------------------------------------------------
// CRM — constantes y lógica pura: nada de esto toca Firestore ni el DOM,
// así que se puede probar en aislado (ver tests/test_crm_calificacion.py,
// test_crm_atencion.py, test_crm_valor_pipeline.py, test_crm_round_robin.py).
// Extraído de crm.js (que había crecido a 1643 líneas) como primera etapa
// de la modularización — ver el plan en curso, mismo criterio ya usado
// para separar geometria.js de app.js: funciones puras primero, menor
// riesgo, sin dependencias hacia el resto del CRM.
// ---------------------------------------------------------------------------

import { getLotesActuales } from "./estado.js";

// Un color por etapa (variables CSS, ver estilos.css) — pintan el borde de
// arriba de cada columna y el borde izquierdo de cada tarjeta, mismo
// lenguaje visual que cualquier CRM real (Pipedrive, HubSpot): se
// distingue la etapa de un vistazo, sin tener que leer el texto. Reusan
// colores que YA existen en la app para "visita"/"oferta"/"cerrado"/
// "perdido" porque significan casi lo mismo que ya significan ahí
// (oferta = decisión pendiente, como una reserva; cerrado = éxito, como
// un lote disponible; perdido = una pérdida, como un lote vendido a
// otro) — "nuevo"/"contactado" son los dos únicos tonos nuevos.
export const ETAPAS = [
  { clave: "nuevo", etiqueta: "Nuevo", color: "var(--crm-nuevo)" },
  { clave: "contactado", etiqueta: "Contactado", color: "var(--crm-contactado)" },
  { clave: "visita", etiqueta: "Visita", color: "var(--crm-visita)" },
  { clave: "oferta", etiqueta: "Oferta", color: "var(--crm-oferta)" },
  { clave: "cerrado", etiqueta: "Cerrado", color: "var(--crm-cerrado)" },
  { clave: "perdido", etiqueta: "Perdido", color: "var(--crm-perdido)" }
];
export const ETIQUETA_ETAPA = Object.fromEntries(ETAPAS.map((e) => [e.clave, e.etiqueta]));
export const COLOR_ETAPA = Object.fromEntries(ETAPAS.map((e) => [e.clave, e.color]));

export const ETIQUETA_ACTIVIDAD = {
  nota: "📝 Nota",
  llamada: "📞 Llamada",
  whatsapp: "💬 WhatsApp",
  visita: "🚗 Visita",
  email: "✉️ Email"
};

// Sin actualizarse en más de esta cantidad de días (y sin estar ya
// cerrado/perdido), un contacto se marca "estancado" — mismo espíritu que
// "Reservas por vencer" del Dashboard: hacer visible lo que se está
// enfriando antes de que se pierda solo por no haberlo mirado.
export const DIAS_ESTANCADO = 7;

// "Control de tiempos de atención" (idea propia, investigada en las
// funcionalidades de Tokko Broker antes de armarla — ver
// feedback_buscar_inspiracion_real: "Módulo de oportunidades... te
// permite... controlar los tiempos de atención"). Distinto de
// "estancado" (que mide silencio DESPUÉS de haber arrancado la
// gestión): esto mide el momento más crítico de todos — un lead nuevo
// que todavía NADIE llamó ni escribió. Deja de contar en cuanto tiene
// una primera actividad registrada, sea cual sea.
export const HORAS_SIN_ATENDER = 24;

// Iniciales + color de avatar determinístico a partir del nombre —
// mismo criterio que Trello/Asana: cada persona tiene un color estable
// sin necesidad de guardarlo a mano por contacto.
const PALETA_AVATAR = ["#33523a", "#c1663f", "#4f7cac", "#8a6d3b", "#6b5b95", "#3f7a5c", "#a1477a", "#5c7f3f"];

export function colorAvatar(texto) {
  let hash = 0;
  for (let i = 0; i < texto.length; i++) hash = (hash * 31 + texto.charCodeAt(i)) >>> 0;
  return PALETA_AVATAR[hash % PALETA_AVATAR.length];
}

export function iniciales(nombre) {
  const partes = (nombre || "").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------
// WhatsApp: heurística de mejor esfuerzo para armar un link wa.me a partir
// de un teléfono cargado a mano, sin ningún formato fijo (con o sin 0/15,
// con o sin código de área, con o sin "54"). No hay forma 100% confiable de
// adivinar esto sin pedirle el celular real al usuario — se prioriza que
// funcione para el caso común (número argentino tal cual lo escribe un
// corredor) antes que una validación estricta.
// ---------------------------------------------------------------------------

export function normalizarTelefonoWhatsapp(telefono) {
  const soloDigitos = (telefono || "").replace(/\D/g, "");
  if (!soloDigitos) return null;
  if (soloDigitos.startsWith("54")) return soloDigitos;
  if (soloDigitos.startsWith("9")) return `54${soloDigitos}`;
  return `549${soloDigitos}`;
}

export function linkWhatsapp(telefono) {
  const numero = normalizarTelefonoWhatsapp(telefono);
  return numero ? `https://wa.me/${numero}` : null;
}

export function estaEstancado(contacto) {
  if (contacto.estado === "cerrado" || contacto.estado === "perdido") return false;
  const fecha = contacto.fecha_actualizacion || contacto.fecha_creacion;
  if (!fecha) return false;
  const dias = Math.floor((Date.now() - new Date(fecha).getTime()) / 86400000);
  return dias >= DIAS_ESTANCADO;
}

export function estaSinAtender(contacto) {
  if (contacto.estado !== "nuevo") return false;
  if ((contacto.actividades || []).length > 0) return false;
  if (!contacto.fecha_creacion) return false;
  const horas = (Date.now() - new Date(contacto.fecha_creacion).getTime()) / 3600000;
  return horas >= HORAS_SIN_ATENDER;
}

// Última actividad, para el resumen de una línea en la tarjeta del
// kanban (mismo criterio que Pipedrive/HubSpot: ver de un vistazo qué
// fue lo último que pasó, sin tener que abrir el contacto).
export function ultimaActividad(contacto) {
  const actividades = contacto.actividades || [];
  if (actividades.length === 0) return null;
  return [...actividades].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""))[0];
}

// Calificación de contactos (idea propia — módulo #2 del listado para
// competir con Tokko, investigado en KiteProp/otros comparativas de
// CRM inmobiliario antes de armarla: "calificación automática de
// contactos" aparece como una funcionalidad que ni Tokko ofrece hoy).
// Un puntaje simple de 5 señales, sin nada de IA — cuántas más de estas
// cosas ciertas tenga el contacto, más "caliente" está:
//   1) tiene teléfono cargado (se lo puede contactar de verdad)
//   2) tiene alguna actividad registrada (ya se lo atendió una vez)
//   3) esa actividad fue hace 3 días o menos (sigue fresco)
//   4) tiene 2 o más lotes de interés (está comparando en serio)
//   5) no está ni "estancado" ni "sin atender" (la gestión va sana)
// No tiene sentido calificar un contacto ya resuelto (cerrado/perdido)
// — la calificación es para decidir A QUIÉN LLAMAR primero, no para
// evaluar el pasado.
export function calificacionContacto(contacto) {
  if (contacto.estado === "cerrado" || contacto.estado === "perdido") return null;

  let puntos = 0;
  if (contacto.telefono) puntos++;
  const ultima = ultimaActividad(contacto);
  if (ultima) {
    puntos++;
    const diasUltima = Math.floor((Date.now() - new Date(ultima.fecha).getTime()) / 86400000);
    if (diasUltima <= 3) puntos++;
  }
  if ((contacto.lotes_interes || []).length >= 2) puntos++;
  if (!estaEstancado(contacto) && !estaSinAtender(contacto)) puntos++;

  if (puntos >= 4) return { nivel: "caliente", etiqueta: "🔥 Caliente" };
  if (puntos >= 2) return { nivel: "tibio", etiqueta: "🌤️ Tibio" };
  return { nivel: "frio", etiqueta: "❄️ Frío" };
}

// Reparto automático de interesados nuevos entre el equipo (idea de
// Tokko: "asignación automática de consultas") — separada del resto de
// siguienteAsignado() (que sí vive en crm-datos.js, porque necesita leer
// Firestore) para poder probar la parte que realmente importa que ande
// bien — elegir quién tiene menos carga — sin depender de qué corredores
// reales existan en este proyecto.
export function elegirMenosCargado(cargaPorUid) {
  const uids = Object.keys(cargaPorUid);
  if (uids.length === 0) return null;
  return [...uids].sort((a, b) => cargaPorUid[a] - cargaPorUid[b])[0];
}

// Valor potencial de un contacto (idea propia, mismo lenguaje que
// Pipedrive/HubSpot: cada columna del pipeline muestra cuánto dinero
// representa, no solo cuántas tarjetas hay — "3 contactos" dice mucho
// menos que "3 contactos, USD 90.000"). Se suma el precio de cada lote
// de interés (los que tengan precio cargado; sin precio no aporta nada,
// no se inventa un valor). Puede sumar el mismo lote más de una vez
// entre distintos contactos — a propósito: cada uno es una oportunidad
// de venta independiente, no una reserva real todavía.
export function valorPotencialContacto(contacto) {
  const lotesPorId = new Map(getLotesActuales().map((f) => [f.id, f.properties]));
  return (contacto.lotes_interes || []).reduce((total, l) => {
    const precio = lotesPorId.get(l.id)?.precio_usd;
    return total + (precio || 0);
  }, 0);
}

export function formatoUsdCompacto(valor) {
  return valor > 0 ? `USD ${Math.round(valor).toLocaleString("es-AR")}` : null;
}

// ---------------------------------------------------------------------------
// Métricas rápidas: de un vistazo, sin tener que contar tarjetas a mano.
// ---------------------------------------------------------------------------

export function calcularMetricas(contactos) {
  const hace7Dias = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const total = contactos.length;
  const nuevosEstaSemana = contactos.filter((c) => (c.fecha_creacion || "").slice(0, 10) >= hace7Dias).length;
  const cerrados = contactos.filter((c) => c.estado === "cerrado").length;
  const tasaConversion = total > 0 ? Math.round((cerrados / total) * 100) : null;
  const estancados = contactos.filter(estaEstancado).length;
  const sinAtender = contactos.filter(estaSinAtender).length;
  // Solo lo que sigue en juego — cerrado ya se ganó, perdido ya se
  // perdió, ninguno de los dos es "pipeline" en el sentido de "todavía
  // por definir".
  const valorPipelineActivo = contactos
    .filter((c) => c.estado !== "cerrado" && c.estado !== "perdido")
    .reduce((total, c) => total + valorPotencialContacto(c), 0);
  return { total, nuevosEstaSemana, tasaConversion, estancados, sinAtender, valorPipelineActivo };
}

// ---------------------------------------------------------------------------
// Matching lote↔interesado por reglas simples (idea propia, investigada
// en varios CRM inmobiliarios antes de armarla: todos plantean esto con
// un LLM y un formulario aparte de "presupuesto/preferencias" del
// contacto — acá se infiere el perfil directo de los lotes que YA marcó
// como interés, sin pedirle nada nuevo a nadie ni depender de una API
// paga. Cero costo, funciona con los datos que ya existen.
// ---------------------------------------------------------------------------

function promedio(numeros) {
  return numeros.reduce((suma, n) => suma + n, 0) / numeros.length;
}

function valorMasFrecuente(valores) {
  if (valores.length === 0) return null;
  const conteos = new Map();
  valores.forEach((v) => conteos.set(v, (conteos.get(v) || 0) + 1));
  return [...conteos.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// lotesInteres: array de {id, titulo} (mismo formato que contacto.
// lotes_interes) — se pasa suelto en vez de un contacto entero para que
// sirva tanto con un contacto ya guardado como con el borrador que se
// está armando en el formulario (todavía sin id de documento).
export function lotesSugeridos(lotesInteres, limite = 5) {
  const interes = (lotesInteres || [])
    .map((li) => getLotesActuales().find((f) => f.id === li.id))
    .filter(Boolean);
  if (interes.length === 0) return [];

  const zonaFrecuente = valorMasFrecuente(interes.map((f) => f.properties.sector).filter(Boolean));
  const precios = interes.map((f) => f.properties.precio_usd).filter((v) => v != null);
  const superficies = interes.map((f) => f.properties.superficie_m2).filter((v) => v != null);
  const precioRef = precios.length > 0 ? promedio(precios) : null;
  const superficieRef = superficies.length > 0 ? promedio(superficies) : null;

  const yaVistos = new Set(interes.map((f) => f.id));
  const candidatos = getLotesActuales().filter((f) => f.properties.estado === "disponible" && !yaVistos.has(f.id));

  return candidatos
    .map((f) => {
      const p = f.properties;
      let puntos = 0;
      const motivos = [];
      if (zonaFrecuente && p.sector === zonaFrecuente) {
        puntos += 3;
        motivos.push("misma zona");
      }
      if (precioRef != null && p.precio_usd != null) {
        const diferencia = Math.abs(p.precio_usd - precioRef) / precioRef;
        if (diferencia <= 0.15) {
          puntos += 2;
          motivos.push("precio similar");
        } else if (diferencia <= 0.3) {
          puntos += 1;
        }
      }
      if (superficieRef != null && p.superficie_m2 != null) {
        const diferencia = Math.abs(p.superficie_m2 - superficieRef) / superficieRef;
        if (diferencia <= 0.2) {
          puntos += 2;
          motivos.push("superficie similar");
        } else if (diferencia <= 0.4) {
          puntos += 1;
        }
      }
      return { feature: f, puntos, motivos };
    })
    .filter((x) => x.puntos > 0)
    .sort((a, b) => b.puntos - a.puntos)
    .slice(0, limite);
}
