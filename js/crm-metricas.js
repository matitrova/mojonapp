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
import { resumenDeComisiones } from "./comisiones.js";
// Las variaciones "vs. mes anterior" de las tarjetas. comparacion.js es
// puro (no lee estado global) justamente para poder probarse solo; lo
// que necesita el estado se arma acá, en variacionesDelMes.
import {
  cierreDelMesAnterior,
  esBuenaNoticia,
  metricasALaFecha,
  nuevosEnLaVentana,
  textoDeVariacion,
  variacion
} from "./comparacion.js";

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
  email: "✉️ Email",
  cambio_etapa: "🔄 Cambio de etapa",
  lote_agregado: "📍 Lote agregado",
  lote_quitado: "📍 Lote quitado",
  contacto_creado: "✨ Contacto creado"
};

export const TIPOS_ACTIVIDAD_AUTOMATICA = ["cambio_etapa", "lote_agregado", "lote_quitado", "contacto_creado"];

export function actividadesAutomaticas(contactoPrevio, datosNuevos, autorEmail) {
  const actividades = [];
  const fecha = new Date().toISOString();

  if (contactoPrevio.estado !== datosNuevos.estado) {
    const etapaAnterior = ETIQUETA_ETAPA[contactoPrevio.estado] || contactoPrevio.estado;
    const etapaNueva = ETIQUETA_ETAPA[datosNuevos.estado] || datosNuevos.estado;
    actividades.push({
      tipo: "cambio_etapa",
      texto: `${etapaAnterior} → ${etapaNueva}`,
      // Las CLAVES, además del texto. El texto es para que una persona
      // lea el historial; estas dos son para poder calcular el embudo
      // (ver js/embudo.js) sin volver a parsear castellano. Antes solo
      // quedaba el texto, así que medir la conversión entre etapas
      // dependía de partir "Nuevo → Contactado" por la flecha y buscar
      // cada mitad en la tabla de etiquetas: andaba, pero se rompía
      // solo con renombrar una etapa.
      etapa_desde: contactoPrevio.estado,
      etapa_hasta: datosNuevos.estado,
      fecha,
      autor_email: autorEmail
    });
  }

  const lotesPrevios = contactoPrevio.lotes_interes || [];
  const lotesNuevos = datosNuevos.lotes_interes || [];
  const idsPrevios = lotesPrevios.map((l) => l.id);
  const idsNuevos = lotesNuevos.map((l) => l.id);

  for (const lote of lotesNuevos) {
    if (!idsPrevios.includes(lote.id)) {
      actividades.push({ tipo: "lote_agregado", texto: lote.titulo || lote.id, fecha, autor_email: autorEmail });
    }
  }
  for (const lote of lotesPrevios) {
    if (!idsNuevos.includes(lote.id)) {
      actividades.push({ tipo: "lote_quitado", texto: lote.titulo || lote.id, fecha, autor_email: autorEmail });
    }
  }

  return actividades;
}

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

// "mensaje" es opcional (compatible con el uso ya existente, el botón
// "💬 WhatsApp" que abre el chat en blanco) — wa.me ya soporta precargar
// el texto con ?text=, sin necesitar la API de WhatsApp Business.
export function linkWhatsapp(telefono, mensaje) {
  const numero = normalizarTelefonoWhatsapp(telefono);
  if (!numero) return null;
  const base = `https://wa.me/${numero}`;
  return mensaje ? `${base}?text=${encodeURIComponent(mensaje)}` : base;
}

// Plantillas de mensaje con datos precargados (idea propia — versión
// gratis de los "envíos automáticos" de Tokko Broker: sin API paga,
// alcanza con armar el texto y dejar que wa.me lo precargue). Recibe un
// objeto liviano en vez de un contacto completo de Firestore, para que
// también sirva con el borrador que se está completando en el
// formulario (todavía sin guardar, sin id). "Recordatorio de visita"
// solo aparece con etapa "Visita" Y fecha agendada — sin eso no hay
// nada real que confirmar.
export function plantillasMensaje({ nombre, lotesInteres, estado, proximoSeguimiento }) {
  const saludo = `Hola${(nombre || "").trim() ? ` ${nombre.trim()}` : ""}!`;
  const lote = (lotesInteres || [])[0]?.titulo || null;
  const plantillas = [
    {
      id: "seguimiento",
      etiqueta: "Seguimiento",
      texto: lote
        ? `${saludo} Te escribo para saber si seguís interesado en ${lote}. ¿Charlamos?`
        : `${saludo} Te escribo para retomar contacto. ¿Cómo estás?`
    },
    {
      id: "bienvenida",
      etiqueta: "Primer contacto",
      texto: lote
        ? `${saludo} Gracias por tu interés en ${lote}. Cualquier duda, estoy a disposición.`
        : `${saludo} Gracias por contactarte. Cualquier duda, estoy a disposición.`
    }
  ];
  if (estado === "visita" && proximoSeguimiento) {
    const fecha = new Date(`${proximoSeguimiento}T00:00:00`).toLocaleDateString("es-AR");
    plantillas.push({
      id: "recordatorio_visita",
      etiqueta: "Recordatorio de visita",
      texto: `${saludo} Te confirmo la visita${lote ? ` a ${lote}` : ""} para el ${fecha}. Cualquier cambio, avisame.`
    });
  }
  return plantillas;
}

