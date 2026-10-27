import json
import boto3
import os
import uuid
import re
from botocore.config import Config
from botocore.exceptions import ClientError

# =========================================================
# CONFIGURACIÓN
# =========================================================
BUCKET = os.environ["BUCKET"]  # variable de entorno llamada BUCKET
REGION = os.environ.get("AWS_REGION", "us-east-1")

s3 = boto3.client(
    "s3",
    region_name=REGION,
    config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
)

CARPETA = "uploads/"

# Tipos de archivo permitidos: fotos, excel, word, powerpoint
ALLOWED_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "video/mp4",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  # .docx
    "application/msword",                                                        # .doc
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",         # .xlsx
    "application/vnd.ms-excel",                                                  # .xls
    "application/vnd.openxmlformats-officedocument.presentationml.presentation", # .pptx
    "application/vnd.ms-powerpoint",                                             # .ppt
}

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str)
    }


def limpiar_nombre(filename):
    filename = os.path.basename(filename)
    filename = re.sub(r'[^a-zA-Z0-9._-]', '_', filename)
    return filename


def es_admin(claims):
    # API Gateway (HTTP API) entrega la lista como texto: "[admin otro]"
    return "admin" in claims.get("cognito:groups", "").strip("[]").replace(",", " ").split()


def lambda_handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")
    # Usuario validado por el autorizador JWT de API Gateway (Cognito)
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})

    print("Método:", method, "Ruta:", path, "Usuario:", claims.get("username") or claims.get("sub"))

    try:
        # =====================================================
        # SUBIR: POST /api/subir -> POST prefirmado de S3
        # =====================================================
        if method == "POST" and path.endswith("/api/subir"):
            body = json.loads(event.get("body") or "{}")
            filename = body.get("filename")
            content_type = body.get("contentType", "application/octet-stream")
            file_size = int(body.get("size", 0))

            if not filename:
                return response(400, {"error": "Debe proporcionar el nombre del archivo"})

            if content_type not in ALLOWED_TYPES:
                return response(400, {
                    "error": "Tipo de archivo no permitido. Solo fotos, Pdf, Excel, Word o PowerPoint.",
                    "tipo_recibido": content_type
                })

            if file_size <= 0:
                return response(400, {"error": "Tamaño de archivo inválido"})

            if file_size > MAX_FILE_SIZE:
                return response(400, {"error": "El archivo supera los 10 MB maximos permitidos."})

            safe_name = limpiar_nombre(filename)
            key = f"{CARPETA}{uuid.uuid4()}-{safe_name}"

            print("Generando POST prefirmado para:", key)

            # S3 mismo rechaza el archivo si no cumple tipo o tamaño (content-length-range),
            # aunque el cliente mienta en "size". El dueño (sub de Cognito) va firmado en la metadata.
            dueno = claims.get("sub", "")
            post = s3.generate_presigned_post(
                Bucket=BUCKET,
                Key=key,
                Fields={"Content-Type": content_type, "x-amz-meta-owner": dueno},
                Conditions=[{"Content-Type": content_type}, {"x-amz-meta-owner": dueno},
                            ["content-length-range", 1, MAX_FILE_SIZE]],
                ExpiresIn=300
            )

            return response(200, {
                "mensaje": "POST prefirmado generado",
                "url": post["url"],
                "fields": post["fields"],
                "key": key,
                "expires": 300
            })

        # =====================================================
        # LISTAR: GET /api/archivos
        # =====================================================
        if method == "GET" and path.endswith("/api/archivos"):
            archivos = []
            for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=CARPETA):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    if key == CARPETA:
                        continue

                    download_url = s3.generate_presigned_url(
                        ClientMethod="get_object",
                        Params={"Bucket": BUCKET, "Key": key},
                        ExpiresIn=300
                    )
                    archivos.append({
                        "nombre": key.split("/")[-1],
                        "key": key,
                        "tamano": obj["Size"],
                        "fecha": obj["LastModified"].isoformat(),
                        "url": download_url
                    })

            return response(200, {"archivos": archivos})

        # =====================================================
        # ELIMINAR: DELETE /api/eliminar
        # =====================================================
        if method == "DELETE" and path.endswith("/api/eliminar"):
            body = json.loads(event.get("body") or "{}")
            key = body.get("key")

            if not key or not key.startswith(CARPETA):
                return response(400, {"error": "Debe proporcionar una key válida dentro de uploads/"})

            # Solo borra quien lo subió o el grupo admin; archivos antiguos sin dueño, solo admin
            try:
                dueno = s3.head_object(Bucket=BUCKET, Key=key)["Metadata"].get("owner")
            except ClientError as e:
                if e.response["Error"]["Code"] in ("404", "NoSuchKey"):
                    return response(404, {"error": "El archivo no existe"})
                raise
            if not es_admin(claims) and (not dueno or dueno != claims.get("sub")):
                return response(403, {"error": "Solo quien subió el archivo puede eliminarlo"})

            s3.delete_object(Bucket=BUCKET, Key=key)
            return response(200, {"mensaje": f"Archivo eliminado: {key}"})

        # Ruta no encontrada
        return response(404, {"error": "Ruta no encontrada", "method": method, "path": path})

    except ClientError as e:
        print("ERROR AWS:", str(e))
        return response(500, {"error": "Error de AWS"})
    except Exception as e:
        print("ERROR:", str(e))
        return response(500, {"error": "Error interno"})
