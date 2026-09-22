"""
Página pública de un lote (/lote/<id>).

QUÉ ES Y POR QUÉ EXISTE. Es la pantalla que se le manda al comprador:
fotos grandes, precio a la vista, el mapa como un bloque al costado y un
formulario para dejar los datos. Pedido del usuario del 2026-09-18, con
una publicación de portal inmobiliario como referencia.

Convive con la ficha, que es la hoja de trabajo del corredor sobre el
mapa. Son dos usos distintos: la ficha tiene notas internas, tasación y
edición; esta no.

Lo que se prueba acá, en orden de importancia:

  - que se llegue por la URL directa, porque ESE es el objeto que
    circula entre el corredor y el cliente;
  - que un visitante SIN sesión la vea (si pidiera login, el link no
    serviría para nada);
  - que no ofrezca subir fotos a quien no puede;
  - que un lote que no existe lo diga, en vez de mostrar una página
    vacía con el precio en blanco.
"""

import re
import uuid

import pytest
from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba


def abrir_lote_publico(page, base_url, lote_id):
    """Abre la página y espera a que termine de resolverse.

    ESPERA UN ESTADO DEFINIDO, no un tiempo. La página tiene tres
    finales posibles —la propiedad, "no se encontró", o el aviso de que
    no se pudo cargar— y hasta que los lotes llegan no muestra ninguno.
    Un expect() directo sobre el contenido falla por timeout cuando la
    lectura a Firestore tarda de más, y el error que da ("no está
    visible") no distingue "no cargó todavía" de "la página está rota",
    que son dos cosas muy distintas de arreglar.
    """
    page.goto(f"{base_url}/lote/{lote_id}")
    page.wait_for_function(
        """() => {
             const visible = (id) => {
               const el = document.getElementById(id);
               return el && !el.classList.contains('oculto');
             };
             return visible('lp-contenido') || visible('lp-no-encontrado') ||
                    document.getElementById('lp-reintentar')?.classList.contains('oculto') === false;
           }""",
        timeout=25000,
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
def lote_publicado():
    marcador = uuid.uuid4().hex[:8]
    doc_id = crear_lote_de_prueba(
        {
            "manzana": f"PUB-{marcador}",
            "lote": "7",
            "nomenclatura": "00-06-65-01-000123-000007",
            "superficie_m2": 900,
            "estado": "disponible",
            "precio_usd": 22000,
            "sector": "Potrero de los Funes",
            "barrio": "Altos del Potrero",
            "descripcion": "Lote en pendiente suave con vista al dique.",
            "servicios": {"luz": True, "agua": True, "gas": False, "cloaca": False},
            "geometry": GEOMETRIA,
        }
    )
    try:
        yield {"id": doc_id, "manzana": f"PUB-{marcador}"}
    finally:
        borrar_lote_de_prueba(doc_id)


def test_se_llega_por_la_url_directa(page, base_url, lote_publicado):
    """El link es el objeto que circula entre el corredor y el cliente."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    expect(page.locator("#panel-lote-publico")).to_be_visible()
    expect(page.locator("#lp-titulo")).to_contain_text(lote_publicado["manzana"])
    expect(page.locator("#lp-precio")).to_have_text("USD 22.000")
    expect(page.locator("#lp-ubicacion")).to_contain_text("Potrero de los Funes")


def test_un_visitante_sin_sesion_la_ve_completa(page, base_url, lote_publicado, inmobiliaria_configurada):
    """Si pidiera iniciar sesión, el link no serviría para nada."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    expect(page.locator("#lp-descripcion")).to_contain_text("vista al dique")
    expect(page.locator("#lp-datos")).to_contain_text("900 m²")
    # El formulario de consulta es el motivo de la página: tiene que estar.
    expect(page.locator("#lp-form")).to_be_visible()
    # El botón de WhatsApp necesita el teléfono de la inmobiliaria: sin
    # número destino no se muestra (ver renderAgencia en
    # js/lote-publico.js), por eso el fixture.
    expect(page.locator("#lp-whatsapp")).to_be_visible()


def test_no_le_ofrece_subir_fotos_a_un_visitante(page, base_url, lote_publicado):
    """Mostrarle el botón sería prometerle algo que las reglas rechazan."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    expect(page.locator("#lp-subir")).to_be_hidden()


def test_los_servicios_que_no_tiene_tambien_se_muestran(page, base_url, lote_publicado):
    """Saber que NO hay gas es un dato para quien compra, no un vacío."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    expect(page.locator("#lp-servicios")).to_contain_text("Luz")
    expect(page.locator("#lp-servicios")).to_contain_text("Gas")
    expect(page.locator("#lp-servicios .lp-servicio.sin")).to_have_count(2)


def test_un_lote_sin_fotos_lo_dice(page, base_url, lote_publicado):
    """Mejor decirlo que mostrar un recuadro gris sin explicación."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    expect(page.locator("#lp-sin-fotos")).to_be_visible()
    expect(page.locator("#lp-foto-principal")).to_be_hidden()


def test_un_lote_que_no_existe_lo_dice(page, base_url, lote_publicado):
    """Un link viejo de una propiedad ya vendida tiene que explicarse,
    no mostrar una página vacía con el precio en blanco."""
    # El fixture crea un lote: hace falta para que la lista NO llegue
    # vacía, porque con la base vacía la página no puede saber si el id
    # no existe o si todavía no cargó — y con razón no dice ninguna de
    # las dos.
    abrir_lote_publico(page, base_url, "no-existe-este-id")
    expect(page.locator("#lp-no-encontrado")).to_be_visible()
    expect(page.locator("#lp-contenido")).to_be_hidden()


def test_el_titulo_de_la_pestana_es_el_del_lote(page, base_url, lote_publicado):
    """Es lo que se ve al compartir el link y al guardarlo en favoritos.

    Se prueba la parte del LOTE. Lo que va después es el nombre de la
    inmobiliaria si está configurada (ver test_inmobiliaria.py), así que
    fijarlo acá rompería este test el día que se carguen esos datos.
    """
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    expect(page).to_have_title(
        re.compile(rf"^Manzana {re.escape(lote_publicado['manzana'])} — Lote 7 — .+")
    )


# ---------------------------------------------------------------------------
# El formulario de consulta
#
# El envío real lo hace una Pages Function de Cloudflare
# (functions/consulta-lote.js) y este proyecto no la puede correr en
# local — está documentado en functions/_middleware.js. Así que acá se
# interviene fetch para probar lo que SÍ vive en el navegador: qué se
# manda, cuándo no se manda nada, y qué se le muestra a la persona en
# cada caso. Que la función ande de verdad se verifica contra el
# despliegue.
# ---------------------------------------------------------------------------


def _espiar_envios(page):
    """Reemplaza fetch y deja anotado qué se posteó a /consulta-lote."""
    page.evaluate(
        """() => {
             window.__envios = [];
             const original = window.fetch;
             window.fetch = (url, opciones) => {
               if (String(url).includes('/consulta-lote')) {
                 window.__envios.push(JSON.parse(opciones.body));
                 return Promise.resolve(new Response(
                   JSON.stringify(window.__respuesta ?? { ok: true }),
                   { status: window.__status ?? 200, headers: { 'Content-Type': 'application/json' } }
                 ));
               }
               return original(url, opciones);
             };
           }"""
    )


def _llenar(page, nombre="Ana Pérez", telefono="266 4123456", mensaje="¿Sigue disponible?"):
    page.fill("#lp-nombre", nombre)
    page.fill("#lp-telefono", telefono)
    page.fill("#lp-mensaje", mensaje)


def test_una_consulta_completa_se_envia_y_se_confirma(page, base_url, lote_publicado):
    """Es la razón de ser de la página: que el lead llegue."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    _espiar_envios(page)
    _llenar(page)
    page.click("#lp-enviar")

    expect(page.locator("#lp-form-mensaje")).to_contain_text("quedó registrada")
    enviados = page.evaluate("() => window.__envios")
    assert len(enviados) == 1, "tenía que postear exactamente una vez"
    assert enviados[0]["nombre"] == "Ana Pérez"
    assert enviados[0]["loteId"] == lote_publicado["id"]
    # El formulario se limpia: si quedaran los datos, alguien lo manda
    # dos veces creyendo que no salió.
    expect(page.locator("#lp-nombre")).to_have_value("")


def test_sin_telefono_no_se_manda_nada(page, base_url, lote_publicado):
    """Rebotar en el navegador ahorra un viaje y explica al instante.
    La validación que vale es la del servidor, pero esta tiene que
    existir y tiene que NO postear."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    _espiar_envios(page)
    page.fill("#lp-nombre", "Ana")
    page.fill("#lp-telefono", "no tengo")
    page.click("#lp-enviar")

    expect(page.locator("#lp-form-mensaje")).to_be_visible()
    assert page.evaluate("() => window.__envios.length") == 0


def test_si_el_envio_falla_manda_a_whatsapp(page, base_url, lote_publicado):
    """No se puede perder el contacto. Se pierde el registro automático,
    que es otra cosa."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    _espiar_envios(page)
    page.evaluate("() => { window.__status = 502; window.__respuesta = { error: 'Se cayó.' }; }")
    _llenar(page)
    page.click("#lp-enviar")

    expect(page.locator("#lp-form-mensaje")).to_contain_text("WhatsApp")


def test_el_campo_trampa_no_lo_ve_ni_lo_alcanza_una_persona(page, base_url, lote_publicado):
    """Si se viera, la trampa se la comería quien completa el formulario
    y perderíamos la consulta.

    NO se usa to_be_hidden a propósito: el campo está puesto FUERA de la
    pantalla, no escondido con display:none (algunos bots saltean lo que
    está explícitamente oculto). Para Playwright eso sigue siendo
    "visible", así que se mide lo que de verdad importa — dónde cae y si
    se puede llegar con el teclado.
    """
    abrir_lote_publico(page, base_url, lote_publicado["id"])

    caja = page.locator("#lp-apellido").bounding_box()
    ancho = page.evaluate("() => window.innerWidth")
    assert caja["x"] + caja["width"] < 0 or caja["x"] > ancho, (
        f"el campo trampa cae dentro de la pantalla (x={caja['x']}): una persona lo vería"
    )
    # Tampoco se llega tabulando, ni lo anuncia un lector de pantalla:
    # una persona ciega no tiene por qué toparse con una trampa.
    assert page.get_attribute("#lp-apellido", "tabindex") == "-1"
    assert page.get_attribute(".lp-trampa", "aria-hidden") == "true"


def test_el_campo_trampa_viaja_en_el_envio(page, base_url, lote_publicado):
    """Si no viajara, el servidor no podría detectar nada — la trampa
    estaría puesta y desconectada, que es peor que no tenerla."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    _espiar_envios(page)
    _llenar(page)
    page.click("#lp-enviar")

    enviados = page.evaluate("() => window.__envios")
    assert "apellido" in enviados[0]
    assert enviados[0]["apellido"] == ""


def test_whatsapp_se_lleva_lo_que_ya_se_escribio(page, base_url, lote_publicado, inmobiliaria_configurada):
    """Escribir los datos dos veces es donde se abandona una consulta."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    _llenar(page, nombre="Ana Pérez", telefono="2664123456")

    # window.open se intercepta: abrir WhatsApp de verdad no aporta nada
    # y lo que se prueba es el texto que se le pasa.
    page.evaluate("() => { window.__abierto = null; window.open = (url) => { window.__abierto = url; }; }")
    page.click("#lp-whatsapp")

    abierto = page.evaluate("() => window.__abierto")
    assert "Ana" in abierto and "2664123456" in abierto, (
        f"el link de WhatsApp no se llevó los datos del formulario: {abierto}"
    )
