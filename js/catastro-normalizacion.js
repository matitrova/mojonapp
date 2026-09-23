// ---------------------------------------------------------------------------
// Acceso y normalización de los 3 catastros provinciales que usa MojonApp
// (San Luis, Córdoba, Buenos Aires) — pedir al WFS de cada uno y adaptar su
// esquema crudo (completamente distinto entre provincias) a una forma común.
// Nada de este archivo toca el DOM ni el mapa: reciben/devuelven datos
// (features GeoJSON, strings, objetos) y usan `fetch` directo. La lógica que
// SÍ depende del mapa (bbox del área visible, mostrar resultados en un
// formulario, etc.) se queda en app.js y llama a estas funciones.
// ---------------------------------------------------------------------------

// GeoServer público de la Dirección Provincial de Catastro y Tierras
// Fiscales de San Luis (el mismo que usa su visor público en
// sistemacatastro.sanluis.gov.ar). No es una API oficial ni documentada:
// se encontró mirando qué pide el navegador del visor. Puede cambiar o
// dejar de andar sin aviso — si eso pasa, "Traer manzana del catastro"
// deja de funcionar pero el resto de la app sigue igual.
//
// No se pide directo: ese GeoServer solo responde por HTTP (sin TLS
// válido), y el navegador bloquea ese pedido como "mixed content" desde
// una página HTTPS como mojonapp.com.ar. Se pasa por
// functions/catastro-proxy.js (Cloudflare Pages Functions), que sí
// puede hablarle por HTTP (corre en el servidor, no en el navegador) y
// devuelve la respuesta por HTTPS. En local (servidor de pruebas por
// HTTP) esta ruta no existe — pedirWfs() cae al WFS real directo en ese
// caso, ver abajo.
export const CATASTRO_WFS_URL =
  location.protocol === "https:" ? "/catastro-proxy" : "http://visualcatsl.dyndns.info/geoserver/SanLuis/ows";

// GeoServer de IDECOR (Dirección General de Catastro de Córdoba) — a
// diferencia del de San Luis, este SÍ es un servicio oficial y
// documentado (mapascordoba.gob.ar), y responde por HTTPS sin
// problemas de certificado — no necesita pasar por un proxy propio.
// Se suma porque hay lotes limítrofes con Córdoba. Esquema bien
// distinto al de San Luis: la capa "idecor:parcelas_graf" trae campos
// estructurados propios (Nomenclatura, Tipo_Parcela, Superficie_Tierra_
// Urbana/Rural) en vez de todo empaquetado en un campo de texto libre
// como el NOMBRE de San Luis, y la geometría es MultiPolygon en vez de
// Polygon (ver primerAnilloDeGeometria más abajo).
export const CATASTRO_CBA_WFS_URL = "https://gn-idecor.mapascordoba.gob.ar/geoserver/wfs";

// GeoServer de ARBA/IDERA (Agencia de Recaudación de la Provincia de
// Buenos Aires) — mismo criterio que Córdoba: oficial, documentado,
// HTTPS sin problemas. Capa "idera:Parcela", con nombres de campo bien
// abreviados: cca (código catastral, hace de nomenclatura), tpa (tipo:
// "Urbano"/"Rural", sin equivalente a "CALLE" visto en el muestreo, no
// se filtra nada), ara1 (superficie en m², numérico), pda (número de
// partida — más corto que el cca, se usa como etiqueta en el mapa).
// Geometría también MultiPolygon.
export const CATASTRO_BSAS_WFS_URL = "https://geo.arba.gov.ar/geoserver/idera/wfs";

// baseUrl parametrizado para poder pedirle tanto al WFS de San Luis
// como al de Córdoba con la misma función — pedirWfs() (sin base propia)
// sigue siendo el de San Luis de siempre, para no tocar el resto de los
// call sites que ya lo usan así.
export async function pedirWfsA(baseUrl, params) {
  const url = `${baseUrl}?${new URLSearchParams(params).toString()}`;
  const respuesta = await fetch(url);
  if (!respuesta.ok) {
    throw new Error("El catastro no respondió. Prueba de nuevo en un momento.");
  }
  const datos = await respuesta.json();
  if (!datos.features) {
    throw new Error("El catastro devolvió una respuesta inesperada.");
  }
  return datos.features;
}

export async function pedirWfs(params) {
  return pedirWfsA(CATASTRO_WFS_URL, params);
}

// La geometría de una parcela puede venir como Polygon (San Luis) o
// MultiPolygon (Córdoba) — esto da el primer anillo exterior en
// cualquiera de los dos casos, para todo el código que solo necesita
// "la forma" y no le importan islas/partes adicionales (no hay lotes
// reales con agujeros o multi-parte en esta app).
export function primerAnilloDeGeometria(geometry) {
  return geometry.type === "MultiPolygon" ? geometry.coordinates[0][0] : geometry.coordinates[0];
}

