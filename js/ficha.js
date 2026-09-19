// ---------------------------------------------------------------------------
// Ficha del lote: el panel que se abre al tocar un lote (en el mapa, en la
// grilla, desde el dashboard o por deep-link) — datos, fotos (Cloudinary),
// interesados (mini-CRM), editores inline de servicios/zona/barrio, borrar
// lote, "Cómo llegar" y "Compartir este lote".
//
// Es el módulo más llamado por el resto de la app (por eso quedó para el
// final de la modularización) — pero nada de lo que necesita de otros
// módulos pasa por una dependencia circular real: mapa.js/vista-lista.js/
// dashboard.js reciben mostrarFicha() (y algunas otras funciones de acá)
// por parámetro (configurarX()), no por `import`, así que este archivo
// puede importar esos tres directo sin crear un ciclo.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { centroideDePoligono, textoMedidasLados, distanciaMetros } from "./geometria.js";
import {
  getLoteSeleccionado,
  setLoteSeleccionado,
  setLoteEditadoDesdeFicha,
  getDeepLinkAbierto,
  setDeepLinkAbierto,
  getLotesActuales
} from "./estado.js";
import { puedeEditarLote, puedeBorrarLote } from "./permisos.js";
import { poblarSelectSector, poblarSelectBarrio } from "./catalogos.js";
import { mapa, cargarLotesDesdeFirestore, abrirTooltipDeLote } from "./mapa.js";
import { mostrarEditarLoteDesdeGrilla } from "./vista-lista.js";
import { registrarVistaDeLote } from "./dashboard.js";
import { registrarAuditoria } from "./auditoria.js";
import { crearContactoDesdeInteresado, abrirContactoEnCrm } from "./crm.js";
// router.js es la capa de abajo: no importa nada de la app, así que no
// hay riesgo de ciclo.
import { navegarA } from "./router.js";
import { esFavorito, alternarFavorito } from "./favoritos.js";
import { distanciasReferenciaCercanas } from "./distancias-referencia.js";
import { leerNotasInternas } from "./notas-internas.js";

const COLECCION_LOTES = "lotes";

const ETIQUETA_ESTADO = {
  disponible: "Disponible",
  reservado: "Reservado",
  vendido: "Vendido"
};

// Badge "Nuevo" (idea propia, mismo criterio y misma constante que
// vista-lista.js — ver el comentario ahí y en cargar-lote.js).
const DIAS_NUEVO = 7;
function esLoteNuevo(p) {
  if (!p.creado_en) return false;
  const dias = (Date.now() - new Date(p.creado_en).getTime()) / 86400000;
  return dias >= 0 && dias <= DIAS_NUEVO;
}

// Texto de estado listo para mostrar, con la fecha de vencimiento de la
// reserva si corresponde ("Reservado (hasta 15/09/2026)" o "Reservado
// (vencida desde 10/09/2026)" en rojo) — para que un lote reservado
// hace rato y nunca actualizado no pase desapercibido. HTML porque el
// "vencida" va en rojo (.texto-vencido); si no hay fecha, se devuelve
// como texto plano (sin riesgo: ETIQUETA_ESTADO no trae HTML).
function textoEstadoConVencimiento(p) {
  const base = ETIQUETA_ESTADO[p.estado] || p.estado;
  if (p.estado !== "reservado" || !p.reservado_hasta) return base;
  const hoy = new Date().toISOString().slice(0, 10);
  const fecha = new Date(`${p.reservado_hasta}T00:00:00`).toLocaleDateString("es-AR");
  return p.reservado_hasta < hoy
    ? `${base} <span class="texto-vencido">(vencida desde ${fecha})</span>`
    : `${base} (hasta ${fecha})`;
}

// Servicios que puede tener un lote (luz/agua/gas/cloaca). El catastro no
// trae este dato — solo se carga a mano, así que la mayoría de los lotes
// importados de "+ Manzana"/"+ Parcela" no van a tener el campo
// `servicios` en absoluto. Se distingue "sin dato" (no se muestra nada)
// de "no tiene el servicio" (chip apagado).
const SERVICIOS_INFO = [
  { clave: "luz", icono: "⚡", etiqueta: "Luz" },
  { clave: "agua", icono: "🚰", etiqueta: "Agua" },
  { clave: "gas", icono: "🔥", etiqueta: "Gas" },
  { clave: "cloaca", icono: "🚽", etiqueta: "Cloaca" }
];

function renderServiciosHTML(servicios) {
  if (servicios == null) return "Sin datos";
  return SERVICIOS_INFO.map(({ clave, icono, etiqueta }) => {
    const tiene = !!servicios[clave];
    return `<span class="chip-servicio${tiene ? "" : " sin-servicio"}">${icono} ${etiqueta}</span>`;
  }).join("");
}

// Mismo helper que usa el resto de la app para las hojas inferiores
// (ficha, login, formularios de carga): cerrar las demás al abrir una.
// Se duplica acá (5 líneas, sin estado propio) en vez de importarla de
// app.js — evita otra dependencia circular por algo tan chico.
function abrirHoja(elHoja) {
  document.querySelectorAll(".hoja-inferior").forEach((hoja) => {
    if (hoja !== elHoja) hoja.classList.add("oculto");
  });
  elHoja.classList.remove("oculto");
}

const elFicha = document.getElementById("ficha-lote");
const elTitulo = document.getElementById("ficha-titulo");
const elSuperficie = document.getElementById("ficha-superficie");
const elMedidas = document.getElementById("ficha-medidas");
const elEstado = document.getElementById("ficha-estado");
const elPrecio = document.getElementById("ficha-precio");
const elServicios = document.getElementById("ficha-servicios");
const elDescripcion = document.getElementById("ficha-descripcion");
const elNotas = document.getElementById("ficha-notas");
const elNotasDt = document.getElementById("ficha-notas-dt");

// Trazabilidad de venta (idea propia — "vendido a" se carga desde
// "Editar lote", ver poblarSelectComprador/actualizarVisibilidadComprador
// en vista-lista.js): acá solo se muestra, y clickearlo abre ese
// contacto directo en el CRM (abrirContactoEnCrm, la misma función que
// ya usa el resumen de seguimientos del Dashboard).
const elFichaCompradorDt = document.getElementById("ficha-comprador-dt");
const elFichaCompradorDd = document.getElementById("ficha-comprador-dd");
const elFichaComprador = document.getElementById("ficha-comprador");

// "← Volver a [contacto]" (idea propia #2 de "el mapa como una cualidad
// del CRM"): cuando se llega a esta ficha desde un contacto puntual
// (mini-mapa o chip de "Lotes de interés" en crm-formulario.js, ver
// irALoteDesdeCrm en crm.js), no perder ese contexto — un solo click
// vuelve directo al formulario de ESE contacto (abrirContactoEnCrm, la
// misma función que ya usa "Vendido a" arriba). Recibe {id, nombre}
// sueltos (mismo criterio liviano que lotes_interes: [{id, titulo}]),
// no hace falta buscar el contacto completo en memoria para esto.
const elFichaVolverContacto = document.getElementById("ficha-volver-contacto");

function actualizarVolverContacto(contactoOrigen) {
  if (!contactoOrigen) {
    elFichaVolverContacto.classList.add("oculto");
    elFichaVolverContacto.onclick = null;
    return;
  }
  elFichaVolverContacto.textContent = `← Volver a ${contactoOrigen.nombre}`;
  elFichaVolverContacto.classList.remove("oculto");
  elFichaVolverContacto.onclick = () => abrirContactoEnCrm(contactoOrigen.id);
}

function actualizarComprador(feature) {
  const { estado, comprador_contacto_id, comprador_nombre } = feature.properties;
  const mostrar = estado === "vendido" && !!comprador_contacto_id && !!comprador_nombre;
  elFichaCompradorDt.classList.toggle("oculto", !mostrar);
  elFichaCompradorDd.classList.toggle("oculto", !mostrar);
  if (!mostrar) return;
  elFichaComprador.textContent = comprador_nombre;
  elFichaComprador.onclick = () => abrirContactoEnCrm(comprador_contacto_id);
}

