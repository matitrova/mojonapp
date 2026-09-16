// Convierte la consulta que llegó por mail desde un portal (ZonaProp,
// MercadoLibre, Argenprop) en un contacto del CRM ya cargado — la
// segunda tarjeta del panel "Inteligencia Artificial" que pasa a andar
// de verdad, hermana de ia-descripcion.js.
//
// OJO CON EL ALCANCE: el mail NO entra solo, lo pega el corredor. La
// versión donde entra solo necesita un Email Worker de Cloudflare, que
// (1) se crea únicamente por CLI, o sea instalar Node y wrangler — la
// dependencia que este proyecto evitó a propósito, ver el comentario en
// _middleware.js —, (2) es un Worker aparte y no una Pages Function, y
// (3) obliga a tocar los MX de mojonapp.com.ar, con el riesgo de dejar
// sin mail al dominio que se usa para hablar con clientes.
//
// Lo bueno es que la parte difícil (entender el mail y sacarle el lead)
// es la misma en los dos casos: el día que se monte ese Email Worker,
// tiene que llamar a este mismo endpoint con el texto del mail. No hay
// nada de acá que haya que rehacer.
//
// Por qué del lado del servidor: igual que ia-descripcion.js, la API
// key no puede viajar al navegador. Vive como secret de Cloudflare y se
// lee solo acá (context.env.ANTHROPIC_API_KEY).

// -------------------------------------------------------------------------
// sesionValida() y json() están duplicados de ia-descripcion.js a
// propósito. La documentación de Cloudflare Pages Functions no dice si un
// archivo compartido dentro de functions/ (por ejemplo _comun.js) queda
// excluido del routing o se publica como una ruta más — y este proyecto no
// puede probar Pages Functions en local para averiguarlo. Entre duplicar 30
// líneas legibles y arriesgarse a publicar sin querer un endpoint que no
// existe, se eligió duplicar. Si algún día se suma wrangler, esto se
// unifica.
// -------------------------------------------------------------------------
const MODELO = "claude-sonnet-5";
const MAX_TOKENS = 1000;
const FIREBASE_API_KEY = "AIzaSyCR9w0fwXixk4CZV051-srq9PsTvmp5lGQ";

// Un mail de portal con la cadena de respuestas abajo puede ser larguísimo.
// Se corta acá: lo que importa (quién consultó y por qué) siempre está
// arriba, y sin tope el costo de una llamada lo decide quien pega el texto.
const MAX_CARACTERES_MAIL = 6000;

function json(cuerpo, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

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

// Structured outputs: acá la respuesta tiene que ser DATOS, no prosa, y
// pedirle JSON por prompt y rezar es la forma conocida de comerse un
// "claro, acá va:" adelante del objeto. Con esto el bloque de texto de la
// respuesta viene con JSON válido garantizado contra este schema.
//
// Todos los campos van en "required" y los que pueden faltar se declaran
// nullable: así el modelo tiene que decir explícitamente "no estaba" en vez
// de omitir la clave, que es más fácil de manejar del lado del cliente.
const SCHEMA_LEAD = {
  type: "object",
  properties: {
    nombre: { type: ["string", "null"] },
    telefono: { type: ["string", "null"] },
    email: { type: ["string", "null"] },
    propiedad: { type: ["string", "null"] },
    consulta: { type: ["string", "null"] }
  },
  required: ["nombre", "telefono", "email", "propiedad", "consulta"],
  additionalProperties: false
};

// La regla de no inventar es la importante de todo esto: un teléfono
// inventado en un CRM es peor que un campo vacío — alguien lo va a marcar.
const INSTRUCCIONES = `Te paso el texto de un mail que le llegó a una inmobiliaria de San Luis, Argentina, desde un portal inmobiliario (ZonaProp, MercadoLibre, Argenprop) o directamente de una persona interesada.

Extraé los datos de quien hace la consulta.

Reglas:
- Usá ÚNICAMENTE lo que dice el mail. Si un dato no está, poné null. No lo deduzcas, no lo completes, no lo inventes.
- nombre: el de la persona interesada, no el del portal ni el de la inmobiliaria.
- telefono: tal como aparece en el mail, sin reformatear.
- email: el de la persona interesada. Si el mail viene de una casilla del portal (del tipo no-reply o similar), poné null.
- propiedad: cómo identifica el mail la propiedad consultada (título del aviso, código, dirección), copiado tal cual. No lo interpretes ni lo traduzcas.
- consulta: qué preguntó o pidió la persona, en una frase corta y en sus propios términos.`;

export async function onRequestPost(context) {
  const apiKey = context.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
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

  const mail = typeof cuerpo.mail === "string" ? cuerpo.mail.trim().slice(0, MAX_CARACTERES_MAIL) : "";
  if (!mail) {
    return json({ error: "Pegá el texto del mail antes de convertirlo." }, 400);
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
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: SCHEMA_LEAD }
        },
        system: INSTRUCCIONES,
        messages: [{ role: "user", content: mail }]
      })
    });
  } catch {
    return json({ error: "No se pudo contactar al servicio de IA." }, 502);
  }

  if (!respuesta.ok) {
    return json({ error: "El servicio de IA no pudo responder ahora. Probá de nuevo en un rato." }, 502);
  }

  const resultado = await respuesta.json();

  if (resultado.stop_reason === "refusal") {
    return json({ error: "El servicio de IA no pudo leer este mail." }, 502);
  }

  // El schema garantiza JSON válido, pero parsear sin red igual sería
  // confiar en que nada cambie nunca del otro lado.
  const texto = (resultado.content || []).find((b) => b.type === "text")?.text;
  let lead;
  try {
    lead = JSON.parse(texto);
  } catch {
    return json({ error: "No se entendió la respuesta del servicio de IA." }, 502);
  }

  // Un mail sin nombre ni teléfono ni mail no es un lead: es texto. Mejor
  // decirlo que abrir un formulario vacío y que parezca que se rompió.
  if (!lead.nombre && !lead.telefono && !lead.email) {
    return json({ error: "No se encontraron datos de contacto en ese texto." }, 422);
  }

  return json({ lead });
}
