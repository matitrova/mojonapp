// ---------------------------------------------------------------------------
// Las reglas de qué es una consulta válida de un comprador.
//
// POR QUÉ ESTÁ SEPARADO. Lo usan los dos extremos: el navegador, para no
// mandar algo que va a rebotar, y functions/consulta-lote.js, para no
// creerle al navegador. Si cada lado tuviera su copia, con el tiempo
// dirían cosas distintas y el que manda es el del servidor — o sea que
// el formulario empezaría a aceptar cosas que después fallan, sin que
// nadie se entere hasta que un lead se pierde.
//
// LA VALIDACIÓN DEL SERVIDOR NO ES UNA COMODIDAD, ES LA ÚNICA QUE VALE.
// Este endpoint es público a propósito (un comprador no tiene cuenta),
// así que cualquiera puede postearle lo que quiera sin pasar por el
// formulario. Todo lo que se asume acá tiene que chequearse de nuevo del
// otro lado.
//
// Sin dependencias a propósito: corre igual en el navegador y en una
// Pages Function de Cloudflare.
// ---------------------------------------------------------------------------

// Topes. No son caprichos: sin tope, el tamaño de lo que se guarda en la
// base lo decide quien postea, y un solo pedido puede dejar un documento
// de megabytes en el CRM.
export const MAX_NOMBRE = 80;
export const MAX_TELEFONO = 30;
export const MAX_EMAIL = 120;
export const MAX_MENSAJE = 500;

// Un id de documento de Firestore. Se chequea la FORMA, no que exista:
// que exista lo pregunta el servidor, que es el único que puede.
const FORMA_ID = /^[A-Za-z0-9_-]{1,128}$/;

// A propósito flojo: validar mails "de verdad" con una expresión regular
// es una trampa conocida (rechaza direcciones válidas raras pero
// perfectamente legales). Acá el email es OPCIONAL y el teléfono es el
// dato que se usa, así que alcanza con descartar lo que evidentemente no
// es un mail y no pelearse con el resto.
const FORMA_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function texto(valor) {
  return typeof valor === "string" ? valor.trim() : "";
}

/**
 * Deja la consulta lista para guardar, o dice qué le falta.
 *
 * Devuelve { ok: true, consulta } o { ok: false, error } — el error es
 * el texto que se le muestra a la persona, así que dice qué hacer y no
 * qué falló por dentro.
 */
export function validarConsulta(datos) {
  const entrada = datos || {};

  const loteId = texto(entrada.loteId);
  if (!FORMA_ID.test(loteId)) {
    return { ok: false, error: "No se pudo identificar el lote de la consulta." };
  }

  const nombre = texto(entrada.nombre);
  if (!nombre) return { ok: false, error: "Poné tu nombre así sabemos con quién hablamos." };
  if (nombre.length > MAX_NOMBRE) {
    return { ok: false, error: `El nombre no puede pasar los ${MAX_NOMBRE} caracteres.` };
  }

  const telefono = texto(entrada.telefono);
  if (!telefono) return { ok: false, error: "Dejá un teléfono para que te podamos contactar." };
  if (telefono.length > MAX_TELEFONO) {
    return { ok: false, error: `El teléfono no puede pasar los ${MAX_TELEFONO} caracteres.` };
  }
  // Un teléfono sin un solo dígito no es un teléfono. No se valida el
  // formato: en Argentina conviven +54 9 266..., 0266 15..., 266..., y
  // exigir uno solo es la forma segura de perder consultas reales.
  if (!/\d/.test(telefono)) {
    return { ok: false, error: "Ese teléfono no parece un número." };
  }

  const email = texto(entrada.email);
  if (email && (email.length > MAX_EMAIL || !FORMA_EMAIL.test(email))) {
    return { ok: false, error: "Revisá el email, parece que tiene algo mal." };
  }

  const mensaje = texto(entrada.mensaje);
  if (mensaje.length > MAX_MENSAJE) {
    return { ok: false, error: `El mensaje no puede pasar los ${MAX_MENSAJE} caracteres.` };
  }

  return { ok: true, consulta: { loteId, nombre, telefono, email, mensaje } };
}

/**
 * ¿La llenó un robot?
 *
 * El campo trampa está escondido por CSS y sin etiqueta: una persona no
 * lo ve y no lo puede completar. Los bots que rellenan formularios leen
 * el HTML y completan todo lo que encuentran, así que un valor acá es la
 * firma de uno.
 *
 * NO ES UNA DEFENSA FUERTE y no hay que tratarla como tal: un bot hecho
 * para este sitio la esquiva mirando el CSS. Frena el spam automático
 * genérico, que es la mayor parte, y no le cuesta nada a nadie. El
 * límite por IP es otra cosa y va en el panel de Cloudflare.
 */
export function pareceRobot(datos) {
  return texto((datos || {}).apellido) !== "";
}

/**
 * Cómo queda la consulta convertida en contacto del CRM.
 *
 * EL SHAPE TIENE QUE SER EL MISMO que arma crearContactoDesdeInteresado
 * en js/crm-datos.js, no uno parecido: `lotes_interes` son objetos
 * {id, titulo} y no ids sueltos, y `actividades` es la lista que el CRM
 * dibuja como historial. Un contacto con la forma equivocada no falla al
 * guardarse — se guarda igual y después se ve roto en el tablero, que es
 * bastante peor.
 *
 * ENTRA EN "nuevo", la primera columna del Kanban, igual que cualquier
 * lead. No se inventa un estado aparte para los de la web: habría que
 * enseñarle esa etapa al embudo, al tablero y a las métricas, y un lead
 * que no está en el embudo es un lead que nadie mira.
 *
 * `origen: "web"` es lo que después permite distinguirlos de un vistazo
 * —y encontrar spam, si alguna vez entra— sin sacarlos del circuito.
 *
 * `asignado_a: null` a propósito: el que escribe es una cuenta de
 * servicio, no una persona, y asignarle el lead lo dejaría a nombre de
 * nadie. Queda "Sin asignar", que el CRM ya sabe mostrar, y lo agarra
 * quien lo atienda. El reparto automático (siguienteAsignado) no se
 * puede hacer acá: necesita leer toda la cartera, que es justo el
 * barrido que este proyecto sacó por costo.
 */
export function contactoDesdeConsulta(consulta, { creadoPor, tituloLote, ahora }) {
  const nota = [consulta.mensaje, consulta.email ? `Email: ${consulta.email}` : null]
    .filter(Boolean)
    .join(" · ");

  return {
    nombre: consulta.nombre,
    telefono: consulta.telefono,
    email: consulta.email || null,
    estado: "nuevo",
    motivo_perdido: null,
    proximo_seguimiento: null,
    lotes_interes: [{ id: consulta.loteId, titulo: tituloLote }],
    actividades: [
      {
        tipo: "nota",
        texto: nota || `Consultó por ${tituloLote} desde la página.`,
        fecha: ahora,
        autor_email: null
      }
    ],
    asignado_a: null,
    creado_por: creadoPor,
    origen: "web",
    fecha_creacion: ahora,
    fecha_actualizacion: ahora
  };
}
