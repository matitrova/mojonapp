"""Calzar la foto mueve LA FOTO y nada más.

ESTE ES EL TEST QUE NO PUEDE FALLAR. La foto satelital de Esri no
coincide con el catastro —hasta 20-25 m en algunas zonas de San Luis— y
el corredor la calza a ojo. Lo que se corrige es la imagen, porque las
parcelas son el dato legal del catastro provincial y los lotes cargados
se dibujaron contra ellas.

Si un día la corrección moviera también los polígonos, el resultado
sería una app que se ve perfecta y miente: los lotes dibujados en el
lugar equivocado, con la foto de testigo dando la razón. Nadie lo
notaría hasta que alguien fuera al terreno. Por eso el test no se
conforma con que el calce "funcione": mide dónde queda cada cosa.

El panel de calibración pide permiso para guardar, así que esa parte va
con sesión; que la foto se mueva no lo pide.
"""

import re
import uuid
from pathlib import Path

import pytest
from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

RAIZ = Path(__file__).resolve().parents[1]

# ¿Está prendido el interruptor? Se lee del código y no de la app para
# poder saltear los tests del panel al RECOLECTARLOS, sin levantar un
# navegador para descubrir que el botón no existe.
#
# Los tests del panel se quedan (no se borran) porque la función está
# entera y probada: el día que se prenda CALZAR_HABILITADO vuelven a
# correr solos, y si se borraran nadie se acordaría de reescribirlos.
CALZE_HABILITADO = bool(
    re.search(
        r"CALZAR_HABILITADO\s*=\s*true",
        (RAIZ / "js" / "calce-panel.js").read_text(),
    )
)

solo_si_esta_prendido = pytest.mark.skipif(
    not CALZE_HABILITADO,
    reason="CALZAR_HABILITADO está en false en js/calce-panel.js: el botón no existe para nadie",
)

# El espejo del anterior. El test que comprueba "apagado quiere decir
# apagado" describe UN estado, no una verdad permanente: con el
# interruptor prendido tiene que saltearse, no fallar. Sin esto, prender
# la función rompía un test y parecía un bug.
solo_si_esta_apagado = pytest.mark.skipif(
    CALZE_HABILITADO,
    reason="CALZAR_HABILITADO está en true: la función está prendida a propósito",
)

GEOMETRIA = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.080000, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410000},
    ],
}


@pytest.fixture
def lote_para_calzar():
    doc_id = crear_lote_de_prueba(
        {
            "manzana": f"CAL-{uuid.uuid4().hex[:8]}",
            "lote": "1",
            "superficie_m2": 900,
            "estado": "disponible",
            "geometry": GEOMETRIA,
        }
    )
    try:
        yield doc_id
    finally:
        borrar_lote_de_prueba(doc_id)


# Mueve la foto por el MISMO camino que el panel (verEnVivo), sin pasar
# por la UI: acá se prueba el efecto en el mapa, no los botones — de eso
# se encargan los tests con sesión de más abajo.
#
# Se usa verEnVivo y no moverLaFoto directo a propósito: moverLaFoto solo
# pinta, y el seguimiento re-aplica lo guardado en cada movimiento del
# mapa, así que un transform puesto por afuera se borra al primer zoom.
# Probar por afuera del camino real daría un verde que no significa nada.
MOVER = """([este, norte]) => import('/js/mapa.js').then(async (m) => {
     m.calceDelMapa.verEnVivo(este === 0 && norte === 0
       ? null : { este_m: este, norte_m: norte });
     await new Promise((r) => setTimeout(r, 300));
     return true;
   })"""

