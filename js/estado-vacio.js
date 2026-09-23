// ---------------------------------------------------------------------------
// Qué mostrar cuando una pantalla no tiene nada que mostrar.
//
// POR QUÉ ES UNA PIEZA PROPIA Y NO UN PÁRRAFO EN CADA PANTALLA. Con la
// base recién creada —o recién vaciada— el mapa, la lista y el dashboard
// quedan en blanco los tres al mismo tiempo, y es justo el primer momento
// de alguien que abre la app por primera vez. Un "no hay datos" suelto
// deja al corredor sin saber qué hacer, y a un visitante sin saber si la
// app está rota.
//
// LAS DOS PREGUNTAS QUE DECIDEN QUÉ SE MUESTRA, que no son la misma
// (ver el comentario de contenidoVacio, que cuenta cómo se confundieron):
//
//   - ¿Hay sesión? Decide el TEXTO. A un visitante se le habla del
//     catálogo ("cuando la inmobiliaria cargue su cartera"), al corredor
//     de su trabajo ("todavía no cargaste ningún lote").
//   - ¿Puede cargar lotes? Decide los BOTONES. Ofrecer cargar a quien no
//     tiene el permiso es prometerle algo que las reglas de Firestore van
//     a rechazar.
//
// Los botones son los MISMOS del menú: se les delega el click en vez de
// copiar su lógica.
//
// El texto vive acá y no en el HTML porque cambia según quién mira y se
// usa en tres lugares. Separado y sin efectos, se puede afirmar en un
// test que a un visitante nunca se le ofrece cargar.
// ---------------------------------------------------------------------------

// Las dos maneras de cargar lotes que ya existen en el menú. Se
// referencian por id para delegarles el click: si mañana cambia cómo
// funciona la carga, cambia en un solo lugar y esto lo sigue.
const ACCION_CATASTRO = { texto: "Traer del catastro", botonId: "btn-abrir-manzana" };
const ACCION_A_MANO = { texto: "Cargar uno a mano", botonId: "btn-cargar-lote" };

// Los cuatro catálogos se abren solo desde el menú, que ya exige sesión
// y permiso: no existe el caso "visitante". Se repite el mismo texto en
// las dos ramas en vez de enseñarle a contenidoVacio un caso especial
// que ninguna otra pantalla necesita — la distinción con/sin sesión es
// el corazón de este módulo y no conviene diluirla por esto.
function siempreIgual(titulo, texto) {
  return { conSesion: { titulo, texto }, sinSesion: { titulo, texto } };
}

const TEXTOS = {
  mapa: {
    conSesion: {
      titulo: "El mapa todavía no tiene lotes",
      texto:
        "Traelos del catastro por nomenclatura y quedan dibujados con su forma real, " +
        "o carga uno a mano si lo vas a dibujar vos."
    },
    sinSesion: {
      titulo: "Todavía no hay lotes publicados",
      texto: "Cuando la inmobiliaria cargue su cartera, los vas a ver acá sobre el mapa."
    }
  },
  lista: {
    conSesion: {
      titulo: "Todavía no cargaste ningún lote",
      texto:
        "La lista es para administrar la cartera: precio, zona, servicios y estado de cada lote. " +
        "Empezá por traerlos del catastro."
    },
    sinSesion: {
      titulo: "Todavía no hay lotes publicados",
      texto: "Cuando haya lotes en venta, van a aparecer en esta lista."
    }
  },
  dashboard: {
    conSesion: {
      titulo: "Todavía no hay métricas que mostrar",
      texto:
        "El dashboard resume la cartera y el pipeline de contactos. En cuanto tengas lotes cargados, " +
        "acá vas a ver el inventario, y con contactos, la conversión."
    },
    sinSesion: {
      titulo: "Todavía no hay métricas que mostrar",
      texto: "Esta pantalla es para la inmobiliaria."
    }
  },
  // Las claves de los catálogos son el `plural` de crearPanelCatalogo
  // (js/catalogos.js), que es lo que ese módulo pasa como `pantalla`.
  // El texto dice PARA QUÉ sirve el catálogo: con la lista vacía, quien
  // entra por primera vez no tiene de dónde deducirlo.
  sectores: siempreIgual(
    "Todavía no cargaste ninguna zona",
    "Las zonas son los nombres con los que agrupás los lotes por área (Zona Norte, Cerro de Oro). " +
      "Al cargar o editar un lote se eligen de esta lista, para que no invente cada uno su propia variante del mismo nombre."
  ),
  barrios: siempreIgual(
    "Todavía no cargaste ningún barrio",
    "El barrio es la otra manera de ubicar un lote, independiente de la zona (Las Vertientes, El Trapiche): " +
      "un lote tiene zona Y barrio a la vez, y los dos se eligen de su lista al cargarlo o editarlo."
  ),
  motivos: siempreIgual(
    "Todavía no cargaste ningún motivo de pérdida",
    "Es por qué se cayó una oportunidad (Precio, Financiación, Compró en otro lado). Se elige al marcar " +
      "un contacto como perdido, y el Dashboard los cuenta agrupados para ver qué se repite."
  ),
  "etiquetas-crm": siempreIgual(
    "Todavía no cargaste ninguna etiqueta",
    "Las etiquetas marcan contactos para encontrarlos después (Urgente, Referido, Inversor). " +
      "Se ponen en la ficha del contacto y filtran el pipeline del CRM."
  )
};

