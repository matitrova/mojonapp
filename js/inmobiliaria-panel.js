// ---------------------------------------------------------------------------
// Pantalla "Datos de la inmobiliaria" (#panel-inmobiliaria).
//
// Un solo formulario, sin lista: no hay varias agencias. Por eso NO usa
// la fábrica de js/catalogos.js, que está armada para el par
// lista/formulario de los catálogos.
//
// LOS CAMPOS SE DIBUJAN DESDE CAMPOS (js/inmobiliaria-datos.js) y no
// están escritos a mano en index.html. Es la misma lista que valida el
// guardado, así que un campo nuevo es una línea en un solo archivo, y no
// existe el caso "está en el HTML pero el guardado lo ignora" — que es
// justamente cómo se pierde un dato sin que nadie se entere.
// ---------------------------------------------------------------------------

import { CAMPOS, validarInmobiliaria } from "./inmobiliaria-datos.js";
import { recargarInmobiliaria, getInmobiliaria, guardarInmobiliaria } from "./inmobiliaria.js";
import { subirFotoACloudinary } from "./ficha.js";
import { registrarAuditoria } from "./auditoria.js";
import { onRutaAplicada } from "./router.js";

const elFormulario = document.getElementById("formulario-inmobiliaria");
const elCampos = document.getElementById("inmobiliaria-campos");
const elError = document.getElementById("inmobiliaria-error");
const elOk = document.getElementById("inmobiliaria-ok");
const elGuardar = document.getElementById("inmobiliaria-guardar");

const elLogoUrl = document.getElementById("inmobiliaria-logo_url");
const elLogoPreview = document.getElementById("inmobiliaria-logo-preview");
const elLogoVacio = document.getElementById("inmobiliaria-logo-vacio");
const elLogoSubir = document.getElementById("inmobiliaria-logo-subir");
const elLogoQuitar = document.getElementById("inmobiliaria-logo-quitar");
const elLogoInput = document.getElementById("inmobiliaria-logo-input");
const elLogoEstado = document.getElementById("inmobiliaria-logo-estado");

// El logo no es un campo de texto: se maneja aparte, con su propio
// bloque en el HTML.
const CAMPOS_DE_TEXTO = CAMPOS.filter((c) => c.tipo !== "logo");

function idDe(campo) {
  return `inmobiliaria-${campo.clave}`;
}

// Cada campo se arma con createElement y textContent —  no con
// innerHTML de un template con los valores interpolados. Los valores son
// texto que escribió una persona y termina también en la página pública;
// que no pueda contener markup se decide acá, de una vez.
function dibujarCampos() {
  elCampos.innerHTML = "";
  for (const campo of CAMPOS_DE_TEXTO) {
    const label = document.createElement("label");
    label.append(campo.etiqueta + (campo.obligatorio ? "" : " (opcional)"));

    if (campo.ayuda) {
      const ayuda = document.createElement("span");
      ayuda.className = "campo-ayuda";
      ayuda.textContent = campo.ayuda;
      label.appendChild(ayuda);
    }

    const input = document.createElement("input");
    input.type = campo.tipo;
    input.id = idDe(campo);
    input.dataset.testid = idDe(campo);
    if (campo.ejemplo) input.placeholder = `Ej: ${campo.ejemplo}`;
    // "required" solo en el nombre: el resto se puede completar después,
    // y un formulario que no deja guardar nada hasta tenerlo todo se
    // abandona a la mitad.
    if (campo.obligatorio) input.required = true;
    label.appendChild(input);

    elCampos.appendChild(label);
  }
}

