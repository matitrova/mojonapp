"""
Tests de los estados vacíos (js/estado-vacio.js).

POR QUÉ IMPORTAN. Con la base recién creada —o recién vaciada— el mapa,
la lista y el dashboard quedan en blanco los tres a la vez, y es el
primer momento de alguien que abre la app. Antes no había ningún mensaje
en el mapa: se veía una foto satelital sin nada y no había forma de
distinguir "todavía no cargaste" de "la app falló".

Lo que se afirma acá, en orden de importancia:

  1. A un visitante SIN sesión nunca se le ofrece cargar lotes. Es un
     botón que no podría usar (las reglas de Firestore lo rechazarían) y
     prometerlo es mentirle.
  2. El corredor sí recibe las dos formas reales de cargar.
  3. Los botones apuntan a botones del menú que EXISTEN — si el id
     estuviera mal escrito, el botón no haría nada al tocarlo.
"""

import pytest
from playwright.sync_api import expect

PANTALLAS = ["mapa", "lista", "dashboard"]


def _contenido(page, base_url, pantalla, con_sesion):
    page.goto(base_url)
    return page.evaluate(
        """([pantalla, conSesion]) => import('/js/estado-vacio.js')
             .then((m) => m.contenidoVacio({ pantalla, conSesion }))""",
        [pantalla, con_sesion],
    )


@pytest.mark.parametrize("pantalla", PANTALLAS)
def test_sin_sesion_nunca_se_ofrece_cargar(page, base_url, pantalla):
    """El test más importante del archivo.

    Un visitante no puede crear lotes, así que ninguna de las tres
    pantallas puede ofrecerle un botón de carga.
    """
    contenido = _contenido(page, base_url, pantalla, False)
    assert contenido["acciones"] == [], f"{pantalla} le ofrece cargar a un visitante"
    assert contenido["titulo"]
    assert contenido["texto"]


@pytest.mark.parametrize("pantalla", ["mapa", "lista"])
def test_con_sesion_hay_dos_formas_de_cargar(page, base_url, pantalla):
    contenido = _contenido(page, base_url, pantalla, True)
    ids = [accion["botonId"] for accion in contenido["acciones"]]
    assert ids == ["btn-abrir-manzana", "btn-cargar-lote"], f"{pantalla} ofrece {ids}"


def test_el_dashboard_no_ofrece_cargar_ni_con_sesion(page, base_url):
    """No es la pantalla donde se carga: mandar al mapa desde acá agrega
    un salto en vez de sacarlo."""
    assert _contenido(page, base_url, "dashboard", True)["acciones"] == []


def test_los_botones_que_se_ofrecen_existen_en_la_pantalla(page, base_url):
    """Un id mal escrito daría un botón que al tocarlo no hace nada.

    Se verifica contra el HTML real, no contra una lista escrita en el
    test: si mañana el menú renombra esos botones, esto se pone en rojo.
    """
    page.goto(base_url)
    faltantes = page.evaluate(
        """() => import('/js/estado-vacio.js').then((m) => {
             const ids = new Set();
             for (const pantalla of ['mapa', 'lista', 'dashboard']) {
               for (const accion of m.contenidoVacio({ pantalla, conSesion: true }).acciones) {
                 ids.add(accion.botonId);
               }
             }
             return [...ids].filter((id) => !document.getElementById(id));
           })"""
    )
    assert faltantes == [], f"estos botones no existen en index.html: {faltantes}"


def test_una_pantalla_sin_texto_falla_fuerte(page, base_url):
    """Pedir el vacío de una pantalla que no tiene texto tira error.

    Es a propósito: si alguien suma una pantalla y se olvida del texto,
    tiene que enterarse, no quedarse con un cartel en blanco.
    """
    page.goto(base_url)
    error = page.evaluate(
        """() => import('/js/estado-vacio.js')
             .then((m) => { try { m.contenidoVacio({ pantalla: 'inventada', conSesion: true }); return null; }
                            catch (e) { return e.message; } })"""
    )
    assert error is not None and "inventada" in error


def test_el_boton_del_cartel_dispara_el_del_menu(page, base_url):
    """Que el cartel se dibuje no prueba que sus botones sirvan.

    Este test no depende de que la base esté vacía: pinta el cartel a
    mano en la pantalla y confirma que tocar "Traer del catastro"
    efectivamente le manda el click al botón del menú. Es la parte que
    podría romperse en silencio, porque un id mal escrito da un botón
    lindo que no hace nada.

    El listener se pone en fase de captura y corta la propagación: se
    verifica que el click LLEGA, sin ejecutar de verdad la apertura del
    panel de catastro.
    """
    page.goto(base_url)
    llego = page.evaluate(
        """async () => {
             const m = await import('/js/estado-vacio.js');
             const contenedor = document.getElementById('mapa-vacio');
             m.pintarEstadoVacio(contenedor, { pantalla: 'mapa', conSesion: true });
             const real = document.getElementById('btn-abrir-manzana');
             let llamado = false;
             const espia = (evento) => { llamado = true; evento.stopPropagation(); evento.preventDefault(); };
             real.addEventListener('click', espia, { capture: true });
             contenedor.querySelector('[data-vacio-accion="btn-abrir-manzana"]').click();
             real.removeEventListener('click', espia, { capture: true });
             return {
               llamado,
               botones: [...contenedor.querySelectorAll('.vacio-boton')].map((b) => b.textContent),
               titulo: contenedor.querySelector('.vacio-titulo').textContent
             };
           }"""
    )
    assert llego["llamado"], "el botón del cartel no le mandó el click al botón del menú"
    assert llego["botones"] == ["Traer del catastro", "Cargar uno a mano"]
    assert llego["titulo"] == "El mapa todavía no tiene lotes"


def test_el_mapa_vacio_se_ve_en_la_app(page, base_url):
    """De punta a punta: con la base sin lotes, el cartel aparece.

    SE SALTEA SOLO si la base tiene lotes cargados: este test necesita
    una cartera vacía y no puede borrar la de nadie para conseguirla.
    """
    page.goto(base_url)
    # Esperar a que la carga TERMINE, que tiene dos finales posibles y
    # excluyentes: si no hay lotes aparece #mapa-vacio, y si hay, mapa.js
    # escribe data-encuadre al encuadrar (ver js/encuadre-mapa.js). Sin
    # esta espera el test miraría el mapa antes de que Firestore conteste
    # y vería "vacío" siempre, incluso con la base llena: un verde que no
    # prueba nada.
    page.wait_for_function(
        """() => {
             const vacio = document.getElementById('mapa-vacio');
             return (vacio && !vacio.classList.contains('oculto')) ||
                    document.getElementById('mapa').hasAttribute('data-encuadre');
           }""",
        timeout=20000,
    )
    hay_lotes = page.evaluate("() => import('/js/estado.js').then((m) => m.getLotesActuales().length)")
    if hay_lotes > 0:
        pytest.skip(
            f"la base tiene {hay_lotes} lotes cargados, así que el mapa no está vacío "
            "y este caso no se puede reproducir sin borrarle datos a alguien"
        )

    expect(page.locator("#mapa-vacio")).to_be_visible()
    expect(page.locator("#mapa-vacio .vacio-titulo")).to_contain_text("lotes")
    # Sin sesión: ni un botón de carga.
    expect(page.locator("#mapa-vacio .vacio-boton")).to_have_count(0)