// ---------------------------------------------------------------------------
// Tasador automático simple (idea propia, módulo #3 del listado para
// competir con Tokko) — mediana del precio por m² de lotes comparables
// reales (misma zona, o toda la cartera si la zona no tiene
// suficientes) multiplicada por la superficie de este lote. Mediana en
// vez de promedio a propósito: un solo lote con un precio raro (mal
// cargado, o una venta atípica) no debería mover el número tanto como
// con un promedio.
// ---------------------------------------------------------------------------

const elFichaTasacion = document.getElementById("ficha-tasacion");
const elTasacionRango = document.getElementById("tasacion-rango");
const elTasacionNota = document.getElementById("tasacion-nota");
const MIN_COMPARABLES_TASACION = 3;

function mediana(numeros) {
  const ordenados = [...numeros].sort((a, b) => a - b);
  const medio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 === 0 ? (ordenados[medio - 1] + ordenados[medio]) / 2 : ordenados[medio];
}

function tasacionEstimada(feature) {
  const { sector, superficie_m2 } = feature.properties;
  if (superficie_m2 == null || superficie_m2 <= 0) return null;

  const comparables = getLotesActuales().filter(
    (f) =>
      f.id !== feature.id &&
      f.properties.precio_usd != null &&
      f.properties.superficie_m2 != null &&
      f.properties.superficie_m2 > 0
  );
  const mismaZona = sector ? comparables.filter((f) => f.properties.sector === sector) : [];
  const base = mismaZona.length >= MIN_COMPARABLES_TASACION ? mismaZona : comparables;
  if (base.length < MIN_COMPARABLES_TASACION) return null;

  const medianaPorM2 = mediana(base.map((f) => f.properties.precio_usd / f.properties.superficie_m2));
  const estimado = medianaPorM2 * superficie_m2;
  return {
    minimo: estimado * 0.85,
    maximo: estimado * 1.15,
    cantidadComparables: base.length,
    esDeLaMismaZona: base === mismaZona && mismaZona.length > 0
  };
}

function actualizarTasacion(feature) {
  const tasacion = tasacionEstimada(feature);
  elFichaTasacion.classList.toggle("oculto", !tasacion);
  if (!tasacion) return;
  const formatear = (n) => Math.round(n).toLocaleString("es-AR");
  elTasacionRango.innerHTML = `<strong>USD ${formatear(tasacion.minimo)} – USD ${formatear(tasacion.maximo)}</strong>`;
  elTasacionNota.textContent = `Estimación automática comparando ${tasacion.cantidadComparables} lote${tasacion.cantidadComparables === 1 ? "" : "s"} con precio real ${tasacion.esDeLaMismaZona ? "de la misma zona" : "de la cartera"} — no reemplaza una tasación profesional.`;
}

// ---------------------------------------------------------------------------
// Calculadora de cuotas (idea propia, investigada en el simulador de
// financiación de REPLUS antes de armarla — ver
// feedback_buscar_inspiracion_real). A diferencia de un crédito
// hipotecario, acá NO hay tasa de interés: un lote en estos loteos se
// paga directo a la inmobiliaria en cuotas fijas ("anticipo y 12
// cuotas" es el texto típico en Zonaprop/MercadoLibre para este tipo de
// terreno) — por eso el cálculo es una simple resta y división, sin
// interés compuesto de por medio.
// ---------------------------------------------------------------------------

const elCalculadoraCuotas = document.getElementById("ficha-calculadora-cuotas");
const elCalcAnticipoPct = document.getElementById("calc-anticipo-pct");
const elCalcCantidadCuotas = document.getElementById("calc-cantidad-cuotas");
const elCalcResultado = document.getElementById("calc-resultado");

function recalcularCuotas() {
  const feature = getLoteSeleccionado();
  if (!feature || feature.properties.precio_usd == null) return;
  const precio = Number(feature.properties.precio_usd);
  const anticipoPct = Math.min(100, Math.max(0, Number(elCalcAnticipoPct.value) || 0));
  const cantidadCuotas = Math.max(1, Math.round(Number(elCalcCantidadCuotas.value) || 1));
  const anticipo = precio * (anticipoPct / 100);
  const cuota = (precio - anticipo) / cantidadCuotas;
  const formatear = (n) => Math.round(n).toLocaleString("es-AR");
  elCalcResultado.innerHTML = `Anticipo: <strong>USD ${formatear(anticipo)}</strong> + <strong>${cantidadCuotas}</strong> cuota${cantidadCuotas === 1 ? "" : "s"} de <strong>USD ${formatear(cuota)}</strong>`;
}

// Solo tiene sentido con precio cargado — sin eso no hay nada que
// calcular (mismo criterio que "Sin datos" en el resto de la ficha).
function actualizarCalculadoraCuotas(feature) {
  const visible = feature.properties.precio_usd != null;
  elCalculadoraCuotas.classList.toggle("oculto", !visible);
  if (visible) recalcularCuotas();
}

elCalcAnticipoPct.addEventListener("input", recalcularCuotas);
elCalcCantidadCuotas.addEventListener("input", recalcularCuotas);

// ---------------------------------------------------------------------------
// Fotos del lote: se suben directo desde el navegador a Cloudinary (plan
// gratis, sin tarjeta — a diferencia de Firebase Storage o Cloudflare R2,
// que piden tarjeta cargada aunque el uso se mantenga gratis, ver charla
// con el usuario) usando un "upload preset" sin firmar (unsigned) — el
// modo pensado por Cloudinary para subir directo desde el cliente sin
// exponer ninguna clave secreta ni necesitar un servidor propio. Firestore
// solo guarda la URL resultante (y el public_id, por si en el futuro hace
// falta) en un array "fotos" del lote, mismo patrón que "interesados"
// (arrayUnion/arrayRemove) más abajo.
//
// Cloud name y upload preset de la cuenta de Cloudinary del usuario —
// ninguno de los dos es secreto (a diferencia del API key/secret, que
// jamás deben viajar al navegador): son justamente los dos únicos datos
// que Cloudinary espera ver embebidos en código de cliente para el modo
// "unsigned". El preset está configurado como Unsigned + carpeta
// "mojonapp-lotes" en el panel de Cloudinary.
const CLOUDINARY_CLOUD_NAME = "ipuyvn4v";
const CLOUDINARY_UPLOAD_PRESET = "mojonapp_lotes";

const elFichaFotos = document.getElementById("ficha-fotos");
const elGaleriaFotos = document.getElementById("galeria-fotos-lote");
const elSubirFotoLabel = document.getElementById("subir-foto-label");
const elInputFotoLote = document.getElementById("input-foto-lote");
const elFichaFotoCargando = document.getElementById("ficha-foto-cargando");
const elFichaFotoError = document.getElementById("ficha-foto-error");

// Se exporta para que la página pública del lote suba fotos por el mismo
// camino (js/lote-publico.js): una sola implementación de la subida, y
// el formato del objeto guardado queda garantizado igual — arrayRemove,
// que usa borrarFoto, necesita coincidir EXACTO con lo guardado.
export async function subirFotoACloudinary(archivo) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    throw new Error("Cloudinary todavía no está configurado en la app (falta CLOUDINARY_CLOUD_NAME/CLOUDINARY_UPLOAD_PRESET).");
  }
  const formData = new FormData();
  formData.append("file", archivo);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  const respuesta = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: "POST",
    body: formData
  });
  if (!respuesta.ok) {
    throw new Error("Cloudinary rechazó la subida.");
  }
  const datos = await respuesta.json();
  // Un objeto chico y estable a propósito: arrayRemove (ver borrarFoto)
  // necesita coincidir EXACTO con lo que ya está guardado para poder
  // sacarlo, así que cuantos menos campos variables, mejor.
  return { url: datos.secure_url, id: datos.public_id };
}

