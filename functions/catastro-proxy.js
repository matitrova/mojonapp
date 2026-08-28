// Proxy HTTPS -> HTTP para el WFS del catastro de San Luis (Cloudflare
// Pages Functions — puerto de netlify/functions/catastro-proxy.js,
// mismo motivo, ver el comentario completo ahí).
//
// visualcatsl.dyndns.info (el GeoServer público que usa MojonApp para
// "+ Manzana", "+ Parcela" y "Ver catastro cercano" — ver CATASTRO_WFS_URL
// en js/app.js) solo responde por HTTP: no tiene un certificado TLS
// válido, el handshake HTTPS falla directo (probado con curl). Con
// MojonApp sirviendo por HTTPS, el navegador bloquea ese pedido como
// "mixed content" — lo impone el navegador mismo, no hay forma de
// saltarlo desde el cliente.
//
// Esta función corre del lado del servidor (Cloudflare), no en el
// navegador del corredor: ahí SÍ puede pedirle HTTP al catastro sin que
// la regla de mixed-content aplique (esa regla es browser-a-servidor,
// no servidor-a-servidor), y le devuelve la respuesta ya servida por
// HTTPS. El navegador solo le habla a esta función, nunca directo al
// catastro.
//
// Convención de Cloudflare Pages Functions: este archivo, por vivir en
// functions/catastro-proxy.js, queda servido en /catastro-proxy — sin
// necesidad de wrangler.toml ni ninguna otra config.
const CATASTRO_WFS_URL = "http://visualcatsl.dyndns.info/geoserver/SanLuis/ows";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const destino = `${CATASTRO_WFS_URL}?${url.searchParams.toString()}`;

  try {
    const respuesta = await fetch(destino);
    const cuerpo = await respuesta.text();
    return new Response(cuerpo, {
      status: respuesta.status,
      headers: {
        "Content-Type": respuesta.headers.get("content-type") || "application/json",
        // El catastro no cambia segundo a segundo — evita pegarle de
        // nuevo al WFS por cada paneo/zoom idéntico del mapa.
        "Cache-Control": "public, max-age=60"
      }
    });
  } catch {
    return new Response(JSON.stringify({ error: "No se pudo contactar al catastro." }), {
      status: 502,
      headers: { "Content-Type": "application/json" }
    });
  }
}
