// ---------------------------------------------------------------------------
// Los datos de la inmobiliaria: qué es válido y cómo se muestra.
//
// POR QUÉ EXISTE ESTA PIEZA. Hasta ahora la app no sabía de quién era.
// El link que el corredor manda por WhatsApp diez veces por día abría
// una página anónima que arriba decía "MojonApp" — el nombre del
// software, no el del negocio — y su botón "Consultar por WhatsApp" se
// armaba SIN número de destino, así que abría el selector de contactos
// del comprador y la consulta podía no llegar nunca.
//
// Para la inmobiliaria eso es al revés de lo que compra: quiere que el
// link la muestre a ella.
//
// Módulo puro: sin Firestore ni DOM. La parte que habla con la base vive
// en js/inmobiliaria.js.
// ---------------------------------------------------------------------------

// Los campos que se guardan. La lista vive acá y no repartida por la
// pantalla y el guardado: agregar uno nuevo es tocar un solo lugar.
//
// "obligatorio" es solo el nombre, a propósito. Una inmobiliaria chica
// puede no tener web, ni horario fijo, ni matrícula a mano el día que
// configura esto; exigirle todo la deja sin poder guardar nada, y sin
// nombre es como si no hubiera configurado nada.
export const CAMPOS = [
  { clave: "nombre", etiqueta: "Nombre de la inmobiliaria", tipo: "text", obligatorio: true, ejemplo: "Inmobiliaria Los Algarrobos" },
  { clave: "telefono", etiqueta: "Teléfono / WhatsApp", tipo: "tel", ayuda: "Es el número al que le van a llegar las consultas de la página pública.", ejemplo: "266 4 55-8821" },
  { clave: "localidad", etiqueta: "Localidad", tipo: "text", ejemplo: "Merlo, San Luis" },
  { clave: "direccion", etiqueta: "Dirección", tipo: "text", ejemplo: "Av. del Sol 1240" },
  { clave: "horario", etiqueta: "Horario de atención", tipo: "text", ejemplo: "Lunes a viernes de 9 a 13 y de 17 a 20" },
  { clave: "email", etiqueta: "Email", tipo: "email", ejemplo: "contacto@ejemplo.com.ar" },
  { clave: "web", etiqueta: "Sitio web", tipo: "text", ejemplo: "www.ejemplo.com.ar" },
  { clave: "matricula", etiqueta: "Matrícula del corredor", tipo: "text", ayuda: "Se muestra en la página pública: es lo que distingue a una inmobiliaria registrada.", ejemplo: "CSI 1234" },
  { clave: "logo_url", etiqueta: "Logo", tipo: "logo" }
];

const CLAVES = CAMPOS.map((c) => c.clave);

// A propósito flojo, igual que en js/consulta-lote.js: validar mails con
// una expresión regular estricta rechaza direcciones raras pero
// perfectamente legales. Alcanza con descartar lo que evidentemente no
// es un mail.
const FORMA_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tope por campo. No es un capricho: sin tope, el largo de lo que se
// guarda —y de lo que después se dibuja en la página del comprador— lo
// decide quien escribe en el formulario.
const MAX_TEXTO = 120;
const MAX_HORARIO = 200;

function texto(valor) {
  return typeof valor === "string" ? valor.trim() : "";
}

/**
 * Deja los datos listos para guardar, o dice qué está mal.
 *
 * Devuelve { ok: true, datos } o { ok: false, error }. El error es el
 * texto que se le muestra a la persona, así que dice qué hacer.
 */
export function validarInmobiliaria(entrada) {
  const crudo = entrada || {};
  const datos = {};

  const nombre = texto(crudo.nombre);
  if (!nombre) {
    return { ok: false, error: "Poné el nombre de la inmobiliaria: es lo que va a ver el comprador." };
  }
  if (nombre.length > MAX_TEXTO) {
    return { ok: false, error: `El nombre no puede pasar los ${MAX_TEXTO} caracteres.` };
  }
  datos.nombre = nombre;

  const telefono = texto(crudo.telefono);
  if (telefono && !/\d/.test(telefono)) {
    return { ok: false, error: "Ese teléfono no parece un número." };
  }
  if (telefono.length > 40) {
    return { ok: false, error: "El teléfono no puede pasar los 40 caracteres." };
  }
  datos.telefono = telefono || null;

  const email = texto(crudo.email);
  if (email && !FORMA_EMAIL.test(email)) {
    return { ok: false, error: "Revisá el email, parece que tiene algo mal." };
  }
  datos.email = email || null;

  // La web se normaliza en vez de rechazarse: nadie escribe "https://"
  // cuando le preguntan por su sitio, y un link sin esquema es un link
  // roto (el navegador lo trata como una ruta relativa de la app).
  const web = texto(crudo.web);
  datos.web = web ? (/^https?:\/\//i.test(web) ? web : `https://${web}`) : null;

  for (const clave of ["localidad", "direccion", "matricula"]) {
    const valor = texto(crudo[clave]);
    if (valor.length > MAX_TEXTO) {
      return { ok: false, error: `El campo "${clave}" no puede pasar los ${MAX_TEXTO} caracteres.` };
    }
    datos[clave] = valor || null;
  }

  const horario = texto(crudo.horario);
  if (horario.length > MAX_HORARIO) {
    return { ok: false, error: `El horario no puede pasar los ${MAX_HORARIO} caracteres.` };
  }
  datos.horario = horario || null;

  const logo = texto(crudo.logo_url);
  datos.logo_url = logo || null;

  return { ok: true, datos };
}

/**
 * Lo que viene de la base, limpio y con solo las claves conocidas.
 *
 * Se filtra al LEER y no solo al escribir: un documento editado a mano
 * en la consola de Firebase, o de una versión anterior con otros
 * campos, no tiene por qué romper la página que ve un comprador.
 */
export function normalizarInmobiliaria(documento) {
  if (!documento || typeof documento !== "object") return null;
  const datos = {};
  for (const clave of CLAVES) {
    const valor = documento[clave];
    datos[clave] = typeof valor === "string" && valor.trim() ? valor.trim() : null;
  }
  // Sin nombre no hay identidad que mostrar: se trata como "todavía no
  // configuraron esto", que es distinto de "hay datos a medias".
  return datos.nombre ? datos : null;
}

/**
 * El nombre para la pestaña del navegador y los títulos.
 *
 * Cae a "MojonApp" cuando no hay nada cargado — es mejor que una
 * pestaña sin nombre, pero es justamente lo que esta pantalla existe
 * para reemplazar.
 */
export function nombreParaMostrar(inmobiliaria) {
  return inmobiliaria?.nombre || "MojonApp";
}

/**
 * Una línea con dónde queda, para el pie de la página pública.
 *
 * Arma solo con lo que hay: sin dirección ni localidad devuelve null y
 * quien dibuja no pone la línea, en vez de mostrar comas sueltas.
 */
export function comoUbicarla(inmobiliaria) {
  if (!inmobiliaria) return null;
  const partes = [inmobiliaria.direccion, inmobiliaria.localidad].filter(Boolean);
  return partes.length > 0 ? partes.join(" · ") : null;
}

/**
 * ¿Está configurada lo suficiente como para que el botón de WhatsApp
 * tenga sentido?
 *
 * Sin teléfono, ese botón abre el selector de contactos del comprador y
 * la consulta se pierde — es peor que no mostrarlo.
 */
export function puedeRecibirWhatsapp(inmobiliaria) {
  return !!(inmobiliaria && inmobiliaria.telefono && /\d/.test(inmobiliaria.telefono));
}
