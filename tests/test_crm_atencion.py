"""
Test de Playwright para "control de tiempos de atención" en el CRM (idea
propia, investigada en las funcionalidades de Tokko Broker antes de
armarla — ver feedback_buscar_inspiracion_real: "Módulo de
oportunidades... controlar los tiempos de atención"): un contacto
"nuevo" sin ninguna actividad registrada en más de 24hs se marca "Sin
atender", distinto de "estancado" (que mide silencio DESPUÉS de la
primera gestión). También cubre el resumen de última actividad en la
tarjeta.
"""

import datetime
import uuid

from playwright.sync_api import expect

from conftest import (
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
    _uid_de_prueba,
    borrar_contacto_de_prueba,
    crear_contacto_de_prueba,
)


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


def _datos_base(nombre, *, horas_atras, estado="nuevo", actividades=None):
    fecha = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=horas_atras)).isoformat()
    return {
        "nombre": nombre,
        "telefono": None,
        "email": None,
        "estado": estado,
        "motivo_perdido": None,
        "proximo_seguimiento": None,
        "lotes_interes": [],
        "actividades": actividades or [],
        "asignado_a": _uid_de_prueba(),
        "fecha_creacion": fecha,
        "fecha_actualizacion": fecha,
    }


def test_contacto_nuevo_sin_actividad_hace_mas_de_24h_se_marca_sin_atender(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    sin_atender = crear_contacto_de_prueba(_datos_base(f"SLA-VIEJO-{marcador}", horas_atras=30))
    recien_llegado = crear_contacto_de_prueba(_datos_base(f"SLA-NUEVO-{marcador}", horas_atras=1))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        tarjeta_vieja = page.locator(f'[data-testid="crm-tarjeta-{sin_atender}"]')
        tarjeta_nueva = page.locator(f'[data-testid="crm-tarjeta-{recien_llegado}"]')
        expect(tarjeta_vieja.locator(".crm-badge-sin-atender")).to_be_visible()
        expect(tarjeta_vieja).to_contain_text("Sin atender +24h")
        expect(tarjeta_nueva.locator(".crm-badge-sin-atender")).to_have_count(0)

        # La métrica de arriba también lo cuenta.
        stats = page.locator("#crm-stats")
        expect(stats).to_contain_text("Sin atender")
    finally:
        borrar_contacto_de_prueba(sin_atender)
        borrar_contacto_de_prueba(recien_llegado)


def test_contacto_con_actividad_no_se_marca_sin_atender_y_muestra_el_resumen(page, base_url):
    marcador = uuid.uuid4().hex[:8]
    actividades = [
        {
            "tipo": "llamada",
            "texto": "Preguntó por financiación en cuotas.",
            "fecha": (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=30)).isoformat(),
            "autor_email": TEST_USER_EMAIL,
        }
    ]
    doc_id = crear_contacto_de_prueba(_datos_base(f"SLA-ATENDIDO-{marcador}", horas_atras=30, actividades=actividades))
    try:
        _loguearse(page, base_url)
        _abrir_crm(page)

        tarjeta = page.locator(f'[data-testid="crm-tarjeta-{doc_id}"]')
        expect(tarjeta.locator(".crm-badge-sin-atender")).to_have_count(0)
        expect(tarjeta).to_contain_text("Preguntó por financiación en cuotas.")
    finally:
        borrar_contacto_de_prueba(doc_id)
