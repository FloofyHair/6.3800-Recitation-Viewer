from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import webbrowser


ROOT = Path(__file__).resolve().parent


class RecitationHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)


server = ThreadingHTTPServer(("127.0.0.1", 0), RecitationHandler)
url = f"http://127.0.0.1:{server.server_port}/"
print(f"Recitation viewer running at {url}. Close this window to stop it.")
webbrowser.open(url)
server.serve_forever()
