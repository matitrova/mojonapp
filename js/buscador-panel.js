// ---------------------------------------------------------------------------
// Cableado del buscador global de la barra superior.
//
// Las reglas (qué coincide, en qué orden, cuántos) están en
// js/buscador.js, sin DOM. Acá solo está la pantalla: escuchar lo que se
// escribe, dibujar los resultados y llevar a donde se elija.
//
// SOLO CON SESIÓN. Un visitante no tiene por qué ver nombres de leads, y
// para los lotes ya existe el buscador de la lista, que además filtra.
// El campo se muestra recién cuando hay sesión (ver app.js).
// ---------------------------------------------------------------------------

import { buscar, hayResultados, MINIMO_PARA_BUSCAR } from "./buscador.js";
import { getLotesActuales, getContactosActuales } from "./estado.js";
import { navegarA } from "./router.js";

const elCaja = document.getElementById("buscador");
const elTexto = document.getElementById("buscador-texto");
const elResultados = document.getElementById("buscador-resultados");

// Lo inyecta app.js: mostrar la ficha de un lote y abrir un contacto en
// el CRM viven en módulos que importan a este de forma indirecta, así
// que se pasan por parámetro para no armar un ciclo.
let irAlLote, irAlLead;

export function configurarBuscador(deps) {
  ({ irAlLote, irAlLead } = deps);
}

function cerrar() {
  elResultados.classList.add("oculto");
  elResultados.innerHTML = "";
}

function filaDeResultado(resultado, alElegir) {
  const fila = document.createElement("button");
  fila.type = "button";
  fila.className = "buscador-fila";
  fila.dataset.testid = `buscador-resultado-${resultado.id}`;

  const titulo = document.createElement("span");
  titulo.className = "buscador-fila-titulo";
  // textContent: los nombres de lead y las zonas los escribe una persona.
  titulo.textContent = resultado.titulo;
  fila.appendChild(titulo);

  if (resultado.detalle) {
    const detalle = document.createElement("span");
    detalle.className = "buscador-fila-detalle";
    detalle.textContent = resultado.detalle;
    fila.appendChild(detalle);
  }

  fila.addEventListener("click", () => {
    cerrar();
    elTexto.value = "";
    alElegir(resultado);
  });
  return fila;
}

function grupo(titulo, resultados, alElegir) {
  if (resultados.length === 0) return null;
  const seccion = document.createElement("div");
  seccion.className = "buscador-grupo";

  const rotulo = document.createElement("p");
  rotulo.className = "buscador-grupo-titulo";
  rotulo.textContent = titulo;
  seccion.appendChild(rotulo);

  for (const resultado of resultados) seccion.appendChild(filaDeResultado(resultado, alElegir));
  return seccion;
}

function render() {
  const termino = elTexto.value;
  elResultados.innerHTML = "";

  if (termino.trim().length < MINIMO_PARA_BUSCAR) {
    cerrar();
    return;
  }

  const resultados = buscar(termino, getLotesActuales(), getContactosActuales());
  elResultados.classList.remove("oculto");

  if (!hayResultados(resultados)) {
    // "No encontré nada" y "escribiste poco" son dos cosas distintas y
    // se dicen distinto: con este mensaje, quien busca sabe que el
    // sistema miró y no que le falta escribir.
    const vacio = document.createElement("p");
    vacio.className = "buscador-vacio";
    vacio.dataset.testid = "buscador-vacio";
    vacio.textContent = `No se encontró ningún lote ni lead con "${termino.trim()}".`;
    elResultados.appendChild(vacio);
    return;
  }

  const deLotes = grupo("Lotes", resultados.lotes, (r) => {
    navegarA("/");
    irAlLote?.(r.feature);
  });
  if (deLotes) elResultados.appendChild(deLotes);

  const deLeads = grupo("Leads", resultados.leads, (r) => irAlLead?.(r.contacto));
  if (deLeads) elResultados.appendChild(deLeads);
}

elTexto.addEventListener("input", render);
elTexto.addEventListener("focus", render);

// Escape cierra sin borrar lo escrito: si te equivocaste de tecla, no
// perdés lo que venías tipeando.
elTexto.addEventListener("keydown", (evento) => {
  if (evento.key === "Escape") cerrar();
});

// Un click afuera cierra la lista. Se escucha en el documento y se
// pregunta si el click cayó adentro, en vez de usar "blur": con blur, el
// click sobre un resultado cierra la lista ANTES de que el resultado
// reciba su propio click, y no pasa nada.
document.addEventListener("click", (evento) => {
  if (!elCaja.contains(evento.target)) cerrar();
});

export function mostrarBuscador(visible) {
  elCaja.classList.toggle("oculto", !visible);
  if (!visible) {
    elTexto.value = "";
    cerrar();
  }
}