# Dónde está cada cosa EN LA PANTALLA.
#
# SE MIDE LA POSICIÓN REAL DE UNA TILE, no el atributo transform del
# pane. La primera versión miraba el transform y daba un verde que no
# probaba nada: al reintroducir el bug a propósito (sacarle `pane:
# PANE_FOTO` a la capa, o sea que la foto vuelve al pane compartido) el
# pane propio quedaba vacío, igual recibía el transform, y el test pasaba
# tan contento mientras la foto no se movía ni un píxel.
#
# Una tile es un <img> de verdad: si se movió, su caja en pantalla
# cambió, y eso no se puede simular.
DONDE_ESTA_TODO = """() => import('/js/mapa.js').then((m) => {
     const cont = m.mapa.getContainer();
     const pane = m.mapa.getPane(m.PANE_FOTO);
     const svg = cont.querySelector('svg.leaflet-zoom-animated');
     const punto = m.mapa.latLngToContainerPoint([-32.4101, -65.07989]);
     // La tile satelital que esté más cerca del centro: se identifica
     // por su src para no agarrar una de las capas de referencia.
     const tiles = [...cont.querySelectorAll('img.leaflet-tile')]
       .filter((t) => t.src.includes('World_Imagery'))
       .map((t) => ({ src: t.src, caja: t.getBoundingClientRect() }))
       .sort((a, b) => a.src.localeCompare(b.src));
     const tile = tiles[0] || null;
     return {
       transformDeLaFoto: pane.style.transform || '',
       // Identidad + posición, para poder comparar LA MISMA tile.
       tileSrc: tile ? tile.src : null,
       tileX: tile ? Math.round(tile.caja.left) : null,
       tileY: tile ? Math.round(tile.caja.top) : null,
       cuantasTiles: tiles.length,
       transformDelSvg: svg ? (svg.style.transform || '') : null,
       cajaDelSvg: svg ? svg.getBoundingClientRect().top : null,
       puntoDelTerreno: { x: punto.x, y: punto.y },
       centro: m.mapa.getCenter(),
       zoom: m.mapa.getZoom(),
     };
   })"""


def _ir_al_lote(page, base_url, con_sesion=False):
    page.goto(base_url)
    page.wait_for_function("() => window.L", timeout=30000)
    page.wait_for_selector("#mapa .leaflet-tile", timeout=30000)
    if con_sesion:
        # Con sesión la app aterriza en el Dashboard, y lo flotante vive
        # solo en el mapa (body.en-el-mapa), así que hay que volver al
        # mapa antes de buscar el botón. Mismo patrón que
        # tests/test_fab_carga.py.
        expect(page.locator("#sesion-activa")).to_be_visible()
        # ANTES del primer click, no solo después: Playwright arranca con
        # el puntero en (0,0), que cae sobre el rail del menú, y el rail
        # se expande con el hover y tapa la franja izquierda entera.
        soltar_el_mouse(page)
        page.locator("#cerrar-panel-dashboard").click()
        soltar_el_mouse(page)
    _fijar_la_vista(page)


ZOOM_DE_PRUEBA = 18


def _fijar_la_vista(page):
    """Deja el mapa en un lugar y zoom conocidos, y lo comprueba.

    HACE FALTA COMPROBARLO. La app reencuadra el mapa sola cuando
    terminan de cargar los lotes (ver convieneEnfocarUnGrupo en
    js/encuadre-mapa.js), así que un setView hecho antes se pierde. La
    primera versión de estos tests medía sin verificar y corría en zoom
    13 creyendo estar en 18: la corrección de 10 m daba 1 píxel en vez
    de 20, y el test fallaba culpando al código de la feature.
    """
    # Que el reencuadre automático ocurra primero, y después pisarlo.
    page.wait_for_timeout(4000)
    for _ in range(4):
        vista = page.evaluate(
            """([lat, lon, zoom]) => import('/js/mapa.js').then(async (m) => {
                 m.mapa.setView([lat, lon], zoom, { animate: false });
                 await new Promise((r) => setTimeout(r, 1200));
                 const c = m.mapa.getCenter();
                 return { zoom: m.mapa.getZoom(), lat: c.lat, lon: c.lng };
               })""",
            [-32.4101, -65.07989, ZOOM_DE_PRUEBA],
        )
        if vista["zoom"] == ZOOM_DE_PRUEBA:
            return vista
    raise AssertionError(
        f"no se pudo dejar el mapa en zoom {ZOOM_DE_PRUEBA}: quedó en {vista['zoom']}. "
        f"Algo lo está reencuadrando."
    )


def _calce_habilitado(page):
    """¿Está prendido el interruptor de js/calce-panel.js?"""
    return page.evaluate("() => import('/js/calce-panel.js').then((m) => m.CALZAR_HABILITADO)")