function renderFotos(feature) {
  const fotos = feature.properties.fotos || [];
  const puedeSubir = puedeEditarLote(feature);

  elFichaFotos.classList.toggle("oculto", fotos.length === 0 && !puedeSubir);
  elSubirFotoLabel.classList.toggle("oculto", !puedeSubir);

  elGaleriaFotos.innerHTML = "";
  fotos.forEach((foto) => {
    const contenedor = document.createElement("div");
    contenedor.className = "foto-lote";

    const img = document.createElement("img");
    img.src = foto.url;
    img.loading = "lazy";
    img.alt = "Foto del lote";
    // Ver más grande en una pestaña aparte — más simple que armar un
    // visor propio para una sola imagen a la vez.
    img.addEventListener("click", () => window.open(foto.url, "_blank"));
    contenedor.appendChild(img);

    if (puedeSubir) {
      const botonBorrar = document.createElement("button");
      botonBorrar.type = "button";
      botonBorrar.className = "btn-borrar-foto";
      botonBorrar.textContent = "×";
      botonBorrar.setAttribute("aria-label", "Borrar foto");
      botonBorrar.addEventListener("click", (evento) => {
        evento.stopPropagation();
        borrarFoto(feature, foto);
      });
      contenedor.appendChild(botonBorrar);
    }

    elGaleriaFotos.appendChild(contenedor);
  });
}

async function borrarFoto(feature, foto) {
  if (!window.confirm("¿Borrar esta foto del lote?")) return;
  try {
    // Solo saca la referencia en Firestore — el archivo en sí sigue
    // ocupando espacio en Cloudinary. Borrarlo de ahí también necesita
    // una llamada FIRMADA (con la clave secreta), que no puede hacerse
    // con seguridad desde el navegador — queda fuera de alcance por
    // ahora, la cuota gratis (25GB) da para mucho antes de que importe.
    await updateDoc(doc(db, COLECCION_LOTES, feature.id), { fotos: arrayRemove(foto) });
    feature.properties.fotos = (feature.properties.fotos || []).filter((f) => f !== foto);
    renderFotos(feature);
  } catch (error) {
    window.alert(
      error.code === "permission-denied" ? "No tienes permiso para borrar fotos de este lote." : "No se pudo borrar la foto."
    );
  }
}

elInputFotoLote.addEventListener("change", async () => {
  const archivo = elInputFotoLote.files[0];
  if (!archivo || !getLoteSeleccionado()) return;

  elFichaFotoError.classList.add("oculto");
  elFichaFotoCargando.classList.remove("oculto");
  elInputFotoLote.disabled = true;
  try {
    const foto = await subirFotoACloudinary(archivo);
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { fotos: arrayUnion(foto) });
    if (!getLoteSeleccionado().properties.fotos) getLoteSeleccionado().properties.fotos = [];
    getLoteSeleccionado().properties.fotos.push(foto);
    renderFotos(getLoteSeleccionado());
  } catch (error) {
    elFichaFotoError.textContent =
      error.code === "permission-denied" ? "No tienes permiso para agregar fotos a este lote." : "No se pudo subir la foto. Prueba de nuevo.";
    elFichaFotoError.classList.remove("oculto");
  } finally {
    elFichaFotoCargando.classList.add("oculto");
    elInputFotoLote.disabled = false;
    elInputFotoLote.value = "";
  }
});

// Interesados: mini-CRM liviano, solo para quien puede editar el lote.
const elFichaInteresados = document.getElementById("ficha-interesados");
const elListaInteresados = document.getElementById("lista-interesados");
const formularioInteresado = document.getElementById("formulario-interesado");
const elInteresadoNombre = document.getElementById("interesado-nombre");
const elInteresadoTelefono = document.getElementById("interesado-telefono");
const elInteresadoNota = document.getElementById("interesado-nota");
const elInteresadoError = document.getElementById("interesado-error");

function renderInteresados(feature) {
  const interesados = feature.properties.interesados || [];
  elListaInteresados.innerHTML = "";
  interesados.forEach((interesado) => {
    const fila = document.createElement("li");
    fila.className = "fila-interesado";

    const datos = document.createElement("div");
    datos.className = "fila-interesado-datos";
    const fecha = interesado.fecha
      ? new Date(`${interesado.fecha}T00:00:00`).toLocaleDateString("es-AR")
      : "";
    datos.innerHTML = `<strong>${interesado.nombre}</strong>${
      interesado.telefono ? ` · ${interesado.telefono}` : ""
    }${interesado.nota ? ` · ${interesado.nota}` : ""}${fecha ? ` <span>(${fecha})</span>` : ""}`;

    const botonBorrar = document.createElement("button");
    botonBorrar.type = "button";
    botonBorrar.textContent = "Borrar";
    botonBorrar.addEventListener("click", () => borrarInteresado(feature, interesado));

    fila.append(datos, botonBorrar);
    elListaInteresados.appendChild(fila);
  });
}

async function borrarInteresado(feature, interesado) {
  if (!window.confirm(`¿Borrar a "${interesado.nombre}" de los interesados en este lote?`)) return;
  try {
    await updateDoc(doc(db, COLECCION_LOTES, feature.id), { interesados: arrayRemove(interesado) });
    feature.properties.interesados = (feature.properties.interesados || []).filter((i) => i !== interesado);
    renderInteresados(feature);
  } catch (error) {
    window.alert(
      error.code === "permission-denied"
        ? "No tienes permiso para borrar interesados."
        : "No se pudo borrar."
    );
  }
}

formularioInteresado.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  if (!getLoteSeleccionado()) return;
  elInteresadoError.classList.add("oculto");

  const nombre = elInteresadoNombre.value.trim();
  if (!nombre) return;
  const interesado = {
    nombre,
    telefono: elInteresadoTelefono.value.trim() || null,
    nota: elInteresadoNota.value.trim() || null,
    fecha: new Date().toISOString().slice(0, 10)
  };

  const boton = document.getElementById("interesado-guardar-btn");
  boton.disabled = true;
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), {
      interesados: arrayUnion(interesado)
    });
    if (!getLoteSeleccionado().properties.interesados) {
      getLoteSeleccionado().properties.interesados = [];
    }
    getLoteSeleccionado().properties.interesados.push(interesado);
    renderInteresados(getLoteSeleccionado());
    formularioInteresado.reset();
    // Fire-and-forget: alimenta el CRM central (js/crm.js) además de
    // guardarse acá en el lote — si esto falla (sin conexión, etc.) el
    // interesado ya quedó guardado arriba, no se le avisa nada al
    // corredor por algo que no le impide seguir su flujo.
    crearContactoDesdeInteresado({
      nombre: interesado.nombre,
      telefono: interesado.telefono,
      nota: interesado.nota,
      feature: getLoteSeleccionado()
    });
  } catch (error) {
    elInteresadoError.textContent =
      error.code === "permission-denied"
        ? "No tienes permiso para agregar interesados."
        : "No se pudo guardar.";
    elInteresadoError.classList.remove("oculto");
  } finally {
    boton.disabled = false;
  }
});

const elBtnEditarServicios = document.getElementById("btn-editar-servicios");
const elEditorServicios = document.getElementById("editor-servicios");
const elEditarServicioLuz = document.getElementById("editar-servicio-luz");
const elEditarServicioAgua = document.getElementById("editar-servicio-agua");
const elEditarServicioGas = document.getElementById("editar-servicio-gas");
const elEditarServicioCloaca = document.getElementById("editar-servicio-cloaca");
const elBtnGuardarServicios = document.getElementById("btn-guardar-servicios");
const elBtnCancelarServicios = document.getElementById("btn-cancelar-servicios");
const elEditorServiciosError = document.getElementById("editor-servicios-error");

const elSector = document.getElementById("ficha-sector");
const elBtnEditarSector = document.getElementById("btn-editar-sector");
const elEditorSector = document.getElementById("editor-sector");
const elEditarSectorValor = document.getElementById("editar-sector-valor");
const elBtnGuardarSector = document.getElementById("btn-guardar-sector");
const elBtnCancelarSector = document.getElementById("btn-cancelar-sector");
const elEditorSectorError = document.getElementById("editor-sector-error");

