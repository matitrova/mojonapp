// Redacta con IA la descripción de un lote para publicar en portales
// (ZonaProp, MercadoLibre, Argenprop) — la primera de las funciones del
// panel "Inteligencia Artificial" que deja de ser "Próximamente" y pasa
// a andar de verdad. La versión por plantilla sigue existiendo y no se
// toca: "Copiar descripción para portales" en js/ficha.js arma el mismo
// texto con campos fijos, gratis y sin conexión a nada. Esto es la
// versión redactada.
//
// Por qué esto vive del lado del servidor y no en js/: la API key no
// puede viajar al navegador (cualquiera abre las devtools y se la
// lleva). Vive como *secret* de Cloudflare y solo se lee acá dentro
// (context.env.ANTHROPIC_API_KEY) — mismo criterio que
// catastro-proxy.js, el navegador le habla a esta función y nunca al
// proveedor directo.
//
// Convención de Cloudflare Pages Functions: por vivir en
// functions/ia-descripcion.js queda servido en /ia-descripcion, sin
// wrangler.toml ni ninguna otra config.
//
// Igual que catastro-proxy.js y _middleware.js, este archivo NO se
// puede probar en local (no hay wrangler/Node instalado, decisión
// deliberada del proyecto): el test de tests/test_ia_descripcion.py
// mockea la respuesta con page.route() y la verificación real es
// directo sobre el sitio ya desplegado.

// El modelo, a propósito en una constante y no enterrado en el cuerpo
// del pedido: elegir entre Sonnet y Opus para esta tarea es algo que se
// decide LEYENDO los avisos que salen, no mirando la tabla de precios,
// así que cambiarlo tiene que costar editar una línea. Sonnet 5 es el
// default porque redactar un aviso corto a partir de campos que ya
// vienen estructurados no es un problema difícil; si los textos salen
// flojos, se prueba "claude-opus-5" (2,5 veces más caro, ~1 dólar por
// mes de diferencia al volumen de una inmobiliaria chica).
const MODELO = "claude-sonnet-5";

// Techo duro de lo que puede costar UNA llamada. No es una estimación
// de cuánto va a escribir el modelo (un aviso ronda los 300 tokens):
// es el tope que hace que un prompt raro o un modelo enroscado no
// puedan convertirse en una factura.
//
// Ojo si alguien lo baja: este presupuesto lo comparten el razonamiento
// del modelo y el aviso en sí. Con 1000 y effort "low" sobra de lejos,
// pero apretarlo hasta el largo del aviso haría que el razonamiento se
// coma el presupuesto y la respuesta llegue cortada o vacía.
const MAX_TOKENS = 1000;

// La misma config pública que js/firebase-config.js — no es secreta
// (ver el comentario ahí), la seguridad real la dan las reglas de
// Firestore y la validación del token de acá abajo.
const FIREBASE_API_KEY = "AIzaSyCR9w0fwXixk4CZV051-srq9PsTvmp5lGQ";

// Qué campos del lote se aceptan, y cuánto texto se deja pasar de cada
// uno. Sin esta lista blanca, alguien con una cuenta válida puede
// mandar cualquier cosa en "observaciones" y usar el endpoint como una
// API de IA de uso general pagada por vos.
const CAMPOS_TEXTO = { titulo: 120, sector: 80, barrio: 80, observaciones: 600 };
const SERVICIOS_CONOCIDOS = ["luz", "agua", "gas", "cloaca"];

function json(cuerpo, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// Valida la sesión del corredor contra Google. Se eligió este camino
// (un fetch) por sobre verificar la firma del JWT contra las claves
// públicas de Google (~80 líneas de WebCrypto): cuesta unos 100ms por
// llamada, y a este volumen esos 100ms no le importan a nadie.
//
// Sin esta verificación el endpoint es una API de IA gratis para
// cualquiera que descubra la URL — que es pública, como la de cualquier
// otra ruta del sitio.
async function sesionValida(idToken) {
  if (typeof idToken !== "string" || idToken.length < 20) return false;
  try {
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken })
      }
    );
    if (!resp.ok) return false;
    const datos = await resp.json();
    return Array.isArray(datos.users) && datos.users.length > 0;
  } catch {
    return false;
  }
}

