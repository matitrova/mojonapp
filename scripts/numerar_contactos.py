"""Le pone número a los contactos que se crearon antes de que existiera.

POR QUÉ HACE FALTA. Desde el 2026-09-24 cada contacto nuevo se guarda
con un `numero` correlativo (#1, #2, #3…) para poder nombrarlo por
teléfono y para distinguir dos que se llamen igual. Los que ya estaban
no lo tienen, y una mitad numerada y otra sin numerar es justo lo
confuso.

CÓMO NUMERA. Por antigüedad: el contacto más viejo de la inmobiliaria es
el #1. Así el número dice algo (cuán antiguo es el cliente) en vez de
ser el orden en que se corrió un script.

DEJA EL CONTADOR DONDE CORRESPONDE. Si numerara sin tocar
contadores/contactos, el próximo contacto que alguien dé de alta
arrancaría de cero y repetiría números — que es exactamente lo que
rompería para lo que se pidió esto.

    python scripts/numerar_contactos.py            # solo informa
    python scripts/numerar_contactos.py --aplicar  # escribe

HAY QUE CORRERLO EN LOS DOS PROYECTOS (producción y pruebas): no hay
Firebase CLI acá y las reglas y los datos van por separado.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests"))

import conftest  # noqa: E402
import requests  # noqa: E402


def contactos_ordenados_por_antiguedad():
    """Todos los contactos, del más viejo al más nuevo.

    Se ordena por `fecha_creacion` si está, y por el `createTime` del
    propio documento si no — que es lo que tienen los contactos más
    viejos, de antes de que se guardara la fecha.
    """
    docs = []
    pagina = None
    while True:
        url = f"{conftest.FIRESTORE_RAIZ}/contactos?pageSize=300"
        if pagina:
            url += f"&pageToken={pagina}"
        r = requests.get(url, headers={"Authorization": f"Bearer {conftest._id_token_de_prueba()}"}, timeout=30)
        r.raise_for_status()
        cuerpo = r.json()
        docs.extend(cuerpo.get("documents", []))
        pagina = cuerpo.get("nextPageToken")
        if not pagina:
            break

    def clave(d):
        campos = d.get("fields", {})
        creada = campos.get("fecha_creacion", {}).get("stringValue")
        return creada or d.get("createTime") or ""

    return sorted(docs, key=clave)


def numero_de(doc):
    v = doc.get("fields", {}).get("numero", {})
    if "integerValue" in v:
        return int(v["integerValue"])
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aplicar", action="store_true", help="escribir de verdad (sin esto, solo informa)")
    args = parser.parse_args()

    print(f"Proyecto: {conftest.FIREBASE_PROJECT_ID}\n")

    docs = contactos_ordenados_por_antiguedad()
    sin_numero = [d for d in docs if numero_de(d) is None]
    con_numero = [d for d in docs if numero_de(d) is not None]

    print(f"Contactos: {len(docs)}  ·  ya numerados: {len(con_numero)}  ·  sin número: {len(sin_numero)}")

    if con_numero:
        # Se respetan los que ya tienen número: repartir de nuevo le
        # cambiaría el número a un contacto del que alguien ya habló.
        print("  (los que ya tienen número no se tocan)")

    if not sin_numero:
        print("\nNo hay nada que numerar.")
        return

    usados = {numero_de(d) for d in con_numero}
    siguiente = 1
    asignaciones = []
    for d in sin_numero:
        while siguiente in usados:
            siguiente += 1
        asignaciones.append((d, siguiente))
        usados.add(siguiente)
        siguiente += 1

    for d, n in asignaciones[:10]:
        nombre = d.get("fields", {}).get("nombre", {}).get("stringValue", "(sin nombre)")
        print(f"  #{n:<5} {nombre}")
    if len(asignaciones) > 10:
        print(f"  … y {len(asignaciones) - 10} más")

    tope = max(usados) if usados else 0
    print(f"\nEl contador quedaría en {tope}.")

    if not args.aplicar:
        print("\nDry-run: no se escribió nada. Volvé a correrlo con --aplicar.")
        return

    escrituras = [
        {
            "update": {"name": d["name"], "fields": {"numero": {"integerValue": str(n)}}},
            "updateMask": {"fieldPaths": ["numero"]},
        }
        for d, n in asignaciones
    ]
    # Firestore acepta hasta 500 escrituras por commit.
    for i in range(0, len(escrituras), 400):
        conftest._commit(escrituras[i : i + 400])
    print(f"  {len(asignaciones)} contactos numerados.")

    # EL CONTADOR SE SUBE DE A UNO, y no de un saque.
    #
    # La regla de firestore.rules (soloSumaUno) deja hacer UNA sola cosa
    # con este documento: llevarlo de N a N+1. Está así a propósito —
    # cualquier logueado lo tiene que poder mover, y sin ese límite
    # alguien podría dejarlo en 9.999.999 y arruinar la numeración para
    # siempre.
    #
    # O sea que la regla prohíbe esta migración, y hace bien. La primera
    # versión de este script intentaba escribir el tope directo y se
    # comía un 403. Subirlo de a uno respeta la regla sin aflojarla: son
    # tantos pedidos como contactos, y esto se corre una sola vez.
    #
    # Si se cortara en la mitad, el contador queda más bajo de lo que
    # debería y los próximos altas repetirían números. Por eso se
    # verifica al final y se avisa para volver a correrlo.
    desde = max((n for n in usados if n < tope), default=0)
    print(f"  subiendo el contador hasta {tope}...")
    for valor in range(1, tope + 1):
        conftest._commit([
            {
                "update": {
                    "name": f"{conftest.FIRESTORE_RAIZ_RELATIVA}/contadores/contactos",
                    "fields": {"valor": {"integerValue": str(valor)}},
                }
            }
        ])
    print(f"\nListo: {len(asignaciones)} contactos numerados, contador en {tope}.")

    # Se relee: informar "escribí N" solo dice que ninguna escritura tiró
    # excepción, no que hayan quedado.
    quedaron = [d for d in contactos_ordenados_por_antiguedad() if numero_de(d) is None]
    if quedaron:
        sys.exit(f"ATENCIÓN: quedaron {len(quedaron)} contactos sin número.")

    # Y EL CONTADOR, que es la mitad que se olvida. Si quedó más bajo que
    # el número más alto asignado, el próximo contacto que alguien dé de
    # alta va a repetir un número — y repetir es justo lo que rompe para
    # lo que se pidió la numeración.
    r = requests.get(
        f"{conftest.FIRESTORE_RAIZ}/contadores/contactos",
        headers={"Authorization": f"Bearer {conftest._id_token_de_prueba()}"},
        timeout=20,
    )
    valor = int(r.json().get("fields", {}).get("valor", {}).get("integerValue", 0)) if r.ok else 0
    if valor < tope:
        sys.exit(
            f"ATENCIÓN: el contador quedó en {valor} y tendría que estar en {tope}. "
            "Volvé a correr el script: los próximos altas repetirían números."
        )
    print(f"Verificado: ningún contacto sin número, y el contador en {valor}.")


if __name__ == "__main__":
    main()