// tocado: lo marca cuando el cambio lo pidió la persona (subir o quitar
// el logo), no cuando es la pantalla llenándose sola. Sin esto, una
// lectura tardía le devolvería el logo que acaba de quitar.
function mostrarLogo(url, tocado = false) {
  if (tocado) formularioTocado = true;
  elLogoUrl.value = url || "";
  const hay = !!url;
  if (hay) elLogoPreview.src = url;
  elLogoPreview.classList.toggle("oculto", !hay);
  elLogoVacio.classList.toggle("oculto", hay);
  elLogoQuitar.classList.toggle("oculto", !hay);
  elLogoSubir.textContent = hay ? "Cambiar logo" : "Subir logo";
}

function llenarCon(datos) {
  for (const campo of CAMPOS_DE_TEXTO) {
    const input = document.getElementById(idDe(campo));
    if (input) input.value = datos?.[campo.clave] || "";
  }
  mostrarLogo(datos?.logo_url || "");
}

// ¿La persona ya escribió algo desde que se abrió la pantalla?
//
// EXISTE POR UN BUG QUE SE VEÍA COMO UN ÉXITO. Al entrar, el formulario
// se llena dos veces: primero con lo que ya estaba cacheado y después
// con lo recién leído de Firestore. Si esa segunda lectura volvía
// DESPUÉS de que empezaste a escribir, te pisaba lo escrito con el
// valor guardado — y al apretar Guardar se guardaba el valor viejo, con
// el cartel de "Listo, guardado" arriba. Nada parecía fallar.
//
// Con esto, una lectura que llega tarde no toca un formulario que ya
// está en uso: ganó la persona, no la red.
let formularioTocado = false;

// En el contenedor y no en cada input: los campos se dibujan solos desde
// CAMPOS, así que un campo nuevo queda cubierto sin acordarse de nada.
elCampos.addEventListener("input", () => {
  formularioTocado = true;
});

function leerDelFormulario() {
  const datos = {};
  for (const campo of CAMPOS_DE_TEXTO) {
    datos[campo.clave] = document.getElementById(idDe(campo))?.value || "";
  }
  datos.logo_url = elLogoUrl.value;
  return datos;
}

function mostrarError(texto) {
  elOk.classList.add("oculto");
  elError.textContent = texto;
  elError.classList.remove("oculto");
}

// ---------------------------------------------------------------------------
// El logo
// ---------------------------------------------------------------------------

elLogoSubir.addEventListener("click", () => elLogoInput.click());

// Quitar el logo NO guarda sola: deja el formulario sin logo y el cambio
// recién se aplica al apretar Guardar, igual que los demás campos. Un
// borrado que se aplica de una es el que después nadie sabe deshacer.
elLogoQuitar.addEventListener("click", () => {
  mostrarLogo("", true);
  elLogoEstado.classList.add("oculto");
});

elLogoInput.addEventListener("change", async () => {
  const archivo = elLogoInput.files?.[0];
  if (!archivo) return;
  elLogoEstado.textContent = "Subiendo el logo…";
  elLogoEstado.classList.remove("oculto");
  elLogoSubir.disabled = true;
  try {
    // Misma subida que las fotos de un lote (js/ficha.js): un solo
    // camino a Cloudinary, con su preset y su manejo de errores.
    const subida = await subirFotoACloudinary(archivo);
    mostrarLogo(subida.url, true);
    elLogoEstado.textContent = "Logo listo. Acordate de guardar.";
  } catch (error) {
    elLogoEstado.textContent = `No se pudo subir el logo: ${error.message}`;
  } finally {
    elLogoSubir.disabled = false;
    // Sin esto, elegir el MISMO archivo dos veces seguidas (típico
    // después de un error) no dispara "change" y parece que el botón
    // dejó de andar.
    elLogoInput.value = "";
  }
});

// ---------------------------------------------------------------------------
// Guardar
// ---------------------------------------------------------------------------

elFormulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  elError.classList.add("oculto");
  elOk.classList.add("oculto");

  const revision = validarInmobiliaria(leerDelFormulario());
  if (!revision.ok) {
    mostrarError(revision.error);
    return;
  }

  elGuardar.disabled = true;
  try {
    await guardarInmobiliaria(revision.datos);
    registrarAuditoria({
      accion: "editar_inmobiliaria",
      objetoId: "inmobiliaria",
      objetoTitulo: revision.datos.nombre
    });
    // Lo que se guardó, releído: si la validación normalizó algo (la web
    // sin https://, por ejemplo) el formulario muestra lo que quedó
    // guardado de verdad, no lo que se tipeó.
    llenarCon(getInmobiliaria());
    formularioTocado = false;
    elOk.classList.remove("oculto");
  } catch (error) {
    mostrarError(
      error.code === "permission-denied"
        ? "Solo el usuario principal puede cambiar los datos de la inmobiliaria."
        : "No se pudieron guardar los datos. Probá de nuevo."
    );
  } finally {
    elGuardar.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Entrada a la pantalla
// ---------------------------------------------------------------------------

dibujarCampos();

// ABRIR EL PANEL ES RESPONSABILIDAD DE ACÁ, no del router: el router
// esconde TODAS las pantallas grandes y después avisa, y quien sabe
// abrir la suya es cada módulo (ver el comentario de aplicarEstado en
// js/router.js). Los catálogos lo hacen en el click de su botón; acá se
// hace en el aviso del router, que cubre los tres caminos por igual —
// click en el menú, URL directa y "atrás" del navegador.
//
// Y se llena al ENTRAR, no una sola vez al arrancar: si alguien guardó
// desde otra sesión, o si la lectura todavía no había vuelto cuando se
// cargó la app, entrar a la pantalla tiene que mostrar lo que hay.
const elPanel = document.getElementById("panel-inmobiliaria");
let entradaActual = 0;

// ¿Ya estábamos en esta pantalla la vez anterior que avisó el router?
//
// EL ROUTER AVISA MÁS DE UNA VEZ POR LA MISMA PANTALLA. app.js aplica la
// ruta al arrancar (js/app.js:324) y otra vez cuando resuelve la sesión
// (js/app.js:561), porque las pantallas con permisos no se pueden
// decidir antes de saber quién sos. Las dos pasadas caen sobre la misma
// ruta, y la segunda llega cuando ya se está usando la pantalla.
//
// Sin este guardia, esa segunda pasada volvía a llenar el formulario y
// borraba lo que la persona estaba escribiendo. Era el mecanismo real
// detrás del bug de "guardé y quedó el valor viejo".
let estabaAdentro = false;

onRutaAplicada(async (ruta) => {
  if (ruta.clave !== "inmobiliaria") {
    estabaAdentro = false;
    return;
  }

  // Sincrónico y antes de cualquier await: si se esperara la lectura de
  // Firestore, entre el click y la respuesta no habría NINGUNA pantalla
  // visible — el router ya escondió todas. Esto sí se hace siempre: la
  // pasada que no entra igual escondió el panel y hay que volver a
  // mostrarlo.
  elPanel.classList.remove("oculto");

  // Ya estábamos acá: no es una entrada, es el router pasando de nuevo
  // por la misma pantalla. No se toca nada de lo que hay en el
  // formulario.
  if (estabaAdentro) return;
  estabaAdentro = true;

  elError.classList.add("oculto");
  elOk.classList.add("oculto");
  elLogoEstado.classList.add("oculto");
  formularioTocado = false;
  llenarCon(getInmobiliaria());

  // Cada entrada a la pantalla tiene su propio número. Si se entró, se
  // salió y se volvió a entrar mientras la lectura viajaba, la respuesta
  // vieja llega con un número que ya no corre y se descarta — si no,
  // pisaría el formulario de la visita nueva.
  //
  // Y formularioTocado cubre el otro lado: la lectura que vuelve cuando
  // la persona ya empezó a escribir. Son dos carreras distintas.
  const miEntrada = ++entradaActual;
  const frescos = await recargarInmobiliaria();
  if (miEntrada !== entradaActual || formularioTocado) return;
  llenarCon(frescos);
});
