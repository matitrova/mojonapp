"""
Test de Playwright para "Tasador automático simple" en la ficha (idea
propia, módulo #3 del listado para competir con Tokko — Tokko no ofrece
una tasación automática ni siquiera en sus planes más caros): compara
precio_usd/m² de lotes similares (misma zona si hay 3+, si no toda la
cartera) y estima un rango ±15% sobre la mediana. Se oculta si no hay
suficientes comparables o si el lote no tiene superficie cargada — una
estimación con pocos datos sería más ruido que ayuda.
"""

import pytest
import requests
from playwright.sync_api import expect

from conftest import (
    FIREBASE_PROJECT_ID,
    _id_token_de_prueba,
    borrar_lote_de_prueba,
    borrar_lotes_de_prueba,
    crear_lote_de_prueba,
    soltar_el_mouse,
)

# El mismo mínimo que usa la app (MIN_COMPARABLES_TASACION en js/ficha.js).
MIN_COMPARABLES_TASACION = 3


def _comparables_en_la_cartera():
    """Cuántos lotes de la base tienen precio Y superficie cargados.

    Son los que la app puede usar como comparables cuando cae al fallback
    de toda la cartera (ver calcularTasacion en js/ficha.js).
    """
    url = (
        f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
        "/databases/(default)/documents/lotes"
    )
    cabeceras = {"Authorization": f"Bearer {_id_token_de_prueba()}"}
    cuenta, pagina = 0, None
    while True:
        parametros = {"pageSize": 300}
        if pagina:
            parametros["pageToken"] = pagina
        respuesta = requests.get(url, headers=cabeceras, params=parametros, timeout=30)
        respuesta.raise_for_status()
        datos = respuesta.json()
        for doc in datos.get("documents", []):
            campos = doc.get("fields", {})
            tiene_precio = "nullValue" not in campos.get("precio_usd", {"nullValue": None})
            tiene_superficie = "nullValue" not in campos.get("superficie_m2", {"nullValue": None})
            if tiene_precio and tiene_superficie:
                cuenta += 1
        pagina = datos.get("nextPageToken")
        if not pagina:
            return cuenta

GEOMETRY_BASE = {
    "type": "Polygon",
    "coordinates": [
        {"lon": -65.080000, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410000},
        {"lon": -65.079780, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410200},
        {"lon": -65.080000, "lat": -32.410000},
    ],
}


def _lote(manzana, *, superficie_m2, precio_usd, sector):
    return {
        "manzana": manzana,
        "lote": "1",
        "nomenclatura": None,
        "superficie_m2": superficie_m2,
        "estado": "disponible",
        "precio_usd": precio_usd,
        "sector": sector,
        "geometry": GEOMETRY_BASE,
    }


def _abrir_ficha_desde_lista(page, doc_id):
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    soltar_el_mouse(page)
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_tasacion_usa_mediana_de_la_misma_zona(page, base_url):
    zona = "TASA-ZONA"
    # 1000 m2 a 18/20/22 USD/m2 -> mediana 20 USD/m2 -> estimado 20000, rango ±15%
    comparables = [
        crear_lote_de_prueba(_lote("TAS-A", superficie_m2=1000, precio_usd=18000, sector=zona)),
        crear_lote_de_prueba(_lote("TAS-B", superficie_m2=1000, precio_usd=20000, sector=zona)),
        crear_lote_de_prueba(_lote("TAS-C", superficie_m2=1000, precio_usd=22000, sector=zona)),
    ]
    objetivo = crear_lote_de_prueba(_lote("TAS-SIN-PRECIO", superficie_m2=1000, precio_usd=None, sector=zona))
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, objetivo)

        tasacion = page.locator("#ficha-tasacion")
        expect(tasacion).to_be_visible()
        expect(page.locator("#tasacion-rango")).to_contain_text("USD 17.000")
        expect(page.locator("#tasacion-rango")).to_contain_text("USD 23.000")
        expect(page.locator("#tasacion-nota")).to_contain_text("misma zona")
    finally:
        borrar_lote_de_prueba(objetivo)
        borrar_lotes_de_prueba(comparables)


