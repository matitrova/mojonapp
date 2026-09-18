// ---------------------------------------------------------------------------
// Página pública de un lote: /lote/<id>
//
// POR QUÉ EXISTE SI YA ESTÁ LA FICHA. La ficha es la hoja de trabajo del
// corredor sobre el mapa: rápida, con notas internas, tasación y
// edición. Esta es la que se le manda al comprador — fotos grandes,
// precio a la vista, el mapa como un bloque más y un formulario para
// dejar los datos. Decisión del usuario del 2026-09-18: conviven, porque
// son dos usos distintos de la misma información.
//
// EL MAPA VA AL COSTADO, NO DE FONDO. En la ficha el protagonista es el
// mapa y la información es una hoja encima; acá es al revés. Por eso es
// una segunda instancia de Leaflet, chica y propia, en vez de reusar el
// mapa principal: el principal vive en #mapa a pantalla completa y
// moverlo para esto dejaría al corredor sin su vista al volver.
// ---------------------------------------------------------------------------

import { getLotesActuales } from "./estado.js";
import { onRutaAplicada } from "./router.js";
import { subirFotoACloudinary } from "./ficha.js";
import { db, auth } from "./firebase-config.js";
import { doc, updateDoc, arrayUnion } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { crearContactoDesdeInteresado } from "./crm-datos.js";
// Las mismas reglas que aplica functions/consulta-lote.js del otro lado.
import { validarConsulta } from "./consulta-lote.js";

const elPanel = document.getElementById("panel-lote-publico");
const elTitulo = document.getElementById("lp-titulo");
const elNoEncontrado = document.getElementById("lp-no-encontrado");
const elContenido = document.getElementById("lp-contenido");
const elPrecio = document.getElementById("lp-precio");
const elUbicacion = document.getElementById("lp-ubicacion");
const elDatos = document.getElementById("lp-datos");
const elServicios = document.getElementById("lp-servicios");
const elDescripcion = document.getElementById("lp-descripcion");
const elFotoPrincipal = document.getElementById("lp-foto-principal");
const elSinFotos = document.getElementById("lp-sin-fotos");
const elMiniaturas = document.getElementById("lp-miniaturas");
const elSubir = document.getElementById("lp-subir");
const elSubirInput = document.getElementById("lp-subir-input");
const elSubirEstado = document.getElementById("lp-subir-estado");
const elForm = document.getElementById("lp-form");
const elFormMensaje = document.getElementById("lp-form-mensaje");
const elWhatsapp = document.getElementById("lp-whatsapp");
const elTrampa = document.getElementById("lp-apellido");
const elEsperando = document.getElementById("lp-esperando");
const elEsperandoTexto = document.getElementById("lp-esperando-texto");
const elReintentar = document.getElementById("lp-reintentar");

const SERVICIOS = [
  { clave: "luz", etiqueta: "Luz" },
  { clave: "agua", etiqueta: "Agua" },
  { clave: "gas", etiqueta: "Gas" },
  { clave: "cloaca", etiqueta: "Cloaca" }
];

let loteActual = null;
let mapaChico = null;
let capaDelLote = null;

function tituloDe(p) {
  return `Manzana ${p.manzana ?? "?"} — Lote ${p.lote ?? "?"}`;
}

