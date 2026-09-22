"""
Los datos de la inmobiliaria: la pantalla y lo que cambia en la app.

POR QUÉ EXISTE ESTA FEATURE. El link que un corredor manda por WhatsApp
diez veces por día abría una página que arriba decía "MojonApp" —el
nombre del software, no el del negocio— y cuyo botón "Consultar por
WhatsApp" se armaba SIN número de destino: abría el selector de
contactos del comprador, así que la consulta podía no llegar nunca. Eso
es lo que se arregla acá.

Lo que se prueba, en orden de importancia:

  - que el botón de WhatsApp lleve al número de la inmobiliaria (es el
    bug que más plata cuesta y el que no se ve fallar);
  - que el comprador vea de quién es la propiedad;
  - que se pueda guardar desde la pantalla y quede guardado;
  - que la app NO se rompa cuando todavía no se configuró nada, que es
    el estado en el que queda recién instalada.

Las reglas de decisión (qué es válido, cómo se arma cada texto) se
prueban aparte, sin navegador, en test_inmobiliaria_datos.py.

OJO: estos tests escriben en la colección `configuracion`, así que
necesitan que su regla de Firestore ya esté publicada. Sin eso fallan
con "Solo el usuario principal puede cambiar los datos", que es
exactamente lo que hace la app hasta que se publique.
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import abrir_menu, soltar_el_mouse

GEOMETRIA = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.080000, "lat": -32.410000},
        {"lon": -65.079800, "lat": -32.410000},
        {"lon": -65.079800, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410000},
    ],
}

ANCHO_ESCRITORIO = {"width": 1200, "height": 900}


@pytest.fixture
def lote_publicado():
    from conftest import borrar_lote_de_prueba, crear_lote_de_prueba

    datos = {
        "manzana": f"INMO-{uuid.uuid4().hex[:8]}",
        "lote": "7",
        "superficie_m2": 900,
        "estado": "disponible",
        "precio_usd": 22000,
        "sector": "Potrero de los Funes",
        "geometry": GEOMETRIA,
    }
    doc_id = crear_lote_de_prueba(datos)
    try:
        yield {**datos, "id": doc_id}
    finally:
        borrar_lote_de_prueba(doc_id)


def abrir_lote_publico(page, base_url, lote_id):
    """Mismo esperar-a-un-estado que en test_lote_publico.py."""
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


# ---------------------------------------------------------------------------
# Lo que ve el comprador
# ---------------------------------------------------------------------------


def test_el_whatsapp_lleva_al_numero_de_la_inmobiliaria(
    page, base_url, lote_publicado, inmobiliaria_configurada
):
    """EL BUG QUE ESTA FEATURE VINO A ARREGLAR.

    Antes el link era "https://wa.me/?text=..." — sin número. WhatsApp
    abría el mensaje escrito pero le pedía al comprador que eligiera un
    contacto a mano, así que la consulta podía terminar en cualquier
    lado. Y no se veía fallar: el botón "andaba".
    """
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    page.evaluate("() => { window.__abierto = null; window.open = (url) => { window.__abierto = url; }; }")
    page.click("#lp-whatsapp")

    abierto = page.evaluate("() => window.__abierto")
    assert abierto, "el botón de WhatsApp no abrió nada"
    # 549 + el número: el formato que WhatsApp necesita para Argentina
    # (ver normalizarTelefonoWhatsapp en js/crm-metricas.js).
    assert "wa.me/549" in abierto, f"el link no lleva al número de la inmobiliaria: {abierto}"
    assert "2664558821" in abierto, f"el número no es el de la inmobiliaria: {abierto}"


def test_sin_telefono_cargado_no_se_ofrece_whatsapp(
    page, base_url, lote_publicado, inmobiliaria_sin_configurar
):
    """Un botón sin destino es peor que no tener botón: promete que la
    consulta llega, y no llega. El formulario sigue estando."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    expect(page.locator("#lp-whatsapp")).to_be_hidden()
    expect(page.locator("#lp-form")).to_be_visible()


def test_el_comprador_ve_de_quien_es_la_propiedad(
    page, base_url, lote_publicado, inmobiliaria_configurada
):
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    expect(page.locator("#lp-agencia-nombre")).to_have_text(inmobiliaria_configurada["nombre"])
    expect(page.locator("#lp-pie-datos")).to_contain_text(inmobiliaria_configurada["horario"])
    expect(page.locator("#lp-pie-matricula")).to_contain_text("CSI 1234")