// Normalizan una parcela cruda del WFS (esquemas completamente
// distintos entre provincias) a la única forma que el resto de la app
// necesita para poder cargarla como lote: nomenclatura, una etiqueta
// corta para mostrar en el mapa, y superficie si se puede determinar.
// Se guarda en feature.properties._mojon en vez de tocar las
// propiedades originales del WFS (por si hace falta depurar con los
// datos crudos más adelante).
export function normalizarParcelaSanLuis(feature) {
  feature.properties._mojon = {
    provincia: "San Luis",
    nomenclatura: feature.properties.CATNMC_CAT || null,
    etiqueta: feature.properties.ETIQUETA || "",
    superficie_m2: superficieDesdeNombreCatastro(feature.properties.NOMBRE)
  };
  return feature;
}

export function normalizarParcelaCordoba(feature) {
  const p = feature.properties;
  feature.properties._mojon = {
    provincia: "Córdoba",
    nomenclatura: p.Nomenclatura || null,
    etiqueta: p.desig_oficial || "",
    superficie_m2: p.Superficie_Tierra_Urbana > 0 ? p.Superficie_Tierra_Urbana : p.Superficie_Tierra_Rural || null
  };
  return feature;
}

export function normalizarParcelaBuenosAires(feature) {
  const p = feature.properties;
  feature.properties._mojon = {
    provincia: "Buenos Aires",
    nomenclatura: p.cca || null,
    etiqueta: p.pda || "",
    superficie_m2: p.ara1 || null
  };
  return feature;
}

// El campo NOMBRE de una manzana trae, entre otras cosas, su nomenclatura
// catastral: " Manzana: 104 \n Nomenclatura Manzana:00-06-44-05-000104".
// La nomenclatura de cada parcela empieza exactamente con la de su
// manzana ("00-06-44-05-000104-000001"), así que sirve para filtrar con
// precisión — mejor que quedarse con todo lo que cae dentro de un
// rectángulo, que trae parcelas de la manzana vecina también.
export function nomenclaturaDeManzana(nombre) {
  const coincidencia = /Nomenclatura Manzana:\s*([\d-]+)/i.exec(nombre || "");
  return coincidencia ? coincidencia[1] : null;
}

// El campo NOMBRE del catastro trae todo junto en texto libre, por ejemplo:
// "Parcela: 2569 \n Nom.Catastral: 00-06-... \n Sup. Terreno: 3024.04 m2 \n
//  Tipo Parcela: URBANA \n Plano Mensura: 06-56-2015". Se extrae la
// superficie con una expresión regular; si el formato cambia y no
// coincide, se deja en null en vez de romper la importación.
export function superficieDesdeNombreCatastro(nombre) {
  const coincidencia = /Sup\.\s*Terreno:\s*([\d.,]+)\s*m2/i.exec(nombre || "");
  return coincidencia ? Number(coincidencia[1].replace(",", ".")) : null;
}

// El mismo campo trae el "Tipo Parcela" (URBANA, RURAL, SUB, PROPIEDAD
// HORIZONTAL, CALLE...). Las de tipo CALLE son calles/caminos registrados
// como parcela en el catastro (se confirmó con un caso real: 399
// vértices, ~28.300 m², "Tipo Parcela: CALLE") — no son lotes que un
// corredor pueda cargar, así que se descartan en todas las búsquedas.
export function esParcelaDeCalle(nombre) {
  return /Tipo Parcela:\s*CALLE/i.test(nombre || "");
}

// La nomenclatura de una parcela es la de su manzana más "-parcela"
// (ver nomenclaturaDeManzana más arriba): "00-06-43-03-000022-000020" es
// la parcela 20 de la manzana 22. El anteúltimo segmento es el número de
// manzana con ceros a la izquierda.
export function manzanaDesdeNomenclaturaDeParcela(nomenclatura) {
  const partes = (nomenclatura || "").split("-");
  if (partes.length < 2) return null;
  const numero = parseInt(partes[partes.length - 2], 10);
  return Number.isNaN(numero) ? null : String(numero);
}

// Los dos números que hacen falta para nombrar un lote en castellano, o
// null. Es la versión estricta de manzanaDesdeNomenclaturaDeParcela: esa
// precarga un campo del formulario, que el corredor ve y corrige; esto
// arma el título que el lote va a llevar en el mapa, en la ficha y en el
// CRM, así que ante la duda no inventa nada.
//
// POR QUÉ EXIGE LOS 6 GRUPOS DE SAN LUIS. Con menos, el anteúltimo grupo
// ya no es la manzana: la nomenclatura de una MANZANA tiene 5 grupos
// ("00-06-44-05-000104") y ahí el anteúltimo es la sección. Y el campo
// nomenclatura se puede cargar a mano (#lote-nomenclatura), o venir de
// Córdoba/Buenos Aires, que usan otros formatos. Cuando no encaja se
// devuelve null y el que llama muestra el código crudo: feo, pero nunca
// miente.
export function manzanaYLoteDesdeNomenclatura(nomenclatura) {
  const partes = (nomenclatura || "").trim().split("-");
  if (partes.length !== 6 || !partes.every((parte) => /^\d+$/.test(parte))) return null;
  const manzana = parseInt(partes[4], 10);
  const lote = parseInt(partes[5], 10);
  if (Number.isNaN(manzana) || Number.isNaN(lote)) return null;
  return { manzana: String(manzana), lote: String(lote) };
}
