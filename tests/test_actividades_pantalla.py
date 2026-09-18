"""
Integración de la pantalla "Actividades".

Las reglas puras están en test_actividad_equipo.py. Acá se prueba que la
pantalla abra, lea los eventos reales de la auditoría y arme el resumen,
y que respete el permiso: es información de conducción (quién trabajó y
en qué), no algo que deba ver cualquiera con sesión.
"""

import pytest
from playwright.sync_api import expect

from conftest import soltar_el_mouse

pytestmark = pytest.mark.con_sesion


def _abrir_actividades(page, base_url):
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()
    page.locator("#cerrar-panel-dashboard").click()
    page.locator("#btn-menu").click()
    page.locator("#btn-abrir-actividades").click()
    soltar_el_mouse(page)
    expect(page.locator("#panel-actividades")).to_be_visible()


def test_la_pantalla_abre_y_resume_la_actividad_real(page, base_url):
    """Lee los eventos que la app ya venía grabando.

    No se siembran eventos: la corrida de la suite genera los suyos
    (crear y borrar lotes deja auditoría), así que si el resumen
    funciona, algo tiene que mostrar. Lo que se afirma es la estructura,
    no un número puntual, para no depender de cuántos eventos hubo.
    """
    _abrir_actividades(page, base_url)
    expect(page.locator("#actividades-error")).to_be_hidden()

    # Esperar a que la pantalla se asiente antes de contar. count() no
    # espera —a diferencia de expect()—, así que sin esto cuenta cero
    # mientras Firestore todavía está contestando, y el test concluye
    # "no hay actividad" teniendo 300 eventos.
    page.wait_for_selector("[data-testid='actividad-persona'], #actividades-vacio:not(.oculto)")
    hay_personas = page.locator("[data-testid='actividad-persona']").count()
    if hay_personas == 0:
        expect(page.locator("#actividades-vacio")).to_be_visible()
    else:
        # Cada fila tiene quién, cuántas acciones y el resumen en palabras.
        primera = page.locator("[data-testid='actividad-persona']").first
        expect(primera.locator("strong")).not_to_be_empty()
        expect(primera.locator(".actividad-total")).to_contain_text("acci")
        expect(primera.locator(".actividad-en-palabras")).not_to_be_empty()


def test_el_grafico_aparece_solo_con_mas_de_un_dia(page, base_url):
    """Con un solo día una barra sola no dice nada que el número no diga
    mejor, así que el gráfico se esconde."""
    _abrir_actividades(page, base_url)
    expect(page.locator("#actividades-grafico")).to_be_hidden()

    page.locator("[data-testid='actividades-7']").click()
    expect(page.locator("#actividades-grafico")).to_be_visible()
    # Siete columnas, incluidas las de los días sin actividad.
    expect(page.locator(".actividad-dia")).to_have_count(7)

    page.locator("[data-testid='actividades-30']").click()
    expect(page.locator(".actividad-dia")).to_have_count(30)


def test_la_seccion_tiene_su_propia_url(page, base_url):
    """Mismo criterio que el resto de la app (ver js/router.js): cada
    sección tiene URL propia y se puede entrar directo."""
    _abrir_actividades(page, base_url)
    assert page.url.endswith("/actividades")

    page.goto(f"{base_url}/actividades")
    expect(page.locator("#panel-actividades")).to_be_visible()
