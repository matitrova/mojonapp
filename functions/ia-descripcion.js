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

// "No inventes datos" es la regla importante de todo este prompt, no un
// detalle de estilo: un aviso publicado que promete un servicio que el
// lote no tiene es un problema con un comprador real, no un bug.
const INSTRUCCIONES = `Sos quien redacta los avisos de una inmobiliaria chica de la zona serrana de San Luis, Argentina.

Escribí el aviso de este lote para publicar en un portal inmobiliario (ZonaProp, MercadoLibre, Argenprop).

Reglas:
- Español rioplatense, natural y concreto. Nada de "¡No deje pasar esta oportunidad única!" ni relleno de folleto.
- Entre 40 y 90 palabras, en uno o dos párrafos cortos.
- Usá ÚNICAMENTE los datos que te paso. No inventes servicios, medidas, distancias, escrituras, financiación ni características del terreno que no estén en la lista. Si un dato no está, no lo menciones y no lo reemplaces por una suposición.
- Tampoco DEDUZCAS cualidades a partir de los datos. Un dato del terreno no autoriza a afirmar nada que se siga de él: de "pendiente suave" no se sigue "buena orientación"; de "vista al dique" no se sigue "ideal para descansar"; de "calle de ripio" no se sigue "buen acceso"; de una superficie grande no se sigue "ideal para dos viviendas". Esas conclusiones las saca quien compra, no el aviso.
- Nada de distancias, tiempos de viaje, servicios del barrio, comparaciones con otros lotes ni proyecciones de valor. Aunque los sepas, acá no los tenés.
- Pero el aviso tiene que resultar LINDO de leer, no una ficha técnica. Escribilo con calidez, cuidando el ritmo de las frases. Si buscás darle atractivo, tenés exactamente dos lugares de donde sacarlo, y ninguno inventa nada:
  1. UBICAR al lector: nombrar la zona y el barrio que te pasé y dejar claro que es zona serrana de San Luis, para que se imagine dónde queda.
  2. APOYARTE en el dato más fuerte de la lista (la vista, la superficie, un servicio ya instalado) y contarlo bien, con lenguaje natural en vez de enumerarlo seco.
  Lo primero es dónde está; lo segundo es qué tiene. Todo lo demás sobra.
- Los servicios que te paso YA ESTÁN en el lote. Decilo sin ambigüedad: "cuenta con luz y agua", "tiene luz y agua". Nunca "disponibles", "con posibilidad de", "en la zona" ni nada que se pueda leer como que todavía hay que conectarlos — quien compra lo va a reclamar en la visita y va a tener razón.
- Antes de responder, releé lo que escribiste y preguntate, frase por frase, de qué dato de la lista sale. Si alguna afirmación no sale de ninguno, borrala. Devolvé solo el aviso corregido, sin mostrar esta revisión.
- El cierre: variá de verdad, no cambies dos palabras. Esta agencia publica su cartera entera y los avisos se leen uno al lado del otro. Evitá las fórmulas gastadas ("vale la pena ir a conocerlo", "una buena opción para quienes buscan..."). Mejor todavía: cerrá apoyándote en algo concreto de ESTE lote, que va a ser distinto en cada uno. Y si el aviso ya cierra bien sin agregar nada, no agregues una frase de relleno solo por cerrar.
- No inventes precio. Si te paso precio, podés mencionarlo; si no, no hables de precio.
- No uses emojis, ni hashtags, ni MAYÚSCULAS de grito.
- Devolvé solamente el texto del aviso, sin título, sin comillas y sin comentarios tuyos.`;

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
        // La tarea es corta y acotada: no necesita que el modelo piense
        // de más, y bajar el esfuerzo abarata la llamada y la hace más
        // rápida (que en una demo se nota más que el costo).
        output_config: { effort: "low" },
        system: INSTRUCCIONES,
        messages: [{ role: "user", content: datos }]
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

  return json({ texto });
}
