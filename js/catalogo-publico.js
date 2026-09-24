// ---------------------------------------------------------------------------
// La vidriera de la inmobiliaria: /propiedades.
//
// Es el link que se pega en la bio de Instagram y en la firma del mail,
// y a donde va a parar un comprador que llegó a una propiedad que ya no
// está. Hasta el 2026-09-24 ese botón lo mandaba a /lotes, la lista
// interna del corredor.
//
// Las decisiones (qué se muestra, en qué orden, cómo filtra) viven en
// js/catalogo.js, que se prueba sin navegador. Acá solo está el dibujo.
// ---------------------------------------------------------------------------

import { getLotesActuales } from "./estado.js";
import { onRutaAplicada, navegarA } from "./router.js";
import { getInmobiliaria, alCambiarLaInmobiliaria, whatsappDeLaInmobiliaria } from "./inmobiliaria.js";
import { pintarBanda, pintarPie } from "./agencia-ui.js";
import {
  ordenarParaElComprador,
  filtrarCatalogo,
  zonasDelCatalogo,
  precioParaElComprador,
  datosParaLaTarjeta,
  ubicacionParaElComprador,
  fajaDeEstado,
  zoomParaElLote,
  mosaicoSatelital,
  aPixelesDeLaMiniatura,
  ladoAproximadoEnMetros
} from "./catalogo.js";
import { centroideDePoligono } from "./geometria.js";

const elPanel = document.getElementById("panel-catalogo");
const elTitulo = document.getElementById("cat-titulo");
const elGrilla = document.getElementById("cat-grilla");
const elVacio = document.getElementById("cat-vacio");
const elCuenta = document.getElementById("cat-cuenta");
const elZona = document.getElementById("cat-zona");
const elDesde = document.getElementById("cat-desde");
const elHasta = document.getElementById("cat-hasta");
const elLimpiar = document.getElementById("cat-limpiar");

const agencia = {
  contenedor: document.getElementById("cat-agencia"),
  logo: document.getElementById("cat-agencia-logo"),
  nombre: document.getElementById("cat-agencia-nombre"),
  donde: document.getElementById("cat-agencia-donde")
};
const pie = {
  contenedor: document.getElementById("cat-pie"),
  nombre: document.getElementById("cat-pie-nombre"),
  datos: document.getElementById("cat-pie-datos"),
  matricula: document.getElementById("cat-pie-matricula")
};

// Lo que el visitante viene buscando: qué lotes hay. Se dibuja el título
// de un lote igual que en la página pública — "Manzana 118 — Lote 8" y
// no la nomenclatura catastral.
function tituloDe(p) {
  if (p.manzana && p.lote) return `Manzana ${p.manzana} — Lote ${p.lote}`;
  return p.nomenclatura || "Lote";
}

