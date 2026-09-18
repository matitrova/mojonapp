"""
Tests del buscador global (js/buscador.js).

QUÉ PROTEGEN. Un buscador se juzga por si lo que buscabas aparece
primero. Los errores que lo vuelven inútil son de orden y de umbral, no
de coincidencia:

  - con una letra coincide medio sistema y la lista deja de ayudar;
  - si "manzana 14" no sale antes que un lote que tiene "14" perdido en
    su nomenclatura, hay que leer la lista entera y ya no se ahorró nada;
  - en una app argentina se escribe sin tildes: buscar "carpinteria"
    tiene que encontrar "Carpintería", o el buscador parece roto.
"""

import pytest
from playwright.sync_api import expect  # noqa: F401  (consistencia con el resto de la suite)


def _evaluar(page, base_url, expresion, *args):
    page.goto(base_url)
    return page.evaluate(
        "(args) => import('/js/buscador.js').then((m) => (" + expresion + "))",
        list(args),
    )


def _lote(id_, manzana, lote, sector=None, nomenclatura=None):
    return {"id": id_, "properties": {"manzana": manzana, "lote": lote, "sector": sector, "nomenclatura": nomenclatura}}


def _lead(id_, nombre, telefono=None):
    return {"id": id_, "nombre": nombre, "telefono": telefono}


def test_con_una_sola_letra_no_busca(page, base_url):
    """Con una letra coincide casi todo y la lista deja de ayudar."""
    resultado = _evaluar(
        page, base_url, "m.buscar('a', args[0], args[1])", [_lote("x", "14", "7")], [_lead("y", "Ana")]
    )
    assert resultado["lotes"] == [] and resultado["leads"] == []


def test_lo_mas_parecido_va_primero(page, base_url):
    """Buscando "14", la manzana 14 antes que un 14 perdido en el medio.

    Si no, hay que leer la lista entera y el buscador no ahorró nada.
    """
    lotes = [
        _lote("perdido", "3", "1", nomenclatura="00-06-65-01-000140-000022"),
        _lote("exacto", "14", "7"),
    ]
    resultado = _evaluar(page, base_url, "m.buscar('14', args[0], [])", lotes)
    assert [r["id"] for r in resultado["lotes"]][0] == "exacto"


def test_encuentra_sin_tildes(page, base_url):
    """En una app argentina se escribe sin tildes; si no encontrara,
    el buscador parecería roto."""
    resultado = _evaluar(
        page, base_url, "m.buscar('carpinteria', args[0], [])", [_lote("a", "8", "4", sector="Carpintería")]
    )
    assert len(resultado["lotes"]) == 1


def test_encuentra_leads_por_nombre_y_por_telefono(page, base_url):
    leads = [_lead("a", "Familia Sosa", "2664 55-8821"), _lead("b", "Marcelo Pérez", "2664 30-9955")]
    por_nombre = _evaluar(page, base_url, "m.buscar('sosa', [], args[0])", leads)
    assert [r["id"] for r in por_nombre["leads"]] == ["a"]

    por_telefono = _evaluar(page, base_url, "m.buscar('30-99', [], args[0])", leads)
    assert [r["id"] for r in por_telefono["leads"]] == ["b"]


def test_no_devuelve_una_lista_interminable(page, base_url):
    """Una lista larga no se lee: si lo que buscabas no está arriba,
    conviene afinar el término."""
    lotes = [_lote(f"l{n}", "14", str(n)) for n in range(20)]
    resultado = _evaluar(page, base_url, "m.buscar('14', args[0], [])", lotes)
    assert len(resultado["lotes"]) == 5


def test_distingue_escribiste_poco_de_no_hay_nada(page, base_url):
    """Son dos mensajes distintos para el usuario, así que el módulo
    tiene que poder distinguirlos."""
    sin_nada = _evaluar(page, base_url, "m.hayResultados(m.buscar('zzz', args[0], []))", [_lote("a", "14", "7")])
    assert sin_nada is False

    con_algo = _evaluar(page, base_url, "m.hayResultados(m.buscar('14', args[0], []))", [_lote("a", "14", "7")])
    assert con_algo is True


@pytest.mark.parametrize(
    "texto,termino,esperado",
    [("14", "14", 3), ("140", "14", 2), ("0140", "14", 1), ("7", "14", 0), (None, "14", 0)],
)
def test_el_puntaje_ordena_igual_empieza_contiene(page, base_url, texto, termino, esperado):
    assert _evaluar(page, base_url, "m.puntaje(args[0], args[1])", texto, termino) == esperado


def test_un_lote_sin_datos_no_rompe_la_busqueda(page, base_url):
    """Los lotes importados del catastro pueden no tener zona ni barrio."""
    resultado = _evaluar(page, base_url, "m.buscar('14', args[0], [])", [{"id": "x", "properties": {"manzana": "14"}}])
    assert len(resultado["lotes"]) == 1
    assert resultado["lotes"][0]["titulo"] == "Manzana 14 — Lote ?"
