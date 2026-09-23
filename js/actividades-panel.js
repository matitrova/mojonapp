// ---------------------------------------------------------------------------
// Pantalla "Actividades": el resumen de lo que hizo el equipo.
//
// Las reglas (categorías, períodos, resúmenes) viven en
// js/actividad-equipo.js, sin Firestore ni DOM. Acá está el cableado.
//
// LEE LA MISMA COLECCIÓN QUE LA AUDITORÍA, a propósito: los eventos ya
// están grabados desde hace rato (1668 en producción), así que esta
// pantalla nace con historial de verdad. Lo que cambia es la pregunta que
// contesta — no "quién borró esto" sino "cómo viene cada corredor".
//
// Textos en español neutro, igual que Tareas.
// ---------------------------------------------------------------------------

import { db } from "./firebase-config.js";
import {
  collection,
  getDocs,
  query,
  orderBy,
  where,
  limit,
  Timestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  CATEGORIAS,
  eventosDelPeriodo,
  resumenPorPersona,
  resumenEnPalabras,
  actividadPorDia
} from "./actividad-equipo.js";
import { esRootActual } from "./permisos.js";

// Techo de seguridad, no criterio de corte: lo que decide qué se trae es
// el RANGO DE FECHAS del período elegido.
//
// POR QUÉ NO ALCANZA UN "últimos N". La primera versión traía los 300
// eventos más recientes y de ahí filtraba el período. Se vio en la
// captura de revisión: con 300 eventos generados hoy, el gráfico de 7
// días mostraba los seis días anteriores en CERO — y eso era mentira, no
// es que no hubo actividad, es que esos eventos nunca se leyeron. Una
// pantalla que afirma "nadie trabajó el martes" sin haberlo mirado es
// peor que no tener la pantalla.
//
// Si aun con el rango se llega a este techo, se avisa en pantalla en vez
// de mostrar un resumen incompleto como si fuera completo.
const MAX_EVENTOS = 2000;

const elPanel = document.getElementById("panel-actividades");
const elPeriodo = document.getElementById("actividades-periodo");
const elGrafico = document.getElementById("actividades-grafico");
const elPersonas = document.getElementById("actividades-personas");
const elVacio = document.getElementById("actividades-vacio");
const elError = document.getElementById("actividades-error");

let eventos = [];
let dias = 1;
// True cuando el período trajo tantos eventos como el techo: el resumen
// puede estar incompleto y hay que decirlo.
let incompleto = false;

async function cargarEventos() {
  try {
    // El comienzo del período, en hora local: el día que se ve arriba es
    // el día del corredor, no UTC (mismo criterio que diaComoTexto).
    const desde = new Date();
    desde.setHours(0, 0, 0, 0);
    desde.setDate(desde.getDate() - (dias - 1));

    const snapshot = await getDocs(
      query(
        collection(db, "auditoria"),
        where("fecha", ">=", Timestamp.fromDate(desde)),
        orderBy("fecha", "desc"),
        limit(MAX_EVENTOS)
      )
    );
    eventos = snapshot.docs.map((d) => d.data());
    incompleto = snapshot.size >= MAX_EVENTOS;
    elError.classList.add("oculto");
  } catch (error) {
    elError.textContent =
      error.code === "permission-denied"
        ? "No tienes permiso para ver la actividad del equipo."
        : "No se pudo cargar la actividad.";
    elError.classList.remove("oculto");
    eventos = [];
    incompleto = false;
  }
}