def test_la_pestaña_dice_el_nombre_de_la_inmobiliaria(
    page, base_url, lote_publicado, inmobiliaria_configurada
):
    """Es lo que queda si el comprador la agrega a favoritos, y lo que
    lee cuando tiene ocho pestañas abiertas comparando propiedades."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    page.wait_for_function(
        "(nombre) => document.title.includes(nombre)",
        arg=inmobiliaria_configurada["nombre"],
        timeout=15000,
    )
    assert "MojonApp" not in page.title()


def test_sin_configurar_la_pagina_igual_se_ve_entera(
    page, base_url, lote_publicado, inmobiliaria_sin_configurar
):
    """El estado en el que queda la app recién instalada. Que falte el
    logo no puede dejar al comprador sin ver la propiedad."""
    abrir_lote_publico(page, base_url, lote_publicado["id"])
    expect(page.locator("#lp-contenido")).to_be_visible()
    expect(page.locator("#lp-precio")).to_have_text("USD 22.000")
    # Los bloques de la agencia se esconden enteros: una banda vacía se
    # ve peor que ninguna banda.
    expect(page.locator("#lp-agencia")).to_be_hidden()
    expect(page.locator("#lp-pie")).to_be_hidden()


# ---------------------------------------------------------------------------
# La pantalla de configuración
# ---------------------------------------------------------------------------


@pytest.mark.con_sesion
def test_se_guarda_y_queda_guardado(page, base_url, inmobiliaria_configurada):
    """De punta a punta: escribir, guardar, recargar, seguir estando."""
    page.set_viewport_size(ANCHO_ESCRITORIO)
    nombre_nuevo = f"Inmobiliaria {uuid.uuid4().hex[:6]}"

    page.goto(f"{base_url}/inmobiliaria")
    expect(page.locator("#panel-inmobiliaria")).to_be_visible()
    # El formulario se llena con lo que hay guardado, no vacío.
    expect(page.locator("#inmobiliaria-nombre")).to_have_value(
        inmobiliaria_configurada["nombre"], timeout=15000
    )

    page.fill("#inmobiliaria-nombre", nombre_nuevo)
    page.fill("#inmobiliaria-telefono", "266 4 11-2233")
    soltar_el_mouse(page)
    page.click("#inmobiliaria-guardar")
    expect(page.locator("#inmobiliaria-ok")).to_be_visible(timeout=15000)

    # Recargar es lo que distingue "se guardó" de "se mostró".
    page.reload()
    expect(page.locator("#inmobiliaria-nombre")).to_have_value(nombre_nuevo, timeout=15000)
    expect(page.locator("#inmobiliaria-telefono")).to_have_value("266 4 11-2233")


@pytest.mark.con_sesion
def test_no_deja_guardar_sin_nombre(page, base_url, inmobiliaria_configurada):
    """Sin nombre no hay identidad que mostrar: es como no haber
    configurado nada, pero con datos a medias guardados."""
    page.set_viewport_size(ANCHO_ESCRITORIO)
    page.goto(f"{base_url}/inmobiliaria")
    expect(page.locator("#inmobiliaria-nombre")).to_have_value(
        inmobiliaria_configurada["nombre"], timeout=15000
    )

    page.fill("#inmobiliaria-nombre", "")
    soltar_el_mouse(page)
    page.click("#inmobiliaria-guardar")

    # No se guardó: el aviso de OK nunca aparece.
    expect(page.locator("#inmobiliaria-ok")).to_be_hidden()


@pytest.mark.con_sesion
def test_la_web_sin_https_se_guarda_usable(page, base_url, inmobiliaria_configurada):
    """Nadie escribe "https://" cuando le preguntan por su sitio, y un
    link sin esquema el navegador lo toma como una ruta de la app."""
    page.set_viewport_size(ANCHO_ESCRITORIO)
    page.goto(f"{base_url}/inmobiliaria")
    expect(page.locator("#inmobiliaria-nombre")).to_have_value(
        inmobiliaria_configurada["nombre"], timeout=15000
    )

    page.fill("#inmobiliaria-web", "www.recienpuesta.com.ar")
    soltar_el_mouse(page)
    page.click("#inmobiliaria-guardar")
    expect(page.locator("#inmobiliaria-ok")).to_be_visible(timeout=15000)

    expect(page.locator("#inmobiliaria-web")).to_have_value("https://www.recienpuesta.com.ar")


@pytest.mark.con_sesion
def test_se_llega_desde_el_menu(page, base_url):
    """Una pantalla a la que solo se llega escribiendo la URL no existe
    para quien la tiene que usar."""
    page.set_viewport_size(ANCHO_ESCRITORIO)
    page.goto(base_url)
    soltar_el_mouse(page)
    abrir_menu(page)
    page.click("#btn-abrir-inmobiliaria")
    expect(page.locator("#panel-inmobiliaria")).to_be_visible()
    assert page.url.endswith("/inmobiliaria")


def test_un_visitante_sin_sesion_no_ve_la_pantalla(page, base_url):
    """De acá sale el número al que llegan TODAS las consultas."""
    page.goto(f"{base_url}/inmobiliaria")
    expect(page.locator("#btn-abrir-inmobiliaria")).to_be_hidden()
