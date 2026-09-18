"""
Tests de la decisión "qué proyecto Firebase le toca a cada dominio"
(js/firebase-proyecto.js).

POR QUÉ ESTO TIENE TESTS PROPIOS. Es la única línea de código que decide
si la app escribe en los datos reales del cliente o en una base
desechable. Equivocarla tiene dos formas, las dos malas:

  - producción apuntando a pruebas: el cliente ve la app vacía,
  - una vista previa apuntando a producción: se tocan datos reales
    creyendo que se está en un ambiente de prueba (esto último pasaba de
    verdad, hasta que se separaron los proyectos).

La lista es de PRODUCCIÓN y todo lo demás cae en pruebas, a propósito:
así un dominio inesperado falla de forma visible (app vacía) en lugar de
corromper datos en silencio. El último caso de la tabla cubre eso.

Estos tests no necesitan sesión ni Firestore: cargan el módulo y le
preguntan por cada dominio. Los .pages.dev no se pueden simular
navegando —.dev es un TLD con HTTPS forzado y el server de prueba es
HTTP—, y por eso la decisión vive en un módulo aparte y puro.
"""

from playwright.sync_api import expect  # noqa: F401  (consistencia con el resto de la suite)

# (dominio, proyecto esperado, por qué)
DOMINIOS = [
    ("mojonapp.com.ar", "mojonapp", "el dominio real del cliente"),
    ("www.mojonapp.com.ar", "mojonapp", "el mismo con www"),
    ("mojonapp.pages.dev", "mojonapp", "el alias de Pages de la rama de producción"),
    ("preview.mojonapp.pages.dev", "mojonapptest", "la vista previa de la rama preview"),
    ("a1b2c3d4.mojonapp.pages.dev", "mojonapptest", "la vista previa de un deploy puntual"),
    ("localhost", "mojonapptest", "abrir la app en local"),
    ("127.0.0.1", "mojonapptest", "lo mismo por IP"),
    ("mojonapp.com.ar.atacante.com", "mojonapptest", "un dominio que IMITA al real"),
    ("dominio-nuevo-sin-configurar.com", "mojonapptest", "un dominio nuevo: el lado seguro"),
]


def _proyecto_para(page, base_url, hostname):
    page.goto(base_url)
    return page.evaluate(
        """(host) => import('/js/firebase-proyecto.js')
             .then((m) => m.configPara(host).projectId)""",
        hostname,
    )


def test_cada_dominio_va_al_proyecto_que_le_corresponde(page, base_url):
    page.goto(base_url)
    reales = page.evaluate(
        """(dominios) => import('/js/firebase-proyecto.js')
             .then((m) => dominios.map((d) => m.configPara(d).projectId))""",
        [d for d, _, _ in DOMINIOS],
    )
    for (dominio, esperado, motivo), real in zip(DOMINIOS, reales):
        assert real == esperado, f"{dominio} ({motivo}) fue a {real}, se esperaba {esperado}"


def test_solo_los_dominios_de_produccion_llevan_a_produccion(page, base_url):
    """El complemento del test de arriba: que la lista no tenga de más.

    Si alguien agrega un dominio a DOMINIOS_DE_PRODUCCION sin pensarlo,
    acá se ve — son los únicos tres que pueden tocar datos del cliente.
    """
    page.goto(base_url)
    lista = page.evaluate(
        "() => import('/js/firebase-proyecto.js').then((m) => m.DOMINIOS_DE_PRODUCCION)"
    )
    assert sorted(lista) == sorted(["mojonapp.com.ar", "www.mojonapp.com.ar", "mojonapp.pages.dev"])


def test_un_dominio_que_imita_al_real_no_entra(page, base_url):
    """La comparación es por igualdad exacta, no "termina con" ni
    "contiene": un dominio como mojonapp.com.ar.atacante.com no puede
    quedar apuntado a la base del cliente."""
    assert _proyecto_para(page, base_url, "mojonapp.com.ar.atacante.com") == "mojonapptest"
    assert _proyecto_para(page, base_url, "no-mojonapp.com.ar") == "mojonapptest"
    assert _proyecto_para(page, base_url, "mojonapp.com.ar") == "mojonapp"
