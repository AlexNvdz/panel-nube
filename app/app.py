import os

from flask import Flask, redirect, render_template

# =========================================================
# CONFIGURACIÓN
# El login lo hace Cognito en el navegador y la API se llama directo
# a API Gateway con el token; Flask solo sirve las páginas.
# Estos valores son públicos (no son secretos).
# =========================================================
POOL_ID = os.environ.get("COGNITO_POOL_ID", "us-east-1_uIw9Yyh9L")
PANEL = {
    "apiUrl": os.environ.get("API_URL", "https://kaxmhidad2.execute-api.us-east-1.amazonaws.com").rstrip("/"),
    "authority": f"https://cognito-idp.us-east-1.amazonaws.com/{POOL_ID}",
    "clientId": os.environ.get("COGNITO_CLIENT_ID", "35mfvlhfd8da9qrrduq8d3li2o"),
    "cognitoDomain": os.environ.get("COGNITO_DOMAIN", "https://panel-nube-nvdz.auth.us-east-1.amazoncognito.com"),
}
BUCKET_NOMBRE = os.environ.get("BUCKET_NOMBRE", "nvdz-priv-info")  # solo para mostrar

app = Flask(__name__)

# Versión de los estáticos: cambia en cada despliegue y evita CSS/JS viejos en caché
_static = os.path.join(app.root_path, "static")
ASSET_V = str(int(max(os.path.getmtime(os.path.join(_static, f)) for f in os.listdir(_static))))


@app.context_processor
def contexto():
    return {"bucket": BUCKET_NOMBRE, "v": ASSET_V, "panel": PANEL}


# "/" es la página de entrada y también el callback de Cognito
@app.route("/")
def index():
    return render_template("login.html")


@app.route("/login")
def login():
    return redirect("/")


@app.route("/archivos")
def archivos():
    return render_template("archivos.html", activo="archivos")


@app.route("/dynamo")
def dynamo():
    return render_template("dynamo.html", activo="dynamo")


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1")
