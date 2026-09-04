// Metaetiquetas Open Graph dinámicas para "?lote=<id>" (ver "Compartir
// este lote" en js/ficha.js) — sin esto, un link compartido por
// WhatsApp/Facebook mostraba solo "MojonApp" pelado, sin superficie,
// precio ni estado del lote puntual: mucho menos vistoso para un
// corredor mandándoselo a un cliente, contra cualquier portal
// inmobiliario (ZonaProp, MercadoLibre) que sí arma una tarjeta con
// foto/precio al compartir.
//
// WhatsApp/Facebook/etc. leen el HTML crudo con su propio crawler (no
// ejecutan el JS de la app), así que esto tiene que resolverse del
// lado del servidor — no hay forma de armarlo solo en el cliente.
//
// Cloudflare Pages Functions no deja filtrar "_middleware.js" por query
// string en el nombre del archivo: este corre en TODO pedido a la app,
// por eso el primer chequeo (sin "?lote=", o no es la home) devuelve el
// pedido sin tocar nada, lo más rápido posible.
const PROJECT_ID = "mojonapp";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Los documentos de Firestore vía REST vienen con cada campo envuelto
// en su tipo ({ stringValue: "..." }, { doubleValue: 123 }, etc.) — este
// helper solo necesita leer valores simples (texto o número), nunca
// geometry ni mapas anidados.
function valorSimple(campos, nombre) {
  const v = campos?.[nombre];
  if (!v) return null;
  return v.stringValue ?? v.integerValue ?? v.doubleValue ?? null;
}

async function datosDelLote(loteId) {
  const resp = await fetch(`${FIRESTORE_BASE}/lotes/${loteId}`);
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

const ETIQUETA_ESTADO = { disponible: "Disponible", reservado: "Reservado", vendido: "Vendido" };

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const loteId = url.searchParams.get("lote");

  // Nada que enriquecer: pedidos a /js, /css, /catastro-proxy, la home
  // sin "?lote=", etc. — se deja pasar tal cual, sin pedirle nada a
  // Firestore de más.
  if (!loteId || url.pathname !== "/") {
    return context.next();
  }

  const respuesta = await context.next();

  let datos;
  try {
    datos = await datosDelLote(loteId);
  } catch {
    datos = null;
  }
  // Lote borrado, ID inválido, o Firestore no respondió: se sirve la
  // página normal sin metaetiquetas de más — mejor un preview genérico
  // que una página rota.
  if (!datos) return respuesta;

  const titulo = datos.manzana && datos.lote
    ? `${datos.manzana} · Lote ${datos.lote} — MojonApp`
    : datos.nomenclatura
      ? `${datos.nomenclatura} — MojonApp`
      : "Lote — MojonApp";

  const partes = [];
  if (datos.superficie) partes.push(`${Math.round(datos.superficie)} m²`);
  if (datos.estado) partes.push(ETIQUETA_ESTADO[datos.estado] || datos.estado);
  if (datos.precio) partes.push(`USD ${Number(datos.precio).toLocaleString("es-AR")}`);
  const descripcion = partes.length
    ? `${partes.join(" · ")} — mirá el límite real del terreno en el mapa.`
    : "Mirá el límite real de este terreno sobre imagen satelital.";

  // Este proyecto no tiene wrangler/Node instalado (decisión deliberada,
  // ver memoria) así que _middleware.js no se puede probar en local — la
  // verificación es directo en producción, mismo criterio ya usado para
  // catastro-proxy.js. Por eso HTMLRewriter también queda dentro de un
  // try/catch: si algo sale mal acá, mejor servir la página tal cual
  // (sin el preview enriquecido) que romper la carga de la app entera.
  try {
    return new HTMLRewriter()
      .on("title", { element: (el) => el.setInnerContent(titulo) })
      .on('meta[property="og:title"]', { element: (el) => el.setAttribute("content", titulo) })
      .on('meta[property="og:description"]', { element: (el) => el.setAttribute("content", descripcion) })
      .on('meta[property="og:url"]', { element: (el) => el.setAttribute("content", url.toString()) })
      .on('meta[name="twitter:title"]', { element: (el) => el.setAttribute("content", titulo) })
      .on('meta[name="twitter:description"]', { element: (el) => el.setAttribute("content", descripcion) })
      .on('meta[name="description"]', { element: (el) => el.setAttribute("content", descripcion) })
      .transform(respuesta);
  } catch {
    return respuesta;
  }
}
