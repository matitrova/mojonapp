"""
Test de Playwright para "Plantillas de WhatsApp con datos precargados"
(js/crm-metricas.js, plantillasMensaje/linkWhatsapp; js/crm-formulario.js,
actualizarPlantillasWhatsapp) — segunda de 3 ideas inspiradas en el gap
de Tokko Broker: versión gratis de sus "envíos automáticos", sin API de
WhatsApp Business — wa.me ya soporta precargar el texto con ?text=.
"""

import uuid
from urllib.parse import unquote

import pytest
from playwright.sync_api import expect

from conftest import abrir_menu, soltar_el_mouse

# Todos los tests de este archivo arrancan logueados: el login se hace
# una sola vez por corrida (ver estado_de_sesion en conftest.py).
pytestmark = pytest.mark.con_sesion


def _loguearse(page, base_url):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de arriba).
    Se conserva el nombre para no tocar los llamados."""
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()


def test_sin_telefono_no_se_muestran_plantillas(page, base_url):
    _loguearse(page, base_url)
    abrir_menu(page)
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    page.locator("#btn-agregar-contacto").click()
    expect(page.locator("#crm-plantillas-whatsapp")).to_be_hidden()


def test_plantilla_de_seguimiento_precarga_nombre_y_telefono(page, base_url):
    nombre = f"PLANTILLA-{uuid.uuid4().hex[:8]}"
    _loguearse(page, base_url)
    abrir_menu(page)
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    page.locator("#btn-agregar-contacto").click()
    page.locator("#contacto-nombre").fill(nombre)
    page.locator("#contacto-telefono").fill("3511234567")

    expect(page.locator("#crm-plantillas-whatsapp")).to_be_visible()
    opciones = page.locator("#crm-select-plantilla option").all_inner_texts()
    assert opciones == ["Seguimiento", "Primer contacto"]  # sin "Recordatorio de visita": no está en etapa "Visita"

    href = page.locator("#crm-btn-enviar-plantilla").get_attribute("href")
    assert href.startswith("https://wa.me/5493511234567?text=")
    texto = unquote(href.split("?text=", 1)[1])
    assert nombre in texto


def test_recordatorio_de_visita_solo_aparece_con_esa_etapa_y_fecha(page, base_url):
    _loguearse(page, base_url)
    abrir_menu(page)
    page.locator("#btn-abrir-crm").click()
    soltar_el_mouse(page)
    page.locator("#btn-agregar-contacto").click()
    page.locator("#contacto-nombre").fill("Juan")
    page.locator("#contacto-telefono").fill("3511234567")

    opciones = page.locator("#crm-select-plantilla option")
    expect(opciones).to_have_count(2)

    page.locator("#contacto-estado").select_option("visita")
    page.locator("#contacto-seguimiento").fill("2026-09-20")
    expect(opciones).to_have_count(3)

    page.locator("#crm-select-plantilla").select_option("recordatorio_visita")
    href = page.locator("#crm-btn-enviar-plantilla").get_attribute("href")
    texto = unquote(href.split("?text=", 1)[1])
    assert "20/9/2026" in texto
