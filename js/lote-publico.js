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
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 24,
      maxNativeZoom: 18,
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
}

function noEncontrado() {
  loteActual = null;
  elTitulo.textContent = "Lote";
  elContenido.classList.add("oculto");
  elNoEncontrado.classList.remove("oculto");
}

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
  // Todavía sin datos: se deja la pantalla en silencio (ni contenido ni
  // "no encontrado") hasta que lleguen. Decir "no existe" mientras se
  // está cargando sería mentir.
  if (feature) render(feature);
  else if (getLotesActuales().length > 0) noEncontrado();
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

function abrirWhatsapp() {
  if (!loteActual) return;
  const texto = encodeURIComponent(mensajeDeWhatsapp(loteActual.properties));
  window.open(`https://wa.me/?text=${texto}`, "_blank", "noopener");
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

  elFormMensaje.classList.remove("oculto");
  elFormMensaje.textContent = "Enviando...";

  // GUARDAR LA CONSULTA REQUIERE SESIÓN. Las reglas de Firestore exigen
  // estar autenticado para crear un contacto (ver firestore.rules), así
  // que un comprador anónimo no puede dejar su consulta en el CRM tal
  // como está hoy. Se resuelve habilitando el acceso anónimo en Firebase
  // más una regla acotada; mientras tanto, en vez de fallar, la consulta
  // se manda por WhatsApp con los datos ya escritos. Pierde el registro
  // automático, pero el comprador no pierde el contacto — que es lo que
  // no se puede perder.
  if (!auth.currentUser) {
    const texto = encodeURIComponent(
      `${mensajeDeWhatsapp(loteActual.properties)}\n\nNombre: ${nombre}\nTeléfono: ${telefono}` +
        (email ? `\nEmail: ${email}` : "") +
        (mensaje ? `\n\n${mensaje}` : "")
    );
    window.open(`https://wa.me/?text=${texto}`, "_blank", "noopener");
    elFormMensaje.textContent = "Te abrimos WhatsApp con la consulta lista para enviar.";
    return;
  }

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
});
