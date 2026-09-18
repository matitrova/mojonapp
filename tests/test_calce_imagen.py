"""Las reglas del calce de la foto satelital (js/calce-imagen.js).

QUÉ SE ESTÁ PROBANDO Y POR QUÉ IMPORTA. La foto satelital de Esri no
coincide con el catastro —hasta 20-25 metros en algunas zonas de San
Luis, verificado el 2026-09-18— y como no se puede medir el corrimiento
solo, lo calza el corredor a mano, una vez por zona.

Los dos errores que este módulo no puede cometer:

  1. Guardar píxeles en vez de metros. El calce se vería bien en el zoom
     donde se hizo y se rompería en todos los demás, que es justo cuando
     la gente lo mira.
  2. Aceptar un valor cualquiera de la base y mover la foto a la otra
     punta del mapa. Un documento con basura tiene que dar "sin
     corrección".

Módulo puro: se prueba importándolo suelto, sin Firestore ni mapa.
"""

import math

import pytest

MODULO = "/js/calce-imagen.js"


@pytest.fixture
def evaluar(page, base_url):
    page.goto(base_url)

    def _correr(expresion, *args):
        return page.evaluate(
            f"""(args) => import('{MODULO}').then((m) => {{ const f = {expresion}; return f(m, ...args); }})""",
            list(args),
        )

    return _correr


# --- La celda de calibración ---------------------------------------------


def test_dos_puntos_de_la_misma_manzana_caen_en_la_misma_celda(evaluar):
    """Si no, habría que calibrar de nuevo cada vez que te movés una
    cuadra, y la función no serviría para nada."""
    a = evaluar("(m, lat, lon) => m.celdaDe(lat, lon)", -32.3415, -65.0125)
    b = evaluar("(m, lat, lon) => m.celdaDe(lat, lon)", -32.3420, -65.0130)
    assert a == b


def test_dos_pueblos_distintos_caen_en_celdas_distintas(evaluar):
    """El corrimiento no es el mismo en cada lugar: es el motivo entero
    de que la calibración sea por zona."""
    merlo = evaluar("(m, lat, lon) => m.celdaDe(lat, lon)", -32.3415, -65.0125)
    carpinteria = evaluar("(m, lat, lon) => m.celdaDe(lat, lon)", -32.4101, -65.0799)
    potrero = evaluar("(m, lat, lon) => m.celdaDe(lat, lon)", -33.2170, -66.2400)
    assert len({merlo, carpinteria, potrero}) == 3


def test_la_celda_sirve_como_id_de_firestore(evaluar):
    """Va a ser el nombre de un documento: sin barras, sin puntos, sin
    espacios. Un id inválido falla al guardar y recién se notaría
    cuando alguien intenta calibrar."""
    for lat, lon in [(-32.3415, -65.0125), (-33.6757, -65.4578), (0.0, 0.0), (45.5, 120.25)]:
        celda = evaluar("(m, lat, lon) => m.celdaDe(lat, lon)", lat, lon)
        assert celda, f"no dio celda para {lat},{lon}"
        assert "/" not in celda and "." not in celda and " " not in celda, celda


def test_una_coordenada_invalida_no_da_celda(evaluar):
    for lat, lon in [(None, -65.0), (float("nan"), -65.0)]:
        valor = None if lat is None else "NaN"
        celda = evaluar(
            "(m, lat, lon) => m.celdaDe(lat === 'NaN' ? NaN : lat, lon)", valor, lon
        )
        assert celda is None


# --- Metros a píxeles ----------------------------------------------------


def test_un_pixel_mide_alrededor_de_un_metro_en_zoom_17(evaluar):
    """Es el zoom donde las tiles de Esri son las nativas en San Luis
    (ver maxNativeZoom en js/mapa.js), así que es el número que más se
    usa. Si esto se va de escala, TODO el calce se va de escala."""
    mpp = evaluar("(m, lat, z) => m.metrosPorPixel(lat, z)", -32.34, 17)
    assert 0.9 < mpp < 1.1, mpp


def test_acercarse_un_zoom_parte_al_medio_el_metro_por_pixel(evaluar):
    a = evaluar("(m, lat, z) => m.metrosPorPixel(lat, z)", -32.34, 17)
    b = evaluar("(m, lat, z) => m.metrosPorPixel(lat, z)", -32.34, 18)
    assert math.isclose(a / b, 2.0, rel_tol=1e-9)


def test_los_mismos_metros_son_mas_pixeles_cuanto_mas_cerca(evaluar):
    """ES EL PUNTO DEL MÓDULO. La corrección se guarda en metros porque
    los metros no cambian; los píxeles sí. Guardar píxeles haría que el
    calce se rompiera al hacer zoom."""
    corr = {"este_m": 10, "norte_m": 0}
    z17 = evaluar("(m, c, lat, z) => m.corrimientoEnPixeles(c, lat, z)", corr, -32.34, 17)
    z19 = evaluar("(m, c, lat, z) => m.corrimientoEnPixeles(c, lat, z)", corr, -32.34, 19)
    assert z19["x"] == pytest.approx(z17["x"] * 4, abs=1)
    assert z17["x"] > 0, "correr al este tiene que dar x positivo"