// Arma el texto que se le manda al modelo a partir SOLO de los campos
// permitidos, recortados. Devuelve null si no quedó nada con qué
// trabajar (un lote sin ningún dato no da para redactar nada).
function datosDelLote(lote) {
  if (!lote || typeof lote !== "object") return null;

  const lineas = [];
  for (const [campo, largoMaximo] of Object.entries(CAMPOS_TEXTO)) {
    const valor = lote[campo];
    if (typeof valor === "string" && valor.trim()) {
      lineas.push(`${campo}: ${valor.trim().slice(0, largoMaximo)}`);
    }
  }
  if (Number.isFinite(lote.superficie_m2)) lineas.push(`superficie_m2: ${lote.superficie_m2}`);
  if (Number.isFinite(lote.precio_usd)) lineas.push(`precio_usd: ${lote.precio_usd}`);

  const servicios = SERVICIOS_CONOCIDOS.filter((s) => lote.servicios?.[s] === true);
  if (servicios.length) lineas.push(`servicios: ${servicios.join(", ")}`);

  return lineas.length ? lineas.join("\n") : null;
}

// Las distancias medidas que manda el cliente (ver cercaniasDelLote en
// js/ia-descripcion.js). Se formatean ACÁ y no del lado del navegador a
// propósito: así lo único que cruza la red son números, que no pueden
// traer texto colado en el prompt. El nombre de la localidad sí es texto
// —viene de OpenStreetMap— así que se le sacan los saltos de línea y se
// recorta, por el mismo motivo.
function formatearKm(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1).replace(".", ",")} km`;
}

function lineasDeCercanias(cercanias) {
  if (!cercanias || typeof cercanias !== "object") return [];

  const lineas = [];
  const { rutaKm, localidadKm, localidadNombre } = cercanias;

  // Techo de 200 km: más que eso es un cálculo con algo mal, no un lote
  // lejos — la consulta original ni siquiera mira más allá de 15 km.
  const valida = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 200;

  if (valida(rutaKm)) lineas.push(`distancia medida a la ruta pavimentada más cercana: ${formatearKm(rutaKm)}`);
  if (valida(localidadKm) && typeof localidadNombre === "string" && localidadNombre.trim()) {
    const nombre = localidadNombre.replace(/\s+/g, " ").trim().slice(0, 60);
    lineas.push(`distancia medida a ${nombre}: ${formatearKm(localidadKm)}`);
  }
  return lineas;
}

// "No inventes datos" es la regla importante de todo este prompt, no un
// detalle de estilo: un aviso publicado que promete un servicio que el
// lote no tiene es un problema con un comprador real, no un bug.
// Este prompt se reescribió corto a propósito. La versión anterior tenía
// diez reglas largas y las importantes quedaban enterradas en el medio:
// en las pruebas reales el modelo ignoró dos prohibiciones explícitas
// ("disponibles" y el cierre repetido) en 2 de cada 3 avisos. Las tres
// prohibiciones duras van ahora arriba, cortas y separadas del resto.
// Si hay que sumar una regla nueva, conviene sacar otra antes que alargar
// la lista.
const INSTRUCCIONES = `Sos quien redacta los avisos de una inmobiliaria chica de la zona serrana de San Luis, Argentina. Escribí el aviso de este lote para publicar en un portal (ZonaProp, MercadoLibre, Argenprop).

TRES PROHIBICIONES. Son las que importan:

1. No afirmes NADA que no esté en los datos que te paso. Ni datos nuevos (servicios, medidas, distancias, tiempos de viaje, escrituras, financiación) ni conclusiones sacadas de los datos: de "pendiente suave" no se sigue "buena orientación", de "vista al dique" no se sigue "ideal para descansar", de "calle de ripio" no se sigue "buen acceso". Esas conclusiones las saca quien compra.

   UNA EXCEPCIÓN: si entre los datos viene alguna línea que empieza con "distancia medida a", ese número está medido de verdad y SÍ lo podés usar — conviene, porque ubica al lector. Escribilo tal como te lo paso, sin redondear ni convertirlo en tiempo de viaje ("a 10 minutos" sigue prohibido: no sabés a qué velocidad). Cualquier otra distancia o referencia que no venga en esa forma sigue estando prohibida.

