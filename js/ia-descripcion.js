// ---------------------------------------------------------------------------
// "Redactar con IA" — la versión redactada de la descripción para portales.
//
// Convive con "Copiar descripción para portales" (js/ficha.js), no lo
// reemplaza: aquel arma el texto por plantilla, gratis, sin conexión a
// ningún servicio y sin fallar nunca. Este le pide a un modelo de
// lenguaje que lo escriba de verdad. Si el de IA falla (sin internet,
// servicio caído, sesión vencida), el de plantilla sigue ahí al lado.
//
// Toda la parte cara y secreta vive en functions/ia-descripcion.js: acá
// no hay ninguna API key ni ninguna llamada a un proveedor, solo un
// fetch a nuestro propio endpoint. Ese endpoint exige un token de
// sesión válido, así que este módulo tiene que mandarlo sí o sí.
//
// Módulo aparte en vez de sumarlo a ficha.js (que ya pasa las 1200
// líneas) — mismo criterio que la modularización del CRM. No hace falta
// el patrón de configurar(deps) de crm-datos.js porque
// getLoteSeleccionado vive en estado.js, que no importa a nadie: no hay
// riesgo de ciclo.
// ---------------------------------------------------------------------------

import { auth } from "./firebase-config.js";
import { getLoteSeleccionado } from "./estado.js";
import { tituloLote } from "./ficha.js";
import { distanciasReferenciaEnCache } from "./distancias-referencia.js";
import { centroideDePoligono } from "./geometria.js";

const elBoton = document.getElementById("btn-redactar-ia");
const elResultado = document.getElementById("ia-descripcion-resultado");
const elTexto = document.getElementById("ia-descripcion-texto");
const elMensaje = document.getElementById("ia-mensaje");
const elBotonCopiar = document.getElementById("btn-copiar-ia");

function mostrarMensaje(texto) {
  elMensaje.textContent = texto;
  elMensaje.classList.remove("oculto");
}

// Solo los campos que el endpoint acepta (tiene su propia lista blanca
// del otro lado, esta es para no mandar de más por la red): la ficha
// completa trae geometría, historial de vistas y varias cosas más que
// no aportan nada a un aviso.
function datosParaElAviso(feature) {
  const p = feature.properties;
  return {
    titulo: tituloLote(p),
    sector: p.sector || null,
    barrio: p.barrio || null,
    superficie_m2: p.superficie_m2 ?? null,
    precio_usd: p.precio_usd ?? null,
    servicios: p.servicios || {},
    descripcion: p.descripcion || null
  };
}

// Distancia real a la ruta pavimentada y a la localidad más cercana, el
// mismo dato medido que la ficha ya muestra en "Cercanías" (ver
// js/distancias-referencia.js, que lo saca de OpenStreetMap).
//
// Por qué se lo pasamos al generador de avisos: mirando cómo publican las
// otras inmobiliarias de la zona, TODAS ubican al lector con referencias
// concretas ("a 500 metros del Centro Cívico", "sobre el camino que une La
// Punta con Potrero"). Es lo que hace que un aviso ubique de verdad, y
// nuestros avisos no podían hacerlo porque el prompt tiene prohibido
// inventar distancias — con razón. Esta es la forma de tenerlas sin
// inventar nada: son medidas.
//
// Lee SOLO del cache, nunca sale a la red: Overpass tarda entre 9 y 16
// segundos bajo carga, y hacer esperar todo eso para redactar un aviso
// sería peor que publicarlo sin la referencia de distancia. En la práctica
// casi siempre hay dato, porque abrir la ficha ya disparó la consulta de
// "Cercanías" y este es el mismo cache. Si no hay, el aviso se escribe sin
// esta parte — es un extra, no un requisito.
function cercaniasDelLote(feature) {
  try {
    const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
    return distanciasReferenciaEnCache(lat, lon);
  } catch {
    return null;
  }
}

elBoton.addEventListener("click", async () => {
  const feature = getLoteSeleccionado();
  if (!feature) return;

  if (!auth.currentUser) {
    mostrarMensaje("Tienes que iniciar sesión para usar esto.");
    return;
  }

  // Mientras dura la llamada (un par de segundos) el botón queda
  // deshabilitado y lo dice: sin esto, en una conexión rural lenta, no
  // hay ninguna señal de que algo esté pasando y se termina apretando
  // tres veces, que son tres llamadas pagas.
  const textoOriginal = elBoton.textContent;
  elBoton.disabled = true;
  elBoton.textContent = "Redactando…";
  elMensaje.classList.add("oculto");

  try {
    const idToken = await auth.currentUser.getIdToken();
    const respuesta = await fetch("/ia-descripcion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken,
        lote: datosParaElAviso(feature),
        cercanias: cercaniasDelLote(feature)
      })
    });
    const datos = await respuesta.json();

    if (!respuesta.ok) {
      mostrarMensaje(datos.error || "No se pudo redactar el aviso.");
      return;
    }

    // El textarea es editable a propósito: el corredor conoce la zona y
    // al cliente mejor que el modelo — lo normal es que retoque una
    // frase antes de publicar, no que copie tal cual.
    elTexto.value = datos.texto;
    elResultado.classList.remove("oculto");
  } catch {
    mostrarMensaje("No se pudo redactar el aviso. Revisa la conexión.");
  } finally {
    elBoton.disabled = false;
    elBoton.textContent = textoOriginal;
  }
});

elBotonCopiar.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elTexto.value);
    mostrarMensaje("Descripción copiada.");
    setTimeout(() => elMensaje.classList.add("oculto"), 2000);
  } catch {
    // Mismo fallback que "Copiar descripción para portales": sin permiso
    // de portapapeles, el texto ya está a la vista en el textarea para
    // seleccionarlo a mano.
    elTexto.select();
    mostrarMensaje("Copialo a mano desde el cuadro de arriba.");
  }
});