/**
 * SON DOS PREGUNTAS DISTINTAS, Y CONFUNDIRLAS SE VIO EN PRODUCCIÓN.
 *
 * "¿Hay sesión?" decide el TEXTO: a un visitante se le habla del
 * catálogo, a un corredor de su cartera.
 *
 * "¿Puede cargar lotes?" decide los BOTONES, y no es lo mismo: una
 * cuenta puede tener sesión y no tener permiso de carga. Pasa de verdad
 * con un corredor recién creado al que todavía no le asignaron perfil —
 * getMiPerfil() devuelve null y tienePermiso() da false para todo. Con
 * la condición puesta en la sesión, esa cuenta veía "Traer del catastro"
 * y al tocarlo Firestore la rechazaba.
 *
 * @param pantalla "mapa" | "lista" | "dashboard"
 * @param conSesion si hay alguien logueado (decide el texto)
 * @param puedeCargar si ese alguien tiene permiso de cargar lotes
 *        (decide los botones; ver tienePermiso en js/permisos.js)
 * @returns {titulo, texto, acciones}
 */
export function contenidoVacio({ pantalla, conSesion, puedeCargar = false }) {
  const textos = TEXTOS[pantalla];
  if (!textos) throw new Error(`No hay texto de vacío para la pantalla "${pantalla}"`);
  const elegido = conSesion ? textos.conSesion : textos.sinSesion;
  return {
    titulo: elegido.titulo,
    texto: elegido.texto,
    // El dashboard no ofrece cargar ni a quien puede: no es la pantalla
    // donde se carga, y mandar a alguien al mapa desde acá agrega un
    // salto en vez de sacarlo. Mapa y lista sí, que es donde se trabaja
    // la cartera.
    acciones: puedeCargar && pantalla !== "dashboard" ? [ACCION_CATASTRO, ACCION_A_MANO] : []
  };
}

/**
 * Pinta el estado vacío dentro de un contenedor.
 *
 * Los botones no reimplementan nada: le mandan el click al botón del
 * menú que ya sabe hacer esa carga. Si ese botón no existe (por permisos
 * o porque cambió de nombre), no se dibuja — antes que ofrecer algo que
 * al tocarlo no hace nada.
 */
export function pintarEstadoVacio(contenedor, { pantalla, conSesion, puedeCargar = false }) {
  const { titulo, texto, acciones } = contenidoVacio({ pantalla, conSesion, puedeCargar });
  contenedor.innerHTML = "";

  const elTitulo = document.createElement("p");
  elTitulo.className = "vacio-titulo";
  elTitulo.textContent = titulo;
  contenedor.appendChild(elTitulo);

  const elTexto = document.createElement("p");
  elTexto.className = "vacio-texto";
  elTexto.textContent = texto;
  contenedor.appendChild(elTexto);

  const disponibles = acciones.filter((accion) => document.getElementById(accion.botonId));
  if (disponibles.length === 0) return;

  const fila = document.createElement("div");
  fila.className = "vacio-acciones";
  for (const accion of disponibles) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "vacio-boton";
    boton.textContent = accion.texto;
    boton.dataset.vacioAccion = accion.botonId;
    boton.addEventListener("click", () => document.getElementById(accion.botonId).click());
    fila.appendChild(boton);
  }
  contenedor.appendChild(fila);
}
