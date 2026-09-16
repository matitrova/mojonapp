"""
Test de Playwright para "Pegar mail de portal" (js/ia-lead.js) — la
consulta que llegó por mail desde ZonaProp/MercadoLibre se convierte en
un contacto del CRM con los datos ya cargados, para revisar y guardar.

El endpoint que hace la llamada paga vive en functions/ia-lead.js, una
Cloudflare Pages Function, y la suite corre contra `python -m
http.server`, que no ejecuta Pages Functions (ver tests/conftest.py y el
mismo criterio en test_ia_descripcion.py). Así que acá se mockea con
page.route(): lo que se prueba es que el formulario quede bien cargado,
que un error se vea, y que el contacto guardado quede marcado con el
origen nuevo — no la llamada al proveedor, que solo se puede verificar
sobre el sitio ya desplegado y con un mail real de un portal.
"""

import json
import re
import uuid

from playwright.sync_api import expect

from conftest import (
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
    borrar_contacto_de_prueba,
    buscar_contacto_doc_id_por_nombre,
)

MAIL_PEGADO = """De: ZonaProp <no-reply@zonaprop.com.ar>
Asunto: Nueva consulta por tu aviso

Juana Pérez está interesada en Lote 12, Manzana B - Potrero de los Funes.
Teléfono: 2664 55-1234
Email: juana.perez@example.com
Mensaje: Hola, quería saber si tiene luz y agua, y si aceptan financiación.
"""


def _lead(nombre):
    return {
        "nombre": nombre,
        "telefono": "2664 55-1234",
        "email": "juana.perez@example.com",
        "propiedad": "Lote 12, Manzana B - Potrero de los Funes",
        "consulta": "Quiere saber si tiene luz y agua, y si aceptan financiación.",
    }


def _loguearse(page, base_url):
    page.goto(base_url)
    page.locator("#btn-abrir-login").click()
    page.locator("#login-email").fill(TEST_USER_EMAIL)
    page.locator("#login-password").fill(TEST_USER_PASSWORD)
    page.locator("[data-testid='login-submit']").click()
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def _abrir_crm(page):
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-crm").click()
    expect(page.locator("#panel-crm")).to_be_visible()


def _mockear_endpoint(page, *, status, cuerpo):
    page.route(
        "**/ia-lead",
        lambda ruta: ruta.fulfill(
            status=status,
            content_type="application/json",
            body=json.dumps(cuerpo),
        ),
    )


def _pegar_y_convertir(page):
    page.locator("#btn-pegar-mail").click()
    expect(page.locator("#crm-pegar-mail")).to_be_visible()
    page.locator("#crm-pegar-mail-texto").fill(MAIL_PEGADO)
    page.locator("#btn-convertir-mail").click()


def test_pegar_un_mail_deja_el_formulario_cargado(page, base_url):
    nombre = f"LEAD-MAIL-{uuid.uuid4().hex[:8]}"
    _mockear_endpoint(page, status=200, cuerpo={"lead": _lead(nombre)})
    _loguearse(page, base_url)
    _abrir_crm(page)

    _pegar_y_convertir(page)

    expect(page.locator("#crm-vista-form")).to_be_visible()
    expect(page.locator("#contacto-nombre")).to_have_value(nombre)
    expect(page.locator("#contacto-telefono")).to_have_value("2664 55-1234")
    expect(page.locator("#contacto-email")).to_have_value("juana.perez@example.com")
    # La consulta y la propiedad van a la nota fijada: es lo único que se
    # guarda junto con el formulario de un contacto que todavía no existe.
    #
    # Con regex y to_have_value, no to_contain_text: en un <textarea> que
    # cargó el JS, to_contain_text mira el texto del DOM (vacío) y no el
    # value — pasa lo mismo con cualquier campo de estos.
    expect(page.locator("#contacto-nota-fijada")).to_have_value(re.compile("Potrero de los Funes"))
    expect(page.locator("#contacto-nota-fijada")).to_have_value(re.compile("financiación"))
    # El bloque de pegar se cierra recién con el formulario ya abierto.
    expect(page.locator("#crm-pegar-mail")).to_be_hidden()


def test_error_del_endpoint_se_avisa_y_el_boton_vuelve_a_quedar_usable(page, base_url):
    _mockear_endpoint(
        page,
        status=422,
        cuerpo={"error": "No se encontraron datos de contacto en ese texto."},
    )
    _loguearse(page, base_url)
    _abrir_crm(page)

    _pegar_y_convertir(page)

    expect(page.locator("#crm-pegar-mail-mensaje")).to_be_visible()
    expect(page.locator("#crm-pegar-mail-mensaje")).to_contain_text("No se encontraron datos")
    # No se abre el formulario con un lead que no existe, y el texto
    # pegado sigue ahí para no tener que ir a buscar el mail de nuevo.
    expect(page.locator("#crm-vista-form")).to_be_hidden()
    expect(page.locator("#crm-pegar-mail-texto")).to_have_value(MAIL_PEGADO)
    expect(page.locator("#btn-convertir-mail")).to_be_enabled()
    expect(page.locator("#btn-convertir-mail")).to_contain_text("Convertir en contacto")


def test_el_contacto_guardado_queda_con_origen_consulta_de_portal(page, base_url):
    """El contacto que sale de un mail no es un alta manual — tiene que
    quedar marcado con su propio origen (ver ORIGENES en js/crm.js), si
    no "de dónde vienen mis consultas" deja de ser una pregunta que el
    CRM pueda contestar."""
    nombre = f"LEAD-ORIGEN-{uuid.uuid4().hex[:8]}"
    doc_id = None
    try:
        _mockear_endpoint(page, status=200, cuerpo={"lead": _lead(nombre)})
        _loguearse(page, base_url)
        _abrir_crm(page)

        _pegar_y_convertir(page)
        expect(page.locator("#contacto-nombre")).to_have_value(nombre)
        page.locator("#contacto-guardar-btn").click()
        expect(page.locator("#crm-vista-kanban")).to_be_visible()

        doc_id = buscar_contacto_doc_id_por_nombre(nombre)
        assert doc_id is not None

        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta.locator(".crm-tarjeta-origen")).to_have_text("📧")

        page.locator("#crm-filtro-origen").select_option("manual")
        expect(tarjeta).to_be_hidden()
        page.locator("#crm-filtro-origen").select_option("email")
        expect(tarjeta).to_be_visible()
    finally:
        if doc_id:
            borrar_contacto_de_prueba(doc_id)