function render() {
  const delPeriodo = eventosDelPeriodo(eventos, dias);
  const personas = resumenPorPersona(delPeriodo);

  elPersonas.innerHTML = "";
  elVacio.classList.toggle("oculto", personas.length > 0);

  if (incompleto) {
    const aviso = document.createElement("p");
    aviso.className = "dashboard-ayuda";
    aviso.dataset.testid = "actividades-incompleto";
    aviso.textContent =
      `Hay más de ${MAX_EVENTOS} eventos en este período: se muestran los más recientes, así que el resumen puede quedar corto.`;
    elPersonas.appendChild(aviso);
  }

  for (const fila of personas) {
    const tarjeta = document.createElement("div");
    tarjeta.className = "actividad-persona";
    tarjeta.dataset.testid = "actividad-persona";

    const cabecera = document.createElement("div");
    cabecera.className = "actividad-persona-cabecera";

    const quien = document.createElement("strong");
    quien.textContent = fila.persona;
    cabecera.appendChild(quien);

    const total = document.createElement("span");
    total.className = "actividad-total";
    total.textContent = fila.total === 1 ? "1 acción" : `${fila.total} acciones`;
    cabecera.appendChild(total);
    tarjeta.appendChild(cabecera);

    const enPalabras = document.createElement("p");
    enPalabras.className = "actividad-en-palabras";
    enPalabras.textContent = resumenEnPalabras(fila);
    tarjeta.appendChild(enPalabras);

    // Las barras por categoría: mismo total, leído de un vistazo. Se
    // dibujan proporcionales al total de esa persona, no al del equipo,
    // porque la pregunta es "en qué se le fue el día a esta persona".
    const barras = document.createElement("div");
    barras.className = "actividad-barras";
    for (const categoria of CATEGORIAS) {
      const cantidad = fila[categoria.clave] || 0;
      if (cantidad === 0) continue;
      const parte = document.createElement("span");
      parte.className = `actividad-barra actividad-barra-${categoria.clave}`;
      parte.style.width = `${(cantidad / fila.total) * 100}%`;
      parte.title = `${categoria.etiqueta}: ${cantidad}`;
      barras.appendChild(parte);
    }
    tarjeta.appendChild(barras);

    elPersonas.appendChild(tarjeta);
  }

  renderGrafico(delPeriodo);
}

function renderGrafico(delPeriodo) {
  // Con un solo día no hay evolución que mostrar: una barra sola no dice
  // nada que el número de arriba no diga mejor.
  const mostrar = dias > 1;
  elGrafico.classList.toggle("oculto", !mostrar);
  if (!mostrar) return;

  const filas = actividadPorDia(delPeriodo, dias);
  const maximo = Math.max(1, ...filas.map((f) => f.cantidad));
  // Cada cuántas columnas va un rótulo. A 390px las 30 columnas del mes
  // miden 8,7px y un número de dos dígitos mide ~11: rotularlas todas
  // las pega en un bloque ilegible ("242526272829...") y entonces
  // ninguna barra tiene día. Con el tope de 7 rótulos siempre queda
  // aire entre uno y el siguiente; con 7 días el paso es 1 y no cambia
  // nada de lo que ya se leía bien.
  const paso = Math.ceil(dias / 7);
  elGrafico.innerHTML = "";
  for (const [i, fila] of filas.entries()) {
    const columna = document.createElement("div");
    columna.className = "actividad-dia";
    columna.title = `${fila.dia}: ${fila.cantidad}`;

    const barra = document.createElement("div");
    barra.className = "actividad-dia-barra";
    // Un día SIN eventos no dibuja nada. La regla compartida tiene un
    // min-height de 2px para que un día flojo se vea igual cuando el
    // máximo es alto; aplicado a un cero, pinta un trazo naranja
    // apoyado en la base y un día sin movimiento se lee como un día con
    // poco, que es lo contrario de lo que pasó.
    if (fila.cantidad === 0) barra.classList.add("actividad-dia-barra-vacia");
    barra.style.height = `${(fila.cantidad / maximo) * 100}%`;
    columna.appendChild(barra);

    const etiqueta = document.createElement("span");
    etiqueta.className = "actividad-dia-etiqueta";
    // Solo el día del mes: con 30 columnas, la fecha entera no entra.
    // Y solo cada "paso" columnas, contando DESDE LA ÚLTIMA, para que
    // hoy siempre quede rotulado (es el día que se busca primero). Las
    // demás dejan el span VACÍO en vez de no crearlo: el hueco tiene
    // que seguir ocupando lo mismo o sus barras quedarían más altas que
    // las rotuladas. La fecha completa de cada columna sigue estando en
    // el title.
    const ultima = filas.length - 1;
    etiqueta.textContent = (ultima - i) % paso === 0 ? fila.dia.slice(-2) : "";
    columna.appendChild(etiqueta);

    elGrafico.appendChild(columna);
  }
}

// Cambiar de período vuelve a CONSULTAR, no solo a redibujar: cada
// período trae su propio rango de fechas.
elPeriodo.addEventListener("click", async (evento) => {
  const boton = evento.target.closest("button[data-dias]");
  if (!boton) return;
  dias = Number(boton.dataset.dias);
  elPeriodo.querySelectorAll("button").forEach((b) => b.classList.toggle("activo", b === boton));
  await cargarEventos();
  render();
});

export async function abrirPanelActividades() {
  if (!esRootActual()) return;
  elPanel.classList.remove("oculto");
  await cargarEventos();
  render();
}

document.getElementById("btn-abrir-actividades").addEventListener("click", abrirPanelActividades);
