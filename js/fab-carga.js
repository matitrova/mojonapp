// ---------------------------------------------------------------------------
// Botón flotante de carga: las tres formas de sumar un lote.
//
// POR QUÉ NO ESTÁ EN EL MENÚ LATERAL (pedido del usuario del
// 2026-09-18). Cargar un lote no es "ir a una sección", es una acción que
// se hace mirando el mapa: elegís dónde y cargás ahí. Tenerla en el menú
// obligaba a abrir el menú, elegir, y que el menú se cierre — tres pasos
// para lo que más se repite cuando estás armando la cartera.
//
// SON LOS MISMOS BOTONES que estaban en el menú, movidos: un solo camino
// por acción. Por eso sus ids no cambiaron y todo lo que ya los
// disparaba (los estados vacíos de js/estado-vacio.js, los tests) sigue
// funcionando sin tocar nada.
// ---------------------------------------------------------------------------

const elCaja = document.getElementById("fab-carga");
const elBoton = document.getElementById("fab-carga-boton");
const elOpciones = document.getElementById("fab-carga-opciones");

function abrir() {
  elOpciones.classList.remove("oculto");
  elCaja.classList.add("abierto");
  elBoton.setAttribute("aria-expanded", "true");
}

export function cerrarFabCarga() {
  elOpciones.classList.add("oculto");
  elCaja.classList.remove("abierto");
  elBoton.setAttribute("aria-expanded", "false");
}

elBoton.addEventListener("click", (evento) => {
  evento.stopPropagation();
  if (elOpciones.classList.contains("oculto")) abrir();
  else cerrarFabCarga();
});

// Elegir una opción cierra el menú: las tres abren un formulario encima
// del mapa, así que dejarlo abierto taparía justo lo que se va a usar.
elOpciones.addEventListener("click", cerrarFabCarga);

// Un click en cualquier otro lado también cierra. Se escucha en el
// documento y se pregunta si cayó adentro, en vez de usar "blur": con
// blur, el click sobre una opción cerraría el menú ANTES de que la
// opción reciba el suyo.
document.addEventListener("click", (evento) => {
  if (!elCaja.contains(evento.target)) cerrarFabCarga();
});

document.addEventListener("keydown", (evento) => {
  if (evento.key === "Escape") cerrarFabCarga();
});