2. Los servicios que te paso YA ESTÁN instalados en el lote. Escribí "cuenta con luz y agua" o "tiene luz y agua". Está PROHIBIDA la palabra "disponibles", y también "con posibilidad de" o "en la zona": se leen como que todavía hay que conectarlos, y quien compra lo reclama en la visita.

3. Está PROHIBIDO cerrar con "vale la pena ir a conocerlo", "vale la pena ir a verlo", "una buena opción para quienes buscan" o cualquier variante de esas. Esta agencia publica su cartera entera y los avisos se leen uno al lado del otro.

El aviso NO puede terminar en el precio ni en una enumeración de datos: eso es una ficha técnica, no un aviso. La última frase tiene que retomar algo concreto de ESTE lote y decir qué habilita para quien compre, sin prometer nada que no esté en los datos. Como es distinto en cada lote, el cierre sale distinto solo. Ejemplos de la forma (no los copies): "Son 900 metros para acomodar la casa mirando al dique." / "Con la luz y el agua ya puestas, se puede empezar a construir sin trámites previos."

Tres cuidados con el cierre:
- El cierre habla SOLO del lote y de lo que se puede hacer DENTRO de él. Está prohibido afirmar nada sobre los vecinos, los terrenos de al lado, el entorno o el futuro. Concretamente: si te paso "vista al dique", el lote tiene vista al dique y se terminó — no digas que es abierta, despejada, que no hay nada que la tape, que es panorámica ni que va a seguir así. Eso nadie lo verificó, y si mañana el vecino construye, el aviso prometió algo falso. (Las "distancias medidas" son la excepción de siempre: son dato, no interpretación. Pero van en el cuerpo, donde ubican; no las uses de cierre.)
- NO repitas en el cierre un dato que ya dijiste en el cuerpo. El cierre agrega algo, no resume.
- Elegí para el cierre lo que un comprador valora: la vista, los servicios ya instalados, la superficie. La pendiente, el tipo de calle, la forma del terreno y parecidos son características, no atractivos: van una sola vez en el cuerpo y al pasar, nunca como argumento de venta ni en el cierre.

CUIDADO CON "observaciones". Ese campo lo escribe el corredor para sí mismo, no para publicar, y suele mezclar las dos cosas. Usá solamente lo que describe el terreno para alguien que lo quiere comprar (la vista, la forma, el estado, lo que tiene alrededor). IGNORÁ por completo todo lo demás: de dónde salieron los datos, sistemas de coordenadas, nombres de organismos, fechas de relevamiento, códigos internos, recordatorios del corredor. Nada de eso va en un aviso.

Y si una observación es ambigua, no la interpretes: ignorala. Un ejemplo real: "lote de difícil ubicación" puede querer decir que cuesta encontrarlo en el mapa, no que tenga mal acceso — si lo publicás como "difícil acceso" estás inventando un defecto que espanta compradores. Ante la duda, no lo menciones. Si después de descartar todo esto no queda nada usable en observaciones, escribí el aviso con el resto de los datos y listo.

Cómo escribirlo:
- Que sea lindo de leer, no una ficha técnica. Español rioplatense, natural, cuidando el ritmo de las frases. Nada de "¡oportunidad única!".
- El atractivo sale de dos lugares y de ningún otro: ubicar al lector (nombrar barrio y zona, que es la sierra de San Luis) y contar bien el dato más fuerte de la lista (la vista, la superficie, un servicio).
- Entre 40 y 90 palabras, uno o dos párrafos cortos.
- Sin emojis, sin hashtags, sin MAYÚSCULAS de grito.