const elBarrio = document.getElementById("ficha-barrio");
const elBtnEditarBarrio = document.getElementById("btn-editar-barrio");
const elEditorBarrio = document.getElementById("editor-barrio");
const elEditarBarrioValor = document.getElementById("editar-barrio-valor");
const elBtnGuardarBarrio = document.getElementById("btn-guardar-barrio");
const elBtnCancelarBarrio = document.getElementById("btn-cancelar-barrio");
const elEditorBarrioError = document.getElementById("editor-barrio-error");

// Varios lotes reales todavía no tienen nomenclatura catastral asignada ni
// manzana/lote definidos (loteos nuevos, en trámite). Se arma el título con
// el mejor identificador disponible, sin mostrar nunca "null".
export function tituloLote(p) {
  if (p.nomenclatura) return p.nomenclatura;
  if (p.manzana != null && p.lote != null) return `Manzana ${p.manzana} — Lote ${p.lote}`;
  return "Lote sin nomenclatura catastral";
}

// Contenido del cartel que aparece al pasar el mouse por encima de un
// lote cargado (ver bindTooltip en mapa.js) — un resumen rápido sin
// tener que tocarlo y abrir la ficha completa.
export function contenidoTooltipLote(feature) {
  const p = feature.properties;
  const superficie = p.superficie_m2 == null ? "Sin datos" : `${p.superficie_m2} m²`;
  const precio = p.precio_usd == null ? "Sin datos" : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`;
  return `
    <div class="tooltip-lote-titulo">${tituloLote(p)}</div>
    <div>Zona: ${p.sector || "Sin datos"}</div>
    <div>Barrio: ${p.barrio || "Sin datos"}</div>
    <div>Superficie: ${superficie}</div>
    <div>Medidas: ${textoMedidasLados(feature.geometry.coordinates[0])}</div>
    <div>Estado: ${textoEstadoConVencimiento(p)}</div>
    <div>Precio: ${precio}</div>
  `;
}

export function mostrarFicha(feature, contactoOrigen = null) {
  setLoteSeleccionado(feature);
  const p = feature.properties;

  actualizarVolverContacto(contactoOrigen);
  elTitulo.innerHTML = `${tituloLote(p)}${esLoteNuevo(p) ? ' <span class="chip-nuevo">Nuevo</span>' : ""}`;
  elSector.textContent = p.sector || "Sin datos";
  elBarrio.textContent = p.barrio || "Sin datos";
  // superficie_m2 puede venir en null: el catastro no siempre la declara
  // para sub-parcelas (se vio con datos reales de "+ Manzana"), y a
  // diferencia del formulario manual, la importación en bloque no pasa
  // por el "required" del campo — puede llegar null a Firestore.
  elSuperficie.textContent = p.superficie_m2 == null ? "Sin datos" : `${p.superficie_m2} m²`;
  elMedidas.textContent = textoMedidasLados(feature.geometry.coordinates[0]);
  elEstado.innerHTML = textoEstadoConVencimiento(p);
  actualizarComprador(feature);
  elPrecio.textContent = p.precio_usd == null ? "Sin datos" : `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`;
  elServicios.innerHTML = renderServiciosHTML(p.servicios);
  elDescripcion.textContent = p.descripcion || "Sin datos";
  actualizarTasacion(feature);
  actualizarCalculadoraCuotas(feature);
  renderFotos(feature);
  actualizarBotonFavorito(feature.id);
  renderLotesSimilares(feature);
  actualizarCercanias(feature);
  actualizarNotasInternas(feature);

  aplicarPermisosEnLaFicha(feature);
  renderInteresados(feature);
  cerrarEditorServicios(); // por si había quedado abierto en el lote anterior
  cerrarEditorSector();
  cerrarEditorBarrio();

  abrirHoja(elFicha);
  registrarVistaDeLote(feature);
  ponerElLoteEnLaUrl(feature.id);
}

// ---------------------------------------------------------------------------
// El lote abierto vive en la URL
//
// POR QUÉ ES ESTRUCTURAL Y NO UN DETALLE (pedido del usuario del
// 2026-09-18: "sin un ID en la URL es info flotante que puede ser
// duplicable"). Un lote abierto sin identificador en la dirección no es
// una cosa a la que se pueda volver: no se puede recargar sin perderlo,
// no se puede mandar por WhatsApp, no se puede tener dos abiertos en dos
// pestañas, y el "atrás" del navegador no significa nada. Para una
// inmobiliaria eso es peor que una molestia: el link a una propiedad es
// el objeto que circula entre el corredor y el cliente.
//
// Se usa el MISMO parámetro que ya usaba "Compartir este lote"
// (?lote=<id>), que ya estaba probado de punta a punta: abrirlo desde
// una URL pegada a mano funciona desde antes. Lo que faltaba era que la
// URL se mantuviera sola al abrir un lote desde adentro de la app.
//
// replaceState y no pushState: el "atrás" sigue significando "volver a
// la sección anterior", que es lo que hace el resto de la app (ver
// js/router.js). Con pushState, cada lote mirado agregaría una entrada
// al historial y para salir del mapa habría que apretar atrás diez
// veces.
// ---------------------------------------------------------------------------

function ponerElLoteEnLaUrl(id) {
  const url = new URL(location.href);
  if (url.searchParams.get("lote") === id) return;
  url.searchParams.set("lote", id);
  history.replaceState(history.state, "", url);
}

export function sacarElLoteDeLaUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has("lote")) return;
  url.searchParams.delete("lote");
  history.replaceState(history.state, "", url);
}

// "Ver publicación": lleva a la página pública del lote (/lote/<id>),
// que es la que se le muestra a un comprador. La ficha sigue siendo la
// hoja de trabajo del corredor; desde acá se pasa a ver cómo la ve el
// cliente, sin tener que copiar el link y pegarlo.
document.getElementById("btn-ver-publicacion").addEventListener("click", () => {
  const feature = getLoteSeleccionado();
  if (feature) navegarA(`/lote/${feature.id}`);
});

document.getElementById("cerrar-ficha").addEventListener("click", () => {
  elFicha.classList.add("oculto");
  // Cerrar la ficha saca el lote de la URL: si quedara, recargar
  // volvería a abrir un lote que el usuario ya cerró.
  sacarElLoteDeLaUrl();
});

// "Editar lote" en la ficha abre el mismo formulario completo que
// "Editar" desde la grilla (manzana/lote/nomenclatura/superficie/
// estado/precio/sector/servicios/descripción) — pedido explícito:
// antes solo se podía corregir todo eso yendo a "Ver como lista", acá
// arriba del mapa solo había editores sueltos para sector y servicios.
// Reusa mostrarEditarLoteDesdeGrilla tal cual para no duplicar la
// validación de nomenclatura ni el guardado.
document.getElementById("btn-editar-lote-completo").addEventListener("click", () => {
  if (!getLoteSeleccionado()) return;
  elFicha.classList.add("oculto");
  document.getElementById("panel-admin").classList.add("oculto");
  document.getElementById("panel-sectores").classList.add("oculto");
  document.getElementById("panel-barrios").classList.add("oculto");
  document.getElementById("vista-lista").classList.remove("oculto");
  document.getElementById("btn-ver-lista").classList.add("activo");
  setLoteEditadoDesdeFicha(true);
  mostrarEditarLoteDesdeGrilla(getLoteSeleccionado());
});

// Editar servicios de un lote ya cargado: el catastro no trae este dato,
// así que la mayoría de los lotes traídos por "+ Manzana"/"+ Parcela"
// necesitan que un corredor lo complete después, no solo al cargarlos a
// mano. Mismo criterio de permiso que "Borrar lote" (propio/ajeno, ver
// puedeEditarLote).
export function cerrarEditorServicios() {
  elEditorServicios.classList.add("oculto");
  elServicios.classList.remove("oculto");
  elBtnEditarServicios.classList.toggle(
    "oculto",
    !getLoteSeleccionado() || !puedeEditarLote(getLoteSeleccionado())
  );
  elEditorServiciosError.classList.add("oculto");
}

elBtnEditarServicios.addEventListener("click", () => {
  const servicios = getLoteSeleccionado()?.properties?.servicios || {};
  elEditarServicioLuz.checked = !!servicios.luz;
  elEditarServicioAgua.checked = !!servicios.agua;
  elEditarServicioGas.checked = !!servicios.gas;
  elEditarServicioCloaca.checked = !!servicios.cloaca;
  elServicios.classList.add("oculto");
  elBtnEditarServicios.classList.add("oculto");
  elEditorServicios.classList.remove("oculto");
});

elBtnCancelarServicios.addEventListener("click", cerrarEditorServicios);

elBtnGuardarServicios.addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const servicios = {
    luz: elEditarServicioLuz.checked,
    agua: elEditarServicioAgua.checked,
    gas: elEditarServicioGas.checked,
    cloaca: elEditarServicioCloaca.checked
  };

  elBtnGuardarServicios.disabled = true;
  elEditorServiciosError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { servicios });
    registrarAuditoria({
      accion: "editar_lote",
      objetoId: getLoteSeleccionado().id,
      objetoTitulo: tituloLote(getLoteSeleccionado().properties),
      detalle: "Editó servicios"
    });
    getLoteSeleccionado().properties.servicios = servicios;
    elServicios.innerHTML = renderServiciosHTML(servicios);
    cerrarEditorServicios();
    cargarLotesDesdeFirestore(); // refresca mapa y grilla; la ficha ya se actualizó sola arriba
  } catch (error) {
    elEditorServiciosError.textContent =
      error.code === "permission-denied"
        ? "No tienes permiso para editar servicios. Inicia sesión de nuevo."
        : "No se pudieron guardar los servicios.";
    elEditorServiciosError.classList.remove("oculto");
  } finally {
    elBtnGuardarServicios.disabled = false;
  }
});

// Editar sector/zona: es el corredor quien organiza su propia cartera
// (el catastro no tiene idea de "sectores"), así que casi todo lote
// importado necesita que alguien se lo asigne después. Mismo criterio
// de permiso y mismo patrón que "Editar servicios".
export function cerrarEditorSector() {
  elEditorSector.classList.add("oculto");
  elSector.classList.remove("oculto");
  elBtnEditarSector.classList.toggle(
    "oculto",
    !getLoteSeleccionado() || !puedeEditarLote(getLoteSeleccionado())
  );
  elEditorSectorError.classList.add("oculto");
}

elBtnEditarSector.addEventListener("click", () => {
  poblarSelectSector(elEditarSectorValor, getLoteSeleccionado()?.properties?.sector);
  elSector.classList.add("oculto");
  elBtnEditarSector.classList.add("oculto");
  elEditorSector.classList.remove("oculto");
  elEditarSectorValor.focus();
});

elBtnCancelarSector.addEventListener("click", cerrarEditorSector);

elBtnGuardarSector.addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const sector = elEditarSectorValor.value.trim() || null;

  elBtnGuardarSector.disabled = true;
  elEditorSectorError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { sector });
    registrarAuditoria({
      accion: "editar_lote",
      objetoId: getLoteSeleccionado().id,
      objetoTitulo: tituloLote(getLoteSeleccionado().properties),
      detalle: `Zona: ${getLoteSeleccionado().properties.sector || "Sin datos"} → ${sector || "Sin datos"}`
    });
    getLoteSeleccionado().properties.sector = sector;
    elSector.textContent = sector || "Sin datos";
    cerrarEditorSector();
    cargarLotesDesdeFirestore(); // refresca mapa y grilla; la ficha ya se actualizó sola arriba
  } catch (error) {
    elEditorSectorError.textContent =
      error.code === "permission-denied"
        ? "No tienes permiso para editar la zona. Inicia sesión de nuevo."
        : "No se pudo guardar la zona.";
    elEditorSectorError.classList.remove("oculto");
  } finally {
    elBtnGuardarSector.disabled = false;
  }
});

// Editar barrio: mismo patrón exacto que "Editar zona" arriba — segunda
// categorización independiente de un lote.
export function cerrarEditorBarrio() {
  elEditorBarrio.classList.add("oculto");
  elBarrio.classList.remove("oculto");
  elBtnEditarBarrio.classList.toggle(
    "oculto",
    !getLoteSeleccionado() || !puedeEditarLote(getLoteSeleccionado())
  );
  elEditorBarrioError.classList.add("oculto");
}

elBtnEditarBarrio.addEventListener("click", () => {
  poblarSelectBarrio(elEditarBarrioValor, getLoteSeleccionado()?.properties?.barrio);
  elBarrio.classList.add("oculto");
  elBtnEditarBarrio.classList.add("oculto");
  elEditorBarrio.classList.remove("oculto");
  elEditarBarrioValor.focus();
});

elBtnCancelarBarrio.addEventListener("click", cerrarEditorBarrio);

elBtnGuardarBarrio.addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const barrio = elEditarBarrioValor.value.trim() || null;

  elBtnGuardarBarrio.disabled = true;
  elEditorBarrioError.classList.add("oculto");
  try {
    await updateDoc(doc(db, COLECCION_LOTES, getLoteSeleccionado().id), { barrio });
    registrarAuditoria({
      accion: "editar_lote",
      objetoId: getLoteSeleccionado().id,
      objetoTitulo: tituloLote(getLoteSeleccionado().properties),
      detalle: `Barrio: ${getLoteSeleccionado().properties.barrio || "Sin datos"} → ${barrio || "Sin datos"}`
    });
    getLoteSeleccionado().properties.barrio = barrio;
    elBarrio.textContent = barrio || "Sin datos";
    cerrarEditorBarrio();
    cargarLotesDesdeFirestore(); // refresca mapa y grilla; la ficha ya se actualizó sola arriba
  } catch (error) {
    elEditorBarrioError.textContent =
      error.code === "permission-denied"
        ? "No tienes permiso para editar el barrio. Inicia sesión de nuevo."
        : "No se pudo guardar el barrio.";
    elEditorBarrioError.classList.remove("oculto");
  } finally {
    elBtnGuardarBarrio.disabled = false;
  }
});

// "Borrar lote": solo visible para quien puede editar/borrar ese lote
// puntual (ver puedeBorrarLote). Pide confirmación porque borrar un
// documento de Firestore no se puede deshacer. La usan tanto el botón
// de la ficha como el de cada fila de la vista en lista.
export async function borrarLote(feature, elBoton) {
  const titulo = tituloLote(feature.properties);
  if (!window.confirm(`¿Borrar "${titulo}"? No se puede deshacer.`)) return;

  if (elBoton) elBoton.disabled = true;
  try {
    await deleteDoc(doc(db, COLECCION_LOTES, feature.id));
    registrarAuditoria({ accion: "borrar_lote", objetoId: feature.id, objetoTitulo: titulo });
    elFicha.classList.add("oculto");
    await cargarLotesDesdeFirestore();
  } catch (error) {
    window.alert(
      error.code === "permission-denied"
        ? "No tienes permiso para borrar lotes. Inicia sesión de nuevo."
        : "No se pudo borrar el lote."
    );
  } finally {
    if (elBoton) elBoton.disabled = false;
  }
}

const elBtnBorrarLote = document.getElementById("btn-borrar-lote");
elBtnBorrarLote.addEventListener("click", () => {
  if (!getLoteSeleccionado()) return;
  borrarLote(getLoteSeleccionado(), elBtnBorrarLote);
});

// ---------------------------------------------------------------------------
// Botón "Cómo llegar": abre Google Maps marcando el centroide del lote.
// Se usa el endpoint de búsqueda (maps/search, no maps/dir): probado a mano,
// "dir" (navegación) puede resolver la coordenada al comercio indexado más
// cercano y mostrar ESE nombre como destino (p. ej. un lote vacío terminó
// etiquetado como un taller de chapa y pintura a varios metros de ahí).
// "search" en cambio deja el pin exactamente en la coordenada que mandamos,
// sin sustituirlo por otro lugar. No admite una etiqueta con el nombre del
// lote (se probó el viejo truco de "lat,lon(Texto)" y ya no funciona, Google
// Maps directamente no encuentra la ubicación) — muestra coordenadas o el
// Plus Code, no el texto del lote. Tampoco calcula una ruta: es responsabilidad
// del corredor iniciar la navegación una vez que confirma visualmente el pin.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Favoritos: sin sesión, guardado en el propio navegador (ver
// js/favoritos.js) — funciona igual para un comprador anónimo mirando el
// mapa que para un corredor logueado.
// ---------------------------------------------------------------------------

const elBtnFavorito = document.getElementById("btn-favorito");

function actualizarBotonFavorito(loteId) {
  const guardado = esFavorito(loteId);
  elBtnFavorito.textContent = guardado ? "❤️" : "🤍";
  elBtnFavorito.setAttribute("aria-label", guardado ? "Quitar de favoritos" : "Guardar en favoritos");
  elBtnFavorito.classList.toggle("activo", guardado);
}

elBtnFavorito.addEventListener("click", () => {
  if (!getLoteSeleccionado()) return;
  const guardado = alternarFavorito(getLoteSeleccionado().id);
  elBtnFavorito.textContent = guardado ? "❤️" : "🤍";
  elBtnFavorito.setAttribute("aria-label", guardado ? "Quitar de favoritos" : "Guardar en favoritos");
  elBtnFavorito.classList.toggle("activo", guardado);
});

// ---------------------------------------------------------------------------
// "También te puede interesar": otros lotes de la misma zona (o, sin zona
// cargada, los más cercanos por geometría real) — mismo criterio que
// cualquier portal real (Zonaprop, LandWatch), para que quien mira un lote
// no se vaya sin ver el resto de la cartera cercana.
// ---------------------------------------------------------------------------

const elFichaSimilares = document.getElementById("ficha-similares");
const elFichaSimilaresLista = document.getElementById("ficha-similares-lista");
const CANTIDAD_SIMILARES = 4;

function lotesSimilares(feature) {
  const candidatos = getLotesActuales().filter((f) => f.id !== feature.id && f.properties.estado !== "vendido");
  if (candidatos.length === 0) return [];

  const { sector } = feature.properties;
  const mismaZona = sector ? candidatos.filter((f) => f.properties.sector === sector) : [];
  // Si la propia zona no alcanza para completar la cantidad pedida, se
  // completa con el resto de la cartera ordenado por distancia real —
  // así siempre hay algo útil para mostrar, tenga o no zona cargada.
  const base = mismaZona.length >= CANTIDAD_SIMILARES ? mismaZona : candidatos;

  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  return base
    .map((f) => {
      const centro = centroideDePoligono(f.geometry.coordinates[0]);
      return { feature: f, distancia: distanciaMetros(lat, lon, centro.lat, centro.lon) };
    })
    .sort((a, b) => a.distancia - b.distancia)
    .slice(0, CANTIDAD_SIMILARES)
    .map((x) => x.feature);
}

// "Reemplaza" la ficha actual por la del lote elegido — mismo criterio de
// animate:false que cargarLotesDesdeFirestore/abrirLoteDesdeUrlSiCorresponde
// (ver comentario ahí): con una animación de cámara todavía en curso,
// Leaflet puede ignorar en silencio este segundo setView.
function irALoteSimilar(feature) {
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  mapa.setView([lat, lon], 19, { animate: false });
  mostrarFicha(feature);
}

function renderLotesSimilares(feature) {
  const similares = lotesSimilares(feature);
  elFichaSimilares.classList.toggle("oculto", similares.length === 0);
  elFichaSimilaresLista.innerHTML = "";

  similares.forEach((f) => {
    const p = f.properties;
    const item = document.createElement("div");
    item.className = "ficha-similar-item";
    item.dataset.testid = `ficha-similar-${f.id}`;

    const titulo = document.createElement("p");
    titulo.className = "ficha-similar-titulo";
    titulo.textContent = tituloLote(p);
    item.appendChild(titulo);

    const dato = document.createElement("p");
    dato.className = "ficha-similar-dato";
    const partes = [];
    if (p.superficie_m2 != null) partes.push(`${p.superficie_m2} m²`);
    if (p.precio_usd != null) partes.push(`USD ${Number(p.precio_usd).toLocaleString("es-AR")}`);
    dato.textContent = partes.length ? partes.join(" · ") : "Sin datos";
    item.appendChild(dato);

    const estado = document.createElement("span");
    estado.className = `ficha-similar-estado ${p.estado || ""}`;
    estado.textContent = ETIQUETA_ESTADO[p.estado] || p.estado || "";
    item.appendChild(estado);

    item.addEventListener("click", () => irALoteSimilar(f));
    elFichaSimilaresLista.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// "Cercanías": distancia real a la ruta pavimentada y a la localidad más
// próxima (ver js/distancias-referencia.js) — se pide async, no bloquea el
// resto de la ficha, y no muestra nada si Overpass no contesta.
// ---------------------------------------------------------------------------

const elFichaCercaniasDt = document.getElementById("ficha-cercanias-dt");
const elFichaCercanias = document.getElementById("ficha-cercanias");

function formatearKm(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

// Notas internas (ver js/notas-internas.js): la libreta del corredor, que
// NO se publica. Se pide async y solo con sesión iniciada — a un visitante
// anónimo no se le esconde la fila, directamente no se le trae el dato.
// Esa diferencia es el punto de todo el cambio: antes las notas vivían en
// "observaciones", que se mostraba acá mismo a cualquiera.
//
// Mismo criterio que actualizarCercanias, abajo: no bloquea la ficha, y si
// la lectura falla la fila simplemente no aparece.
async function actualizarNotasInternas(feature) {
  elNotasDt.classList.add("oculto");
  elNotas.classList.add("oculto");
  if (!auth.currentUser) return;

  const texto = await leerNotasInternas(feature.id);

  // Mientras se esperaba la respuesta el corredor pudo haber abierto otra
  // ficha — no pisar esos datos con la respuesta de un pedido viejo
  // (mismo cuidado que actualizarCercanias).
  if (!texto || getLoteSeleccionado() !== feature) return;

  elNotas.textContent = texto;
  elNotasDt.classList.remove("oculto");
  elNotas.classList.remove("oculto");
}

async function actualizarCercanias(feature) {
  elFichaCercaniasDt.classList.add("oculto");
  elFichaCercanias.classList.add("oculto");

  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  const resultado = await distanciasReferenciaCercanas(lat, lon);

  // Mientras se esperaba la respuesta el usuario pudo haber abierto otra
  // ficha — no pisar esos datos con la respuesta de un pedido viejo.
  if (!resultado || getLoteSeleccionado() !== feature) return;

  const partes = [];
  if (resultado.rutaKm != null) partes.push(`🛣️ Ruta pavimentada a ${formatearKm(resultado.rutaKm)}`);
  if (resultado.localidadNombre) partes.push(`🏘️ ${resultado.localidadNombre} a ${formatearKm(resultado.localidadKm)}`);
  if (partes.length === 0) return;

  elFichaCercanias.innerHTML = partes.join("<br>");
  elFichaCercaniasDt.classList.remove("oculto");
  elFichaCercanias.classList.remove("oculto");
}

function construirUrlComoLlegar(feature) {
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

document.getElementById("btn-como-llegar").addEventListener("click", () => {
  if (!getLoteSeleccionado()) return;
  const url = construirUrlComoLlegar(getLoteSeleccionado());
  window.open(url, "_blank", "noopener");
});

// "Compartir este lote": arma un link a esta misma app con "?lote=<id>"
// (ver abrirLoteDesdeUrlSiCorresponde en app.js) — mandado por WhatsApp a
// un cliente, abre la app directo en la ficha de ESE lote, sin que tenga
// que buscarlo a mano en el mapa. En el celular usa el selector nativo
// para compartir (WhatsApp, etc.) si está disponible; si no, copia el
// link al portapapeles.
const elCompartirLoteMensaje = document.getElementById("compartir-lote-mensaje");

// El mensaje lleva superficie/precio si están cargados (idea propia,
// mismo criterio que cualquier portal real — ZonaProp/MercadoLibre
// arman el texto de WhatsApp con esos datos, no mandan un link pelado)
// — un lote sin ese dato simplemente no lo menciona, no se inventa.
function textoParaCompartir(feature) {
  const p = feature.properties;
  const partes = [`Mira este lote en MojonApp: ${tituloLote(p)}`];
  if (p.superficie_m2 != null) partes.push(`${p.superficie_m2} m²`);
  if (p.precio_usd != null) partes.push(`USD ${Number(p.precio_usd).toLocaleString("es-AR")}`);
  return partes.join(" — ");
}

document.getElementById("btn-compartir-lote").addEventListener("click", async () => {
  if (!getLoteSeleccionado()) return;
  const feature = getLoteSeleccionado();
  const url = `${location.origin}${location.pathname}?lote=${feature.id}`;
  const titulo = tituloLote(feature.properties);
  const texto = textoParaCompartir(feature);

  if (navigator.share) {
    try {
      await navigator.share({ title: `MojonApp - ${titulo}`, text: texto, url });
    } catch {
      // El usuario canceló el selector de compartir, o el navegador lo
      // bloqueó — no es un error real, no hace falta avisar nada.
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(`${texto}\n${url}`);
    elCompartirLoteMensaje.textContent = "Link copiado.";
    elCompartirLoteMensaje.classList.remove("oculto");
    setTimeout(() => elCompartirLoteMensaje.classList.add("oculto"), 2500);
  } catch {
    // Sin permiso de portapapeles (o sin soportarlo, como algunos
    // navegadores embebidos): se deja el texto a la vista, seleccionable
    // a mano, en vez de depender de prompt() — no todos los entornos lo
    // soportan (ver quirk de testing en la memoria del proyecto).
    elCompartirLoteMensaje.textContent = `${texto} ${url}`;
    elCompartirLoteMensaje.classList.remove("oculto");
  }
});

// "Portales" — checklist de publicación (idea propia, a pedido del
// usuario: "la sección para publicar en varios portales también
// sumala"). Investigado: MercadoLibre tiene API pública pero pide
// registrar una app y conseguir credenciales; ZonaProp/Argenprop piden
// un acuerdo comercial con feed XML — ninguna es una integración que se
// pueda prender sin que el usuario primero consiga esas credenciales.
// Esto NO publica de verdad en ningún lado: es un checklist de "dónde
// debería estar este lote" (para no perder de vista qué falta subir a
// mano) más un texto ya armado, listo para copiar y pegar en el
// formulario de cada portal. Igual que "Compartir este lote", con
// fallback si el navegador no tiene permiso de portapapeles.
const PORTALES = ["zonaprop", "mercadolibre", "argenprop"];
const elFichaPortales = document.getElementById("ficha-portales");
const elPortalesMensaje = document.getElementById("portales-mensaje");
const elsPortalCheckbox = Object.fromEntries(PORTALES.map((p) => [p, document.getElementById(`portal-${p}`)]));

/**
 * Todo lo de la ficha que depende de los permisos, en un solo lugar.
 *
 * ESTÁ SEPARADO PARA PODER VOLVER A APLICARLO, y eso es lo importante.
 * El perfil del corredor llega por una lectura asíncrona a Firestore
 * (resolverMiPerfil en app.js), así que puede resolverse DESPUÉS de que
 * la ficha ya se dibujó. Antes, cuando eso pasaba, nadie la volvía a
 * dibujar: la ficha quedaba de SOLO LECTURA —sin botón de editar, sin
 * borrar, sin interesados, sin portales— hasta que el corredor la
 * cerrara y la abriera de nuevo.
 *
 * Se veía poco mientras abrir una ficha era siempre un click (para
 * entonces el perfil ya había llegado). Pasó a verse siempre desde que
 * el lote abierto vive en la URL: recargar, o entrar por un link
 * compartido, abre la ficha en la primera pasada, antes del perfil.
 *
 * Lo llama app.js desde actualizarUIPorPermisos, que es el mismo lugar
 * que ya arregla la lista por el mismo motivo.
 */
function aplicarPermisosEnLaFicha(feature) {
  document.getElementById("btn-borrar-lote").classList.toggle("oculto", !puedeBorrarLote(feature));
  document.getElementById("btn-editar-lote-completo").classList.toggle("oculto", !puedeEditarLote(feature));
  document.getElementById("btn-editar-forma-lote").classList.toggle("oculto", !puedeEditarLote(feature));
  elFichaInteresados.classList.toggle("oculto", !puedeEditarLote(feature));
  actualizarPortales(feature);
  // Subir fotos también depende del permiso (ver renderFotos): se
  // redibujan para que reaparezca el botón.
  renderFotos(feature);
}

/**
 * Vuelve a aplicar los permisos sobre la ficha que esté abierta.
 *
 * No redibuja la ficha entera a propósito: mostrarFicha registra una
 * visita en el contador de "más consultados" (registrarVistaDeLote),
 * así que llamarla de nuevo inflaría esa métrica cada vez que llega el
 * perfil.
 */
export function refrescarPermisosDeLaFicha() {
  const feature = getLoteSeleccionado();
  if (!feature || elFicha.classList.contains("oculto")) return;
  aplicarPermisosEnLaFicha(feature);
}

function actualizarPortales(feature) {
  const puedeEditar = puedeEditarLote(feature);
  elFichaPortales.classList.toggle("oculto", !puedeEditar);
  if (!puedeEditar) return;
  const publicado = feature.properties.portales_publicado || {};
  PORTALES.forEach((p) => {
    elsPortalCheckbox[p].checked = !!publicado[p];
  });
}

PORTALES.forEach((portal) => {
  elsPortalCheckbox[portal].addEventListener("change", async () => {
    const feature = getLoteSeleccionado();
    if (!feature) return;
    const checkbox = elsPortalCheckbox[portal];
    const valorAnterior = !checkbox.checked; // ya cambió antes de disparar "change"
    const publicado = { ...(feature.properties.portales_publicado || {}), [portal]: checkbox.checked };
    try {
      await updateDoc(doc(db, COLECCION_LOTES, feature.id), { portales_publicado: publicado });
      feature.properties.portales_publicado = publicado;
      // Sin esto, no había ninguna señal de que el toggle se guardó de
      // verdad (a diferencia de "Copiar descripción", que sí avisa) — un
      // corredor con conexión lenta podía cerrar la ficha pensando que
      // ya estaba, sin que se hubiera guardado todavía.
      elPortalesMensaje.textContent = "Guardado.";
      elPortalesMensaje.classList.remove("oculto");
      setTimeout(() => elPortalesMensaje.classList.add("oculto"), 2000);
    } catch (error) {
      checkbox.checked = valorAnterior; // revertir: no quedó guardado
      window.alert(
        error.code === "permission-denied" ? "No tienes permiso para editar este lote." : "No se pudo guardar."
      );
    }
  });
});

function textoDescripcionPortal(feature) {
  const p = feature.properties;
  const lineas = [tituloLote(p)];
  const ubicacion = [p.sector, p.barrio].filter(Boolean).join(" — ");
  if (ubicacion) lineas.push(ubicacion);
  if (p.superficie_m2 != null) lineas.push(`Superficie: ${p.superficie_m2} m²`);
  if (p.precio_usd != null) lineas.push(`Precio: USD ${Number(p.precio_usd).toLocaleString("es-AR")}`);
  const servicios = Object.entries(p.servicios || {})
    .filter(([, tiene]) => tiene)
    .map(([nombre]) => nombre);
  if (servicios.length > 0) lineas.push(`Servicios: ${servicios.join(", ")}`);
  if (p.descripcion) lineas.push(p.descripcion);
  lineas.push(`Más info: ${location.origin}${location.pathname}?lote=${feature.id}`);
  return lineas.join("\n");
}

document.getElementById("btn-copiar-descripcion-portal").addEventListener("click", async () => {
  const feature = getLoteSeleccionado();
  if (!feature) return;
  const texto = textoDescripcionPortal(feature);
  try {
    await navigator.clipboard.writeText(texto);
    elPortalesMensaje.textContent = "Descripción copiada.";
  } catch {
    // Mismo fallback que "Compartir este lote": sin permiso de
    // portapapeles, se deja el texto a la vista para copiarlo a mano.
    elPortalesMensaje.textContent = texto;
  }
  elPortalesMensaje.classList.remove("oculto");
  setTimeout(() => elPortalesMensaje.classList.add("oculto"), 4000);
});

// "Cartel con QR para imprimir" (idea #7): mismo link que "Compartir
// este lote" (?lote=<id>), pero como cartel para clavar físicamente en
// el terreno — alguien que pasa caminando lo escanea y cae directo en
// la ficha de ESE lote. El QR lo arma un servicio público gratis
// (api.qrserver.com, sin API key) contra ese mismo link — no hace falta
// vendorizar un generador de QR propio para un cartel que se imprime
// una sola vez con conexión de por medio.
const elPanelCartelQr = document.getElementById("panel-cartel-qr");
const elCartelQrTitulo = document.getElementById("cartel-qr-titulo");
const elCartelQrSubtitulo = document.getElementById("cartel-qr-subtitulo");
const elCartelQrImagen = document.getElementById("cartel-qr-imagen");

document.getElementById("btn-cartel-qr").addEventListener("click", () => {
  const feature = getLoteSeleccionado();
  if (!feature) return;
  const p = feature.properties;
  const url = `${location.origin}${location.pathname}?lote=${feature.id}`;

  elCartelQrTitulo.textContent = tituloLote(p);
  elCartelQrSubtitulo.textContent = [p.sector, p.superficie_m2 ? `${p.superficie_m2} m²` : null]
    .filter(Boolean)
    .join(" — ");
  elCartelQrImagen.src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=${encodeURIComponent(url)}`;
  elPanelCartelQr.classList.remove("oculto");
});

