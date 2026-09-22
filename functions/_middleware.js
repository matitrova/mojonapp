// Metaetiquetas Open Graph dinámicas para los dos links que un corredor
// comparte: "?lote=<id>" (el botón "Compartir este lote" de la ficha) y
// "/lote/<id>" (la página pública que se le manda al comprador). Sin
// esto, un link compartido por WhatsApp/Facebook mostraba solo
// "MojonApp" pelado, sin superficie, precio ni estado — mucho menos
// vistoso contra cualquier portal inmobiliario (ZonaProp, MercadoLibre)
// que sí arma una tarjeta con foto y precio.
//
// WhatsApp/Facebook/etc. leen el HTML crudo con su propio crawler (no
// ejecutan el JS de la app), así que esto tiene que resolverse del lado
// del servidor — no hay forma de armarlo solo en el cliente.
//
// Y EL NOMBRE QUE APARECE ES EL DE LA INMOBILIARIA, no el del software.
// La tarjeta que se ve en el chat es lo primero que ve el comprador:
// que diga el nombre de la agencia es la mitad del valor de mandar el
// link. Sale de configuracion/inmobiliaria (ver js/inmobiliaria.js), y
// si no está configurada cae a "MojonApp" como antes.
//
// Cloudflare Pages Functions no deja filtrar "_middleware.js" por query
// string en el nombre del archivo: este corre en TODO pedido a la app,
// por eso el primer chequeo (ninguna de las dos formas de link) devuelve
// el pedido sin tocar nada, lo más rápido posible.

// El proyecto sale del dominio, igual que en la app y en
// functions/consulta-lote.js: la vista previa tiene que mostrar los
// datos de SU base, no los de producción. Antes acá había un
// "mojonapp" fijo, así que compartir un lote desde la vista previa
// armaba la tarjeta con un lote de producción — o con ninguno.
import { configPara } from "../js/firebase-proyecto.js";

const NOMBRE_POR_DEFECTO = "MojonApp";

function firestoreBase(hostname) {
  return `https://firestore.googleapis.com/v1/projects/${configPara(hostname).projectId}/databases/(default)/documents`;
}

// Los documentos de Firestore vía REST vienen con cada campo envuelto
// en su tipo ({ stringValue: "..." }, { doubleValue: 123 }, etc.) — este
// helper solo necesita leer valores simples (texto o número), nunca
// geometry ni mapas anidados.
function valorSimple(campos, nombre) {
  const v = campos?.[nombre];
  if (!v) return null;
  return v.stringValue ?? v.integerValue ?? v.doubleValue ?? null;
}

async function datosDelLote(base, loteId) {
  const resp = await fetch(`${base}/lotes/${loteId}`);
  if (!resp.ok) return null;
  const doc = await resp.json();
  const campos = doc.fields || {};
  return {
    manzana: valorSimple(campos, "manzana"),
    lote: valorSimple(campos, "lote"),
    nomenclatura: valorSimple(campos, "nomenclatura"),
    superficie: valorSimple(campos, "superficie_m2"),
    precio: valorSimple(campos, "precio_usd"),
    estado: valorSimple(campos, "estado")
  };
}

// Nunca tira ni frena la respuesta: si la inmobiliaria no está
// configurada, o Firestore no contesta, la tarjeta sale con el nombre
// por defecto. Que no aparezca el nombre de la agencia es una lástima;
// que no salga la tarjeta es perder el link.
async function nombreDeLaInmobiliaria(base) {
  try {
    const resp = await fetch(`${base}/configuracion/inmobiliaria`);
    if (!resp.ok) return NOMBRE_POR_DEFECTO;
    const doc = await resp.json();
    return valorSimple(doc.fields || {}, "nombre") || NOMBRE_POR_DEFECTO;
  } catch {
    return NOMBRE_POR_DEFECTO;
  }
}

const ETIQUETA_ESTADO = { disponible: "Disponible", reservado: "Reservado", vendido: "Vendido" };

// Las dos formas de link que valen. La tabla vive acá y no desparramada
// en ifs para que agregar una tercera no obligue a releer el flujo.
//
// El id del path se decodifica: un id de Firestore no trae caracteres
// raros, pero lo que llega en la URL lo elige quien manda el pedido.
export function idDeLoteEnLaUrl(url) {
  if (url.pathname === "/") return url.searchParams.get("lote");
  if (url.pathname.startsWith("/lote/")) {
    const crudo = url.pathname.slice("/lote/".length).split("/")[0];
    if (!crudo) return null;
    try {
      return decodeURIComponent(crudo);
    } catch {
      return null;
    }
  }
  return null;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const loteId = idDeLoteEnLaUrl(url);

  // Nada que enriquecer: pedidos a /js, /css, /catastro-proxy, la home
  // sin "?lote=", etc. — se deja pasar tal cual, sin pedirle nada a
  // Firestore de más.
  if (!loteId) return context.next();

  const respuesta = await context.next();
  const base = firestoreBase(url.hostname);

  let datos;
  let nombre = NOMBRE_POR_DEFECTO;
  try {
    // En paralelo: son dos lecturas independientes y el crawler de
    // WhatsApp no espera para siempre.
    [datos, nombre] = await Promise.all([datosDelLote(base, loteId), nombreDeLaInmobiliaria(base)]);
  } catch {
    datos = null;
  }
  // Lote borrado, ID inválido, o Firestore no respondió: se sirve la
  // página normal sin metaetiquetas de más — mejor un preview genérico
  // que una página rota.
  if (!datos) return respuesta;

  const titulo = datos.manzana && datos.lote
    ? `${datos.manzana} · Lote ${datos.lote} — ${nombre}`
    : datos.nomenclatura
      ? `${datos.nomenclatura} — ${nombre}`
      : `Lote — ${nombre}`;

  const partes = [];
  if (datos.superficie) partes.push(`${Math.round(datos.superficie)} m²`);
  if (datos.estado) partes.push(ETIQUETA_ESTADO[datos.estado] || datos.estado);
  if (datos.precio) partes.push(`USD ${Number(datos.precio).toLocaleString("es-AR")}`);
  const descripcion = partes.length
    ? `${partes.join(" · ")} — mirá el límite real del terreno en el mapa.`
    : "Mirá el límite real de este terreno sobre imagen satelital.";

  // Este proyecto no tiene wrangler/Node instalado (decisión deliberada,
  // ver memoria) así que _middleware.js no se puede probar en local — la
  // verificación es directo contra el deploy, mismo criterio ya usado
  // para catastro-proxy.js. Por eso HTMLRewriter también queda dentro de
  // un try/catch: si algo sale mal acá, mejor servir la página tal cual
  // (sin el preview enriquecido) que romper la carga de la app entera.
  try {
    return new HTMLRewriter()
      .on("title", { element: (el) => el.setInnerContent(titulo) })
      .on('meta[property="og:title"]', { element: (el) => el.setAttribute("content", titulo) })
      .on('meta[property="og:description"]', { element: (el) => el.setAttribute("content", descripcion) })
      .on('meta[property="og:url"]', { element: (el) => el.setAttribute("content", url.toString()) })
      .on('meta[property="og:site_name"]', { element: (el) => el.setAttribute("content", nombre) })
      .on('meta[name="twitter:title"]', { element: (el) => el.setAttribute("content", titulo) })
      .on('meta[name="twitter:description"]', { element: (el) => el.setAttribute("content", descripcion) })
      .on('meta[name="description"]', { element: (el) => el.setAttribute("content", descripcion) })
      .transform(respuesta);
  } catch {
    return respuesta;
  }
}