Antes de responder, releé lo que escribiste y verificá las tres prohibiciones una por una. Devolvé solamente el aviso corregido: sin título, sin comillas y sin mostrar esta revisión.`;

// Descargo al pie del aviso. Va acá y NO en el prompt a propósito: es una
// frase legal que tiene que salir SIEMPRE y SIEMPRE igual, y una
// instrucción más en el prompt es algo que el modelo puede olvidar,
// reescribir o resumir — ya pasó con otras reglas de esta misma función.
// Escrito en código, no falla nunca.
//
// Es práctica estándar del rubro: revisando los 21 terrenos publicados en
// Potrero de los Funes, casi todas las inmobiliarias incluyen un descargo
// equivalente. Y es el mismo criterio que la app ya usa en el mapa ("las
// ubicaciones son orientativas y no reemplazan una mensura profesional").
const DESCARGO =
  "Los datos de esta publicación son orientativos y no forman parte de documentación contractual. " +
  "Las medidas y superficies definitivas surgen del título de propiedad.";

export async function onRequestPost(context) {
  const apiKey = context.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Falta configurar el secret en Cloudflare. Se distingue del resto
    // de los errores a propósito: es el único que se arregla del lado
    // de ustedes y no reintentando.
    //
    // Si esto vuelve a aparecer con el secret aparentemente cargado, el
    // sospechoso número uno es que el VALOR esté vacío: Cloudflare
    // muestra "Valor cifrado" en el panel tenga contenido o no, así que
    // una variable bien nombrada y guardada sin valor se ve idéntica a
    // una correcta. Pasó una vez (2026-09-16) y costó varias vueltas
    // encontrarlo. La forma rápida de confirmarlo es devolver acá
    // `typeof` y `.length` del valor por un deploy: string de largo 0 es
    // exactamente ese caso.
    return json({ error: "La función de IA todavía no está configurada." }, 503);
  }

  let cuerpo;
  try {
    cuerpo = await context.request.json();
  } catch {
    return json({ error: "Pedido inválido." }, 400);
  }

  if (!(await sesionValida(cuerpo.idToken))) {
    return json({ error: "Tenés que iniciar sesión para usar esto." }, 401);
  }

  const datos = datosDelLote(cuerpo.lote);
  if (!datos) {
    return json({ error: "Este lote no tiene datos cargados como para redactar un aviso." }, 400);
  }

  let respuesta;
  try {
    respuesta = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: MAX_TOKENS,
        // Empezó en "low" (la tarea es corta y acotada). Se subió a
        // "medium" porque con "low" el modelo ignoraba prohibiciones
        // explícitas del prompt en 2 de cada 3 avisos — el esfuerzo es lo
        // que gobierna cuánto cuida las instrucciones, y acá las
        // instrucciones son el producto. El costo sigue siendo décimas de
        // centavo por aviso.
        output_config: { effort: "medium" },
        system: INSTRUCCIONES,
        messages: [{ role: "user", content: [datos, ...lineasDeCercanias(cuerpo.cercanias)].join("\n") }]
      })
    });
  } catch {
    return json({ error: "No se pudo contactar al servicio de IA." }, 502);
  }

  if (!respuesta.ok) {
    return json({ error: "El servicio de IA no pudo responder ahora. Probá de nuevo en un rato." }, 502);
  }

  const resultado = await respuesta.json();

  // Chequear stop_reason ANTES de leer el contenido: si el modelo se
  // negó a responder, "content" no trae el texto que uno espera.
  // Redactando avisos de lotes esto no debería pasar nunca, pero leerlo
  // sin mirar rompe de la peor forma (texto vacío, sin explicación).
  if (resultado.stop_reason === "refusal") {
    return json({ error: "El servicio de IA no pudo redactar este aviso." }, 502);
  }

  // Con el pensamiento activado, "content" puede traer bloques de otro
  // tipo antes del texto — por eso se busca el bloque de texto en vez
  // de agarrar content[0] y confiar.
  const texto = (resultado.content || []).find((b) => b.type === "text")?.text?.trim();
  if (!texto) {
    return json({ error: "El servicio de IA devolvió una respuesta vacía." }, 502);
  }

  return json({ texto: `${texto}\n\n${DESCARGO}` });
}
