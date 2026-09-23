"""Las decisiones puras que salieron de la tanda 2 de la bitácora.

QUÉ SE PRUEBA ACÁ Y QUÉ NO. La tanda 2 son 33 defectos y la mayoría son
de CSS: se verifican mirando la pantalla, no con asserts. Lo que sí tiene
una decisión adentro —un texto que se arma, un código que se traduce a
algo legible— se prueba acá, sin Firestore, importando el módulo suelto.

Los de layout quedaron verificados a ojo y con mediciones en el
navegador; los que miden geometría viven en test_bitacora_rompe.py.
"""

import pytest

VACIO = "/js/estado-vacio.js"
CATASTRO = "/js/catastro-normalizacion.js"


@pytest.fixture
def evaluar(page, base_url):
    page.goto(base_url)

    def _correr(modulo, expresion, *args):
        return page.evaluate(
            f"""(args) => import('{modulo}').then((m) => {{ const f = {expresion}; return f(m, ...args); }})""",
            list(args),
        )

    return _correr


# ---------------------------------------------------------------------------
# Un nombre legible en vez de una nomenclatura catastral
# ---------------------------------------------------------------------------
#
# El desplegable de "Lotes de interés" del CRM, la lista de apartados y la
# tabla de lotes mostraban códigos de 25 caracteres que se diferencian en
# un dígito: 00-06-44-05-000118-000008. Imposible elegir el correcto sin
# abrirlos uno por uno. La nomenclatura del catastro argentino tiene
# adentro la manzana y el lote, así que el nombre legible se puede armar.


@pytest.mark.parametrize(
    "nomenclatura,manzana,lote",
    [
        ("00-06-44-05-000118-000008", "118", "8"),
        ("00-06-44-04-000076-000033", "76", "33"),
        ("00-06-44-04-000076-000032", "76", "32"),
        ("00-06-44-05-000118-000009", "118", "9"),
    ],
)
def test_la_nomenclatura_se_traduce_a_manzana_y_lote(evaluar, nomenclatura, manzana, lote):
    r = evaluar(CATASTRO, "(m, n) => m.manzanaYLoteDesdeNomenclatura(n)", nomenclatura)
    assert r == {"manzana": manzana, "lote": lote}


def test_los_ceros_de_adelante_no_quedan_en_el_nombre(evaluar):
    """"Manzana 000118" no es más legible que el código entero."""
    r = evaluar(CATASTRO, "(m, n) => m.manzanaYLoteDesdeNomenclatura(n)", "00-06-44-05-000118-000008")
    assert r["manzana"] == "118" and not r["manzana"].startswith("0")


@pytest.mark.parametrize("basura", ["", "basura", "00-06-44", "no-es-una-nomenclatura", "00-06-44-05-000118"])
def test_lo_que_no_es_una_nomenclatura_no_se_inventa(evaluar, basura):
    """Devolver algo igual sería peor: pondría un nombre falso en la
    pantalla, y nadie podría notar que está mal."""
    assert evaluar(CATASTRO, "(m, n) => m.manzanaYLoteDesdeNomenclatura(n)", basura) is None


def test_null_no_rompe(evaluar):
    assert evaluar(CATASTRO, "(m) => m.manzanaYLoteDesdeNomenclatura(null)") is None


# ---------------------------------------------------------------------------
# Los catálogos vacíos dicen para qué sirven
# ---------------------------------------------------------------------------
#
# Con la lista vacía, las cuatro pantallas mostraban el encabezado
# "Nombre" y una raya: parecía que habían fallado al cargar. Y quien entra
# por primera vez no tiene de dónde deducir para qué sirve el catálogo.


@pytest.mark.parametrize(
    "pantalla,palabra",
    [("sectores", "zona"), ("barrios", "barrio"), ("motivos", "motivo"), ("etiquetas-crm", "etiqueta")],
)
def test_cada_catalogo_vacio_explica_lo_suyo(evaluar, pantalla, palabra):
    r = evaluar(VACIO, "(m, p) => m.contenidoVacio({ pantalla: p, conSesion: true })", pantalla)
    assert r is not None
    assert palabra in r["titulo"].lower(), f"{pantalla}: el título no habla de {palabra}"
    # Y dice PARA QUÉ sirve, no solo que está vacío: es la mitad que
    # faltaba. Un texto corto sería otra vez "acá no hay nada".
    assert len(r["texto"]) > 80, f"{pantalla}: el texto no explica para qué sirve"


def test_las_pantallas_que_ya_tenian_texto_siguen_igual(evaluar):
    """Este módulo TIRA para una pantalla que no conoce, así que agregar
    claves nuevas podía haber pisado las viejas."""
    for pantalla in ("mapa", "lista", "dashboard"):
        r = evaluar(VACIO, "(m, p) => m.contenidoVacio({ pantalla: p, conSesion: true })", pantalla)
        assert r and r["titulo"], f"{pantalla} se quedó sin texto"


def test_una_pantalla_desconocida_sigue_fallando_fuerte(evaluar):
    """A propósito: un estado vacío mudo es un bug que no se ve. Que tire
    en el momento de escribirlo es lo que hace que no llegue a producción.
    """
    r = evaluar(
        VACIO,
        "(m, p) => { try { m.contenidoVacio({ pantalla: p, conSesion: true }); return 'no tiró'; } catch (e) { return 'tiró'; } }",
        "pantalla-que-no-existe",
    )
    assert r == "tiró"
