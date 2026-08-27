"""
Test de integridad de data/carpinteria-01.geojson: no involucra navegador,
lee el archivo directo.

Existe para agarrar el caso de vértices cargados en el orden equivocado:
el polígono puede seguir siendo "válido" (cierra, no tira error al
dibujarse) y dar una superficie completamente distinta a la real sin que
nada lo note.
"""

import json
import math
from pathlib import Path

RAIZ_PROYECTO = Path(__file__).resolve().parent.parent
RUTA_GEOJSON = RAIZ_PROYECTO / "data" / "carpinteria-01.geojson"

TOLERANCIA = 0.02  # 2%


def _cargar_anillo_exterior():
    geojson = json.loads(RUTA_GEOJSON.read_text())
    feature = geojson["features"][0]
    return feature["geometry"]["coordinates"][0], feature["properties"]["superficie_m2"]


def _superficie_m2(anillo):
    # Proyección equirectangular local (centrada en el primer vértice): a la
    # escala de un lote (decenas de metros) es más que suficiente precisión,
    # y evita mezclar grados de longitud/latitud con metros en la fórmula.
    lon0, lat0 = anillo[0]
    m_por_grado_lat = 111320.0
    m_por_grado_lon = 111320.0 * math.cos(math.radians(lat0))

    puntos_m = [
        ((lon - lon0) * m_por_grado_lon, (lat - lat0) * m_por_grado_lat)
        for lon, lat in anillo
    ]

    area2 = 0.0
    for i in range(len(puntos_m) - 1):
        x0, y0 = puntos_m[i]
        x1, y1 = puntos_m[i + 1]
        area2 += x0 * y1 - x1 * y0

    return abs(area2) / 2


def test_geojson_carpinteria_es_valido():
    anillo, superficie_declarada = _cargar_anillo_exterior()

    assert anillo[0] == anillo[-1], (
        "El anillo del polígono no cierra: el primer vértice debería ser "
        "igual al último."
    )

    superficie_calculada = _superficie_m2(anillo)
    error_relativo = abs(superficie_calculada - superficie_declarada) / superficie_declarada
    assert error_relativo <= TOLERANCIA, (
        f"Superficie calculada ({superficie_calculada:.1f} m²) se aleja más "
        f"de {TOLERANCIA:.0%} de la declarada ({superficie_declarada} m²) — "
        "revisar el orden de los vértices."
    )
