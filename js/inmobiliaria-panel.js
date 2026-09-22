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

function mostrarLogo(url) {
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
  mostrarLogo("");
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
    mostrarLogo(subida.url);
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

onRutaAplicada(async (ruta) => {
  if (ruta.clave !== "inmobiliaria") return;
  // Sincrónico y antes de cualquier await: si se esperara la lectura de
  // Firestore, entre el click y la respuesta no habría NINGUNA pantalla
  // visible — el router ya escondió todas.
  elPanel.classList.remove("oculto");
  elError.classList.add("oculto");
  elOk.classList.add("oculto");
  elLogoEstado.classList.add("oculto");
  llenarCon(getInmobiliaria());
  llenarCon(await recargarInmobiliaria());
});
