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

// ---------------------------------------------------------------------------
// Apuntar el despliegue a otro proyecto Firebase (ambiente de demo)
//
// js/firebase-config.js tiene el proyecto fijo en el código, y los 12
// módulos que hablan con Firebase importan de ahí — así que reemplazar ESE
// módulo mueve la app entera. Es el mismo truco que scripts/servidor_dev.py
// usa en local, ahora del lado de Cloudflare: este middleware ya corre en
// todos los pedidos, así que puede interceptar el archivo antes de que se
// sirva el estático.
//
// Para qué: tener una URL de demo con datos inventados (rama "demo" →
// demo.mojonapp.pages.dev, con las variables cargadas en el ambiente
// Preview de Pages) sin tocar la app real que usa la inmobiliaria.
//
// PRODUCCIÓN NO CAMBIA, por dos motivos acumulados: en el ambiente de
// producción estas variables no están definidas, y aunque alguien las
// definiera apuntando a "mojonapp" el guard de abajo igual sirve el
// archivo real del repo. Sin variables, esto no hace absolutamente nada.
// ---------------------------------------------------------------------------
const RUTA_CONFIG_FIREBASE = "/js/firebase-config.js";

// Mismo módulo que js/firebase-config.js pero con otro proyecto. Mantiene
// la MISMA interfaz (db, auth y firebaseConfig): si faltara alguno, los
// módulos que lo importan romperían de formas poco obvias.
// authDomain/storageBucket siguen el formato que arma Firebase para
// cualquier proyecto nuevo — igual que config_firebase_generado() en
// scripts/servidor_dev.py, que es el equivalente local de esto.
function configFirebaseGenerado(apiKey, projectId) {
  return `// GENERADO AL VUELO por functions/_middleware.js — NO es un archivo del
// repo. Apunta la app a un proyecto Firebase distinto del de producción
// (ambiente de demo). El archivo de verdad es js/firebase-config.js.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "${apiKey}",
  authDomain: "${projectId}.firebaseapp.com",
  projectId: "${projectId}",
  storageBucket: "${projectId}.firebasestorage.app"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export { firebaseConfig };
`;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.pathname === RUTA_CONFIG_FIREBASE) {
    const apiKey = context.env.MOJONAPP_FIREBASE_API_KEY;
    const projectId = context.env.MOJONAPP_FIREBASE_PROJECT_ID;
    // "mojonapp" es producción: ahí no hay nada que reemplazar.
    if (apiKey && projectId && projectId !== "mojonapp") {
      return new Response(configFirebaseGenerado(apiKey, projectId), {
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          // Igual que /js/* en _headers: el navegador puede cachearlo,
          // pero revalida antes de usarlo. Sin esto, cambiar de proyecto
          // dejaría a alguien con el config viejo en la mano.
          "Cache-Control": "public, max-age=0, must-revalidate"
        }
      });
    }
  }

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
