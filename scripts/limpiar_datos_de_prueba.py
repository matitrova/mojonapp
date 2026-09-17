#!/usr/bin/env python3
"""
Borra de Firestore los contactos y lotes que quedaron de corridas de
tests, dejando los datos reales intactos.

La suite ya hace esta limpieza sola al arrancar (ver la fixture
`limpiar_sobrantes_al_arrancar` en tests/conftest.py, que es donde vive
toda la lógica y el por qué). Este script existe para poder correrla a
mano y, sobre todo, para poder MIRAR primero qué se borraría sin borrar
nada — útil la primera vez, cuando hay mucho acumulado y conviene
revisar a ojo que no se lleve nada real.

USO:
    python3 scripts/limpiar_datos_de_prueba.py            # solo informa
    python3 scripts/limpiar_datos_de_prueba.py --borrar   # borra de verdad

OJO: listar también consume cuota de lectura. Si el proyecto está en 429
(RESOURCE_EXHAUSTED), esto no puede correr hasta que la cuota se reponga,
a la medianoche del Pacífico — las 4 AM en Argentina.
"""

import sys
from collections import Counter
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "tests"))

import requests  # noqa: E402

import conftest  # noqa: E402  (carga tests/.env y resuelve el token de sesión)


def main():
    borrar = "--borrar" in sys.argv

    try:
        sobrantes = conftest.datos_de_prueba_sobrantes()
    except requests.HTTPError as error:
        if error.response is not None and error.response.status_code == 429:
            sys.exit(
                "Firestore devolvió 429 (cuota diaria agotada): no se puede ni "
                "listar. Reintentar cuando la cuota se reponga."
            )
        raise

    total = sum(len(v) for v in sobrantes.values())
    for coleccion, documentos in sobrantes.items():
        print(f"\n{'=' * 60}\n{coleccion}: {len(documentos)} sobrantes de prueba")
        if documentos:
            for prefijo, cuantos in Counter(
                nombre.rsplit("-", 1)[0] for _, nombre in documentos
            ).most_common():
                print(f"    {cuantos:4d}  {prefijo}-*")

    if not borrar:
        print(f"\n{'=' * 60}")
        print(f"MODO INFORME: no se borró nada. {total} documentos se borrarían.")
        print("Para borrarlos de verdad: --borrar")
        return

    print(f"\nborrando {total}…")
    borrados = conftest.borrar_datos_de_prueba_sobrantes()
    print(f"listo: {', '.join(f'{k}: {v}' for k, v in borrados.items())}")


if __name__ == "__main__":
    main()
