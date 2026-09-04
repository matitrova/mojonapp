"""
Tests de Playwright (pytest) para el CRM (js/crm.js): contactos + pipeline
visual. Mismo criterio que el resto de la suite (ver test_lotes.py y
conftest.py): corre contra el proyecto real de Firebase (no hay emulador en
esta máquina), así que cada test siembra y borra sus propios datos.

Cubren: crear un contacto desde el panel y verlo en la columna "Nuevo",
moverlo de etapa con el selector de la tarjeta (y que quede reflejado tanto
en el pipeline como en Firestore), y que "Agregar interesado" en la ficha de
un lote (js/ficha.js) alimente el CRM automáticamente.
"""

import uuid

from playwright.sync_api import expect

from conftest import (
    LOTE_PRUEBA_DATOS,
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
    borrar_contacto_de_prueba,
    buscar_contacto_doc_id_por_nombre,
)


def _loguearse(page, base_url):
    page.goto(base_url)
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()
    # Mismo motivo que en test_lotes.py: el login abre el dashboard
    # automático y tapa el resto de la UI.
    page.locator("#cerrar-panel-dashboard").click()


def _abrir_crm(page):
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-crm").click()
    expect(page.locator("#panel-crm")).to_be_visible()


def test_crear_contacto_y_verlo_en_la_columna_nuevo(page, base_url):
    nombre = f"TEST-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator("#btn-agregar-contacto").click()
        page.locator("#contacto-nombre").fill(nombre)
        page.locator("#contacto-guardar-btn").click()

        columna_nuevo = page.locator('[data-testid="crm-columna-nuevo"]')
        expect(columna_nuevo.locator(".crm-tarjeta", has_text=nombre)).to_have_count(1)

        # Se busca en Firestore DESPUÉS de la aserción del pipeline a
        # propósito (mismo criterio que test_corredor_logueado_puede_
        # cargar_un_lote): si la aserción fallara con esto al revés, el
        # "finally" nunca llegaría a limpiar el contacto creado.
        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None, "El contacto creado no apareció en Firestore."
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)


def test_mover_contacto_actualiza_la_columna(page, base_url):
    nombre = f"TEST-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        page.locator("#btn-agregar-contacto").click()
        page.locator("#contacto-nombre").fill(nombre)
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator(".crm-tarjeta", has_text=nombre)).to_have_count(1)

        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None

        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta).to_be_visible()
        tarjeta.locator("select").select_option("contactado")

        expect(
            page.locator('[data-testid="crm-columna-contactado"]').locator(".crm-tarjeta", has_text=nombre)
        ).to_have_count(1)
        expect(
            page.locator('[data-testid="crm-columna-nuevo"]').locator(".crm-tarjeta", has_text=nombre)
        ).to_have_count(0)
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)


def test_agregar_interesado_alimenta_el_crm(page, base_url, lote_sembrado):
    nombre = f"TEST-{uuid.uuid4().hex[:8]}"
    telefono = f"11{uuid.uuid4().int % 10**8:08d}"
    doc_id_contacto = None
    try:
        _loguearse(page, base_url)

        # Mismo patrón que abrir_ficha_desde_lista en test_lotes.py: entra
        # por "Ver como lista" en vez de tocar el polígono en el mapa, para
        # no depender de dónde haya quedado encuadrado el mapa.
        page.locator("#btn-menu").click()
        page.locator("#btn-ver-lista").click()
        page.locator("#filtro-cantidad").select_option("0")
        page.locator(f'tr[data-lote-id="{lote_sembrado["doc_id"]}"]').click()

        page.locator("#interesado-nombre").fill(nombre)
        page.locator("#interesado-telefono").fill(telefono)
        page.locator("[data-testid='interesado-guardar']").click()
        expect(page.locator("#lista-interesados")).to_contain_text(nombre)

        # crearContactoDesdeInteresado (js/crm.js) es fire-and-forget — no
        # bloquea el guardado del interesado, así que puede terminar un
        # instante después de que la UI ya muestra el interesado guardado.
        doc_id_contacto = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id_contacto is not None, "Agregar interesado no creó el contacto en el CRM."

        page.locator("#cerrar-ficha").click()
        _abrir_crm(page)
        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id_contacto}"]')
        expect(tarjeta).to_be_visible()
        expect(tarjeta).to_contain_text(f"Manzana {LOTE_PRUEBA_DATOS['manzana']} — Lote {LOTE_PRUEBA_DATOS['lote']}")
    finally:
        if doc_id_contacto:
            borrar_contacto_de_prueba(doc_id_contacto)