export function estaEstancado(contacto) {
  if (contacto.estado === "cerrado" || contacto.estado === "perdido") return false;
  const fecha = contacto.fecha_actualizacion || contacto.fecha_creacion;
  if (!fecha) return false;
  const dias = Math.floor((Date.now() - new Date(fecha).getTime()) / 86400000);
  return dias >= DIAS_ESTANCADO;
}

// "Vigencia" (idea de Tokko Broker, columna del mismo nombre en su tabla
// de Oportunidades) — versión propia como porcentaje/nivel en vez de un
// dato fijo, para poder pintarla como barra sin depender de un campo
// nuevo en Firestore: reusa el mismo "días desde la última actualización"
// que ya usa estaEstancado, solo expresado como progreso hacia ese mismo
// umbral en vez de un booleano. No aplica a cerrado/perdido (ya resueltos,
// mismo criterio de exclusión que calificacionContacto).
export function vigenciaContacto(contacto) {
  if (contacto.estado === "cerrado" || contacto.estado === "perdido") return null;
  const fecha = contacto.fecha_actualizacion || contacto.fecha_creacion;
  if (!fecha) return null;
  const dias = Math.floor((Date.now() - new Date(fecha).getTime()) / 86400000);
  const porcentaje = Math.min(100, Math.round((dias / DIAS_ESTANCADO) * 100));
  const nivel = porcentaje < 50 ? "fresco" : porcentaje < 100 ? "atencion" : "vencido";
  return { porcentaje, nivel };
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
  // Lo mismo que el valor del pipeline, pero en plata de la
  // inmobiliaria: de USD 90.000 en lotes, lo que se cobra es el
  // porcentaje. Va aparte de "valorPipelineActivo" y no lo reemplaza —
  // el valor sirve para dimensionar la operación y la comisión para
  // dimensionar el negocio propio (ver js/comisiones.js).
  const propiedadesPorId = new Map(getLotesActuales().map((f) => [f.id, f.properties]));
  const { enPipeline, cerrada } = resumenDeComisiones(contactos, propiedadesPorId);
  return {
    total,
    nuevosEstaSemana,
    tasaConversion,
    estancados,
    sinAtender,
    valorPipelineActivo,
    comisionEnPipeline: enPipeline,
    comisionCerrada: cerrada
  };
}

// Template de las 6 tarjetas de métricas — usado tanto por "#crm-stats"
// (panel CRM, ver renderStats en crm.js) como por "Ventas" en el
// Dashboard (ver renderVentas en dashboard.js): mismo número, mismo
// lugar de un solo lado, ya no dos templates iguales mantenidos a mano
// por separado.
// La variación de una tarjeta, o nada.
//
// NADA Y NO "0%" NI UN GUION cuando no hay con qué comparar (la base
// recién arranca, o el valor anterior era cero): un 0% se lee como "no
// cambió nada", que es una afirmación, y acá no sabemos. Ver variacion()
// en js/comparacion.js.
//
// El color NO sale del signo: en "Sin atender" y "Estancados" bajar es
// la buena noticia (esBuenaNoticia decide).
function htmlVariacion(clave, variaciones, leyenda) {
  if (!variaciones) return "";
  const pct = variaciones[clave];
  const texto = textoDeVariacion(pct);
  if (texto == null) return "";
  const bueno = esBuenaNoticia(clave, pct);
  const clase = bueno === null ? "neutra" : bueno ? "buena" : "mala";
  return `<em class="crm-stat-variacion ${clase}">${texto} <span>${leyenda}</span></em>`;
}