document.getElementById("cerrar-cartel-qr").addEventListener("click", () => {
  elPanelCartelQr.classList.add("oculto");
});

document.getElementById("btn-imprimir-cartel").addEventListener("click", () => {
  window.print();
});

// "Imprimir ficha (PDF)" (idea #9): a diferencia del cartel de arriba
// (mínimo, para clavar en el terreno), esta hoja lleva TODOS los datos
// del lote — pensada para que un corredor se la imprima o mande el PDF
// (el propio diálogo de impresión del navegador ya deja "Guardar como
// PDF", no hace falta una librería aparte) a un cliente. Mismo mecanismo
// .hoja-imprimible + @media print que el cartel.
const elPanelFichaImprimir = document.getElementById("panel-ficha-imprimir");
const elFichaImprimirTitulo = document.getElementById("ficha-imprimir-titulo");
const elFichaImprimirSubtitulo = document.getElementById("ficha-imprimir-subtitulo");
const elFichaImprimirTablaCuerpo = document.getElementById("ficha-imprimir-tabla-cuerpo");
const elFichaImprimirImagen = document.getElementById("ficha-imprimir-imagen");
const elFichaImprimirFecha = document.getElementById("ficha-imprimir-fecha");

function filaTabla(etiqueta, valorHTML) {
  return `<tr><th>${etiqueta}</th><td>${valorHTML}</td></tr>`;
}

