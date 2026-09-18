#!/usr/bin/env python3
"""
Busca nombres usados y no definidos en los tests, sin ejecutarlos.

POR QUÉ EXISTE. Este proyecto no tiene linter (no hay Node ni build
step, y tampoco ruff/flake8 en el venv), y en Python los nombres se
resuelven al EJECUTAR: un `page.goto(base_url)` dentro de una función
cuya firma es solo `(page)` compila perfecto y `pytest --collect-only`
lo importa sin una queja, porque el NameError recién aparece cuando ese
código corre. Se descubre con un test en rojo y un rato de diagnóstico.

Pasó dos veces el 2026-09-17, las dos con codemods sobre ~40 archivos de
tests a la vez. De ahí este chequeo: cuesta menos de un segundo y cubre
justo el agujero que dejan `py_compile` y `--collect-only`.

Usa `symtable`, de la librería estándar, que resuelve los ámbitos de
verdad — bucles, comprensiones, funciones anidadas y cierres — así que
no tiene los falsos positivos de recorrer el AST a mano.

USO:
    python3 scripts/chequear_nombres.py            # tests/
    python3 scripts/chequear_nombres.py js         # cualquier carpeta

Devuelve código 1 si encontró algo, para poder encadenarlo:
    python3 scripts/chequear_nombres.py && pytest tests/
"""

import builtins
import symtable
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
INCORPORADOS = set(dir(builtins))


def revisar_archivo(archivo):
    """Los nombres sin definir de un archivo, como lista de strings."""
    codigo = archivo.read_text(encoding="utf-8")
    try:
        tabla = symtable.symtable(codigo, archivo.name, "exec")
    except SyntaxError as error:
        return [f"{archivo.name}: no se pudo parsear ({error})"]

    del_modulo = {s.get_name() for s in tabla.get_symbols()}
    hallazgos = []

    def recorrer(ambito, camino):
        for simbolo in ambito.get_symbols():
            nombre = simbolo.get_name()
            if not simbolo.is_referenced():
                continue
            # is_free: viene de la función de afuera (un cierre), así que
            # está definido aunque no lo esté en este ámbito.
            if simbolo.is_free():
                continue
            if simbolo.is_parameter() or simbolo.is_assigned() or simbolo.is_imported():
                continue
            if nombre in del_modulo or nombre in INCORPORADOS:
                continue
            hallazgos.append(f"{archivo.name}: {camino} usa '{nombre}' y no está definido")
        for hijo in ambito.get_children():
            recorrer(hijo, f"{camino}.{hijo.get_name()}()")

    for hijo in tabla.get_children():
        recorrer(hijo, f"{hijo.get_name()}()")
    return hallazgos


def main():
    carpeta = RAIZ / (sys.argv[1] if len(sys.argv) > 1 else "tests")
    if not carpeta.is_dir():
        sys.exit(f"No existe la carpeta {carpeta}")

    archivos = sorted(carpeta.glob("*.py"))
    # Sin archivos NO es un resultado limpio: es que no se revisó nada.
    # Esto usa symtable, que entiende Python y nada más, así que apuntarlo
    # a js/ o functions/ no matchea ningún archivo — y decir "0 nombres
    # sin definir" ahí sería un verde falso, justo el tipo de salida que
    # da tranquilidad donde no hay ninguna cobertura.
    if not archivos:
        sys.exit(
            f"No hay archivos .py en {carpeta}: no se revisó nada.\n"
            "Este chequeo solo entiende Python (usa symtable). Para el código de la\n"
            "app, que es JavaScript, no sirve."
        )

    hallazgos = []
    for archivo in archivos:
        hallazgos.extend(revisar_archivo(archivo))

    for linea in hallazgos:
        print(f"  {linea}")
    print(f"\n{carpeta.name}/: {len(archivos)} archivos, {len(hallazgos)} nombres sin definir")
    sys.exit(1 if hallazgos else 0)


if __name__ == "__main__":
    main()