def test_tasacion_usa_toda_la_cartera_si_la_zona_no_alcanza(page, base_url):
    zona_objetivo = "TASA-ZONA-CHICA"
    otra_zona = "TASA-ZONA-OTRA"
    # Solo 1 comparable en la zona del lote (no alcanza el mínimo de 3) ->
    # cae a toda la cartera. No fijamos el rango numérico exacto porque el
    # fallback a "toda la cartera" mezcla estos comparables con cualquier
    # otro lote real con precio+superficie que ya exista en producción —
    # lo que sí podemos afirmar sin depender de esos datos ajenos es que
    # se muestra y que la nota dice "de la cartera" (no "misma zona").
    comparables = [
        crear_lote_de_prueba(_lote("TAS-D", superficie_m2=1000, precio_usd=25000, sector=zona_objetivo)),
        crear_lote_de_prueba(_lote("TAS-E", superficie_m2=1000, precio_usd=18000, sector=otra_zona)),
        crear_lote_de_prueba(_lote("TAS-F", superficie_m2=1000, precio_usd=20000, sector=otra_zona)),
        crear_lote_de_prueba(_lote("TAS-G", superficie_m2=1000, precio_usd=22000, sector=otra_zona)),
    ]
    objetivo = crear_lote_de_prueba(_lote("TAS-SIN-PRECIO-2", superficie_m2=1000, precio_usd=None, sector=zona_objetivo))
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, objetivo)

        tasacion = page.locator("#ficha-tasacion")
        expect(tasacion).to_be_visible()
        expect(page.locator("#tasacion-rango")).to_contain_text("USD")
        expect(page.locator("#tasacion-nota")).to_contain_text("de la cartera")
    finally:
        borrar_lote_de_prueba(objetivo)
        borrar_lotes_de_prueba(comparables)


def test_tasacion_oculta_sin_comparables_suficientes(page, base_url):
    """La tasación se esconde cuando no hay con qué compararse.

    OJO, ESTE TEST SE SALTEA SOLO cuando no se puede probar. No crea
    comparables propios: usa una zona única (mismaZona queda vacía) y cae
    al fallback de TODA la cartera, así que solo tiene sentido si la
    cartera entera tiene menos de MIN_COMPARABLES_TASACION lotes con
    precio y superficie.

    El comentario original ya avisaba que si la cartera crecía, el test
    iba a empezar a fallar. Pasó: el proyecto de pruebas se sembró con 12
    lotes de demo (con precio y superficie), que es justo lo que hace
    falta para que las vistas previas no se vean vacías. O sea que la
    condición que este test necesita dejó de existir a propósito.

    En vez de dejarlo en rojo para siempre —o borrarlo y perder la
    cobertura— se saltea con el motivo a la vista. Sigue corriendo y
    protegiendo en una base recién creada, que es cuando la condición se
    cumple.
    """
    if _comparables_en_la_cartera() >= MIN_COMPARABLES_TASACION:
        pytest.skip(
            f"la cartera tiene {_comparables_en_la_cartera()} lotes con precio y "
            f"superficie (mínimo {MIN_COMPARABLES_TASACION}), así que el fallback "
            "de toda la cartera SÍ alcanza y esta condición no se puede reproducir"
        )

    zona = "TASA-SOLA"
    objetivo = crear_lote_de_prueba(_lote("TAS-SIN-PRECIO-3", superficie_m2=1000, precio_usd=None, sector=zona))
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, objetivo)
        expect(page.locator("#ficha-tasacion")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(objetivo)


def test_tasacion_oculta_sin_superficie_cargada(page, base_url):
    zona = "TASA-SINSUP"
    comparables = [
        crear_lote_de_prueba(_lote("TAS-H", superficie_m2=1000, precio_usd=18000, sector=zona)),
        crear_lote_de_prueba(_lote("TAS-I", superficie_m2=1000, precio_usd=20000, sector=zona)),
        crear_lote_de_prueba(_lote("TAS-J", superficie_m2=1000, precio_usd=22000, sector=zona)),
    ]
    objetivo = crear_lote_de_prueba(_lote("TAS-SIN-SUP", superficie_m2=None, precio_usd=None, sector=zona))
    try:
        page.goto(base_url)
        _abrir_ficha_desde_lista(page, objetivo)
        expect(page.locator("#ficha-tasacion")).to_be_hidden()
    finally:
        borrar_lote_de_prueba(objetivo)
        borrar_lotes_de_prueba(comparables)