/**
 * Las 8 tarjetas de métricas.
 *
 * `variaciones` es opcional: sin él las tarjetas se dibujan como antes.
 * Las tres de plata no llevan variación a propósito — dependen del
 * precio de cada lote y el historial de precios recién empezó a
 * guardarse (ver js/historial-precios.js), así que todavía no hay un
 * mes con el que comparar. Calcularlas con los precios de hoy daría un
 * número que nunca existió, justo en las tarjetas que se miran para
 * decidir.
 */
export function htmlResumenVentas(m, variaciones = null) {
  const vsMes = "vs. mes anterior";
  return `
    <div class="crm-stat"><strong>${m.total}</strong><span>Contactos</span>${htmlVariacion("total", variaciones, vsMes)}</div>
    <div class="crm-stat"><strong>${m.nuevosEstaSemana}</strong><span>Nuevos (7 días)</span>${htmlVariacion("nuevosEstaSemana", variaciones, "vs. semana anterior")}</div>
    <div class="crm-stat"><strong>${m.tasaConversion == null ? "—" : `${m.tasaConversion}%`}</strong><span>Conversión a cerrado</span>${htmlVariacion("tasaConversion", variaciones, vsMes)}</div>
    <div class="crm-stat crm-stat-urgente"><strong>${m.sinAtender}</strong><span>Sin atender (+${HORAS_SIN_ATENDER}h)</span>${htmlVariacion("sinAtender", variaciones, vsMes)}</div>
    <div class="crm-stat"><strong>${m.estancados}</strong><span>Estancados (+${DIAS_ESTANCADO}d)</span>${htmlVariacion("estancados", variaciones, vsMes)}</div>
    <div class="crm-stat crm-stat-valor"><strong>${formatoUsdCompacto(m.valorPipelineActivo) || "—"}</strong><span>Valor en pipeline</span></div>
    <div class="crm-stat crm-stat-comision"><strong>${formatoUsdCompacto(m.comisionEnPipeline) || "—"}</strong><span>Comisión proyectada</span></div>
    <div class="crm-stat crm-stat-comision-ganada"><strong>${formatoUsdCompacto(m.comisionCerrada) || "—"}</strong><span>Comisión ganada</span></div>
  `;
}

/**
 * Las variaciones de las 5 tarjetas que se pueden comparar con
 * honestidad, o null si todavía no hay pasado con qué comparar.
 *
 * Vive acá y no en comparacion.js porque necesita calcularMetricas (el
 * valor de HOY); comparacion.js se queda puro, sin leer estado global,
 * para poder probarse solo.
 */
export function variacionesDelMes(contactos, ahora = new Date()) {
  const corte = cierreDelMesAnterior(ahora);
  // Los umbrales van de acá, que es donde viven: si se duplicaran en
  // comparacion.js, el pasado se calcularía con otro criterio que el
  // presente y la comparación mediría dos cosas distintas. Ya pasó.
  const antes = metricasALaFecha(contactos, corte, {
    horasSinAtender: HORAS_SIN_ATENDER,
    diasEstancado: DIAS_ESTANCADO
  });
  if (!antes) return null;

  const hoy = calcularMetricas(contactos);
  const ventanaAnterior = new Date(ahora.getTime() - 7 * 86400000);
  return {
    total: variacion(hoy.total, antes.total),
    tasaConversion: variacion(hoy.tasaConversion, antes.tasaConversion),
    sinAtender: variacion(hoy.sinAtender, antes.sinAtender),
    estancados: variacion(hoy.estancados, antes.estancados),
    // La única de ventana: contra los 7 días anteriores, no contra el
    // mes. Comparar 7 días con 30 daría siempre un número catastrófico
    // que no significa nada.
    nuevosEstaSemana: variacion(
      hoy.nuevosEstaSemana,
      nuevosEnLaVentana(contactos, ventanaAnterior, 7)
    )
  };
}

// Embudo por etapa (idea propia — dónde se atascan los leads, no solo
// cuántos hay en total): mismo orden/color que las columnas del kanban
// (ETAPAS/COLOR_ETAPA de arriba), expuesto como dato reusable en vez de
// quedar calculado inline dentro de renderKanban().
export function contactosPorEtapa(contactos) {
  return ETAPAS.map(({ clave, etiqueta, color }) => ({
    clave,
    etiqueta,
    color,
    cantidad: contactos.filter((c) => c.estado === clave).length
  }));
}

