"""
Tests de las comisiones (js/comisiones.js).

QUÉ SE PROTEGE ACÁ. Es una cifra de plata que el dueño de la inmobiliaria
va a mirar para decidir, así que lo que importa no es que muestre un
número sino que el número sea defendible. Los casos que podrían
falsearlo, todos cubiertos:

  - un lote con comisión 0% (existe: hay operaciones sin comisión) no
    puede caer en el porcentaje general y mostrar plata que no se cobra;
  - un lote sin precio no puede aportar una comisión inventada;
  - lo ya ganado (contactos cerrados) no puede sumarse con lo proyectado,
    porque daría un número más grande y menos cierto;
  - los contactos perdidos no aportan nada.
"""

import pytest
from playwright.sync_api import expect  # noqa: F401  (consistencia con el resto de la suite)


def _evaluar(page, base_url, expresion, *args):
    page.goto(base_url)
    return page.evaluate(
        "(args) => import('/js/comisiones.js').then((m) => (" + expresion + "))",
        list(args),
    )


def test_usa_el_porcentaje_del_lote_cuando_lo_tiene(page, base_url):
    assert _evaluar(page, base_url, "m.comisionDeUnLote({ precio_usd: 20000, comision_pct: 6 })") == 1200


def test_usa_el_general_cuando_el_lote_no_trae_uno(page, base_url):
    """4% de 20.000 = 800, con el porcentaje por defecto."""
    resultado = _evaluar(page, base_url, "m.comisionDeUnLote({ precio_usd: 20000 })")
    assert resultado == 800
    assert _evaluar(page, base_url, "m.COMISION_PCT_POR_DEFECTO") == 4


def test_una_comision_de_cero_no_cae_en_el_general(page, base_url):
    """El caso que un `||` mal puesto rompe.

    Un lote con comisión 0% es un lote por el que no se cobra. Con
    `comision_pct || 4` ese 0 se convertiría en 4% y la app mostraría
    plata que nadie va a cobrar.
    """
    assert _evaluar(page, base_url, "m.comisionDeUnLote({ precio_usd: 20000, comision_pct: 0 })") == 0
    assert _evaluar(page, base_url, "m.pctDelLote({ comision_pct: 0 })") == 0


def test_sin_precio_no_hay_comision(page, base_url):
    """No se inventa un precio: mismo criterio que valorPotencialContacto."""
    assert _evaluar(page, base_url, "m.comisionDeUnLote({ comision_pct: 5 })") == 0
    assert _evaluar(page, base_url, "m.comisionDeUnLote({ precio_usd: null, comision_pct: 5 })") == 0


def test_la_comision_de_un_contacto_suma_sus_lotes(page, base_url):
    total = _evaluar(
        page,
        base_url,
        """m.comisionDeContacto(
             { lotes_interes: [{ id: 'a' }, { id: 'b' }] },
             new Map([['a', { precio_usd: 20000 }], ['b', { precio_usd: 10000, comision_pct: 10 }]])
           )""",
    )
    # 4% de 20.000 = 800, más 10% de 10.000 = 1000
    assert total == 1800


def test_un_lote_que_ya_no_existe_no_rompe_la_cuenta(page, base_url):
    """Un contacto puede tener en su lista un lote borrado después.

    Antes que fallar o inventar, ese lote aporta 0 — el resto de la
    cuenta sigue siendo correcta.
    """
    total = _evaluar(
        page,
        base_url,
        """m.comisionDeContacto(
             { lotes_interes: [{ id: 'existe' }, { id: 'borrado' }] },
             new Map([['existe', { precio_usd: 20000 }]])
           )""",
    )
    assert total == 800


def test_lo_ganado_y_lo_proyectado_van_separados(page, base_url):
    """El test central del módulo.

    Un contacto cerrado (plata ganada), uno en visita (proyección) y uno
    perdido (nada). Las dos primeras cifras NO se pueden mezclar.
    """
    resumen = _evaluar(
        page,
        base_url,
        """m.resumenDeComisiones(
             [
               { estado: 'cerrado', lotes_interes: [{ id: 'a' }] },
               { estado: 'visita', lotes_interes: [{ id: 'b' }] },
               { estado: 'perdido', lotes_interes: [{ id: 'c' }] }
             ],
             new Map([
               ['a', { precio_usd: 50000 }],
               ['b', { precio_usd: 20000 }],
               ['c', { precio_usd: 90000 }]
             ])
           )""",
    )
    assert resumen["cerrada"] == 2000, "la comisión ya ganada no es la del contacto cerrado"
    assert resumen["enPipeline"] == 800, "el pipeline no es solo el contacto vivo"


@pytest.mark.parametrize("etapa", ["nuevo", "contactado", "visita", "oferta"])
def test_todas_las_etapas_vivas_cuentan_en_el_pipeline(page, base_url, etapa):
    resumen = _evaluar(
        page,
        base_url,
        "m.resumenDeComisiones([{ estado: args[0], lotes_interes: [{ id: 'a' }] }], new Map([['a', { precio_usd: 20000 }]]))",
        etapa,
    )
    assert resumen["enPipeline"] == 800, f"la etapa {etapa} no está contando en el pipeline"


def test_la_cartera_cuenta_solo_lo_que_esta_disponible(page, base_url):
    """Un lote reservado o vendido ya no se puede vender de nuevo."""
    total = _evaluar(
        page,
        base_url,
        """m.comisionDeLaCartera([
             { properties: { estado: 'disponible', precio_usd: 20000 } },
             { properties: { estado: 'reservado', precio_usd: 50000 } },
             { properties: { estado: 'vendido', precio_usd: 90000 } },
             { properties: { estado: 'disponible', precio_usd: 10000, comision_pct: 10 } }
           ])""",
    )
    assert total == 1800