def test_correr_al_norte_sube_en_pantalla(evaluar):
    """El eje Y de la pantalla va al revés que la latitud: crece hacia
    abajo. Confundir el signo acá deja el calce simétricamente mal, que
    es el error más fácil de no ver."""
    r = evaluar(
        "(m, c, lat, z) => m.corrimientoEnPixeles(c, lat, z)",
        {"este_m": 0, "norte_m": 10},
        -32.34,
        17,
    )
    assert r["y"] < 0, f"al norte tiene que ser y negativo, dio {r['y']}"


def test_sin_corrimiento_no_se_mueve_nada(evaluar):
    r = evaluar(
        "(m, c, lat, z) => m.corrimientoEnPixeles(c, lat, z)", {}, -32.34, 17
    )
    assert r == {"x": 0, "y": 0}


# --- Validar lo que viene de la base ------------------------------------


def test_un_corrimiento_normal_se_acepta(evaluar):
    r = evaluar("(m, v) => m.corrimientoValido(v)", {"este_m": -6, "norte_m": 25})
    assert r == {"este_m": -6, "norte_m": 25}


@pytest.mark.parametrize(
    "basura",
    [
        None,
        {},
        {"este_m": "mucho", "norte_m": 0},
        {"este_m": 5000, "norte_m": 0},
        {"este_m": 0, "norte_m": -9999},
        {"este_m": 0, "norte_m": 0},
    ],
)
def test_lo_que_no_sirve_da_sin_correccion(evaluar, basura):
    """Se valida AL LEER y no solo al escribir: un documento editado a
    mano o de un formato viejo tiene que dejar la foto donde está, no
    mandarla a la otra punta del mapa."""
    assert evaluar("(m, v) => m.corrimientoValido(v)", basura) is None


# --- Mover con las flechas ----------------------------------------------


def test_cada_flecha_mueve_un_metro_en_su_direccion(evaluar):
    base = {"este_m": 0, "norte_m": 0}
    assert evaluar("(m, a, d) => m.conElPaso(a, d)", base, "este")["este_m"] == 1
    assert evaluar("(m, a, d) => m.conElPaso(a, d)", base, "oeste")["este_m"] == -1
    assert evaluar("(m, a, d) => m.conElPaso(a, d)", base, "norte")["norte_m"] == 1
    assert evaluar("(m, a, d) => m.conElPaso(a, d)", base, "sur")["norte_m"] == -1


def test_una_flecha_no_toca_el_otro_eje(evaluar):
    r = evaluar("(m, a, d) => m.conElPaso(a, d)", {"este_m": 7, "norte_m": -3}, "norte")
    assert r["este_m"] == 7


def test_en_el_tope_la_flecha_deja_de_hacer_efecto(evaluar):
    """Se queda en el tope y no rebota: que una flecha no haga nada se
    entiende, que el valor salte a otra cosa no."""
    tope = evaluar("(m) => m.CORRIMIENTO_MAXIMO_M")
    r = evaluar("(m, a, d) => m.conElPaso(a, d)", {"este_m": tope, "norte_m": 0}, "este")
    assert r["este_m"] == tope


def test_desde_el_tope_se_puede_volver(evaluar):
    tope = evaluar("(m) => m.CORRIMIENTO_MAXIMO_M")
    r = evaluar("(m, a, d) => m.conElPaso(a, d)", {"este_m": tope, "norte_m": 0}, "oeste")
    assert r["este_m"] == tope - 1


# --- Lo que se le muestra a la persona -----------------------------------


def test_el_texto_dice_para_donde_y_cuanto(evaluar):
    t = evaluar("(m, c) => m.comoTexto(c)", {"este_m": -6, "norte_m": 25})
    assert "25" in t and "norte" in t
    assert "6" in t and "oeste" in t


def test_sin_corrimiento_lo_dice_con_palabras(evaluar):
    assert evaluar("(m, c) => m.comoTexto(c)", {"este_m": 0, "norte_m": 0}) == "sin corrección"
    assert evaluar("(m, c) => m.comoTexto(c)") == "sin corrección"


def test_no_menciona_el_eje_que_no_se_movio(evaluar):
    """\"5 m al norte y 0 m al este\" se lee como si hubiera pasado algo
    en los dos ejes."""
    t = evaluar("(m, c) => m.comoTexto(c)", {"este_m": 0, "norte_m": 5})
    assert "este" not in t and "oeste" not in t
