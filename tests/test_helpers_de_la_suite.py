"""
Tests de los helpers de la propia suite (tests/conftest.py).

POR QUÉ TESTEAR EL ANDAMIO. Estos helpers no son producto, pero si se
equivocan, se equivocan en silencio y contaminan el resultado de todos
los demás tests: un buscador que devuelve None cuando el documento sí
existe hace fallar tests que están bien, y uno que devuelve un id
equivocado hace pasar tests que están mal.

Se agregaron el 2026-09-18, cuando los buscadores dejaron de barrer la
colección entera y pasaron a consultar con filtro del lado del servidor
(":runQuery"). Ese cambio no se pudo probar contra Firestore en el
momento —la cuota de lecturas por REST estaba agotada, mientras que
escrituras y borrados seguían funcionando—, así que el parseo, que es la
parte con forma rara, se aisló para poder verificarlo sin red.

No tocan Firestore ni el navegador: son datos de entrada y salida.
"""

from conftest import id_del_primer_documento

RAIZ = "projects/mojonapptest/databases/(default)/documents"


def test_sin_resultados_devuelve_none():
    """La forma real de una consulta que no encuentra nada.

    NO es una lista vacía: Firestore devuelve una entrada con solo
    "readTime". Verificado contra Firestore de verdad antes de escribir
    esto. Si se asumiera una lista vacía, el helper explotaría con
    KeyError en vez de informar "no está".
    """
    assert id_del_primer_documento([{"readTime": "2026-09-18T10:21:39.006784Z"}]) is None


def test_lista_vacia_tambien_devuelve_none():
    """Por las dudas: si algún día devolviera una lista vacía, tampoco rompe."""
    assert id_del_primer_documento([]) is None


def test_con_resultado_devuelve_el_id_del_documento():
    """El id es el ÚLTIMO segmento del nombre completo del documento.

    El "name" viene como la ruta entera; quedarse con todo o partir mal
    devolvería un id que después no matchea con ningún doc al borrarlo,
    y el dato de prueba quedaría sin limpiar.
    """
    respuesta = [
        {
            "document": {
                "name": f"{RAIZ}/lotes/abc123DEF456",
                "fields": {"descripcion": {"stringValue": "Lote de prueba"}},
            },
            "readTime": "2026-09-18T10:21:39.006784Z",
        }
    ]
    assert id_del_primer_documento(respuesta) == "abc123DEF456"


def test_ignora_las_entradas_de_metadatos_y_devuelve_el_documento():
    """Una respuesta puede traer metadatos antes del documento.

    Si el helper se quedara con la primera entrada sin mirar si tiene
    "document", devolvería None teniendo un resultado válido más abajo —
    y el test que lo use fallaría diciendo "no apareció en Firestore"
    cuando sí apareció.
    """
    respuesta = [
        {"readTime": "2026-09-18T10:21:39.000000Z"},
        {"document": {"name": f"{RAIZ}/contactos/XYZ789"}, "readTime": "2026-09-18T10:21:39.006784Z"},
    ]
    assert id_del_primer_documento(respuesta) == "XYZ789"