function precioEnTexto(p) {
  return p.precio_usd == null
    ? "Consultar precio"
    : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`;
}

function renderGaleria(p) {
  const fotos = p.fotos || [];
  elMiniaturas.innerHTML = "";
  elSinFotos.classList.toggle("oculto", fotos.length > 0);
  elFotoPrincipal.classList.toggle("oculto", fotos.length === 0);
  if (fotos.length === 0) return;

  elFotoPrincipal.src = fotos[0].url;
  elFotoPrincipal.alt = `Foto de ${tituloDe(p)}`;

  // Las miniaturas solo tienen sentido con más de una: con una sola
  // serían una fila de un elemento repitiendo lo de arriba.
  if (fotos.length < 2) return;
  fotos.forEach((foto, indice) => {
    const mini = document.createElement("button");
    mini.type = "button";
    mini.className = "lp-miniatura";
    mini.dataset.testid = `lp-miniatura-${indice}`;
    const img = document.createElement("img");
    img.src = foto.url;
    img.alt = "";
    mini.appendChild(img);
    mini.addEventListener("click", () => {
      elFotoPrincipal.src = foto.url;
    });
    elMiniaturas.appendChild(mini);
  });
}

function renderDatos(p) {
  const filas = [
    ["Superficie", p.superficie_m2 == null ? "Sin datos" : `${p.superficie_m2} m²`],
    ["Estado", { disponible: "Disponible", reservado: "Reservado", vendido: "Vendido" }[p.estado] || p.estado],
    ["Zona", p.sector || "Sin datos"],
    ["Barrio", p.barrio || "Sin datos"],
    ["Nomenclatura", p.nomenclatura || "Sin datos"]
  ];
  elDatos.innerHTML = "";
  for (const [clave, valor] of filas) {
    const dt = document.createElement("dt");
    dt.textContent = clave;
    const dd = document.createElement("dd");
    // textContent: zona, barrio y nomenclatura los escribe una persona.
    dd.textContent = valor;
    elDatos.append(dt, dd);
  }

  elServicios.innerHTML = "";
  if (p.servicios == null) {
    elServicios.textContent = "Sin datos";
  } else {
    for (const { clave, etiqueta } of SERVICIOS) {
      const chip = document.createElement("span");
      chip.className = `lp-servicio${p.servicios[clave] ? "" : " sin"}`;
      chip.textContent = etiqueta;
      elServicios.appendChild(chip);
    }
  }

  elDescripcion.textContent = p.descripcion || "Este lote todavía no tiene una descripción publicada.";
}

function renderMapa(feature) {
  // Se crea recién la primera vez que hace falta: Leaflet necesita que el
  // contenedor tenga tamaño real, y mientras el panel está oculto mide 0.
  if (!mapaChico) {
    mapaChico = L.map("lp-mapa", { zoomControl: true, scrollWheelZoom: false, maxZoom: 24 });
    // maxNativeZoom 17 por el mismo motivo que el mapa principal, y acá
    // importa todavía más: esta es la página que ve un comprador, y un
    // recuadro gris que dice "Map data not yet available" donde tendría
    // que estar la propiedad es lo peor que puede mostrar. Ver el
    // comentario largo en js/mapa.js.
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 24,
      maxNativeZoom: 17,
      attribution: "Tiles &copy; Esri"
    }).addTo(mapaChico);
  }
  if (capaDelLote) capaDelLote.remove();
  capaDelLote = L.geoJSON(feature, { style: { color: "#e2591f", weight: 2, fillOpacity: 0.25 } }).addTo(mapaChico);
  // invalidateSize porque el panel estaba oculto cuando se creó el mapa:
  // sin esto queda de 0×0 y no se ve nada (el mismo problema que ya
  // tuvo el mapa principal al abrirse detrás de un panel).
  mapaChico.invalidateSize();
  mapaChico.fitBounds(capaDelLote.getBounds(), { padding: [20, 20], maxZoom: 18, animate: false });
}

function mensajeDeWhatsapp(p) {
  return `Hola, me interesa ${tituloDe(p)}${p.sector ? ` en ${p.sector}` : ""}. ${location.href}`;
}

function render(feature) {
  clearTimeout(relojDeEspera);
  loteActual = feature;
  const p = feature.properties;

  elTitulo.textContent = tituloDe(p);
  document.title = `${tituloDe(p)} — MojonApp`;
  elPrecio.textContent = precioEnTexto(p);
  elUbicacion.textContent = [p.sector, p.barrio].filter(Boolean).join(" · ") || "Ubicación sin cargar";

  renderGaleria(p);
  renderDatos(p);
  renderMapa(feature);

  // Subir fotos: solo con sesión. Un visitante no puede, y mostrarle el
  // botón sería prometerle algo que las reglas van a rechazar.
  elSubir.classList.toggle("oculto", !auth.currentUser);

  elContenido.classList.remove("oculto");
  elNoEncontrado.classList.add("oculto");
  elEsperando.classList.add("oculto");
}

function noEncontrado() {
  clearTimeout(relojDeEspera);
  loteActual = null;
  elTitulo.textContent = "Lote";
  elContenido.classList.add("oculto");
  elEsperando.classList.add("oculto");
  elNoEncontrado.classList.remove("oculto");
}

// Cuánto se espera a los datos antes de admitir que algo salió mal. Es
// generoso a propósito: con una conexión rural una lectura puede tardar
// varios segundos y cortar antes sería declarar un error que no hubo.
const ESPERA_MAXIMA_MS = 15000;
let relojDeEspera = null;

function cargando() {
  clearTimeout(relojDeEspera);
  elContenido.classList.add("oculto");
  elNoEncontrado.classList.add("oculto");
  elEsperando.classList.remove("oculto");
  elEsperandoTexto.textContent = "Cargando la propiedad…";
  elReintentar.classList.add("oculto");

  relojDeEspera = setTimeout(() => {
    // Se distingue de "no existe" a propósito: el lote puede estar
    // perfectamente, y decirle a alguien que la propiedad no existe
    // cuando lo que falló fue la conexión es perder una venta por un
    // error nuestro.
    elEsperandoTexto.textContent =
      "No pudimos cargar la propiedad. Puede ser la conexión.";
    elReintentar.classList.remove("oculto");
  }, ESPERA_MAXIMA_MS);
}

// Recargar y no "reintentar la consulta": lo que falló fue la carga
// inicial de los lotes, que la hace app.js al arrancar. Volver a
// arrancar la página es lo único que la vuelve a disparar, y para quien
// está del otro lado es lo mismo.
elReintentar.addEventListener("click", () => location.reload());

/**
 * Dibuja la página si la ruta actual es la de un lote.
 *
 * Se llama desde dos lados: cuando el router entra en la ruta, y cuando
 * terminan de cargar los lotes (app.js). El segundo hace falta porque
 * entrar directo por el link llega antes que los datos, y sin eso la
 * página diría "no se encontró" para un lote que sí existe.
 */
export function refrescarLotePublicoSiCorresponde() {
  if (elPanel.classList.contains("oculto")) return;
  const id = idDeLaUrl();
  if (!id) return;
  const feature = getLotesActuales().find((f) => f.id === id);
  if (feature) render(feature);
  else if (getLotesActuales().length > 0) noEncontrado();
}

function idDeLaUrl() {
  const partes = location.pathname.split("/lote/");
  return partes.length > 1 ? partes[1].split("/")[0] : null;
}

onRutaAplicada((ruta) => {
  if (ruta.clave !== "lote-publico") return;
  elPanel.classList.remove("oculto");
  const feature = getLotesActuales().find((f) => f.id === ruta.loteId);
  if (feature) {
    render(feature);
  } else if (getLotesActuales().length > 0) {
    noEncontrado();
  } else {
    // Todavía sin datos. NO se dice "no existe" mientras se carga: sería
    // mentirle a alguien que tiene un link bueno.
    //
    // Pero tampoco se deja la pantalla en blanco y en silencio, que es
    // lo que hacía antes: si la lectura falla (sin señal, se cortó en la
    // mitad), los datos no llegan NUNCA y el comprador se queda mirando
    // una página vacía sin saber si está cargando o si se rompió. Con la
    // conexión de un pueblo eso no es un caso raro.
    cargando();
  }
});

// ---------------------------------------------------------------------------
// Subir fotos (varias de una)
// ---------------------------------------------------------------------------

elSubirInput.addEventListener("change", async () => {
  const archivos = [...elSubirInput.files];
  if (archivos.length === 0 || !loteActual) return;

  elSubirEstado.textContent = `Subiendo ${archivos.length}...`;
  const subidas = [];
  for (const archivo of archivos) {
    try {
      subidas.push(await subirFotoACloudinary(archivo));
      elSubirEstado.textContent = `Subiendo ${subidas.length} de ${archivos.length}...`;
    } catch {
      // Se sigue con las demás: que una foto pesada falle no tiene por
      // qué tirar abajo las otras cuatro que ya se subieron.
    }
  }
  elSubirInput.value = "";

  if (subidas.length === 0) {
    elSubirEstado.textContent = "No se pudo subir ninguna foto.";
    return;
  }
  try {
    await updateDoc(doc(db, "lotes", loteActual.id), { fotos: arrayUnion(...subidas) });
    loteActual.properties.fotos = [...(loteActual.properties.fotos || []), ...subidas];
    renderGaleria(loteActual.properties);
    elSubirEstado.textContent =
      subidas.length === archivos.length
        ? `Listo: ${subidas.length} ${subidas.length === 1 ? "foto" : "fotos"}.`
        : `Se subieron ${subidas.length} de ${archivos.length}.`;
  } catch {
    elSubirEstado.textContent = "Las fotos se subieron pero no se pudieron guardar en el lote.";
  }
});

// ---------------------------------------------------------------------------
// Consulta del comprador
// ---------------------------------------------------------------------------

// El botón de WhatsApp se lleva lo que ya haya escrito en el
// formulario. Si alguien llenó sus datos y el envío falló, o si
// directamente prefiere WhatsApp, no tiene que escribirlos de nuevo —
// escribirlos dos veces es donde se abandona una consulta.
function abrirWhatsapp() {
  if (!loteActual) return;
  const nombre = document.getElementById("lp-nombre").value.trim();
  const telefono = document.getElementById("lp-telefono").value.trim();
  const email = document.getElementById("lp-email").value.trim();
  const mensaje = document.getElementById("lp-mensaje").value.trim();

  const partes = [mensajeDeWhatsapp(loteActual.properties)];
  if (nombre) partes.push(`\nNombre: ${nombre}`);
  if (telefono) partes.push(`Teléfono: ${telefono}`);
  if (email) partes.push(`Email: ${email}`);
  if (mensaje) partes.push(`\n${mensaje}`);

  window.open(`https://wa.me/?text=${encodeURIComponent(partes.join("\n"))}`, "_blank", "noopener");
}

