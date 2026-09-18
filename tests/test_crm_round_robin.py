"""
Test de Playwright para el reparto automático de interesados nuevos
entre el equipo (js/crm.js) — pedido explícito del usuario ("Arregla
eso", respondiendo a que "round-robin de leads" quedaba pendiente de
confirmar). Reparte por CARGA actual (menos contactos activos, no una
cola con puntero guardado aparte — evita necesitar una colección/regla
nueva en firestore.rules) y SOLO aplica a "Agregar interesado" desde la
ficha de un lote, no a "+ Nuevo contacto" del CRM.

Prueba la lógica de selección (elegirMenosCargado, exportada para esto)
en aislado, sin leer Firestore — depende de qué corredores reales
existan en este proyecto (ver mojonapp_estado_proyecto), así que no
tiene sentido fijar de antemano quién "gana" contra datos reales; la
cobertura de que el resultado realmente se usa como asignado_a al crear
el contacto ya la da test_agregar_interesado_alimenta_el_crm en
test_crm.py (ajustado para mirar "Todos", no "Mis contactos", porque el
asignado ya no tiene por qué ser quien lo cargó).
"""

from conftest import TEST_USER_PASSWORD
import pytest
from playwright.sync_api import expect

# Todos los tests de este archivo arrancan logueados: el login se hace
# una sola vez por corrida (ver estado_de_sesion en conftest.py).
pytestmark = pytest.mark.con_sesion


def _loguearse(page, base_url):
    """Ya NO se loguea: el contexto viene con la sesión puesta (ver
    estado_de_sesion en conftest.py y el marcador con_sesion de arriba).
    Se conserva el nombre para no tocar los llamados."""
    page.goto(base_url)
    expect(page.locator("#sesion-activa")).to_be_visible()


def test_elegir_menos_cargado_favorece_al_de_menos_contactos(page, base_url):
    page.goto(base_url)
    resultado = page.evaluate(
        """async () => {
            const mod = await import("./js/crm.js");
            return {
                vacio: mod.elegirMenosCargado({}),
                simple: mod.elegirMenosCargado({a: 3, b: 1, c: 5}),
                empate: mod.elegirMenosCargado({x: 2, y: 2}),
                todosEnCero: mod.elegirMenosCargado({m: 0, n: 0, o: 0}),
            };
        }"""
    )
    assert resultado["vacio"] is None
    assert resultado["simple"] == "b"
    # Empate: gana el primero en el orden en que se armó el objeto — no
    # es azar, es predecible (mismo criterio que un Array.sort estable).
    assert resultado["empate"] == "x"
    assert resultado["todosEnCero"] == "m"