def _abrir_el_panel(page, base_url):
    _ir_al_lote(page, base_url, con_sesion=True)
    # De nuevo acá, no solo en _ir_al_lote: entre medio hubo un
    # setView y una espera, y el menú lateral se expande con el hover y
    # se come el click ("subtree intercepts pointer events"). Ver
    # soltar_el_mouse en conftest.
    soltar_el_mouse(page)
    page.locator("#fab-carga-boton").click()
    page.locator("#btn-calzar-foto").click()
    expect(page.locator("#panel-calce")).to_be_visible()


def test_la_foto_se_mueve_de_verdad(page, base_url, lote_para_calzar):
    """La mitad fácil, pero medida donde corresponde.

    Se compara la posición en pantalla de LA MISMA tile satelital antes
    y después. No el atributo transform: eso se puede poner sin que la
    imagen se mueva, y ya dio un falso verde una vez.
    """
    _ir_al_lote(page, base_url)
    antes = page.evaluate(DONDE_ESTA_TODO)
    assert antes["cuantasTiles"] > 0, "no se cargó ninguna tile satelital"
    assert antes["transformDeLaFoto"] == "", "la foto arrancó ya movida"
    assert antes["zoom"] == ZOOM_DE_PRUEBA, f"el mapa quedó en zoom {antes['zoom']}"

    page.evaluate(MOVER, [10, -20])
    despues = page.evaluate(DONDE_ESTA_TODO)

    assert despues["tileSrc"] == antes["tileSrc"], "se comparó una tile distinta"
    corrio_x = abs(despues["tileX"] - antes["tileX"])
    corrio_y = abs(despues["tileY"] - antes["tileY"])
    # 10 m al este y 20 m al sur, a zoom 18 (~0,5 m/px): unos 20 y 40 px.
    assert corrio_x > 5 and corrio_y > 5, (
        f"la imagen no se movió en pantalla (x {corrio_x}px, y {corrio_y}px). "
        f"El transform puede estar puesto en un pane que no contiene la foto."
    )


def test_los_lotes_y_el_catastro_NO_se_mueven(page, base_url, lote_para_calzar):
    """LA MITAD QUE IMPORTA.

    Se mide de dos formas independientes, porque es lo único que no
    puede fallar: el transform del SVG donde se dibujan los polígonos, y
    a qué píxel de la pantalla corresponde una coordenada del terreno.
    Si el calce tocara la proyección del mapa en vez de solo la imagen,
    lo segundo cambiaría aunque lo primero no.
    """
    _ir_al_lote(page, base_url)
    antes = page.evaluate(DONDE_ESTA_TODO)

    page.evaluate(MOVER, [25, -25])
    despues = page.evaluate(DONDE_ESTA_TODO)

    assert despues["transformDelSvg"] == antes["transformDelSvg"], (
        "el calce movió la capa donde se dibujan los lotes y las parcelas del "
        "catastro. Tiene que mover SOLO la foto: los polígonos son el dato bueno."
    )
    assert despues["puntoDelTerreno"] == antes["puntoDelTerreno"], (
        "el calce cambió a qué punto de la pantalla corresponde una coordenada "
        "real. Eso desplaza todo lo dibujado, no solo la foto."
    )
    assert despues["cajaDelSvg"] == antes["cajaDelSvg"], "se movió el SVG de los polígonos"


def test_el_mismo_corrimiento_son_mas_pixeles_al_acercarse(page, base_url, lote_para_calzar):
    """La corrección se guarda en metros. Si se aplicara como una
    cantidad fija de píxeles, el calce se vería bien solo en el zoom en
    que se hizo — y se rompería al acercarse, que es cuando se mira."""
    _ir_al_lote(page, base_url)
    page.evaluate(MOVER, [20, 0])

    def pixeles_x():
        t = page.evaluate(DONDE_ESTA_TODO)["transformDeLaFoto"]
        # translate3d(Npx, Mpx, 0)
        return abs(float(t.split("(")[1].split("px")[0]))

    en_18 = pixeles_x()
    page.evaluate(
        """() => import('/js/mapa.js').then(async (m) => {
             m.mapa.setZoom(20, { animate: false });
             await new Promise((r) => setTimeout(r, 1500));
           })"""
    )
    en_20 = pixeles_x()
    assert en_20 > en_18 * 3, (
        f"a dos zooms más cerca los mismos 20 m tendrían que ser ~4 veces más "
        f"píxeles: pasó de {en_18:.0f} a {en_20:.0f}"
    )