elWhatsapp.addEventListener("click", abrirWhatsapp);

elForm.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!loteActual) return;

  const nombre = document.getElementById("lp-nombre").value.trim();
  const telefono = document.getElementById("lp-telefono").value.trim();
  const email = document.getElementById("lp-email").value.trim();
  const mensaje = document.getElementById("lp-mensaje").value.trim();
  if (!nombre || !telefono) return;

  // Se valida acá también, con las MISMAS reglas que usa el servidor
  // (js/consulta-lote.js), nada más que para no hacer viajar un pedido
  // que va a rebotar y para poder decir qué falta al instante. La que
  // vale es la del servidor: este endpoint es público y cualquiera puede
  // postearle sin pasar por este formulario.
  const validacion = validarConsulta({ loteId: loteActual.id, nombre, telefono, email, mensaje });
  elFormMensaje.classList.remove("oculto");
  if (!validacion.ok) {
    elFormMensaje.textContent = validacion.error;
    return;
  }

  elFormMensaje.textContent = "Enviando...";

  // GUARDAR LA CONSULTA NECESITA SESIÓN, Y EL COMPRADOR NO TIENE.
  //
  // Las reglas de Firestore exigen estar autenticado para crear un
  // contacto, así que este formulario no puede escribir en la base desde
  // el navegador. Escribe functions/consulta-lote.js, del lado del
  // servidor, con una cuenta propia de la app hecha para esto. Acá solo
  // se postea.
  //
  // Con sesión abierta (el corredor mirando su propia publicación) se
  // sigue usando el camino de siempre, que además junta la consulta con
  // un contacto que ya exista con ese teléfono en vez de duplicarlo.
  if (auth.currentUser) {
    try {
      await crearContactoDesdeInteresado({
        nombre,
        telefono,
        nota: [mensaje, email ? `Email: ${email}` : null].filter(Boolean).join(" · ") || null,
        feature: loteActual
      });
      elForm.reset();
      elFormMensaje.textContent = "¡Listo! Tu consulta quedó registrada, te vamos a contactar.";
    } catch {
      elFormMensaje.textContent = "No se pudo enviar la consulta. Probá por WhatsApp.";
    }
    return;
  }

  try {
    const respuesta = await fetch("/consulta-lote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validacion.consulta,
        // El campo trampa viaja tal cual lo dejó quien llenó el
        // formulario: vacío si fue una persona.
        apellido: elTrampa.value
      })
    });
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) throw new Error(datos.error || "falló");
    elForm.reset();
    elFormMensaje.textContent = "¡Listo! Tu consulta quedó registrada, te vamos a contactar.";
  } catch (error) {
    // SI FALLA NO SE PIERDE LA CONSULTA. El botón de WhatsApp de acá
    // abajo ya se lleva lo que la persona escribió (ver abrirWhatsapp),
    // así que alcanza con mandarla ahí: se pierde el registro
    // automático, no el contacto — que es lo que no se puede perder.
    const detalle = error.message && error.message !== "falló" ? `${error.message} ` : "";
    elFormMensaje.textContent = `${detalle}Mandanos la consulta por WhatsApp: el botón de abajo ya la lleva escrita.`;
  }
});
