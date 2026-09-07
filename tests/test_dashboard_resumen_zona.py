"""
Test de Playwright para "Resumen por zona" en el Dashboard (idea propia,
investigada en las funcionalidades y planes de Tokko Broker antes de
armarla — ver feedback_buscar_inspiracion_real: Tokko cobra
"Emprendimientos" aparte, recién desde su plan de $252.320/mes, para dar
"visión general del estado de las propiedades" — acá cualquier zona ya
cumple ese rol, sin costo extra).
"""

import uuid

from playwright.sync_api import expect

from conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD, borrar_lote_de_prueba, crear_lote_de_prueba


def _loguearse(page, base_url):
    page.goto(base_url)
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()


def _datos_lote(manzana, offset, *, estado, precio_usd, sector):
    return {
        "manzana": manzana,
        "lote": "1",
        "nomenclatura": None,
        "superficie_m2": 500,
        "estado": estado,
        "precio_usd": precio_usd,
        "sector": sector,
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                {"lon": -65.150000 + offset, "lat": -32.480000},
                {"lon": -65.149780 + offset, "lat": -32.480000},
                {"lon": -65.149780 + offset, "lat": -32.480200},
                {"lon": -65.150000 + offset, "lat": -32.480200},
                {"lon": -65.150000 + offset, "lat": -32.480000},
            ],
        },
    }


def test_resumen_por_zona_desglosa_inventario_y_precio_promedio(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    zona = f"ZonaResumenTest-{marcador}"
    disponible = crear_lote_de_prueba(_datos_lote("RESZ-1", 0, estado="disponible", precio_usd=10000, sector=zona))
    reservado = crear_lote_de_prueba(_datos_lote("RESZ-2", 0.001, estado="reservado", precio_usd=20000, sector=zona))
    vendido = crear_lote_de_prueba(_datos_lote("RESZ-3", 0.002, estado="vendido", precio_usd=None, sector=zona))
    try:
        _loguearse(page, base_url)
        # El login ya abre el dashboard automático (ver formularioLogin
        # en app.js) — no hace falta navegar, alcanza con esperar a que
        # la fila de esta zona (recién sembrada) aparezca.
        expect(page.locator("#panel-dashboard")).to_be_visible()

        fila = page.locator("#dashboard-precios-zona-cuerpo tr", has_text=zona)
        expect(fila).to_be_visible()
        celdas = fila.locator("td")
        expect(celdas.nth(1)).to_have_text("3")  # total
        expect(celdas.nth(2)).to_have_text("1")  # disponible
        expect(celdas.nth(3)).to_have_text("1")  # reservado
        expect(celdas.nth(4)).to_contain_text("1")  # vendido (33%)
        expect(celdas.nth(4)).to_contain_text("33%")
        # Precio promedio: solo los 2 con precio cargado (10000+20000)/2
        expect(celdas.nth(5)).to_contain_text("USD 15.000")
    finally:
        borrar_lote_de_prueba(disponible)
        borrar_lote_de_prueba(reservado)
        borrar_lote_de_prueba(vendido)