document.getElementById("btn-ficha-imprimir").addEventListener("click", () => {
  const feature = getLoteSeleccionado();
  if (!feature) return;
  const p = feature.properties;
  const url = `${location.origin}${location.pathname}?lote=${feature.id}`;

  elFichaImprimirTitulo.textContent = tituloLote(p);
  elFichaImprimirSubtitulo.textContent = [p.sector, p.barrio].filter(Boolean).join(" — ");

  const filas = [];
  if (p.superficie_m2 != null) filas.push(filaTabla("Superficie", `${p.superficie_m2} m²`));
  filas.push(filaTabla("Estado", textoEstadoConVencimiento(p)));
  if (p.precio_usd != null) filas.push(filaTabla("Precio", `USD ${Number(p.precio_usd).toLocaleString("es-AR")}`));
  filas.push(filaTabla("Servicios", renderServiciosHTML(p.servicios)));
  if (p.nomenclatura) filas.push(filaTabla("Nomenclatura catastral", p.nomenclatura));
  elFichaImprimirTablaCuerpo.innerHTML = filas.join("");

  elFichaImprimirImagen.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data=${encodeURIComponent(url)}`;
  elFichaImprimirFecha.textContent = `Impreso el ${new Date().toLocaleDateString("es-AR")}`;
  elPanelFichaImprimir.classList.remove("oculto");
});

document.getElementById("cerrar-ficha-imprimir").addEventListener("click", () => {
  elPanelFichaImprimir.classList.add("oculto");
});

document.getElementById("btn-imprimir-ficha").addEventListener("click", () => {
  window.print();
});

// Si la app se abrió con "?lote=<id>" (link armado por "Compartir este
// lote"), abre esa ficha directo apenas hay datos para buscarla. Al
// arrancar, la app dispara DOS cargas de lotes en paralelo — iniciarMapa()
// (mapa.js) pinta rápido sin esperar la sesión, y onAuthStateChanged
// (app.js) vuelve a cargar apenas Firebase Auth resuelve, para aplicar el
// alcance correcto según permisos — y cada una hace su propio fitBounds()
// sobre TODOS los lotes. Esta función se llama al terminar cualquiera de
// las dos: si se reaplicara el centrado solo una vez, la carga que
// terminara después (la carrera de red no es determinística) podía pisar
// el zoom del lote puntual con su propio fitBounds y dejar el mapa
// enfocado en el conjunto en vez del lote — reportado en vivo: "ahora lo
// marca pero no lo enfoca con un zoom". Por eso el centrado se reaplica
// en cada llamada (gana siempre la carga que terminó última); lo que se
// hace una sola vez es abrir el cartel/ficha, para no reabrirlo en medio
// de que alguien ya esté usando la app (login/logout también pasan por
// acá).
export function abrirLoteDesdeUrlSiCorresponde() {
  const idDesdeUrl = new URLSearchParams(location.search).get("lote");
  if (!idDesdeUrl) return;
  const feature = getLotesActuales().find((f) => f.id === idDesdeUrl);
  if (!feature) return;
  const { lat, lon } = centroideDePoligono(feature.geometry.coordinates[0]);
  // animate: false, igual que el fitBounds() de cargarLotesDesdeFirestore
  // (mapa.js) — ver el comentario ahí: si ese fitBounds queda animando
  // cuando este setView corre, Leaflet ignora el zoom pedido acá.
  mapa.setView([lat, lon], 19, { animate: false });

  // En "modo embed" (insertado en la web de una inmobiliaria, ver
  // index.html) la ficha completa (hoja inferior, hasta 70% del alto) tapa
  // casi toda la vista en un iframe chico — reportado en vivo: "no me
  // aparece en el mapa, solo me despliega el panel de info". Ahí alcanza
  // con centrar el mapa en el lote y abrir su cartel (mismo que aparece al
  // pasar el mouse), sin abrir el panel — el caso de uso real es "mostrame
  // dónde está este lote", no necesariamente todos sus datos.
  //
  // A diferencia de la ficha completa (más abajo, una sola vez), el
  // cartel se reabre en CADA llamada, igual que el centrado: vive en
  // capaLotes, que cargarLotesDesdeFirestore() reconstruye de cero en
  // cada una de las dos cargas del arranque (ver comentario arriba). Si
  // se abriera una sola vez, la carga que reconstruye la capa después de
  // esa primera apertura se lleva puesto el cartel junto con el resto de
  // los lotes viejos, y el marcador desaparece sin avisar.
  if (document.documentElement.classList.contains("modo-embed")) {
    abrirTooltipDeLote(feature.id);
    return;
  }

  if (getDeepLinkAbierto()) return;
  setDeepLinkAbierto(true);
  mostrarFicha(feature);
}
