// ---------------------------------------------------------------------------
// Cargar un lote nuevo: a mano (formulario con vértices pegados o
// capturados), o importado del catastro de San Luis por número de manzana
// ("+ Manzana", trae varias parcelas de una) o de parcela individual
// ("+ Parcela", para cuando el catastro tiene la parcela pero no el
// contorno de la manzana que la contiene). Las tres vías terminan en el
// mismo formulario "Cargar lote" — importar solo lo precarga, no lo guarda
// directo, para que el corredor pueda revisar antes.
//
// `mapa`, `cargarLotesDesdeFirestore` y `anilloAGeometryFirestore` todavía
// viven en app.js (Mapa no es un módulo separado en este punto de la
// modularización) — se inyectan por parámetro vía configurarCargarLote()
// para evitar una dependencia circular. `db`/`auth` y el SDK de Firestore
// sí se importan directo: son librerías externas estables, no arrastran
// ningún acoplamiento con el resto de la app.
// ---------------------------------------------------------------------------

import { db, auth } from "./firebase-config.js";
import {
  collection,
  getDocs,
  addDoc,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { areaEnM2 } from "./geometria.js";
import {
  pedirWfs,
  esParcelaDeCalle,
  superficieDesdeNombreCatastro,
  nomenclaturaDeManzana,
  normalizarParcelaSanLuis,
  primerAnilloDeGeometria,
  manzanaDesdeNomenclaturaDeParcela
} from "./catastro-normalizacion.js";
import { getModoCaptura, setModoCaptura, onSesionCerrada } from "./estado.js";
import { poblarSelectSector, poblarSelectBarrio } from "./catalogos.js";
import { registrarAuditoria } from "./auditoria.js";
import { guardarNotasInternas } from "./notas-internas.js";

const COLECCION_LOTES = "lotes";

// Mismo criterio que tituloLote() en ficha.js (duplicado a propósito acá
// — importarlo de ficha.js crearía un ciclo: mapa.js ya importa de este
// archivo, y ficha.js importa de mapa.js).
function tituloLoteParaAuditoria({ nomenclatura, manzana, lote }) {
  if (nomenclatura) return nomenclatura;
  if (manzana != null && lote != null) return `Manzana ${manzana} — Lote ${lote}`;
  return "Lote sin nomenclatura catastral";
}

let mapa, cargarLotesDesdeFirestore, anilloAGeometryFirestore;

// app.js llama esto una sola vez, antes de usar cualquier otra función de
// este módulo.
export function configurarCargarLote(deps) {
  ({ mapa, cargarLotesDesdeFirestore, anilloAGeometryFirestore } = deps);
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

function bboxDelMapaVisible() {
  const b = mapa.getBounds();
  return `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
}

// ---------------------------------------------------------------------------
// Formulario "Cargar lote" (solo corredores logueados).
// ---------------------------------------------------------------------------

const elFormLote = document.getElementById("form-lote");
const formularioLote = document.getElementById("formulario-lote");
const elLoteManzana = document.getElementById("lote-manzana");
const elLoteNumero = document.getElementById("lote-numero");
const elLoteNomenclatura = document.getElementById("lote-nomenclatura");
const elLoteSector = document.getElementById("lote-sector");
const elLoteBarrio = document.getElementById("lote-barrio");
const elLoteSuperficie = document.getElementById("lote-superficie");
const elLoteEstado = document.getElementById("lote-estado");
const elLotePrecio = document.getElementById("lote-precio");
const elLoteComision = document.getElementById("lote-comision");
const elLoteServicioLuz = document.getElementById("lote-servicio-luz");
const elLoteServicioAgua = document.getElementById("lote-servicio-agua");
const elLoteServicioGas = document.getElementById("lote-servicio-gas");
const elLoteServicioCloaca = document.getElementById("lote-servicio-cloaca");
const elLoteDescripcion = document.getElementById("lote-descripcion");
const elLoteNotas = document.getElementById("lote-notas");
const elLoteVertices = document.getElementById("lote-vertices");
const elLoteAreaCalculada = document.getElementById("lote-area-calculada");
const elLoteError = document.getElementById("lote-error");

// El formulario se resetea tanto al abrirlo desde cero como al cerrarlo
// sin guardar: si no, quedan pegados los datos de una carga anterior (por
// ejemplo, de una parcela traída del catastro que no se llegó a guardar)
// y podrían mezclarse con la próxima carga sin que el corredor lo note.
function limpiarFormLote() {
  formularioLote.reset();
  elLoteAreaCalculada.textContent = "";
  elLoteError.classList.add("oculto");
}

document.getElementById("btn-cargar-lote").addEventListener("click", () => {
  limpiarFormLote();
  poblarSelectSector(elLoteSector, null);
  poblarSelectBarrio(elLoteBarrio, null);
  abrirHoja(elFormLote);
});
document.getElementById("cerrar-form-lote").addEventListener("click", () => {
  elFormLote.classList.add("oculto");
  limpiarFormLote();
});
onSesionCerrada(() => {
  elFormLote.classList.add("oculto");
  limpiarFormLote();
});

// Cada línea es "latitud,longitud" tal cual la copia el corredor del visor
// de catastro (así lo muestra ese sitio) — se invierte a [lon, lat], que es
// el orden que usa GeoJSON, y se cierra el anillo si hace falta.
function parsearVertices(texto) {
  const lineas = texto
    .split("\n")
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0);

  if (lineas.length < 3) {
    throw new Error("Hacen falta al menos 3 vértices.");
  }

  const puntos = lineas.map((linea, indice) => {
    const partes = linea.split(",").map((numero) => Number(numero.trim()));
    if (partes.length !== 2 || partes.some(Number.isNaN)) {
      throw new Error(`El vértice de la línea ${indice + 1} no tiene el formato "latitud,longitud".`);
    }
    const [lat, lon] = partes;
    return [lon, lat];
  });

  const [primerLon, primerLat] = puntos[0];
  const [ultimoLon, ultimoLat] = puntos[puntos.length - 1];
  if (primerLon !== ultimoLon || primerLat !== ultimoLat) {
    puntos.push([primerLon, primerLat]);
  }

  return puntos;
}

function actualizarAreaCalculada() {
  elLoteAreaCalculada.classList.remove("area-advertencia");
  try {
    const vertices = parsearVertices(elLoteVertices.value);
    const area = areaEnM2(vertices);
    const superficieDeclarada = Number(elLoteSuperficie.value);

    let mensaje = `Área calculada a partir de los vértices: ${area.toFixed(1)} m²`;
    if (superficieDeclarada > 0) {
      const errorRelativo = Math.abs(area - superficieDeclarada) / superficieDeclarada;
      if (errorRelativo > 0.05) {
        mensaje += ` — se aleja bastante de los ${superficieDeclarada} m² declarados. Revisa el orden de los vértices.`;
        elLoteAreaCalculada.classList.add("area-advertencia");
      }
    }
    elLoteAreaCalculada.textContent = mensaje;
  } catch (error) {
    elLoteAreaCalculada.textContent = "";
  }
}

elLoteVertices.addEventListener("input", actualizarAreaCalculada);
elLoteSuperficie.addEventListener("input", actualizarAreaCalculada);

formularioLote.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elLoteError.classList.add("oculto");

  try {
    const nomenclatura = elLoteNomenclatura.value.trim() || null;

    // Mismo chequeo que ya hace la importación de "+ Manzana": si esta
    // nomenclatura ya está cargada, avisar en vez de duplicar el lote.
    // "+ Parcela" y "Ver catastro cercano" precargan este formulario, así
    // que sin este chequeo alcanzaba con tocar la misma parcela dos veces
    // para terminar con dos lotes iguales en el mapa.
    if (nomenclatura) {
      const yaExiste = await getDocs(
        query(collection(db, COLECCION_LOTES), where("nomenclatura", "==", nomenclatura))
      );
      if (!yaExiste.empty) {
        throw new Error(`Ya hay un lote cargado con la nomenclatura ${nomenclatura}.`);
      }
    }

    const vertices = parsearVertices(elLoteVertices.value);
    const manzana = elLoteManzana.value.trim() || null;
    const lote = elLoteNumero.value.trim() || null;
    const nuevoLoteRef = await addDoc(collection(db, COLECCION_LOTES), {
      creado_por: auth.currentUser.uid,
      // Idea propia: badge "Nuevo" en la lista/ficha (ver ESTA_SEMANA en
      // vista-lista.js/ficha.js) — mismo criterio que LandWatch, que deja
      // ordenar por "listing age". Los lotes cargados ANTES de este
      // cambio no tienen el campo, y eso está bien: simplemente no
      // muestran el badge, no hace falta completarlo a mano.
      creado_en: new Date().toISOString(),
      manzana,
      lote,
      nomenclatura,
      sector: elLoteSector.value.trim() || null,
      barrio: elLoteBarrio.value.trim() || null,
      superficie_m2: Number(elLoteSuperficie.value),
      estado: elLoteEstado.value,
      precio_usd: elLotePrecio.value.trim() === "" ? null : Number(elLotePrecio.value),
      // El primer precio arranca el historial, que es lo que después
      // permite comparar el valor del pipeline contra el mes anterior
      // (ver js/historial-precios.js). Un lote que nace sin precio no
      // lleva historial: cuando se le ponga uno, ese será el primero.
      ...(elLotePrecio.value.trim() === ""
        ? {}
        : {
            historial_precios: [
              { precio_usd: Number(elLotePrecio.value), fecha: new Date().toISOString() }
            ]
          }),
      // null = sin porcentaje propio, usa el general (js/comisiones.js).
      comision_pct: elLoteComision.value.trim() === "" ? null : Number(elLoteComision.value),
      servicios: {
        luz: elLoteServicioLuz.checked,
        agua: elLoteServicioAgua.checked,
        gas: elLoteServicioGas.checked,
        cloaca: elLoteServicioCloaca.checked
      },
      descripcion: elLoteDescripcion.value.trim() || null,
      geometry: anilloAGeometryFirestore(vertices)
    });
    // Las notas internas van en una subcolección del lote (ver
    // js/notas-internas.js), así que recién se pueden escribir acá, con el
    // id del documento ya creado.
    //
    // Con su propio try/catch, y no bajo el de afuera, a propósito: para
    // cuando esto falla el lote YA está guardado, así que dejar que el
    // error suba mostraría "no tienes permiso" y el formulario abierto,
    // como si no se hubiera creado nada — y el corredor lo cargaría de
    // nuevo, duplicado. El caso concreto que lo hace probable: desplegar
    // esto antes de pegar la regla nueva de Firestore. Se pierde la nota,
    // nunca el lote.
    try {
      await guardarNotasInternas(nuevoLoteRef.id, elLoteNotas.value);
    } catch {
      // El lote quedó creado; la nota se puede volver a escribir desde
      // "Editar lote", que sí avisa si falla.
    }
    registrarAuditoria({
      accion: "crear_lote",
      objetoId: nuevoLoteRef.id,
      objetoTitulo: tituloLoteParaAuditoria({ nomenclatura, manzana, lote })
    });

    limpiarFormLote();
    elFormLote.classList.add("oculto");
    await cargarLotesDesdeFirestore();
  } catch (error) {
    elLoteError.textContent =
      error.code === "permission-denied"
        ? "No tienes permiso para cargar lotes. Inicia sesión de nuevo."
        : error.message || "No se pudo guardar el lote.";
    elLoteError.classList.remove("oculto");
  }
});

// ---------------------------------------------------------------------------
// "Traer manzana del catastro": busca una manzana por número dentro del
// área visible del mapa (WFS público de catastro) y trae todas las
// parcelas que la componen, para importarlas de una sola vez en vez de
// cargar lote por lote.
// ---------------------------------------------------------------------------

const elBtnAbrirManzana = document.getElementById("btn-abrir-manzana");
const elFormManzana = document.getElementById("form-manzana");
const formularioManzana = document.getElementById("formulario-manzana");
const elManzanaNumero = document.getElementById("manzana-numero");
const elManzanaResultado = document.getElementById("manzana-resultado");
const elManzanaConfirmar = document.getElementById("manzana-confirmar");
const elManzanaError = document.getElementById("manzana-error");

let parcelasEncontradas = []; // resultado de la última búsqueda, pendiente de confirmar

// Si se cierra sin importar, hay que limpiar la búsqueda anterior: si no,
// al reabrir queda visible el botón "Importar estos lotes" todavía
// apuntando a una búsqueda vieja (de otra manzana), y tocarlo importaría
// esos lotes por error.
function limpiarFormManzana() {
  parcelasEncontradas = [];
  elManzanaResultado.innerHTML = "";
  elManzanaConfirmar.classList.add("oculto");
  elManzanaError.classList.add("oculto");
}

elBtnAbrirManzana.addEventListener("click", () => abrirHoja(elFormManzana));
document.getElementById("cerrar-form-manzana").addEventListener("click", () => {
  elFormManzana.classList.add("oculto");
  limpiarFormManzana();
});
onSesionCerrada(() => {
  elFormManzana.classList.add("oculto");
  limpiarFormManzana();
});

// El número de manzana NO es único en toda la provincia (hay una "manzana
// 104" en cada pueblo), así que la búsqueda se acota al área visible del
// mapa además del número — si no encuadra la manzana correcta antes de
// buscar, puede no encontrarla o encontrar la de otro lado.
async function buscarManzana(numero) {
  const cql = `ETIQUETA='${numero}' AND BBOX(GEOM,${bboxDelMapaVisible()},'EPSG:4326')`;
  const features = await pedirWfs({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeName: "SanLuis:GIS_MANZANAS_VV",
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    CQL_FILTER: cql
  });
  return features[0] || null;
}

// Este GeoServer no admite indicarle el sistema de coordenadas de un
// polígono dentro de INTERSECTS() (se probó "SRID=4326;POLYGON(...)" y
// tira error de sintaxis), así que en vez de intersectar la forma exacta
// de la manzana se pide todo lo que cae en su rectángulo envolvente (con
// BBOX(), que sí admite el sistema de coordenadas) y se filtra por
// nomenclatura después, del lado del cliente.
async function buscarParcelasDeManzana(manzanaFeature) {
  const anillo = manzanaFeature.geometry.coordinates[0];
  const lons = anillo.map((p) => p[0]);
  const lats = anillo.map((p) => p[1]);
  const bbox = `${Math.min(...lons)},${Math.min(...lats)},${Math.max(...lons)},${Math.max(...lats)}`;

  const candidatas = (
    await pedirWfs({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: "SanLuis:GIS_PARCELAS_VV",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      CQL_FILTER: `BBOX(GEOM,${bbox},'EPSG:4326')`
    })
  ).filter((feature) => !esParcelaDeCalle(feature.properties.NOMBRE));

  const nomenclaturaManzana = nomenclaturaDeManzana(manzanaFeature.properties.NOMBRE);
  if (!nomenclaturaManzana) return candidatas;

  return candidatas.filter((feature) =>
    (feature.properties.CATNMC_CAT || "").startsWith(`${nomenclaturaManzana}-`)
  );
}

formularioManzana.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elManzanaError.classList.add("oculto");
  elManzanaConfirmar.classList.add("oculto");
  elManzanaResultado.textContent = "Buscando…";
  parcelasEncontradas = [];

  try {
    const manzana = await buscarManzana(elManzanaNumero.value.trim());
    if (!manzana) {
      throw new Error(
        "No se encontró esa manzana en el área visible del mapa. Acercate o alejate hasta encuadrarla y prueba de nuevo."
      );
    }

    const parcelas = await buscarParcelasDeManzana(manzana);
    if (parcelas.length === 0) {
      throw new Error("La manzana se encontró pero no tiene parcelas cargadas en el catastro.");
    }

    parcelasEncontradas = parcelas.map((feature) => ({
      lote: feature.properties.ETIQUETA || null,
      nomenclatura: feature.properties.CATNMC_CAT || null,
      superficie_m2: superficieDesdeNombreCatastro(feature.properties.NOMBRE),
      anillo: feature.geometry.coordinates[0]
    }));

    elManzanaResultado.innerHTML = `
      <p>Se encontraron ${parcelasEncontradas.length} parcelas en la manzana ${manzana.properties.ETIQUETA}:</p>
      <ul>${parcelasEncontradas
        .map((p) => `<li>Lote ${p.lote || "sin número"}${p.superficie_m2 ? ` — ${p.superficie_m2} m²` : ""}</li>`)
        .join("")}</ul>
    `;
    elManzanaConfirmar.dataset.manzana = manzana.properties.ETIQUETA;
    elManzanaConfirmar.classList.remove("oculto");
  } catch (error) {
    elManzanaResultado.textContent = "";
    elManzanaError.textContent = error.message || "No se pudo buscar la manzana.";
    elManzanaError.classList.remove("oculto");
  }
});

elManzanaConfirmar.addEventListener("click", async () => {
  elManzanaError.classList.add("oculto");
  elManzanaConfirmar.disabled = true;
  const numeroManzana = elManzanaConfirmar.dataset.manzana;

  try {
    let importados = 0;
    let omitidos = 0;

    for (const parcela of parcelasEncontradas) {
      // Evita duplicar si esta parcela ya se había importado antes (misma
      // nomenclatura catastral).
      if (parcela.nomenclatura) {
        const yaExiste = await getDocs(
          query(collection(db, COLECCION_LOTES), where("nomenclatura", "==", parcela.nomenclatura))
        );
        if (!yaExiste.empty) {
          omitidos++;
          continue;
        }
      }

      const nuevoLoteRef = await addDoc(collection(db, COLECCION_LOTES), {
        creado_por: auth.currentUser.uid,
        creado_en: new Date().toISOString(),
        manzana: numeroManzana,
        lote: parcela.lote,
        nomenclatura: parcela.nomenclatura,
        superficie_m2: parcela.superficie_m2,
        estado: "disponible",
        precio_usd: null,
        // Un lote importado no tiene descripción: nadie la escribió
        // todavía. De dónde salió es una nota de trabajo, no algo que se
        // publique — antes iba a "observaciones", que se mostraba en la
        // ficha a cualquier visitante.
        descripcion: null,
        geometry: anilloAGeometryFirestore(parcela.anillo)
      });
      // Mismo criterio que el alta a mano: una nota que no se pudo
      // escribir no puede cortar una importación de varias parcelas por
      // la mitad.
      try {
        await guardarNotasInternas(nuevoLoteRef.id, "Importado automáticamente del catastro de San Luis.");
      } catch {
        // El lote importado ya está; la nota es un extra.
      }
      registrarAuditoria({
        accion: "crear_lote",
        objetoId: nuevoLoteRef.id,
        objetoTitulo: tituloLoteParaAuditoria({ nomenclatura: parcela.nomenclatura, manzana: numeroManzana, lote: parcela.lote }),
        detalle: "Importado del catastro de San Luis (+ Manzana)."
      });
      importados++;
    }

    elManzanaResultado.textContent =
      omitidos > 0
        ? `Se importaron ${importados} lotes nuevos (${omitidos} ya existían y se omitieron).`
        : `Se importaron ${importados} lotes.`;
    elManzanaConfirmar.classList.add("oculto");
    await cargarLotesDesdeFirestore();
  } catch (error) {
    elManzanaError.textContent =
      error.code === "permission-denied"
        ? "No tienes permiso para cargar lotes. Inicia sesión de nuevo."
        : error.message || "No se pudieron importar los lotes.";
    elManzanaError.classList.remove("oculto");
  } finally {
    elManzanaConfirmar.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// "Traer parcela del catastro": busca una parcela individual por número,
// sin pasar por la manzana. Existe porque en varias zonas (justo las que
// le interesan a esta app) el catastro tiene la parcela cargada pero no
// el contorno de la manzana que la contiene, así que "+ Manzana" no
// encuentra nada ahí — se confirmó con el lote real de Carpintería.
// ---------------------------------------------------------------------------

const elBtnAbrirParcela = document.getElementById("btn-abrir-parcela");
const elFormParcela = document.getElementById("form-parcela");
const formularioParcela = document.getElementById("formulario-parcela");
const elParcelaNumero = document.getElementById("parcela-numero");
const elParcelaResultado = document.getElementById("parcela-resultado");
const elParcelaError = document.getElementById("parcela-error");

elBtnAbrirParcela.addEventListener("click", () => abrirHoja(elFormParcela));

// Al elegir una parcela encontrada, se precarga en el formulario "+ Lote"
// de siempre (en vez de guardarla directo) para que el corredor pueda
// revisar o completar estado/precio/descripción antes de guardar — y
// para reusar ese único camino de guardado, ya probado. También la llama
// "Ver catastro cercano" (en app.js) cuando se toca una parcela cercana.
export function cargarParcelaEnFormLote(feature) {
  // Las llamadas desde "+ Manzana"/"+ Parcela" (San Luis, sin tocar en
  // este cambio) pasan la parcela cruda sin normalizar — se normaliza
  // acá mismo si hace falta, para no tener que tocar esos otros dos
  // call sites.
  const datos = feature.properties._mojon || normalizarParcelaSanLuis(feature).properties._mojon;
  const anillo = primerAnilloDeGeometria(feature.geometry);

  elLoteManzana.value = manzanaDesdeNomenclaturaDeParcela(datos.nomenclatura) || "";
  elLoteNumero.value = datos.etiqueta || "";
  elLoteNomenclatura.value = datos.nomenclatura || "";
  poblarSelectSector(elLoteSector, null);
  poblarSelectBarrio(elLoteBarrio, null);
  elLoteSuperficie.value = datos.superficie_m2 ?? "";
  elLoteEstado.value = "disponible";
  elLotePrecio.value = "";
  // De dónde salió el lote es una nota de trabajo, no la descripción que
  // se publica — va al campo interno, igual que en el alta masiva de
  // arriba. La descripción queda vacía para que la escriba el corredor.
  elLoteDescripcion.value = "";
  elLoteNotas.value = `Importado del catastro de ${datos.provincia} (parcela individual).`;
  elLoteVertices.value = anillo.map(([lon, lat]) => `${lat},${lon}`).join("\n");
  elLoteVertices.dispatchEvent(new Event("input"));
  abrirHoja(elFormLote);
}

// Las candidatas de "+ Parcela" se resaltan en el mapa (no solo listadas
// como texto), para que el corredor vea de entrada dónde está cada una
// antes de elegir — importa porque el número de parcela se repite en
// varias manzanas dentro de la misma vista.
let capaResaltadoParcelas = null;

function limpiarResaltadoParcelas() {
  if (capaResaltadoParcelas) {
    mapa.removeLayer(capaResaltadoParcelas);
    capaResaltadoParcelas = null;
  }
}

function resaltarCandidatasEnMapa(candidatas) {
  limpiarResaltadoParcelas();
  capaResaltadoParcelas = L.geoJSON(
    { type: "FeatureCollection", features: candidatas },
    {
      style: { color: "#00e5ff", weight: 4, fillColor: "#00e5ff", fillOpacity: 0.25 },
      // Tocar el polígono resaltado en el mapa carga esa parcela, igual
      // que el botón "Cargar este lote" de la lista — antes solo
      // funcionaba el botón, el resaltado era puramente visual.
      onEachFeature: (feature, layer) => {
        layer.on("click", (evento) => {
          // Mismo cuidado que en la capa de lotes cargados: no pisar una
          // captura de vértices en curso (ver el comentario en
          // cargarLotesDesdeFirestore).
          if (getModoCaptura() !== null) return;
          L.DomEvent.stopPropagation(evento);
          limpiarResaltadoParcelas();
          cargarParcelaEnFormLote(feature);
        });
      }
    }
  ).addTo(mapa);
}

// Si se cierra sin cargar ninguna, se limpia la lista y el resaltado del
// mapa: si no, al reabrir queda una búsqueda vieja dando vueltas.
document.getElementById("cerrar-form-parcela").addEventListener("click", () => {
  elFormParcela.classList.add("oculto");
  limpiarResaltadoParcelas();
  elParcelaResultado.innerHTML = "";
  elParcelaError.classList.add("oculto");
});
onSesionCerrada(() => {
  elFormParcela.classList.add("oculto");
  limpiarResaltadoParcelas();
  elParcelaResultado.innerHTML = "";
  elParcelaError.classList.add("oculto");
});

formularioParcela.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elParcelaError.classList.add("oculto");
  elParcelaResultado.innerHTML = "Buscando…";
  limpiarResaltadoParcelas();

  try {
    const numero = elParcelaNumero.value.trim();
    const candidatas = (
      await pedirWfs({
        service: "WFS",
        version: "2.0.0",
        request: "GetFeature",
        typeName: "SanLuis:GIS_PARCELAS_VV",
        outputFormat: "application/json",
        srsName: "EPSG:4326",
        CQL_FILTER: `ETIQUETA='${numero}' AND BBOX(GEOM,${bboxDelMapaVisible()},'EPSG:4326')`
      })
    ).filter((feature) => !esParcelaDeCalle(feature.properties.NOMBRE));

    if (candidatas.length === 0) {
      elParcelaResultado.innerHTML = "";
      throw new Error(
        "No se encontró esa parcela en el área visible del mapa. Acercate o alejate hasta encuadrarla y prueba de nuevo."
      );
    }

    resaltarCandidatasEnMapa(candidatas);

    // El número de parcela tampoco es único (puede haber una "20" en cada
    // manzana visible), así que se muestran todas las que caen en el área
    // para que el corredor elija la correcta por su nomenclatura/superficie.
    elParcelaResultado.innerHTML = "";
    candidatas.forEach((feature, indice) => {
      const superficie = superficieDesdeNombreCatastro(feature.properties.NOMBRE);
      const nomenclatura = feature.properties.CATNMC_CAT || "(sin nomenclatura)";
      const fila = document.createElement("div");
      fila.className = "parcela-candidata";
      fila.innerHTML = `
        <p>${nomenclatura}${superficie ? ` — ${superficie} m²` : ""}</p>
        <button type="button" data-testid="parcela-cargar-${indice}">Cargar este lote</button>
      `;
      fila.querySelector("button").addEventListener("click", () => {
        limpiarResaltadoParcelas();
        cargarParcelaEnFormLote(feature);
      });
      elParcelaResultado.appendChild(fila);
    });
  } catch (error) {
    elParcelaError.textContent = error.message || "No se pudo buscar la parcela.";
    elParcelaError.classList.remove("oculto");
  }
});

// ---------------------------------------------------------------------------
// Captura interactiva de vértices: dos formas alternativas de llenar el
// textarea de vértices sin pegar coordenadas a mano — parado en cada
// esquina con el GPS del celular, o tocando el mapa directamente.
// Las dos terminan armando el mismo texto "latitud,longitud" por línea
// que ya entiende parsearVertices(), así que el resto del formulario de
// carga de lote no necesita saber de dónde salieron los vértices.
// ---------------------------------------------------------------------------

const elPanelCaptura = document.getElementById("panel-captura-vertices");
const elCapturaMensaje = document.getElementById("captura-mensaje");
const elCapturaContador = document.getElementById("captura-contador");
const elCapturaError = document.getElementById("captura-error");
const elBtnCapturaAgregar = document.getElementById("btn-captura-agregar");
const elBtnCapturaDeshacer = document.getElementById("btn-captura-deshacer");
const elBtnCapturaTerminar = document.getElementById("btn-captura-terminar");

let puntosCaptura = []; // [[lat, lon], ...]
let marcadoresCaptura = [];
let listenerClickMapaCaptura = null;

function actualizarContadorCaptura() {
  const n = puntosCaptura.length;
  let texto = `${n} punto${n === 1 ? "" : "s"} marcado${n === 1 ? "" : "s"}`;
  if (n >= 3) {
    const anillo = [...puntosCaptura, puntosCaptura[0]].map(([lat, lon]) => [lon, lat]);
    texto += ` — ~${Math.round(areaEnM2(anillo))} m²`;
  }
  elCapturaContador.textContent = texto;
}

function agregarPuntoCaptura(lat, lon) {
  puntosCaptura.push([lat, lon]);
  if (getModoCaptura() === "mapa") {
    const marcador = L.circleMarker([lat, lon], {
      radius: 7,
      color: "#fff",
      weight: 2,
      fillColor: "#2e7d32",
      fillOpacity: 1
    }).addTo(mapa);
    marcadoresCaptura.push(marcador);
  }
  elCapturaError.classList.add("oculto");
  actualizarContadorCaptura();
}

function deshacerUltimoPuntoCaptura() {
  puntosCaptura.pop();
  const marcador = marcadoresCaptura.pop();
  if (marcador) mapa.removeLayer(marcador);
  actualizarContadorCaptura();
}

function limpiarCaptura() {
  marcadoresCaptura.forEach((m) => mapa.removeLayer(m));
  marcadoresCaptura = [];
  puntosCaptura = [];
  if (listenerClickMapaCaptura) {
    mapa.off("click", listenerClickMapaCaptura);
    listenerClickMapaCaptura = null;
  }
  setModoCaptura(null);
  elPanelCaptura.classList.add("oculto");
  elCapturaError.classList.add("oculto");
}

function iniciarCapturaGps() {
  setModoCaptura("gps");
  puntosCaptura = [];
  elCapturaMensaje.textContent = 'Parate en cada esquina del lote y toca "Marcar acá".';
  elBtnCapturaAgregar.classList.remove("oculto");
  actualizarContadorCaptura();
  elFormLote.classList.add("oculto");
  elPanelCaptura.classList.remove("oculto");
}

function iniciarCapturaMapa() {
  setModoCaptura("mapa");
  puntosCaptura = [];
  elCapturaMensaje.textContent = "Toca cada esquina del lote directo sobre el mapa.";
  elBtnCapturaAgregar.classList.add("oculto");
  actualizarContadorCaptura();
  elFormLote.classList.add("oculto");
  elPanelCaptura.classList.remove("oculto");

  listenerClickMapaCaptura = (evento) => agregarPuntoCaptura(evento.latlng.lat, evento.latlng.lng);
  mapa.on("click", listenerClickMapaCaptura);
}

elBtnCapturaAgregar.addEventListener("click", () => {
  if (!navigator.geolocation) {
    elCapturaError.textContent = "Este navegador no soporta geolocalización.";
    elCapturaError.classList.remove("oculto");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (posicion) => agregarPuntoCaptura(posicion.coords.latitude, posicion.coords.longitude),
    () => {
      elCapturaError.textContent = "No se pudo obtener tu ubicación. Revisa el permiso de ubicación.";
      elCapturaError.classList.remove("oculto");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

elBtnCapturaDeshacer.addEventListener("click", deshacerUltimoPuntoCaptura);

elBtnCapturaTerminar.addEventListener("click", () => {
  if (puntosCaptura.length < 3) {
    elCapturaError.textContent = "Hacen falta al menos 3 puntos.";
    elCapturaError.classList.remove("oculto");
    return;
  }
  elLoteVertices.value = puntosCaptura.map(([lat, lon]) => `${lat},${lon}`).join("\n");
  elLoteVertices.dispatchEvent(new Event("input"));
  limpiarCaptura();
  elFormLote.classList.remove("oculto");
});

document.getElementById("cerrar-captura-vertices").addEventListener("click", () => {
  const habiaEmpezado = getModoCaptura() !== null;
  limpiarCaptura();
  if (habiaEmpezado) elFormLote.classList.remove("oculto");
});
onSesionCerrada(limpiarCaptura);

document.getElementById("btn-vertices-gps").addEventListener("click", iniciarCapturaGps);
document.getElementById("btn-vertices-mapa").addEventListener("click", iniciarCapturaMapa);

// bboxDelMapaVisible también la usa "Ver catastro cercano" (en app.js).
export { bboxDelMapaVisible };