// Motivos de pérdida más frecuentes (idea propia — el dato de
// "motivo_perdido" ya se captura al marcar un contacto como Perdido,
// pero hasta ahora no se resumía en ningún lado; saber que "el 40% de
// lo que se pierde es por precio" es justo el tipo de información que
// ayuda a vender más, sin necesitar ningún dato nuevo). Texto libre, se
// agrupa por coincidencia exacta (trim, sin fuzzy) — igual que las
// etiquetas libres del CRM.
export function motivosPerdidaFrecuentes(contactos, limite = 3) {
  const conteos = new Map();
  contactos
    .filter((c) => c.estado === "perdido" && c.motivo_perdido && c.motivo_perdido.trim())
    .forEach((c) => {
      const motivo = c.motivo_perdido.trim();
      conteos.set(motivo, (conteos.get(motivo) || 0) + 1);
    });
  return [...conteos.entries()]
    .map(([motivo, cantidad]) => ({ motivo, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, limite);
}

// Demanda por zona (idea propia #3 de "el mapa como una cualidad del
// CRM" — no un mapa de calor geográfico: "zona" es un campo de texto
// del lote, no tiene un polígono propio con el que dibujar algo así, ni
// falta hace) — cuántos CONTACTOS ACTIVOS distintos (ni cerrado ni
// perdido) tienen al menos un lote de interés en cada zona. Un mismo
// contacto interesado en 2 lotes de la misma zona cuenta una sola vez
// ahí (es un interesado, no dos marcas de interés) — de ahí el Set en
// vez de sumar lotes_interes.length. Devuelve { [zona]: cantidad },
// pensado para mezclarse con el "Resumen por zona" que ya existe en el
// Dashboard (mismo criterio de agrupación, ver calcularMetricasDashboard
// en dashboard.js) en vez de armar una tabla aparte.
export function demandaPorZona(contactos) {
  const porZona = {};
  contactos
    .filter((c) => c.estado !== "cerrado" && c.estado !== "perdido")
    .forEach((c) => {
      const zonasDeEsteContacto = new Set();
      (c.lotes_interes || []).forEach((li) => {
        const zona = getLotesActuales().find((f) => f.id === li.id)?.properties?.sector;
        if (zona) zonasDeEsteContacto.add(zona);
      });
      zonasDeEsteContacto.forEach((zona) => {
        porZona[zona] = (porZona[zona] || 0) + 1;
      });
    });
  return porZona;
}

// Interés de pipeline por lote (idea propia #5 de "el mapa como una
// cualidad del CRM" — resaltar el mapa por pipeline activo, ver
// activarInteresCrm en js/mapa.js): cuántos contactos ACTIVOS (ni
// cerrado ni perdido) tienen ESE lote puntual como lote de interés.
// Mismo criterio de "activo" que demandaPorZona/calcularMetricas, pero
// por lote en vez de por zona. Devuelve { [loteId]: cantidad }.
export function interesPorLote(contactos) {
  const porLote = {};
  contactos
    .filter((c) => c.estado !== "cerrado" && c.estado !== "perdido")
    .forEach((c) => {
      (c.lotes_interes || []).forEach((li) => {
        porLote[li.id] = (porLote[li.id] || 0) + 1;
      });
    });
  return porLote;
}

// Ruta de visitas de hoy (idea propia #4 de "el mapa como una cualidad
// del CRM" — literalmente "pineadas", ver renderVisitasDeHoy en
// dashboard.js): contactos en etapa "Visita" con el seguimiento
// agendado para HOY. No hay un campo de "fecha de visita" propio en el
// contacto — se reusa proximo_seguimiento (mismo campo que ya arma
// "Seguimientos pendientes") en vez de sumar uno nuevo a Firestore. Una
// "parada" por cada lote de interés del contacto (una visita puede
// cubrir más de un lote), ordenadas por zona para sugerir un recorrido
// razonable sin necesitar ninguna API de ruteo real.
export function visitasDeHoy(contactos) {
  const hoy = new Date().toISOString().slice(0, 10);
  const paradas = [];
  contactos
    .filter((c) => c.estado === "visita" && c.proximo_seguimiento === hoy)
    .forEach((c) => {
      (c.lotes_interes || []).forEach((li) => {
        const zona = getLotesActuales().find((f) => f.id === li.id)?.properties?.sector || null;
        paradas.push({ contactoId: c.id, contactoNombre: c.nombre, loteId: li.id, loteTitulo: li.titulo, zona });
      });
    });
  return paradas.sort(
    (a, b) => (a.zona || "").localeCompare(b.zona || "") || a.contactoNombre.localeCompare(b.contactoNombre)
  );
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