function numeroODefault(input) {
  const v = input.value.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function filtrosActuales() {
  return { zona: elZona.value, desde: numeroODefault(elDesde), hasta: numeroODefault(elHasta) };
}

function hayFiltroPuesto() {
  const f = filtrosActuales();
  return !!(f.zona || f.desde != null || f.hasta != null);
}

const TILE_ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

// Medidas de la miniatura. 4:3, como el marco de la tarjeta.
const MINI_ANCHO = 400;
const MINI_ALTO = 300;

/**
 * El lote dibujado sobre la foto satelital, para cuando no hay fotos.
 *
 * ES EL DIFERENCIAL DEL PRODUCTO. ZonaProp y Argenprop muestran un pin
 * sobre un mapa de calles; acá se ve el límite real del terreno. Y en
 * una cartera recién cargada la mayoría de los lotes todavía no tiene
 * fotos, así que sin esto el catálogo es una pared de cuadros grises
 * diciendo "Sin fotos todavía" — justo la pantalla que se manda para
 * vender.
 *
 * Son <img> sueltos y un <svg> encima, no una instancia de Leaflet por
 * tarjeta: siete mapas en una pantalla es otra cosa.
 */
function miniaturaSatelital(feature) {
  const anillo = feature.geometry?.coordinates?.[0];
  if (!Array.isArray(anillo) || anillo.length < 3) return null;

  const centro = centroideDePoligono(anillo);
  if (!centro || !Number.isFinite(centro.lat) || !Number.isFinite(centro.lon)) return null;

  const zoom = zoomParaElLote(ladoAproximadoEnMetros(anillo), MINI_ALTO, centro.lat);
  const { tiles, origenX, origenY, lado } = mosaicoSatelital(centro.lat, centro.lon, zoom, MINI_ANCHO, MINI_ALTO);

  const caja = document.createElement("div");
  caja.className = "cat-mini";
  caja.dataset.zoom = String(zoom);

  for (const t of tiles) {
    const img = document.createElement("img");
    // Esri numera {z}/{y}/{x}, en ese orden — no {z}/{x}/{y}.
    img.src = `${TILE_ESRI}/${t.z}/${t.y}/${t.x}`;
    img.alt = "";
    img.loading = "lazy";
    img.className = "cat-mini-tile";
    img.style.left = `${(t.izquierda / MINI_ANCHO) * 100}%`;
    img.style.top = `${(t.arriba / MINI_ALTO) * 100}%`;
    img.style.width = `${(lado / MINI_ANCHO) * 100}%`;
    img.style.height = `${(lado / MINI_ALTO) * 100}%`;
    caja.appendChild(img);
  }

  const puntos = anillo
    .map((v) => {
      const lat = v.lat ?? v[1];
      const lon = v.lon ?? v.lng ?? v[0];
      const px = aPixelesDeLaMiniatura(lat, lon, zoom, origenX, origenY);
      return `${px.x.toFixed(1)},${px.y.toFixed(1)}`;
    })
    .join(" ");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${MINI_ANCHO} ${MINI_ALTO}`);
  svg.setAttribute("class", "cat-mini-forma");
  svg.setAttribute("aria-hidden", "true");
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  poly.setAttribute("points", puntos);
  svg.appendChild(poly);
  caja.appendChild(svg);

  return caja;
}

// Una foto vale más que el polígono; si no hay foto, el polígono.
function fondoDeLaTarjeta(feature) {
  const p = feature.properties;
  const primera = (p.fotos || [])[0];
  const foto = typeof primera === "string" ? primera : primera?.url;
  if (foto) return { tipo: "foto", url: foto };
  const mini = miniaturaSatelital(feature);
  return mini ? { tipo: "mini", nodo: mini } : { tipo: "sin-foto" };
}

function tarjeta(feature) {
  const p = feature.properties;
  const art = document.createElement("article");
  art.className = "cat-tarjeta";
  art.dataset.loteId = feature.id;

  const fondo = fondoDeLaTarjeta(feature);
  const marco = document.createElement("div");
  marco.className = "cat-tarjeta-foto";
  if (fondo.tipo === "foto") {
    const img = document.createElement("img");
    img.src = fondo.url;
    img.alt = `Foto de ${tituloDe(p)}`;
    img.loading = "lazy";
    // Una foto que ya no carga deja el ícono de imagen rota en la
    // vidriera: mejor el cartel de "sin fotos", que al menos se lee.
    img.onerror = () => {
      marco.innerHTML = "";
      marco.classList.add("cat-tarjeta-sin-foto");
      marco.textContent = "Sin fotos todavía";
    };
    marco.appendChild(img);
  } else if (fondo.tipo === "mini") {
    marco.appendChild(fondo.nodo);
  } else {
    marco.classList.add("cat-tarjeta-sin-foto");
    marco.textContent = "Sin fotos todavía";
  }

  const faja = fajaDeEstado(p);
  if (faja) {
    const chip = document.createElement("span");
    chip.className = `cat-faja cat-faja-${faja.clase}`;
    chip.textContent = faja.texto;
    marco.appendChild(chip);
  }
  art.appendChild(marco);

  const cuerpo = document.createElement("div");
  cuerpo.className = "cat-tarjeta-cuerpo";

  const precio = precioParaElComprador(p);
  if (precio) {
    const elPrecio = document.createElement("p");
    elPrecio.className = "cat-tarjeta-precio";
    elPrecio.textContent = precio;
    cuerpo.appendChild(elPrecio);
  }

  const titulo = document.createElement("p");
  titulo.className = "cat-tarjeta-titulo";
  titulo.textContent = tituloDe(p);
  cuerpo.appendChild(titulo);

  const donde = ubicacionParaElComprador(p);
  if (donde) {
    const elDonde = document.createElement("p");
    elDonde.className = "cat-tarjeta-donde";
    elDonde.textContent = donde;
    cuerpo.appendChild(elDonde);
  }

  // Superficie y medidas. Las medidas las muestran todos los portales y
  // acá salen de la geometría real del lote, no hay que cargarlas.
  const datos = datosParaLaTarjeta(p, p.medidas || null);
  if (datos.length > 0) {
    const elDatos = document.createElement("p");
    elDatos.className = "cat-tarjeta-datos";
    elDatos.textContent = datos.join(" · ");
    cuerpo.appendChild(elDatos);
  }

  art.appendChild(cuerpo);

  // "Publica: <inmobiliaria>" y el WhatsApp EN LA TARJETA. Es lo que
  // hace Argenprop y es lo que evita que el comprador tenga que abrir la
  // propiedad para poder escribir. Solo para lo que se puede comprar:
  // un vendido no lleva botón de consulta, por el mismo motivo que su
  // página no lleva formulario.
  const inmo = getInmobiliaria();
  const acciones = document.createElement("div");
  acciones.className = "cat-tarjeta-acciones";
  if (inmo) {
    const quien = document.createElement("span");
    quien.className = "cat-tarjeta-publica";
    quien.textContent = `Publica: ${inmo.nombre}`;
    acciones.appendChild(quien);
  }
  const link = precio ? whatsappDeLaInmobiliaria(`Hola, me interesa ${tituloDe(p)}. ${location.origin}/lote/${feature.id}`) : null;
  if (link) {
    const wa = document.createElement("a");
    wa.className = "cat-tarjeta-whatsapp";
    wa.href = link;
    wa.target = "_blank";
    wa.rel = "noopener noreferrer";
    wa.textContent = "WhatsApp";
    // Sin esto el click abre también la propiedad: la tarjeta entera es
    // un link.
    wa.addEventListener("click", (e) => e.stopPropagation());
    acciones.appendChild(wa);
  }
  if (acciones.childElementCount > 0) art.appendChild(acciones);

  art.addEventListener("click", () => navegarA(`/lote/${feature.id}`));
  return art;
}

function render() {
  if (elPanel.classList.contains("oculto")) return;

  const inmo = getInmobiliaria();
  pintarBanda(agencia, inmo);
  pintarPie(pie, inmo);
  elTitulo.textContent = inmo ? `Propiedades de ${inmo.nombre}` : "Propiedades";

  const todos = getLotesActuales();
  const zonas = zonasDelCatalogo(todos);
  const elegida = elZona.value;
  elZona.innerHTML =
    `<option value="">Todas las zonas</option>` +
    zonas.map((z) => `<option value="${z}">${z}</option>`).join("");
  elZona.value = zonas.includes(elegida) ? elegida : "";

  const visibles = ordenarParaElComprador(filtrarCatalogo(todos, filtrosActuales()));

  elGrilla.innerHTML = "";
  for (const feature of visibles) elGrilla.appendChild(tarjeta(feature));

  const hayFiltro = hayFiltroPuesto();
  elLimpiar.classList.toggle("oculto", !hayFiltro);

  // Dos vacíos distintos: "todavía no hay nada publicado" no es lo mismo
  // que "no hay nada con estos filtros", y confundirlos deja al visitante
  // creyendo que la inmobiliaria no tiene propiedades.
  const vacio = visibles.length === 0;
  elVacio.classList.toggle("oculto", !vacio);
  if (vacio) {
    elVacio.textContent = hayFiltro
      ? "No hay propiedades con esos filtros. Probá ampliando el precio o mirando todas las zonas."
      : "Todavía no hay propiedades publicadas.";
  }

  elCuenta.textContent = vacio
    ? ""
    : `${visibles.length} ${visibles.length === 1 ? "propiedad" : "propiedades"}`;
}

for (const control of [elZona, elDesde, elHasta]) {
  control.addEventListener("change", render);
  control.addEventListener("input", render);
}

elLimpiar.addEventListener("click", () => {
  elZona.value = "";
  elDesde.value = "";
  elHasta.value = "";
  render();
});

// Los lotes y los datos de la inmobiliaria llegan de Firestore DESPUÉS
// de que la pantalla se dibujó. Sin esto, el visitante que entra directo
// por el link ve un catálogo vacío que nunca se llena.
alCambiarLaInmobiliaria(render);

onRutaAplicada((ruta) => {
  if (ruta.clave !== "catalogo") return;
  elPanel.classList.remove("oculto");
  render();
});

/** La llama app.js cuando terminan de cargar los lotes. */
export function refrescarCatalogoSiCorresponde() {
  render();
}