def test_volver_a_cero_deja_la_foto_donde_estaba(page, base_url, lote_para_calzar):
    _ir_al_lote(page, base_url)
    page.evaluate(MOVER, [15, 15])
    assert page.evaluate(DONDE_ESTA_TODO)["transformDeLaFoto"] != ""
    page.evaluate(MOVER, [0, 0])
    assert page.evaluate(DONDE_ESTA_TODO)["transformDeLaFoto"] == ""


def test_un_visitante_sin_sesion_no_ve_el_boton_de_calzar(page, base_url):
    """Guardar un calce desalinea el mapa de todo el equipo si se hace
    mal: pide permiso. Mostrar el botón sería ofrecer un trabajo a ojo
    que se pierde recién al apretar Guardar."""
    page.goto(base_url)
    page.wait_for_function("() => window.L", timeout=30000)
    expect(page.locator("#btn-calzar-foto")).to_be_hidden()


@solo_si_esta_apagado
@pytest.mark.con_sesion
def test_con_el_interruptor_apagado_nadie_ve_el_boton_ni_siendo_root(page, base_url):
    """EL INTERRUPTOR, que es el estado en el que sale a producción.

    Decisión del usuario: la función no va suelta hasta que él la pruebe
    en una zona que conoce. La cuenta de los tests es root, así que este
    test prueba justo el caso que un permiso común no podía cubrir —
    root se saltea todos los permisos, y por eso el interruptor es una
    constante y no un permiso (ver CALZAR_HABILITADO en
    js/calce-panel.js).
    """
    _ir_al_lote(page, base_url, con_sesion=True)
    assert _calce_habilitado(page) is False, (
        "el interruptor quedó prendido: revisá CALZAR_HABILITADO en js/calce-panel.js"
    )
    soltar_el_mouse(page)
    page.locator("#fab-carga-boton").click()
    # El flotante se abre y ofrece todo lo demás, pero no esto.
    expect(page.locator("#btn-cargar-lote")).to_be_visible()
    expect(page.locator("#btn-calzar-foto")).to_be_hidden()
    expect(page.locator("#panel-calce")).to_be_hidden()


def test_un_calce_ya_guardado_se_sigue_aplicando_con_el_interruptor_apagado(page, base_url, lote_para_calzar):
    """Apagar el botón NO apaga las correcciones que ya existen.

    Son dos cosas distintas y conviene que sigan separadas: si una zona
    ya está calzada, la foto tiene que seguir saliendo en su lugar — para
    el corredor y para el comprador que abre el link. Lo que se apagó es
    poder crear o cambiar una.
    """
    _ir_al_lote(page, base_url)
    page.evaluate(MOVER, [10, -20])
    assert page.evaluate(DONDE_ESTA_TODO)["transformDeLaFoto"] != "", (
        "con el interruptor apagado dejó de aplicarse un calce existente"
    )


@solo_si_esta_prendido
@pytest.mark.con_sesion
def test_con_permiso_el_panel_abre_y_muestra_cuanto_se_movio(page, base_url, lote_para_calzar):
    """El número tiene que estar a la vista: sin él no se sabe si se
    corrió 2 metros o 20, y calzar a ojo se vuelve adivinar."""
    _abrir_el_panel(page, base_url)
    expect(page.locator("#calce-estado")).to_have_text("sin corrección")

    page.click("#calce-norte")
    page.click("#calce-norte")
    page.click("#calce-este")
    estado = page.locator("#calce-estado")
    expect(estado).to_contain_text("2 m al norte")
    expect(estado).to_contain_text("1 m al este")


@solo_si_esta_prendido
@pytest.mark.con_sesion
def test_cerrar_sin_guardar_descarta_lo_probado(page, base_url, lote_para_calzar):
    """Si quedara aplicado, alguien podría seguir trabajando sobre una
    corrección que cree guardada y no está en la base."""
    _abrir_el_panel(page, base_url)
    for _ in range(5):
        page.click("#calce-norte")
    assert page.evaluate(DONDE_ESTA_TODO)["transformDeLaFoto"] != ""

    page.click("#calce-cerrar")
    page.wait_for_timeout(600)
    expect(page.locator("#panel-calce")).to_be_hidden()
    assert page.evaluate(DONDE_ESTA_TODO)["transformDeLaFoto"] == "", (
        "lo que se probó y no se guardó quedó aplicado en el mapa"
    )
