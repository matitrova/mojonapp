"""Qué link reconoce la vista previa al compartir (functions/_middleware.js).

POR QUÉ IMPORTA. Ese middleware es lo que convierte un link pegado en
WhatsApp en una tarjeta con la superficie, el precio y el nombre de la
inmobiliaria. Corre en el servidor (el crawler de WhatsApp no ejecuta el
JS de la app), así que nada de lo que pasa en el navegador lo prueba.

EL BUG QUE ESTO CUBRE: el middleware solo miraba "?lote=<id>" en la
home. La página pública —"/lote/<id>", que es justamente el link que se
le manda a un comprador— caía en el "no hay nada que enriquecer" y se
compartía como "MojonApp" pelado.

Solo se prueba idDeLoteEnLaUrl, que es la decisión: el resto de la
función habla con Firestore y con HTMLRewriter (una API que solo existe
en Cloudflare) y se verifica contra el deploy, como catastro-proxy.js.
"""

import pytest

MODULO = "/functions/_middleware.js"


@pytest.fixture
def id_en(page, base_url):
    """Devuelve el id de lote que el middleware saca de una URL."""
    page.goto(base_url)

    def _correr(url):
        return page.evaluate(
            f"""(url) => import('{MODULO}').then((m) => m.idDeLoteEnLaUrl(new URL(url)))""",
            url,
        )

    return _correr


BASE = "https://mojonapp.com.ar"


# --- Las dos formas de link que un corredor comparte ---------------------


def test_reconoce_la_pagina_publica(id_en):
    """El link que se le manda al comprador. Antes NO se reconocía."""
    assert id_en(f"{BASE}/lote/abc123") == "abc123"


def test_reconoce_el_lote_en_la_home(id_en):
    """"Compartir este lote" desde la ficha del corredor."""
    assert id_en(f"{BASE}/?lote=abc123") == "abc123"


def test_la_pagina_publica_con_barra_final_tambien(id_en):
    assert id_en(f"{BASE}/lote/abc123/") == "abc123"


# --- Lo que tiene que dejar pasar sin tocar ------------------------------


def test_la_home_pelada_no_es_un_lote(id_en):
    """Si devolviera algo, CADA pedido a la app pagaría dos lecturas de
    Firestore de más."""
    assert id_en(f"{BASE}/") is None


def test_una_pantalla_de_la_app_no_es_un_lote(id_en):
    assert id_en(f"{BASE}/contactos") is None


def test_un_archivo_estatico_no_es_un_lote(id_en):
    assert id_en(f"{BASE}/js/app.js") is None


def test_lote_sin_id_no_es_un_lote(id_en):
    assert id_en(f"{BASE}/lote/") is None


def test_un_lote_en_otra_ruta_no_cuenta(id_en):
    """"?lote=" solo vale en la home: en /contactos el router lo borra de
    la URL, así que ahí no significa nada."""
    assert id_en(f"{BASE}/contactos?lote=abc123") is None


# --- Lo que manda cualquiera --------------------------------------------


def test_un_id_con_caracteres_escapados_se_decodifica(id_en):
    assert id_en(f"{BASE}/lote/abc%20123") == "abc 123"


def test_un_escape_roto_no_tira(id_en):
    """El id lo elige quien manda el pedido, no la app. Un "%" suelto
    hace que decodeURIComponent tire, y una excepción acá rompería la
    carga de la página entera para ese visitante."""
    assert id_en(f"{BASE}/lote/abc%ZZ") is None
