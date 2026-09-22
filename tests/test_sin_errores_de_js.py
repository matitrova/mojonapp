"""Recorrer la app no puede tirar ni un error de JavaScript.

POR QUÉ EXISTE. El 2026-09-19 se rompió `renderFotos` al separarle una
parte: el `const puedeSubir` se fue con la mitad nueva y el cuerpo quedó
usando un nombre que ya no existía. Resultado: `mostrarFicha` explotaba a
la mitad y NINGÚN LOTE CON FOTOS abría su ficha — la pantalla principal
de la app, rota para cualquier lote publicado en serio.

Dos tests lo agarraron, pero contaron el síntoma equivocado: decían
"elemento no visible". Con ese mensaje el bug pasó por "inestabilidad de
los tests" durante tres días. Un `ReferenceError` en la consola lo
habría nombrado en el acto.

ESTE ARCHIVO NO PRUEBA UNA FEATURE: prueba que nada explote. Por eso no
hace asserts sobre contenido — para eso están los otros 400 tests. Hace
una sola cosa que ninguno hacía: escuchar `pageerror` mientras se usa la
app normalmente, y fallar si aparece algo.

LOS LOTES DE PRUEBA LLEVAN FOTO A PROPÓSITO. El bug vivía dentro del
`fotos.forEach(...)`, así que un lote sin fotos ni lo rozaba: el primer
diagnóstico que hice pasaba limpio y mandaba a buscar el problema a otro
lado. Si alguna vez se saca la foto de acá, este archivo deja de cubrir
el caso que lo originó.
"""

import uuid

import pytest
from playwright.sync_api import expect

from conftest import abrir_menu, borrar_lote_de_prueba, crear_lote_de_prueba, soltar_el_mouse

# Una imagen de demostración de Cloudinary, la misma que usa
# test_vista_grilla: no depende de que subamos nada.
FOTO = "https://res.cloudinary.com/demo/image/upload/sample.jpg"

GEOMETRIA = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.0800, "lat": -32.4100},
        {"lon": -65.0798, "lat": -32.4100},
        {"lon": -65.0798, "lat": -32.4102},
        {"lon": -65.0800, "lat": -32.4102},
        {"lon": -65.0800, "lat": -32.4100},
    ],
}


@pytest.fixture
def lote_con_foto():
    doc_id = crear_lote_de_prueba(
        {
            "manzana": f"JSERR-{uuid.uuid4().hex[:8]}",
            "lote": "1",
            "superficie_m2": 800,
            "estado": "disponible",
            "precio_usd": 19000,
            "sector": "Potrero de los Funes",
            "descripcion": "Lote de prueba para el guardián de errores de JS.",
            "fotos": [{"url": FOTO, "id": "demo/sample"}],
            "geometry": GEOMETRIA,
        }
    )
    try:
        yield doc_id
    finally:
        borrar_lote_de_prueba(doc_id)


def _escuchar(page):
    """Devuelve la lista donde se van a acumular los errores."""
    errores = []
    page.on("pageerror", lambda e: errores.append(str(e)))
    return errores


def _sin_errores(errores, donde):
    assert not errores, (
        f"la app tiró {len(errores)} error(es) de JavaScript {donde}:\n  "
        + "\n  ".join(errores[:5])
    )


def test_abrir_la_ficha_de_un_lote_con_fotos_no_tira_errores(page, base_url, lote_con_foto):
    """EL CASO QUE ORIGINÓ ESTE ARCHIVO.

    El error vivía dentro del bucle que dibuja cada foto, así que solo
    aparece con un lote que tenga al menos una.
    """
    errores = _escuchar(page)
    page.goto(f"{base_url}/?lote={lote_con_foto}")
    expect(page.locator("#ficha-lote")).to_be_visible()
    # Que la galería llegó a dibujarse, no solo que la hoja se abrió:
    # el bug rompía justo ahí.
    expect(page.locator("#ficha-fotos")).to_be_visible()
    _sin_errores(errores, "al abrir la ficha de un lote con fotos")


def test_recorrer_las_pantallas_principales_no_tira_errores(page, base_url, lote_con_foto):
    """Las cuatro pantallas que un corredor abre todos los días."""
    errores = _escuchar(page)
    page.goto(base_url)
    page.wait_for_function("() => window.L", timeout=30000)

    # "/inmobiliaria" entra sin sesión a propósito: la pantalla no se ve
    # (el ítem del menú es solo de root) pero su módulo corre igual, y
    # este archivo existe justamente para que ese camino no explote.
    for ruta in ("/lotes", "/favoritos", "/dashboard", "/inmobiliaria", "/"):
        page.goto(f"{base_url}{ruta}")
        page.wait_for_timeout(1800)
        _sin_errores(errores, f"en {ruta}")


def test_la_pagina_publica_de_un_lote_con_fotos_no_tira_errores(page, base_url, lote_con_foto):
    """Es la que ve un comprador: un error acá se lo lleva puesto a
    alguien que no es de la casa."""
    errores = _escuchar(page)
    page.goto(f"{base_url}/lote/{lote_con_foto}")
    expect(page.locator("#lp-contenido")).to_be_visible()
    page.wait_for_timeout(1500)
    _sin_errores(errores, "en la página pública del lote")
