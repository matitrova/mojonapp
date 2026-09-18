// La consulta que deja un comprador en la página pública de un lote
// (js/lote-publico.js) entra sola al CRM como un lead en "nuevo".
//
// POR QUÉ HACE FALTA UN ENDPOINT. Las reglas de Firestore exigen sesión
// para crear un contacto, y un comprador no tiene cuenta. Las dos
// salidas conocidas son habilitar el acceso anónimo de Firebase —que le
// abre a cualquiera con el link la puerta de escribir en la base— o
// poner la escritura de este lado. Se eligió esto: el navegador no
// escribe en Firestore, le pide a esta función que escriba, y acá se
// puede validar, frenar bots y cambiar de opinión sin tocar reglas.
//
// CON QUÉ IDENTIDAD ESCRIBE, que es la decisión que importa. NO con una
// service account de Google: esa clave saltea TODAS las reglas de
// Firestore, y si alguna vez se filtra se filtró la base entera. Escribe
// con una cuenta común de la app, creada para esto ("consultas web"),
// cuyo mail y contraseña viven como secrets de Cloudflare. O sea que
// esta función no puede hacer nada que esa cuenta no pueda hacer, las
// reglas se siguen aplicando igual que a cualquiera, y cada lead que
// entra por la web queda atribuido a ella en `creado_por`.
//
// La cuenta NO necesita ningún permiso: la regla de create en contactos
// pide solo sesión y que creado_por sea el propio uid (firestore.rules).

import { validarConsulta, pareceRobot, contactoDesdeConsulta } from "../js/consulta-lote.js";
import { configPara } from "../js/firebase-proyecto.js";

// EL PROYECTO SE ELIGE POR EL DOMINIO DEL PEDIDO, con la misma función
// que usa el navegador. Si estuviera fijo en "mojonapp", una consulta
// hecha en la vista previa —donde la app usa la base de pruebas— se
// guardaría en los datos reales del cliente: la app mostraría un lote de
// prueba y el lead terminaría en producción. Es justo el cruce que la
// lista de dominios existe para evitar; acá tiene que aplicarse igual.
function proyectoDelPedido(request) {
  const config = configPara(new URL(request.url).hostname);
  return {
    apiKey: config.apiKey,
    firestore: `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`
  };
}

// Tope de lo que se acepta leer del pedido. Sin esto, el tamaño del
// cuerpo lo decide quien postea.
const MAX_CUERPO = 8000;

function json(cuerpo, status = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// Firestore REST quiere los valores tipados uno por uno. Es verboso pero
// explícito, y evita la librería entera del SDK en un Worker.
function aValorFirestore(valor) {
  if (valor === null || valor === undefined) return { nullValue: null };
  if (typeof valor === "string") return { stringValue: valor };
  if (typeof valor === "number") return { integerValue: String(valor) };
  if (typeof valor === "boolean") return { booleanValue: valor };
  if (Array.isArray(valor)) {
    return { arrayValue: { values: valor.map(aValorFirestore) } };
  }
  return { mapValue: { fields: aCamposFirestore(valor) } };
}

function aCamposFirestore(objeto) {
  const campos = {};
  for (const [clave, valor] of Object.entries(objeto)) campos[clave] = aValorFirestore(valor);
  return campos;
}

// El token de la cuenta de servicio dura una hora. Se guarda en el
// módulo: un isolate de Cloudflare atiende varios pedidos seguidos, así
// que la mayoría se ahorra el login. No es un caché que haya que
// invalidar — si vence, el siguiente pedido saca uno nuevo.
// Se cachea POR PROYECTO: el mismo isolate puede atender pedidos de
// producción y de la vista previa, y devolver el token del proyecto
// equivocado escribiría el lead en la base equivocada.
const tokenCacheado = {};

async function tokenDeLaCuentaWeb(env, proyecto) {
  const ahora = Date.now();
  const guardado = tokenCacheado[proyecto.firestore];
  if (guardado && guardado.vence > ahora + 60_000) return guardado;

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${proyecto.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: env.CUENTA_WEB_EMAIL,
        password: env.CUENTA_WEB_PASSWORD,
        returnSecureToken: true
      })
    }
  );
  if (!resp.ok) return null;

  const datos = await resp.json();
  if (!datos.idToken || !datos.localId) return null;

  tokenCacheado[proyecto.firestore] = {
    idToken: datos.idToken,
    uid: datos.localId,
    vence: ahora + Number(datos.expiresIn || 3600) * 1000
  };
  return tokenCacheado[proyecto.firestore];
}

// El lote tiene que existir. Es la validación que el navegador no puede
// hacer: sin esto se pueden meter consultas contra ids inventados, que
// después aparecen en el CRM como leads interesados en nada.
//
// Se lee con el token de la cuenta, no sin sesión: así funciona igual si
// algún día los lotes dejan de ser de lectura pública.
async function tituloDelLote(loteId, idToken, proyecto) {
  const resp = await fetch(`${proyecto.firestore}/lotes/${encodeURIComponent(loteId)}`, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!resp.ok) return null;

  const campos = (await resp.json()).fields || {};
  const manzana = campos.manzana?.stringValue;
  const lote = campos.lote?.stringValue;
  if (!manzana && !lote) return "Lote";
  // Mismo texto que tituloLote en js/lotes-formato.js, para que el lead
  // se lea igual que los que se cargan desde la ficha.
  return `Manzana ${manzana || "?"} — Lote ${lote || "?"}`;
}

export async function onRequestPost(context) {
  const env = context.env;

  let cuerpo;
  try {
    const texto = (await context.request.text()).slice(0, MAX_CUERPO);
    cuerpo = JSON.parse(texto);
  } catch {
    return json({ error: "Pedido inválido." }, 400);
  }

  // El campo trampa se responde 200 A PROPÓSITO, sin guardar nada: a un
  // bot no se le explica que lo detectaste, porque entonces prueba otra
  // cosa. Para él la consulta "entró".
  if (pareceRobot(cuerpo)) return json({ ok: true });

  const validacion = validarConsulta(cuerpo);
  if (!validacion.ok) return json({ error: validacion.error }, 400);

  // La configuración se chequea DESPUÉS de leer y validar, no antes.
  // Cuesta lo mismo y hace que el endpoint se pueda probar de verdad
  // antes de que existan los secrets: sin esto, todo contesta 503 y no
  // hay forma de saber si el resto funciona hasta que ya está en
  // producción.
  if (!env.CUENTA_WEB_EMAIL || !env.CUENTA_WEB_PASSWORD) {
    return json({ error: "Las consultas web todavía no están configuradas." }, 503);
  }

  const proyecto = proyectoDelPedido(context.request);
  const cuenta = await tokenDeLaCuentaWeb(env, proyecto);
  if (!cuenta) {
    return json({ error: "No se pudo registrar la consulta. Probá por WhatsApp." }, 502);
  }

  const titulo = await tituloDelLote(validacion.consulta.loteId, cuenta.idToken, proyecto);
  if (!titulo) {
    return json({ error: "Ese lote ya no está publicado." }, 404);
  }

  const contacto = contactoDesdeConsulta(validacion.consulta, {
    creadoPor: cuenta.uid,
    tituloLote: titulo,
    ahora: new Date().toISOString()
  });

  const guardado = await fetch(`${proyecto.firestore}/contactos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cuenta.idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields: aCamposFirestore(contacto) })
  });

  if (!guardado.ok) {
    return json({ error: "No se pudo registrar la consulta. Probá por WhatsApp." }, 502);
  }

  return json({ ok: true });
}
