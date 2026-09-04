"""
Test de Playwright para "Cercanías" (distanciasReferenciaCercanas en
js/distancias-referencia.js): distancia real a la ruta pavimentada y a la
localidad más cercana, sacada en vivo de Overpass API (OpenStreetMap).

Interceptamos la llamada a Overpass en vez de depender del servicio real:
la latencia pública de Overpass es muy variable (medido en vivo: entre 2s y
16s+, a veces 504) y este test no debería ser flaky por eso — lo que se
prueba acá es que MojonApp arma bien el pedido y pinta bien la respuesta,
no la disponibilidad de un servicio de terceros.
"""

import json

from playwright.sync_api import expect

from conftest import borrar_lote_de_prueba, crear_lote_de_prueba

RESPUESTA_OVERPASS_SIMULADA = {
    "elements": [
        {
            "type": "way",
            "id": 1,
            "tags": {"highway": "primary"},
            "center": {"lat": -32.3505, "lon": -65.02},
        },
        {
            "type": "node",
            "id": 2,
            "tags": {"place": "town", "name": "Pueblo De Prueba"},
            "lat": -32.36,
            "lon": -65.02,
        },
    ]
}


def _abrir_ficha_desde_lista(page, doc_id):
    page.locator("#btn-menu").click()
    page.locator("#btn-ver-lista").click()
    page.locator("#filtro-cantidad").select_option("0")
    page.locator(f'tr[data-lote-id="{doc_id}"]').click()


def test_cercanias_muestra_ruta_y_localidad_de_la_respuesta(page, base_url, lote_sembrado):
    page.route(
        "**/overpass-api.de/**",
        lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(RESPUESTA_OVERPASS_SIMULADA)),
    )

    page.goto(base_url)
    _abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])

    cercanias = page.locator("#ficha-cercanias")
    expect(cercanias).to_be_visible(timeout=10000)
    expect(cercanias).to_contain_text("Ruta pavimentada")
    expect(cercanias).to_contain_text("Pueblo De Prueba")


def test_cercanias_no_muestra_nada_si_overpass_falla(page, base_url, lote_sembrado):
    # Simula el 504 que se vio en vivo cuando el servicio público está
    # sobrecargado — la ficha tiene que seguir andando normal, sin la
    # sección de "Cercanías".
    page.route("**/overpass-api.de/**", lambda route: route.fulfill(status=504, body="Gateway Timeout"))

    page.goto(base_url)
    _abrir_ficha_desde_lista(page, lote_sembrado["doc_id"])

    expect(page.locator("#ficha-titulo")).to_be_visible()
    page.wait_for_timeout(1000)
    expect(page.locator("#ficha-cercanias-dt")).to_be_hidden()
    expect(page.locator("#ficha-cercanias")).to_be_hidden()
